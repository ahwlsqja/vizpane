#!/usr/bin/env node
// Builds the inline renderer into a temporary state root, draws the three examples of
// skills/viz-style/SKILL.md to PNG files, and checks that the renderer sends no network
// request. macOS only. Exits non-zero when any step fails.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('check-inline: macOS only');
  process.exit(1);
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(repo, 'plugins/vizpane');
const root = mkdtempSync(join(tmpdir(), 'vizpane-check-inline-'));
process.env.VIZPANE_HOME = root;

const { syncApp } = await import(join(plugin, 'lib/sync.mjs'));
const { ensureRenderer } = await import(join(plugin, 'lib/renderer.mjs'));
const { mermaidBlocks, hashSource } = await import(join(plugin, 'claude/inline-core.mjs'));

// A page that asks for six kinds of network load. It stands in for a diagram that got past
// Mermaid's own checks; the renderer must still load nothing.
const PROBE_PAGE = `<!doctype html><meta charset="utf-8"><body><script>
window.vizRender = async (src) => {
  const base = src.trim();
  try { await fetch(base + '/fetch'); } catch {}
  await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = base + '/img.png'; });
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = base + '/style.css'; document.head.appendChild(l);
  try { const x = new XMLHttpRequest(); x.open('GET', base + '/xhr', false); x.send(); } catch {}
  try {
    const w = new WebSocket(base.replace('http', 'ws') + '/ws');
    await new Promise((done) => { w.onopen = w.onerror = w.onclose = done; setTimeout(done, 800); });
  } catch {}
  try { navigator.sendBeacon(base + '/beacon', 'x'); } catch {}
  await new Promise((done) => setTimeout(done, 600));
  return JSON.stringify({ ok: true, width: 100, height: 50 });
};
</script></body>`;

// Runs a renderer build on the probe page and returns the requests a local server received.
// The helper runs asynchronously so that the server can answer while it runs.
const probe = async (helper, dir) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('ok');
  });
  server.on('upgrade', (req, socket) => { seen.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const src = join(dir, 'probe.src');
  writeFileSync(src, `http://127.0.0.1:${server.address().port}`);
  await new Promise((done) => {
    const child = spawn(helper, [join(root, 'inline/probe.html'), src, join(dir, 'probe.png'), 'dark'], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', () => { clearTimeout(timer); done(); });
  });
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  return seen;
};

let failed = false;
try {
  syncApp(plugin, { force: true });
  const built = ensureRenderer();
  if (!built.ok) throw new Error(`build: ${built.error}`);
  console.log(`built ${built.path}`);

  const guide = readFileSync(join(plugin, 'skills/viz-style/SKILL.md'), 'utf8');
  const blocks = mermaidBlocks(guide);
  if (blocks.length !== 3) throw new Error(`expected 3 examples in SKILL.md, found ${blocks.length}`);
  const out = join(root, 'out');
  mkdirSync(out);

  for (const [i, block] of blocks.entries()) {
    for (const theme of ['dark', 'light']) {
      const id = `${i + 1}-${theme}`;
      const mmd = join(out, `${id}.mmd`);
      const png = join(out, `${id}.png`);
      spawnSync('/usr/bin/env', ['sh', '-c', 'cat > "$1"', 'sh', mmd], { input: block.source });
      const r = spawnSync(built.path, [join(root, 'inline/render.html'), mmd, png, theme], { encoding: 'utf8', timeout: 30000 });
      const info = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
      if (r.status !== 0 || info.ok !== true) {
        failed = true;
        console.error(`FAIL diagram ${i + 1} (${theme}): ${info.error || r.stderr || `exit ${r.status}`}`);
        continue;
      }
      // The PNG holds two pixels per CSS pixel: enough for a 2x display, no more.
      const head = readFileSync(png).subarray(16, 24);
      const pixels = [head.readUInt32BE(0), head.readUInt32BE(4)];
      if (Math.abs(pixels[0] - 2 * info.width) > 2) {
        failed = true;
        console.error(`FAIL diagram ${i + 1} (${theme}): png is ${pixels[0]} px wide for ${info.width} css px, expected ${2 * info.width}`);
        continue;
      }
      console.log(`ok   diagram ${i + 1} ${theme}: ${info.width} x ${info.height} css px, png ${pixels[0]} x ${pixels[1]} px, ${statSync(png).size} bytes, key ${hashSource(block.source)}`);
    }
  }

  // Network. A control build whose block rules match nothing shows that the probe page's
  // requests would reach the server; without it, zero requests would prove nothing.
  writeFileSync(join(root, 'inline/probe.html'), PROBE_PAGE);
  const source = readFileSync(join(plugin, 'inline/render.swift'), 'utf8');
  const open = source
    .replace('^https?://', '^no-such-scheme-a://')
    .replace('^wss?://', '^no-such-scheme-b://')
    .replace('viz-no-network', 'viz-check-control');
  if (open.split('no-such-scheme').length !== 3 || !open.includes('viz-check-control')) {
    throw new Error('network check: render.swift no longer has the block rules this check rewrites');
  }
  writeFileSync(join(out, 'control.swift'), open);
  // Same file name as the real helper, so that WebKit keeps its files in the helper's own
  // folder and the check leaves nothing new behind.
  mkdirSync(join(out, 'control'));
  const control = join(out, 'control', 'viz-render');
  const cc = spawnSync('swiftc', ['-O', join(out, 'control.swift'), '-o', control], { encoding: 'utf8', timeout: 120000 });
  if (cc.status !== 0) throw new Error(`network check: control build failed: ${(cc.stderr || '').trim().split('\n').pop()}`);
  const withoutRules = await probe(control, out);
  const withRules = await probe(built.path, out);
  if (withoutRules.length === 0) {
    failed = true;
    console.error('FAIL network: the control build sent no request, so the probe proves nothing');
  } else if (withRules.length > 0) {
    failed = true;
    console.error(`FAIL network: the renderer sent ${withRules.length} request(s): ${withRules.join(', ')}`);
  } else {
    console.log(`ok   network: 0 requests from the renderer (control build without block rules: ${withoutRules.length})`);
  }

  // Informational: the terminal that runs this script may not report its pixel size.
  const cell = spawnSync(built.path, ['--cell'], { encoding: 'utf8', timeout: 10000 });
  console.log(`cell ${(cell.stdout || '').trim()}`);
} catch (e) {
  failed = true;
  console.error(`FAIL ${e.message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
