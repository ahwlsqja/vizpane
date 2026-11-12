#!/usr/bin/env node
// End-to-end check that must run inside cmux. It uses a throwaway state root, lets the real CLI
// open a viewer pane in the current workspace, pushes fixtures, asserts on the live page through
// `cmux browser eval`, and closes the pane again. Pass --keep to leave the pane open.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repo, 'plugins/vizpane/bin/vizpane.mjs')
const cmux = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux'
const wsId = process.env.CMUX_WORKSPACE_ID
const keep = process.argv.includes('--keep')

if (!wsId) {
  console.error('CMUX_WORKSPACE_ID is not set: run this inside a cmux terminal.')
  process.exit(2)
}

// realpath so the file:// URL is the same string whether or not the engine resolves symlinks.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'vizpane-e2e-')))
const ws = wsId.replace(/[^A-Za-z0-9_-]/g, '_')
const viewerUrl = pathToFileURL(join(home, 'viewer.html')).href + '?ws=' + ws
const env = { ...process.env, VIZPANE_HOME: home }
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 6000, step = 150) {
  const end = Date.now() + ms
  for (;;) {
    try { const v = fn(); if (v) return v } catch { /* not ready yet */ }
    if (Date.now() > end) return null
    await sleep(step)
  }
}
function vizpane(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8', timeout: 20000 })
}
function findSurface() {
  const tree = JSON.parse(execFileSync(cmux, ['tree', '--workspace', wsId, '--json'], { encoding: 'utf8', timeout: 5000 }))
  for (const w of tree.windows || []) for (const s of w.workspaces || []) for (const p of s.panes || []) for (const f of p.surfaces || []) {
    if (f.type === 'browser' && typeof f.url === 'string' && f.url.startsWith(viewerUrl)) return f.ref
  }
  return null
}
// Evaluates after boot loading and pending diagram renders have finished.
function page(ref, expr) {
  const js = `viz.ready.then(() => viz.idle()).then(() => (${expr})).then(v => JSON.stringify(v === undefined ? null : v))`
  const out = execFileSync(cmux, ['browser', ref, 'eval', js], { encoding: 'utf8', timeout: 8000 })
  return JSON.parse(out.trim())
}
function pageRaw(ref, expr) {
  const out = execFileSync(cmux, ['browser', ref, 'eval', `JSON.stringify(${expr})`], { encoding: 'utf8', timeout: 8000 })
  return JSON.parse(out.trim())
}
function fixture(name, text) {
  const p = join(home, `fixture-${name}.md`)
  writeFileSync(p, text)
  return p
}
const turnsOf = ref => page(ref, 'viz.turns')

const GOOD = `**한 줄 결론:** Sink는 checkpoint가 끝난 뒤에만 commit한다.

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant JM@{ "type": "control", "alias": "JobManager" }
  participant SNK as Sink
  participant T@{ "type": "queue", "alias": "출력 topic" }
  JM->>SNK: notifyCheckpointComplete(n)
  SNK->>T: commit
\`\`\`

| 장애 시점 | 동작 |
|---|---|
| 완료 후 | commit 재시도 |
`

const BROKEN = `깨진 도식 하나와 정상 도식 하나.

\`\`\`mermaid
flowchart LR
  a["Kafka"] --> b["Flink"]
  linkStyle 0 stroke:#c0392b;
\`\`\`

\`\`\`mermaid
flowchart LR
  topic@{ shape: h-cyl, label: "orders.cdc" }
  ch@{ shape: lin-cyl, label: "orders_clean" }
  topic ==> ch
  class topic stream
  class ch store
\`\`\`
`

const XSS = `신뢰할 수 없는 내용.

<img src="x" onerror="window.__xss = 1">
<script>window.__xss = 2</script>

![remote](https://example.invalid/pixel.png)

\`\`\`mermaid
flowchart LR
  a["<img src=x onerror='window.__xss=3'>"] --> b["ok"]
\`\`\`

\`\`\`mermaid
%%{init: {"themeCSS": "@import url(https://www.google.com/remote.css); .node rect { fill: url(https://www.google.com/favicon.ico) }"}}%%
flowchart LR
  pic@{ img: "https://www.google.com/favicon.ico", label: "remote", w: 40, h: 40 }
  pic --> c["ok"]
\`\`\`
`

const skillExamples = () => {
  const md = readFileSync(join(repo, 'plugins/vizpane/skills/viz-style/SKILL.md'), 'utf8')
  const blocks = [...md.matchAll(/```mermaid\n[\s\S]*?```/g)].map(m => m[0])
  return { count: blocks.length, text: '# viz-style 예시\n\n' + blocks.join('\n\n') + '\n' }
}

let ref = null
try {
  const sync = vizpane(['sync'])
  check('sync copies the app into the state root', sync.status === 0 && existsSync(join(home, 'viewer.html')) && existsSync(join(home, 'vendor/mermaid.min.js')) && existsSync(join(home, 'bin/vizpane.mjs')), sync.stderr.trim())

  // 1. First push opens the viewer.
  const p1 = vizpane(['push', '--file', fixture('good', GOOD), '--title', 'good', '--agent', 'claude'])
  check('push --file exits 0', p1.status === 0, p1.stderr.trim())
  ref = await waitFor(findSurface)
  check('first push opens a viewer surface', !!ref, String(ref))
  if (!ref) throw new Error('no viewer surface; cannot continue')
  await waitFor(() => pageRaw(ref, 'typeof viz === "object" && !!viz.ready'))
  check('first card rendered', turnsOf(ref) === 1)
  check('sequence diagram became an svg', page(ref, 'document.querySelectorAll(".dia svg").length') === 1)
  check('table rendered', page(ref, 'document.querySelectorAll("table").length') === 1)
  check('no render errors yet', page(ref, 'viz.errors().length') === 0, JSON.stringify(page(ref, 'viz.errors()')))
  check('viewer did not take keyboard focus', (() => {
    const t = JSON.parse(execFileSync(cmux, ['identify', '--json'], { encoding: 'utf8', timeout: 5000 }))
    return !(t.focused && t.focused.is_browser_surface)
  })())

  // 2. Broken diagram: error box plus the healthy sibling diagram.
  vizpane(['push', '--file', fixture('broken', BROKEN), '--title', 'broken', '--agent', 'codex'])
  await waitFor(() => turnsOf(ref) === 2)
  check('second card pushed into the open viewer', turnsOf(ref) === 2)
  check('broken diagram is reported', page(ref, 'viz.errors().length') === 1, JSON.stringify(page(ref, 'viz.errors()')).slice(0, 160))
  check('healthy sibling diagram still rendered', page(ref, 'document.querySelectorAll(".dia svg").length') === 2)
  check('semantic class was injected', page(ref, 'document.querySelectorAll(".dia svg .stream, .dia svg .store").length') >= 2)

  // 3. Untrusted HTML must not run.
  vizpane(['push', '--file', fixture('xss', XSS), '--title', 'xss'])
  await waitFor(() => turnsOf(ref) === 3)
  await sleep(400)
  check('script and event handlers in the answer did not run', page(ref, 'typeof window.__xss') === 'undefined', String(page(ref, 'String(window.__xss)')))
  check('remote image in the answer was removed', page(ref, 'document.querySelectorAll(".md img[src]").length') === 0 && page(ref, 'viz.blocked()') >= 1, 'blocked=' + page(ref, 'viz.blocked()'))
  check('diagrams carry no external references', page(ref, '[...document.querySelectorAll(".dia svg image, .dia svg img, .dia svg use")].filter(n => /^https?:/i.test(n.getAttribute("href") || n.getAttribute("xlink:href") || n.getAttribute("src") || "")).length') === 0)
  check('diagram CSS carries no remote url or import', page(ref, '[...document.querySelectorAll(".dia svg style")].some(n => /google|@import/i.test(n.textContent))') === false)

  // 4. Hook: an answer without a fence is stored but not shown.
  const noFence = JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e-a', cwd: repo, last_assistant_message: '네, 수정했습니다.' })
  const h1 = vizpane(['hook', '--agent', 'claude'], noFence)
  check('claude hook exits 0 and prints nothing', h1.status === 0 && h1.stdout === '', JSON.stringify(h1.stdout))
  await sleep(1500)
  check('answer without a diagram is not pushed', turnsOf(ref) === 3)
  const last = vizpane(['push', '--last'])
  await waitFor(() => turnsOf(ref) === 4)
  check('push --last shows the stored answer', last.status === 0 && turnsOf(ref) === 4, last.stderr.trim())

  // 5. Hook: an answer with a fence is pushed by the detached worker.
  const withFence = JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e-b', turn_id: 't1', cwd: repo, last_assistant_message: GOOD })
  const h2 = vizpane(['hook', '--agent', 'codex'], withFence)
  check('codex hook exits 0 and prints {"continue":true}', h2.status === 0 && h2.stdout.trim() === '{"continue":true}', JSON.stringify(h2.stdout))
  await waitFor(() => turnsOf(ref) === 5)
  check('answer with a diagram is pushed by the hook', turnsOf(ref) === 5)

  // 6. Every example in the agent guide must render.
  const ex = skillExamples()
  const before = page(ref, 'viz.errors().length')
  vizpane(['push', '--file', fixture('examples', ex.text), '--title', 'viz-style examples'])
  await waitFor(() => turnsOf(ref) === 6)
  await sleep(600)
  check(`all ${ex.count} guide examples render`, ex.count >= 3 && page(ref, 'viz.errors().length') === before, JSON.stringify(page(ref, 'viz.errors()')).slice(0, 300))
  // The guide's examples are plain Mermaid plus `%% viz:` comments; the viewer must upgrade them.
  const card = '[...document.querySelectorAll(".turn")].find(t => t.textContent.includes("viz-style"))'
  check('viz comments become layer boxes', page(ref, `${card}.querySelectorAll(".dia svg g.cluster").length`) >= 3)
  check('viz comments become shapes and colours', page(ref, `${card}.querySelectorAll(".dia svg g.node.stream, .dia svg g.node.store").length`) >= 4 && page(ref, `${card}.querySelectorAll(".dia svg g.node path").length`) >= 4)
  check('sequence gets step numbers and phase bands', page(ref, `${card}.querySelectorAll(".dia svg .sequenceNumber").length`) >= 8 && page(ref, `${card}.querySelectorAll(".dia svg rect.rect").length`) >= 2)

  const shot = join(home, 'viewer.png')
  try { execFileSync(cmux, ['browser', ref, 'screenshot', '--out', shot], { timeout: 8000 }); console.log('screenshot: ' + shot) } catch { /* optional */ }

  // 7. Closing the viewer: next push reopens it and earlier cards come back from boot.js.
  execFileSync(cmux, ['close-surface', '--surface', ref], { timeout: 5000 })
  await waitFor(() => !findSurface())
  vizpane(['push', '--file', fixture('again', GOOD), '--title', 'after reopen'])
  ref = await waitFor(findSurface)
  check('viewer reopens on the next push', !!ref)
  if (ref) {
    await waitFor(() => pageRaw(ref, 'typeof viz === "object" && !!viz.ready'))
    check('earlier cards are restored', turnsOf(ref) === 7, String(turnsOf(ref)))
  }

  // 8. A page that runs an older version is reloaded by the next push, with its cards restored.
  if (ref) {
    pageRaw(ref, '(viz.version = "0.0.0", window.__beforeReload = 1)')
    const stale = vizpane(['push', '--file', fixture('stale', GOOD), '--title', 'after update'])
    check('push reports a reload for an outdated page', stale.stdout.trim().startsWith('reloaded'), stale.stdout.trim())
    await waitFor(() => pageRaw(ref, 'typeof viz === "object" && !!viz.ready && typeof window.__beforeReload === "undefined"'))
    check('reloaded page runs the installed version and keeps every card', page(ref, 'viz.version') !== '0.0.0' && turnsOf(ref) === 8, `${page(ref, 'viz.version')} / ${turnsOf(ref)}`)
  }

  // 9. off: stored only.
  vizpane(['off'])
  vizpane(['hook', '--agent', 'claude'], withFence)
  await sleep(1500)
  check('off suppresses automatic push', ref ? turnsOf(ref) === 8 : false)
  vizpane(['on'])
} catch (e) {
  check('e2e ran to completion', false, e.message)
} finally {
  if (!keep) {
    try { const r = findSurface(); if (r) execFileSync(cmux, ['close-surface', '--surface', r], { timeout: 5000 }) } catch { /* already closed */ }
    if (results.every(r => r.ok)) rmSync(home, { recursive: true, force: true })
    else console.log('state root kept for inspection: ' + home)
  } else {
    console.log('pane and state root kept: ' + home)
  }
}

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
