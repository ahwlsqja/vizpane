import { execFile } from 'node:child_process';
import { addTurn, wsId, viewerUrl, withLock } from './store.mjs';
import { syncApp, defaultPluginRoot, installedVersion } from './sync.mjs';
import { titleOf } from './extract.mjs';
import { log } from './log.mjs';

const TIMEOUT_MS = 5000;

export const cmuxBin = () => process.env.VIZPANE_CMUX_BIN || process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';

// execFile, never a shell: arguments (including the eval script) are passed verbatim.
export function runCmux(args) {
  return new Promise((resolve, reject) => {
    execFile(cmuxBin(), args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

const list = (x) => (Array.isArray(x) ? x : []);

export function findViewerSurface(tree, url) {
  for (const win of list(tree?.windows)) {
    for (const space of list(win?.workspaces)) {
      for (const pane of list(space?.panes)) {
        for (const s of list(pane?.surfaces)) {
          if (s?.type === 'browser' && typeof s.url === 'string' && s.url.startsWith(url)) return s.ref;
        }
      }
    }
  }
  return null;
}

async function findSurface(cmuxWs, ws) {
  const out = await runCmux(['tree', '--workspace', cmuxWs, '--json']);
  return findViewerSurface(JSON.parse(out), viewerUrl(ws));
}

// An open page keeps running the code it was loaded with. When its version differs from the
// installed one the script answers 'stale' and the caller reloads the surface through cmux.
// The page must not call location.reload() itself: in the cmux browser a file:// page reloaded
// from its own script never finishes loading its scripts (verified on cmux 0.64.22).
export function pushScript(ws, rel, version = installedVersion()) {
  const load = `viz.loadScript('data/${ws}/${rel}')`;
  if (!version) return load;
  return `(window.viz && viz.version === ${JSON.stringify(version)}) ? ${load} : 'stale'`;
}

// A new pane loads boot.js itself, so it needs no eval afterwards.
// The theme goes after ?ws= so findViewerSurface, which matches by URL prefix, still finds the pane.
export function paneUrl(ws, theme = process.env.VIZPANE_THEME) {
  return viewerUrl(ws) + (theme === 'light' || theme === 'dark' ? `&theme=${theme}` : '');
}

const newPane = (cmuxWs, ws) =>
  runCmux(['new-pane', '--type', 'browser', '--direction', 'right', '--workspace', cmuxWs,
    '--url', paneUrl(ws), '--focus', 'false']);

export async function openViewer(ws, cmuxWs = process.env.CMUX_WORKSPACE_ID) {
  if (await findSurface(cmuxWs, ws)) return 'exists';
  await newPane(cmuxWs, ws);
  return 'opened';
}

export async function publish({ agent, session, cwd, markdown, title, zoom }, { pluginRoot = defaultPluginRoot(), now } = {}) {
  const ws = wsId();
  try {
    syncApp(pluginRoot);
  } catch (e) {
    log(`error sync: ${e.message}`);
  }
  const { id, rel } = await addTurn(ws, { agent, session, cwd, markdown, title: title || titleOf(markdown), zoom }, now);
  const cmuxWs = process.env.CMUX_WORKSPACE_ID;
  let action = 'stored-only';
  if (!cmuxWs) {
    log(`${ws} ${id} ${action} (no CMUX_WORKSPACE_ID)`);
    return { id, action };
  }
  try {
    // Find-or-create runs under the workspace lock so two agents finishing together open one viewer, not two.
    action = await withLock(ws, async () => {
      const ref = await findSurface(cmuxWs, ws);
      if (ref) {
        const answer = await runCmux(['browser', ref, 'eval', pushScript(ws, rel)]);
        if (String(answer).trim() !== 'stale') return 'pushed';
        // boot.js already lists the new turn, so the reloaded page shows it.
        await runCmux(['browser', ref, 'reload']);
        return 'reloaded';
      }
      await newPane(cmuxWs, ws);
      return 'opened';
    });
    log(`${ws} ${id} ${action}`);
  } catch (e) {
    log(`${ws} ${id} stored-only error: ${e.message}`);
  }
  return { id, action };
}
