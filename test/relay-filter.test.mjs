// T1: the relay's output filter (plugins/vizpane/inline/relay-filter.h), without a pty.
//
// The filter is compiled into test/relay/filter-main.c with AddressSanitizer and
// UndefinedBehaviorSanitizer. Streams are generated here, fed to it in every split
// position and in random chunks, and the result is checked against the properties of
// the design:
//
//   R1  removing every inserted APC from the output gives exactly the input;
//   R2  every insertion sits at a ground point, as an independent lexer
//       (test/helpers/vtlex.mjs) sees it: parser in ground, no UTF-8 sequence open,
//       no chunked kitty load open on the active screen;
//   R3  every inserted byte is fixed ASCII, a decimal integer the filter validated, or
//       the base64 of <session dir>/<6 hex>.png.
//
// VIZPANE_FUZZ=1 runs 10^6 random streams instead of 2*10^4. VIZPANE_FUZZ_SEED changes the
// base seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync, realpathSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex, isGround, ST } from './helpers/vtlex.mjs';
import { makePng } from './helpers/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'relay', 'filter-main.c');
const HEADER = join(here, '..', 'plugins', 'vizpane', 'inline', 'relay-filter.h');
const HAVE_CC = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_CC ? false : 'cc is not available';
const FUZZ = process.env.VIZPANE_FUZZ === '1';
const FUZZ_SEED = Number(process.env.VIZPANE_FUZZ_SEED || 1);

const work = mkdtempSync(join(tmpdir(), 'vizpane-filter-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });
const ASAN = join(work, 'filter-asan');
const FAST = join(work, 'filter-fast');

function build(out, flags) {
  const r = spawnSync('cc', [...flags, '-Wall', '-Wextra', '-o', out, SRC], { encoding: 'utf8' });
  assert.equal(r.status, 0, `cc failed:\n${r.stderr}`);
  assert.equal(r.stderr.trim(), '', `compiler warnings:\n${r.stderr}`);
}
if (HAVE_CC) {
  build(ASAN, ['-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=undefined']);
  build(FAST, ['-O2']);
}

// ---------------------------------------------------------------------------
// Fixtures: a session directory with images, generated here.

const ESC = '\x1b';
const PH = String.fromCodePoint(0x10eeee);
const hex6 = (id) => id.toString(16).padStart(6, '0');
const DIAC = ['̅', '̍', '̎', '̐'];

// The IHDR of a real small PNG with another size: the filter reads the header only.
function fakePng(width, height) {
  const png = Buffer.from(makePng(1, 1));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

let sessionCounter = 0;
function newSession() {
  const dir = join(realpathSync(work), `s${sessionCounter++}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function putImage(dir, id, { w = 40, h = 20, cr = '40 10\n' } = {}) {
  writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(w, h));
  if (cr !== null) writeFileSync(join(dir, `${hex6(id)}.cr`), cr);
}

const IDS = [0x123456, 0x234567, 0x345678];
const ID_ABSENT = 0x456789;
const SESSION = newSession();
for (const id of IDS) putImage(SESSION, id);

// ---------------------------------------------------------------------------
// Stream builder with named offsets.

class B {
  constructor() { this.parts = []; this.len = 0; this.marks = {}; }
  add(x) {
    const b = Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8');
    this.parts.push(b); this.len += b.length;
    return this;
  }
  mark(name) { this.marks[name] = this.len; return this; }
  buf() { return Buffer.concat(this.parts); }
}

const sgrId = (id, tail = '') => `${ESC}[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}${tail}m`;
const cells = (n, r = 0) => Array.from({ length: n }, (_, c) => PH + DIAC[r % 4] + DIAC[c % 4]).join('');
// a row of two cells with the position of its first placeholder marked
const addRow = (b, id, name) => b.add(`${ESC}[13;5H|${sgrId(id, ';49')}`).mark(name).add(cells(2)).add(`${ESC}[39;49m|`);
const rowOf = (id, n, r = 0) => `${ESC}[${13 + r};5H|${sgrId(id, ';49')}${cells(n, r)}${ESC}[39;49m|`;
const apc = (ctl, payload = '') => `${ESC}_G${ctl};${payload}${ESC}\\`;
const b64 = (n) => Buffer.alloc(n, 0x41).toString('base64');

// ---------------------------------------------------------------------------
// Running the driver.

function parseStderr(text, label) {
  const streams = [];
  let cur = null;
  const open = () => { cur = { ins: [], stat: null, time: null }; streams.push(cur); return cur; };
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let m;
    if (line.startsWith('STREAM ')) { open(); continue; }
    if ((m = /^INS (\d+) (\d+) (\d+) ([TD]) (\d+)$/.exec(line))) {
      (cur || open()).ins.push({ inOff: Number(m[1]), outOff: Number(m[2]), len: Number(m[3]), kind: m[4], id: Number(m[5]) });
    } else if (line.startsWith('STAT ')) {
      const stat = Object.fromEntries(line.slice(5).split(' ').map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
      (cur || open()).stat = stat;
      cur = null;
    } else if (line.startsWith('TIME ')) {
      const t = Object.fromEntries(line.slice(5).split(' ').map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
      streams.time = t;
    } else {
      assert.fail(`${label}: unexpected driver output (a sanitizer report?):\n${text.slice(0, 2000)}`);
    }
  }
  return streams;
}

let driveCounter = 0;
function drive(input, { dir = SESSION, args = [], bin = ASAN, label = 'driver' } = {}) {
  // Files, not pipes: a pipe to a child that reads all of its input first can stall under load.
  const base = join(work, `drive-${driveCounter++}`);
  writeFileSync(`${base}.in`, input);
  const fdIn = openSync(`${base}.in`, 'r');
  const fdOut = openSync(`${base}.out`, 'w');
  const fdErr = openSync(`${base}.err`, 'w');
  let r;
  try {
    r = spawnSync(bin, [dir ?? '-', ...args], { stdio: [fdIn, fdOut, fdErr], timeout: 300000 });
  } finally {
    closeSync(fdIn); closeSync(fdOut); closeSync(fdErr);
  }
  const stdout = readFileSync(`${base}.out`);
  const stderr = readFileSync(`${base}.err`, 'latin1');
  for (const ext of ['in', 'out', 'err']) rmSync(`${base}.${ext}`, { force: true });
  assert.equal(r.status, 0, `${label}: driver exit ${r.status} ${r.signal ?? ''}\n${stderr.slice(0, 3000)}`);
  return { stdout, streams: parseStderr(stderr, label) };
}

function runOnce(input, opts = {}) {
  const { stdout, streams } = drive(input, opts);
  assert.equal(streams.length, 1);
  return { out: stdout, ...streams[0] };
}

// Several results from one process: --multi and --each-split frame their stdout.
function splitFrames(stdout) {
  const outs = [];
  let pos = 0;
  while (pos < stdout.length) {
    const n = stdout.readUInt32LE(pos);
    outs.push(stdout.subarray(pos + 4, pos + 4 + n));
    pos += 4 + n;
  }
  return outs;
}

function runMany(input, args, opts = {}) {
  const { stdout, streams } = drive(input, { ...opts, args });
  const outs = splitFrames(stdout);
  assert.equal(outs.length, streams.length);
  return outs.map((out, i) => ({ out, ...streams[i] }));
}

function multiInput(streams) {
  return Buffer.concat(streams.flatMap((s) => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(s.length);
    return [h, s];
  }));
}

// R1, R2 and R3 for one result.
const TX_RE = /^\x1b_Ga=T,U=1,f=100,t=f,q=2,C=1,i=(\d+),c=(\d+),r=(\d+);([A-Za-z0-9+/]+={0,2})\x1b\\$/;
const DEL_RE = /^\x1b_Ga=d,d=I,i=(\d+),q=2\x1b\\$/;

function check(input, res, { dir = SESSION, ref = lex(input), label = '' } = {}) {
  const { out, ins } = res;
  // R1 and the position of every insertion in the output
  let rebuilt = Buffer.alloc(0);
  let pos = 0, added = 0;
  const chunks = [];
  for (const e of ins) {
    assert.ok(e.outOff >= pos, `${label}: insertions overlap or are out of order`);
    assert.equal(e.outOff, e.inOff + added, `${label}: insertion at input ${e.inOff} is not at output ${e.inOff + added} but ${e.outOff}`);
    chunks.push(out.subarray(pos, e.outOff));
    pos = e.outOff + e.len;
    assert.ok(pos <= out.length, `${label}: insertion runs past the output`);
    added += e.len;
  }
  chunks.push(out.subarray(pos));
  rebuilt = Buffer.concat(chunks);
  assert.ok(rebuilt.equals(input), `${label}: output without insertions differs from the input (R1)`);

  // The transmit goes in front of the held region, which can hold up to VF_HOLD_MAX bytes of broken
  // UTF-8 before the placeholder that completes it.
  const seenPlaceholder = (id, at) => ref.placeholders.some((p) => p.fg === id && p.end <= at + 64);
  const sent = new Set();
  for (const e of ins) {
    // R2
    assert.ok(isGround(ref, e.inOff), `${label}: insertion at input ${e.inOff} is not at a ground point (R2)`);
    // R3
    const text = out.subarray(e.outOff, e.outOff + e.len).toString('latin1');
    if (e.kind === 'T') {
      const m = TX_RE.exec(text);
      assert.ok(m, `${label}: malformed transmit ${JSON.stringify(text)} (R3)`);
      const id = Number(m[1]);
      assert.equal(id, e.id);
      assert.ok(id >= 0x100000 && id <= 0x7fffff);
      const c = Number(m[2]), r = Number(m[3]);
      assert.ok(c >= 1 && c <= 255 && r >= 1 && r <= 255);
      assert.equal(Buffer.from(m[4], 'base64').toString('latin1'), `${dir}/${hex6(id)}.png`, `${label}: wrong path (R3)`);
      assert.ok(seenPlaceholder(id, e.inOff), `${label}: transmit for ${hex6(id)} without a placeholder before it`);
      sent.add(id);
    } else {
      const m = DEL_RE.exec(text);
      assert.ok(m, `${label}: malformed delete ${JSON.stringify(text)} (R3)`);
      assert.equal(Number(m[1]), e.id);
      assert.ok(sent.has(e.id), `${label}: delete of ${hex6(e.id)}, which was never transmitted`);
    }
  }
}

const sig = (res) => res.ins.map((e) => `${e.kind}${e.id}@${e.inOff}`);
const kinds = (res) => res.ins.map((e) => `${e.kind}:${hex6(e.id)}`);

// A stream, split at every byte position and fed in random chunk sizes. `expectIns` is the list of
// [kind, id, offset or mark name] the insertions must be, in order. `finish` lists the ids that are
// freed when the stream ends (any order); the stream ends with those deletes.
function golden(name, b, expectIns, { finish = [], dir = SESSION, flushExact = true, lite = false } = {}) {
  const input = b.buf();
  const ref = lex(input);
  const at = (x) => (typeof x === 'string' ? b.marks[x] : x);
  const want = expectIns.map(([k, id, where]) => `${k}${id}@${at(where)}`);
  const wantKinds = expectIns.map(([k, id]) => `${k}:${hex6(id)}`);
  const tail = [...finish].sort((x, y) => x - y).map((id) => `D${id}@${input.length}`);

  // the tail is compared as a set, the rest in order
  const split = (res) => {
    const head = res.ins.slice(0, res.ins.length - finish.length);
    const end = res.ins.slice(res.ins.length - finish.length);
    return { head, end: end.map((e) => `${e.kind}${e.id}@${e.inOff}`).sort((x, y) => Number(x.slice(1, x.indexOf('@'))) - Number(y.slice(1, y.indexOf('@')))) };
  };
  const exact = (res, label) => {
    const { head, end } = split(res);
    assert.deepEqual(head.map((e) => `${e.kind}${e.id}@${e.inOff}`), want, label);
    assert.deepEqual(end, tail, `${label} (freed at exit)`);
  };
  const loose = (res, label) => {
    const { head, end } = split(res);
    assert.deepEqual(head.map((e) => `${e.kind}:${hex6(e.id)}`), wantKinds, label);
    assert.deepEqual(end, tail, `${label} (freed at exit)`);
  };

  const whole = runOnce(input, { dir, label: name });
  check(input, whole, { dir, ref, label: `${name} whole` });
  exact(whole, `${name}: whole stream`);

  const each = runMany(input, ['--each-split'], { dir, label: name });
  assert.equal(each.length, input.length + 1);
  each.forEach((res, k) => {
    check(input, res, { dir, ref, label: `${name} split ${k}` });
    exact(res, `${name}: split after byte ${k}`);
  });

  // with a flush at the split (5 ms of silence): the insertions may move later, but the same ones happen
  // (a leave that is cut by the flush cannot be freed in front of: such a stream passes flushExact: false)
  const flushed = lite ? [] : runMany(input, ['--each-split', '--flush'], { dir, label: name });
  flushed.forEach((res, k) => {
    check(input, res, { dir, ref, label: `${name} split+flush ${k}` });
    if (flushExact) loose(res, `${name}: split after byte ${k} with flush`);
    else assert.ok(res.ins.length <= want.length + finish.length, `${name}: split after byte ${k} with flush inserted too much`);
  });

  for (let seed = 1; seed <= (lite ? 2 : 12); seed++) {
    const max = [1, 2, 3, 5, 8, 13, 21, 64][seed % 8];
    const rnd = runOnce(input, { dir, args: ['--random', String(seed), String(max)], label: name });
    check(input, rnd, { dir, ref, label: `${name} random ${seed}/${max}` });
    if (flushExact) loose(rnd, `${name}: random chunks ${seed}/${max}`);
  }
  exact(runOnce(input, { dir, args: ['--chunk', '1'], label: name }), `${name}: byte by byte`);
}

// ---------------------------------------------------------------------------
// Golden streams

const ID = IDS[0];

test('a Codex-shaped frame gets one transmit, right before the first placeholder', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?2004h${ESC}[?1049h${ESC}[?2026h${ESC}[H`).add('Hook · vizpane · 1 diagram').add(`${ESC}[12;5H`);
  b.add(`${ESC}[13;5H|${sgrId(ID, ';49')}`).mark('first').add(cells(40, 0)).add(`${ESC}[39;49m|`);
  b.add(`${ESC}[14;5H|${sgrId(ID, ';49')}${cells(40, 1)}${ESC}[39;49m|`);
  b.add(`${ESC}[?2026l`);
  golden('frame', b, [['T', ID, 'first']], { finish: [ID] });
});

test('with a chunked load open, the transmit goes right after the last chunk', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h${ESC}7${ESC}[5;70H`).add(apc('a=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1', b64(60)));
  b.add(apc('m=1', b64(60)));
  b.add(`${ESC}[13;5H|${sgrId(ID, ';49')}${cells(3)}${ESC}[39;49m|`);   // a row while the load is open
  b.add(apc('m=1', b64(60)));
  b.add(apc('m=0', b64(8))).mark('closed');
  b.add(`${ESC}8${ESC}[0m`);
  golden('chunk-open', b, [['T', ID, 'closed']], { finish: [ID] });
});

test('a chunked load that is already closed does not delay the transmit', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h`).add(apc('a=T,t=d,f=100,m=1', b64(12))).add(apc('m=0', b64(12)));
  b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('first').add(cells(2)).add(`${ESC}[0m`);
  golden('chunk-closed', b, [['T', ID, 'first']], { finish: [ID] });
});

test('an APC that is not a transmit never opens or closes a load', { skip }, () => {
  const b = new B();
  b.add(apc('a=T,t=d,f=100,m=1', b64(12)));
  b.add(apc('a=p,i=7,m=0'));          // a placement: m means nothing here
  b.add(apc('a=d,d=I,i=7'));
  b.add(apc('a=q,i=7,m=0'));
  b.add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);   // still open: deferred
  b.add(apc('m=0', b64(4))).mark('closed').add('x');
  golden('chunk-nontransmit', b, [['T', ID, 'closed']], { finish: [ID] });
});

test('a transmit by file never opens a load, whatever m says', { skip }, () => {
  const b = new B();
  b.add(apc('a=T,t=f,f=100,m=1', b64(12)));                       // file medium: m is ignored
  b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('first').add(cells(2)).add(`${ESC}[0m`);
  golden('chunk-file', b, [['T', ID, 'first']], { finish: [ID] });
});

test('a command that may open a load does, and one that cannot be proved valid does not close it', { skip }, () => {
  // A payload that is not base64 gets the command dropped by the terminal, so no load is open there.
  // The filter cannot tell every such case from a valid one, so it treats m=1 as open and waits.
  const open = new B();
  open.add(apc('a=T,t=d,f=100,m=1', '!!!!'));
  open.add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);
  open.add(apc('m=0', b64(4))).mark('closed').add('x');
  golden('chunk-maybe-open', open, [['T', ID, 'closed']], { finish: [ID] });
  // a closing command whose payload is suspect leaves the load open
  const stay = new B();
  stay.add(apc('a=T,t=d,f=100,m=1', b64(12)));
  stay.add(apc('m=0', 'A'));                                       // one base64 digit is never valid
  stay.add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);
  stay.add(apc('m=0', b64(4))).mark('closed').add('x');
  golden('chunk-suspect-close', stay, [['T', ID, 'closed']], { finish: [ID] });
  // a value Ghostty rejects makes the whole command fail, so it never closes a load
  const bad = new B();
  bad.add(apc('a=T,t=d,f=100,m=1', b64(12)));
  bad.add(apc('m=0,i=-5', b64(4)));                                // "-5" does not fit a u32
  bad.add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);
  bad.add(apc('m=0', b64(4))).mark('closed').add('x');
  golden('chunk-bad-value', bad, [['T', ID, 'closed']], { finish: [ID] });
});

// Ghostty reads every control value with Zig's std.fmt.parseInt: an optional sign and '_' between
// digits are accepted. A load opened (or closed) with such a value is open (or closed) for Ghostty,
// so the filter has to read them the same way or it would insert a transmit inside the load.
test('control values are read the way Zig parseInt reads them: signs and "_" separators', { skip }, () => {
  const opens = ['m=+1', 'm=1_0', 'm=+0_1', 'm=1,s=1_0', 'm=1,i=1_2', 'a=1_16,m=1', 'm=1,i=+5', 'm=1,s=-0'];
  for (const ctl of opens) {
    const b = new B();
    b.add(apc(`${ctl.includes('a=') ? '' : 'a=t,'}f=100,${ctl}`, b64(12)));
    b.add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);   // the load is open: deferred
    b.add(apc('m=0', b64(4))).mark('closed').add('x');
    golden(`zig-open ${ctl}`, b, [['T', ID, 'closed']], { finish: [ID], lite: true });
  }
  // commands that Ghostty rejects do not open a load, so the transmit is not delayed
  const shut = ['m=-1', 'm=1_', 'm=_1', 'm=1,s=1__', 'm=1,i=-3', 'm=1,i=4294967296', 'm=-0,s=1'];
  for (const ctl of shut) {
    const b = new B();
    b.add(apc(`a=t,f=100,${ctl}`, b64(12)));
    b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('first').add(cells(2)).add(`${ESC}[0m`);
    golden(`zig-shut ${ctl}`, b, [['T', ID, 'first']], { finish: [ID], lite: true });
  }
  // a closing command written the same way closes the load
  for (const ctl of ['m=0_0', 'm=-0', 'm=+0']) {
    const b = new B();
    b.add(apc('a=t,f=100,m=1', b64(12)));
    b.add(apc(ctl, b64(4)));
    b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('first').add(cells(2)).add(`${ESC}[0m`);
    golden(`zig-close ${ctl}`, b, [['T', ID, 'first']], { finish: [ID], lite: true });
  }
});

test('ESC 7 and ESC 8 restore the foreground the way the terminal does', { skip }, () => {
  // fg is the image, ESC 7, fg reset, a row (no image), ESC 8, a row (the image)
  const b = new B();
  b.add(sgrId(ID)).add(`${ESC}7${ESC}[39m`).add(`|${PH}${DIAC[0]}${DIAC[0]}|`).add(`${ESC}8|`).mark('image').add(`${PH}${DIAC[0]}${DIAC[1]}`).add(`${ESC}[0m`);
  golden('decsc-restore', b, [['T', ID, 'image']], { finish: [ID] });
  // fg is none, ESC 7, fg is the image, ESC 8: the row after it has no image
  const c = new B();
  c.add(`${ESC}7`).add(sgrId(ID)).add(`${ESC}8`).add(`${PH}${DIAC[0]}${DIAC[0]}`).add(`${ESC}[m`);
  golden('decsc-restore-none', c, []);
  // CSI s / CSI u do the same, and with DEC mode 69 on, CSI s is not a save
  const d = new B();
  d.add(sgrId(ID)).add(`${ESC}[s${ESC}[39m${ESC}[u`).mark('image').add(`${PH}${DIAC[0]}${DIAC[0]}`).add(`${ESC}[0m`);
  golden('csi-su', d, [['T', ID, 'image']], { finish: [ID] });
  const e = new B();
  e.add(`${ESC}[?69h`).add(sgrId(ID)).add(`${ESC}[s${ESC}[39m${ESC}[u`).add(`${PH}${DIAC[0]}${DIAC[0]}`).add(`${ESC}[0m`);
  golden('csi-s-margins', e, []);
});

test('every SGR form that sets or clears the foreground', { skip }, () => {
  const [r, g, bl] = [ID >> 16, (ID >> 8) & 255, ID & 255];
  const cell = `${PH}${DIAC[0]}${DIAC[0]}`;
  const sets = [
    `${ESC}[38:2::${r}:${g}:${bl}m`,                // colour space present
    `${ESC}[38:2:${r}:${g}:${bl}m`,                 // colour space absent
    `${ESC}[38;2;${r};${g};${bl};49m`,              // combined, as Codex writes it
    `${ESC}[1;38;2;${r};${g};${bl};4m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[48;2;1;2;3m`,   // a background after it changes nothing
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[58;2;1;2;3m${ESC}[4:3m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[48:2::1:2:3m${ESC}[58:5:9m`,
    `${ESC}[48;2;1;2;3;38;2;${r};${g};${bl}m`,      // the 48 form is skipped as a whole
    `${ESC}[58:2::1:2:3;38;2;${r};${g};${bl}m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[1m${ESC}[22m${ESC}[7m`,
    `${ESC}[38;2;${r + 256};${g};${bl}m`,           // only 8 bits are kept, as in the terminal
    `${ESC}[31;38;2;${r};${g};${bl}m`,
    `${ESC}[38;2;1;2m${ESC}[38;2;${r};${g};${bl}m`, // a short one first: nothing breaks the next
  ];
  sets.forEach((sgr, i) => {
    const b = new B();
    b.add(sgr).mark('first').add(cell).add(`${ESC}[0m`);
    golden(`sgr-set-${i}`, b, [['T', ID, 'first']], { finish: [ID], lite: true });
  });
  const clears = [
    `${ESC}[38;5;${r}m`,                            // palette
    `${ESC}[38:5:${r}m`,
    `${ESC}[38;2;${r};${g}m`,                       // too short for a colour
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[0m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[39m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[31m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[91m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[38;5;3m`,
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[1;0m`,
    `${ESC}[38;2;${r};${g};${bl};39m`,
    `${ESC}[38:2:${r}:${g}:${bl}:7m`,               // too many colon parameters: unknown, not a colour
    `${ESC}[38;2;${r};${g};${bl}m${ESC}[38;2;1;39m`, // short: only the 38 is consumed, then the 39 resets the colour
  ];
  clears.forEach((sgr, i) => {
    const b = new B();
    b.add(sgr).add(cell).add(`${ESC}[0m`);
    golden(`sgr-clear-${i}`, b, [], { lite: true });
  });
  // a CSI with 24 parameters or more is dropped by the terminal, so a reset in it does nothing
  const many = new B();
  many.add(sgrId(ID)).add(`${ESC}[0;${Array.from({ length: 30 }, (_, i) => i + 1).join(';')}m`).mark('first').add(cell).add(`${ESC}[0m`);
  golden('sgr-too-many-params', many, [['T', ID, 'first']], { finish: [ID], lite: true });
  const edge = new B();       // 24 parameters are still fine
  edge.add(sgrId(ID)).add(`${ESC}[0;${Array.from({ length: 23 }, (_, i) => i + 1).join(';')}m`).add(cell).add(`${ESC}[0m`);
  golden('sgr-24-params', edge, [], { lite: true });
  // a private-marker m is not SGR, so the colour set before it stays
  const keep = new B();
  keep.add(sgrId(ID)).add(`${ESC}[?4m`).mark('first').add(cell).add(`${ESC}[0m`);
  golden('sgr-private-ignored', keep, [['T', ID, 'first']], { finish: [ID] });
});

test('leaving the alternate screen frees what was loaded there, once, in front of the sequence', { skip }, () => {
  for (const [on, off] of [['?1049h', '?1049l'], ['?1047h', '?1047l'], ['?47h', '?47l']]) {
    const b = new B();
    b.add(`${ESC}[${on}`);
    b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('t1').add(cells(4)).add(`${ESC}[0m`);
    b.add(`${ESC}[14;5H|${sgrId(IDS[1])}`).mark('t2').add(cells(4)).add(`${ESC}[0m`);
    b.add(`${ESC}[15;5H|${sgrId(ID)}`).add(cells(4)).add(`${ESC}[0m`);       // same image again: nothing new
    b.mark('leave').add(`${ESC}[${off}`).add('$ ');
    b.add(`${ESC}[${on}`);                                                   // re-entry: the image is sent again
    b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('t3').add(cells(4)).add(`${ESC}[0m`);
    b.mark('end');
    const input = b.buf();
    const res = runOnce(input, { label: off });
    check(input, res, { label: off });
    const k = res.ins.map((e) => `${e.kind}${e.id}@${e.inOff}`);
    assert.deepEqual(k, [
      `T${ID}@${b.marks.t1}`, `T${IDS[1]}@${b.marks.t2}`,
      `D${ID}@${b.marks.leave}`, `D${IDS[1]}@${b.marks.leave}`,
      `T${ID}@${b.marks.t3}`,
      `D${ID}@${input.length}`,                                              // freed at exit
    ], off);
    assert.equal(res.stat.deletes_leave, 2);
    assert.equal(res.stat.deletes_finish, 1);
    golden(`alt-${off}`, b, [['T', ID, 't1'], ['T', IDS[1], 't2'], ['D', ID, 'leave'], ['D', IDS[1], 'leave'], ['T', ID, 't3']], { finish: [ID], flushExact: false });
  }
});

test('RIS forgets what was loaded: the image is sent again and nothing is freed for it', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h`).add(`${ESC}[13;5H|${sgrId(ID)}`).mark('t1').add(cells(2)).add(`${ESC}[0m`);
  b.add(`${ESC}c`);
  b.add(`${ESC}[13;5H|${sgrId(ID)}`).mark('t2').add(cells(2)).add(`${ESC}[0m`);
  const input = b.buf();
  const res = runOnce(input);
  check(input, res);
  assert.deepEqual(sig(res), [`T${ID}@${b.marks.t1}`, `T${ID}@${b.marks.t2}`, `D${ID}@${input.length}`]);
  assert.equal(res.stat.deletes_leave, 0);
});

test('an image with no files gets nothing, and is looked up again once the directory changes', { skip }, () => {
  const dir = newSession();
  const id = 0x555555;
  const stage = newSession();
  putImage(stage, id);
  const b = new B();
  b.add(rowOf(id, 3)).add(rowOf(id, 3, 1)).mark('copy').add(rowOf(id, 3, 2)).mark('first').add('x');
  const input = b.buf();
  // the hook publishes the png, then the .cr, in front of the third row
  const res = runOnce(input, {
    dir,
    args: ['--copy', String(b.marks.copy), join(stage, `${hex6(id)}.png`), join(dir, `${hex6(id)}.png`),
      '--copy', String(b.marks.copy), join(stage, `${hex6(id)}.cr`), join(dir, `${hex6(id)}.cr`)],
  });
  check(input, res, { dir });
  assert.deepEqual(kinds(res).slice(0, 1), [`T:${hex6(id)}`]);
  assert.ok(res.ins[0].inOff >= b.marks.copy, 'no transmit before the files exist');
  assert.equal(res.stat.absent_added, 1, 'two sightings before the files, one lookup');
  // without the copy it stays absent for the whole stream
  const none = runOnce(input, { dir: newSession() });
  assert.deepEqual(none.ins, []);
  assert.equal(none.stat.absent_added, 1);
});

test('ids outside 0x100000..0x7FFFFF get nothing, whatever files exist', { skip }, () => {
  const dir = newSession();
  const ids = [0x0fffff, 0x800000, 0x000001, 0xffffff, 0x0000ff];
  for (const id of ids) putImage(dir, id);
  const b = new B();
  for (const id of ids) b.add(rowOf(id, 2));
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  assert.deepEqual(res.ins, []);
  // the boundaries do work
  for (const id of [0x100000, 0x7fffff]) {
    putImage(dir, id);
    const c = new B();
    c.add(rowOf(id, 2));
    const r2 = runOnce(c.buf(), { dir });
    check(c.buf(), r2, { dir });
    assert.deepEqual(kinds(r2).slice(0, 1), [`T:${hex6(id)}`]);
  }
});

test('files the filter must refuse', { skip }, () => {
  const dir = newSession();
  const good = join(dir, 'good.png');
  writeFileSync(good, fakePng(40, 20));
  const cases = [];
  const add = (name, make) => { const id = 0x300000 + cases.length; make(id); cases.push([name, id]); };
  add('symlink to a png', (id) => { symlinkSync(good, join(dir, `${hex6(id)}.png`)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('directory as png', (id) => { mkdirSync(join(dir, `${hex6(id)}.png`)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('png over 32 MiB', (id) => { const p = join(dir, `${hex6(id)}.png`); writeFileSync(p, fakePng(40, 20)); truncateSync(p, 33 * 1024 * 1024); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('not a png', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), Buffer.alloc(64, 0x41)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('bad IHDR tag', (id) => { const p = fakePng(40, 20); p.write('IHDX', 12, 'latin1'); writeFileSync(join(dir, `${hex6(id)}.png`), p); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('bad IHDR length', (id) => { const p = fakePng(40, 20); p.writeUInt32BE(12, 8); writeFileSync(join(dir, `${hex6(id)}.png`), p); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('width over 10000', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(10001, 20)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('height over 10000', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(20, 10001)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('width 0', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(0, 20)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('over the 96 MiB budget alone', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(5100, 5000)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('truncated png', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(40, 20).subarray(0, 30)); writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  add('no .cr', (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(40, 20)); });
  add('no .png', (id) => { writeFileSync(join(dir, `${hex6(id)}.cr`), '40 10\n'); });
  for (const cr of ['0 10', '40 0', '256 10', '40 256', '40', '40,10', '', '40 10 5', ' 40 10', '40  10', '-1 10', '1000 10', '40 10\n\n', '4 0x\n', '40\t10\n']) {
    add(`.cr ${JSON.stringify(cr)}`, (id) => { writeFileSync(join(dir, `${hex6(id)}.png`), fakePng(40, 20)); writeFileSync(join(dir, `${hex6(id)}.cr`), cr); });
  }
  const b = new B();
  for (const [, id] of cases) b.add(rowOf(id, 2));
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  assert.deepEqual(res.ins.map((e) => cases.find(([, id]) => id === e.id)?.[0]), [], 'inserted for a file that should be refused');
  assert.equal(res.stat.absent_added, cases.length);
  // and the accepted forms of .cr
  for (const cr of ['1 1', '255 255\n', '40 10\n', '007 08\n']) {
    const id = 0x310000 + cr.length;
    putImage(dir, id, { cr });
    const c = new B().add(rowOf(id, 2));
    const r2 = runOnce(c.buf(), { dir });
    assert.deepEqual(kinds(r2).slice(0, 1), [`T:${hex6(id)}`], `.cr ${JSON.stringify(cr)}`);
  }
  // wrong owner: only root can create such a file
  if (process.getuid && process.getuid() === 0) {
    const id = 0x320000;
    putImage(dir, id);
    spawnSync('chown', ['65534', join(dir, `${hex6(id)}.png`)]);
    const r3 = runOnce(new B().add(rowOf(id, 2)).buf(), { dir });
    assert.deepEqual(r3.ins, []);
  }
});

test('the 96 MiB budget evicts the least recently seen image before the one that does not fit', { skip }, () => {
  const dir = newSession();
  const big = [0x400001, 0x400002, 0x400003, 0x400004];
  for (const id of big) putImage(dir, id, { w: 3072, h: 2560 });          // 30 MiB decoded each
  const b = new B();
  addRow(b, big[0], 't0'); addRow(b, big[1], 't1'); addRow(b, big[2], 't2');
  addRow(b, big[0], 'again');                                             // seen again: no longer the oldest
  addRow(b, big[3], 't3');
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  const first = res.ins.slice(0, 5).map((e) => `${e.kind}:${hex6(e.id)}`);
  assert.deepEqual(first, ['T:400001', 'T:400002', 'T:400003', 'D:400002', 'T:400004']);
  assert.equal(res.ins[3].inOff, res.ins[4].inOff, 'the delete is in front of the transmit, at the same place');
  assert.equal(res.stat.deletes_lru, 1);
  assert.equal(res.stat.loaded_primary, 0, 'freed at exit');
  golden('budget', b, [['T', big[0], 't0'], ['T', big[1], 't1'], ['T', big[2], 't2'], ['D', big[1], 't3'], ['T', big[3], 't3']],
    { dir, finish: [big[2], big[0], big[3]] });
});

test('the screens have separate budgets and loaded sets', { skip }, () => {
  const dir = newSession();
  const big = [0x410001, 0x410002, 0x410003];
  for (const id of big) putImage(dir, id, { w: 3072, h: 2560 });
  const b = new B();
  b.add(rowOf(big[0], 2)).add(rowOf(big[1], 2)).add(rowOf(big[2], 2));         // 90 MiB on the primary screen
  b.add(`${ESC}[?1049h`).add(rowOf(big[0], 2)).add(rowOf(big[1], 2)).add(rowOf(big[2], 2));  // 90 MiB on the alternate one: no eviction
  b.add(`${ESC}[?1049l`);
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  assert.equal(res.stat.transmits, 6);
  assert.equal(res.stat.deletes_lru, 0);
  assert.equal(res.stat.deletes_leave, 3);
  assert.equal(res.stat.deletes_finish, 3);
});

test('at most 256 images are loaded per screen; past that the oldest is deleted first', { skip }, () => {
  const dir = newSession();
  const ids = Array.from({ length: 258 }, (_, i) => 0x500000 + i);
  for (const id of ids) putImage(dir, id, { w: 4, h: 4 });
  const b = new B();
  for (const id of ids) b.add(rowOf(id, 1));
  const input = b.buf();
  const res = runOnce(input, { dir, args: ['--chunk', '40'] });     // one image per chunk, as the per-call limit allows
  check(input, res, { dir });
  assert.equal(res.stat.transmits, 258);
  assert.equal(res.stat.deletes_lru, 2);
  assert.deepEqual(res.ins.filter((e) => e.kind === 'D').slice(0, 2).map((e) => hex6(e.id)), ['500000', '500001']);
  assert.equal(res.stat.dropped_no_room, 0);
});

test('one feed inserts at most 32 transmits, and the rest follow on the next sighting', { skip }, () => {
  const dir = newSession();
  const ids = Array.from({ length: 100 }, (_, i) => 0x520000 + i);
  for (const id of ids) putImage(dir, id, { w: 4, h: 4 });
  const b = new B();
  for (const id of ids) b.add(rowOf(id, 1));
  const input = b.buf();
  const one = runOnce(input, { dir });
  check(input, one, { dir });
  assert.equal(one.ins.filter((e) => e.kind === 'T').length, 32, 'the limit of one feed');
  assert.equal(one.stat.dropped_no_room, 0);
  // the same stream in two feeds: 32 in each, the second feed picks up where the first stopped
  const two = runOnce(input, { dir, args: ['--split', String(Math.floor(input.length / 2))] });
  check(input, two, { dir });
  assert.equal(two.ins.filter((e) => e.kind === 'T').length, 32 + Math.min(32, 100 - 32 - 18));
});

test('with exactly the room the contract promises, nothing is dropped, in the worst cases I can build', { skip }, () => {
  const dir = newSession();
  const ids = Array.from({ length: 300 }, (_, i) => 0x700000 + i);
  for (const id of ids) putImage(dir, id, { w: 4, h: 4 });
  // 256 images loaded on the alternate screen, then one feed that sends 32 more and leaves the screen
  const warm = new B();
  warm.add(`${ESC}[?1049h`);
  for (const id of ids.slice(0, 256)) warm.add(rowOf(id, 1));
  const last = new B();
  for (const id of ids.slice(256)) last.add(rowOf(id, 1));
  last.add(`${ESC}[?1049l`);
  const input = Buffer.concat([warm.buf(), last.buf()]);
  const res = runOnce(input, { dir, args: ['--tight', '--split', String(warm.buf().length), '--chunk', '60'] });
  check(input, res, { dir });
  assert.equal(res.stat.dropped_data, 0);
  assert.equal(res.stat.dropped_no_room, 0);
  // all of it in one feed: the transmits are capped, the output still fits
  const one = runOnce(input, { dir, args: ['--tight'] });
  check(input, one, { dir });
  assert.equal(one.stat.dropped_data, 0);
  assert.equal(one.stat.dropped_no_room, 0);
  // random streams with the tight cap
  const gen = generator(31337);
  const inputs = Array.from({ length: 2000 }, () => gen(600));
  for (const r of runMany(multiInput(inputs), ['--multi', '--random', '5', '300', '--tight'])) {
    assert.equal(r.stat.dropped_data, 0);
    assert.equal(r.stat.dropped_no_room, 0);
  }
});

test('a feed full of unknown ids does a bounded number of file lookups', { skip }, () => {
  const dir = newSession();
  const b = new B();
  for (let i = 0; i < 500; i++) b.add(rowOf(0x600000 + i, 1));
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  assert.equal(res.stat.absent_added, 64, 'one feed looks at 64 ids at most');
  const each = runOnce(input, { dir, args: ['--chunk', '70'] });
  assert.ok(each.stat.absent_added >= 400, 'the rest are looked at on later feeds');
});

test('a placeholder split across reads is still preceded by its transmit, and the held bytes come out on a flush', { skip }, () => {
  const b = new B();
  b.add(sgrId(ID)).mark('t').add(`${PH}${DIAC[0]}${DIAC[1]}`);
  const input = b.buf();
  const f4 = input.indexOf(0xf4);
  assert.equal(f4, b.marks.t);
  for (const cut of [f4 + 1, f4 + 2, f4 + 3]) {
    const res = runOnce(input, { args: ['--split', String(cut)] });
    check(input, res);
    assert.deepEqual(sig(res), [`T${ID}@${f4}`, `D${ID}@${input.length}`], `cut after ${cut - f4} bytes of the placeholder`);
  }
  // A CSI longer than 64 bytes is let out before it ends and nothing is inserted inside it. The leave
  // that is too long cannot be freed in front of, so the image on the alternate screen stays loaded.
  const long = new B();
  long.add(`${ESC}[?1049h`).add(sgrId(ID)).add(`${ESC}[`).add('0'.repeat(100)).add('1m');
  long.add(`${ESC}[13;5H|`).mark('t1').add(`${PH}${DIAC[0]}${DIAC[0]}`);
  long.add(`${ESC}[?`).add('0'.repeat(100)).add('1049l');
  long.add(sgrId(ID)).mark('t2').add(`${PH}${DIAC[0]}${DIAC[0]}`).add(`${ESC}[0m`);
  const lin = long.buf();
  const lres = runOnce(lin);
  check(lin, lres);
  assert.equal(lres.stat.hold_overflow, 2);
  assert.equal(lres.stat.leave_skipped, 1);
  assert.deepEqual(sig(lres), [`T${ID}@${long.marks.t1}`, `T${ID}@${long.marks.t2}`, `D${ID}@${lin.length}`]);
  const lsplit = runMany(lin, ['--each-split']);
  lsplit.forEach((r, k) => { check(lin, r, { label: `long csi split ${k}` }); assert.deepEqual(sig(r), sig(lres), `long csi split ${k}`); });
});

test('a leave that could not be held is not freed in front of, and the image stays known', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h`).add(rowOf(ID, 2)).add(`${ESC}[?`).add('0'.repeat(80)).add('1049l').add(`${ESC}[?1049h`).add(rowOf(ID, 2)).add('x');
  const input = b.buf();
  const res = runOnce(input);
  check(input, res);
  assert.equal(res.stat.leave_skipped, 1);
  assert.equal(res.stat.transmits, 1, 'still loaded after the screen came back');
});

// Ghostty implements XTSAVE (CSI ? Pm s) and XTRESTORE (CSI ? Pm r). A restore runs the mode's effect
// again even when the value did not change, so it can switch screens. If the filter lost track of
// the screen, it would put a transmit into a load that is open on the other one.
test('XTSAVE and XTRESTORE of the screen modes move the filter between screens like the terminal', { skip }, () => {
  for (const mode of [1049, 1047, 47]) {
    const b = new B();
    b.add(`${ESC}[?${mode}h${ESC}[?${mode}s${ESC}[?${mode}l${ESC}[?${mode}r`);      // the restore puts the terminal back on alt
    b.add(apc('a=T,t=d,f=100,i=7,m=1', 'AAAA'));                                    // a load opens on alt
    b.add(`${ESC}[?${mode}l${ESC}[?${mode}h`);                                      // primary, then alt again
    b.add(rowOf(ID, 2)).add(apc('m=0', 'AAAA')).mark('closed').add('x');
    const input = b.buf();
    const res = runOnce(input, { label: `xtrestore ${mode}` });
    check(input, res, { label: `xtrestore ${mode}` });
    assert.deepEqual(sig(res), [`T${ID}@${b.marks.closed}`, `D${ID}@${input.length}`], `mode ${mode}`);
  }
  // a restore of a mode that was never saved is the default, off: it leaves the alternate screen
  const off = new B();
  off.add(`${ESC}[?1049h`).add(rowOf(ID, 2)).add(`${ESC}[?1049r`).add('x');
  const input = off.buf();
  const res = runOnce(input);
  check(input, res);
  assert.equal(res.stat.deletes_leave, 1, 'leaving through a restore frees what was loaded');
  // 2004 and the other tracked modes are saved and restored too
  const tui = new B();
  tui.add(`${ESC}[?2004h${ESC}[?2004s${ESC}[?2004l${ESC}[?2004r`);
  const ti = tui.buf();
  const tr = runOnce(ti);
  assert.equal(tr.stat.tui, 1, 'bracketed paste is back on after the restore');
});

// An eviction that is queued and then dropped leaves its victim in the terminal. The victim must
// stay on the list of loaded images, so the next leave frees it.
test('an eviction dropped with the queue does not leak its victim', { skip }, () => {
  const dir = newSession();
  const A = 0x200001, Bb = 0x200002;
  putImage(dir, A, { w: 4096, h: 4096, cr: '4 1\n' });                        // 64 MiB decoded each
  putImage(dir, Bb, { w: 4096, h: 4096, cr: '4 1\n' });
  const b = new B();
  b.add(`${ESC}[?1049h`).add(rowOf(A, 2)).mark('tA');
  b.add(apc('a=T,t=d,f=100,i=7,m=1', 'AAAA'));                                 // a chunked load opens on alt
  b.add(rowOf(Bb, 2));                                                         // needs A evicted: queued and deferred
  b.add(`${ESC}[?1049l`).add('x');                                             // leave while the load is open, then primary
  b.add(`${ESC}[?1049h`).add(apc('m=0', 'AAAA')).add('y');                     // back on alt, the load closes
  b.mark('leave2').add(`${ESC}[?1049l`).add('z');
  const input = b.buf();
  const res = runOnce(input, { dir });
  check(input, res, { dir });
  assert.ok(res.ins.some((e) => e.kind === 'D' && e.id === A && e.inOff === b.marks.leave2), 'A is deleted in front of the second leave');
  assert.equal(res.stat.loaded_alt, 0);
});

// Accepted: cleanup needs a ground point with no load open, and the filter never writes a byte that
// is not a transmit or a delete. When Codex is killed in the middle of a sequence the images stay
// in the pane's storage until the pane closes. Stock Codex leaves the parser in the same state.
test('a stream that ends inside a sequence frees nothing, and inserts nothing', { skip }, () => {
  for (const tail of [`${ESC}[38;2`, `${ESC}_Ga=d`, `${ESC}`]) {
    const b = new B();
    b.add(rowOf(ID, 2)).add(tail);
    const input = b.buf();
    const res = runOnce(input);
    check(input, res);
    assert.equal(res.stat.deletes_finish, 0, JSON.stringify(tail));
    assert.deepEqual(kinds(res), [`T:${hex6(ID)}`], JSON.stringify(tail));
  }
});

test('with no session directory the filter never inserts anything', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h`).add(rowOf(ID, 5)).add(`${ESC}[?1049l`);
  const input = b.buf();
  for (const dir of [null, 'relative/path', '']) {
    const res = runOnce(input, { dir: dir ?? '-', args: ['--random', '5', '9'] });
    assert.ok(res.out.equals(input));
    assert.deepEqual(res.ins, []);
  }
});

test('the filter holds back exactly the unfinished sequence or character, and a flush lets it go', { skip }, () => {
  const mixed = new B();
  mixed.add(`${ESC}[?2004h${ESC}[?1049h${ESC}7${ESC}[5;70H`).add(`${ESC}]0;title\x07${ESC}P1$rx${ESC}\\`);
  mixed.add(apc('a=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1', b64(9))).add(apc('m=0', b64(3))).add(`${ESC}8`);
  mixed.add(`${ESC}[1;38:2::18:52:86m`).add('héllo 日本 ').add(rowOf(ID, 2)).add(`${ESC}[?1049l`);
  const input = mixed.buf();
  const ref = lex(input);
  const expectedHeld = (k) => {
    if (ref.ground[k]) return 0;
    if (ref.state[k] >= ST.DCS_ENTRY) return 0;                    // strings are not held
    let i = k - 1;
    while (i >= 0 && !ref.ground[i]) i--;
    for (let j = k; j > i; j--) if (ref.state[j] >= ST.DCS_ENTRY) return 0;   // a string began inside: let out
    return k - i >= 64 ? 0 : k - i;
  };
  for (const flush of [false, true]) {
    const file = join(work, 'calls.txt');
    const results = runMany(input, ['--each-split', '--calls', file, ...(flush ? ['--flush'] : [])], { label: 'calls' });
    const groups = readFileSync(file, 'latin1').split('S\n').slice(1).map((g) => g.split('\n').filter(Boolean).map((l) => l.split(' ')));
    assert.equal(groups.length, input.length + 1);
    let maxHeld = 0;
    groups.forEach((lines, k) => {
      if (k === 0 || k === input.length) return;
      const first = lines.find((l) => l[0] === 'F');
      const fed = Number(first[1]), outTotal = Number(first[2]), held = Number(first[3]);
      assert.equal(fed, k);
      assert.equal(held, expectedHeld(k), `held after ${k} bytes`);
      const inserted = results[k].ins.filter((e) => e.outOff + e.len <= outTotal).reduce((a, e) => a + e.len, 0);
      assert.equal(outTotal - inserted, k - held, `the output after ${k} bytes has everything but the held bytes`);
      maxHeld = Math.max(maxHeld, held);
      if (flush) {
        const l = lines.find((x) => x[0] === 'L');
        assert.equal(Number(l[3]), 0, 'a flush lets everything go');
      }
    });
    assert.ok(maxHeld > 3 && maxHeld < 64, `held up to ${maxHeld} bytes`);
  }
});

test('a transmit that waits for a load to close is let out by the timer when nothing more arrives', { skip }, () => {
  const b = new B();
  b.add(`${ESC}[?1049h`).add(apc('a=T,t=d,f=100,m=1', b64(12))).add(`${ESC}[13;5H|${sgrId(ID)}`).add(cells(2)).add(`${ESC}[0m`);
  b.add(apc('m=0', b64(4))).mark('closed');
  const input = b.buf();
  const file = join(work, 'calls-timer.txt');
  const res = runOnce(input, { args: ['--calls', file, '--flush'] });
  check(input, res);
  const lines = readFileSync(file, 'latin1').split('\n').filter(Boolean).map((l) => l.split(' '));
  const feed = lines.find((l) => l[0] === 'F');
  const flush = lines.find((l) => l[0] === 'L');
  assert.equal(Number(feed[3]), 1, 'the filter asks for the timer, though no byte is held');
  assert.equal(Number(flush[3]), 0, 'and it is done after the flush');
  assert.deepEqual(res.ins.slice(0, 1).map((e) => `${e.kind}${e.id}@${e.inOff}`), [`T${ID}@${b.marks.closed}`]);
  assert.equal(Number(flush[2]) - Number(feed[2]), res.ins[0].len, 'the flush wrote the transmit');
});

test('bracketed paste mode is reported while it is on', { skip }, () => {
  const cases = [
    [`${ESC}[?2004h`, 1], [`${ESC}[?2004h${ESC}[?2004l`, 0], [`${ESC}[?25l${ESC}[?1049;2004h`, 1], [`${ESC}[?2004h${ESC}c`, 0],
    [`${ESC}[?2004h${ESC}[?2004;1049l`, 0], [`${ESC}[?2004h${ESC}[?2004$h`, 1], [`${ESC}[2004h`, 0], [`${ESC}[?2004:1h`, 0],
    [`${ESC}[?2004h${ESC}[?2004`, 1],
  ];
  for (const [text, want] of cases) {
    const input = Buffer.from(text);
    for (const res of runMany(input, ['--each-split'])) assert.equal(res.stat.tui, want, JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------
// Random streams

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed) {
  const rnd = mulberry32(seed);
  const int = (n) => Math.floor(rnd() * n);
  const pick = (a) => a[int(a.length)];
  const rid = () => pick([...IDS, ID_ABSENT, 0x0fffff, 0x800000, 0x123457]);
  const bytes = (n, lo = 0, hi = 255) => Buffer.from(Array.from({ length: n }, () => lo + int(hi - lo + 1)));
  const text = () => Buffer.from(Array.from({ length: 1 + int(12) }, () => 0x20 + int(0x5f)));
  const terminator = () => pick([`${ESC}\\`, `${ESC}\\`, `${ESC}\\`, '\x07', '\x9c', '\x18', '\x1a', '', `${ESC}[m`]);
  const paramList = () => {
    const forms = [
      () => { const id = rid(); return `38;2;${id >> 16};${(id >> 8) & 255};${id & 255}`; },
      () => { const id = rid(); return `38:2::${id >> 16}:${(id >> 8) & 255}:${id & 255}`; },
      () => { const id = rid(); return `38:2:${id >> 16}:${(id >> 8) & 255}:${id & 255}`; },
      () => { const id = rid(); return `38;2;${id >> 16};${(id >> 8) & 255};${id & 255};49`; },
      () => `38;5;${int(256)}`, () => `38:5:${int(256)}`, () => `48;2;${int(256)};${int(256)};${int(256)}`,
      () => `58:2::${int(256)}:${int(256)}:${int(256)}`, () => '0', () => '39', () => '', () => '1;4:3', () => String(30 + int(8)),
      () => String(90 + int(8)), () => `38;2;${int(300)}`, () => `38;${int(7)}`, () => `4:${int(7)}`, () => `${int(120)}:${int(9)}`,
      () => '38;2', () => '38:2:1:2', () => '38:2::1:2:3:4',
    ];
    return Array.from({ length: 1 + int(4) }, () => pick(forms)()).join(';');
  };
  const apcCtl = () => pick([
    () => `a=T,U=1,f=100,t=f,q=2,C=1,i=${rid()},c=40,r=10`, () => 'a=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1',
    () => 'm=1', () => 'm=1', () => 'm=0', () => 'm=0', () => 'm=2', () => 'm=x', () => 'a=d,d=I,i=5', () => 'a=p,i=1', () => 'a=q,i=1,m=0',
    () => 't=f,m=1', () => 'a=t,m=1,i=3,I=4', () => 'a=t,f=77,m=1', () => 'a=T,U=2,m=1', () => 'a==,m=1', () => 'i=-1,m=1', () => 'm=1,',
    () => 'garbage', () => '', () => 'a=T,q=3,m=1', () => `m=${int(3)},i=${int(1 << 20)}`, () => 'a=zz,m=1', () => 'a=300,m=1', () => 'z=-3,m=1',
    () => 'mm=1', () => 'm=1;', () => ';', () => 'a=t;m=1',
    () => 'm=+1', () => 'm=1_0', () => 'm=+0', () => 'm=-0', () => 'm=1,s=1_0', () => 'm=1,i=1_2', () => 'a=1_16,m=1', () => 'm=1_', () => 'm=0,i=+5',
  ])();
  const payload = () => pick([
    () => b64(1 + int(40)), () => b64(3 * int(8)), () => 'AAAA=', () => 'A', () => 'AAAAA', () => '====', () => 'AA==AA', () => '!!',
    () => 'AAA\nAAA', () => '', () => b64(int(64)).slice(0, -1),
  ])();
  const modes = ['2004', '1049', '1047', '47', '1048', '69', '25', '2026', '1049;2004', '2004;1049', '47;1047', '1000;1006', '9999'];

  const token = [
    [8, () => text()],
    [3, () => Buffer.from([int(32)])],
    [3, () => Buffer.from([pick([0x18, 0x1a, 0x1b, 0x1b, 0x07, 0x0a])])],
    [4, () => Buffer.from(`${ESC}[${Array.from({ length: int(8) }, () => pick('0123456789;:?<>=!$ "\'')).join('')}${String.fromCharCode(0x40 + int(0x3f))}`)],
    [10, () => Buffer.from(`${ESC}[${paramList()}m`)],
    [8, () => Buffer.from(`${ESC}[?${pick(modes)}${pick(['h', 'l'])}`)],
    [3, () => Buffer.from(`${ESC}[?${pick(modes)}${pick(['s', 'r', 'r'])}`)],
    [4, () => Buffer.from(pick([`${ESC}7`, `${ESC}8`, `${ESC}[s`, `${ESC}[u`, `${ESC}[1u`, `${ESC}7`, `${ESC}8`]))],
    [1, () => Buffer.from(pick([`${ESC}c`, `${ESC}c`, `${ESC}#8`, `${ESC}(B`, `${ESC}=`]))],
    [3, () => Buffer.concat([Buffer.from(`${ESC}]${int(10)};`), text(), bytes(int(3), 0x80, 0xff), Buffer.from(terminator())])],
    [2, () => Buffer.concat([Buffer.from(`${ESC}P${pick(['', '1;2', '$', '1$', ':'])}${pick(['q', 'p', '|'])}`), text(), Buffer.from(terminator())])],
    [9, () => Buffer.from(`${ESC}_G${apcCtl()};${payload()}${terminator()}`)],
    [3, () => Buffer.from(`${ESC}_G${apcCtl()}${terminator()}`)],
    [2, () => Buffer.from(`${ESC}${pick(['X', '^', '_'])}${pick(['G', 'Gm=1;', 'x', '25a1;'])}${payload()}${terminator()}`)],
    [2, () => Buffer.from([pick([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f, 0x80, 0x85, 0x9c, 0x9a])])],
    [3, () => bytes(1 + int(3), 0x80, 0xff)],
    [3, () => Buffer.from(pick(['é', '日本', '\u{1F600}', '̅', '\u{10EEEE}', '\u{10FFFF}', '�']))],
    [3, () => Buffer.from(pick([[0xf4, 0x8e, 0xbb], [0xf4, 0x8e], [0xf4], [0xe2, 0x82], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xc3]]))],
    [10, () => Buffer.concat([Buffer.from(sgrId(rid(), pick(['', ';49', ';4']))), Buffer.from(cells(1 + int(5), int(3))), Buffer.from(pick([`${ESC}[39m`, `${ESC}[0m`, '', `${ESC}8`]))])],
    [6, () => Buffer.from(rowOf(rid(), 1 + int(6), int(3)))],
    [3, () => bytes(1 + int(4))],
    [2, () => Buffer.from(`${ESC}7${ESC}[${1 + int(20)};${1 + int(80)}H${apc('a=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1', b64(1 + int(20)))}${apc('m=1', b64(1 + int(20)))}${apc('m=0', b64(1 + int(20)))}${ESC}8`)],
  ];
  const total = token.reduce((s, [w]) => s + w, 0);
  const one = () => {
    let r = rnd() * total;
    for (const [w, f] of token) { if ((r -= w) < 0) return f(); }
    return token[0][1]();
  };
  return (targetLen) => {
    const parts = [];
    let n = 0;
    while (n < targetLen) { const p = one(); parts.push(p); n += p.length; }
    let buf = Buffer.concat(parts);
    if (int(4) === 0 && buf.length) {                       // damage a quarter of them
      buf = Buffer.from(buf);
      for (let k = 1 + int(4); k > 0; k--) {
        const at = int(buf.length);
        switch (int(3)) {
          case 0: buf[at] = int(256); break;
          case 1: buf = Buffer.concat([buf.subarray(0, at), buf.subarray(at + 1 + int(3))]); break;
          default: buf = buf.subarray(0, at + 1 + int(buf.length - at));
        }
        if (!buf.length) break;
      }
    }
    return buf;
  };
}

function fuzz(count, baseSeed, { perProcess = 500 } = {}) {
  let inserted = 0, transmitted = 0, deleted = 0, deferred = 0, streams = 0;
  for (let first = 0; first < count; first += perProcess) {
    const n = Math.min(perProcess, count - first);
    const gen = generator(baseSeed * 1000003 + first);
    const lens = mulberry32(baseSeed + first);
    const inputs = Array.from({ length: n }, () => gen(20 + Math.floor(lens() * 1200)));
    const results = runMany(multiInput(inputs), ['--multi', '--random', String(baseSeed + first), String(1 + Math.floor(lens() * 40))], { label: `fuzz ${first}` });
    assert.equal(results.length, n);
    results.forEach((res, k) => {
      const label = `fuzz stream ${first + k} (base seed ${baseSeed})`;
      try {
        check(inputs[k], res, { label });
      } catch (e) {
        writeFileSync(join(work, `fuzz-fail-${first + k}.bin`), inputs[k]);
        e.message += `\n(input saved as ${join(work, `fuzz-fail-${first + k}.bin`)})`;
        throw e;
      }
      assert.equal(res.stat.held, 0);
      assert.equal(res.stat.dropped_no_room, 0);
      assert.equal(res.stat.dropped_data, 0);
      assert.equal(res.stat.api_transmits, res.stat.transmits, 'vf_transmits counts the transmits inserted');
      inserted += res.ins.length; transmitted += res.stat.transmits; deleted += res.stat.deletes_leave + res.stat.deletes_lru + res.stat.deletes_finish;
      deferred += res.stat.deferred; streams++;
    });
  }
  return { streams, inserted, transmitted, deleted, deferred };
}

test('random streams: R1, R2 and R3 hold, and the filter is clean under the sanitizers', { skip, timeout: FUZZ ? 3600000 : 300000 }, () => {
  const count = FUZZ ? 1000000 : 20000;
  const r = fuzz(count, FUZZ_SEED);
  console.log(`# random streams: ${r.streams}, insertions ${r.inserted} (transmits ${r.transmitted}, deletes ${r.deleted}), deferred ${r.deferred}`);
  assert.ok(r.transmitted > count / 50, 'the generator must reach the transmit path');
  assert.ok(r.deleted > count / 100, 'the generator must reach the free path');
  assert.ok(r.deferred > 0, 'the generator must reach the deferral path');
});

test('random streams: with no session directory the output is the input', { skip }, () => {
  const gen = generator(77);
  const inputs = Array.from({ length: 300 }, () => gen(400));
  const results = runMany(multiInput(inputs), ['--multi', '--random', '3', '17'], { dir: null });
  results.forEach((r, k) => { assert.ok(r.out.equals(inputs[k]), `stream ${k}`); assert.deepEqual(r.ins, []); });
});

test('the filter and the reference lexer agree at every byte of random streams', { skip }, () => {
  const count = FUZZ ? 20000 : 1500;
  const gen = generator(4242);
  const inputs = Array.from({ length: count }, () => gen(10 + Math.floor(Math.random() * 0 + 600)));
  const tracePath = join(work, 'trace.bin');
  runMany(multiInput(inputs), ['--multi', '--trace', tracePath], { label: 'trace' });
  const trace = readFileSync(tracePath);
  let at = 0;
  inputs.forEach((input, k) => {
    const ref = lex(input);
    for (let i = 0; i <= input.length; i++, at += 5) {
      const flags = trace[at];
      const fg = trace.readInt32LE(at + 1);
      const want = ref.ground[i] | (ref.ground[i] ? 2 : 0) | (ref.chunk[i] << 2) | (ref.alt[i] << 3) | (ref.tui[i] << 4);
      // bit 0 is "parser in ground" and bit 1 "decoder idle"; the reference folds both into ground
      const got = ((flags & 3) === 3 ? 3 : 0) | (flags & 0x1c);
      if (got !== want || fg !== ref.fg[i]) {
        const ctx = input.subarray(Math.max(0, i - 24), i + 8).toString('latin1').replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
        assert.fail(`stream ${k}, position ${i}: filter flags ${flags.toString(2)} fg ${fg}, reference ground ${ref.ground[i]} chunk ${ref.chunk[i]} alt ${ref.alt[i]} tui ${ref.tui[i]} fg ${ref.fg[i]}\n  ...${ctx}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Safe cut points (vf_cuts): where the relay may end a write to the terminal.

// Reads the --cuts file: per stream, one record per vf_feed (F), vf_flush (L) and the final vf_finish (E).
function readCuts(path) {
  const streams = [];
  for (const line of readFileSync(path, 'latin1').split('\n')) {
    if (line === '') continue;
    if (line === 'S') { streams.push([]); continue; }
    const f = line.split(' ');
    assert.equal(f[0], 'K', `bad cuts line ${line}`);
    const n = Number(f[4]);
    const offs = f.slice(5).map(Number);
    assert.equal(offs.length, n);
    streams.at(-1).push({ kind: f[1], start: Number(f[2]), len: Number(f[3]), offs });
  }
  return streams;
}

// What a safe cut point is, judged by the reference lexer on the output: ground, no partial character, and
// the next byte below 0x80 or the previous item a complete sequence. With `strict` the next byte does not
// count: at the end of a call the filter has not seen it yet (unless it holds it), so there only a point
// after a complete sequence is certain.
function safeAt(ref, out, p, strict = false) {
  if (p < 0 || p > out.length || ref.ground[p] !== 1) return false;
  if (p > 0 && ref.state[p - 1] !== ST.GROUND) return true;
  return !strict && p < out.length && out[p] < 0x80;
}

function checkCuts(out, calls, label) {
  const ref = lex(out);
  let cutsSeen = 0;
  for (const [k, c] of calls.entries()) {
    const where = `${label}, call ${k} (${c.kind}, output ${c.start}+${c.len})`;
    assert.ok(c.offs.length <= 1024, `${where}: more than VF_MAX_CUTS`);
    for (let i = 0; i < c.offs.length; i++) {
      const o = c.offs[i];
      assert.ok(o >= 0 && o <= c.len, `${where}: cut ${o} outside the call's output`);
      if (i > 0) assert.ok(o > c.offs[i - 1], `${where}: cuts are not ascending`);
      assert.ok(safeAt(ref, out, c.start + o), `${where}: cut at output ${c.start + o} is not a safe point`);
      cutsSeen++;
    }
    // Consecutive cuts are at most 64 bytes apart unless the stream has no safe point in between.
    for (let i = 1; i < c.offs.length; i++) {
      const a = c.offs[i - 1], b = c.offs[i];
      if (b - a <= 64) continue;
      for (let p = a + 1; p <= a + 64 && p < b; p++) {
        assert.ok(!safeAt(ref, out, c.start + p), `${where}: no cut at ${c.start + p}, a safe point ${p - a} bytes after the cut at ${c.start + a}`);
      }
    }
    // The last safe point of the call is reported (or one beyond it that the filter holds the next byte of),
    // so a write can reach as far as the filter knows.
    if (c.len === 0) continue;                       // nothing was produced, so there is nothing to cut
    let last = -1;
    // (the start of a call is the end of the previous one, which reported it, or is a point inside released held bytes)
    for (let p = 1; p <= c.len; p++) if (safeAt(ref, out, c.start + p, p === c.len)) last = p;
    if (last < 0) continue;
    assert.ok((c.offs.at(-1) ?? -1) >= last, `${where}: the call's last safe point is ${last}, the last cut ${c.offs.at(-1)}`);
  }
  return cutsSeen;
}

test('cut points: text is cut at least every 64 bytes, and a call that ends after a sequence ends in a cut', { skip }, () => {
  const text = 'x'.repeat(300);
  const path = join(work, 'cuts-1.txt');
  const r = runOnce(Buffer.from(text), { args: ['--cuts', path] });
  const [calls] = readCuts(path);
  assert.equal(r.out.toString(), text);
  assert.deepEqual(calls[0].offs, [0, 64, 128, 192, 256, 299], 'text: before the first byte, every 64, and before the last one');
  // the same text with a complete sequence at the end: the call ends in a cut
  const tail = `${text}${ESC}[m`;
  runOnce(Buffer.from(tail), { args: ['--cuts', path] });
  assert.deepEqual(readCuts(path)[0][0].offs.slice(-2), [256, tail.length], 'the end of a call after a sequence is a cut; points closer than 64 bytes to the last one are dropped');
  // an unfinished sequence is not
  runOnce(Buffer.from(`${text}${ESC}[3`), { args: ['--cuts', path] });
  assert.equal(readCuts(path)[0][0].offs.at(-1), 300, 'an unfinished sequence holds the tail back: the last cut is before it');
});

test('cut points: a character is never parted from the combining marks that may follow it', { skip }, () => {
  const path = join(work, 'cuts-2.txt');
  const s = Buffer.from(`ab${PH}${DIAC[0]}${DIAC[1]}${ESC}[0m${PH}${DIAC[0]}${DIAC[2]}`);
  runOnce(s, { args: ['--cuts', path] });
  const [calls] = readCuts(path);
  const cuts = calls[0].offs;
  const mark = Buffer.from(DIAC[0]).length;
  const phEnd = 2 + Buffer.from(PH).length;
  assert.ok(!cuts.includes(phEnd), 'no cut between the placeholder and its first diacritic');
  assert.ok(!cuts.includes(phEnd + mark), 'no cut between its two diacritics');
  assert.deepEqual(cuts, [0, phEnd + 2 * mark + 4], 'the start, and the point after the sequence that follows the cell');
});

test('cut points: every cut, also after an inserted transmit, is a safe point of random streams', { skip }, () => {
  const count = FUZZ ? 20000 : 2000;
  const gen = generator(8675309);
  const inputs = Array.from({ length: count }, (_, k) => gen(20 + ((k * 37) % 700)));
  const path = join(work, 'cuts-3.txt');
  const results = runMany(multiInput(inputs), ['--multi', '--random', '11', '64', '--cuts', path], { label: 'cuts' });
  const streams = readCuts(path);
  assert.equal(streams.length, count);
  let total = 0, insertions = 0;
  results.forEach((res, k) => {
    total += checkCuts(res.out, streams[k], `random stream ${k}`);
    for (const e of res.ins) {
      insertions++;
      const calls = streams[k];
      const call = calls.find((c) => c.start <= e.outOff && e.outOff < c.start + c.len);
      assert.ok(call, `insertion at ${e.outOff} belongs to a call`);
      // the point after it is recorded, or replaced by a later one when that is closer than 64 bytes
      assert.ok(call.offs.at(-1) >= e.outOff + e.len - call.start, `random stream ${k}: no cut at or after the insertion that ends at ${e.outOff + e.len}`);
    }
  });
  assert.ok(total > count, 'the streams have cut points');
  assert.ok(insertions > count / 100, 'the streams reach the insertion path');
});

test('cut points: with flushes after every chunk, and one byte at a time or in tiny random pieces', { skip }, () => {
  const gen = generator(31337);
  const inputs = Array.from({ length: 300 }, (_, k) => gen(40 + ((k * 53) % 400)));
  for (const args of [['--flush', '--random', '5', '5'], ['--random', '6', '1'], ['--flush', '--random', '3', '9']]) {
    const path = join(work, 'cuts-4.txt');
    const results = runMany(multiInput(inputs), ['--multi', ...args, '--cuts', path], { label: `cuts ${args}` });
    const streams = readCuts(path);
    results.forEach((res, k) => checkCuts(res.out, streams[k], `${args.join(' ')} stream ${k}`));
  }
});

// ---------------------------------------------------------------------------
// Throughput

function frames(bytes, seed) {
  // Codex-shaped: synchronized-update frames of cursor moves and SGR text, with the pet's
  // chunked image loads wrapped in ESC 7 / ESC 8, which is where almost all bytes are.
  const rnd = mulberry32(seed);
  const parts = [];
  let n = 0;
  const chunk64 = Buffer.from(b64(3072).replace(/A/g, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(rnd() * 64)]));
  const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); parts.push(b); n += b.length; };
  push(`${ESC}[?1049h${ESC}[?2004h`);
  while (n < bytes) {
    push(`${ESC}[?2026h${ESC}[H`);
    for (let r = 0; r < 6; r++) push(`${ESC}[${1 + r};1H${ESC}[1m> ${ESC}[0m${'lorem ipsum '.repeat(1 + Math.floor(rnd() * 5))}${ESC}[K`);
    push(rowOf(IDS[Math.floor(rnd() * 3)], 20, 0));
    push(`${ESC}7${ESC}[5;70H`);
    push(`${ESC}_Ga=T,t=d,f=100,c=9,r=5,q=2,i=49374,m=1,C=1;`); push(chunk64); push(`${ESC}\\`);
    for (let k = 0; k < 6; k++) { push(`${ESC}_Gm=1;`); push(chunk64); push(`${ESC}\\`); }
    push(`${ESC}_Gm=0;`); push(chunk64.subarray(0, 1000)); push(`${ESC}\\`);
    push(`${ESC}8${ESC}[?2026l`);
  }
  return Buffer.concat(parts);
}

test('throughput on 50 MB of Codex-shaped frames, and p99 per chunk below 5 ms', { skip, timeout: 600000 }, () => {
  const input = frames(50 * 1024 * 1024, 5);
  const inPath = join(work, 'frames.bin');
  const outPath = join(work, 'frames.out');
  writeFileSync(inPath, input);
  const fdIn = openSync(inPath, 'r');
  const fdOut = openSync(outPath, 'w');
  const r = spawnSync(FAST, [SESSION, '--random', '9', '32768', '--time'], { stdio: [fdIn, fdOut, 'pipe'], maxBuffer: 1 << 28 });
  closeSync(fdIn); closeSync(fdOut);
  assert.equal(r.status, 0, r.stderr?.toString());
  const streams = parseStderr(r.stderr.toString('latin1'), 'throughput');
  const t = streams.time;
  const mbs = (t.bytes / 1048576) / (t.total_ns / 1e9);
  console.log(`# throughput: ${mbs.toFixed(0)} MB/s over ${t.feeds} feeds of up to 32 KiB, p99 ${(t.p99_ns / 1e6).toFixed(3)} ms, max ${(t.max_ns / 1e6).toFixed(3)} ms`);
  assert.ok(t.p99_ns < 5e6, `p99 per chunk is ${t.p99_ns / 1e6} ms`);
  const out = readFileSync(outPath);
  const ins = streams[0].ins;
  // R1 on the big stream, without the per-insertion reference lexer
  let pos = 0, added = 0;
  const kept = [];
  for (const e of ins) { kept.push(out.subarray(pos, e.outOff)); pos = e.outOff + e.len; added += e.len; }
  kept.push(out.subarray(pos));
  assert.ok(Buffer.concat(kept).equals(input), 'R1 on the large stream');
  assert.equal(out.length, input.length + added);
});
