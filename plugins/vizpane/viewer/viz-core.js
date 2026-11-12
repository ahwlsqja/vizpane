// DOM-free viewer logic. Classic script (no modules) so it loads from file://
// and can be evaluated by node:vm in tests.
(function (root) {
  'use strict'

  var PALETTE = {
    light: {
      stream: { fill: '#e3f1ec', stroke: '#2f7d63', color: '#123d2e' },
      store: { fill: '#e6eefc', stroke: '#3b6fd1', color: '#16305f' },
      proc: { fill: '#f1f3f6', stroke: '#6b7785', color: '#232b33' },
      decide: { fill: '#fff6d6', stroke: '#b08a00', color: '#3d3000' },
      fail: { fill: '#fdeaea', stroke: '#c0392b', color: '#6b1a12' },
      ok: { fill: '#eaf7ea', stroke: '#2e8b57', color: '#174d2f' },
      ext: { fill: '#f4eefb', stroke: '#7d5bbe', color: '#35215f' },
      bronze: { fill: '#f3e3d3', stroke: '#a9662b', color: '#4a2c10' },
      silver: { fill: '#e8ecf1', stroke: '#6b7785', color: '#232b33' },
      gold: { fill: '#fbf0c4', stroke: '#b08a00', color: '#3d3000' }
    },
    dark: {
      stream: { fill: '#1d3029', stroke: '#5fbf9c', color: '#c9eedf' },
      store: { fill: '#1f2a3d', stroke: '#7aa5f5', color: '#dbe6fb' },
      proc: { fill: '#262c36', stroke: '#8f9bab', color: '#e4e8ee' },
      decide: { fill: '#3a3217', stroke: '#d9b84a', color: '#f3e2a4' },
      fail: { fill: '#3a1f1f', stroke: '#f08a80', color: '#ffd9d4' },
      ok: { fill: '#1c3324', stroke: '#6cc48f', color: '#d2f0dd' },
      ext: { fill: '#2b2440', stroke: '#b39ae8', color: '#e6dcfa' },
      bronze: { fill: '#3a2a1c', stroke: '#d39a62', color: '#f1dcc7' },
      silver: { fill: '#2a3038', stroke: '#a7b2c0', color: '#e4e8ee' },
      gold: { fill: '#3a3217', stroke: '#e0c050', color: '#f6e9b0' }
    }
  }

  var VOCABULARY = ['stream', 'store', 'proc', 'decide', 'fail', 'ok', 'ext', 'bronze', 'silver', 'gold']
  var FIT_THRESHOLD = 0.7

  // Lines of the diagram body after an optional leading "---" front matter block.
  function bodyLines(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n')
    var m = /^\s*---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text)
    if (m) text = text.slice(m[0].length)
    return text.split('\n')
  }

  function diagramKind(src) {
    var lines = bodyLines(src)
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (line === '' || line.indexOf('%%') === 0) continue
      return line.split(/\s+/)[0].replace(/;+$/, '') || 'diagram'
    }
    return 'diagram'
  }

  function injectSemanticClasses(src, scheme) {
    var text = String(src == null ? '' : src)
    var kind = diagramKind(text)
    if (kind !== 'flowchart' && kind !== 'graph') return text

    var used = {}
    var re = /:::([A-Za-z_][\w-]*)/g
    var m
    while ((m = re.exec(text))) used[m[1]] = true
    re = /^[ \t]*class[ \t]+[^\n]*?[ \t]+([A-Za-z_][\w-]*)[ \t]*;?[ \t]*$/gm
    while ((m = re.exec(text))) used[m[1]] = true

    var defined = {}
    re = /^[ \t]*classDef[ \t]+([^\n]+)/gm
    while ((m = re.exec(text))) {
      var names = m[1].trim().split(/[ \t]+/)[0].split(',')
      for (var i = 0; i < names.length; i++) defined[names[i].trim()] = true
    }

    var colors = PALETTE[scheme === 'dark' ? 'dark' : 'light']
    var add = []
    for (var j = 0; j < VOCABULARY.length; j++) {
      var name = VOCABULARY[j]
      if (!used[name] || defined[name]) continue
      var c = colors[name]
      add.push('classDef ' + name + ' fill:' + c.fill + ',stroke:' + c.stroke + ',color:' + c.color + ',stroke-width:1.5px')
    }
    if (add.length === 0) return text
    return text.replace(/\s+$/, '') + '\n' + add.join('\n') + '\n'
  }

  // ---- upgradeSource: "%% viz:" directives -> Mermaid-only syntax ----
  var DIRECTIVE_RE = /^[ \t]*%%[ \t]*viz:[ \t]*(.*?)[ \t]*$/
  var ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
  var NODE_VERBS = {
    stream: { cls: 'stream', shape: 'h-cyl' },
    store: { cls: 'store', shape: 'cyl' },
    table: { cls: 'store', shape: 'lin-cyl' },
    // Sequence-diagram words that agents also use in flowcharts.
    database: { cls: 'store', shape: 'cyl' },
    queue: { cls: 'stream', shape: 'h-cyl' },
    proc: { cls: 'proc' },
    decide: { cls: 'decide' },
    fail: { cls: 'fail' },
    ok: { cls: 'ok' },
    ext: { cls: 'ext' }
  }
  var CLASS_ORDER = ['stream', 'store', 'proc', 'decide', 'fail', 'ok', 'ext']
  var TIERS = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' }
  var KIND_VERBS = { queue: 1, database: 1, control: 1, boundary: 1, entity: 1, collections: 1 }
  var BOX_COLORS = ['47,125,99', '59,111,209', '125,91,190', '176,138,0']
  var PHASE_COLORS = ['217,184,74', '46,158,107', '59,111,209', '125,91,190']
  var DECL_RE = /^([ \t]*)(participant|actor)[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+as[ \t]+(.+?))?[ \t]*$/

  function cleanTitle(s) {
    return String(s).replace(/"/g, "'").replace(/\\/g, '')
  }

  // tokens after the verb -> { ids: valid ids before "as", title: string|null }
  function parseArgs(tokens) {
    var ids = []
    var title = null
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'as') {
        title = tokens.slice(i + 1).join(' ')
        break
      }
      if (ID_RE.test(tokens[i])) ids.push(tokens[i])
    }
    return { ids: ids, title: title }
  }

  function readDirectives(lines) {
    var out = []
    for (var i = 0; i < lines.length; i++) {
      var m = DIRECTIVE_RE.exec(lines[i])
      if (!m) continue
      var tokens = m[1].split(/\s+/).filter(Boolean)
      if (!tokens.length) continue
      out.push({ line: i, verb: tokens[0], args: tokens.slice(1) })
    }
    return out
  }

  function upgradeFlowchart(text, lines) {
    var dirs = readDirectives(lines)
    var shapeOf = {}
    var shapeOrder = []
    var classOf = {}
    var mentioned = []
    var tiers = {}
    var groups = []
    var i, j
    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i]
      var a = parseArgs(d.args)
      if (NODE_VERBS.hasOwnProperty(d.verb)) {
        var nv = NODE_VERBS[d.verb]
        for (j = 0; j < a.ids.length; j++) {
          var id = a.ids[j]
          if (!classOf.hasOwnProperty(id)) mentioned.push(id)
          classOf[id] = nv.cls
          if (nv.shape && !shapeOf.hasOwnProperty(id)) {
            shapeOf[id] = nv.shape
            shapeOrder.push(id)
          }
        }
      } else if (TIERS.hasOwnProperty(d.verb)) {
        if (!a.ids.length) continue
        var t = tiers[d.verb]
        if (!t) t = tiers[d.verb] = { ids: [], title: a.title ? cleanTitle(a.title) : TIERS[d.verb] }
        for (j = 0; j < a.ids.length; j++) if (t.ids.indexOf(a.ids[j]) < 0) t.ids.push(a.ids[j])
      } else if (d.verb === 'group') {
        if (!a.ids.length) continue
        var n = groups.length + 1
        groups.push({ n: n, ids: a.ids, title: a.title ? cleanTitle(a.title) : 'Group ' + n })
      }
    }

    var add = []
    for (i = 0; i < shapeOrder.length; i++) add.push('  ' + shapeOrder[i] + '@{ shape: ' + shapeOf[shapeOrder[i]] + ' }')
    function block(name, title, ids) {
      add.push('  subgraph ' + name + '["' + title + '"]')
      for (var k = 0; k < ids.length; k++) add.push('    ' + ids[k])
      add.push('  end')
    }
    var tierNames = ['bronze', 'silver', 'gold']
    for (i = 0; i < tierNames.length; i++) {
      if (tiers[tierNames[i]]) block('viz_' + tierNames[i], tiers[tierNames[i]].title, tiers[tierNames[i]].ids)
    }
    for (i = 0; i < groups.length; i++) block('viz_group_' + groups[i].n, groups[i].title, groups[i].ids)
    for (i = 0; i < CLASS_ORDER.length; i++) {
      var ids = mentioned.filter(function (x) { return classOf[x] === CLASS_ORDER[i] })
      if (ids.length) add.push('  class ' + ids.join(',') + ' ' + CLASS_ORDER[i])
    }
    for (i = 0; i < tierNames.length; i++) {
      if (tiers[tierNames[i]]) add.push('  class viz_' + tierNames[i] + ' ' + tierNames[i])
    }
    if (!add.length) return text
    return text.replace(/\n+$/, '') + '\n' + add.join('\n') + (/\n$/.test(text) ? '\n' : '')
  }

  function upgradeSequence(text, lines) {
    var dirs = readDirectives(lines)
    var kindOf = {}
    var boxes = []
    var phaseSeq = []
    var i, j

    // Agents sometimes name a participant by its label instead of its id
    // (`queue Kafka` for `participant K as Kafka 브로커`). Accept a label's
    // first word when exactly one declaration has it; ids always win.
    var declIds = {}
    var byWord = {}
    for (i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('@{') >= 0) continue
      var dm = DECL_RE.exec(lines[i])
      if (!dm) continue
      declIds[dm[3]] = true
      var word = dm[4] ? dm[4].split(/\s+/)[0].toLowerCase() : ''
      if (word) byWord[word] = byWord.hasOwnProperty(word) ? null : dm[3]
    }
    function resolveAll(tokens) {
      var found = []
      for (var r = 0; r < tokens.length; r++) {
        var id = declIds.hasOwnProperty(tokens[r]) ? tokens[r] : (byWord[tokens[r].toLowerCase()] || null)
        if (id && found.indexOf(id) < 0) found.push(id)
      }
      return found
    }

    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i]
      if (KIND_VERBS.hasOwnProperty(d.verb)) {
        var ids = resolveAll(parseArgs(d.args).ids)
        for (j = 0; j < ids.length; j++) kindOf[ids[j]] = d.verb
      } else if (d.verb === 'box') {
        var a = parseArgs(d.args)
        var members = resolveAll(a.ids)
        if (members.length) boxes.push({ ids: members, title: a.title ? cleanTitle(a.title) : '' })
      } else if (d.verb === 'phase' || d.verb === 'end') {
        phaseSeq.push(d)
      }
    }

    // declarations (with kind rewrite applied)
    var decls = []
    for (i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('@{') >= 0) continue
      var m = DECL_RE.exec(lines[i])
      if (!m) continue
      var text2 = lines[i]
      if (m[2] === 'participant' && kindOf.hasOwnProperty(m[3])) {
        text2 = m[1] + 'participant ' + m[3] + '@{ "type": "' + kindOf[m[3]] + '"' +
          (m[4] ? ', "alias": "' + cleanTitle(m[4]) + '"' : '') + ' }'
      }
      decls.push({ line: i, indent: m[1], id: m[3], text: text2 })
    }

    var out = lines.slice()
    var removed = {}
    for (i = 0; i < decls.length; i++) out[decls[i].line] = decls[i].text

    // boxes
    var owner = {}
    for (i = 0; i < boxes.length; i++) {
      for (j = 0; j < boxes[i].ids.length; j++) {
        if (!owner.hasOwnProperty(boxes[i].ids[j])) owner[boxes[i].ids[j]] = i
      }
    }
    var anyMember = false
    for (i = 0; i < decls.length; i++) if (owner.hasOwnProperty(decls[i].id)) anyMember = true
    if (anyMember && decls.length) {
      var indent = decls[0].indent
      var block = []
      var done = {}
      var colorIdx = 0
      for (i = 0; i < decls.length; i++) {
        if (done[i]) continue
        var di = decls[i]
        if (!owner.hasOwnProperty(di.id)) {
          block.push(di.text)
          done[i] = true
          continue
        }
        var b = owner[di.id]
        var head = indent + 'box rgba(' + BOX_COLORS[colorIdx++ % BOX_COLORS.length] + ',.12)'
        if (boxes[b].title) head += ' ' + boxes[b].title
        block.push(head)
        for (j = i; j < decls.length; j++) {
          if (done[j] || owner[decls[j].id] !== b) continue
          done[j] = true
          block.push(indent + '  ' + decls[j].text.replace(/^[ \t]*/, ''))
        }
        block.push(indent + 'end')
      }
      for (i = 0; i < decls.length; i++) removed[decls[i].line] = true
      var first = decls[0].line
      var rebuilt = []
      for (i = 0; i < out.length; i++) {
        if (i === first) rebuilt = rebuilt.concat(block)
        if (!removed[i]) rebuilt.push(out[i])
      }
      out = rebuilt
    }

    // phases: need balanced, strictly alternating phase/end starting with phase
    var okPhase = phaseSeq.length > 0 && phaseSeq.length % 2 === 0
    for (i = 0; okPhase && i < phaseSeq.length; i++) {
      if (phaseSeq[i].verb !== (i % 2 === 0 ? 'phase' : 'end')) okPhase = false
    }
    if (okPhase) {
      // line numbers shift if boxes were rebuilt, so rewrite by matching directive text in order
      var k = 0
      for (i = 0; i < out.length && k < phaseSeq.length; i++) {
        var pm = DIRECTIVE_RE.exec(out[i])
        if (!pm) continue
        var verb = pm[1].split(/\s+/)[0]
        if (verb !== 'phase' && verb !== 'end') continue
        var ind = /^[ \t]*/.exec(out[i])[0]
        out[i] = verb === 'phase'
          ? ind + 'rect rgba(' + PHASE_COLORS[(k / 2) % PHASE_COLORS.length] + ',.14)'
          : ind + 'end'
        k++
      }
    }

    // autonumber
    var has = false
    for (i = 0; i < lines.length && !has; i++) {
      if (/^[ \t]*autonumber\b/.test(lines[i]) || /:[ \t]*(\d+[.)]|[①-⑳])/.test(lines[i])) has = true
    }
    if (!has) {
      for (i = 0; i < out.length; i++) {
        if (out[i].trim().indexOf('sequenceDiagram') === 0) {
          out.splice(i + 1, 0, '  autonumber')
          break
        }
      }
    }
    return out.join('\n')
  }

  function upgradeSource(src) {
    if (src == null) return ''
    var raw = String(src)
    try {
      var text = raw.replace(/\r\n/g, '\n')
      var kind = diagramKind(text)
      var lines = text.split('\n')
      if (kind === 'flowchart' || kind === 'graph') return upgradeFlowchart(text, lines)
      if (kind === 'sequenceDiagram') return upgradeSequence(text, lines)
      return text
    } catch (e) {
      return raw
    }
  }

  function fitDecision(bodyWidth, naturalWidth) {
    var body = Number(bodyWidth)
    var natural = Number(naturalWidth)
    if (!isFinite(natural) || natural <= 0) return 'fit'
    if (!isFinite(body) || body <= 0) return 'fit'
    return body / natural >= FIT_THRESHOLD ? 'fit' : 'scroll'
  }

  function agentLabel(agent) {
    if (agent === 'claude') return 'Claude Code'
    if (agent === 'codex') return 'Codex'
    var s = typeof agent === 'string' ? agent.trim() : ''
    return s || 'agent'
  }

  function timeLabel(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    var h = d.getHours()
    var mi = d.getMinutes()
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi
  }

  function cwdLabel(cwd) {
    if (typeof cwd !== 'string') return ''
    var parts = cwd.split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : ''
  }

  root.vizCore = {
    diagramKind: diagramKind,
    injectSemanticClasses: injectSemanticClasses,
    upgradeSource: upgradeSource,
    fitDecision: fitDecision,
    agentLabel: agentLabel,
    timeLabel: timeLabel,
    cwdLabel: cwdLabel,
    PALETTE: PALETTE
  }
})(globalThis)
