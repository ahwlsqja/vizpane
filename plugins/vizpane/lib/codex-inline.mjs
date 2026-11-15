// Codex inline pictures, hook side. Inside the vizpane relay (inline/relay.c) the Stop hook draws
// a diagram as kitty Unicode-placeholder cells in its systemMessage: Codex draws those cells
// itself, so the picture follows Codex's own repainting and scrolling. The pixels reach the
// terminal through the relay, which transmits a file from the session directory the first time
// it sees a placeholder for it. This module is the other half of that contract: it renders the
// diagrams, publishes them into the session directory and builds the message.
//
// Contract (version 1, the "s1-" prefix of the session directory):
//   <dir>/tui                 written by the relay while Codex's TUI is live
//   <dir>/<id6hex>.png, .cr   written here: one image, then its "C R\n" cell box (.cr last)
//   <dir>/resolved            touched by the relay on each transmit
//   <dir>/emitted, strikes, incompatible   canary state, written here only
// The relay also exports VIZPANE_TTY: the pane's own terminal (not the relay's pseudo-terminal
// that carries Codex's output). The hook runs in a session of its own with no controlling
// terminal, so that path is the only way it can read the window and pixel size, and it reads
// them from the pane directly.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fitCells, hashSource, mermaidBlocks, MAX_ROWS } from '../claude/inline-core.mjs';
import { DIACRITICS } from './diacritics.mjs';
import { stateRoot } from './store.mjs';
import { inlineOff, rendererPath, rendererReady } from './renderer.mjs';

export const CONTRACT_PREFIX = 's1-';
export const ID_MIN = 0x100000;
export const ID_SPAN = 0x700000; // ids stay below 0x800000, clear of the ids Codex itself uses
export const MAX_DIAGRAMS = 6;
export const MAX_PARALLEL = 3;
export const BUDGET_MS = 7000; // the hook's own timeout is 10 s
export const LABEL_COLUMNS = 48;
// Columns the transcript does not offer to a hook cell: the body indent, the pet image with its
// gap, and a spare for a per-line reserve that was not verified.
export const RESERVED_COLUMNS = 20;
export const MIN_COLUMNS = 20;
export const MIN_ROWS = 9; // H - 8 is at least one row
const MAX_COLUMNS = 120;
const PLACEHOLDER = String.fromCodePoint(0x10EEEE);
const CANARY_GRACE_MS = 10000;
const CANARY_STRIKES = 2;
const PROBES = 16;
const RENDER_ATTEMPTS = 3;
export const CACHE_DAYS = 7; // the Claude Code mod prunes the shared cache by the same age
const PRUNE_LIMIT = 200;

const ESC = '\u001b';
const hex6 = (id) => id.toString(16).padStart(6, '0');

// MARK: gate

// The session directory of this Codex session, or null. Anything unexpected about it (not ours,
// not 0700, a symlink, another contract version) means the relay is not what this hook knows.
export function sessionDir(env) {
  const dir = env.VIZPANE_INLINE_DIR;
  if (typeof dir !== 'string' || !isAbsolute(dir) || !basename(dir).startsWith(CONTRACT_PREFIX)) return null;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if (!lstatSync(join(dir, 'tui')).isFile()) return null;
  } catch {
    return null;
  }
  return dir;
}

// Returns { dir, blocks } when this Stop should draw inside the conversation, otherwise null and
// the caller takes the side-pane path unchanged. `ready` tells whether the renderer is built.
export function eligible(env, payload, { ready = () => rendererReady() } = {}) {
  if (inlineOff(env) || env.CODEX_THREAD_ID || env.NO_COLOR) return null;
  const dir = sessionDir(env);
  if (!dir || existsSync(join(dir, 'incompatible'))) return null;
  if (!ready()) return null;
  const blocks = mermaidBlocks(payload && payload.markdown);
  return blocks.length ? { dir, blocks } : null;
}

// MARK: labels

const STRIPPED = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{10EEEE}\u{2060}-\u{2064}\u{180e}\u{fff9}-\u{fffb}\u{e0000}-\u{e007f}\p{Cs}]/gu;

function cellWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (/^[\p{Mn}\p{Me}]$/u.test(grapheme[0])) return 0;
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)
    || /^\p{Emoji_Presentation}/u.test(grapheme);
  return wide ? 2 : 1;
}

// One line of Mermaid source for the caption of a picture. The text is untrusted: controls, bidi
// marks, invisible format characters, lone surrogates (JSON would write them as escapes that
// Codex's parser rejects, and the whole hook output would be lost) and the placeholder character
// are dropped, and the rest is cut at LABEL_COLUMNS.
// `%%` comment lines are skipped because the viz-style comments come first in a diagram.
export function sanitizeLabel(source) {
  if (typeof source !== 'string') return '';
  const line = source.split(/\r?\n|\u{2028}|\u{2029}/u).find((l) => l.trim() !== '' && !l.trim().startsWith('%%')) ?? '';
  const text = line.replace(/\s+/g, ' ').replace(STRIPPED, '').trim();
  let out = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const w = cellWidth(segment);
    if (used + w > LABEL_COLUMNS) break;
    out += segment;
    used += w;
  }
  return out.trimEnd();
}

// MARK: message

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// items: [{ number, source, id, columns, rows }], in display order; `more` counts the diagrams
// that were left out. Every byte of the message is either the caption, a sanitized label, an
// SGR colour built from the id, a placeholder with its two diacritics, a space or a newline.
export function buildMessage(items, more = 0) {
  const lines = [`vizpane · ${items.length} ${items.length === 1 ? 'diagram' : 'diagrams'}${more > 0 ? ` and ${more} more` : ''}`];
  items.forEach((item, k) => {
    const { number, source, id, columns, rows } = item;
    if (!isInt(id, ID_MIN, ID_MIN + ID_SPAN - 1) || !isInt(columns, 1, 255) || !isInt(rows, 1, 255) || !isInt(number, 1, 1e6)) {
      throw new Error('buildMessage: value out of range');
    }
    if (k > 0) lines.push('');
    lines.push(`${number} · ${sanitizeLabel(source) || 'diagram'}`);
    const sgr = `${ESC}[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m`;
    for (let r = 0; r < rows; r++) {
      const row = String.fromCodePoint(DIACRITICS[r]);
      let cells = '';
      for (let c = 0; c < columns; c++) cells += PLACEHOLDER + row + String.fromCodePoint(DIACRITICS[c]);
      lines.push(`${sgr}${cells}${ESC}[39m`);
    }
  });
  return lines.join('\n');
}

// MARK: sizing

// fitCells follows the picture's aspect inside a box; this adds the terminal-size rules of the
// transcript: at most W-20 columns (and 120), and at most H-8 rows unless the legibility rule
// grew the picture, which is capped at H-6. Returns null when the answer should go to the side pane.
export function fitBox(width, height, term, cell) {
  const maxCols = Math.min(MAX_COLUMNS, term.columns - RESERVED_COLUMNS);
  if (!(maxCols >= MIN_COLUMNS) || !(term.rows - 6 >= 1)) return null;
  // fitCells keeps 4 columns for the transcript margin; the margin here is RESERVED_COLUMNS.
  const box = fitCells(width, height, { columns: maxCols + 4, rows: term.rows }, cell);
  const limit = box.rows > MAX_ROWS ? term.rows - 6 : Math.min(MAX_ROWS, term.rows - 8);
  if (limit < 1) return null;
  if (box.rows <= limit) return { columns: box.columns, rows: box.rows };
  return { columns: Math.max(1, Math.round((box.columns * limit) / box.rows)), rows: limit };
}

// MARK: running the helper

function runHelper(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeoutMs));
    child.stdout.on('data', (d) => { if (stdout.length < 65536) stdout += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stdout }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout }); });
  });
}

const lastJson = (text) => {
  const line = String(text).trim().split('\n').pop();
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/;

// Terminal size and cell size of the pane (VIZPANE_TTY names the pane's terminal itself):
// { columns, rows, cell: { width, aspect } }, or null if the helper cannot say (it reports a
// zero pixel size as an error).
export async function cellSize(helper, tty, { timeoutMs = 3000, run = runHelper } = {}) {
  if (typeof tty !== 'string' || !TTY_PATH.test(tty)) return null;
  const r = await run(helper, ['--cell', tty], timeoutMs);
  const v = lastJson(r.stdout);
  const pos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (v.ok !== true || !pos(v.cellWidth) || !pos(v.cellAspect) || !isInt(v.columns, 1, 10000) || !isInt(v.rows, 1, 10000)) return null;
  return { columns: v.columns, rows: v.rows, cell: { width: v.cellWidth, aspect: v.cellAspect } };
}

// MARK: rendering

// The cache is the one the Claude Code mod uses: <id>.png with a <id>.json sidecar, <id> being
// the source hash and the theme. A picture counts as cached only once its sidecar exists, and
// both files are put in place by rename, so a reader never sees half of either.
const writeAtomic = (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
};

function fromCache(png, meta) {
  try {
    if (!existsSync(png)) return null;
    const size = JSON.parse(readFileSync(meta, 'utf8'));
    return size.width > 0 && size.height > 0 ? { ok: true, png, width: size.width, height: size.height } : null;
  } catch {
    return null;
  }
}

let renderCount = 0;

async function renderOne(source, { root, helper, theme, deadline, run }) {
  const id = `${hashSource(source)}-${theme}`;
  const cache = join(root, 'inline', 'cache');
  const png = join(cache, `${id}.png`);
  const meta = join(cache, `${id}.json`);
  const hit = fromCache(png, meta);
  if (hit) return hit;
  const left = deadline - Date.now();
  if (left <= 50) return { ok: false };
  // Own source and output files per render: another hook (another Codex session) may be rendering
  // the same diagram at this moment, and a shared source file would be truncated under its reader.
  const stem = join(cache, `${id}.${process.pid}-${renderCount++}`);
  const tmp = `${stem}.tmp.png`;
  const src = `${stem}.tmp.mmd`;
  try {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    writeFileSync(src, source, { mode: 0o600 });
    let info;
    for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt++) {
      const r = await run(helper, [join(root, 'inline', 'render.html'), src, tmp, theme], Math.max(1, deadline - Date.now()));
      info = lastJson(r.stdout);
      // WebKit's rule-list store fails now and then when several helpers start at the same moment
      // (about 2 in 90 with three at once). It fails within milliseconds and works on the next try.
      if (info.ok === true || !String(info.error).startsWith('cannot block network') || deadline - Date.now() < 500) break;
    }
    if (info.ok !== true || !(info.width > 0) || !(info.height > 0) || !existsSync(tmp)) return { ok: false };
    renameSync(tmp, png);
    writeAtomic(meta, JSON.stringify({ width: info.width, height: info.height }));
    return { ok: true, png, width: info.width, height: info.height };
  } catch {
    return { ok: false };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(src, { force: true });
  }
}

// Renders the blocks (at most `concurrency` helpers at a time, none after `deadline`, an absolute
// time in ms) and returns one result per block: { ok, png, width, height } or { ok: false }.
// Identical sources in one answer share one render.
export async function renderAll(blocks, {
  root = stateRoot(), helper = rendererPath(root), theme = 'dark', deadline = Date.now() + BUDGET_MS,
  concurrency = MAX_PARALLEL, run = runHelper,
} = {}) {
  const shared = new Map();
  const results = new Array(blocks.length);
  let next = 0;
  const worker = async () => {
    while (next < blocks.length) {
      const i = next++;
      const source = blocks[i].source;
      if (!shared.has(source)) shared.set(source, renderOne(source, { root, helper, theme, deadline, run }));
      results[i] = await shared.get(source);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, blocks.length) }, worker));
  return results;
}

// Deletes cache files whose last write is more than CACHE_DAYS old (what `find -mtime +7 -delete`
// does in the mod, which only runs when a Claude Code session starts, so a Codex-only user would
// otherwise never get pruning). Best effort and bounded: at most PRUNE_LIMIT deletions a call.
export function pruneCache(root, now = Date.now()) {
  const cache = join(root, 'inline', 'cache');
  try {
    let left = PRUNE_LIMIT;
    for (const name of readdirSync(cache)) {
      if (left <= 0) break;
      const file = join(cache, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || now - st.mtimeMs <= CACHE_DAYS * 86400000) continue;
        rmSync(file, { force: true });
        left--;
      } catch {}
    }
  } catch {}
}

// MARK: publish

// Puts a PNG and its cell box into the session directory and returns { id, fresh }. The id comes
// from the content, so the same picture in the same box keeps its id; if another picture has taken
// that id, the next ones are tried. The .cr file goes last: the relay needs both.
export function publish(dir, pngPath, columns, rows) {
  const bytes = readFileSync(pngPath);
  const box = `${columns} ${rows}\n`;
  const h = createHash('sha256').update(bytes).update(box).digest().readUInt32BE(0);
  for (let k = 0; k <= PROBES; k++) {
    const id = ID_MIN + ((h + k) % ID_SPAN);
    const name = hex6(id);
    const dest = join(dir, `${name}.png`);
    const cr = join(dir, `${name}.cr`);
    let existing = null;
    try {
      existing = readFileSync(cr, 'utf8');
    } catch {}
    if (existing !== null) {
      let same = false;
      try {
        same = existing === box && readFileSync(dest).equals(bytes);
      } catch {}
      if (same) return { id, fresh: false };
      continue;
    }
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    try {
      linkSync(pngPath, tmp);
    } catch {
      copyFileSync(pngPath, tmp);
    }
    renameSync(tmp, dest);
    writeAtomic(cr, box);
    return { id, fresh: true };
  }
  throw new Error('publish: no free image id');
}

// MARK: canary

const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

// Called before an emission. If the previous emission was never drawn (the relay did not touch
// `resolved` after it) that is a strike, a drawn emission clears the strikes, and the second strike in a row ends inline pictures for this
// session. Returns false when the session is marked incompatible.
export function canaryCheck(dir, now = Date.now()) {
  if (existsSync(join(dir, 'incompatible'))) return false;
  const emitted = mtime(join(dir, 'emitted'));
  if (emitted === null) return true;
  const resolved = mtime(join(dir, 'resolved'));
  if (resolved !== null && resolved >= emitted) {
    // Only failures in a row count: a picture the user scrolled past while it was drawn is not
    // a sign that this session cannot draw.
    rmSync(join(dir, 'strikes'), { force: true });
    return true;
  }
  if (now - emitted <= CANARY_GRACE_MS) return true;
  let strikes = 0;
  try {
    strikes = Number.parseInt(readFileSync(join(dir, 'strikes'), 'utf8'), 10) || 0;
  } catch {}
  strikes += 1;
  writeAtomic(join(dir, 'strikes'), `${strikes}\n`);
  // The same emission must not count twice.
  rmSync(join(dir, 'emitted'), { force: true });
  if (strikes < CANARY_STRIKES) return true;
  writeAtomic(join(dir, 'incompatible'), 'pictures were not drawn\n');
  return false;
}

// Called after publishing and before the reply is printed: the relay may transmit as soon as
// Codex has the reply, so marking afterwards could land after `resolved`. An emission that only
// reused pictures the relay has already loaded produces no transmit and so is not marked.
export function canaryMark(dir) {
  writeAtomic(join(dir, 'emitted'), `${Date.now()}\n`);
}

// MARK: whole pipeline

// The Stop inline branch after eligibility: returns { message, shown } or null (use the side
// pane). Never throws.
export async function inlineReply({
  env = process.env, gate, root = stateRoot(), startedAt = Date.now(), run = runHelper,
}) {
  try {
    const { dir, blocks } = gate;
    const deadline = startedAt + BUDGET_MS;
    if (!canaryCheck(dir)) return null;
    const helper = rendererPath(root);
    const term = await cellSize(helper, env.VIZPANE_TTY, { timeoutMs: Math.min(3000, deadline - Date.now()), run });
    if (!term) return null;
    // Not even the smallest picture fits: skip the renders too.
    if (term.columns - RESERVED_COLUMNS < MIN_COLUMNS || term.rows < MIN_ROWS) return null;
    const chosen = blocks.slice(0, MAX_DIAGRAMS);
    const theme = env.VIZPANE_THEME === 'light' ? 'light' : 'dark';
    const rendered = await renderAll(chosen, { root, helper, theme, deadline, run });
    const items = [];
    let fresh = false;
    for (let i = 0; i < chosen.length; i++) {
      const r = rendered[i];
      if (!r.ok) continue;
      const box = fitBox(r.width, r.height, term, term.cell);
      if (!box) continue;
      const pub = publish(dir, r.png, box.columns, box.rows);
      fresh = fresh || pub.fresh;
      items.push({ number: i + 1, source: chosen[i].source, id: pub.id, columns: box.columns, rows: box.rows });
    }
    if (!items.length) return null;
    // Left out means every diagram that is not shown, whether it was over the limit or failed.
    const message = buildMessage(items, blocks.length - items.length);
    if (fresh) canaryMark(dir);
    pruneCache(root);
    return { message, shown: items.length };
  } catch {
    return null;
  }
}
