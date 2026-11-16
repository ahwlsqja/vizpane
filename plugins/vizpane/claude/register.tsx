import type { EngineInterface, Register } from 'claude-code'

import { fitCells, hashSource, mermaidBlocks, splitBlocks } from './inline-core.mjs'

// Draws each ```mermaid block of an assistant reply as a picture inside the transcript, where the
// block was: the reply is drawn in pieces around it (the engine's row, then Markdown). The hook point (AssistantMessage) and the cell layout follow natsukium/claude-code-figures-plugin (Apache-2.0). The
// picture comes from the viz-render helper (inline/render.swift), which runs Mermaid in the
// system WebKit; `vizpane renderer` builds it. Without the helper the reply is drawn unchanged.

const LEGACY_CELL = { width: 8, aspect: 2.1 }
const RENDER_TIMEOUT_MS = 20000
const CACHE_DAYS = 7

type Cell = { width: number; aspect: number }
type Picture = { ok: true; file: string; width: number; height: number } | { ok: false }
type Viewport = { columns: number; rows: number }
type Setup = { root: string; helper: string | null; cell: Cell }

const rendered = new Map<string, Promise<Picture>>()
let setup: Promise<Setup> | undefined

// The last line of stdout is the JSON answer; anything before it is noise.
function lastJson(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '')
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function start($: EngineInterface): Promise<Setup> {
  const home = await $.env.get('HOME')
  const root = (await $.env.get('VIZPANE_HOME')) || `${home ?? ''}/.local/state/vizpane`
  let helper: string | null = null
  let cell = LEGACY_CELL
  try {
    const built = lastJson((await $.process.run(['node', `${$.plugin.root}/bin/vizpane.mjs`, 'renderer'], { timeoutMs: 150000 })).stdout)
    if (built.ok === true && typeof built.path === 'string') helper = built.path
  } catch {
    // No helper: replies are drawn as before.
  }
  if (helper !== null) {
    try {
      const measured = lastJson((await $.process.run([helper, '--cell'], { timeoutMs: 10000 })).stdout)
      if (measured.ok === true && typeof measured.cellWidth === 'number' && typeof measured.cellAspect === 'number'
        && measured.cellWidth > 0 && measured.cellAspect > 0) {
        cell = { width: measured.cellWidth, aspect: measured.cellAspect }
      }
    } catch {
      // The fallback cell size stays.
    }
    await $.process
      .run(['find', `${root}/inline/cache`, '-type', 'f', '-mtime', `+${CACHE_DAYS}`, '-delete'], { timeoutMs: 10000 })
      .catch(() => undefined)
  }
  return { root, helper, cell }
}

const ready = ($: EngineInterface) => (setup ??= start($))

async function themeOf($: EngineInterface): Promise<'dark' | 'light'> {
  try {
    const row = (await $.config.list()).find((entry) => entry.key === 'theme')
    return String(row?.value ?? '').includes('light') ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

async function render($: EngineInterface, s: Setup, source: string, theme: string): Promise<Picture> {
  const id = `${hashSource(source)}-${theme}`
  const cache = `${s.root}/inline/cache`
  const png = `${cache}/${id}.png`
  const meta = `${cache}/${id}.json`
  try {
    if (await $.fs.exists(png)) {
      const size = JSON.parse(await $.fs.read(meta))
      if (size.width > 0 && size.height > 0) return { ok: true, file: png, width: size.width, height: size.height }
    }
  } catch {
    // No usable sidecar: render again.
  }
  try {
    const src = `${cache}/${id}.mmd`
    await $.fs.write(src, source)
    const ran = await $.process.run([s.helper as string, `${s.root}/inline/render.html`, src, png, theme], { timeoutMs: RENDER_TIMEOUT_MS })
    const info = lastJson(ran.stdout)
    if (info.ok !== true || typeof info.width !== 'number' || typeof info.height !== 'number') return { ok: false }
    await $.fs.write(meta, JSON.stringify({ width: info.width, height: info.height }))
    return { ok: true, file: png, width: info.width, height: info.height }
  } catch {
    return { ok: false }
  }
}

// One render per source and theme in a session; a reply drawn again joins the first render.
function picture($: EngineInterface, s: Setup, source: string, theme: string): Promise<Picture> {
  const key = `${theme}\0${source}`
  let pending = rendered.get(key)
  if (!pending) {
    pending = render($, s, source, theme)
    rendered.set(key, pending)
  }
  return pending
}

// The Enlarge button: the side pane draws the diagram as a vector picture and opens it enlarged.
// Outside cmux there is no pane, so the PNG opens in the system viewer instead.
async function enlarge($: EngineInterface, source: string, file: string, title: string, korean: boolean) {
  try {
    if (await $.env.get('CMUX_WORKSPACE_ID')) {
      const ran = await $.process.run(
        ['node', `${$.plugin.root}/bin/vizpane.mjs`, 'push', '--stdin', '--zoom', '--agent', 'claude', '--title', title],
        { stdin: '```mermaid\n' + source + '\n```\n', timeoutMs: 20000 })
      if (ran.exitCode === 0) {
        $.ui.toast(korean ? '옆 화면에 크게 열었습니다' : 'Opened enlarged in the side pane')
        return
      }
    }
    await $.process.run(['open', file], { timeoutMs: 10000 })
  } catch {
    $.ui.toast(korean ? '크게 열지 못했습니다' : 'Could not open the diagram')
  }
}

const viewportOf = (e: { viewport?: Viewport }): Viewport => ({
  columns: e.viewport?.columns ?? 80,
  rows: e.viewport?.rows ?? 40,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ready($)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const text = e.props.text
    const blocks = mermaidBlocks(text)
    if (blocks.length === 0) return next(e)
    const s = await ready($)
    if (s.helper === null) return next(e)

    const theme = await themeOf($)
    const drawn = await Promise.all(blocks.map(block => picture($, s, block.source, theme)))
    if (!drawn.some(d => d.ok)) return next(e)

    const korean = ((await $.env.get('LANG')) ?? '').startsWith('ko')
    const label = korean ? '도식' : 'diagram'
    // The reply is drawn in pieces, each picture where its block was. The first piece is the engine's
    // own row (it keeps the reply's bullet and how the engine marks it); the text after a picture is a
    // Markdown element, which the engine draws as it draws a reply. A block that could not be drawn
    // stays as code. A reply that opens with a diagram gets a one-line first row naming it.
    const parts = splitBlocks(text, drawn.map(d => d.ok))
    const { Box, Button, Image, Markdown, Text } = $.ui.resolve(e)
    const more = korean ? '크게 보기' : 'Enlarge'
    const viewport = viewportOf(e)
    const first = parts[0]
    const lead = 'text' in first ? first.text : `${label} ${first.block + 1}`
    const rows = [<Box key="viz-lead">{await next({ ...e, props: { ...e.props, text: lead } })}</Box>]
    for (const [k, part] of parts.entries()) {
      if (k === 0 && 'text' in part) continue
      if ('text' in part) {
        rows.push(<Box key={`viz-t${k}`} marginLeft={2} marginTop={1}><Markdown text={part.text} /></Box>)
        continue
      }
      const i = part.block
      const d = drawn[i]
      if (!d.ok) continue
      const box = fitCells(d.width, d.height, viewport, s.cell)
      rows.push(
        <Box key={`viz-${i}`} marginLeft={2} marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor>{label} {i + 1}  </Text>
            <Button key={`viz-more-${i}`} label={more}
              onPress={() => { void enlarge($, blocks[i].source, d.file, `${label} ${i + 1}`, korean) }} />
          </Box>
          <Image source={{ file: d.file, format: 'png' }} columns={box.columns} rows={box.rows} alt={`[${label} ${i + 1}]`} />
        </Box>,
      )
    }
    return <Box flexDirection="column">{rows}</Box>
  })
}
