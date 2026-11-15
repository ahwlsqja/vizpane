// T2: the relay's process part, driven through a real pty.
//
// test/relay/harness.c plays the terminal and the shell (own session, own foreground process group,
// job control events; with -z it runs a real `/bin/zsh -i` as the session leader instead).
// test/relay/stand-in.c and test/relay/fake-tui.mjs play Codex, test/relay/foreign-writer.c plays
// another writer to the terminal. All are built here. Darwin only: the relay uses macOS pty and
// job-control semantics.
//
// The relay carries Codex's output only: keys, terminal modes, the window size and job control
// stay between the terminal and Codex. The tests check that, and that what the shell and the
// terminal see is what a stock run of the same program shows.
//
// Environment:
//   VIZPANE_TEST_ASAN=1   build the relay with AddressSanitizer and UBSan
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync,
  existsSync, readdirSync, statSync, symlinkSync, linkSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from './helpers/vtlex.mjs';
import { makePng } from './helpers/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_SRC = join(HERE, '../plugins/vizpane/inline/relay.c');
const FILTER_H = join(HERE, '../plugins/vizpane/inline/relay-filter.h');
const HARNESS_SRC = join(HERE, 'relay/harness.c');
const FAKE_SRC = join(HERE, 'relay/fake-tui.mjs');
const STAND_IN_SRC = join(HERE, 'relay/stand-in.c');
const WRITER_SRC = join(HERE, 'relay/foreign-writer.c');
const BLOCK_SRC = join(HERE, 'relay/block-exec.c');
const CUT_SRC = join(HERE, 'relay/utf8-cut-test.c');

const hasCC = process.platform === 'darwin' && spawnSync('cc', ['--version']).status === 0;
const hasZsh = existsSync('/bin/zsh');
const SKIP = process.platform !== 'darwin' ? 'relay tests run on macOS only' : !hasCC ? 'cc not found' : false;
const SKIP_ZSH = SKIP || (!hasZsh ? '/bin/zsh not found' : false);
const ASAN = process.env.VIZPANE_TEST_ASAN === '1';

const ENTER = '\x1b[?1049h\x1b[?2004h';
const LEAVE = '\x1b[?2004l\x1b[?1049l';
const ICANON = 0x100;
const ECHO = 0x8;
const PENDIN = 0x20000000;
const SIGTSTP = 18;
const SIGTTOU = 22;
const SHELL_PAYLOAD = 40000;   // what the fake TUI's Z and F keys write

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

// The same deterministic bytes as fake-tui.mjs.
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

function seeded(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = (x >>> 8) & 0xff;
  }
  return out;
}

let work;
let harnessBin;
let fakeBin;
let standInBin;
let writerBin;
let blockBin;
let zdot;
const variants = [];
const leftovers = [];

function cc(args) {
  const r = spawnSync('cc', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `cc failed: ${r.stderr}`);
  // Warnings that come from the filter header are the filter's own business.
  const mine = r.stderr.split('\n').filter((l) => /warning:|error:/.test(l) && !l.includes('relay-filter.h'));
  assert.deepEqual(mine, [], `cc warned: ${r.stderr}`);
}

before(() => {
  if (SKIP) return;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'vizpane-relay-')));
  harnessBin = join(work, 'harness');
  cc(['-O2', '-Wall', '-Wextra', '-o', harnessBin, HARNESS_SRC]);
  standInBin = join(work, 'stand-in');
  cc(['-O2', '-Wall', '-Wextra', '-o', standInBin, STAND_IN_SRC]);
  writerBin = join(work, 'foreign-writer');
  cc(['-O2', '-Wall', '-Wextra', '-o', writerBin, WRITER_SRC]);
  blockBin = join(work, 'block-exec');
  cc(['-O2', '-Wall', '-Wextra', '-o', blockBin, BLOCK_SRC]);
  fakeBin = join(work, 'fake-codex');
  copyFileSync(FAKE_SRC, fakeBin);
  chmodSync(fakeBin, 0o755);
  // a real interactive zsh with nothing of the user's in it: a marker prompt and no line-editor extras
  zdot = join(work, 'zdot');
  mkdirSync(zdot);
  writeFileSync(join(zdot, '.zshrc'), "PS1='PROMPT> '\nPROMPT_EOL_MARK=''\nunsetopt BEEP\nunset zle_bracketed_paste\nHISTFILE=/dev/null\n");
  const flags = ASAN
    ? ['-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=undefined']
    : ['-O2'];
  // every build counts its writes (VIZPANE_RELAY_LOG); the last two leave out one safeguard each, as
  // negative controls for the tests that must notice
  const defs = [
    ['stub', ['-DVF_STUB']],
    ['nodrain', ['-DVF_STUB', '-DVIZPANE_RELAY_NODRAIN']],
    ['nofollow', ['-DVF_STUB', '-DVIZPANE_RELAY_NOFOLLOW']],
  ];
  if (existsSync(FILTER_H)) defs.push(['filter', []]);
  for (const [name, extra] of defs) {
    const root = join(work, name, 'root');
    mkdirSync(join(root, 'relay'), { recursive: true });
    const relay = join(root, 'relay/codex');
    cc([...flags, '-Wall', '-Wextra', '-DVIZPANE_RELAY_DEBUG', ...extra, '-o', relay, RELAY_SRC]);
    variants.push({ name, root, relay, sessions: join(root, 'inline/sessions') });
  }
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

function baseEnv(v, extra = {}) {
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: work,
    TERM: 'xterm-256color',
    CMUX_SURFACE_ID: 't',
    TERM_PROGRAM: 'ghostty',
    VIZPANE_REAL_CODEX: fakeBin,
    FAKE_TUI_WINSZ: harnessBin,
    FAKE_TUI_KEYS: '1',
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  return env;
}

class Term {
  // zsh: the program is a real interactive zsh and the test types command lines at its prompt
  constructor(v, { args = [], env = {}, harnessArgs = [], program, quiet = 300, typeahead = false, zsh = false } = {}) {
    this.v = v;
    this.log = join(mkdtempSync(join(work, 't-')), 'fake.log');
    this.chunks = [];
    this.events = [];
    this.ended = false;
    this.typeaheadFile = join(dirname(this.log), 'typeahead');
    // With a file the shell reads the type-ahead until it is quiet and keeps all of it there; without
    // one it reports a single look at the queue.
    const zenv = zsh ? { HOME: join(dirname(this.log)), ZDOTDIR: zdot, LANG: 'en_US.UTF-8', VIZPANE_REAL_CODEX: standInBin, FAKE_TUI_KEYS: '0' } : {};
    const full = baseEnv(v, { FAKE_TUI_LOG: this.log, ...(typeahead ? { HARNESS_TYPEAHEAD_FILE: this.typeaheadFile } : {}), ...zenv, ...env });
    this.proc = spawn(
      harnessBin,
      ['-q', String(quiet), ...(zsh ? ['-z'] : []), ...harnessArgs, '--', ...(zsh ? ['/bin/zsh', '-i'] : [program ?? v.relay, ...args])],
      { env: full, stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] },
    );
    this.proc.on('error', (e) => { this.error = e; });
    this.proc.stdout.on('data', (c) => this.chunks.push(c));
    let acc = '';
    this.proc.stdio[4].on('data', (c) => {
      acc += c.toString('latin1');
      let i;
      while ((i = acc.indexOf('\n')) >= 0) {
        this.events.push(acc.slice(0, i));
        acc = acc.slice(i + 1);
      }
    });
    this.closed = new Promise((resolve) => this.proc.on('close', (code, sig) => {
      this.ended = true;
      resolve({ code, sig });
    }));
    this.proc.stdin.on('error', () => {});
    this.proc.stdio[3].on('error', () => {});
  }

  get out() { return Buffer.concat(this.chunks); }
  get outText() { return this.out.toString('latin1'); }
  send(data) { this.proc.stdin.write(data); }
  control(line) { this.proc.stdio[3].write(`${line}\n`); }
  event(prefix) { return this.events.find((e) => e.startsWith(prefix)); }
  async waitEvent(prefix, ms = 8000) {
    return until(() => this.event(prefix), ms, `event ${prefix}`);
  }
  get relayPid() { return Number(this.event('PID ')?.slice(4)); }
  get ttyPath() { return this.event('TTY ')?.slice(4); }
  // Everything the shell found in the terminal's input, however much (the event carries 512 bytes).
  typeahead() { return existsSync(this.typeaheadFile) ? readFileSync(this.typeaheadFile, 'latin1') : ''; }
  logLines() { return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter(Boolean) : []; }
  logFind(re) { return this.logLines().find((l) => re.test(l)); }
  async waitLog(re, ms = 8000) { return until(() => this.logFind(re), ms, `log ${re}`); }
  ready() {
    const l = this.logFind(/^READY /);
    return l ? JSON.parse(l.slice(6)) : null;
  }
  async waitReady() { await until(() => this.ready(), 8000, 'fake TUI READY'); return this.ready(); }
  // The stand-in's start-up marker has reached the terminal: the offset right after it. (Its READY line in the log
  // comes first; the bytes follow a moment later when they go through a relay.)
  async afterMarker() { return (await this.waitText('<<READY>>', 0, 8000)) + '<<READY>>'.length; }
  inputHex() {
    return this.logLines().filter((l) => l.startsWith('IN ')).map((l) => l.slice(3)).join('');
  }
  async termios() {
    const before = this.events.filter((e) => e.startsWith('TERMIOS ')).length;
    this.control('T');
    const line = await until(
      () => this.events.filter((e) => e.startsWith('TERMIOS '))[before], 4000, 'TERMIOS');
    const m = Object.fromEntries(line.slice(8).split(' ').map((kv) => kv.split('=')));
    // PENDIN is the driver's own "input to be retyped" mark: it is set by a change of ICANON and
    // cleared by the next read, so it says nothing about the settings the program chose.
    const l = parseInt(m.l, 16) & ~PENDIN;
    return { raw: line.replace(/ l=[0-9a-f]+/, ` l=${l.toString(16)}`), l, o: parseInt(m.o, 16), i: parseInt(m.i, 16) };
  }
  sessionDirs(v = this.v) {
    return existsSync(v.sessions) ? readdirSync(v.sessions) : [];
  }
  // -- a real shell --
  // Waits for text in the terminal output from an offset on; returns where it starts.
  async waitText(text, from = 0, ms = 15000) {
    return until(() => { const i = this.outText.indexOf(text, from); return i >= 0 ? i : false; }, ms, `terminal text ${JSON.stringify(text)}`)
      .then((i) => i);
  }
  // the shell's prompt after an offset
  async prompt(from = 0, ms = 15000) { return this.waitText('PROMPT> ', from, ms); }
  type(line) { this.send(`${line}\r`); }
  // Waits for the shell's prompt, runs the relay (or any command line) and waits for the stand-in.
  async start(cmdline) {
    await this.prompt();
    const pos = this.out.length;
    this.type(cmdline);
    await this.waitText('<<READY>>', pos);
    return pos;
  }
  // Wait for the harness to finish; kill everything we started afterwards.
  async finish(ms = 10000) {
    const t = setTimeout(() => this.proc.kill('SIGKILL'), ms);
    const r = await this.closed;
    clearTimeout(t);
    await this.cleanup();
    return r;
  }
  pids() {
    const out = [];
    const r = this.ready();
    if (r) out.push(r.pid);
    for (const l of this.logLines()) if (l.startsWith('LEAK ')) out.push(Number(l.slice(5)));
    if (this.relayPid) out.push(this.relayPid);
    return out;
  }
  // what of ours still runs: the relay build, the stand-in and the fake TUI of this test
  running() {
    const needle = dirname(this.log);
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n');
    return ps.filter((l) => l.includes(needle) || l.includes(this.v.relay) || l.includes(standInBin) || l.includes(fakeBin))
      .filter((l) => !l.includes(' ps ') && !l.includes(harnessBin));
  }
  async cleanup() {
    if (!this.ended) {
      this.proc.kill('SIGTERM');
      const t = setTimeout(() => this.proc.kill('SIGKILL'), 3000);
      await this.closed;
      clearTimeout(t);
    }
    // Anything that still runs from this test's own paths is a leak.
    const end = Date.now() + 2500;
    while (this.running().length && Date.now() < end) await sleep(50);
    const left = this.running();
    if (left.length) {
      leftovers.push(...left);
      for (const l of left) { try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ } }
    }
    for (const pid of this.pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

async function session(v, opts, body) {
  const t = new Term(v, opts);
  try {
    await body(t);
  } catch (e) {
    // Show what the harness and the fake TUI saw; a bare timeout says little.
    const log = t.logLines().filter((l) => !l.startsWith('IN ')).slice(-12);
    e.message += `\n  events: ${JSON.stringify(t.events)}\n  fake TUI log: ${JSON.stringify(log)}\n  terminal bytes: ${t.out.length}${t.out.length > 0 && t.out.length < 2000 ? ` ${JSON.stringify(t.outText)}` : ` tail ${JSON.stringify(t.outText.slice(-300))}`}${/ERROR|Sanitizer|runtime error/.test(t.outText) ? `\n  terminal tail: ${t.outText.slice(Math.max(0, t.outText.search(/ERROR|Sanitizer|runtime error/) - 50)).slice(0, 3500)}` : ''}`;
    throw e;
  } finally {
    await t.cleanup();
  }
}

// a real zsh at the terminal
const zsh = (v, opts, body) => session(v, { ...opts, zsh: true }, body);

const T = { timeout: 40000 };
const TZ = { timeout: 90000 };

// ---------------------------------------------------------------------------
describe('relay chunking', { skip: SKIP }, () => {
  for (const [name, defs] of [['stub', ['-DVF_STUB']], ['filter', []]]) {
    test(`a run without cut points is cut at a character start, not between a placeholder and its marks (${name} filter)`, { skip: name === 'filter' && !existsSync(FILTER_H) }, () => {
      const bin = join(work, `utf8-cut-${name}`);
      cc(['-O2', '-Wall', '-Wextra', ...defs, '-o', bin, CUT_SRC]);
      const r = spawnSync(bin, [], { encoding: 'utf8' });
      assert.equal(r.stdout.trim(), 'ok', r.stdout + r.stderr);
    });
  }
});

for (const variantName of ['stub', 'filter']) {
  describe(`relay process part (${variantName} filter${ASAN ? ', ASan+UBSan' : ''})`, { skip: SKIP || (variantName === 'filter' && !existsSync(FILTER_H) ? 'relay-filter.h not present' : false) }, () => {
    let v;
    before(() => {
      v = variants.find((x) => x.name === variantName);
      if (!v) throw new Error('the filter variant needs plugins/vizpane/inline/relay-filter.h');
    });

    test('input goes from the terminal straight to Codex: its stdin is the pane, and a 1 MB paste arrives byte for byte', T, async () => {
      await session(v, { env: { FAKE_TUI_KEYS: '0' } }, async (t) => {
        const r = await t.waitReady();
        assert.equal(r.stdinRdev, statSync(t.ttyPath).rdev, 'Codex\'s stdin is the pane itself');
        assert.notEqual(r.stdoutRdev, r.stdinRdev, 'its stdout is the relay\'s pseudo-terminal');
        const all = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) all[i] = (i * 167 + 13) & 0xff;
        const paste = Buffer.concat([Buffer.from('\x1b[200~'), seeded(1 << 20, 99), Buffer.from('\x1b[201~')]);
        const sent = Buffer.concat([all, paste]);
        t.send(all);
        t.send(paste);
        await until(() => t.inputHex().length >= sent.length * 2, 25000, 'all input in the log');
        assert.equal(t.inputHex(), sent.toString('hex'));
        t.control('QUIT');
        await t.finish();
      });
    });

    test('1 MB of output arrives byte for byte, also when Codex exits right after writing it', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.send('o');
        await t.waitLog(/^PAYLOAD-SENT/, 20000);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
        assert.equal(t.outText, ENTER + payload().toString('latin1') + LEAVE);
      });
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.send('E');
        await t.waitEvent('EXIT 0');
        await t.finish();
        assert.equal(t.outText, ENTER + payload().toString('latin1') + LEAVE);
      });
    });

    test('a slow terminal holds Codex back without losing or reordering anything, and Codex\'s input is unaffected', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.control('PAUSE');
        t.send('o');
        await sleep(600);
        t.send('w');
        t.send('q');
        await sleep(300);
        // Codex is blocked in its write, so it has not seen the keys yet.
        assert.equal(t.logFind(/^PAYLOAD-SENT/), undefined);
        t.control('RESUME');
        await t.waitEvent('EXIT 3', 20000);
        await t.finish();
        assert.equal(t.outText, ENTER + payload().toString('latin1') + LEAVE);
        assert.ok(t.logFind(/^SIZE /), 'the key typed while output was blocked arrived');
      });
    });

    // N13. The pane's SIGWINCH reaches the job at once; a program that asks its stdout for the size (vim) can
    // read the relay's pty before the relay has updated it. The relay sends one more SIGWINCH after it has.
    const resizeRounds = async (variant, rounds) => {
      let good = 0;
      await session(variant, { harnessArgs: ['-s', '100,30,1000,600'], env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        t.send('w');
        await t.waitText('err-same', 0, 5000);
        assert.match(t.outText, /<<W 100 30 \/ 100 30 \/ err-same 1>>/, 'at the start stdout and /dev/tty have the pane\'s size, and stderr is stdout\'s device');
        for (let k = 0; k < rounds; k++) {
          const cols = 101 + k, rows = 30 + (k % 5);
          const pos = t.out.length;
          t.control(`W ${cols} ${rows} ${cols * 10} ${rows * 20}`);
          await sleep(250);
          const reports = [...t.outText.slice(pos).matchAll(/<<WINCH (\d+) (\d+)>>/g)];
          if (reports.length && Number(reports.at(-1)[1]) === cols && Number(reports.at(-1)[2]) === rows) good++;
        }
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      return good;
    };

    test('N13: a child that reads stdout\'s size on SIGWINCH has the right size after each of 20 resizes', T, async () => {
      assert.equal(await resizeRounds(v, 20), 20);
    });

    test('N13 negative control: without the follow-up SIGWINCH the last read is stale', { ...T, skip: variantName !== 'stub' }, async () => {
      const good = await resizeRounds(variants.find((x) => x.name === 'nofollow'), 20);
      assert.ok(good < 20, `the test sees the stale read (right in ${good}/20)`);
    });

    // N13b. vim handles the pane's SIGWINCH, reads stdout's size, and ignores a signal that arrives while it
    // does: a follow-up sent at once is lost, one sent a few tens of ms later is not. The stand-in's V mode
    // reads like that (no timer, 5 ms of work, flag cleared afterwards).
    const vimRounds = async (variant, rounds) => {
      let good = 0;
      await session(variant, { harnessArgs: ['-s', '100,30,1000,600'], env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        t.send('V');
        await t.waitText('<<V>>', 0, 5000);
        for (let k = 0; k < rounds; k++) {
          const cols = 101 + k, rows = 30 + (k % 5);
          const pos = t.out.length;
          t.control(`W ${cols} ${rows} ${cols * 10} ${rows * 20}`);
          await sleep(300);
          const reports = [...t.outText.slice(pos).matchAll(/<<VWINCH (\d+) (\d+)>>/g)];
          if (reports.length && Number(reports.at(-1)[1]) === cols && Number(reports.at(-1)[2]) === rows) good++;
        }
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      return good;
    };

    test('N13b: a reader that handles a SIGWINCH once and ignores one that arrives meanwhile (vim) has the right size after each of 20 resizes', T, async () => {
      assert.equal(await vimRounds(v, 20), 20);
    });

    test('Ctrl+Z: Codex\'s restore bytes arrive before the stop, the tui marker follows its screen, and fg continues it', T, async () => {
      await session(v, { quiet: 1500 }, async (t) => {
        await t.waitReady();
        const running = await t.termios();
        assert.equal(running.l & ICANON, 0, 'raw while running (Codex set it, on the pane)');
        assert.equal(running.l & ECHO, 0);
        await until(() => t.sessionDirs().length === 1, 3000, 'session dir');
        const dir = join(v.sessions, t.sessionDirs()[0]);
        await until(() => existsSync(join(dir, 'tui')), 3000, 'tui marker while the TUI is live');

        t.send('z');
        const stopped = await t.waitEvent('STOPPED');
        assert.equal(stopped.split(' ')[3], String(SIGTSTP), 'the job stops with the signal that stopped Codex');
        const bytes = Number(stopped.split(' ')[1]);
        assert.ok(t.out.subarray(0, bytes).toString('latin1').includes(LEAVE), 'restore bytes before the stop');
        assert.equal(existsSync(join(dir, 'tui')), false, 'tui marker removed when the TUI left bracketed paste');

        t.control('W 77 22 770 440');
        await sleep(100);
        t.control('CONT');
        await t.waitLog(/^CONT/);
        t.send('w');
        assert.equal((await t.waitLog(/^SIZE /)).slice(5), '77 22 770 440', 'Codex sees the new size');
        await until(() => t.outText.split(ENTER).length >= 3, 3000, 'the TUI re-entered');
        await until(() => existsSync(join(dir, 'tui')), 3000, 'tui marker back');

        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    test('ten stop and continue rounds in a row', T, async () => {
      await session(v, { quiet: 200 }, async (t) => {
        await t.waitReady();
        for (let i = 1; i <= 10; i++) {
          t.send('z');
          await until(() => t.events.filter((e) => e.startsWith('STOPPED')).length === i, 5000, `stop ${i}`);
          t.control('CONT');
          await until(() => t.logLines().filter((l) => l === 'CONT').length >= i, 5000, `cont ${i}`);
        }
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    test('an editor child sees the current size', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.control('W 110 33 1100 660');
        await t.waitLog(/^WINCH 110 33/);
        t.send('g');
        await t.waitLog(/^EDITOR-DONE/);
        await until(() => t.outText.includes('EDIT-END'), 3000, 'editor output');
        assert.match(t.outText, /EDIT-BEGIN\n33 110\nEDIT-END/);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    test('exit status 3 is the relay exit status, the session dir exists meanwhile and is removed after', T, async () => {
      await session(v, {}, async (t) => {
        const r = await t.waitReady();
        await until(() => t.sessionDirs().length === 1, 3000, 'session dir');
        const [name] = t.sessionDirs();
        assert.match(name, /^s1-\d+-[0-9a-f]{16}$/);
        assert.equal(name.split('-')[1], String(t.relayPid));
        const dir = join(v.sessions, name);
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.equal(r.dir, dir);
        assert.equal(r.tty, t.ttyPath, 'VIZPANE_TTY is the pane\'s terminal, not the relay\'s pseudo-terminal');
        assert.notEqual(r.pid, t.relayPid);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
        assert.deepEqual(t.sessionDirs(), []);
      });
    });

    test('stale session dirs of dead relays are removed, those of live ones are kept', T, async () => {
      mkdirSync(v.sessions, { recursive: true });
      let dead = 400000;
      while (spawnSync('kill', ['-0', String(dead)]).status === 0) dead++;
      const stale = join(v.sessions, `s1-${dead}-00112233445566aa`);
      const live = join(v.sessions, `s1-${process.pid}-00112233445566bb`);
      const other = join(v.sessions, 'not-a-session');
      for (const d of [stale, live, other]) { mkdirSync(d); writeFileSync(join(d, 'f'), 'x'); }
      await session(v, {}, async (t) => {
        await t.waitReady();
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(live), true);
        assert.equal(existsSync(other), true);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      rmSync(live, { recursive: true });
      rmSync(other, { recursive: true });
    });

    test('Codex dying from SIGTERM kills the relay with SIGTERM', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.send('x');
        await t.waitEvent('SIGNAL 15');
        await t.finish();
        assert.deepEqual(t.sessionDirs(), []);
      });
    });

    test('signals sent to the relay reach Codex: SIGTERM is re-raised, SIGHUP ends the fake TUI', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        process.kill(t.relayPid, 'SIGTERM');
        await t.waitEvent('SIGNAL 15');
        await t.finish();
      });
      await session(v, {}, async (t) => {
        await t.waitReady();
        process.kill(t.relayPid, 'SIGHUP');
        await t.waitLog(/^HUP/);
        await t.waitEvent('EXIT 0');
        await t.finish();
      });
    });

    test('a helper that keeps the terminal open does not delay the relay exit', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.send('l');
        const ev = await t.waitEvent('EXIT 0');
        const exiting = Number((await t.waitLog(/^EXITING /)).slice(8));
        const exitedAt = Number(ev.split(' ')[3]);
        assert.ok(exitedAt - exiting < 200, `relay took ${exitedAt - exiting} ms after Codex exited`);
        await t.finish();
      });
    });


    test('Codex\'s descriptors are the shell\'s, with only its stdout (and stderr, when that was the terminal) replaced', T, async () => {
      let relayed;
      let direct;
      let pane;
      let directPane;
      await session(v, {}, async (t) => {
        relayed = await t.waitReady();
        pane = statSync(t.ttyPath).rdev;
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      await session(v, { env: { VIZPANE_INLINE: 'off' } }, async (t) => {
        const r = await t.waitReady();
        assert.equal(r.pid, t.relayPid, 'the baseline run is exec\'d directly');
        direct = r;
        directPane = statSync(t.ttyPath).rdev;
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      assert.ok(relayed.fds.includes(0) && relayed.fds.includes(1) && relayed.fds.includes(2));
      assert.deepEqual(relayed.fds, direct.fds, 'none of the relay\'s descriptors (pane, master, hold, self-pipe) reaches Codex');
      assert.equal(relayed.stdinRdev, pane);
      // each session has its own pane: a pty number may or may not be reused by the next session
      assert.equal(direct.stdinRdev, directPane);
      assert.equal(direct.stdoutRdev, directPane, 'stock: stdout is the pane');
      assert.notEqual(relayed.stdoutRdev, pane, 'relay: stdout is the pseudo-terminal');
      assert.equal(relayed.stderrTTY, true);
    });

    // Stock Codex blocks in write() while the terminal is busy, however long that takes. A relay that
    // gave up after a while would lose Codex's restore bytes and hang its session up.
    test('a terminal that takes nothing for 3 s while Codex suspends loses nothing and ends nothing', T, async () => {
      await session(v, { quiet: 1500 }, async (t) => {
        await t.waitReady();
        t.control('PAUSE');
        t.send('Z');
        await sleep(3000);
        assert.equal(t.event('STOPPED'), undefined, 'the relay is still waiting for the terminal to take the bytes');
        t.control('RESUME');
        const stopped = await t.waitEvent('STOPPED', 8000);
        assert.equal(stopped.split(' ')[3], String(SIGTSTP), 'stopped by SIGTSTP, as Codex stops itself');
        assert.equal(t.outText, ENTER + payload().subarray(0, SHELL_PAYLOAD).toString('latin1') + LEAVE);
        t.control('CONT');
        await t.waitLog(/^CONT/);
        assert.equal(t.logFind(/^HUP/), undefined, 'Codex was not hung up');
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    test('a terminal that takes nothing for 3 s while Codex exits still gets every byte', T, async () => {
      await session(v, { quiet: 1500 }, async (t) => {
        await t.waitReady();
        t.control('PAUSE');
        t.send('F');
        await sleep(3000);
        assert.equal(t.event('EXIT'), undefined, 'the relay is still waiting for the terminal');
        t.control('RESUME');
        await t.waitEvent('EXIT 0', 8000);
        assert.equal(t.outText, ENTER + payload().subarray(0, SHELL_PAYLOAD).toString('latin1') + LEAVE);
        await t.finish();
      });
    });

    // Codex's write blocks once the inner queue (1 KiB) and the relay's pending output (one chunk, plus what one
    // read can add) are full, so it runs a few KiB ahead of the terminal, not a pty buffer's worth.
    test('Codex runs at most a few KiB ahead of a terminal that is not reading', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        t.control('PAUSE');
        t.send('B');
        await sleep(800);
        const progress = t.logLines().filter((l) => l.startsWith('PROGRESS ')).map((l) => Number(l.slice(9)));
        const ahead = progress.at(-1) ?? 0;
        assert.ok(ahead <= 8192, `Codex completed ${ahead} bytes of writes before it blocked`);
        t.control('RESUME');
        await t.waitLog(/^PROGRESS 1048576$/, 20000);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
        assert.equal(t.outText, ENTER + payload().toString('latin1') + LEAVE);
      });
    });

    // The job is whatever the shell started: here a shell script that forks the relay instead of
    // exec'ing it, like an env-injecting launcher. Codex stops its whole process group with SIGTSTP,
    // and the relay has to do the same or the launcher keeps waiting and the shell never sees a stop.
    test('Ctrl+Z under a launcher that forks: the whole job stops with SIGTSTP and fg continues it', T, async () => {
      await session(v, { quiet: 1500, program: '/bin/sh', args: ['-c', `"${v.relay}"; exit $?`] }, async (t) => {
        await t.waitReady();
        t.send('z');
        const stopped = await t.waitEvent('STOPPED', 5000);
        assert.equal(stopped.split(' ')[3], String(SIGTSTP));
        const kids = spawnSync('pgrep', ['-P', String(t.relayPid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
        assert.equal(kids.length, 1, 'the launcher has the relay as its child');
        const state = spawnSync('ps', ['-o', 'stat=', '-p', kids[0]], { encoding: 'utf8' }).stdout.trim();
        assert.match(state, /^T/, `the relay is stopped (${state})`);
        t.control('CONT');
        await t.waitLog(/^CONT/);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });
    // `kill %1` is SIGTERM and SIGCONT with the shell still in the foreground: the relay wakes up in
    // the background, where changing termios would stop it again, and must pass the SIGTERM on.
    test('kill %1 on a suspended job ends it', T, async () => {
      await session(v, { quiet: 1500 }, async (t) => {
        await t.waitReady();
        t.send('z');
        await t.waitEvent('STOPPED', 5000);
        t.control('KILLJOB');
        await t.waitEvent('SIGNAL 15', 6000);
        assert.equal(t.events.filter((e) => e.startsWith('STOPPED')).length, 1, 'it did not stop a second time');
        await t.finish();
        assert.deepEqual(t.sessionDirs(), []);
      });
    });

    // `bg` continues the job with the shell still owning the terminal. As without a relay, Codex stops again at
    // its first terminal setting (SIGTTOU), and the relay, in the same job, stops with it.
    test('bg on a suspended job: it stops again at the first terminal setting, and fg continues it', T, async () => {
      await session(v, { quiet: 1500, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        t.send('z');
        await t.waitEvent('STOPPED', 5000);
        t.control('BGJOB');
        await sleep(700);
        const stops = t.events.filter((e) => e.startsWith('STOPPED'));
        assert.equal(stops.length, 2, `stopped again (${stops})`);
        assert.equal(stops[1].split(' ')[3], String(SIGTTOU), 'stopped by SIGTTOU, like a background terminal setting');
        assert.equal(t.outText.includes('<<C>>'), false, 'Codex did not finish re-entering raw mode in the background');
        t.control('CONT');
        await t.waitText('<<C>>', 0, 5000);
        t.send('q\r');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    test('a SIGTSTP sent to the relay does not stop the job: Codex keeps running and drawing', T, async () => {
      await session(v, {}, async (t) => {
        await t.waitReady();
        process.kill(t.relayPid, 'SIGTSTP');
        await sleep(500);
        assert.equal(t.event('STOPPED'), undefined);
        t.send('w');
        await t.waitLog(/^SIZE /);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    // -- type-ahead: the shell gets exactly what it gets without a relay ------------------------------------
    //
    // The relay never reads the terminal, so there is nothing to hand back at a stop or an exit. Each scenario
    // runs the C stand-in once directly (stock) and once under the relay and compares what the shell found in the
    // terminal's input afterwards, byte for byte.
    const PASTE = Array.from({ length: 500 }, (_, i) => `b${String(i).padStart(4, '0')}\n`).join('');
    async function typeahead(program, how, key, body) {
      let got;
      await session(v, { quiet: 1500, program, typeahead: true, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        t.send(key);
        await t.waitLog(/^RESTORED/);
        await body(t);
        if (how === 'suspend') {
          await t.waitEvent('STOPPED', 8000);
          await sleep(200);
          t.control('READIN');
          await t.waitEvent('TYPEAHEAD', 8000);
          got = t.typeahead();
          t.control('CONT');
          await t.waitLog(/^CONT/);
          t.send('q');
          await t.waitEvent('EXIT 3');
        } else {
          await t.waitEvent('EXIT 0', 10000);
          await t.waitEvent('TYPEAHEAD', 8000);
          got = t.typeahead();
        }
        await t.finish();
      });
      return got;
    }
    const sameAsStock = async (how, key, body, want) => {
      const stock = await typeahead(standInBin, how, key, body);
      assert.equal(stock, want, 'stock leaves everything typed after the restore to the shell');
      const relayed = await typeahead(undefined, how, key, body);
      assert.equal(relayed, stock, 'the relay changes nothing about what the shell finds');
    };

    test('keys typed after Codex restored the terminal go to the shell, as without the relay', T, async () => {
      const line = 'echo TY\'\'PEAHEAD\n';
      await sameAsStock('exit', 'D', async () => { await sleep(150); }, '');
      await sameAsStock('exit', 'D', async (t) => { await sleep(150); t.send(line); }, line);
    });

    test('keys typed just before a suspend are the shell\'s, not Codex\'s after fg, as without the relay', T, async () => {
      await sameAsStock('suspend', 'Y', async (t) => { await sleep(100); t.send('echo T2\n'); }, 'echo T2\n');
    });

    for (const [key, how] of [['Y', 'suspend'], ['X', 'exit']]) {
      test(`keys typed around the final flush reach the shell in the order typed, as without the relay (${how})`, T, async () => {
        await sameAsStock(how, key, async (t) => {
          t.send('a\n');
          await sleep(150);
          t.control('PAUSE');
          await t.waitLog(/^WRITTEN/, 1500).catch(() => {}); // stock: the stand-in itself is the one blocked
          await sleep(400);
          t.send('b\n');
          await sleep(300);
          t.control('RESUME');
        }, 'a\nb\n');
      });
    }

    // The terminal's input queue holds 1 KiB; a terminal emulator keeps the rest of a longer paste back until the
    // shell reads. Stock Codex never takes those keys off the terminal, and neither does the relay.
    test('a paste over 1 KiB typed while Codex shuts down reaches the shell whole, as without the relay', T, async () => {
      await sameAsStock('exit', 'D', async (t) => { await sleep(100); t.send(PASTE); }, PASTE);
    });

    for (const [key, how] of [['Y', 'suspend'], ['X', 'exit']]) {
      test(`a key and a paste over 1 KiB typed while the terminal is busy stay whole and in order, as without the relay (${how})`, T, async () => {
        await sameAsStock(how, key, async (t) => {
          t.send('a\n');
          await sleep(150);
          t.control('PAUSE');
          await t.waitLog(/^WRITTEN/, 1500).catch(() => {});
          await sleep(400);
          t.send(PASTE);
          await sleep(300);
          t.control('RESUME');
        }, `a\n${PASTE}`);
      });
    }

    // N8. Nothing of what is typed is read by the relay, and the terminal's settings are Codex's own.
    test('N8: the relay never reads keys or touches the terminal settings: 4 KB typed while Codex does not read is all the shell\'s', T, async () => {
      const run = async (program) => {
        let result;
        await session(v, { quiet: 3000, program, typeahead: true, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
          await t.waitReady();
          t.send('p');
          await t.waitLog(/^NOT-READING/);
          t.send(seeded(4096, 7));
          await sleep(400);
          const termios = await t.termios();
          await t.waitEvent('EXIT 0', 8000);
          await t.waitEvent('TYPEAHEAD', 8000);
          result = { termios: termios.raw, queued: t.typeahead() };
          await t.finish();
        });
        return result;
      };
      const stock = await run(standInBin);
      const relayed = await run(undefined);
      assert.equal(stock.queued, seeded(4096, 7).toString('latin1'), 'stock: everything typed is left to the shell');
      assert.equal(relayed.queued, stock.queued, 'relay: the same 4096 bytes, none taken');
      assert.equal(relayed.termios, stock.termios, 'the terminal settings are what Codex set');
    });

    // N7. When the last slave descriptor closes, macOS discards the output nobody has read; the relay keeps its own.
    test('N7: output Codex wrote just before it exited survives a terminal that does not read for a second, and Codex\'s exit is not delayed', T, async () => {
      await session(v, { quiet: 1500, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        const r = await t.waitReady();
        t.control('PAUSE');
        t.send('u');
        const written = Number((await t.waitLog(/^WRITTEN /)).slice(8));
        const goneAt = await until(() => { try { process.kill(r.pid, 0); return false; } catch { return Date.now(); } }, 3000, 'the stand-in to be gone');
        assert.ok(goneAt - written < 300, `the stand-in's exit took ${goneAt - written} ms (about 600 ms if the last slave descriptor closed with output unread)`);
        await sleep(1000);
        t.control('RESUME');
        await t.waitEvent('EXIT 0', 8000);
        await t.finish();
        assert.ok(t.outText.endsWith('U'.repeat(1000)), 'all 1000 bytes arrived');
      });
    });

    // N9. Codex compares stdout and stderr, and keeps stray stderr output off its screen only if they are one file.
    test('N9: stderr follows stdout when it was the terminal, and a redirected stderr stays redirected', T, async () => {
      await session(v, { env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        const pos = await t.afterMarker();
        t.send('a');
        await t.waitLog(/^ABC/);
        await sleep(200);
        assert.equal(t.outText.slice(pos), 'ABC', 'stdout and stderr bytes arrive in the order written');
        t.send('w');
        await t.waitText('err-same', pos, 5000);
        assert.match(t.outText.slice(pos), /err-same 1/, 'Codex\'s stdout and stderr are one device');
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
      const dir = mkdtempSync(join(work, 'err-'));
      const file = join(dir, 'err.txt');
      await session(v, { harnessArgs: ['-e', file], env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        const pos = await t.afterMarker();
        t.send('a');
        await t.waitLog(/^ABC/);
        await sleep(200);
        t.send('e');
        await t.waitLog(/^ERR-WRITTEN/);
        await sleep(200);
        assert.equal(t.outText.slice(pos), 'AC', 'only stdout reaches the terminal');
        assert.equal(readFileSync(file, 'utf8'), 'BERR-LINE\r\n', 'stderr went to the file');
        t.send('w');
        await t.waitText('err-same', pos, 5000);
        assert.match(t.outText.slice(pos), /err-same 0/);
        t.send('q');
        await t.waitEvent('EXIT 3');
        await t.finish();
      });
    });

    // N10. The pane processes output once, when the relay writes it. The relay's own pty is transparent.
    test('N10: output processing is applied once, as without the relay: cooked, raw and an editor that turns it off', T, async () => {
      const run = async (program, key) => {
        let seen;
        await session(v, { program, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
          await t.waitReady();
          const pos = await t.afterMarker();
          t.send(key);
          await t.waitLog(/WRITTEN$/, 4000);
          await sleep(400);
          seen = t.outText.slice(pos);
          t.send('q');
          await t.waitEvent('EXIT 3');
          await t.finish();
        });
        return seen;
      };
      for (const [key, want] of [['c', 'L1\r\nL2\r\n'], ['r', 'R1\r\nR2\r\n'], ['v', 'E1\nE2\n']]) {
        const stock = await run(standInBin, key);
        const relayed = await run(undefined, key);
        assert.ok(stock.startsWith(want), `stock: ${JSON.stringify(stock)}`);
        assert.equal(relayed, stock, `key ${key}: identical to stock`);
      }
    });

    // N11. If the relay itself is killed, nothing restores the terminal (the shell gets it back at once and Codex
    // ends at its next read). The terminal settings are whatever Codex had set, as when Codex itself is killed.
    test('N11: SIGKILL of the relay, running or stopped: prompt at once, nothing written afterwards, Codex gone within 1 s, settings as after a stock SIGKILL', T, async () => {
      const run = async (stopped, relayed) => {
        let termios;
        await session(v, { quiet: 4000, program: relayed ? undefined : standInBin, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
          const r = await t.waitReady();
          if (stopped) {
            t.send('z');
            await t.waitEvent('STOPPED', 5000);
          }
          // stopped: the relay wrote out everything before it stopped; running: wait for the start-up marker's last byte
          const before = stopped ? t.out.length : await t.afterMarker();
          process.kill(relayed ? t.relayPid : r.pid, 'SIGKILL');
          await t.waitEvent('SIGNAL 9', 5000);
          await until(() => { try { process.kill(r.pid, 0); return false; } catch { return true; } }, 1500, 'Codex to be gone within 1 s');
          await sleep(600);
          assert.equal(t.out.subarray(before).toString('latin1'), '', 'nothing was written to the terminal after the kill');
          termios = (await t.termios()).raw;
          await t.finish();
        });
        return termios;
      };
      for (const stopped of [false, true]) {
        const baseline = await run(stopped, false);
        assert.equal(await run(stopped, true), baseline, `the terminal settings are Codex's own (${stopped ? 'stopped' : 'running'})`);
      }
    });

    // N12. A budget, not a race: 5 MiB to a terminal that reads at full speed.
    test('N12: 5 MiB of output to a terminal that reads at full speed takes at most 5 times what stock takes', { ...T, skip: ASAN ? 'timing under the sanitizers means nothing' : false }, async () => {
      const run = async (program) => {
        let ms;
        await session(v, { quiet: 600, program, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
          await t.waitReady();
          t.send('T');
          await t.waitLog(/^DONE /, 30000);
          const start = Number(t.logFind(/^START /).slice(6)), done = Number(t.logFind(/^DONE /).slice(5));
          ms = done - start;
          t.send('q');
          await t.waitEvent('EXIT 3');
          await t.finish();
          assert.ok(t.out.length > 5 * 1024 * 1024, 'all of it arrived');
        });
        return ms;
      };
      const stock = [], relayed = [];
      for (let i = 0; i < 3; i++) { stock.push(await run(standInBin)); relayed.push(await run(undefined)); }
      const med = (a) => [...a].sort((x, y) => x - y)[1];
      console.log(`# 5 MiB: stock ${stock.join('/')} ms, relay ${relayed.join('/')} ms (${variantName})`);
      assert.ok(med(relayed) <= 5 * Math.max(med(stock), 60), `relay median ${med(relayed)} ms against stock ${med(stock)} ms`);
    });

    // N14. The pane goes away while Codex streams: the relay keeps reading so Codex is never stuck in a write.
    test('N14: when the terminal hangs up while Codex streams, the relay keeps draining and both end, with Codex\'s status', T, async () => {
      await session(v, { quiet: 1500, env: { VIZPANE_REAL_CODEX: standInBin } }, async (t) => {
        await t.waitReady();
        t.control('SLOW 256 500');
        t.send('S');
        await sleep(300);
        t.control('HANGUP');
        // Codex sees the SIGHUP or the end of its input first, whichever the kernel delivers; either way it
        // ends, and the relay's status is its status
        await until(() => t.event('SIGNAL 1') || t.event('EXIT 0'), 10000, 'the job to end');
        await t.finish();
        assert.deepEqual(t.sessionDirs(), []);
      });
    });

    // N1. Another writer to the pane (Codex's OSC 52 clipboard copy goes straight to /dev/tty) lands only between
    // whole items of the relayed stream. The receiving side runs an independent reference lexer (not the filter): it
    // takes each foreign sequence out of the stream and asks whether the rest is at a ground point there, and not
    // between a character and the combining marks that follow it.
    const OSC = '\x1b]52;c;';
    const B64 = /[A-Za-z0-9+/]/;
    function landings(text) {
      let rest = '';
      let i = 0, seen = 0, cut = 0;
      const marks = [];
      for (;;) {
        const j = text.indexOf(OSC, i);
        if (j < 0) { rest += text.slice(i); break; }
        rest += text.slice(i, j);
        let k = j + OSC.length;
        while (k < text.length && B64.test(text[k])) k++;
        marks.push(rest.length);
        seen++;
        if (text[k] === '\x07') i = k + 1;
        else { cut++; i = k; }   // something else came before its BEL: the foreign write was cut
      }
      const bytes = Buffer.from(rest, 'latin1');
      const ref = lex(bytes);
      let bad = 0, parted = 0;
      for (const m of marks) {
        if (!ref.ground[m]) bad++;
        else if (m < bytes.length && (bytes[m] === 0xcc || bytes[m] === 0xcd)) parted++;
      }
      return { seen, cut, bad, parted };
    }

    const foreign = async (program, size, count = 150) => {
      const log = join(mkdtempSync(join(work, 'wlog-')), 'relay.log');
      let result;
      await session(v, { program, quiet: 600, env: { VIZPANE_REAL_CODEX: standInBin, VIZPANE_RELAY_LOG: log } }, async (t) => {
        const r = await t.waitReady();
        if (r.dir) {
          // the picture the hook would have rendered for the placeholder rows, so transmits are inserted too
          writeFileSync(join(r.dir, '123456.png'), makePng(40, 20));
          writeFileSync(join(r.dir, '123456.cr'), '40 10\n');
        }
        const pos = await t.afterMarker();
        t.control('SLOW 1024 200');
        const writer = spawn(writerBin, [t.ttyPath, String(size), String(count), '1500'], { stdio: 'inherit' });
        const done = new Promise((resolve) => writer.on('close', resolve));
        t.send('S');
        await t.waitLog(/^STREAMED/, 60000);
        await Promise.race([done, sleep(30000)]);
        writer.kill('SIGKILL');
        await sleep(300);
        t.control('SLOW 0 0');
        const text = t.outText.slice(pos);
        t.send('q');
        await t.waitEvent('EXIT 3', 10000);
        await t.finish();
        result = { ...landings(text), transmits: text.split('\x1b_Ga=T,U=1').length - 1 };
        if (program === undefined && existsSync(log)) {
          const m = /partials=(\d+)/.exec(readFileSync(log, 'utf8'));
          result.partials = m ? Number(m[1]) : null;
        }
      });
      return result;
    };

    test('N1: another writer to the pane lands only between whole items of the relayed stream', { timeout: 120000, skip: variantName !== 'filter' ? 'needs the real filter: the stub does not track sequences' : false }, async () => {
      const lines = [];
      for (const size of [64, 128, 256, 500, 700]) {
        const r = await foreign(undefined, size);
        lines.push(`${size}: foreign writes seen ${r.seen}, cut ${r.cut}, landed inside ${r.bad}, parted a combining mark ${r.parted}, partial relay writes ${r.partials}, transmits ${r.transmits}`);
        assert.ok(r.seen >= 100, `${size}: the writer got its writes in (${r.seen})`);
        assert.ok(r.transmits >= 1, 'the filter inserted its transmit while the other writer was at it');
        if (size <= 500) {
          assert.equal(r.bad, 0, `${size}: foreign sequences inside a sequence or character of the relayed stream`);
          assert.equal(r.parted, 0, `${size}: foreign sequences between a character and its combining marks`);
        } else {
          // A foreign write larger than the free space of the pane's queue is split by the kernel, and a relay write
          // that finds the room taken is partial; only then can a foreign sequence land inside the relayed stream.
          assert.ok(r.bad + r.parted <= r.partials, `${size}: ${r.bad + r.parted} landings inside, but only ${r.partials} partial relay writes`);
        }
        if (size <= 256) {
          assert.equal(r.cut, 0, `${size}: foreign writes cut by the relay`);
          assert.equal(r.partials, 0, `${size}: partial relay writes`);
        }
      }
      console.log(`# N1 (${variantName}): ${lines.join('; ')}`);
    });

    test('N1 negative control: without the relay the same writer lands inside the stream', { timeout: 150000, skip: variantName !== 'stub' }, async () => {
      // The landing depends on timing: single runs saw 0 to 25 of 150, and one saw none. A control that
      // may legitimately miss is repeated, up to five runs; it still fails when the failure never shows.
      let r;
      for (let attempt = 1; attempt <= 5; attempt++) {
        r = await foreign(standInBin, 256);
        console.log(`# N1 stock (run ${attempt}): foreign writes seen ${r.seen}, cut ${r.cut}, landed inside ${r.bad}, parted a combining mark ${r.parted}`);
        if (r.bad + r.cut > 0) break;
      }
      assert.ok(r.bad + r.cut > 0, 'the test sees the failure it looks for');
    });

    // -- a real interactive zsh: job control as the user sees it ------------------------------------------------

    const zskip = { ...TZ, skip: SKIP_ZSH };
    const none = (t) => t.running().filter((l) => !l.includes('/bin/zsh')).length === 0;
    // the stand-in's quit: its last bytes, then the prompt, then its status
    // (a stand-in continued in the background and then in the foreground is left in a cooked terminal, as the
    // stock one is, because its tcsetattr from the background is interrupted: its key needs a newline then)
    const quit = async (t, cooked = false) => {
      const pos = t.out.length;
      t.send(cooked ? 'q\r' : 'q');
      const iq = await t.waitText('<<Q>>', pos);
      const ip = await t.prompt(iq);
      const pos2 = t.out.length;
      t.type('echo rc=$?');
      await t.waitText('rc=3', pos2);
      assert.ok(iq < ip, 'Codex\'s last bytes come before the shell\'s prompt');
    };
    // one Ctrl+Z, `fg` round; returns whether the stand-in's restore marker was seen before the shell's report
    const suspendRound = async (t, slow) => {
      const pos = t.out.length;
      if (slow) t.control('SLOW 256 2000');
      t.send('z');
      const sus = await t.waitText('suspended', pos, 30000);
      const ir = t.outText.indexOf('<<R>>', pos);
      await t.prompt(sus);
      t.control('SLOW 0 0');
      const pos2 = t.out.length;
      t.type('fg');
      await t.waitText('<<C>>', pos2);
      return ir >= 0 && ir < sus;
    };

    // N3. Ctrl+Z and fg with the terminal reading slowly: Codex's restore bytes reach the terminal before the
    // shell reports the stop, because the relay stops only after it has written out everything Codex wrote.
    test('N3: real zsh, Ctrl+Z and fg ten times with a slow terminal: the restore bytes come before "suspended" every time', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        let ok = 0;
        for (let i = 0; i < 10; i++) if (await suspendRound(t, true)) ok++;
        assert.equal(ok, 10, `restore marker before the shell's report in ${ok}/10 rounds`);
        await quit(t);
      });
    });

    test('N3 negative control: a relay that stops without draining fails at least one round', { ...zskip, skip: SKIP_ZSH || variantName !== 'stub' }, async () => {
      await zsh(variants.find((x) => x.name === 'nodrain'), {}, async (t) => {
        await t.start(t.v.relay);
        let ok = 0;
        for (let i = 0; i < 10; i++) if (await suspendRound(t, true)) ok++;
        assert.ok(ok < 10, `the test sees the late restore bytes (right in ${ok}/10 rounds)`);
      });
    });

    test('a launcher that leaves SIGCHLD blocked: Codex\'s exit still ends the relay and the shell gets its prompt', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(`${blockBin} 20 -- ${v.relay}`);
        await quit(t);
      });
    });

    test('N3b: real zsh, bg: "suspended (tty output)", nothing redrawn before fg, the redraw after it', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        let pos = t.out.length;
        t.send('z');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('bg');
        await t.prompt(await t.waitText('suspended (tty output)', pos));
        await sleep(500);
        assert.equal(t.outText.indexOf('<<C>>', pos), -1, 'no redraw marker before fg');
        pos = t.out.length;
        t.type('fg');
        await t.waitText('<<C>>', pos);
        await quit(t, true);
      });
    });

    test('N3c: real zsh, kill %1 on a stopped job: "terminated", nothing left running', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        let pos = t.out.length;
        t.send('z');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('kill %1');
        await t.prompt(await t.waitText('terminated', pos));
        await sleep(300);
        assert.ok(none(t), `left running: ${t.running()}`);
      });
    });

    test('N3d: real zsh, exit twice with a stopped job: zsh ends and nothing is left running', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        let pos = t.out.length;
        t.send('z');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('exit');
        await t.prompt(await t.waitText('suspended jobs', pos));
        t.type('exit');
        await t.waitEvent('EXIT', 8000);
        await sleep(500);
        assert.ok(none(t), `left running: ${t.running()}`);
      });
    });

    test('N3e: real zsh, Codex exits: its last bytes come before the prompt, and $? is its status', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        await quit(t);
      });
    });

    // The stock `codex` is a /bin/sh script that runs node as a child, which execs the native Codex: the relay's
    // child is a shell and the program that draws is its child, all in one process group.
    test('N3f: real zsh, Codex behind a forking /bin/sh launcher: Ctrl+Z, fg and exit work as above', zskip, async () => {
      const shim = join(mkdtempSync(join(work, 'shim-')), 'codex');
      writeFileSync(shim, `#!/bin/sh\n"${standInBin}" "$@"\nexit $?\n`);
      chmodSync(shim, 0o755);
      await zsh(v, { env: { VIZPANE_REAL_CODEX: shim } }, async (t) => {
        await t.start(v.relay);
        assert.equal(await suspendRound(t, false), true);
        assert.equal(await suspendRound(t, false), true);
        await quit(t);
      });
    });

    // N4. A cooked terminal and a program that is not Codex: the relay behaves as the program does without it.
    test('N4: real zsh, a program in a cooked terminal: Ctrl+C gives 130, Ctrl+Z suspends and fg ends it with 0, as without the relay', zskip, async () => {
      const run = async (prefix) => {
        let c, z;
        await zsh(v, { env: { VIZPANE_REAL_CODEX: '/bin/sleep' } }, async (t) => {
          await t.prompt();
          let pos = t.out.length;
          t.type(`${prefix} 3`);
          await sleep(800);
          t.send('\x03');
          await t.prompt(pos + 20);
          pos = t.out.length;
          t.type('echo rc=$?');
          c = (await until(() => /rc=(\d+)/.exec(t.outText.slice(pos + 12))?.[1], 5000, 'rc')).toString();
          pos = t.out.length;
          t.type(`${prefix} 2`);
          await sleep(800);
          t.send('\x1a');
          await t.prompt(await t.waitText('suspended', pos));
          pos = t.out.length;
          t.type('fg');
          await t.prompt(pos + 5);
          pos = t.out.length;
          t.type('echo rc=$?');
          z = (await until(() => /rc=(\d+)/.exec(t.outText.slice(pos + 12))?.[1], 5000, 'rc')).toString();
        });
        return { c, z };
      };
      const stock = await run('/bin/sleep');
      const relayed = await run(v.relay);
      assert.deepEqual(stock, { c: '130', z: '0' });
      assert.deepEqual(relayed, stock);
    });

    // N5. A signal sent to the relay's pid alone reaches Codex, and the shell sees how the job ended.
    test('N5: real zsh, SIGTERM to the relay\'s pid only: "terminated", nothing left running', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        const kids = spawnSync('pgrep', ['-P', String(t.relayPid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
        assert.equal(kids.length, 1, 'the relay is the shell\'s only child');
        const pos = t.out.length;
        process.kill(Number(kids[0]), 'SIGTERM');
        await t.prompt(await t.waitText('terminated', pos));
        await sleep(300);
        assert.ok(none(t), `left running: ${t.running()}`);
      });
    });

    // N6. fg after bg must not stop the job again, and Codex must be reading keys.
    test('N6: real zsh, Ctrl+Z, bg, fg: no "suspended" after fg, and Codex reads keys', zskip, async () => {
      await zsh(v, {}, async (t) => {
        await t.start(v.relay);
        let pos = t.out.length;
        t.send('z');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('bg');
        await t.prompt(await t.waitText('suspended (tty output)', pos));
        pos = t.out.length;
        t.type('fg');
        await t.waitText('<<C>>', pos);
        await sleep(700);
        assert.equal(t.outText.indexOf('suspended', pos), -1, 'no stop after fg');
        const pos2 = t.out.length;
        t.send('w\r');
        await t.waitText('err-same', pos2, 5000);
        await quit(t, true);
      });
    });

    // P5. A job that is stopped, continued in the background and then in the foreground, stopped again and
    // killed. The program behind a /bin/sh launcher (as the real Codex is) touches the terminal once while it
    // dies. Without a relay the launcher's death orphans the process group, so that touch fails with EIO and
    // nothing is left. With one, the group is not orphaned while the relay lives: the touch becomes a
    // group-wide SIGTTIN, and a relay that stops on it (the default action) is left stopped with nobody to
    // continue it. The relay must stop only when its child is observably stopped, and leave when it is gone.
    const launcher = (name) => {
      const shim = join(mkdtempSync(join(work, `${name}-`)), 'codex');
      writeFileSync(shim, `#!/bin/sh\n"${standInBin}" "$@"\nexit $?\n`);
      chmodSync(shim, 0o755);
      return shim;
    };
    const jobStatuses = (text) => text.replace(/\r/g, '').split('\n').filter((l) => /\[1\]/.test(l))
      .map((l) => (l.match(/(running|continued|suspended \(tty (?:input|output)\)|suspended|terminated|done|exit \d+)/) ?? ['?'])[0]);
    // Ctrl+Z, optionally bg and fg, Ctrl+Z, kill %1; returns the shell's job reports after the kill
    const p5 = async (t, cmd, cycle) => {
      await t.start(cmd);
      let pos = t.out.length;
      t.send('z');
      await t.prompt(await t.waitText('suspended', pos));
      if (cycle) {
        pos = t.out.length;
        t.type('bg');
        await t.prompt(await t.waitText('suspended (tty output)', pos));
        pos = t.out.length;
        t.type('fg');
        await t.waitText('<<C>>', pos);
        await sleep(300);
        // the stand-in is left in a cooked terminal after a bg, as the stock one is: its key needs a newline
        pos = t.out.length;
        t.send('z\r');
        await t.prompt(await t.waitText('suspended', pos));
      }
      pos = t.out.length;
      t.type('kill %1');
      await t.waitText('terminated', pos, 6000).catch(() => {});
      await sleep(1200);
      return { statuses: jobStatuses(t.outText.slice(pos)), left: t.running().filter((l) => !l.includes('/bin/zsh')) };
    };
    for (const cycle of [true, false]) {
      test(`P5${cycle ? 'a' : 'b'}: real zsh, Ctrl+Z, ${cycle ? 'bg, fg, Ctrl+Z, ' : ''}kill %1, a program that touches the terminal as it dies: the shell reports what it reports without the relay, nothing is left`, zskip, async () => {
        const shim = launcher('p5');
        const env = { VIZPANE_REAL_CODEX: shim, XP5_TERMREAD: '1' };
        let direct;
        await zsh(v, { env }, async (t) => { direct = await p5(t, shim, cycle); });
        assert.deepEqual(direct.statuses.slice(-1), ['terminated'], `the baseline: ${JSON.stringify(direct)}`);
        assert.deepEqual(direct.left, [], 'the baseline leaves nothing');
        let relayed;
        await zsh(v, { env }, async (t) => { relayed = await p5(t, v.relay, cycle); });
        assert.deepEqual(relayed.statuses, direct.statuses, `shell reports: ${JSON.stringify(relayed)}`);
        assert.deepEqual(relayed.left, [], `left running: ${relayed.left}`);
      });
    }

    // P5c. With `stty tostop` the relay's own write to the pane from the background is a terminal-output
    // access: it must stop the job as it would stop any program ("suspended (tty output)"), once, without a
    // loop of interrupted writes, and `fg` must carry on with the lines it was holding. The stand-in never
    // reads stdin and keeps the terminal settings, so nothing but the relay touches the pane.
    test('P5c: real zsh, stty tostop, bg: the relay stops with "suspended (tty output)", does not spin, and fg resumes it', zskip, async () => {
      const cpuSeconds = (pid) => {
        const o = spawnSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        const m = o.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
        return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
      };
      const stateOf = (pid) => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      await zsh(v, { env: { XP5_NOREAD: '1' } }, async (t) => {
        await t.prompt();
        let pos = t.out.length;
        t.type('stty tostop');
        await t.prompt(pos);
        await t.start(v.relay);
        await sleep(300);
        pos = t.out.length;
        t.send('\x1a');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('bg');
        await t.prompt(await t.waitText('suspended (tty output)', pos));
        const kids = spawnSync('pgrep', ['-P', String(t.relayPid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
        assert.equal(kids.length, 1, 'the relay is the shell\'s only child');
        const relay = Number(kids[0]);
        const c0 = cpuSeconds(relay);
        await sleep(1500);
        assert.match(stateOf(relay), /^T/, 'the relay itself is stopped, not looping');
        const used = cpuSeconds(relay) - c0;
        assert.ok(used < 0.1, `the relay used ${used} s of CPU in 1.5 s while stopped`);
        pos = t.out.length;
        t.type('fg');
        await t.waitText('tick', pos, 5000);
        await sleep(300);
        assert.equal(t.outText.indexOf('suspended', pos), -1, 'no stop after fg');
        pos = t.out.length;
        t.send('\x03');
        await t.prompt(pos);
        await sleep(300);
        assert.ok(none(t), `left running: ${t.running()}`);
      });
    });

    // P5g (a known difference, pinned as it is today). Ctrl+Z, bg, fg with a program that follows Codex 0.169.0's order on
    // resume: its screen modes are written to stdout first, then raw mode is set with tcsetattr, whose interruption it
    // does not retry. Without `stty tostop` the stock program's write passes in the background and its tcsetattr is
    // the first access that stops it, so after fg it is left cooked (macOS's default; Codex's own behaviour). With
    // `stty tostop` the stock program's write is what stops it, its tcsetattr then runs in the foreground, and it
    // comes back raw. Behind the relay the program's stdout is the relay's pseudo-terminal, which is not its
    // controlling terminal, so tostop does not stop that write and the program is cooked after fg, as stock is
    // without tostop. If this test fails because the relayed program is now raw, the difference has gone away:
    // turn the relay's expectation around and take the known difference out of the README, the setup guide, how-it-works
    // and the changelog. If it fails the other way, stock Codex's behaviour changed; check its resume order again.
    test('P5g: real zsh, Ctrl+Z, bg, fg with a Codex-order stand-in: stock is raw with `stty tostop` and cooked without, the relay is cooked in both', zskip, async () => {
      const shim = launcher('p5g');
      const round = async (cmd, tostop) => {
        let res;
        await zsh(v, { env: { VIZPANE_REAL_CODEX: shim } }, async (t) => {
          await t.prompt();
          let pos = t.out.length;
          if (tostop) {
            t.type('stty tostop');
            await t.prompt(pos);
          }
          await t.start(cmd);
          await sleep(300);
          pos = t.out.length;
          t.send('z');
          await t.prompt(await t.waitText('suspended', pos));
          pos = t.out.length;
          t.type('bg');
          await t.waitText('suspended (tty', pos);
          await sleep(400);
          pos = t.out.length;
          t.type('fg');
          await t.waitText('<<C>>', pos);
          await sleep(300);
          const { l } = await t.termios();
          res = { canon: (l & 0x100) !== 0, echo: (l & 0x8) !== 0 };
          // cooked input needs the newline; raw input would pass the carriage return to the shell, which is harmless
          await quit(t, true);
        });
        return res;
      };
      const stockTostop = await round(shim, true);
      const relayTostop = await round(v.relay, true);
      const stockPlain = await round(shim, false);
      const relayPlain = await round(v.relay, false);
      assert.deepEqual(stockTostop, { canon: false, echo: false }, `stock with tostop comes back raw: ${JSON.stringify(stockTostop)}`);
      assert.deepEqual(relayTostop, { canon: true, echo: true }, `relay with tostop comes back cooked (known difference): ${JSON.stringify(relayTostop)}`);
      assert.deepEqual(stockPlain, { canon: true, echo: true }, `stock without tostop comes back cooked: ${JSON.stringify(stockPlain)}`);
      assert.deepEqual(relayPlain, { canon: true, echo: true }, `relay without tostop comes back cooked, as stock: ${JSON.stringify(relayPlain)}`);
    });

    // P5d/P5e. With `stty tostop`, a job that stopped on its own refused background write must still die
    // of `kill %1`. Stock: the stopped writer has SIGTERM pending and dies of it at the continue, before
    // it retries its write. A relay that went back to writing, with the child already dead but not yet
    // reaped, was refused again and stopped again, on every kill. The child must stop with the group's
    // SIGTTOU like any writer, and the relay must follow that stop and then the child's death.
    for (const [name, env, key, what] of [
      ['P5d', { XP5_NOREAD: '1' }, '\x1a', 'a program that only writes (the relay carries every line)'],
      ['P5e', {}, 'z', 'a raw-mode program whose resume bytes are carried in the background'],
    ]) {
      test(`${name}: real zsh, stty tostop, Ctrl+Z, bg, kill %1, ${what}: "terminated", nothing is left`, zskip, async () => {
        const run = async (t, cmd) => {
          await t.prompt();
          let pos = t.out.length;
          t.type('stty tostop');
          await t.prompt(pos);
          await t.start(cmd);
          await sleep(300);
          pos = t.out.length;
          t.send(key);
          await t.prompt(await t.waitText('suspended', pos));
          pos = t.out.length;
          t.type('bg');
          await t.prompt(await t.waitText('suspended (tty output)', pos));
          pos = t.out.length;
          t.type('kill %1');
          await t.waitText('terminated', pos, 6000).catch(() => {});
          await sleep(1200);
          return { statuses: jobStatuses(t.outText.slice(pos)), left: t.running().filter((l) => !l.includes('/bin/zsh')) };
        };
        let direct;
        await zsh(v, { env }, async (t) => { direct = await run(t, standInBin); });
        assert.deepEqual(direct.statuses.slice(-1), ['terminated'], `the baseline: ${JSON.stringify(direct)}`);
        assert.deepEqual(direct.left, [], 'the baseline leaves nothing');
        let relayed;
        await zsh(v, { env }, async (t) => { relayed = await run(t, v.relay); });
        assert.deepEqual(relayed.statuses.slice(-1), ['terminated'], `shell reports: ${JSON.stringify(relayed)}`);
        assert.deepEqual(relayed.left, [], `left running: ${relayed.left}`);
      });
    }

    // P5f. The bytes the relay itself still owes after its child is gone (the delete commands for the
    // pictures on the main screen) are written from a background group under TOSTOP. Stock has nothing
    // left to write: the program died of kill %1 before it wrote. Nothing may keep the relay alive.
    test('P5f: real zsh, stty tostop, a picture on the main screen, Ctrl+Z, kill %1: "terminated", nothing is left', { ...zskip, skip: SKIP_ZSH || (variantName !== 'filter' ? 'needs the real filter: the stub inserts and deletes nothing' : false) }, async () => {
      await zsh(v, { env: { XP5_MAIN: '1' } }, async (t) => {
        await t.prompt();
        let pos = t.out.length;
        t.type('stty tostop');
        await t.prompt(pos);
        await t.start(v.relay);
        writeFileSync(join(t.ready().dir, '123456.png'), makePng(40, 20));
        writeFileSync(join(t.ready().dir, '123456.cr'), '6 2\n');
        pos = t.out.length;
        t.send('i');
        await t.waitText('<<PIC>>', pos);
        assert.ok(t.outText.slice(pos).includes('\x1b_Ga=T'), 'the picture was transmitted');
        await sleep(200);
        pos = t.out.length;
        t.send('z');
        await t.prompt(await t.waitText('suspended', pos));
        pos = t.out.length;
        t.type('kill %1');
        await t.waitText('terminated', pos, 6000).catch(() => {});
        await sleep(1200);
        assert.deepEqual(jobStatuses(t.outText.slice(pos)).slice(-1), ['terminated'], `shell reports: ${JSON.stringify(jobStatuses(t.outText.slice(pos)))}`);
        assert.deepEqual(t.running().filter((l) => !l.includes('/bin/zsh')), [], 'nothing is left running');
      });
    });

    test('Codex sees the environment it would see without the relay, plus the two variables it adds', T, async () => {
      let direct;
      let relayed;
      let pane;
      await session(v, { program: fakeBin, env: { FAKE_TUI_AUTOEXIT: '1' } }, async (t) => {
        direct = (await t.waitReady()).env;
        await t.waitEvent('EXIT 0');
        await t.finish();
      });
      await session(v, { env: { FAKE_TUI_AUTOEXIT: '1' } }, async (t) => {
        relayed = (await t.waitReady()).env;
        pane = t.ttyPath;
        await t.waitEvent('EXIT 0');
        await t.finish();
      });
      assert.ok(relayed.VIZPANE_INLINE_DIR && relayed.VIZPANE_TTY);
      assert.equal(relayed.VIZPANE_TTY, pane, 'VIZPANE_TTY is the pane\'s terminal');
      delete relayed.VIZPANE_INLINE_DIR;
      delete relayed.VIZPANE_TTY;
      delete relayed.FAKE_TUI_LOG;
      delete direct.FAKE_TUI_LOG;
      assert.deepEqual(relayed, direct);
    });

    // -- gating ------------------------------------------------------------

    const direct = [
      ['stdin is not a terminal', { harnessArgs: ['-i'] }],
      ['stdout is not a terminal', { harnessArgs: ['-o'] }],
      ['exec', { args: ['exec', 'hi'] }],
      ['e', { args: ['e', 'hi'] }],
      ['review', { args: ['review'] }],
      ['queue', { args: ['queue', 'a message'] }],
      ['a job in the background', { harnessArgs: ['-b'] }],
      ['login', { args: ['login'] }],
      ['mcp', { args: ['mcp', 'list'] }],
      ['doctor', { args: ['doctor'] }],
      ['--version', { args: ['--version'] }],
      ['-h', { args: ['-h'] }],
      ['--help after resume', { args: ['resume', '--help'] }],
      ['options with values before exec', { args: ['--enable', 'hooks', '-c', 'x=y', '--dangerously-bypass-hook-trust', 'exec', 'p'] }],
      ['TMUX', { env: { TMUX: '1' } }],
      ['TMUX_PANE (Codex takes it for tmux)', { env: { TMUX_PANE: '%0' } }],
      ['ZELLIJ', { env: { ZELLIJ: '0' } }],
      ['GNU screen (STY)', { env: { STY: '1234.pts-0.host', TERM: 'screen-256color' } }],
      ['TERM=screen', { env: { TERM: 'screen' } }],
      ['TERM=tmux-256color', { env: { TERM: 'tmux-256color' } }],
      ['a Vim terminal', { env: { VIM_TERMINAL: '901' } }],
      ['a Neovim terminal', { env: { NVIM: '/tmp/nvim.sock' } }],
      ['an Emacs terminal', { env: { INSIDE_EMACS: '29.1,vterm' } }],
      ['a JetBrains terminal', { env: { TERMINAL_EMULATOR: 'JetBrains-JediTerm' } }],
      ['NO_COLOR', { env: { NO_COLOR: '1' } }],
      ['VIZPANE_INLINE=off', { env: { VIZPANE_INLINE: 'off' } }],
      ['CODEX_THREAD_ID', { env: { CODEX_THREAD_ID: 'x' } }],
      ['no CMUX_SURFACE_ID', { env: { CMUX_SURFACE_ID: null } }],
      ['TERM_PROGRAM is not ghostty', { env: { TERM_PROGRAM: 'xterm' } }],
      ['SSH_CONNECTION (Codex writes OSC 52 to the terminal there)', { env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' } }],
      ['SSH_TTY', { env: { SSH_TTY: '/dev/ttys099' } }],
      ['HERDR_ENV=1', { env: { HERDR_ENV: '1' } }],
    ];
    for (const [name, opts] of direct) {
      test(`gating: ${name} runs the real Codex directly, with no relay process`, T, async () => {
        await session(v, { ...opts, env: { FAKE_TUI_AUTOEXIT: '1', ...opts.env } }, async (t) => {
          const r = await t.waitReady();
          await t.waitEvent('EXIT 0');
          assert.equal(r.pid, t.relayPid, 'the fake TUI replaced the relay process');
          assert.deepEqual(r.argv, opts.args ?? []);
          assert.equal(r.dir, null);
          assert.deepEqual(t.sessionDirs(), []);
          await t.finish();
        });
      });
    }

    const relayed = [
      ['no arguments', {}],
      ['a prompt', { args: ['write a test'] }],
      ['resume', { args: ['resume', 'abc'] }],
      ['fork', { args: ['fork', '--last'] }],
      ['injected options before resume', { args: ['--enable', 'hooks', '-c', 'hooks.Stop=[{}]', 'resume', 'abc'] }],
      ['a value that looks like a subcommand', { args: ['-m', 'exec'] }],
      ['a prompt after --', { args: ['--', 'exec'] }],
      ['an empty NO_COLOR', { env: { NO_COLOR: '' } }],
      ['HERDR_ENV=0', { env: { HERDR_ENV: '0' } }],
    ];
    for (const [name, opts] of relayed) {
      test(`gating: ${name} goes through the relay`, T, async () => {
        await session(v, { ...opts, env: { FAKE_TUI_AUTOEXIT: '1', ...opts.env } }, async (t) => {
          const r = await t.waitReady();
          await t.waitEvent('EXIT 0');
          assert.notEqual(r.pid, t.relayPid, 'a relay process sits above the fake TUI');
          assert.deepEqual(r.argv, opts.args ?? []);
          assert.ok(r.dir && r.dir.startsWith(v.sessions));
          await t.finish();
          assert.deepEqual(t.sessionDirs(), []);
        });
      });
    }

    test('gating: a relay above this one already owns the terminal', T, async () => {
      await session(v, { env: { FAKE_TUI_AUTOEXIT: '1', VIZPANE_INLINE_DIR: '/nonexistent/outer-relay' } }, async (t) => {
        const r = await t.waitReady();
        await t.waitEvent('EXIT 0');
        assert.equal(r.pid, t.relayPid, 'no second relay');
        assert.equal(r.dir, '/nonexistent/outer-relay', 'the outer relay\'s directory is untouched');
        assert.deepEqual(t.sessionDirs(), []);
        await t.finish();
      });
    });

    test('a setup failure falls back to the real Codex', T, async () => {
      const root = mkdtempSync(join(work, 'bad-'));
      mkdirSync(join(root, 'relay'));
      const relay = join(root, 'relay/codex');
      copyFileSync(v.relay, relay);
      chmodSync(relay, 0o755);
      writeFileSync(join(root, 'inline'), 'a file where the state dir should be');
      await session({ ...v, relay, sessions: join(root, 'inline/sessions') },
        { env: { FAKE_TUI_AUTOEXIT: '1' }, program: relay }, async (t) => {
          const r = await t.waitReady();
          await t.waitEvent('EXIT 0');
          assert.equal(r.pid, t.relayPid);
          assert.equal(r.dir, null);
          await t.finish();
        });
    });

    // -- real-Codex resolution and probe -------------------------------------

    test('probe: resolves the real Codex, skipping the relay itself, cmux shims and the wrapper', T, async () => {
      const w = mkdtempSync(join(work, 'probe-'));
      const exe = (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, '#!/bin/sh\nexit 0\n');
        chmodSync(p, 0o755);
      };
      exe(join(w, 'a/cmux-cli-shims/codex'));
      exe(join(w, 'b/Contents/Resources/bin/codex'));
      exe(join(w, 'wrapper/codex'));
      mkdirSync(join(w, 'self'));
      symlinkSync(v.relay, join(w, 'self/codex'));
      mkdirSync(join(w, 'notexec'));
      writeFileSync(join(w, 'notexec/codex'), 'x');
      exe(join(w, 'real/codex'));
      exe(join(w, 'later/codex'));
      const PATH = ['a/cmux-cli-shims', 'b/Contents/Resources/bin', 'wrapper', 'self', 'notexec', 'real', 'later']
        .map((d) => join(w, d)).join(':');
      const env = { PATH, VIZPANE_RELAY_PROBE: '1', CMUX_CODEX_WRAPPER_SHIM: join(w, 'wrapper/codex') };
      const r = spawnSync(v.relay, ['--model', 'x'], { env, encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^gate: direct \(stdin or stdout is not a terminal\)$/m);
      assert.match(r.stdout, new RegExp(`^real: ${join(w, 'real/codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.match(r.stdout, new RegExp(`^root: ${v.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

      // Through a symlink the relay finds its own root, and the override wins.
      const viaLink = spawnSync(join(w, 'self/codex'), [], {
        env: { ...env, VIZPANE_REAL_CODEX: join(w, 'later/codex') }, encoding: 'utf8' });
      assert.match(viaLink.stdout, new RegExp(`^real: ${join(w, 'later/codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.match(viaLink.stdout, new RegExp(`^root: ${v.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      // An override that points back at the relay is ignored.
      const self = spawnSync(v.relay, [], {
        env: { ...env, VIZPANE_REAL_CODEX: join(w, 'self/codex') }, encoding: 'utf8' });
      assert.match(self.stdout, /real: .*\/real\/codex$/m);
    });

    test('probe: a hard link of the relay, anything that is the cmux wrapper, and a copy outside <root>/relay', T, () => {
      const w = mkdtempSync(join(work, 'probe2-'));
      const exe = (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, '#!/bin/sh\nexit 0\n');
        chmodSync(p, 0o755);
      };
      mkdirSync(join(w, 'hard'));
      linkSync(v.relay, join(w, 'hard/codex'));
      exe(join(w, 'x/cmux-codex-wrapper'));
      mkdirSync(join(w, 'wrapper'));
      symlinkSync(join(w, 'x/cmux-codex-wrapper'), join(w, 'wrapper/codex'));
      exe(join(w, 'real/codex'));
      const want = new RegExp(`^real: ${join(w, 'real/codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
      const PATH = ['hard', 'wrapper', 'real'].map((d) => join(w, d)).join(':');
      const base = { PATH, VIZPANE_RELAY_PROBE: '1' };
      assert.match(spawnSync(v.relay, [], { env: base, encoding: 'utf8' }).stdout, want);
      // an override that names the wrapper or the relay is no better than the PATH entry
      for (const over of [join(w, 'wrapper/codex'), join(w, 'hard/codex')]) {
        assert.match(spawnSync(v.relay, [], { env: { ...base, VIZPANE_REAL_CODEX: over }, encoding: 'utf8' }).stdout, want);
      }
      // a copy somewhere else has no state root, so it never creates directories next to itself
      mkdirSync(join(w, 'bin'));
      const copy = join(w, 'bin/codex');
      copyFileSync(v.relay, copy);
      chmodSync(copy, 0o755);
      const out = spawnSync(copy, [], { env: { PATH: join(w, 'real'), VIZPANE_RELAY_PROBE: '1' }, encoding: 'utf8' }).stdout;
      assert.match(out, /^root: \(unknown\)$/m);
    });

    test('probe in a terminal reports the relay, and ignores the subcommand rules for help', T, async () => {
      const seen = existsSync(v.sessions) ? readdirSync(v.sessions) : [];
      await session(v, { env: { VIZPANE_RELAY_PROBE: '1' } }, async (t) => {
        await t.waitEvent('EXIT 0');
        await t.finish();
        assert.match(t.outText, /gate: relay/);
        assert.match(t.outText, new RegExp(`real: ${fakeBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.deepEqual(t.sessionDirs(), seen, 'probing creates nothing');
      });
      await session(v, { env: { VIZPANE_RELAY_PROBE: '1' }, args: ['exec'] }, async (t) => {
        await t.waitEvent('EXIT 0');
        await t.finish();
        assert.match(t.outText, /gate: direct \(non-interactive subcommand\)/);
      });
    });

    test('without a real Codex the relay says so and exits 127', T, () => {
      const empty = mkdtempSync(join(work, 'empty-'));
      const r = spawnSync(v.relay, [], { env: { PATH: empty }, encoding: 'utf8' });
      assert.equal(r.status, 127);
      assert.match(r.stderr, /codex not found in PATH/);
    });

    test('an exec failure of the real Codex is reported like a failed exec', T, () => {
      const w = mkdtempSync(join(work, 'noexec-'));
      writeFileSync(join(w, 'codex'), '#!/nonexistent/interpreter\n');
      chmodSync(join(w, 'codex'), 0o755);
      const r = spawnSync(v.relay, [], { env: { PATH: w }, encoding: 'utf8' });
      assert.equal(r.status, 127);
      assert.match(r.stderr, /No such file/);
    });
  });
}

test('no process of these tests is left behind', { skip: SKIP, timeout: 10000 }, () => {
  assert.deepEqual(leftovers, []);
});
