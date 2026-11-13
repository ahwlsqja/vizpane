import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStub } from './stub-cmux.mjs';
import { ensureRenderer, rendererReady, rendererPath, inlineOff } from '../plugins/vizpane/lib/renderer.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../plugins/vizpane/bin/vizpane.mjs');
const VERSION = readFileSync(new URL('../plugins/vizpane/VERSION', import.meta.url), 'utf8').trim();
const WITH_FENCE = 'Intro\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n';

let dir, root;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vizpane-renderer-'));
  root = join(dir, 'home');
  mkdirSync(join(root, 'inline'), { recursive: true });
  writeFileSync(join(root, 'inline/render.swift'), '// source');
});

// A build that writes a file instead of compiling, and counts its calls.
function fakeBuild() {
  const calls = [];
  const build = (source, out) => {
    calls.push({ source, out });
    writeFileSync(out, '#!/bin/sh\n');
    return { ok: true };
  };
  return { build, calls };
}
const stamp = () => readFileSync(`${rendererPath(root)}.stamp`, 'utf8').trim();

test('builds once per version: the stamp decides', () => {
  const { build, calls } = fakeBuild();
  const first = ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.deepEqual(first, { ok: true, path: join(root, 'bin/viz-render') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, join(root, 'inline/render.swift'));
  assert.equal(stamp(), '1.0.0');
  assert.equal(rendererReady({ root, version: '1.0.0' }), true);

  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 1, 'same version: no rebuild');

  assert.equal(rendererReady({ root, version: '1.1.0' }), false);
  ensureRenderer({ root, version: '1.1.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2, 'new version: rebuilt');
  assert.equal(stamp(), '1.1.0');
});

test('a binary without a stamp is not ready', () => {
  mkdirSync(join(root, 'bin'));
  writeFileSync(rendererPath(root), 'x');
  assert.equal(rendererReady({ root, version: '1.0.0' }), false);
});

test('missing swiftc is reported, nothing is stamped', () => {
  const build = () => ({ ok: false, error: 'swiftc not found (install the Xcode Command Line Tools)' });
  const r = ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(r.ok, false);
  assert.match(r.error, /swiftc not found/);
  assert.equal(existsSync(`${rendererPath(root)}.stamp`), false);
  assert.equal(rendererReady({ root, version: '1.0.0' }), false);
});

test('a build that exits ok but leaves no binary fails', () => {
  const r = ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build: () => ({ ok: true }) });
  assert.equal(r.ok, false);
});

test('a build that throws is reported, not raised', () => {
  const r = ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build: () => { throw new Error('boom'); } });
  assert.deepEqual(r, { ok: false, error: 'boom' });
});

test('non-macOS and VIZPANE_INLINE=off never build', () => {
  const { build, calls } = fakeBuild();
  const linux = ensureRenderer({ root, version: '1.0.0', platform: 'linux', env: {}, build });
  assert.equal(linux.ok, false);
  assert.match(linux.error, /macOS/);
  const off = ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: { VIZPANE_INLINE: 'off' }, build });
  assert.equal(off.ok, false);
  assert.match(off.error, /VIZPANE_INLINE=off/);
  assert.equal(calls.length, 0);
  assert.equal(inlineOff({ VIZPANE_INLINE: 'off' }), true);
  assert.equal(inlineOff({ VIZPANE_INLINE: 'on' }), false);
  assert.equal(inlineOff({}), false);
});

test('missing Swift source in the state root is reported', () => {
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const r = ensureRenderer({ root: empty, version: '1.0.0', platform: 'darwin', env: {}, build: fakeBuild().build });
  assert.equal(r.ok, false);
  assert.match(r.error, /render\.swift/);
});

// CLI and worker, with cmux stubbed.
function cli(env, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], { input, env, encoding: 'utf8' });
}
async function waitFor(path, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
function hookEnv(extra = {}) {
  const stub = makeStub(dir);
  const env = { ...process.env, VIZPANE_HOME: root, VIZPANE_CMUX_BIN: stub.bin, CMUX_WORKSPACE_ID: 'ws1', ...extra };
  delete env.CMUX_BUNDLED_CLI_PATH;
  delete env.VIZPANE_INLINE;
  Object.assign(env, extra);
  return { env, stub };
}
const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/proj', last_assistant_message: WITH_FENCE });
const markReady = () => {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(rendererPath(root), '#!/bin/sh\n');
  writeFileSync(`${rendererPath(root)}.stamp`, `${VERSION}\n`);
};
const turn1 = () => join(root, 'data/ws1/turns/turn-0001.js');
const last = () => join(root, 'data/ws1/last/sess-1.json');

test('renderer command prints one JSON line and exits 0 when inline is off', () => {
  const { env } = hookEnv({ VIZPANE_INLINE: 'off' });
  const r = cli(env, ['renderer']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ok: false, error: 'VIZPANE_INLINE=off' });
  assert.ok(existsSync(join(root, 'inline/render.html')), 'sync copied inline/');
});

test('claude with a ready renderer: answer stored, not published', async () => {
  markReady();
  const { env, stub } = hookEnv();
  const r = cli(env, ['hook', '--agent', 'claude'], payload);
  assert.equal(r.status, 0);
  assert.ok(await waitFor(last()));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(turn1()), false);
  assert.deepEqual(stub.calls(), []);
});

test('claude with a ready renderer but VIZPANE_INLINE=off: published', async () => {
  markReady();
  const { env } = hookEnv({ VIZPANE_INLINE: 'off' });
  cli(env, ['hook', '--agent', 'claude'], payload);
  assert.ok(await waitFor(turn1()));
});

test('claude without a ready renderer: published', async () => {
  const { env } = hookEnv();
  cli(env, ['hook', '--agent', 'claude'], payload);
  assert.ok(await waitFor(turn1()));
});

test('codex is published even when the renderer is ready', async () => {
  markReady();
  const { env } = hookEnv();
  const r = cli(env, ['hook', '--agent', 'codex'], payload);
  assert.equal(r.stdout, '{"continue":true}\n');
  assert.ok(await waitFor(turn1()));
});

test('push --last, --file and --stdin still publish for claude when the renderer is ready', async () => {
  markReady();
  const { env } = hookEnv();
  cli(env, ['hook', '--agent', 'claude'], payload);
  assert.ok(await waitFor(last()));
  assert.equal(cli(env, ['push', '--last']).status, 0);
  assert.ok(existsSync(turn1()));
  const md = join(dir, 'a.md');
  writeFileSync(md, WITH_FENCE);
  assert.equal(cli(env, ['push', '--file', md, '--agent', 'claude']).status, 0);
  assert.ok(existsSync(join(root, 'data/ws1/turns/turn-0002.js')));
  assert.equal(cli(env, ['push', '--stdin', '--agent', 'claude'], WITH_FENCE).status, 0);
  assert.ok(existsSync(join(root, 'data/ws1/turns/turn-0003.js')));
});

test('doctor reports the renderer on one line and does not fail on it', () => {
  const { env } = hookEnv();
  cli(env, ['sync']);
  const before = cli(env, ['doctor']);
  assert.equal(before.status, 0, before.stdout);
  assert.match(before.stdout, /^(skip inline renderer \(.+\))$/m);
  markReady();
  const after = cli(env, ['doctor']);
  if (process.platform === 'darwin') assert.match(after.stdout, /^ok {3}inline renderer built$/m);
  assert.equal(after.status, 0);
});
