#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hasMermaid } from '../lib/extract.mjs';
import { parseHookPayload, SESSION_CONTEXT } from '../lib/payload.mjs';
import { stateRoot, wsId, saveLast, newestLast, isOff, setOff } from '../lib/store.mjs';
import { publish, openViewer, runCmux } from '../lib/cmux.mjs';
import { syncApp, pluginVersion, installedVersion } from '../lib/sync.mjs';
import { ensureRenderer, rendererReady, inlineOff } from '../lib/renderer.mjs';
import { log } from '../lib/log.mjs';

const SELF = fileURLToPath(import.meta.url);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// The hook only hands its input to a detached worker, so the agent turn never waits on cmux.
async function hookStop(agent) {
  const input = await readStdin();
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

async function hook(values) {
  const agent = values.agent || 'claude';
  try {
    if (values.event === 'session-start') hookSessionStart();
    else await hookStop(agent);
  } catch (e) {
    log(`error hook: ${e.message}`);
  }
  if (agent === 'codex' && values.event !== 'session-start') process.stdout.write('{"continue":true}\n');
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
  const inline = inlineStatus();
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.label}`);
  console.log(inline);
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
    case 'doctor':
      return doctor();
    default:
      console.error('usage: vizpane <hook|push|open|off|on|sync|renderer|doctor>');
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
