#!/usr/bin/env node
// A fake Codex for the relay's pty tests. It takes the terminal the way a TUI
// does (raw mode, alternate screen, bracketed paste), logs everything the relay
// could get wrong, and has a few keys that trigger the behaviours under test.
//
// It does nothing unless FAKE_TUI_LOG is set, because `node --test` also loads
// every .mjs file under test/.
//
//   FAKE_TUI_LOG     file that receives one line per event
//   FAKE_TUI_KEYS=1  enable the keys below (off for byte-exact input tests)
//   FAKE_TUI_WINSZ   program that prints "cols rows xpix ypix" for its stdin
//   FAKE_TUI_AUTOEXIT=1  log the start and exit 0 at once (gating tests)
//
// What the shell receives as type-ahead is tested with the C stand-in (stand-in.c): this process
// keeps reading its stdin, so it is no baseline for that.
//
// Keys: z suspend (Ctrl+Z as Codex does it), g editor child, q exit 3,
//       x SIGTERM itself, l leave a helper holding the terminal and exit 0,
//       o write 1 MiB, E write 1 MiB and exit 0 at once, w log the size now,
//       Z write 40000 bytes, then suspend; F write 40000 bytes, then exit 0 at once,
//       K leave a process that writes without end and exit 0,
//       e write a line to stderr, B write 1 MiB in 4 KiB writes and log the progress.
import { appendFileSync, fstatSync, readdirSync, writeSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { isatty } from 'node:tty';

const LOG = process.env.FAKE_TUI_LOG;
if (!LOG) process.exit(0);

const log = (line) => appendFileSync(LOG, `${line}\n`);
const ENTER = '\x1b[?1049h\x1b[?2004h';
const LEAVE = '\x1b[?2004l\x1b[?1049l';

// The deterministic 1 MiB payload; the test builds the same bytes.
function payload() {
  const out = Buffer.alloc(1 << 20);
  let x = 0x12345678;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x >>> 24;
  }
  return out;
}

// stdout is shared with a non-blocking stdin description in some setups, so a
// plain writeSync can see EAGAIN.
function put(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function winsz() {
  const prog = process.env.FAKE_TUI_WINSZ;
  if (!prog) return '? ? ? ?';
  const r = spawnSync(prog, ['--winsz'], { stdio: ['inherit', 'pipe', 'inherit'] });
  return String(r.stdout).trim();
}

function start() {
  let fds = [];
  try { fds = readdirSync('/dev/fd').map(Number).sort((a, b) => a - b); } catch { /* none */ }
  log(`READY ${JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(2),
    dir: process.env.VIZPANE_INLINE_DIR ?? null,
    tty: process.env.VIZPANE_TTY ?? null,
    stdinTTY: Boolean(process.stdin.isTTY),
    stdinRdev: fstatSync(0).rdev,
    stdoutRdev: fstatSync(1).rdev,
    stderrTTY: isatty(2),
    env: Object.fromEntries(Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    fds,
  })}`);
}

if (process.env.FAKE_TUI_AUTOEXIT === '1') {
  start();
  process.exit(0);
}

const keys = process.env.FAKE_TUI_KEYS === '1';

// Raw without output post-processing, so the bytes written are the bytes seen.
spawnSync('stty', ['raw', '-echo', '-opost'], { stdio: 'inherit' });

process.on('SIGWINCH', () => log(`WINCH ${winsz()}`));
// The same continue can arrive twice (the job's own, and the relay's copy of it); a test that counts
// continues counts at least.
process.on('SIGCONT', () => {
  log('CONT');
  put(ENTER);
});
process.on('SIGHUP', () => {
  log('HUP');
  process.exit(0);
});

process.stdin.on('data', (chunk) => {
  log(`IN ${chunk.toString('hex')}`);
  if (!keys) return;
  for (const b of chunk) {
    switch (String.fromCharCode(b)) {
      case 'z':
        // What Codex does on Ctrl+Z: restore the terminal, then stop its group.
        put(LEAVE);
        log('STOPPING');
        process.kill(0, 'SIGTSTP');
        break;
      case 'g':
        put('EDIT-BEGIN\n');
        spawnSync('stty', ['size'], { stdio: 'inherit' });
        put('EDIT-END\n');
        log('EDITOR-DONE');
        break;
      case 'q':
        put(LEAVE);
        process.exit(3);
        break;
      case 'x':
        put(LEAVE);
        process.kill(process.pid, 'SIGTERM');
        break;
      case 'l': {
        const helper = spawn('sleep', ['5'], { stdio: 'inherit', detached: true });
        helper.unref();
        log(`LEAK ${helper.pid}`);
        put(LEAVE);
        log(`EXITING ${Date.now()}`);
        process.exit(0);
        break;
      }
      case 'o':
        put(payload());
        log('PAYLOAD-SENT');
        break;
      case 'Z':
        put(payload().subarray(0, 40000));
        put(LEAVE);
        log('STOPPING');
        process.kill(0, 'SIGTSTP');
        break;
      case 'F':
        put(payload().subarray(0, 40000));
        put(LEAVE);
        process.exit(0);
        break;
      case 'K': {
        // A leaked writer that keeps the inner terminal busy after Codex has exited.
        const writer = spawn('yes', [], { stdio: 'inherit', detached: true });
        writer.unref();
        log(`LEAK ${writer.pid}`);
        sleepMs(300);                     // let it get going
        put(LEAVE);
        process.exit(0);
        break;
      }
      case 'e':
        writeSync(2, 'ERRTEST\n');
        log('ERR-WRITTEN');
        break;
      case 'B': {
        const all = payload();
        for (let off = 0; off < all.length; off += 4096) {
          put(all.subarray(off, off + 4096));
          log(`PROGRESS ${off + 4096}`);
        }
        break;
      }
      case 'E':
        put(payload());
        put(LEAVE);
        process.exit(0);
        break;
      case 'w':
        log(`SIZE ${winsz()}`);
        break;
      default:
    }
  }
});
process.stdin.on('end', () => {
  log('END');
  process.exit(0);
});

put(ENTER);
start();
