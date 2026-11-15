#!/usr/bin/env node
// On-screen check of the Codex relay. Builds the relay into a temporary state root, runs a fake
// TUI through it in the CURRENT pane for a few seconds so that a picture is drawn, then prints
// the placeholder cells of that same picture after the relay has exited, where they must draw
// blank, next to a control block whose picture the script loads itself and which must show. The
// last step is a look at the screen: the script cannot read what a terminal drew. It makes no
// model call and never touches ~/.codex or your shell profile.
//
// It takes over the pane's terminal, so run it only in a spare cmux pane, never in a pane with a
// live agent session. It refuses to run outside cmux.
//
//   node scripts/check-codex-inline.mjs
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = fileURLToPath(import.meta.url);
const plugin = join(dirname(here), '..', 'plugins', 'vizpane');

const BOX_COLUMNS = 32;
const BOX_ROWS = 8;
const SHOW_MS = 5000;
const LOOK_MS = 6000;
const MIN_COLUMNS = 40;
const MIN_ROWS = 16;

// MARK: the fake TUI (runs as the "real Codex" behind the relay)

// A valid PNG of four colour quadrants: red, green over blue, yellow.
function quadrantPng(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const colour = (x, y) => {
    if (y < height / 2) return x < width / 2 ? [220, 40, 40] : [40, 180, 60];
    return x < width / 2 ? [50, 90, 230] : [240, 200, 40];
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(colour(x, y), y * (1 + width * 3) + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fakeTui(resultFile) {
  const { publish, buildMessage } = await import(join(plugin, 'lib', 'codex-inline.mjs'));
  const dir = process.env.VIZPANE_INLINE_DIR;
  const result = { engaged: Boolean(dir), transmitted: false };
  const save = () => writeFileSync(resultFile, JSON.stringify(result));
  save();
  if (!dir) return;
  const png = join(dir, '..', '..', 'check.png');
  writeFileSync(png, quadrantPng(320, 160));
  const { id } = publish(dir, png, BOX_COLUMNS, BOX_ROWS);
  result.id = id;
  save();
  const message = buildMessage([{ number: 1, source: 'relay check', id, columns: BOX_COLUMNS, rows: BOX_ROWS }]);
  // Alternate screen and bracketed paste: the relay treats the program as a live TUI from here.
  let out = '\x1b[?1049h\x1b[?2004h\x1b[2J';
  out += '\x1b[1;1HFake TUI behind the vizpane relay';
  message.split('\n').forEach((line, i) => { out += `\x1b[${3 + i};1H${line}`; });
  out += `\x1b[${4 + message.split('\n').length};1HYou should see four coloured quadrants above:`;
  out += `\x1b[${5 + message.split('\n').length};1Hred and green on top, blue and yellow below.`;
  process.stdout.write(out);
  const end = Date.now() + SHOW_MS;
  while (Date.now() < end) {
    if (existsSync(join(dir, 'resolved'))) result.transmitted = true;
    await new Promise((done) => setTimeout(done, 100));
  }
  save();
  process.stdout.write('\x1b[?2004l\x1b[?1049l');
}

if (process.argv[2] === '--fake-tui') {
  await fakeTui(process.argv[3]);
  process.exit(0);
}

// MARK: the check

const fail = (message) => {
  console.error(`check-codex-inline: ${message}`);
  process.exit(1);
};

if (process.platform !== 'darwin') fail('macOS only');
if (!process.env.CMUX_SURFACE_ID) fail('run it inside a cmux terminal (CMUX_SURFACE_ID is not set)');
if (!process.stdin.isTTY || !process.stdout.isTTY) fail('stdin and stdout must be the terminal');
if (process.stdout.columns < MIN_COLUMNS || process.stdout.rows < MIN_ROWS) {
  fail(`the pane is too small; it needs at least ${MIN_COLUMNS} columns and ${MIN_ROWS} rows`);
}

console.log('WARNING: this check takes over this pane for about 15 seconds and draws a test picture.');
console.log('Run it only in a spare cmux pane, never in a pane with a live Codex or Claude Code session.');
console.log('Starting in 3 seconds; press Ctrl+C now to cancel.');
await new Promise((done) => setTimeout(done, 3000));

const root = mkdtempSync(join(tmpdir(), 'vizpane-check-codex-inline-'));
process.env.VIZPANE_HOME = root;
let status = 1;
try {
  const { syncApp } = await import(join(plugin, 'lib', 'sync.mjs'));
  const { ensureRelay } = await import(join(plugin, 'lib', 'renderer.mjs'));
  const { buildMessage, ID_MIN } = await import(join(plugin, 'lib', 'codex-inline.mjs'));
  syncApp();
  const relay = ensureRelay();
  if (!relay.ok) throw new Error(`cannot build the relay: ${relay.error}`);
  console.log('ok   relay built in a temporary state root');

  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const fake = join(root, 'fake-codex');
  const resultFile = join(root, 'result.json');
  writeFileSync(fake, `#!/bin/sh\nexec ${q(process.execPath)} ${q(here)} --fake-tui ${q(resultFile)}\n`);
  chmodSync(fake, 0o755);

  const env = { ...process.env, VIZPANE_REAL_CODEX: fake, VIZPANE_HOME: root };
  for (const name of ['VIZPANE_INLINE_DIR', 'VIZPANE_INLINE', 'NO_COLOR', 'CODEX_THREAD_ID']) delete env[name];
  console.log('Starting the fake TUI through the relay. Look for four coloured quadrants.');

  const run = spawnSync(relay.path, [], { env, stdio: 'inherit' });
  let result = {};
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch {}

  console.log('');
  console.log(run.status === 0 ? 'ok   the fake TUI exited with status 0 through the relay' : `FAIL exit status ${run.status ?? run.signal}`);
  console.log(result.engaged ? 'ok   the relay was engaged (the session directory was set)' : 'FAIL the relay did not engage; run "vizpane doctor" and check TERM_PROGRAM and CMUX_SURFACE_ID');
  console.log(result.transmitted ? 'ok   the relay transmitted the picture' : 'FAIL the relay did not transmit the picture');
  if (run.status !== 0 || !result.engaged || !result.transmitted) throw new Error('the relay check failed');

  // The placeholder cells of the picture the relay loaded, now that the relay is gone, on the
  // alternate screen where it was loaded (terminals keep images per screen). Beside them a control:
  // the same picture loaded by this script under another id, which must show, so that a blank
  // block means "nothing loaded" and not "this check cannot show anything".
  if (!Number.isInteger(result.id)) throw new Error('the fake TUI did not report the picture id');
  const png = join(root, 'inline', 'check.png');
  const controlId = result.id === ID_MIN ? ID_MIN + 1 : ID_MIN;
  const cells = (id, label) => buildMessage([{ number: 1, source: label, id, columns: BOX_COLUMNS, rows: BOX_ROWS }]);
  const transmit = `\x1b_Ga=T,U=1,q=2,t=f,f=100,i=${controlId},c=${BOX_COLUMNS},r=${BOX_ROWS};${Buffer.from(png).toString('base64')}\x1b\\`;
  const blank = cells(result.id, 'after exit: must be BLANK');
  const control = cells(controlId, 'control: must show four quadrants');
  console.log('');
  console.log(`Next, ${LOOK_MS / 1000} seconds on the alternate screen: block A (the relay's picture, id ${result.id.toString(16)}) must be BLANK,`);
  console.log('block B (a control the script loads itself) must show four quadrants.');
  await new Promise((done) => setTimeout(done, 2000));
  process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[1;1H${blank}\n\n${transmit}${control}\n\nA above: blank means the relay freed its picture. B above: must show the quadrants.`);
  await new Promise((done) => setTimeout(done, LOOK_MS));
  process.stdout.write(`\x1b_Ga=d,d=I,i=${controlId},q=2\x1b\\\x1b[?1049l`);
  console.log('Check by eye: four quadrants during the run; then A blank and B drawn.');
  console.log('If A showed a picture, the relay left an image loaded: please report it. If B was blank too, this check cannot tell (the terminal did not take the control): do not read anything into A.');
  status = 0;
} catch (e) {
  console.error(`check-codex-inline: ${e.message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(status);
