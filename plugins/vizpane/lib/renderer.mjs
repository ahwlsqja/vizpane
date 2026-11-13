import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from './store.mjs';
import { pluginVersion } from './sync.mjs';

const BUILD_TIMEOUT_MS = 120000;

export const rendererPath = (root = stateRoot()) => join(root, 'bin', 'viz-render');
const stampPath = (root) => `${rendererPath(root)}.stamp`;

export const inlineOff = (env = process.env) => env.VIZPANE_INLINE === 'off';

// The helper is rebuilt when the plugin version changes: the stamp holds the version it was built for.
export function rendererReady({ root = stateRoot(), version = pluginVersion() } = {}) {
  if (!version || !existsSync(rendererPath(root))) return false;
  try {
    return readFileSync(stampPath(root), 'utf8').trim() === version;
  } catch {
    return false;
  }
}

// Tests inject their own build so that no test compiles Swift.
export function swiftcBuild(source, out) {
  const r = spawnSync('swiftc', ['-O', '-o', out, source], { encoding: 'utf8', timeout: BUILD_TIMEOUT_MS });
  if (r.error) {
    return { ok: false, error: r.error.code === 'ENOENT' ? 'swiftc not found (install the Xcode Command Line Tools)' : r.error.message };
  }
  if (r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, error: `swiftc failed${tail ? `: ${tail}` : ''}` };
  }
  return { ok: true };
}

// Returns { ok: true, path } or { ok: false, error }; never throws.
export function ensureRenderer({
  root = stateRoot(), version = pluginVersion(), platform = process.platform, env = process.env, build = swiftcBuild,
} = {}) {
  if (inlineOff(env)) return { ok: false, error: 'VIZPANE_INLINE=off' };
  if (platform !== 'darwin') return { ok: false, error: 'inline pictures need macOS' };
  const path = rendererPath(root);
  if (rendererReady({ root, version })) return { ok: true, path };
  const source = join(root, 'inline', 'render.swift');
  if (!existsSync(source)) return { ok: false, error: 'inline/render.swift is missing in the state root' };
  try {
    mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o700 });
    const partial = `${path}.partial`;
    rmSync(partial, { force: true });
    const built = build(source, partial);
    if (!built.ok || !existsSync(partial)) {
      rmSync(partial, { force: true });
      return { ok: false, error: built.error || 'build produced no binary' };
    }
    renameSync(partial, path);
    writeFileSync(stampPath(root), `${version}\n`, { mode: 0o600 });
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
