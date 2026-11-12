import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStub } from './stub-cmux.mjs';
import { SESSION_CONTEXT } from '../plugins/vizpane/lib/payload.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../plugins/vizpane/bin/vizpane.mjs');
const WITH_FENCE = 'Intro\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n';
const NO_FENCE = 'Plain answer, no diagram.';

let dir, home, stub, env;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vizpane-hook-'));
  home = join(dir, 'home');
  stub = makeStub(dir);
  env = {
    ...process.env, VIZPANE_HOME: home, VIZPANE_CMUX_BIN: stub.bin, CMUX_WORKSPACE_ID: 'ws1',
  };
  delete env.CMUX_BUNDLED_CLI_PATH;
});

const run = (args, input, e = env) =>
  spawnSync(process.execPath, [CLI, ...args], { input, env: e, encoding: 'utf8' });
const payload = (msg, session = 'sess-1') =>
  JSON.stringify({ hook_event_name: 'Stop', session_id: session, cwd: '/proj', last_assistant_message: msg });

async function waitFor(path, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const turn1 = () => join(home, 'data/ws1/turns/turn-0001.js');
const last = () => join(home, 'data/ws1/last/sess-1.json');

test('codex prints exactly {"continue":true}, exit 0, turn appears', async () => {
  const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"continue":true}\n');
  assert.ok(await waitFor(turn1()));
  assert.match(readFileSync(turn1(), 'utf8'), /"agent":"codex"/);
});

test('claude prints nothing, exit 0, turn appears and cmux is called', async () => {
  const r = run(['hook', '--agent', 'claude'], payload(WITH_FENCE));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(await waitFor(turn1()));
  assert.match(readFileSync(turn1(), 'utf8'), /"cwd":"\/proj"/);
  assert.ok(await waitFor(join(dir, 'cmux-calls.log')));
  assert.equal(readdirSync(join(home, 'jobs')).length, 0); // job file is deleted after use
});

test('answer without a fence: last/ written, no turn', async () => {
  const r = run(['hook', '--agent', 'claude'], payload(NO_FENCE));
  assert.equal(r.status, 0);
  assert.ok(await waitFor(last()));
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!existsSync(turn1()));
  assert.equal(JSON.parse(readFileSync(last(), 'utf8')).markdown, NO_FENCE);
});

test('garbage stdin still exits 0', () => {
  for (const agent of ['claude', 'codex']) {
    const r = run(['hook', '--agent', agent], 'not json {{{');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, agent === 'codex' ? '{"continue":true}\n' : '');
  }
  assert.equal(run(['hook', '--agent', 'claude'], '').status, 0);
  assert.equal(run(['hook'], '{}').status, 0);
});

test('off flag suppresses the turn but last/ is still written', async () => {
  const off = run(['off']);
  assert.equal(off.status, 0);
  assert.ok(existsSync(join(home, 'data/ws1/off')));
  run(['hook', '--agent', 'claude'], payload(WITH_FENCE));
  assert.ok(await waitFor(last()));
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!existsSync(turn1()));
  assert.equal(run(['on']).status, 0);
  assert.ok(!existsSync(join(home, 'data/ws1/off')));
});

test('session-start prints context JSON only inside cmux and when not off', () => {
  const r = run(['hook', '--agent', 'claude', '--event', 'session-start'], '{}');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
  });
  const noCmux = { ...env };
  delete noCmux.CMUX_WORKSPACE_ID;
  assert.equal(run(['hook', '--agent', 'claude', '--event', 'session-start'], '{}', noCmux).stdout, '');
  run(['off']);
  assert.equal(run(['hook', '--agent', 'claude', '--event', 'session-start'], '{}').stdout, '');
});

test('push --file and push --last', async () => {
  const md = join(dir, 'a.md');
  writeFileSync(md, '# From file\n\ntext');
  const f = run(['push', '--file', md, '--title', 'Mine', '--agent', 'manual']);
  assert.equal(f.status, 0, f.stderr);
  assert.match(readFileSync(turn1(), 'utf8'), /"title":"Mine".*"agent"|"agent":"manual".*"title":"Mine"/);
  assert.equal(run(['push', '--last']).status, 1); // nothing saved yet
  run(['hook', '--agent', 'claude'], payload(NO_FENCE));
  assert.ok(await waitFor(last()));
  const l = run(['push', '--last']);
  assert.equal(l.status, 0, l.stderr);
  assert.ok(existsSync(join(home, 'data/ws1/turns/turn-0002.js')));
});

test('open, sync and doctor', () => {
  assert.equal(run(['open']).status, 0);
  assert.match(stub.calls().join('\n'), /new-pane/);
  assert.equal(run(['sync']).status, 0);
  assert.ok(existsSync(join(home, 'VERSION')));
  assert.ok(existsSync(join(home, 'bin/vizpane.mjs')));
  const d = run(['doctor']);
  assert.match(d.stdout, /ok .*Node/);
  assert.match(d.stdout, /ok .*cmux ping/);
  const noWs = { ...env };
  delete noWs.CMUX_WORKSPACE_ID;
  const d2 = run(['doctor'], '', noWs);
  assert.equal(d2.status, 1);
  assert.match(d2.stdout, /FAIL .*CMUX_WORKSPACE_ID/);
});
