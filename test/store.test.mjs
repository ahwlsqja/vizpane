import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../plugins/vizpane/lib/store.mjs';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vizpane-store-'));
  process.env.VIZPANE_HOME = home;
  delete process.env.CMUX_WORKSPACE_ID;
});

const entry = (md = 'hello') => ({ agent: 'claude', session: 'sess1', cwd: '/p', markdown: md, title: 'T' });
const FIXED = new Date('2026-11-13T01:02:11.000Z');

test('stateRoot honours VIZPANE_HOME, default is under ~/.local/state', () => {
  assert.equal(store.stateRoot(), home);
  delete process.env.VIZPANE_HOME;
  assert.match(store.stateRoot(), /\.local\/state\/vizpane$/);
});

test('wsId / sanitize', () => {
  assert.equal(store.wsId({}), 'no-cmux');
  assert.equal(store.wsId({ CMUX_WORKSPACE_ID: 'A1-b_c:d/e' }), 'A1-b_c_d_e');
  assert.equal(store.sanitize(undefined), 'unknown');
  assert.equal(store.sanitize('a b'), 'a_b');
});

test('viewerUrl', () => {
  assert.equal(store.viewerUrl('w1'), `file://${home}/viewer.html?ws=w1`);
});

test('ids start at 0001 and increase; file content matches the contract byte for byte', async () => {
  const a = await store.addTurn('w', entry('first'), FIXED);
  const b = await store.addTurn('w', entry('second'), FIXED);
  assert.equal(a.id, '0001');
  assert.equal(b.id, '0002');
  const text = readFileSync(join(home, 'data/w/turns/turn-0002.js'), 'utf8');
  assert.equal(
    text,
    'viz.add({"v":1,"id":"0002","agent":"claude","session":"sess1","cwd":"/p","time":"2026-11-13T01:02:11.000Z","title":"T","markdown":"second"});\n',
  );
  assert.equal(
    readFileSync(join(home, 'data/w/boot.js'), 'utf8'),
    'viz.boot({"v":1,"ws":"w","turns":["turns/turn-0001.js","turns/turn-0002.js"]});\n',
  );
});

test('a turn carries zoom only when it is asked for', async () => {
  await store.addTurn('w', entry('plain'), FIXED);
  await store.addTurn('w', { ...entry('big'), zoom: true }, FIXED);
  assert.ok(!readFileSync(join(home, 'data/w/turns/turn-0001.js'), 'utf8').includes('zoom'));
  const text = readFileSync(join(home, 'data/w/turns/turn-0002.js'), 'utf8');
  assert.equal(JSON.parse(text.slice('viz.add('.length, text.lastIndexOf(');'))).zoom, true);
});

test('encoding escapes < and line separators', async () => {
  const md = 'x </script><b> \u2028 \u2029 end';
  await store.addTurn('w', entry(md), FIXED);
  const text = readFileSync(join(home, 'data/w/turns/turn-0001.js'), 'utf8');
  assert.ok(!text.includes('<'));
  assert.ok(!text.includes('\u2028') && !text.includes('\u2029'));
  assert.ok(text.includes('\\u003c/script>'));
  const json = text.slice('viz.add('.length, text.lastIndexOf(');'));
  assert.equal(JSON.parse(json).markdown, md);
  assert.equal(text.split('\n').length, 2); // one line plus trailing newline
});

test('retention keeps newest 30, boot lists only kept files', async () => {
  for (let i = 0; i < 33; i++) await store.addTurn('w', entry(`m${i}`), FIXED);
  const files = readdirSync(join(home, 'data/w/turns')).sort();
  assert.equal(files.length, 30);
  assert.equal(files[0], 'turn-0004.js');
  assert.equal(files.at(-1), 'turn-0033.js');
  const boot = readFileSync(join(home, 'data/w/boot.js'), 'utf8');
  const idx = JSON.parse(boot.slice('viz.boot('.length, boot.lastIndexOf(');')));
  assert.equal(idx.turns.length, 30);
  assert.equal(idx.turns[0], 'turns/turn-0004.js');
});

test('id never reuses a number after pruning', async () => {
  for (let i = 0; i < 31; i++) await store.addTurn('w', entry(), FIXED);
  const t = await store.addTurn('w', entry(), FIXED);
  assert.equal(t.id, '0032');
});

test('saveLast and newestLast', async () => {
  store.saveLast('w', { agent: 'claude', session: 's/1', cwd: '/p', markdown: 'one' }, FIXED);
  store.saveLast('w', { agent: 'codex', session: 's2', cwd: '/q', markdown: 'two' }, FIXED);
  const dir = join(home, 'data/w/last');
  utimesSync(join(dir, 's_1.json'), 1000, 1000);
  utimesSync(join(dir, 's2.json'), 2000, 2000);
  assert.equal(store.newestLast('w').markdown, 'two');
  assert.equal(store.newestLast('w', 's/1').markdown, 'one');
  assert.equal(store.newestLast('w', 'nope'), null);
  assert.equal(store.newestLast('other'), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 's2.json'), 'utf8')), {
    agent: 'codex', session: 's2', cwd: '/q', time: '2026-11-13T01:02:11.000Z', markdown: 'two',
  });
});

test('lock is released after an exception and blocks while held', async () => {
  await assert.rejects(store.withLock('w', () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(join(home, 'data/w/.lock')));
  await store.withLock('w', () => {});
  // concurrent callers are serialized
  const order = [];
  await Promise.all([
    store.withLock('w', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 100)); order.push('a2'); }),
    store.withLock('w', async () => { order.push('b1'); order.push('b2'); }),
  ]);
  assert.deepEqual(order.join(), 'a1,a2,b1,b2');
});

test('stale lock older than 10 s is removed', async () => {
  const lock = join(home, 'data/w/.lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 20000);
  utimesSync(lock, old, old);
  await store.withLock('w', () => {});
  assert.ok(!existsSync(lock));
});

test('off flag', () => {
  assert.equal(store.isOff('w'), false);
  store.setOff('w', true);
  assert.equal(store.isOff('w'), true);
  store.setOff('w', false);
  assert.equal(store.isOff('w'), false);
});

test('file and directory modes', async () => {
  await store.addTurn('w', entry(), FIXED);
  store.saveLast('w', { agent: 'claude', session: 's', cwd: '', markdown: 'm' }, FIXED);
  const mode = (p) => statSync(join(home, p)).mode & 0o777;
  assert.equal(mode('data'), 0o700);
  assert.equal(mode('data/w'), 0o700);
  assert.equal(mode('data/w/turns'), 0o700);
  assert.equal(mode('data/w/last'), 0o700);
  assert.equal(mode('data/w/boot.js'), 0o600);
  assert.equal(mode('data/w/turns/turn-0001.js'), 0o600);
  assert.equal(mode('data/w/last/s.json'), 0o600);
});
