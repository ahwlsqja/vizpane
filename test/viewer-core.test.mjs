import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../plugins/vizpane/viewer/viz-core.js', import.meta.url))
vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
const core = globalThis.vizCore

test('diagramKind returns the first keyword', () => {
  assert.equal(core.diagramKind('flowchart LR\n  a --> b'), 'flowchart')
  assert.equal(core.diagramKind('graph TD\n  a --> b'), 'graph')
  assert.equal(core.diagramKind('sequenceDiagram\n  A->>B: hi'), 'sequenceDiagram')
  assert.equal(core.diagramKind('stateDiagram-v2\n  [*] --> A'), 'stateDiagram-v2')
})

test('diagramKind skips front matter, comments and blank lines', () => {
  assert.equal(core.diagramKind('---\ntitle: x\n---\nflowchart TB\n a-->b'), 'flowchart')
  assert.equal(core.diagramKind('%% note\n\n  %%{init: {}}%%\nsequenceDiagram\n'), 'sequenceDiagram')
  assert.equal(core.diagramKind('---\r\ntitle: x\r\n---\r\nerDiagram'), 'erDiagram')
  assert.equal(core.diagramKind(''), 'diagram')
  assert.equal(core.diagramKind('%% only a comment'), 'diagram')
})

test('injectSemanticClasses adds classDef for classes used with :::', () => {
  const out = core.injectSemanticClasses('flowchart LR\n  a[A]:::stream --> b[(B)]:::store', 'light')
  assert.match(out, /^classDef stream fill:#e3f1ec,stroke:#2f7d63,color:#123d2e,stroke-width:1.5px$/m)
  assert.match(out, /^classDef store fill:#e6eefc,stroke:#3b6fd1,color:#16305f,stroke-width:1.5px$/m)
  assert.doesNotMatch(out, /classDef (proc|fail|ok|gold)/)
  assert.ok(out.startsWith('flowchart LR\n  a[A]:::stream'))
})

test('injectSemanticClasses handles "class a,b name" lines', () => {
  const out = core.injectSemanticClasses('graph TD\n  a --> b\n  class a,b fail;\n', 'light')
  assert.match(out, /^classDef fail fill:#fdeaea,stroke:#c0392b,color:#6b1a12,stroke-width:1.5px$/m)
})

test('injectSemanticClasses skips classes the source defines itself', () => {
  const src = 'flowchart LR\n  a:::ok --> b:::fail\n  classDef ok fill:#fff\n  classDef x,fail fill:#000'
  assert.equal(core.injectSemanticClasses(src, 'light'), src)
})

test('injectSemanticClasses never writes a trailing semicolon', () => {
  const out = core.injectSemanticClasses('flowchart LR\n  a:::gold --> b:::silver --> c:::bronze', 'dark')
  for (const line of out.split('\n').filter(l => l.startsWith('classDef'))) {
    assert.doesNotMatch(line, /;\s*$/)
  }
})

test('injectSemanticClasses leaves non-flowchart diagrams and unused vocabulary alone', () => {
  const seq = 'sequenceDiagram\n  A->>B: x:::stream'
  assert.equal(core.injectSemanticClasses(seq, 'light'), seq)
  const plain = 'flowchart LR\n  a --> b'
  assert.equal(core.injectSemanticClasses(plain, 'light'), plain)
  const other = 'flowchart LR\n  a:::custom --> b'
  assert.equal(core.injectSemanticClasses(other, 'light'), other)
})

test('injectSemanticClasses uses the dark palette for "dark"', () => {
  const out = core.injectSemanticClasses('flowchart LR\n  a:::stream', 'dark')
  assert.match(out, /classDef stream fill:#1d3029,stroke:#5fbf9c,color:#c9eedf,stroke-width:1.5px/)
})

test('injectSemanticClasses keeps a front-matter block first', () => {
  const out = core.injectSemanticClasses('---\ntitle: t\n---\nflowchart LR\n  a:::proc --> b', 'light')
  assert.ok(out.startsWith('---\ntitle: t\n---\nflowchart LR'))
  assert.match(out, /classDef proc /)
  assert.equal(core.diagramKind(out), 'flowchart')
})

test('PALETTE has all ten classes in both schemes', () => {
  for (const scheme of ['light', 'dark']) {
    assert.deepEqual(
      Object.keys(core.PALETTE[scheme]).sort(),
      ['bronze', 'decide', 'ext', 'fail', 'gold', 'ok', 'proc', 'silver', 'store', 'stream']
    )
  }
})

test('fitDecision uses a 0.7 threshold', () => {
  assert.equal(core.fitDecision(700, 1000), 'fit')
  assert.equal(core.fitDecision(699, 1000), 'scroll')
  assert.equal(core.fitDecision(900, 600), 'fit')
  assert.equal(core.fitDecision(567, 1178), 'scroll')
})

test('fitDecision falls back to fit for unusable widths', () => {
  assert.equal(core.fitDecision(500, 0), 'fit')
  assert.equal(core.fitDecision(500, NaN), 'fit')
  assert.equal(core.fitDecision(500, undefined), 'fit')
  assert.equal(core.fitDecision(0, 1000), 'fit')
  assert.equal(core.fitDecision(NaN, 1000), 'fit')
})

test('agentLabel', () => {
  assert.equal(core.agentLabel('claude'), 'Claude Code')
  assert.equal(core.agentLabel('codex'), 'Codex')
  assert.equal(core.agentLabel('gemini'), 'gemini')
  assert.equal(core.agentLabel(undefined), 'agent')
  assert.equal(core.agentLabel('  '), 'agent')
})

test('timeLabel renders local HH:MM', () => {
  assert.equal(core.timeLabel(new Date(2026, 10, 13, 9, 5).toISOString()), '09:05')
  assert.equal(core.timeLabel(new Date(2026, 10, 13, 23, 41).toISOString()), '23:41')
  assert.equal(core.timeLabel('not a date'), '')
  assert.equal(core.timeLabel(undefined), '')
})

test('cwdLabel returns the last path segment', () => {
  assert.equal(core.cwdLabel('/Users/x/project'), 'project')
  assert.equal(core.cwdLabel('/Users/x/project/'), 'project')
  assert.equal(core.cwdLabel('C:\\work\\app'), 'app')
  assert.equal(core.cwdLabel('/'), '')
  assert.equal(core.cwdLabel(null), '')
})

// ---- upgradeSource ----

test('upgradeSource leaves a flowchart without directives untouched', () => {
  const src = 'flowchart LR\n  a --> b\n'
  assert.equal(core.upgradeSource(src), src)
})

test('upgradeSource ignores other diagram kinds', () => {
  const src = 'stateDiagram-v2\n  %% viz: stream a\n  [*] --> A\n'
  assert.equal(core.upgradeSource(src), src)
  const er = 'erDiagram\n  %% viz: box a\n  A ||--o{ B : has\n'
  assert.equal(core.upgradeSource(er), er)
})

test('upgradeSource handles null and non-string input', () => {
  assert.equal(core.upgradeSource(null), '')
  assert.equal(core.upgradeSource(undefined), '')
  assert.equal(core.upgradeSource(42), '42')
})

test('upgradeSource appends shapes and classes for node verbs', () => {
  const src = [
    'flowchart LR',
    '  %% viz: stream topic',
    '  %% viz: store db',
    '  %% viz: proc worker',
    '  topic --> worker --> db',
    ''
  ].join('\n')
  const out = core.upgradeSource(src)
  assert.equal(
    out,
    src +
      [
        '  topic@{ shape: h-cyl }',
        '  db@{ shape: cyl }',
        '  class topic stream',
        '  class db store',
        '  class worker proc'
      ].join('\n') +
      '\n'
  )
})

test('upgradeSource: first shape wins, last class wins', () => {
  const src = 'flowchart LR\n  %% viz: stream a\n  %% viz: fail a\n  a --> b\n'
  const out = core.upgradeSource(src)
  assert.match(out, /^ {2}a@\{ shape: h-cyl \}$/m)
  assert.match(out, /^ {2}class a fail$/m)
  assert.doesNotMatch(out, /class a stream/)
})

test('upgradeSource: table maps to lin-cyl with store class', () => {
  const out = core.upgradeSource('flowchart LR\n  %% viz: table t1 t2\n  t1 --> t2\n')
  assert.match(out, /^ {2}t1@\{ shape: lin-cyl \}$/m)
  assert.match(out, /^ {2}t2@\{ shape: lin-cyl \}$/m)
  assert.match(out, /^ {2}class t1,t2 store$/m)
})

test('upgradeSource: medallion subgraphs with default and custom titles', () => {
  const src = [
    'graph TD',
    '  %% viz: bronze raw1 raw2',
    '  %% viz: silver clean as Cleaned Layer',
    '  %% viz: gold mart',
    '  raw1 --> clean --> mart',
    ''
  ].join('\n')
  const out = core.upgradeSource(src)
  const added = out.slice(src.length)
  assert.equal(
    added,
    [
      '  subgraph viz_bronze["Bronze"]',
      '    raw1',
      '    raw2',
      '  end',
      '  subgraph viz_silver["Cleaned Layer"]',
      '    clean',
      '  end',
      '  subgraph viz_gold["Gold"]',
      '    mart',
      '  end',
      '  class viz_bronze bronze',
      '  class viz_silver silver',
      '  class viz_gold gold'
    ].join('\n') + '\n'
  )
})

test('upgradeSource: repeated medallion verb merges ids, first title wins', () => {
  const out = core.upgradeSource('flowchart LR\n  %% viz: gold a as One\n  %% viz: gold b as Two\n  a --> b\n')
  assert.match(out, /subgraph viz_gold\["One"\]\n {4}a\n {4}b\n {2}end/)
  assert.doesNotMatch(out.split('\n').filter((l) => !l.includes('viz:')).join('\n'), /Two/)
})

test('upgradeSource: group verb numbers groups and has no class line', () => {
  const src = 'flowchart LR\n  %% viz: group a b as 수집 계층\n  %% viz: group c\n  a --> b --> c\n'
  const out = core.upgradeSource(src)
  assert.match(out, /^ {2}subgraph viz_group_1\["수집 계층"\]\n {4}a\n {4}b\n {2}end$/m)
  assert.match(out, /^ {2}subgraph viz_group_2\["Group 2"\]\n {4}c\n {2}end$/m)
  assert.doesNotMatch(out, /class viz_group/)
})

test('upgradeSource ignores invalid ids and groups without ids', () => {
  const src = 'flowchart LR\n  %% viz: stream 1bad ok-id good\n  %% viz: group 9x !\n  good --> x\n'
  const out = core.upgradeSource(src)
  assert.match(out, /^ {2}good@\{ shape: h-cyl \}$/m)
  assert.match(out, /^ {2}class good stream$/m)
  assert.doesNotMatch(out.split('\n').filter((l) => !l.includes('viz:')).join('\n'), /1bad|ok-id|subgraph/)
})

test('upgradeSource ignores unknown verbs', () => {
  const src = 'flowchart LR\n  %% viz: wobble a\n  a --> b\n'
  assert.equal(core.upgradeSource(src), src)
})

test('upgradeSource escapes quotes and backslashes in titles', () => {
  const out = core.upgradeSource('flowchart LR\n  %% viz: group a as say "hi" the\\re\n  a --> b\n')
  assert.match(out, /subgraph viz_group_1\["say 'hi' there"\]/)
})

test('upgradeSource keeps front matter first', () => {
  const src = '---\ntitle: T\n---\nflowchart LR\n  %% viz: ok a\n  a --> b\n'
  const out = core.upgradeSource(src)
  assert.ok(out.startsWith('---\ntitle: T\n---\nflowchart LR\n'))
  assert.match(out, /^ {2}class a ok$/m)
})

test('upgradeSource normalises CRLF', () => {
  const out = core.upgradeSource('flowchart LR\r\n  %% viz: ok a\r\n  a --> b\r\n')
  assert.doesNotMatch(out, /\r/)
})

test('upgradeSource rewrites sequence participant kinds', () => {
  const src = [
    'sequenceDiagram',
    '  %% viz: queue Q',
    '  %% viz: database DB',
    '  participant Q as Job Queue',
    '  participant DB',
    '  actor U',
    '  %% viz: entity E',
    '  participant E@{ "type": "boundary" }',
    '  U->>Q: go',
    ''
  ].join('\n')
  const out = core.upgradeSource(src)
  assert.match(out, /^ {2}participant Q@\{ "type": "queue", "alias": "Job Queue" \}$/m)
  assert.match(out, /^ {2}participant DB@\{ "type": "database" \}$/m)
  assert.match(out, /^ {2}actor U$/m)
  assert.match(out, /^ {2}participant E@\{ "type": "boundary" \}$/m)
})

test('upgradeSource escapes quotes in participant aliases', () => {
  const out = core.upgradeSource('sequenceDiagram\n  %% viz: control C\n  participant C as The "Bo\\ss"\n  C->>C: x\n')
  assert.match(out, /participant C@\{ "type": "control", "alias": "The 'Boss'" \}/)
})

test('upgradeSource rebuilds boxes in declaration order', () => {
  const src = [
    'sequenceDiagram',
    '  %% viz: box A C as Backend',
    '  %% viz: box D',
    '  participant A',
    '  participant B',
    '  participant C as See',
    '  participant D',
    '  A->>B: hi',
    ''
  ].join('\n')
  const out = core.upgradeSource(src)
  const body = out.split('\n').filter((l) => !l.includes('%% viz'))
  assert.deepEqual(body.slice(0, 11), [
    'sequenceDiagram',
    '  autonumber',
    '  box rgba(47,125,99,.12) Backend',
    '    participant A',
    '    participant C as See',
    '  end',
    '  participant B',
    '  box rgba(59,111,209,.12)',
    '    participant D',
    '  end',
    '  A->>B: hi'
  ])
})

test('upgradeSource applies kind rewrites inside boxes and cycles colours', () => {
  const lines = ['sequenceDiagram']
  const ids = ['a', 'b', 'c', 'd', 'e']
  for (const id of ids) lines.push('  %% viz: box ' + id)
  lines.push('  %% viz: queue a')
  for (const id of ids) lines.push('  participant ' + id)
  const out = core.upgradeSource(lines.join('\n') + '\n')
  assert.match(out, /box rgba\(47,125,99,\.12\)\n {4}participant a@\{ "type": "queue" \}/)
  const colours = [...out.matchAll(/box rgba\((\d+,\d+,\d+),/g)].map((m) => m[1])
  assert.deepEqual(colours, ['47,125,99', '59,111,209', '125,91,190', '176,138,0', '47,125,99'])
})

test('upgradeSource ignores boxes without declared members', () => {
  const src = 'sequenceDiagram\n  %% viz: box Z\n  participant A\n  A->>A: x: 1. y\n'
  assert.equal(core.upgradeSource(src), src)
})

test('upgradeSource turns balanced phase/end into rect blocks', () => {
  const src = [
    'sequenceDiagram',
    '  participant A',
    '  participant B',
    '  %% viz: phase One',
    '  A->>B: x',
    '    %% viz: end',
    '  %% viz: phase Two',
    '  B->>A: y',
    '  %% viz: end',
    ''
  ].join('\n')
  const out = core.upgradeSource(src)
  assert.match(out, /^ {2}rect rgba\(217,184,74,\.14\)\n {2}A->>B: x\n {4}end\n {2}rect rgba\(46,158,107,\.14\)\n {2}B->>A: y\n {2}end$/m)
  assert.doesNotMatch(out, /viz: (phase|end)/)
})

test('upgradeSource leaves unbalanced phase/end untouched', () => {
  const src = 'sequenceDiagram\n  autonumber\n  %% viz: phase One\n  A->>B: x\n'
  assert.equal(core.upgradeSource(src), src)
  const nested = 'sequenceDiagram\n  autonumber\n  %% viz: phase a\n  %% viz: phase b\n  %% viz: end\n  %% viz: end\n'
  assert.equal(core.upgradeSource(nested), nested)
})

test('upgradeSource inserts autonumber unless present or hand-numbered', () => {
  const plain = core.upgradeSource('sequenceDiagram\n  A->>B: poll\n')
  assert.equal(plain, 'sequenceDiagram\n  autonumber\n  A->>B: poll\n')
  const has = 'sequenceDiagram\n  autonumber\n  A->>B: poll\n'
  assert.equal(core.upgradeSource(has), has)
  const n1 = 'sequenceDiagram\n  A->>B: 1. poll\n'
  assert.equal(core.upgradeSource(n1), n1)
  const n2 = 'sequenceDiagram\n  A->>B: ① poll\n'
  assert.equal(core.upgradeSource(n2), n2)
})

test('upgradeSource output feeds injectSemanticClasses', () => {
  const out = core.injectSemanticClasses(core.upgradeSource('flowchart LR\n  %% viz: stream topic\n  topic --> b\n'), 'light')
  assert.match(out, /^classDef stream /m)
})

// ---- label references in sequence directives ----

test('upgradeSource accepts the first word of a label where an id was expected', () => {
  const src = 'sequenceDiagram\n  %% viz: queue Kafka\n  %% viz: box consumer clickhouse as 적재\n' +
    '  participant K as Kafka 브로커\n  participant C as Consumer 앱\n  participant CH as ClickHouse\n  C->>K: poll\n'
  const out = core.upgradeSource(src)
  assert.ok(out.includes('participant K@{ "type": "queue", "alias": "Kafka 브로커" }'), out)
  assert.ok(/box rgba\(47,125,99,\.12\) 적재\n\s+participant C as Consumer 앱\n\s+participant CH as ClickHouse\n\s+end/.test(out), out)
})

test('upgradeSource ignores a label word shared by two participants, and ids win over labels', () => {
  const shared = 'sequenceDiagram\n  %% viz: queue Kafka\n  participant A as Kafka 입력\n  participant B as Kafka 출력\n  A->>B: x\n'
  assert.ok(!core.upgradeSource(shared).includes('@{'))
  const idWins = 'sequenceDiagram\n  %% viz: database Sink\n  participant Sink as Kafka\n  participant DB as Sink 테이블\n  Sink->>DB: x\n'
  const out = core.upgradeSource(idWins)
  assert.ok(out.includes('participant Sink@{ "type": "database", "alias": "Kafka" }'), out)
  assert.ok(out.includes('participant DB as Sink 테이블'), out)
})

test('upgradeSource treats database and queue in a flowchart as store and stream', () => {
  const out = core.upgradeSource('flowchart TB\n  %% viz: database pg\n  %% viz: queue k\n  pg["PostgreSQL"] --> k["Kafka"]\n')
  assert.ok(out.includes('pg@{ shape: cyl }') && out.includes('k@{ shape: h-cyl }'), out)
  assert.ok(out.includes('class k stream') && out.includes('class pg store'), out)
})
