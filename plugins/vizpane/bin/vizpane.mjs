#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hasMermaid } from '../lib/extract.mjs';
import { parseHookPayload, SESSION_CONTEXT } from '../lib/payload.mjs';
import { stateRoot, wsId, saveLast, newestLast, isOff, setOff } from '../lib/store.mjs';
import { publish, openViewer, runCmux } from '../lib/cmux.mjs';
import { syncApp, pluginVersion, installedVersion } from '../lib/sync.mjs';
import { ensureRenderer, rendererReady, inlineOff, ensureRelay, relayPath, relayReady, relayStamp } from '../lib/renderer.mjs';
import { eligible, inlineReply } from '../lib/codex-inline.mjs';
import { log } from '../lib/log.mjs';

const SELF = fileURLToPath(import.meta.url);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// The hook only hands its input to a detached worker, so the agent turn never waits on cmux.
async function hookStop(agent, input) {
  const jobs = join(stateRoot(), 'jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const job = join(jobs, `${randomBytes(8).toString('hex')}.json`);
  writeFileSync(job, JSON.stringify({ agent, stdin: input }), { mode: 0o600 });
  spawn(process.execPath, [SELF, '_work', job], { detached: true, stdio: 'ignore' }).unref();
}

function hookSessionStart() {
  syncApp();
  if (!process.env.CMUX_WORKSPACE_ID || isOff(wsId())) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
  }) + '\n');
}

// Inside the vizpane Codex relay the diagram is drawn in the conversation: the hook renders
// synchronously and returns it as the systemMessage. Returns the reply line, or null when this
// answer takes the side-pane path.
async function codexInlineReply(input, startedAt) {
  let p;
  try {
    p = parseHookPayload('codex', JSON.parse(input));
  } catch {
    return null;
  }
  const gate = p && !isOff(wsId()) ? eligible(process.env, p) : null;
  if (!gate) return null;
  const reply = await inlineReply({ gate, startedAt });
  if (!reply) return null;
  // The picture is on its way, so the side pane would show it twice; push --last still can.
  try {
    saveLast(wsId(), p);
  } catch (e) {
    log(`error hook saveLast: ${e.message}`);
  }
  return `${JSON.stringify({ continue: true, systemMessage: reply.message })}\n`;
}

async function hook(values) {
  const startedAt = Date.now();
  const agent = values.agent || 'claude';
  let reply = '{"continue":true}\n';
  try {
    if (values.event === 'session-start') {
      hookSessionStart();
    } else {
      const input = await readStdin();
      const inline = agent === 'codex' ? await codexInlineReply(input, startedAt).catch(() => null) : null;
      if (inline) reply = inline;
      else await hookStop(agent, input);
    }
  } catch (e) {
    log(`error hook: ${e.message}`);
  }
  if (agent === 'codex' && values.event !== 'session-start') process.stdout.write(reply);
}

async function work(jobFile) {
  let job;
  try {
    job = JSON.parse(readFileSync(jobFile, 'utf8'));
  } finally {
    rmSync(jobFile, { force: true });
  }
  const p = parseHookPayload(job.agent, JSON.parse(job.stdin));
  if (!p) return;
  const ws = wsId();
  saveLast(ws, p);
  // In Claude Code the mod draws the picture inside the conversation, so the side pane would show it twice.
  if (p.agent === 'claude' && !inlineOff() && rendererReady()) return;
  if (isOff(ws) || !hasMermaid(p.markdown)) return;
  await publish(p);
}

async function push(values) {
  if (values.file || values.stdin) {
    const markdown = values.file ? readFileSync(values.file, 'utf8') : await readStdin();
    if (!markdown.trim()) throw new Error(`push: no input${values.file ? ` in ${values.file}` : ' on stdin'}`);
    return publish({ agent: values.agent || 'manual', session: 'manual', cwd: process.cwd(), markdown, title: values.title, zoom: values.zoom === true });
  }
  if (values.last) {
    const last = newestLast(wsId(), values.session);
    if (!last) throw new Error('저장된 직전 답변이 없습니다');
    return publish({ ...last, title: values.title });
  }
  throw new Error('usage: vizpane push --last [--session <id>] | --file <path.md> | --stdin  [--title <t>] [--agent <name>] [--zoom]');
}

function inlineStatus() {
  if (process.platform !== 'darwin') return 'skip inline renderer (not macOS)';
  if (inlineOff()) return 'skip inline renderer (VIZPANE_INLINE=off)';
  if (rendererReady()) return 'ok   inline renderer built';
  return 'skip inline renderer (not built; it is built when a Claude Code session starts, or run: vizpane renderer)';
}

// With VIZPANE_RELAY_PROBE=1 the relay prints "gate: ...", "real: <path>" and "root: ..." and exits.
// Returns the real Codex it would run, or null when it cannot be probed or finds none. The gate
// line is not shown: it describes the probe's own piped stdio, not the user's pane.
function relayRealCodex() {
  const r = spawnSync(relayPath(), [], {
    env: { ...process.env, VIZPANE_RELAY_PROBE: '1' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0) return null;
  const m = /^real: (.+)$/m.exec(r.stdout);
  return m && m[1].startsWith('/') ? m[1] : null;
}

const probeLine = (real) => (real ? `relay probe: real codex = ${real}` : 'skip relay probe (no real codex found on PATH)');

const realOrSame = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function exportLine(root = stateRoot()) {
  const path = relayPath(root);
  const home = homedir();
  const shown = path.startsWith(`${home}/`) ? `$HOME${path.slice(home.length)}` : path;
  return `export CMUX_CUSTOM_CODEX_PATH="${shown}"`;
}

const relayPointed = () => Boolean(process.env.CMUX_CUSTOM_CODEX_PATH)
  && realOrSame(process.env.CMUX_CUSTOM_CODEX_PATH) === realOrSame(relayPath());

// An existing CMUX_CUSTOM_CODEX_PATH (a company build, a launcher) would be replaced by the export
// line, and the relay would then run the first codex on PATH. VIZPANE_REAL_CODEX chains to it.
const otherCustomCodex = () => {
  const v = process.env.CMUX_CUSTOM_CODEX_PATH;
  return v && !relayPointed() ? v : null;
};

// Informational lines about the Codex relay; like the inline renderer line they never fail doctor.
function relayStatus() {
  if (process.platform !== 'darwin') return ['skip codex relay (not macOS)'];
  if (inlineOff()) return ['skip codex relay (VIZPANE_INLINE=off)'];
  if (!existsSync(relayPath())) return ['skip codex relay (not built; run: vizpane codex-inline)'];
  if (!relayReady()) return [`skip codex relay (built for ${(relayStamp() ?? '').split('+')[0] || 'an unknown version'}, plugin is ${pluginVersion()}; run: vizpane codex-inline)`];
  const lines = ['ok   codex relay built'];
  lines.push(relayPointed()
    ? 'ok   CMUX_CUSTOM_CODEX_PATH points to it'
    : otherCustomCodex()
      ? `skip CMUX_CUSTOM_CODEX_PATH does not point to the relay (it is ${otherCustomCodex()}; to keep running it, export VIZPANE_REAL_CODEX="${otherCustomCodex()}")`
      : 'skip CMUX_CUSTOM_CODEX_PATH does not point to the relay (run: vizpane codex-inline)');
  return [...lines, probeLine(relayRealCodex())];
}

// Builds the renderer and the relay, shows which Codex the relay would run, and prints the one
// line the user adds to their shell profile. vizpane never edits dotfiles.
function codexInline() {
  syncApp();
  const renderer = ensureRenderer();
  console.log(renderer.ok ? 'ok   inline renderer built' : `FAIL inline renderer (${renderer.error})`);
  const relay = ensureRelay();
  console.log(relay.ok ? `ok   codex relay built (${relay.path})` : `FAIL codex relay (${relay.error})`);
  if (!renderer.ok || !relay.ok) return 1;
  console.log(probeLine(relayRealCodex()));
  console.log('Add this line to your shell profile, then open a new cmux pane:');
  console.log(exportLine());
  const other = otherCustomCodex();
  if (other) {
    console.log(`warn CMUX_CUSTOM_CODEX_PATH is already set to ${other}; the export line replaces it. To keep running it, also add: export VIZPANE_REAL_CODEX="${other}"`);
  }
  return 0;
}

async function doctor() {
  const checks = [];
  const add = (ok, label) => checks.push({ ok, label });
  add(Number(process.versions.node.split('.')[0]) >= 20, `Node >= 20 (${process.version})`);
  const root = stateRoot();
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    accessSync(root, constants.W_OK);
    add(true, `state root writable (${root})`);
  } catch {
    add(false, `state root writable (${root})`);
  }
  add(installedVersion() !== null && installedVersion() === pluginVersion(), `VERSION in state root (${installedVersion()}) equals plugin (${pluginVersion()})`);
  const vendor = ['mermaid.min.js', 'marked.umd.js', 'purify.min.js'];
  const missing = vendor.filter((f) => !existsSync(join(root, 'vendor', f)));
  add(missing.length === 0, missing.length ? `vendor files missing: ${missing.join(', ')}` : 'vendor files exist');
  add(Boolean(process.env.CMUX_WORKSPACE_ID), 'CMUX_WORKSPACE_ID set');
  try {
    await runCmux(['ping']);
    add(true, 'cmux ping');
  } catch (e) {
    add(false, `cmux ping (${e.message.split('\n')[0]})`);
  }
  // Optional: inline pictures need macOS and swiftc, so this line reports but never fails the run.
  const inline = [inlineStatus(), ...relayStatus()];
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}`);
  for (const line of inline) console.log(line);
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '_work') {
    await work(rest[0]);
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    strict: false,
    options: {
      agent: { type: 'string' }, event: { type: 'string' }, last: { type: 'boolean' },
      session: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' }, stdin: { type: 'boolean' },
      zoom: { type: 'boolean' },
    },
  });
  switch (cmd) {
    case 'hook':
      await hook(values);
      return 0;
    case 'push': {
      const r = await push(values);
      console.log(`${r.action} ${r.id}`);
      return 0;
    }
    case 'open':
      syncApp();
      console.log(await openViewer(wsId()));
      return 0;
    case 'off':
    case 'on':
      setOff(wsId(), cmd === 'off');
      console.log(`auto push: ${cmd === 'off' ? 'off' : 'on'}`);
      return 0;
    case 'sync':
      console.log(syncApp(undefined, { force: true }) ? 'synced' : 'nothing to sync');
      return 0;
    case 'renderer':
      // Called by the Claude Code mod at session start; the answer is one JSON line, exit 0 either way.
      try {
        syncApp();
        console.log(JSON.stringify(ensureRenderer()));
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: e.message }));
      }
      return 0;
    case 'codex-inline':
      return codexInline();
    case 'doctor':
      return doctor();
    default:
      console.error('usage: vizpane <hook|push|open|off|on|sync|renderer|codex-inline|doctor>');
      return 1;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    log(`error ${process.argv[2]}: ${e.message}`);
    // hook and the detached worker must never fail the agent; other commands report.
    if (process.argv[2] === 'hook' || process.argv[2] === '_work') {
      process.exitCode = 0;
    } else {
      console.error(e.message);
      process.exitCode = 1;
    }
  },
);
