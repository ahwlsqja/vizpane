import {
  mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, statSync, existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const KEEP = 30;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;

export function stateRoot() {
  return process.env.VIZPANE_HOME || join(homedir(), '.local', 'state', 'vizpane');
}

export function sanitize(s) {
  return typeof s === 'string' && s ? s.replace(/[^A-Za-z0-9_-]/g, '_') : 'unknown';
}

export function wsId(env = process.env) {
  return env.CMUX_WORKSPACE_ID ? sanitize(env.CMUX_WORKSPACE_ID) : 'no-cmux';
}

export function viewerUrl(ws) {
  return `file://${stateRoot()}/viewer.html?ws=${ws}`;
}

export const wsDir = (ws) => join(stateRoot(), 'data', ws);

const ensureDir = (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 });

// Script files are loaded by the viewer via <script src>, so '<' and the JS line
// terminators must never appear raw inside them.
export function encode(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Rename keeps the viewer from ever reading a half-written file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export async function withLock(ws, fn) {
  const dir = wsDir(ws);
  ensureDir(dir);
  const lock = join(dir, '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const turnNumbers = (turnsDir) =>
  readdirSync(turnsDir)
    .map((f) => /^turn-(\d+)\.js$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

const turnFile = (n) => `turn-${String(n).padStart(4, '0')}.js`;

// Allocates the id, writes the turn, prunes and rewrites boot.js, all under the lock.
export function addTurn(ws, { agent, session, cwd, markdown, title }, now = new Date()) {
  return withLock(ws, () => {
    const dir = wsDir(ws);
    const turnsDir = join(dir, 'turns');
    ensureDir(turnsDir);
    const nums = turnNumbers(turnsDir);
    const n = (nums.at(-1) ?? 0) + 1;
    const id = String(n).padStart(4, '0');
    const turn = { v: 1, id, agent, session, cwd, time: now.toISOString(), title, markdown };
    writeAtomic(join(turnsDir, turnFile(n)), `viz.add(${encode(turn)});\n`);
    const kept = [...nums, n].slice(-KEEP);
    for (const old of nums.filter((x) => !kept.includes(x))) rmSync(join(turnsDir, turnFile(old)), { force: true });
    const index = { v: 1, ws, turns: kept.map((x) => `turns/${turnFile(x)}`) };
    writeAtomic(join(dir, 'boot.js'), `viz.boot(${encode(index)});\n`);
    return { id, rel: `turns/${turnFile(n)}` };
  });
}

export function saveLast(ws, { agent, session, cwd, markdown }, now = new Date()) {
  const dir = join(wsDir(ws), 'last');
  ensureDir(dir);
  const rec = { agent, session, cwd, time: now.toISOString(), markdown };
  writeAtomic(join(dir, `${sanitize(session)}.json`), JSON.stringify(rec));
}

export function newestLast(ws, session) {
  const dir = join(wsDir(ws), 'last');
  let files;
  try {
    files = session ? [`${sanitize(session)}.json`] : readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    try {
      const m = statSync(join(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    } catch {}
  }
  if (!best) return null;
  try {
    return JSON.parse(readFileSync(join(dir, best.f), 'utf8'));
  } catch {
    return null;
  }
}

const offFlag = (ws) => join(wsDir(ws), 'off');
export const isOff = (ws) => existsSync(offFlag(ws));
export function setOff(ws, off) {
  if (off) {
    ensureDir(wsDir(ws));
    writeFileSync(offFlag(ws), '', { mode: 0o600 });
  } else {
    rmSync(offFlag(ws), { force: true });
  }
}
