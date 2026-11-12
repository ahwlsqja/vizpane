import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViewerSurface, publish, openViewer, pushScript, paneUrl } from '../plugins/vizpane/lib/cmux.mjs';
import { viewerUrl } from '../plugins/vizpane/lib/store.mjs';
import { makeStub, treeWith } from './stub-cmux.mjs';

const URL1 = 'file:///h/viewer.html?ws=w1';

test('findViewerSurface: match, prefix match, no match', () => {
  assert.equal(findViewerSurface(treeWith(URL1), URL1), 'surface:4');
  assert.equal(findViewerSurface(treeWith(URL1 + '#top'), URL1), 'surface:4');
  assert.equal(findViewerSurface(treeWith('file:///h/viewer.html?ws=other'), URL1), null);
});
test('findViewerSurface: url null and non-browser types are ignored', () => {
  const t = { windows: [{ workspaces: [{ panes: [{ surfaces: [
    { ref: 's1', type: 'browser', url: null },
    { ref: 's2', type: 'markdown', url: URL1 },
  ] }] }] }] };
  assert.equal(findViewerSurface(t, URL1), null);
});
test('findViewerSurface: tolerates missing arrays', () => {
  for (const t of [null, {}, { windows: [{}] }, { windows: [{ workspaces: [{}] }] },
    { windows: [{ workspaces: [{ panes: [{}] }] }] }, { windows: 5 }]) {
    assert.equal(findViewerSurface(t, URL1), null);
  }
});

let dir, home, plugin, stub;
const ENTRY = { agent: 'claude', session: 's1', cwd: '/p', markdown: '# Hi\n```mermaid\ngraph TD\n```' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vizpane-cmux-'));
  home = join(dir, 'home');
  plugin = join(dir, 'plugin');
  mkdirSync(join(plugin, 'viewer'), { recursive: true });
  writeFileSync(join(plugin, 'VERSION'), '9.9.9\n');
  process.env.VIZPANE_HOME = home;
  process.env.CMUX_WORKSPACE_ID = 'w1';
  stub = makeStub(dir);
  process.env.VIZPANE_CMUX_BIN = stub.bin;
});

test('publish: eval when the viewer surface exists', async () => {
  stub.setTree(treeWith(viewerUrl('w1')));
  const r = await publish(ENTRY, { pluginRoot: plugin });
  assert.deepEqual(r, { id: '0001', action: 'pushed' });
  const calls = stub.calls();
  assert.equal(calls[0], 'tree --workspace w1 --json');
  // The page loads the turn only when it runs the installed version.
  assert.equal(calls[1], `browser surface:4 eval (window.viz && viz.version === "9.9.9") ? viz.loadScript('data/w1/turns/turn-0001.js') : 'stale'`);
  assert.equal(calls.length, 2);
  assert.ok(existsSync(join(home, 'data/w1/turns/turn-0001.js')));
  assert.equal(readFileSync(join(home, 'VERSION'), 'utf8'), '9.9.9\n'); // synced
  assert.match(readFileSync(join(home, 'vizpane.log'), 'utf8'), /w1 0001 pushed/);
});

test('publish: new-pane when no viewer surface exists', async () => {
  const r = await publish(ENTRY, { pluginRoot: plugin });
  assert.deepEqual(r, { id: '0001', action: 'opened' });
  const calls = stub.calls();
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1],
    `new-pane --type browser --direction right --workspace w1 --url ${viewerUrl('w1')} --focus false`,
  );
});

test('publish: stored-only without CMUX_WORKSPACE_ID', async () => {
  delete process.env.CMUX_WORKSPACE_ID;
  const r = await publish(ENTRY, { pluginRoot: plugin });
  assert.deepEqual(r, { id: '0001', action: 'stored-only' });
  assert.deepEqual(stub.calls(), []);
  assert.ok(existsSync(join(home, 'data/no-cmux/turns/turn-0001.js')));
});

test('publish: cmux failure is logged, turn stays stored', async () => {
  process.env.VIZPANE_CMUX_BIN = join(dir, 'does-not-exist');
  const r = await publish(ENTRY, { pluginRoot: plugin });
  assert.equal(r.action, 'stored-only');
  assert.match(readFileSync(join(home, 'vizpane.log'), 'utf8'), /error/);
});

test('publish: explicit title is used', async () => {
  await publish({ ...ENTRY, title: 'Custom' }, { pluginRoot: plugin });
  assert.match(readFileSync(join(home, 'data/w1/turns/turn-0001.js'), 'utf8'), /"title":"Custom"/);
});

test('openViewer: exists vs opened', async () => {
  assert.equal(await openViewer('w1'), 'opened');
  stub.setTree(treeWith(viewerUrl('w1')));
  assert.equal(await openViewer('w1'), 'exists');
});

test('publish: a viewer running an older version is reloaded through cmux', async () => {
  stub.setTree(treeWith(viewerUrl('w1')));
  stub.setEvalAnswer('stale');
  const r = await publish(ENTRY, { pluginRoot: plugin });
  assert.equal(r.action, 'reloaded');
  const calls = stub.calls();
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'browser surface:4 reload');
  assert.match(readFileSync(join(home, 'vizpane.log'), 'utf8'), /w1 \d{4} reloaded/);
});

test('pushScript: plain load when no version is installed', () => {
  assert.equal(pushScript('w1', 'turns/turn-0002.js', null), "viz.loadScript('data/w1/turns/turn-0002.js')");
});

// A mismatch here would make every push reload the page.
test('viewer.js reports the same version as the VERSION file', () => {
  const root = new URL('../plugins/vizpane/', import.meta.url);
  const version = readFileSync(new URL('VERSION', root), 'utf8').trim();
  const viewer = readFileSync(new URL('viewer/viewer.js', root), 'utf8');
  assert.ok(viewer.includes(`var VERSION = '${version}'`), `viewer.js VERSION is not ${version}`);
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    assert.equal(JSON.parse(readFileSync(new URL(manifest, root), 'utf8')).version, version, manifest);
  }
});

test('paneUrl: VIZPANE_THEME adds a theme parameter after ws', () => {
  assert.equal(paneUrl('w1', undefined), viewerUrl('w1'));
  assert.equal(paneUrl('w1', 'dark'), viewerUrl('w1') + '&theme=dark');
  assert.equal(paneUrl('w1', 'light'), viewerUrl('w1') + '&theme=light');
  assert.equal(paneUrl('w1', 'pink'), viewerUrl('w1'));
});
