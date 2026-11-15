import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateRoot } from './store.mjs';
import { pluginVersion } from './sync.mjs';

const BUILD_TIMEOUT_MS = 120000;
const CC_TIMEOUT_MS = 60000;

export const rendererPath = (root = stateRoot()) => join(root, 'bin', 'viz-render');
const stampPath = (root) => `${rendererPath(root)}.stamp`;

export const inlineOff = (env = process.env) => env.VIZPANE_INLINE === 'off';

const RENDERER_SOURCES = [['inline', 'render.swift']];
const RELAY_SOURCES = [['inline', 'relay.c'], ['inline', 'relay-filter.h']];

// A binary is rebuilt when the plugin version changes or when the sources that go into it change:
// the stamp is "<version>+<hash of the sources>", so an edit without a version bump (a source
// checkout in development) cannot leave an old binary in place. If a source file is not in the
// state root the stamp is the version alone: the hook must not stop drawing because of a hash it
// cannot compute, and a build would fail on the missing source anyway.
export function buildStamp(root, version, sources) {
  if (!version) return null;
  const hash = createHash('sha256');
  try {
    for (const rel of sources) {
      const name = rel.join('/');
      hash.update(`${name}\0`).update(readFileSync(join(root, ...rel))).update('\0');
    }
  } catch {
    return version;
  }
  return `${version}+${hash.digest('hex').slice(0, 12)}`;
}

function stampMatches(file, expected) {
  try {
    return expected !== null && readFileSync(file, 'utf8').trim() === expected;
  } catch {
    return false;
  }
}

export function rendererReady({ root = stateRoot(), version = pluginVersion() } = {}) {
  return existsSync(rendererPath(root)) && stampMatches(stampPath(root), buildStamp(root, version, RENDERER_SOURCES));
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

// Builds <source> into <path> through a partial file, then stamps the version. Shared by the
// renderer and the relay; never throws.
function ensureBuilt({ root, version, platform, env, build, path, ready, sourceRel, sources, platformError }) {
  if (inlineOff(env)) return { ok: false, error: 'VIZPANE_INLINE=off' };
  if (platform !== 'darwin') return { ok: false, error: platformError };
  if (ready({ root, version })) return { ok: true, path };
  const source = join(root, ...sourceRel);
  if (!existsSync(source)) return { ok: false, error: `${sourceRel.join('/')} is missing in the state root` };
  try {
    // Hashed before the build, see below.
    const stampOf = buildStamp(root, version, sources);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Its own name per run: two runs at once (two `codex-inline`, a renderer start next to one) must
    // not delete each other's file or rename a half-written binary into place.
    const partial = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.partial`;
    const built = build(source, partial);
    if (!built.ok || !existsSync(partial)) {
      rmSync(partial, { force: true });
      return { ok: false, error: built.error || 'build produced no binary' };
    }
    renameSync(partial, path);
    // The stamp comes from the hash taken before the build: if a source changed while it compiled,
    // the stamp no longer matches and the next start rebuilds, rather than vouching for a binary
    // of the older source.
    writeFileSync(`${path}.stamp`, `${stampOf}\n`, { mode: 0o600 });
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Returns { ok: true, path } or { ok: false, error }; never throws.
export function ensureRenderer({
  root = stateRoot(), version = pluginVersion(), platform = process.platform, env = process.env, build = swiftcBuild,
} = {}) {
  return ensureBuilt({
    root, version, platform, env, build, path: rendererPath(root), ready: rendererReady,
    sourceRel: ['inline', 'render.swift'], sources: RENDERER_SOURCES, platformError: 'inline pictures need macOS',
  });
}

// MARK: Codex relay

// The relay sits at <root>/relay/codex and finds its state root from that location, so the
// directory holds nothing else that could be mistaken for a PATH entry.
export const relayPath = (root = stateRoot()) => join(root, 'relay', 'codex');

export function relayStamp(root = stateRoot()) {
  try {
    return readFileSync(`${relayPath(root)}.stamp`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function relayReady({ root = stateRoot(), version = pluginVersion() } = {}) {
  return existsSync(relayPath(root)) && stampMatches(`${relayPath(root)}.stamp`, buildStamp(root, version, RELAY_SOURCES));
}

// libc only, so the Xcode Command Line Tools compiler is all it needs. relay.c includes
// relay-filter.h from its own directory.
export function ccBuild(source, out) {
  const r = spawnSync('cc', ['-O2', '-Wall', '-Wextra', '-o', out, source], { encoding: 'utf8', timeout: CC_TIMEOUT_MS });
  if (r.error) {
    return { ok: false, error: r.error.code === 'ENOENT' ? 'cc not found (install the Xcode Command Line Tools)' : r.error.message };
  }
  if (r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, error: `cc failed${tail ? `: ${tail}` : ''}` };
  }
  return { ok: true };
}

// Returns { ok: true, path } or { ok: false, error }; never throws.
export function ensureRelay({
  root = stateRoot(), version = pluginVersion(), platform = process.platform, env = process.env, build = ccBuild,
} = {}) {
  return ensureBuilt({
    root, version, platform, env, build, path: relayPath(root), ready: relayReady,
    sourceRel: ['inline', 'relay.c'], sources: RELAY_SOURCES, platformError: 'the Codex relay needs macOS',
  });
}
