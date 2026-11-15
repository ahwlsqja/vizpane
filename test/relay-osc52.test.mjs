// Measurement: Codex's OSC 52 clipboard fallback through the relay.
//
// When Codex's native clipboard copy fails (macOS outside tmux, Herdr and SSH), Codex writes the copy as an OSC 52
// sequence straight to /dev/tty, from the same thread that writes its frames to stdout. Stock Codex therefore never
// interleaves the two. With the relay, Codex's frames reach the pane through the relay while the OSC 52 still goes to
// /dev/tty directly, so a long copy can be cut by relayed bytes (docs/codex-setup.md, SECURITY.md).
//
// This file reproduces Codex's write pattern (a 40-row frame to stdout, then one OSC 52 of N bytes to /dev/tty, from one
// thread, 200 rounds) against the real relay, plays the terminal with test/relay/harness.c, and counts on the receiving
// side how many copies were cut (the OSC string ended by something other than its own BEL, or had other bytes in it),
// and what cmux's terminal (Ghostty) would then do with each cut copy: it ends the OSC string at ESC, CAN or SUB and
// dispatches what it collected, then drops the copy unless the data is well-formed base64 (length a multiple of 4, only
// the alphabet). So a cut copy is "dropped" (the clipboard keeps its old content), "truncated" (valid base64 made of the
// writer's own letters only), "empty" (cut right after the OSC 52 header: an empty clipboard) or "foreign" (valid base64 that has relayed frame bytes in it). The numbers are printed for
// each size and for a fast, a slow and a very slow terminal; the direct run of the same writer (no relay) is the
// control. The rates depend on the machine and on how busy it is, so they are only reported. What is asserted:
//   - the measurement ran (all rounds written, the copies are found at the receiving end);
//   - without the relay no copy is ever cut and no frame sequence is ever broken;
//   - a copy of up to 256 bytes is never cut. This is a measured result, not a proof: the relay writes when at most
//     256 of the pane's 1,024 queue bytes are in use, which normally leaves room for 256 more, but a chunk of up to
//     768 bytes can leave none, so the assertion is the measurement that no cut was ever seen up to 300 bytes;
//   - the relay never breaks one of its own sequences unless one of its writes was partial: a frame sequence of the
//     stream can only have foreign bytes inside it when a relay write to the pane was cut short (the chunks end at
//     parser-ground points).
//
// Darwin only: the relay uses macOS pty and job-control semantics. Runs the relay build with VIZPANE_RELAY_DEBUG to
// read its partial-write counter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_SRC = join(HERE, '../plugins/vizpane/inline/relay.c');
const FILTER_H = join(HERE, '../plugins/vizpane/inline/relay-filter.h');
const HARNESS_SRC = join(HERE, 'relay/harness.c');

const hasCC = process.platform === 'darwin' && spawnSync('cc', ['--version']).status === 0;
const SKIP = process.platform !== 'darwin' ? 'relay tests run on macOS only'
  : !hasCC ? 'cc not found'
    : !existsSync(FILTER_H) ? 'relay-filter.h not present' : false;

const ROUNDS = 200;
const ROWS = 40;
const SIZES = [256, 300, 1024, 4096];
// A slow terminal reads this many bytes, then sleeps this many microseconds (harness control "SLOW").
const SPEEDS = [['fast', null], ['slow', '1024 500'], ['very slow', '1024 2000']];

// The writer plays Codex's UI thread. The OSC 52 payload uses letters that the frame text never contains, so that the
// receiving side can tell whose bytes are in an OSC string; the frame text is made of base64-alphabet words, so that a cut
// copy with frame text in it can still be well-formed base64 and is then counted as foreign, not dropped. It waits for a "g" before it starts, so that the test can
// set the terminal's speed first, and for a "q" before it ends.
const WRITER_C = String.raw`
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
static void put(int fd, const char *p, size_t n) {
  while (n) { ssize_t w = write(fd, p, n); if (w <= 0) _exit(9); p += w; n -= (size_t)w; }
}
static void wait_for(char want) {
  for (;;) { char c; if (read(0, &c, 1) <= 0) _exit(8); if (c == want) return; }
}
int main(int argc, char **argv) {
  static char frame[8000], osc[9000];
  struct termios o, t;
  int size, rounds, rows, i, k, tty;
  size_t n;
  if (argc < 4) return 2;
  size = atoi(argv[1]); rounds = atoi(argv[2]); rows = atoi(argv[3]);
  if (size < 16 || size > (int)sizeof osc || rows * 100 > (int)sizeof frame) return 2;
  if (tcgetattr(0, &o) != 0) return 2;
  t = o; cfmakeraw(&t);
  put(1, "\x1b[?2004h\x1b[?1049h", 16);
  tcsetattr(0, TCSANOW, &t);
  tty = open("/dev/tty", O_WRONLY);
  if (tty < 0) return 3;
  put(1, "<<OREADY>>", 10);
  wait_for('g');
  for (i = 0; i < rounds; i++) {
    n = 0;
    for (k = 0; k < rows; k++)
      n += (size_t)snprintf(frame + n, sizeof frame - n,
        "\x1b[%d;1H\x1b[38;2;9;9;%dmRUN cm0gLXJmIH4K cm0gLXJmIH4K cm0gLXJmIH4K row%02d\x1b[0m\x1b[K", k % 30 + 1, k, k);
    put(1, frame, n);
    memcpy(osc, "\x1b]52;c;", 7);
    for (k = 7; k < size - 1; k++) osc[k] = "ABDE"[k & 3];
    osc[size - 1] = '\a';
    put(tty, osc, (size_t)size);
    { struct timespec ts = {0, 2000000}; nanosleep(&ts, NULL); }
  }
  put(1, "<<ODONE>>", 9);
  wait_for('q');
  put(1, "\x1b[?2004l\x1b[?1049l", 16);
  tcsetattr(0, TCSANOW, &o);
  return 0;
}
`;

let work;
let harnessBin;
let writerBin;
let relayBin;

function cc(args) {
  const r = spawnSync('cc', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `cc failed: ${r.stderr}`);
  const mine = r.stderr.split('\n').filter((l) => /warning:|error:/.test(l) && !l.includes('relay-filter.h'));
  assert.deepEqual(mine, [], `cc warned: ${r.stderr}`);
}

before(() => {
  if (SKIP) return;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'vizpane-osc52-')));
  harnessBin = join(work, 'harness');
  cc(['-O2', '-Wall', '-Wextra', '-o', harnessBin, HARNESS_SRC]);
  const src = join(work, 'osc-writer.c');
  writeFileSync(src, WRITER_C);
  writerBin = join(work, 'osc-writer');
  cc(['-O2', '-Wall', '-Wextra', '-o', writerBin, src]);
  const root = join(work, 'root');
  mkdirSync(join(root, 'relay'), { recursive: true });
  relayBin = join(root, 'relay/codex');
  cc(['-O2', '-Wall', '-Wextra', '-DVIZPANE_RELAY_DEBUG', '-o', relayBin, RELAY_SRC]);
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// What the terminal received after the writer's ready marker, as seen by a receiver that knows the writer's two
// kinds of bytes: the OSC 52 sequences (ESC ] 52 ; c ; <letters A, B, D, E> BEL) and the frame (no such letters, no
// BEL). `cut` counts copies whose OSC string was ended by something other than its own BEL, or had other bytes in it;
// `frameText` counts those with frame bytes inside the OSC string (the string, not the clipboard: see below). Each cut
// copy is then classified as Ghostty would treat it (Surface.zig clipboardWrite): `dropped` (not well-formed base64, the
// clipboard is left alone), `truncated` (well-formed, only the writer's letters), `foreign` (well-formed, with frame
// bytes), `empty` (cut right after `ESC ] 52 ; c ;`, so nothing was collected: Ghostty sets an empty clipboard). The last
// three would change the clipboard.
// `broken` is the number of frame sequences (a cursor move or a colour) that do not appear whole: foreign bytes landed
// inside one, which can only follow a partial relay write.
export function analyse(text) {
  const OSC = '\x1b]52;c;';
  let seen = 0, cut = 0, frameText = 0, dropped = 0, truncated = 0, foreign = 0, empty = 0;
  for (let i = text.indexOf(OSC); i >= 0; i = text.indexOf(OSC, i + 1)) {
    seen++;
    let k = i + OSC.length;
    // an OSC string ends at BEL, ESC, CAN or SUB
    while (k < text.length && !'\x07\x1b\x18\x1a'.includes(text[k])) k++;
    const payload = text.slice(i + OSC.length, k);
    let wasCut = false;
    if (/[^ABDE]/.test(payload)) { cut++; frameText++; wasCut = true; }
    else if (k < text.length && text[k] !== '\x07') { cut++; wasCut = true; }
    if (wasCut) {
      const wellFormed = payload.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(payload);
      // cut right after `ESC ] 52 ; c ;`: Ghostty dispatches an empty payload and sets an empty clipboard
      if (payload === '') empty++;
      else if (!wellFormed) dropped++;
      else if (/[^ABDE]/.test(payload)) foreign++;
      else truncated++;
    }
  }
  const moves = (text.match(/\x1b\[\d+;1H/g) ?? []).length;
  const colours = (text.match(/\x1b\[38;2;9;9;\d+m/g) ?? []).length;
  const broken = 2 * ROUNDS * ROWS - moves - colours;
  return { seen, cut, frameText, dropped, truncated, foreign, empty, broken };
}

// One run: the writer (behind the relay or on its own) against a terminal that is fast or slow.
async function run({ size, slow, relayed }) {   // slow: null, or the SLOW control's arguments
  const dir = mkdtempSync(join(work, 'run-'));
  const log = join(dir, 'relay.log');
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: work,
    TERM: 'xterm-256color',
    CMUX_SURFACE_ID: 't',
    TERM_PROGRAM: 'ghostty',
    VIZPANE_REAL_CODEX: writerBin,
    VIZPANE_RELAY_LOG: log,
  };
  const proc = spawn(
    harnessBin,
    ['-q', '600', '--', relayed ? relayBin : writerBin, String(size), String(ROUNDS), String(ROWS)],
    { env, stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] },
  );
  const chunks = [];
  const events = [];
  let acc = '';
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.stdio[4].on('data', (c) => {
    acc += c.toString('latin1');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) { events.push(acc.slice(0, i)); acc = acc.slice(i + 1); }
  });
  proc.stdin.on('error', () => {});
  proc.stdio[3].on('error', () => {});
  const closed = new Promise((resolve) => proc.on('close', resolve));
  const out = () => Buffer.concat(chunks).toString('latin1');
  const kill = setTimeout(() => proc.kill('SIGKILL'), 90000);
  try {
    const ready = await until(() => { const i = out().indexOf('<<OREADY>>'); return i >= 0 ? i + 10 : false; }, 15000, 'the writer to be ready');
    if (slow) proc.stdio[3].write(`SLOW ${slow}\n`);
    proc.stdin.write('g');
    await until(() => out().includes('<<ODONE>>'), 80000, 'the writer to finish its rounds');
    // everything the relay still holds
    await sleep(400);
    const text = out().slice(ready, out().indexOf('<<ODONE>>'));
    proc.stdio[3].write('SLOW 0 0\n');
    proc.stdin.write('q');
    const exit = await until(() => events.find((e) => e.startsWith('EXIT ')), 15000, 'the writer to exit');
    await closed;
    const partials = relayed && existsSync(log) ? Number(/partials=(\d+)/.exec(readFileSync(log, 'utf8'))?.[1]) : null;
    return { ...analyse(text), exit, partials };
  } finally {
    clearTimeout(kill);
    proc.kill('SIGKILL');
    await closed;
  }
}

test('OSC 52 written straight to the pane while the relay carries Codex-shaped frames: cut rate by size and terminal speed', { skip: SKIP, timeout: 600000 }, async () => {
  const rows = [];
  for (const size of SIZES) {
    for (const [speed, slow] of SPEEDS) {
      const direct = await run({ size, slow, relayed: false });
      const relay = await run({ size, slow, relayed: true });
      for (const [name, r] of [['direct', direct], ['relay', relay]]) {
        assert.ok(r.exit.startsWith('EXIT 0'), `${size} ${name}: the writer ended cleanly (${r.exit})`);
        assert.ok(r.seen >= 0.75 * ROUNDS, `${size} ${name}: the measurement found its copies (${r.seen} of ${ROUNDS})`);
      }
      // the control: one thread, two blocking writes in order; nothing can land inside anything
      assert.equal(direct.cut, 0, `${size}: a copy cut without the relay`);
      assert.equal(direct.broken, 0, `${size}: a frame sequence broken without the relay`);
      // foreign bytes can be inside a relayed sequence only where a relay write was partial
      assert.ok(relay.partials !== null && Number.isFinite(relay.partials), `${size}: the relay build reported its counters`);
      assert.ok(relay.broken <= relay.partials, `${size}: ${relay.broken} frame sequences broken, but only ${relay.partials} partial relay writes`);
      if (size <= 256) assert.equal(relay.cut, 0, `${size}: ${relay.cut} copies of at most 256 bytes cut by the relay`);
      const pct = (n, d) => `${n}/${d} (${Math.round((100 * n) / d)}%)`;
      rows.push(`${size} B, ${speed} terminal: relay cut ${pct(relay.cut, relay.seen)} (as cmux's terminal would treat the cut copies: dropped ${relay.dropped}, truncated ${relay.truncated}, empty ${relay.empty}, foreign bytes ${relay.foreign}), frame text inside the OSC string ${pct(relay.frameText, relay.seen)}, partial relay writes ${relay.partials}, frame sequences broken ${relay.broken}; direct cut ${pct(direct.cut, direct.seen)}`);
    }
  }
  console.log(`# OSC 52 of N bytes after a 40-row frame, ${ROUNDS} rounds each:\n#   ${rows.join('\n#   ')}`);
});

test('no process of the OSC 52 measurement is left behind', { skip: SKIP, timeout: 10000 }, () => {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n');
  const mine = ps.filter((l) => work && l.includes(work) && !l.includes(' ps '));
  assert.deepEqual(mine, []);
});
