import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncApp, defaultPluginRoot } from '../plugins/vizpane/lib/sync.mjs';

let home, plugin;
function fakePlugin(version, tag) {
  const w = (rel, text) => {
    const p = join(plugin, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  w('VERSION', `${version}\n`);
  w('viewer/viewer.html', `html ${tag}`);
  w('viewer/viewer.js', `js ${tag}`);
  w('viewer/vendor/mermaid.min.js', `mermaid ${tag}`);
  w('bin/vizpane.mjs', `bin ${tag}`);
  w('lib/store.mjs', `lib ${tag}`);
  w('skills/viz/SKILL.md', 'not copied');
}
const read = (rel) => readFileSync(join(home, rel), 'utf8');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vizpane-sync-home-'));
  plugin = mkdtempSync(join(tmpdir(), 'vizpane-sync-plugin-'));
  process.env.VIZPANE_HOME = home;
});

test('copies to the state-root layout', () => {
  fakePlugin('1.0.0', 'a');
  assert.equal(syncApp(plugin), true);
  assert.equal(read('VERSION'), '1.0.0\n');
  assert.equal(read('viewer.html'), 'html a');
  assert.equal(read('viewer.js'), 'js a');
  assert.equal(read('vendor/mermaid.min.js'), 'mermaid a');
  assert.equal(read('bin/vizpane.mjs'), 'bin a');
  assert.equal(read('lib/store.mjs'), 'lib a');
  assert.ok(!existsSync(join(home, 'skills')));
});

test('skipped when versions match, runs when they differ, forced when asked', () => {
  fakePlugin('1.0.0', 'a');
  syncApp(plugin);
  fakePlugin('1.0.0', 'b');
  assert.equal(syncApp(plugin), false);
  assert.equal(read('viewer.html'), 'html a');
  assert.equal(syncApp(plugin, { force: true }), true);
  assert.equal(read('viewer.html'), 'html b');
  fakePlugin('1.1.0', 'c');
  assert.equal(syncApp(plugin), true);
  assert.equal(read('viewer.html'), 'html c');
  assert.equal(read('VERSION'), '1.1.0\n');
});

test('copes with an empty or missing viewer directory', () => {
  fakePlugin('1.0.0', 'a');
  mkdirSync(join(plugin, 'empty'), { recursive: true });
  const p2 = mkdtempSync(join(tmpdir(), 'vizpane-sync-plugin2-'));
  mkdirSync(join(p2, 'bin'));
  mkdirSync(join(p2, 'viewer'));
  writeFileSync(join(p2, 'VERSION'), '2.0.0\n');
  writeFileSync(join(p2, 'bin/vizpane.mjs'), 'x');
  assert.equal(syncApp(p2), true);
  assert.equal(read('bin/vizpane.mjs'), 'x');
});

test('no-op when the plugin root is the state root itself', () => {
  mkdirSync(join(home, 'lib'), { recursive: true });
  writeFileSync(join(home, 'VERSION'), '1.0.0\n');
  assert.equal(syncApp(home, { force: true }), false);
});

test('defaultPluginRoot points at the real plugin directory', () => {
  assert.ok(existsSync(join(defaultPluginRoot(), 'VERSION')));
});
