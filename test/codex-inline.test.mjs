import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIACRITICS } from '../plugins/vizpane/lib/diacritics.mjs';
import {
  ID_MIN, ID_SPAN, LABEL_COLUMNS, buildMessage, canaryCheck, canaryMark, cellSize, eligible, fitBox, inlineReply,
  publish, renderAll, sanitizeLabel, sessionDir,
} from '../plugins/vizpane/lib/codex-inline.mjs';
import { hashSource } from '../plugins/vizpane/claude/inline-core.mjs';
import { makePng } from './helpers/png.mjs';

const cp = (n) => String.fromCodePoint(n);
const PLACEHOLDER = cp(0x10EEEE);
const ESC = String.fromCharCode(27);

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vizpane-cx-'));
});

// A session directory the way the relay leaves it: 0700, contract prefix, tui marker.
function sessionDirectory(name = 's1-123-0123456789abcdef') {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'tui'), '');
  return dir;
}

// MARK: diacritics

test('the diacritic table is the kitty one: 297 sorted combining marks, 0 1 2 first', () => {
  assert.equal(DIACRITICS.length, 297);
  assert.deepEqual(DIACRITICS.slice(0, 3), [0x305, 0x30d, 0x30e]); // kitty documentation: rows 0, 1, 2
  for (let i = 1; i < DIACRITICS.length; i++) assert.ok(DIACRITICS[i - 1] < DIACRITICS[i], `entry ${i} is out of order`);
  for (const d of DIACRITICS) assert.match(cp(d), /^\p{Mn}$/u);
  assert.ok(Object.isFrozen(DIACRITICS));
});

// MARK: labels

test('sanitizeLabel drops controls, bidi marks and the placeholder, and keeps the text', () => {
  assert.equal(sanitizeLabel('flowchart LR'), 'flowchart LR');
  assert.equal(sanitizeLabel(`flow${ESC}[31mchart${ESC}]0;x${cp(7)}`), 'flow[31mchart]0;x');
  assert.equal(sanitizeLabel(`a${cp(0x85)}b${cp(0x7f)}c${cp(0x9b)}d`), 'abcd');
  assert.equal(sanitizeLabel(`a${cp(0x202e)}b${cp(0x2066)}c${cp(0x2069)}d${cp(0x200f)}e`), 'abcde');
  assert.equal(sanitizeLabel(`a${PLACEHOLDER}${cp(0x305)}b`), 'a' + cp(0x305) + 'b');
  assert.equal(sanitizeLabel('graph\tTD\r'), 'graph TD');
});

test('sanitizeLabel drops lone surrogates, so the hook output stays valid JSON for serde', () => {
  const label = sanitizeLabel('\uD800lone \uDC00surrogate\uD83D');
  assert.equal(label, 'lone surrogate');
  assert.ok(!/\\ud[89a-f]/i.test(JSON.stringify(label)));
  assert.equal(sanitizeLabel('a\u{1F600}b'), 'a\u{1F600}b', 'a proper pair is kept');
  assert.equal(sanitizeLabel(`a${cp(0x2060)}${cp(0x180e)}${cp(0xe0041)}${cp(0xfff9)}b`), 'ab');
});

test('sanitizeLabel takes the first source line that is not blank or a comment', () => {
  assert.equal(sanitizeLabel('\n\n%% viz: stream A\n  sequenceDiagram\n  A->>B: x'), 'sequenceDiagram');
  assert.equal(sanitizeLabel(''), '');
  assert.equal(sanitizeLabel(undefined), '');
});

test('sanitizeLabel cuts at 48 columns and counts wide characters twice', () => {
  assert.equal(sanitizeLabel('x'.repeat(100)).length, LABEL_COLUMNS);
  const wide = sanitizeLabel('가'.repeat(100));
  assert.equal([...wide].length, LABEL_COLUMNS / 2);
  const mixed = sanitizeLabel('a' + '가'.repeat(100));
  assert.equal([...mixed].length, 1 + 23); // 1 + 46 columns; one more wide character would be 49
});

// MARK: message

const cellsOf = (row) => {
  const body = row.replace(/^\u001b\[38;2;\d+;\d+;\d+m/, '').replace(/\u001b\[39m$/, '');
  return [...new Intl.Segmenter().segment(body)].map((g) => g.segment);
};

test('buildMessage rows hold exactly C placeholder cells with the right tiles, and the colour decodes to the id', () => {
  const id = 0x23a1f0;
  const msg = buildMessage([{ number: 1, source: 'flowchart LR\n A-->B', id, columns: 7, rows: 3 }]);
  const lines = msg.split('\n');
  assert.equal(lines[0], 'vizpane · 1 diagram');
  assert.equal(lines[1], '1 · flowchart LR');
  assert.equal(lines.length, 2 + 3);
  lines.slice(2).forEach((row, r) => {
    assert.ok(row.startsWith(`${ESC}[38;2;35;161;240m`), 'row colour is the id');
    assert.ok(row.endsWith(`${ESC}[39m`));
    const cells = cellsOf(row);
    assert.equal(cells.length, 7);
    cells.forEach((cell, c) => assert.deepEqual([...cell].map((ch) => ch.codePointAt(0)), [0x10eeee, DIACRITICS[r], DIACRITICS[c]]));
  });
});

test('buildMessage decodes the id back for ids across the range', () => {
  for (const id of [ID_MIN, ID_MIN + 1, 0x23a1f0, 0x7fffff]) {
    const row = buildMessage([{ number: 1, source: 'x', id, columns: 1, rows: 1 }]).split('\n')[2];
    const m = /^\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(row);
    assert.equal((Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]), id);
  }
});

test('buildMessage supports the full 255 x 255 box (the diacritic table is long enough)', () => {
  const msg = buildMessage([{ number: 1, source: 'x', id: ID_MIN, columns: 255, rows: 255 }]);
  const rows = msg.split('\n').slice(2);
  assert.equal(rows.length, 255);
  const last = cellsOf(rows[254]);
  assert.equal(last.length, 255);
  assert.deepEqual([...last[254]].map((ch) => ch.codePointAt(0)), [0x10eeee, DIACRITICS[254], DIACRITICS[254]]);
});

test('buildMessage captions several diagrams, separates them with an empty line, and says how many were left out', () => {
  const items = [1, 2, 4].map((number) => ({ number, source: `graph ${number}`, id: ID_MIN + number, columns: 2, rows: 1 }));
  const lines = buildMessage(items, 3).split('\n');
  assert.equal(lines[0], 'vizpane · 3 diagrams and 3 more');
  assert.deepEqual(lines.filter((l) => /^\d+ · /.test(l)), ['1 · graph 1', '2 · graph 2', '4 · graph 4']);
  assert.equal(lines.filter((l) => l === '').length, 2);
});

test('buildMessage rejects values outside the contract instead of printing them', () => {
  const ok = { number: 1, source: 'x', id: ID_MIN, columns: 1, rows: 1 };
  for (const bad of [{ id: ID_MIN - 1 }, { id: 0x800000 }, { id: 1.5 }, { columns: 0 }, { columns: 256 }, { rows: 0 }, { rows: 256 }, { number: 0 }, { id: '123456' }]) {
    assert.throws(() => buildMessage([{ ...ok, ...bad }]), /out of range/, JSON.stringify(bad));
  }
});

// A seeded generator of hostile text: controls, escape sequences, bidi marks, the placeholder and noise.
function hostile(seed) {
  let s = seed >>> 0;
  const rnd = (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  const parts = [
    () => ESC, () => `${ESC}[38;2;1;2;3m`, () => `${ESC}]52;c;AAAA${cp(7)}`, () => `${ESC}_Ga=d${ESC}\\`, () => cp(rnd(0x20)),
    () => cp(0x80 + rnd(0x20)), () => cp(0x7f), () => cp(0x202a + rnd(5)), () => cp(0x2066 + rnd(4)), () => PLACEHOLDER,
    () => cp(DIACRITICS[rnd(297)]), () => '\n', () => '\r\n', () => cp(0x1f600), () => '가', () => 'abc ', () => cp(0x200b), () => cp(0xfeff),
  ];
  return Array.from({ length: 1 + rnd(60) }, () => parts[rnd(parts.length)]()).join('');
}

test('property: no answer byte reaches the message except as sanitized label text', () => {
  const allowedRow = /^\u001b\[38;2;\d+;\d+;\d+m(?:\u{10EEEE}[\u{300}-\u{1D244}]{2})+\u001b\[39m$/u;
  for (let seed = 1; seed <= 400; seed++) {
    const source = hostile(seed);
    const msg = buildMessage([{ number: 1, source, id: ID_MIN + seed, columns: 3, rows: 2 }]);
    const [caption, label, ...rows] = msg.split('\n');
    assert.equal(caption, 'vizpane · 1 diagram');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row, allowedRow, `seed ${seed}`);
      assert.equal(cellsOf(row).length, 3);
    }
    const text = label.replace(/^1 · /, '');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), `control in label, seed ${seed}`);
    assert.ok(!/[\u{202a}-\u{202e}\u{2066}-\u{2069}]/u.test(text), `bidi in label, seed ${seed}`);
    assert.ok(!text.includes(PLACEHOLDER), `placeholder in label, seed ${seed}`);
    assert.ok(!msg.slice(msg.indexOf('\n') + 1).split('\n')[0].includes('\n'));
    assert.equal(msg.split(ESC).length - 1, 2 * 2, 'only the two SGRs of each of the 2 rows');
  }
});

// MARK: sizing

const CELL = { width: 8, aspect: 2 };

test('fitBox leaves 20 columns and caps at 120, for 150 and 100 column terminals', () => {
  // A very wide picture: 2400 x 600 css px.
  const wide150 = fitBox(2400, 600, { columns: 150, rows: 50 }, CELL);
  assert.equal(wide150.columns, 120);
  const wide100 = fitBox(2400, 600, { columns: 100, rows: 50 }, CELL);
  assert.equal(wide100.columns, 80);
  assert.equal(wide100.rows, 10); // 600/2400 of the width, in cells of 1:2
  // The width cap is the reserve: W - 20 on a narrow terminal, however wide the picture.
  assert.equal(fitBox(4000, 100, { columns: 60, rows: 40 }, CELL).columns, 40);
});

test('fitBox falls back to the side pane when there is no room', () => {
  assert.equal(fitBox(400, 200, { columns: 39, rows: 50 }, CELL), null); // 19 usable columns
  assert.notEqual(fitBox(400, 200, { columns: 40, rows: 50 }, CELL), null);
  assert.equal(fitBox(400, 200, { columns: 150, rows: 6 }, CELL), null);
});

test('fitBox keeps rows within the terminal and within the 1 to 255 box', () => {
  const tall = fitBox(300, 6000, { columns: 150, rows: 50 }, CELL);
  assert.ok(tall.rows >= 1 && tall.rows <= 44, `rows ${tall.rows}`); // legibility growth stops at H - 6
  const short = fitBox(300, 6000, { columns: 150, rows: 20 }, CELL);
  assert.ok(short.rows <= 14);
  const tiny = fitBox(1, 1, { columns: 150, rows: 50 }, CELL);
  assert.ok(tiny.columns >= 1 && tiny.rows >= 1);
  for (const [w, h] of [[10000, 10], [10, 10000], [400, 200]]) {
    const b = fitBox(w, h, { columns: 300, rows: 300 }, CELL);
    assert.ok(b.columns >= 1 && b.columns <= 255 && b.rows >= 1 && b.rows <= 255);
  }
  // 30 rows is the normal cap on a tall terminal.
  assert.ok(fitBox(400, 2000, { columns: 150, rows: 60 }, CELL).rows <= 54);
});

// MARK: cell size

test('cellSize reads the helper answer for the given tty and refuses zeros and odd paths', async () => {
  const seen = [];
  const run = (answer) => async (cmd, args) => {
    seen.push([cmd, ...args]);
    return { ok: true, stdout: `noise\n${JSON.stringify(answer)}\n` };
  };
  const good = { ok: true, cellWidth: 8, cellAspect: 2.1, columns: 150, rows: 50 };
  assert.deepEqual(await cellSize('/h/viz-render', '/dev/ttys001', { run: run(good) }), { columns: 150, rows: 50, cell: { width: 8, aspect: 2.1 } });
  assert.deepEqual(seen[0], ['/h/viz-render', '--cell', '/dev/ttys001']);
  for (const bad of [{ ...good, cellWidth: 0 }, { ...good, cellAspect: 0 }, { ...good, columns: 0 }, { ...good, rows: 0 }, { ok: false, error: 'x' }, { ...good, columns: '150' }]) {
    assert.equal(await cellSize('/h/viz-render', '/dev/ttys001', { run: run(bad) }), null, JSON.stringify(bad));
  }
  const before = seen.length;
  for (const tty of [undefined, '', 'ttys001', '/etc/passwd', '/dev/../etc/x y']) {
    assert.equal(await cellSize('/h/viz-render', tty, { run: run(good) }), null, String(tty));
  }
  assert.equal(seen.length, before, 'the helper is not even started for a bad path');
  assert.equal(await cellSize('/h/viz-render', '/dev/ttys001', { run: async () => ({ ok: false, stdout: '' }) }), null);
});

// MARK: rendering

// A render that writes a PNG and answers like viz-render; tracks how many run at once.
function stubRun({ delay = 0, fail = () => false } = {}) {
  const stats = { calls: [], live: 0, peak: 0 };
  const run = async (cmd, args) => {
    stats.calls.push(args);
    stats.live++;
    stats.peak = Math.max(stats.peak, stats.live);
    try {
      await new Promise((r) => setTimeout(r, delay));
      const [, src, out] = args;
      if (fail(readFileSync(src, 'utf8'))) return { ok: false, stdout: '{"ok":false,"error":"x"}\n' };
      writeFileSync(out, makePng(4, 2));
      return { ok: true, stdout: '{"ok":true,"width":400,"height":200}\n' };
    } finally {
      stats.live--;
    }
  };
  return { run, stats };
}
const blocksOf = (...sources) => sources.map((source) => ({ source }));

test('renderAll renders at most 3 at a time, in order, and writes the shared cache layout', async () => {
  const { run, stats } = stubRun({ delay: 30 });
  const blocks = blocksOf('a', 'b', 'c', 'd', 'e', 'f');
  const res = await renderAll(blocks, { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 5000, run });
  assert.equal(res.length, 6);
  assert.ok(res.every((r) => r.ok && r.width === 400 && r.height === 200));
  assert.equal(stats.peak, 3);
  const cache = join(tmp, 'inline/cache');
  const id = `${hashSource('a')}-dark`;
  assert.equal(res[0].png, join(cache, `${id}.png`));
  assert.deepEqual(JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8')), { width: 400, height: 200 });
  assert.deepEqual(readdirSync(cache).filter((f) => f.includes('.tmp')), [], 'no temporary files left');
  assert.equal(stats.calls[0][0], join(tmp, 'inline/render.html'));
  assert.equal(new Set(stats.calls.map((c) => c[1])).size, 6, 'each render has its own source file');
  assert.equal(stats.calls[0][3], 'dark');
});

test('renderAll serves cached pictures without running the helper, and keys the cache by theme', async () => {
  const { run, stats } = stubRun();
  const deadline = Date.now() + 5000;
  await renderAll(blocksOf('a', 'b'), { root: tmp, helper: '/h', theme: 'dark', deadline, run });
  assert.equal(stats.calls.length, 2);
  const again = await renderAll(blocksOf('a', 'b'), { root: tmp, helper: '/h', theme: 'dark', deadline, run });
  assert.equal(stats.calls.length, 2);
  assert.ok(again.every((r) => r.ok));
  await renderAll(blocksOf('a'), { root: tmp, helper: '/h', theme: 'light', deadline, run });
  assert.equal(stats.calls.length, 3);
});

test('renderAll renders an identical source once, and a cache entry without a sidecar is rendered again', async () => {
  const { run, stats } = stubRun();
  const deadline = Date.now() + 5000;
  const res = await renderAll(blocksOf('same', 'same', 'same'), { root: tmp, helper: '/h', theme: 'dark', deadline, run });
  assert.equal(stats.calls.length, 1);
  assert.ok(res.every((r) => r.ok));
  const cache = join(tmp, 'inline/cache');
  writeFileSync(join(cache, `${hashSource('lonely')}-dark.png`), 'half a file');
  await renderAll(blocksOf('lonely'), { root: tmp, helper: '/h', theme: 'dark', deadline, run });
  assert.equal(stats.calls.length, 2);
});

test('renderAll reports a failed render as not ok and leaves nothing behind', async () => {
  const { run } = stubRun({ fail: (src) => src === 'bad' });
  const res = await renderAll(blocksOf('good', 'bad'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 5000, run });
  assert.equal(res[0].ok, true);
  assert.equal(res[1].ok, false);
  assert.deepEqual(readdirSync(join(tmp, 'inline/cache')).filter((f) => f.startsWith(hashSource('bad')) && /\.(png|json)$/.test(f)), []);
});

test('renderAll starts nothing once the deadline has passed', async () => {
  const { run, stats } = stubRun();
  const res = await renderAll(blocksOf('a', 'b'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() - 1, run });
  assert.deepEqual(res.map((r) => r.ok), [false, false]);
  assert.equal(stats.calls.length, 0);
});

test('renderAll tries again when the helper fails to start its network block, and only then', async () => {
  const transient = '{"ok":false,"error":"cannot block network: The operation could not be completed. (WKErrorDomain error 6.)"}\n';
  let calls = 0;
  const flaky = async (cmd, args) => {
    calls++;
    if (calls < 3) return { ok: false, stdout: transient };
    writeFileSync(args[2], makePng(4, 2));
    return { ok: true, stdout: '{"ok":true,"width":400,"height":200}\n' };
  };
  const res = await renderAll(blocksOf('a'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 5000, run: flaky });
  assert.equal(res[0].ok, true);
  assert.equal(calls, 3);

  calls = 0;
  const always = async () => { calls++; return { ok: false, stdout: transient }; };
  assert.equal((await renderAll(blocksOf('b'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 5000, run: always }))[0].ok, false);
  assert.equal(calls, 3, 'three attempts at most');

  calls = 0;
  const broken = async () => { calls++; return { ok: false, stdout: '{"ok":false,"error":"Parse error on line 2"}\n' }; };
  assert.equal((await renderAll(blocksOf('c'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 5000, run: broken }))[0].ok, false);
  assert.equal(calls, 1, 'a diagram that does not parse is not retried');
});

test('renderAll passes the time left to each render', async () => {
  const limits = [];
  const run = async (cmd, args, ms) => {
    limits.push(ms);
    return { ok: false, stdout: '' };
  };
  await renderAll(blocksOf('a'), { root: tmp, helper: '/h', theme: 'dark', deadline: Date.now() + 4000, run });
  assert.ok(limits[0] > 3000 && limits[0] <= 4000, String(limits[0]));
});

// MARK: publish

const expectedId = (png, c, r) => ID_MIN + (createHash('sha256').update(png).update(`${c} ${r}\n`).digest().readUInt32BE(0) % ID_SPAN);
const hex6 = (id) => id.toString(16).padStart(6, '0');

function cachedPng(rgb, name = 'p.png') {
  const file = join(tmp, name);
  writeFileSync(file, makePng(4, 2, rgb));
  return file;
}

test('publish names the files after a content id in [0x100000, 0x7FFFFF] and writes "C R"', () => {
  const dir = sessionDirectory();
  const src = cachedPng([1, 2, 3]);
  const r = publish(dir, src, 80, 20);
  assert.equal(r.fresh, true);
  assert.equal(r.id, expectedId(readFileSync(src), 80, 20));
  assert.ok(r.id >= 0x100000 && r.id <= 0x7fffff);
  assert.deepEqual(readFileSync(join(dir, `${hex6(r.id)}.png`)), readFileSync(src));
  assert.equal(readFileSync(join(dir, `${hex6(r.id)}.cr`), 'utf8'), '80 20\n');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('tmp')), []);
  assert.equal(statSync(join(dir, `${hex6(r.id)}.png`)).ino, statSync(src).ino, 'hard-linked from the cache');
});

test('publish is idempotent: the same picture and box keep their id and are not fresh the second time', () => {
  const dir = sessionDirectory();
  const src = cachedPng([1, 2, 3]);
  const a = publish(dir, src, 10, 5);
  const crBefore = statSync(join(dir, `${hex6(a.id)}.cr`)).mtimeMs;
  const b = publish(dir, src, 10, 5);
  assert.deepEqual(b, { id: a.id, fresh: false });
  assert.equal(statSync(join(dir, `${hex6(a.id)}.cr`)).mtimeMs, crBefore);
  assert.notEqual(publish(dir, src, 10, 6).id, a.id, 'another box is another id');
});

test('publish probes the next id when the first one holds a different box or a different picture', () => {
  const src = cachedPng([9, 9, 9]);
  const png = readFileSync(src);
  const first = expectedId(png, 40, 10);

  const dir1 = sessionDirectory('s1-1-aaaaaaaaaaaaaaaa');
  writeFileSync(join(dir1, `${hex6(first)}.png`), 'other');
  writeFileSync(join(dir1, `${hex6(first)}.cr`), '1 1\n');
  const r1 = publish(dir1, src, 40, 10);
  assert.equal(r1.id, first + 1);
  assert.equal(r1.fresh, true);
  assert.equal(readFileSync(join(dir1, `${hex6(first)}.cr`), 'utf8'), '1 1\n', 'the other picture is untouched');

  const dir2 = sessionDirectory('s1-2-bbbbbbbbbbbbbbbb');
  writeFileSync(join(dir2, `${hex6(first)}.png`), 'other picture, same box');
  writeFileSync(join(dir2, `${hex6(first)}.cr`), '40 10\n');
  assert.equal(publish(dir2, src, 40, 10).id, first + 1);
});

test('publish gives up after 16 probes and wraps inside the id range', () => {
  const src = cachedPng([5, 5, 5]);
  const png = readFileSync(src);
  const dir = sessionDirectory();
  const start = expectedId(png, 3, 3);
  for (let k = 0; k <= 16; k++) writeFileSync(join(dir, `${hex6(ID_MIN + ((start - ID_MIN + k) % ID_SPAN))}.cr`), 'x\n');
  assert.throws(() => publish(dir, src, 3, 3), /no free image id/);
});

test('publish writes the png before the .cr, and no .cr when the png cannot be written', () => {
  const src = cachedPng([7, 7, 7]);
  const id = expectedId(readFileSync(src), 6, 3);

  // The .cr destination is a directory: the png is already in place when the .cr write fails.
  const dir1 = sessionDirectory('s1-1-aaaaaaaaaaaaaaaa');
  mkdirSync(join(dir1, `${hex6(id)}.cr`));
  assert.throws(() => publish(dir1, src, 6, 3));
  assert.ok(statSync(join(dir1, `${hex6(id)}.png`)).isFile());

  // The png destination is a directory: nothing was written as a .cr.
  const dir2 = sessionDirectory('s1-2-bbbbbbbbbbbbbbbb');
  mkdirSync(join(dir2, `${hex6(id)}.png`));
  assert.throws(() => publish(dir2, src, 6, 3));
  assert.equal(existsSync(join(dir2, `${hex6(id)}.cr`)), false);
});

// MARK: canary

const touch = (file, ageMs, now) => {
  writeFileSync(file, 'x\n');
  const t = new Date(now - ageMs);
  utimesSync(file, t, t);
};

test('canary: an emission that the relay resolved is no strike', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  touch(join(dir, 'emitted'), 60000, now);
  touch(join(dir, 'resolved'), 59000, now);
  assert.equal(canaryCheck(dir, now), true);
  assert.equal(existsSync(join(dir, 'strikes')), false);
});

test('canary: a recent emission is given time, a first emission has nothing to check', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  assert.equal(canaryCheck(dir, now), true);
  touch(join(dir, 'emitted'), 5000, now);
  assert.equal(canaryCheck(dir, now), true);
  assert.equal(existsSync(join(dir, 'strikes')), false);
});

test('canary: a stale emission that was never resolved is a strike, and two strikes switch the session off', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  touch(join(dir, 'emitted'), 30000, now);
  assert.equal(canaryCheck(dir, now), true, 'one strike still draws');
  assert.equal(readFileSync(join(dir, 'strikes'), 'utf8').trim(), '1');
  assert.equal(existsSync(join(dir, 'emitted')), false, 'the same emission does not count twice');
  assert.equal(canaryCheck(dir, now), true);
  assert.equal(readFileSync(join(dir, 'strikes'), 'utf8').trim(), '1');
  touch(join(dir, 'emitted'), 30000, now);
  touch(join(dir, 'resolved'), 90000, now); // resolved, but before the emission
  assert.equal(canaryCheck(dir, now), false, 'second strike');
  assert.ok(existsSync(join(dir, 'incompatible')));
  assert.equal(canaryCheck(dir, now), false);
  assert.equal(eligible({ VIZPANE_INLINE_DIR: dir }, { markdown: '```mermaid\nA\n```' }, { ready: () => true }), null);
});

test('canary: fail, success, fail is not incompatible', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  touch(join(dir, 'emitted'), 30000, now);
  assert.equal(canaryCheck(dir, now), true, 'first failure');
  assert.equal(readFileSync(join(dir, 'strikes'), 'utf8').trim(), '1');
  touch(join(dir, 'emitted'), 20000, now);
  touch(join(dir, 'resolved'), 19000, now);
  assert.equal(canaryCheck(dir, now), true, 'success');
  assert.equal(existsSync(join(dir, 'strikes')), false, 'the success clears the strikes');
  touch(join(dir, 'emitted'), 11000, now);
  assert.equal(canaryCheck(dir, now), true, 'failure after a success is a first failure again');
  assert.equal(readFileSync(join(dir, 'strikes'), 'utf8').trim(), '1');
  assert.equal(existsSync(join(dir, 'incompatible')), false);
});

test('canary: a success inside the grace time still clears the strikes', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  writeFileSync(join(dir, 'strikes'), '1\n');
  touch(join(dir, 'emitted'), 5000, now);
  touch(join(dir, 'resolved'), 4000, now);
  assert.equal(canaryCheck(dir, now), true);
  assert.equal(existsSync(join(dir, 'strikes')), false);
});

test('canary: fail, fail is incompatible', () => {
  const dir = sessionDirectory();
  const now = Date.now();
  touch(join(dir, 'emitted'), 30000, now);
  assert.equal(canaryCheck(dir, now), true);
  touch(join(dir, 'emitted'), 20000, now);
  assert.equal(canaryCheck(dir, now), false);
  assert.ok(existsSync(join(dir, 'incompatible')));
});

test('canaryMark writes emitted', () => {
  const dir = sessionDirectory();
  canaryMark(dir);
  assert.ok(existsSync(join(dir, 'emitted')));
});

// MARK: eligible

const FENCE = { markdown: 'Intro\n```mermaid\nflowchart LR\n A-->B\n```\n' };

test('eligible: all conditions hold, then each one flips the result', () => {
  const dir = sessionDirectory();
  const env = { VIZPANE_INLINE_DIR: dir };
  const ready = () => true;
  const got = eligible(env, FENCE, { ready });
  assert.equal(got.dir, dir);
  assert.equal(got.blocks.length, 1);
  assert.equal(got.blocks[0].source, 'flowchart LR\n A-->B');

  assert.equal(eligible({}, FENCE, { ready }), null, 'no session dir');
  assert.equal(eligible({ ...env, VIZPANE_INLINE: 'off' }, FENCE, { ready }), null);
  assert.equal(eligible({ ...env, CODEX_THREAD_ID: 'abc' }, FENCE, { ready }), null);
  assert.equal(eligible({ ...env, NO_COLOR: '1' }, FENCE, { ready }), null);
  assert.equal(eligible(env, FENCE, { ready: () => false }), null, 'renderer not built');
  assert.equal(eligible(env, { markdown: 'no diagram' }, { ready }), null);
  assert.equal(eligible(env, null, { ready }), null);
  assert.equal(eligible({ ...env, VIZPANE_INLINE: 'on', NO_COLOR: '', CODEX_THREAD_ID: '' }, FENCE, { ready }).dir, dir, 'empty values count as unset');
  writeFileSync(join(dir, 'incompatible'), 'x');
  assert.equal(eligible(env, FENCE, { ready }), null);
});

test('sessionDir refuses what the relay would not have made', () => {
  const good = sessionDirectory();
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: good }), good);
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: 'relative/s1-x' }), null);
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: join(tmp, 'missing', 's1-x') }), null);

  const wrongPrefix = sessionDirectory('s2-1-aaaa');
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: wrongPrefix }), null, 'another contract version');

  const open = sessionDirectory('s1-2-open');
  chmodSync(open, 0o755);
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: open }), null, 'not 0700');

  const noTui = join(tmp, 's1-3-notui');
  mkdirSync(noTui, { mode: 0o700 });
  chmodSync(noTui, 0o700);
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: noTui }), null, 'TUI is not live');

  const link = join(tmp, 's1-4-link');
  symlinkSync(good, link);
  assert.equal(sessionDir({ VIZPANE_INLINE_DIR: link }), null, 'a symlink is not a session directory');
});

// MARK: pipeline

function term(over = {}) {
  return { ok: true, cellWidth: 8, cellAspect: 2, columns: 150, rows: 50, ...over };
}
// One run function for the helper: --cell answers `answer`, a render writes a PNG of css size 800 x 400.
function pipelineRun(answer = term(), { width = 800, height = 400, fail = false } = {}) {
  const seen = { cell: 0, render: 0 };
  const run = async (cmd, args) => {
    if (args[0] === '--cell') {
      seen.cell++;
      return { ok: answer.ok, stdout: `${JSON.stringify(answer)}\n` };
    }
    seen.render++;
    if (fail) return { ok: false, stdout: '' };
    writeFileSync(args[2], makePng(4, 2));
    return { ok: true, stdout: `${JSON.stringify({ ok: true, width, height })}\n` };
  };
  return { run, seen };
}
const gateFor = (dir, ...sources) => ({ dir, blocks: sources.map((source) => ({ source })) });
const pipelineEnv = { VIZPANE_TTY: '/dev/ttys999' };

test('inlineReply publishes each diagram, builds the message and marks the emission', async () => {
  const dir = sessionDirectory();
  const { run } = pipelineRun();
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'flowchart LR\nA-->B', 'sequenceDiagram\nA->>B: x'), root: tmp, run });
  assert.equal(reply.shown, 2);
  const lines = reply.message.split('\n');
  assert.equal(lines[0], 'vizpane · 2 diagrams');
  assert.ok(lines.includes('1 · flowchart LR') && lines.includes('2 · sequenceDiagram'));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.png')).length, 1, 'identical pictures in identical boxes share one id');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.cr')).length, 1);
  assert.ok(existsSync(join(dir, 'emitted')));
  // 800 x 400 css px at 8 pt cells of aspect 2: 100 columns by 25 rows.
  const rows = lines.filter((l) => l.includes(PLACEHOLDER));
  assert.equal(cellsOf(rows[0]).length, 100);
  assert.equal(rows.length, 50);
});

test('inlineReply: the second answer with the same diagram reuses the picture and does not re-arm the canary', async () => {
  const dir = sessionDirectory();
  const { run } = pipelineRun();
  await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nA-->B'), root: tmp, run });
  const t = new Date(Date.now() - 60000);
  utimesSync(join(dir, 'emitted'), t, t);
  writeFileSync(join(dir, 'resolved'), '');
  const before = statSync(join(dir, 'emitted')).mtimeMs;
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nA-->B'), root: tmp, run });
  assert.equal(reply.shown, 1);
  assert.equal(statSync(join(dir, 'emitted')).mtimeMs, before, 'nothing new was published, nothing to wait for');
});

test('inlineReply deletes cache files older than 7 days and keeps newer ones, as the Claude Code mod does at start', async () => {
  const dir = sessionDirectory();
  const cache = join(tmp, 'inline', 'cache');
  mkdirSync(cache, { recursive: true });
  const old = new Date(Date.now() - 8 * 86400000);
  const recent = new Date(Date.now() - 6 * 86400000);
  for (const name of ['old.png', 'old.json', 'old.123-0.tmp.png']) {
    writeFileSync(join(cache, name), 'x');
    utimesSync(join(cache, name), old, old);
  }
  writeFileSync(join(cache, 'recent.png'), 'x');
  utimesSync(join(cache, 'recent.png'), recent, recent);
  const { run } = pipelineRun();
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nA-->B'), root: tmp, run });
  assert.equal(reply.shown, 1);
  assert.deepEqual(readdirSync(cache).filter((f) => f.startsWith('old')), [], 'the old files are gone');
  assert.ok(existsSync(join(cache, 'recent.png')), 'a newer file stays');
  assert.ok(readdirSync(cache).some((f) => f.endsWith('.png') && f !== 'recent.png'), 'this answer\'s own picture stays');
});

test('inlineReply shows at most 6 diagrams and says how many were left out', async () => {
  const dir = sessionDirectory();
  const { run, seen } = pipelineRun();
  const sources = Array.from({ length: 8 }, (_, i) => `graph TD\nN${i}-->M${i}`);
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, ...sources), root: tmp, run });
  assert.equal(reply.shown, 6);
  assert.equal(reply.message.split('\n')[0], 'vizpane · 6 diagrams and 2 more');
  assert.equal(seen.render, 6);
});

test('inlineReply leaves out a diagram that failed to render, keeps its number gap and counts it as left out', async () => {
  const dir = sessionDirectory();
  const run = async (cmd, args) => {
    if (args[0] === '--cell') return { ok: true, stdout: `${JSON.stringify(term())}\n` };
    if (readFileSync(args[1], 'utf8').includes('BAD')) return { ok: false, stdout: '' };
    writeFileSync(args[2], makePng(4, 2));
    return { ok: true, stdout: '{"ok":true,"width":400,"height":200}\n' };
  };
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nA', 'graph TD\nBAD', 'graph LR\nC'), root: tmp, run });
  assert.equal(reply.shown, 2);
  const labels = reply.message.split('\n').filter((l) => /^\d+ · /.test(l));
  assert.deepEqual(labels, ['1 · graph TD', '3 · graph LR']);
  assert.equal(reply.message.split('\n')[0], 'vizpane · 2 diagrams and 1 more', 'the caption does not hide the diagram that is missing');
});

test('inlineReply falls back (null) when the terminal gives no size, no room, or the renderer fails', async () => {
  const dir = sessionDirectory();
  const gate = gateFor(dir, 'graph TD\nA-->B');
  for (const answer of [term({ cellWidth: 0 }), term({ cellAspect: 0 }), term({ columns: 0 }), term({ ok: false }), term({ columns: 39 }), term({ rows: 6 }), term({ rows: 8 })]) {
    const { run, seen } = pipelineRun(answer);
    assert.equal(await inlineReply({ env: pipelineEnv, gate, root: tmp, run }), null, JSON.stringify(answer));
    assert.equal(seen.render, 0, 'no render for a terminal without room');
  }
  assert.equal(await inlineReply({ env: {}, gate, root: tmp, run: pipelineRun().run }), null, 'no VIZPANE_TTY');
  assert.equal(await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nnever rendered'), root: tmp, run: pipelineRun(term(), { fail: true }).run }), null);
  assert.deepEqual(readdirSync(dir), ['tui'], 'a fallback publishes nothing');
});

test('inlineReply asks for the size of the terminal named by VIZPANE_TTY, and only that one', async () => {
  const dir = sessionDirectory();
  const asked = [];
  const run = async (cmd, args) => {
    if (args[0] === '--cell') {
      asked.push(args.slice(1));
      return { ok: true, stdout: `${JSON.stringify(term())}\n` };
    }
    writeFileSync(args[2], makePng(4, 2));
    return { ok: true, stdout: '{"ok":true,"width":400,"height":200}\n' };
  };
  const reply = await inlineReply({ env: { VIZPANE_TTY: '/dev/ttys042' }, gate: gateFor(dir, 'graph TD\nA-->B'), root: tmp, run });
  assert.equal(reply.shown, 1);
  // The hook has no controlling terminal of its own; an empty list would make the helper guess one.
  assert.deepEqual(asked, [['/dev/ttys042']]);
});

test('inlineReply clamps the box to 1..255 and keeps every tile addressable', async () => {
  const dir = sessionDirectory();
  const { run } = pipelineRun(term({ columns: 400, rows: 400 }), { width: 4, height: 4000 });
  const reply = await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nA-->B'), root: tmp, run });
  const rows = reply.message.split('\n').filter((l) => l.includes(PLACEHOLDER));
  assert.ok(rows.length >= 1 && rows.length <= 255);
  assert.ok(cellsOf(rows[0]).length >= 1);
});

test('inlineReply honours VIZPANE_THEME=light and an incompatible session', async () => {
  const dir = sessionDirectory();
  const { run } = pipelineRun();
  await inlineReply({ env: { ...pipelineEnv, VIZPANE_THEME: 'light' }, gate: gateFor(dir, 'graph TD\nA'), root: tmp, run });
  assert.ok(existsSync(join(tmp, 'inline/cache', `${hashSource('graph TD\nA')}-light.png`)));
  writeFileSync(join(dir, 'incompatible'), 'x');
  assert.equal(await inlineReply({ env: pipelineEnv, gate: gateFor(dir, 'graph TD\nB'), root: tmp, run }), null);
});
