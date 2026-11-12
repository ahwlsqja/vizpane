#!/usr/bin/env node
// Refreshes plugins/vizpane/viewer/vendor from npm. Installs into a temp
// directory so the repository never gets node_modules or a lockfile.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(repo, 'plugins', 'vizpane', 'viewer', 'vendor')
// Exact versions: the viewer is tested against these builds.
const packages = ['mermaid@12.3.0', 'marked@18.2.0', 'dompurify@3.4.17']
const files = [
  ['mermaid', 'dist/mermaid.min.js', 'mermaid.min.js'],
  ['marked', 'lib/marked.umd.js', 'marked.umd.js'],
  ['dompurify', 'dist/purify.min.js', 'purify.min.js'],
]

const tmp = mkdtempSync(join(tmpdir(), 'vizpane-vendor-'))
try {
  writeFileSync(join(tmp, 'package.json'), '{"private":true}\n')
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', ...packages], {
    cwd: tmp, stdio: 'inherit',
  })
  mkdirSync(dest, { recursive: true })
  const versions = {}
  for (const [pkg, from, to] of files) {
    copyFileSync(join(tmp, 'node_modules', pkg, from), join(dest, to))
    versions[pkg] = JSON.parse(readFileSync(join(tmp, 'node_modules', pkg, 'package.json'), 'utf8')).version
    // Ship each library's licence text next to its bundle.
    const licence = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].find((n) => existsSync(join(tmp, 'node_modules', pkg, n)))
    if (!licence) throw new Error(`no licence file found in ${pkg}`)
    mkdirSync(join(dest, 'licenses'), { recursive: true })
    copyFileSync(join(tmp, 'node_modules', pkg, licence), join(dest, 'licenses', `${pkg}-LICENSE.txt`))
  }
  writeFileSync(join(dest, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n')
  console.log('vendored', versions)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
