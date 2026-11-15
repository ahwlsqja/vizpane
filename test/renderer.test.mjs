import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStub } from './stub-cmux.mjs';
import {
  ensureRenderer, rendererReady, rendererPath, inlineOff, ensureRelay, relayPath, relayReady, relayStamp, ccBuild, buildStamp,
} from '../plugins/vizpane/lib/renderer.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../plugins/vizpane/bin/vizpane.mjs');
// Stand-in binaries are stamped for the plugin's own sources, copied into the state root the way
// `vizpane sync` does, so a CLI run that syncs first still finds them current.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../plugins/vizpane');
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
  assert.match(stamp(), /^1\.0\.0\+[0-9a-f]{12}$/);
  assert.equal(rendererReady({ root, version: '1.0.0' }), true);

  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 1, 'same version: no rebuild');

  assert.equal(rendererReady({ root, version: '1.1.0' }), false);
  ensureRenderer({ root, version: '1.1.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2, 'new version: rebuilt');
  assert.match(stamp(), /^1\.1\.0\+[0-9a-f]{12}$/);
});

test('a changed renderer source without a version bump rebuilds', () => {
  const { build, calls } = fakeBuild();
  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(rendererReady({ root, version: '1.0.0' }), true);
  writeFileSync(join(root, 'inline/render.swift'), '// edited');
  assert.equal(rendererReady({ root, version: '1.0.0' }), false, 'stale binary is not ready');
  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2);
  assert.equal(rendererReady({ root, version: '1.0.0' }), true);
  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2, 'unchanged source: no rebuild');
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
const useRealSources = (...names) => {
  for (const n of names) copyFileSync(join(PLUGIN_ROOT, 'inline', n), join(root, 'inline', n));
};
const markReady = () => {
  useRealSources('render.swift');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(rendererPath(root), '#!/bin/sh\n');
  writeFileSync(`${rendererPath(root)}.stamp`, `${buildStamp(root, VERSION, [['inline', 'render.swift']])}\n`);
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

// MARK: Codex relay

const relayRoot = () => {
  writeFileSync(join(root, 'inline/relay.c'), '/* source */');
  writeFileSync(join(root, 'inline/relay-filter.h'), '/* filter */');
  return root;
};
const relayStampText = () => readFileSync(`${relayPath(root)}.stamp`, 'utf8').trim();

test('relayPath is <root>/relay/codex', () => {
  assert.equal(relayPath(root), join(root, 'relay/codex'));
});

test('ensureRelay builds once per version, from inline/relay.c, and stamps it', () => {
  relayRoot();
  const { build, calls } = fakeBuild();
  const first = ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.deepEqual(first, { ok: true, path: join(root, 'relay/codex') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, join(root, 'inline/relay.c'));
  assert.notEqual(calls[0].out, relayPath(root), 'built as a partial file, then renamed');
  assert.equal(existsSync(`${relayPath(root)}.partial`), false);
  assert.match(relayStampText(), /^1\.0\.0\+[0-9a-f]{12}$/);
  assert.equal(relayStamp(root), relayStampText());
  assert.equal(relayReady({ root, version: '1.0.0' }), true);

  ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 1, 'same version: no rebuild');

  assert.equal(relayReady({ root, version: '1.1.0' }), false);
  ensureRelay({ root, version: '1.1.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2, 'new version: rebuilt');
  assert.match(relayStampText(), /^1\.1\.0\+[0-9a-f]{12}$/);
});

test('ensureRelay and ensureRenderer are independent: each has its own stamp', () => {
  relayRoot();
  const { build, calls } = fakeBuild();
  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(relayReady({ root, version: '1.0.0' }), false);
  ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2);
  assert.equal(rendererReady({ root, version: '1.0.0' }), true);
  assert.equal(relayReady({ root, version: '1.0.0' }), true);
});

test('a changed relay.c or relay-filter.h without a version bump rebuilds', () => {
  relayRoot();
  const { build, calls } = fakeBuild();
  ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(relayReady({ root, version: '1.0.0' }), true);
  writeFileSync(join(root, 'inline/relay-filter.h'), '/* filter, edited */');
  assert.equal(relayReady({ root, version: '1.0.0' }), false, 'header edit');
  ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 2);
  writeFileSync(join(root, 'inline/relay.c'), '/* source, edited */');
  assert.equal(relayReady({ root, version: '1.0.0' }), false, 'relay.c edit');
  ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(calls.length, 3);
  assert.equal(relayReady({ root, version: '1.0.0' }), true);
});

test('a source that changes during the build leaves a stamp that does not match', () => {
  const calls = [];
  const build = (source, out) => {
    calls.push(1);
    writeFileSync(out, '#!/bin/sh\n');
    writeFileSync(join(root, 'inline/render.swift'), '// changed while compiling');
    return { ok: true };
  };
  ensureRenderer({ root, version: '1.0.0', platform: 'darwin', env: {}, build });
  assert.equal(rendererReady({ root, version: '1.0.0' }), false);
});

test('buildStamp is the version alone when a source is missing, and null without a version', () => {
  assert.equal(buildStamp(root, '1.0.0', [['inline', 'nope.c']]), '1.0.0');
  assert.equal(buildStamp(root, '', [['inline', 'render.swift']]), null);
  assert.match(buildStamp(root, '1.0.0', [['inline', 'render.swift']]), /^1\.0\.0\+[0-9a-f]{12}$/);
});

test('a relay without a stamp is not ready', () => {
  mkdirSync(join(root, 'relay'));
  writeFileSync(relayPath(root), 'x');
  assert.equal(relayReady({ root, version: '1.0.0' }), false);
  assert.equal(relayStamp(root), null);
});

test('ensureRelay reports a failed build, a build that leaves nothing, a throw and a missing source', () => {
  relayRoot();
  const failed = ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build: () => ({ ok: false, error: 'cc failed: boom' }) });
  assert.deepEqual(failed, { ok: false, error: 'cc failed: boom' });
  assert.equal(existsSync(`${relayPath(root)}.stamp`), false);
  assert.equal(ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build: () => ({ ok: true }) }).ok, false);
  assert.deepEqual(ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: {}, build: () => { throw new Error('boom'); } }), { ok: false, error: 'boom' });
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const r = ensureRelay({ root: empty, version: '1.0.0', platform: 'darwin', env: {}, build: fakeBuild().build });
  assert.equal(r.ok, false);
  assert.match(r.error, /relay\.c/);
});

test('ensureRelay refuses VIZPANE_INLINE=off and non-macOS without building', () => {
  relayRoot();
  const { build, calls } = fakeBuild();
  assert.match(ensureRelay({ root, version: '1.0.0', platform: 'linux', env: {}, build }).error, /macOS/);
  assert.match(ensureRelay({ root, version: '1.0.0', platform: 'darwin', env: { VIZPANE_INLINE: 'off' }, build }).error, /VIZPANE_INLINE=off/);
  assert.equal(calls.length, 0);
});

test('ccBuild reports a compile error with its tail, and a missing compiler', () => {
  const bad = join(dir, 'bad.c');
  writeFileSync(bad, 'int main( {\n');
  const r = ccBuild(bad, join(dir, 'bad-out'));
  assert.equal(r.ok, false);
  assert.match(r.error, /^(cc failed: .+|cc not found .+)$/);
});

const hasCc = spawnSync('cc', ['--version'], { encoding: 'utf8' }).status === 0;
test('ccBuild compiles a trivial program into an executable', { skip: !hasCc && 'cc is not installed' }, () => {
  const src = join(dir, 'ok.c');
  writeFileSync(src, 'int main(void) { return 0; }\n');
  const out = join(dir, 'ok-out');
  assert.deepEqual(ccBuild(src, out), { ok: true });
  assert.equal(spawnSync(out).status, 0);
});

test('ccBuild compiles the real relay.c into an executable', { skip: process.platform !== 'darwin' ? 'the relay is built on macOS only (it includes libproc.h)' : !hasCc && 'cc is not installed' }, () => {
  const src = fileURLToPath(new URL('../plugins/vizpane/inline/relay.c', import.meta.url));
  const out = join(dir, 'relay-out');
  const r = ccBuild(src, out);
  assert.deepEqual(r, { ok: true });
  assert.ok(statSync(out).mode & 0o100, 'executable');
});

// The CLI with built stand-ins: no compiler runs, so the output depends only on the command.
const PROBE_STUB = "#!/bin/sh\nprintf 'gate: direct (stdin is not a tty)\\nreal: /opt/bin/codex\\nroot: /r\\n'\n";
const RELAY_SRC = [['inline', 'relay.c'], ['inline', 'relay-filter.h']];
const markRelayReady = (script = PROBE_STUB) => {
  useRealSources('relay.c', 'relay-filter.h');
  mkdirSync(join(root, 'relay'), { recursive: true });
  writeFileSync(relayPath(root), script);
  chmodSync(relayPath(root), 0o755);
  writeFileSync(`${relayPath(root)}.stamp`, `${buildStamp(root, VERSION, RELAY_SRC)}\n`);
};
const onMac = { skip: process.platform !== 'darwin' && 'the relay is built on macOS only' };

test('codex-inline prints the status lines, the probed Codex and the export line', onMac, () => {
  markReady();
  markRelayReady();
  const { env } = hookEnv();
  const r = cli(env, ['codex-inline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'ok   inline renderer built');
  assert.equal(lines[1], `ok   codex relay built (${join(root, 'relay/codex')})`);
  assert.equal(lines[2], 'relay probe: real codex = /opt/bin/codex');
  assert.match(lines[3], /shell profile/);
  assert.equal(lines[4], `export CMUX_CUSTOM_CODEX_PATH="${join(root, 'relay/codex')}"`);
  assert.equal(lines.length, 5);
});

test('codex-inline and doctor warn that an existing CMUX_CUSTOM_CODEX_PATH would be replaced, and name VIZPANE_REAL_CODEX', onMac, () => {
  markReady();
  markRelayReady();
  const { env } = hookEnv();
  const mine = { ...env, CMUX_CUSTOM_CODEX_PATH: '/opt/corp/codex' };
  const r = cli(mine, ['codex-inline']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^warn CMUX_CUSTOM_CODEX_PATH is already set to \/opt\/corp\/codex; the export line replaces it\. To keep running it, also add: export VIZPANE_REAL_CODEX="\/opt\/corp\/codex"$/m);
  const d = cli(mine, ['doctor']);
  assert.match(d.stdout, /^skip CMUX_CUSTOM_CODEX_PATH does not point to the relay \(it is \/opt\/corp\/codex; to keep running it, export VIZPANE_REAL_CODEX="\/opt\/corp\/codex"\)$/m);
  const quiet = cli(env, ['codex-inline']);
  assert.doesNotMatch(quiet.stdout, /^warn/m, 'nothing to warn about when the variable is unset');
  const same = cli({ ...env, CMUX_CUSTOM_CODEX_PATH: relayPath(root) }, ['codex-inline']);
  assert.doesNotMatch(same.stdout, /^warn/m, 'nor when it already points to the relay');
});

test('codex-inline says so when there is no Codex to run, and fails when something cannot be built', onMac, () => {
  markReady();
  markRelayReady("#!/bin/sh\nprintf 'gate: relay\\nreal: (not found)\\nroot: /r\\n'\n");
  const { env } = hookEnv();
  const r = cli(env, ['codex-inline']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^skip relay probe \(no real codex found on PATH\)$/m);

  const off = hookEnv({ VIZPANE_INLINE: 'off' });
  const f = cli(off.env, ['codex-inline']);
  assert.equal(f.status, 1);
  assert.match(f.stdout, /^FAIL inline renderer \(VIZPANE_INLINE=off\)$/m);
  assert.match(f.stdout, /^FAIL codex relay \(VIZPANE_INLINE=off\)$/m);
  assert.doesNotMatch(f.stdout, /export/);
});

test('doctor reports the relay, the export and the probe, and its exit code does not depend on them', onMac, () => {
  const { env } = hookEnv();
  cli(env, ['sync']);
  const before = cli(env, ['doctor']);
  assert.equal(before.status, 0, before.stdout);
  assert.match(before.stdout, /^skip codex relay \(not built; run: vizpane codex-inline\)$/m);

  markRelayReady();
  const unpointed = cli(env, ['doctor']);
  assert.equal(unpointed.status, 0);
  assert.match(unpointed.stdout, /^ok {3}codex relay built$/m);
  assert.match(unpointed.stdout, /^skip CMUX_CUSTOM_CODEX_PATH does not point to the relay/m);
  assert.match(unpointed.stdout, /^relay probe: real codex = \/opt\/bin\/codex$/m);

  const pointed = cli({ ...env, CMUX_CUSTOM_CODEX_PATH: relayPath(root) }, ['doctor']);
  assert.equal(pointed.status, 0);
  assert.match(pointed.stdout, /^ok {3}CMUX_CUSTOM_CODEX_PATH points to it$/m);

  writeFileSync(`${relayPath(root)}.stamp`, 'old\n');
  const stale = cli(env, ['doctor']);
  assert.equal(stale.status, 0);
  assert.match(stale.stdout, /^skip codex relay \(built for old, plugin is .+; run: vizpane codex-inline\)$/m);

  const off = cli({ ...env, VIZPANE_INLINE: 'off' }, ['doctor']);
  assert.match(off.stdout, /^skip codex relay \(VIZPANE_INLINE=off\)$/m);
});
