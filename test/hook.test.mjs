import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStub } from './stub-cmux.mjs';
import { SESSION_CONTEXT } from '../plugins/vizpane/lib/payload.mjs';
import { makePng } from './helpers/png.mjs';

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

test('push --stdin publishes piped markdown, with or without a diagram', () => {
  const r = run(['push', '--stdin', '--agent', 'codex', '--title', 'Piped'], NO_FENCE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^(opened|pushed) 0001\n$/);
  const turn = readFileSync(turn1(), 'utf8');
  assert.ok(turn.includes('"agent":"codex"') && turn.includes('"title":"Piped"') && turn.includes(NO_FENCE), turn);
  assert.ok(stub.calls().some((c) => c.startsWith('new-pane ')), 'the viewer was opened');
});

test('push --zoom asks the viewer to open the diagram enlarged', () => {
  const r = run(['push', '--stdin', '--zoom', '--agent', 'claude', '--title', 'diagram 1'], '```mermaid\nflowchart LR\n  A --> B\n```\n');
  assert.equal(r.status, 0, r.stderr);
  const turn = readFileSync(turn1(), 'utf8');
  assert.ok(turn.includes('"zoom":true') && turn.includes('"title":"diagram 1"'), turn);
});

test('push --stdin with empty input fails without writing a turn', () => {
  const r = run(['push', '--stdin'], '  \n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no input/);
  assert.equal(existsSync(turn1()), false);
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

// Codex inside the vizpane relay: the hook draws the diagram in the conversation.
const VERSION = readFileSync(new URL('../plugins/vizpane/VERSION', import.meta.url), 'utf8').trim();
const STUB_RENDER = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const mode = process.env.STUB_RENDER || 'ok';
if (a[0] === '--cell') {
  if (mode === 'nocell') { console.log('{"ok":false,"error":"terminal does not report pixel size"}'); process.exit(1); }
  console.log('{"ok":true,"cellWidth":8,"cellAspect":2,"columns":150,"rows":50}');
} else if (mode === 'fail') {
  console.log('{"ok":false,"error":"script failed"}'); process.exit(1);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  fs.copyFileSync(process.env.STUB_PNG, a[2]);
  console.log('{"ok":true,"width":800,"height":400}');
}
`;
let sessionCount = 0;
const sessionDirOf = (name = `s1-${++sessionCount}-0123456789abcdef`) => {
  const d = join(dir, name);
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o700);
  writeFileSync(join(d, 'tui'), '');
  return d;
};
// A state root with a stub renderer that counts as built, and an environment inside a relay.
function inlineEnv(extra = {}) {
  mkdirSync(join(home, 'bin'), { recursive: true });
  const stubPath = join(home, 'bin/viz-render');
  writeFileSync(stubPath, STUB_RENDER);
  chmodSync(stubPath, 0o755);
  writeFileSync(`${stubPath}.stamp`, `${VERSION}\n`);
  const png = join(dir, 'fixture.png');
  writeFileSync(png, makePng(8, 4));
  const e = { ...env, VIZPANE_INLINE_DIR: sessionDirOf(), VIZPANE_TTY: '/dev/ttys999', STUB_PNG: png, ...extra };
  for (const k of ['NO_COLOR', 'CODEX_THREAD_ID', 'VIZPANE_INLINE']) if (!(k in extra)) delete e[k];
  return e;
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('codex inside the relay: one JSON line with the picture, files published, side pane not used', async () => {
  const e = inlineEnv();
  const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), e);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').length, 2, 'one line');
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.deepEqual(Object.keys(out), ['continue', 'systemMessage']);
  const lines = out.systemMessage.split('\n');
  assert.equal(lines[0], 'vizpane · 1 diagram');
  assert.equal(lines[1], '1 · sequenceDiagram');
  assert.ok(lines.slice(2).every((l) => l.startsWith('\u001b[38;2;') && l.endsWith('\u001b[39m')));
  const names = readdirSync(e.VIZPANE_INLINE_DIR).sort();
  assert.equal(names.filter((n) => /^[0-9a-f]{6}\.png$/.test(n)).length, 1);
  assert.equal(names.filter((n) => /^[0-9a-f]{6}\.cr$/.test(n)).length, 1);
  assert.ok(names.includes('emitted'));
  await settle();
  assert.equal(existsSync(turn1()), false, 'no side-pane turn');
  assert.deepEqual(stub.calls(), []);
  assert.equal(existsSync(join(home, 'jobs')), false, 'no worker job was queued');
  assert.equal(JSON.parse(readFileSync(last(), 'utf8')).markdown, WITH_FENCE, 'push --last has the answer');
  assert.equal(run(['push', '--last'], '', e).status, 0);
  assert.ok(existsSync(turn1()));
});

test('codex without VIZPANE_INLINE_DIR keeps today\'s output byte for byte, even with a built renderer', async () => {
  const e = inlineEnv();
  delete e.VIZPANE_INLINE_DIR;
  const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), e);
  assert.equal(r.stdout, '{"continue":true}\n');
  assert.equal(r.stderr, '');
  assert.ok(await waitFor(turn1()));
});

test('codex takes the side pane when any gate condition fails', async () => {
  const cases = {
    'NO_COLOR is set': { NO_COLOR: '1' },
    'inside a Codex tool': { CODEX_THREAD_ID: 'thread' },
    'inline is off': { VIZPANE_INLINE: 'off' },
    'relay of another contract version': { VIZPANE_INLINE_DIR: sessionDirOf('s2-1-x') },
    'no TUI marker': { VIZPANE_INLINE_DIR: (() => { const d = sessionDirOf('s1-9-notui'); rmSync(join(d, 'tui')); return d; })() },
    'canary marked the session incompatible': { VIZPANE_INLINE_DIR: (() => { const d = sessionDirOf('s1-10-bad'); writeFileSync(join(d, 'incompatible'), ''); return d; })() },
  };
  for (const [why, extra] of Object.entries(cases)) {
    const e = inlineEnv(extra);
    const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), e);
    assert.equal(r.stdout, '{"continue":true}\n', why);
    assert.ok(await waitFor(turn1()), why);
    rmSync(join(home, 'data'), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('codex with the pane switched off (vizpane off) publishes nothing and draws nothing', async () => {
  const e = inlineEnv();
  assert.equal(run(['off'], '', e).status, 0);
  const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), e);
  assert.equal(r.stdout, '{"continue":true}\n');
  await settle();
  assert.equal(existsSync(turn1()), false);
  assert.deepEqual(readdirSync(e.VIZPANE_INLINE_DIR), ['tui']);
});

test('codex answer without a diagram, and claude, ignore the relay entirely', async () => {
  const e = inlineEnv();
  const plain = run(['hook', '--agent', 'codex'], payload(NO_FENCE), e);
  assert.equal(plain.stdout, '{"continue":true}\n');
  const c = run(['hook', '--agent', 'claude'], payload(WITH_FENCE), e);
  assert.equal(c.stdout, '');
  assert.ok(await waitFor(last()), 'claude stores the answer as before');
  assert.deepEqual(readdirSync(e.VIZPANE_INLINE_DIR), ['tui']);
});

test('codex falls back to the side pane when the renderer fails or cannot size the terminal', async () => {
  for (const mode of ['fail', 'nocell']) {
    const e = inlineEnv({ STUB_RENDER: mode });
    const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), e);
    assert.equal(r.stdout, '{"continue":true}\n', mode);
    assert.ok(await waitFor(turn1()), mode);
    assert.deepEqual(readdirSync(e.VIZPANE_INLINE_DIR), ['tui'], mode);
    rmSync(join(home, 'data'), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('codex with a renderer that hangs answers within 7.5 s and uses the side pane', async () => {
  const e = inlineEnv({ STUB_RENDER: 'hang' });
  const started = Date.now();
  const r = run(['hook', '--agent', 'codex'], payload(WITH_FENCE), { ...e });
  const took = Date.now() - started;
  assert.equal(r.stdout, '{"continue":true}\n');
  assert.ok(took < 7500, `took ${took} ms`);
  assert.ok(took >= 6000, `gave up too early: ${took} ms`);
  assert.ok(await waitFor(turn1()));
});
