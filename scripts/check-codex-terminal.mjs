#!/usr/bin/env node
// Checks that every Mermaid example in the viz-style guide is accepted by the text renderer built
// into the Codex TUI, and reports how many terminal columns each one needs.
//
// It downloads the `codex-rs/mermaid` crate from openai/codex at the tag of the installed Codex
// version and builds it in a temp directory. Needs `gh` (authenticated), `cargo`, and `codex`.
//
// Without --width it only checks that the syntax is accepted; with --width it also fails examples
// that need more columns.
//
//   node scripts/check-codex-terminal.mjs [--width 100] [--tag rust-v0.167.2] [file.md ...]
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback }
const width = Number(opt('--width', '0'))
let tag = opt('--tag', '')
const files = args.length ? args : [join(repo, 'plugins/vizpane/skills/viz-style/SKILL.md')]

if (!tag) {
  const v = execFileSync('codex', ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)
  if (!v) { console.error('cannot read the installed Codex version; pass --tag'); process.exit(2) }
  tag = 'rust-v' + v[0]
}

// Source and build files live in separate directories: the downloaded crate is never edited.
const src = mkdtempSync(join(tmpdir(), 'codex-mermaid-src-'))
const build = mkdtempSync(join(tmpdir(), 'codex-mermaid-build-'))
const SOURCES = ['src/lib.rs', 'src/draw.rs', 'src/output.rs', 'src/parse.rs', 'src/relations.rs', 'src/sequence.rs', 'src/state.rs', 'src/syntax.rs', 'examples/render.rs']
let failed = 0
try {
  mkdirSync(join(src, 'src')); mkdirSync(join(src, 'examples'))
  for (const f of SOURCES) {
    const b64 = execFileSync('gh', ['api', `repos/openai/codex/contents/codex-rs/mermaid/${f}?ref=${tag}`, '--jq', '.content'], { encoding: 'utf8' })
    writeFileSync(join(src, f), Buffer.from(b64, 'base64'))
  }
  writeFileSync(join(build, 'Cargo.toml'), `[package]
name = "codex-mermaid"
version = "0.0.0"
edition = "2024"
publish = false

[lib]
name = "codex_mermaid"
path = ${JSON.stringify(join(src, 'src/lib.rs'))}
doctest = false

[[example]]
name = "render"
path = ${JSON.stringify(join(src, 'examples/render.rs'))}

[dependencies]
unicode-width = "0.2"
`)
  const b = spawnSync('cargo', ['build', '--release', '--example', 'render', '--quiet'], { cwd: build, encoding: 'utf8' })
  if (b.status !== 0) { console.error(b.stderr); process.exit(2) }
  const bin = join(build, 'target/release/examples/render')

  // Display cells: East Asian wide and fullwidth characters take two.
  const cells = line => [...line].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)
  const render = (code, w) => spawnSync(bin, [String(w)], { input: code, encoding: 'utf8' })

  console.log(`Codex terminal renderer ${tag}` + (width ? `, limit ${width} columns` : ', syntax check only'))
  for (const file of files) {
    const blocks = [...readFileSync(file, 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1])
    blocks.forEach((code, i) => {
      const kind = (code.split('\n').find(l => l.trim() && !l.trim().startsWith('%%')) || '').trim().split(/\s+/)[0]
      const wide = render(code, 100000)
      if (wide.status !== 0) {
        failed++
        console.log(`FAIL #${i + 1} ${kind}: ${wide.stderr.trim() || 'error'}`)
        return
      }
      const need = Math.max(...wide.stdout.split('\n').map(cells))
      const fits = width ? render(code, width).status === 0 : true
      if (!fits) failed++
      console.log(`${fits ? 'ok  ' : 'FAIL'} #${i + 1} ${kind}: needs ${need} columns${fits ? '' : ` (limit ${width})`}`)
    })
  }
} finally {
  rmSync(src, { recursive: true, force: true })
  rmSync(build, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
