import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRoot } from './store.mjs';

export function defaultPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const readVersion = (dir) => {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
};

export const pluginVersion = (pluginRoot = defaultPluginRoot()) => readVersion(pluginRoot);
export const installedVersion = () => readVersion(stateRoot());

function copyTree(from, to) {
  if (!existsSync(from) || !statSync(from).isDirectory()) return;
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else writeFileSync(dst, readFileSync(src), { mode: 0o600 });
  }
}

// Returns true when files were copied. VERSION is written last so an interrupted
// copy is retried on the next call.
export function syncApp(pluginRoot = defaultPluginRoot(), { force = false } = {}) {
  const root = stateRoot();
  if (resolve(pluginRoot) === resolve(root)) return false;
  const version = readVersion(pluginRoot);
  if (version === null) return false;
  if (!force && readVersion(root) === version) return false;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  copyTree(join(pluginRoot, 'viewer'), root);
  copyTree(join(pluginRoot, 'bin'), join(root, 'bin'));
  copyTree(join(pluginRoot, 'lib'), join(root, 'lib'));
  copyTree(join(pluginRoot, 'inline'), join(root, 'inline'));
  writeFileSync(join(root, 'VERSION'), `${version}\n`, { mode: 0o600 });
  return true;
}
