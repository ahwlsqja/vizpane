// Viewer runtime. Classic script: the page runs from file:// where modules,
// fetch() and anything outside the page's directory tree are blocked.
(function () {
  'use strict'

  var VERSION = '0.4.1'

  var core = globalThis.vizCore
  // ?theme=light|dark overrides the system colour scheme (set through VIZPANE_THEME).
  var forced = new URLSearchParams(location.search).get('theme')
  if (forced !== 'light' && forced !== 'dark') forced = null
  if (forced) document.documentElement.setAttribute('data-theme', forced)
  var scheme = forced || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

  // Interface text follows the browser language; ?lang=en|ko overrides it.
  var STRINGS = {
    en: {
      count: function (n) { return n + (n === 1 ? ' answer' : ' answers') },
      only: 'Diagrams only', onlyTitle: 'Hide the text and show diagrams only', empty: 'No answers yet.',
      source: 'Source', drawing: 'Rendering...', failed: 'Could not render this diagram: ',
      blocked: 'image blocked', closeZoom: 'Click to close'
    },
    ko: {
      count: function (n) { return n + '개' },
      only: '도식만', onlyTitle: '본문을 접고 도식만 본다', empty: '아직 받은 답변이 없습니다.',
      source: '원본', drawing: '그리는 중...', failed: '도식을 그리지 못했습니다: ',
      blocked: '이미지 차단', closeZoom: '닫으려면 클릭'
    }
  }
  var lang = String(new URLSearchParams(location.search).get('lang') || navigator.language || 'en').toLowerCase().indexOf('ko') === 0 ? 'ko' : 'en'
  var T = STRINGS[lang]
  document.documentElement.lang = lang
  var FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif'

  var THEMES = {
    light: {
      background: '#ffffff', primaryColor: '#eef3fb', primaryTextColor: '#16305f', primaryBorderColor: '#3b6fd1',
      lineColor: '#5b6676', secondaryColor: '#e3f1ec', tertiaryColor: '#fff6d6',
      noteBkgColor: '#fff6d6', noteTextColor: '#3d3000', noteBorderColor: '#d9b84a',
      actorBkg: '#eef3fb', actorBorder: '#3b6fd1', actorTextColor: '#16305f', actorLineColor: '#b9c2cf',
      signalColor: '#2b3442', signalTextColor: '#2b3442', labelBoxBkgColor: '#eef3fb', labelBoxBorderColor: '#3b6fd1',
      labelTextColor: '#16305f', loopTextColor: '#16305f', activationBkgColor: '#dfe9fb', activationBorderColor: '#3b6fd1',
      sequenceNumberColor: '#ffffff'
    },
    dark: {
      background: '#1a1e25', primaryColor: '#1f2a3d', primaryTextColor: '#dbe6fb', primaryBorderColor: '#7aa5f5',
      lineColor: '#9aa5b5', secondaryColor: '#1d3029', tertiaryColor: '#3a3217',
      noteBkgColor: '#3a3217', noteTextColor: '#f3e2a4', noteBorderColor: '#a8892b',
      actorBkg: '#1f2a3d', actorBorder: '#7aa5f5', actorTextColor: '#dbe6fb', actorLineColor: '#4a5566',
      signalColor: '#cfd6e0', signalTextColor: '#cfd6e0', labelBoxBkgColor: '#1f2a3d', labelBoxBorderColor: '#7aa5f5',
      labelTextColor: '#dbe6fb', loopTextColor: '#dbe6fb', activationBkgColor: '#2a3b59', activationBorderColor: '#7aa5f5',
      sequenceNumberColor: '#13161b'
    }
  }

  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base',
      // Keys a diagram's own init/front matter may not change. themeCSS and fonts could pull remote resources.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
        'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily'],
      themeVariables: Object.assign({}, THEMES[scheme], { fontFamily: FONT, fontSize: '14px' }),
      // wrap is off: automatic wrapping broke identifiers mid-token; wide diagrams scroll instead.
      // Compact participant boxes: the defaults (150x65) made even three participants wider than a half-window pane.
      sequence: { mirrorActors: false, width: 112, height: 46, actorMargin: 22, boxMargin: 8, noteMargin: 8, messageMargin: 30, wrap: false, useMaxWidth: true },
      flowchart: { curve: 'basis', useMaxWidth: true }
    })
  }

  // Answers are untrusted and may carry text fetched from the web. A meta Content-Security-Policy is
  // not enforced for file:// pages in the cmux browser (verified: a remote image still loaded), so
  // remote resources are removed here instead: nothing in an answer may trigger a network request.
  var blocked = 0
  var PURIFY = {
    FORBID_TAGS: ['style', 'link', 'base', 'meta', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source',
      'track', 'picture', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'action', 'formaction']
  }
  var INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/i
  if (typeof DOMPurify !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.nodeName !== 'IMG') return
      var src = node.getAttribute('src') || ''
      if (INLINE_IMAGE.test(src)) return
      blocked++
      node.setAttribute('data-blocked', src)
      node.removeAttribute('src')
    })
  }

  // Mermaid output is parsed in an inert document so nothing loads before external references are removed.
  function scrubSvg(svgText) {
    var doc = new DOMParser().parseFromString(svgText, 'text/html')
    doc.querySelectorAll('image, img, use, feImage').forEach(function (n) {
      var href = n.getAttribute('href') || n.getAttribute('xlink:href') || n.getAttribute('src') || ''
      if (href.charAt(0) === '#' || INLINE_IMAGE.test(href)) return
      blocked++
      n.remove()
    })
    doc.querySelectorAll('style').forEach(function (n) {
      n.textContent = n.textContent
        .replace(/@import[^;]*;?/gi, '')
        .replace(/url\(\s*(['"]?)(?!#|data:)[^)]*\)/gi, 'none')
    })
    var svg = doc.body.querySelector('svg')
    return svg ? document.importNode(svg, true) : null
  }

  // The workspace id becomes part of a script path, so it gets the same
  // character restriction the CLI applies.
  var ws = (new URLSearchParams(location.search).get('ws') || 'no-cmux').replace(/[^A-Za-z0-9_-]/g, '_')
  var TURN_PATH = /^turns\/turn-\d{4,}\.js$/

  var timeline = document.getElementById('timeline')
  var zoom = document.getElementById('zoom')
  // How long after a push its zoom request still counts (the pane may first have to open).
  var ZOOM_FRESH_MS = 30000
  var cards = new Map()
  var errors = []
  var seq = 0
  var scriptSeq = 0
  var booted = false
  var bootChain = Promise.resolve()
  var queue = Promise.resolve()

  // The workspace id is a UUID: keep it out of sight, available as a tooltip.
  document.getElementById('ws').textContent = 'vizpane'
  document.getElementById('count').textContent = T.count(0)
  document.getElementById('btn-only').textContent = T.only
  document.getElementById('btn-only').title = T.onlyTitle
  document.getElementById('empty').textContent = T.empty
  document.getElementById('zoom').title = T.closeZoom
  document.getElementById('ws').title = ws
  document.title = 'vizpane'

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  // Mermaid renders one diagram at a time; cards are built synchronously and
  // only their diagrams wait in this queue.
  function enqueue(fn) {
    var p = queue.then(fn)
    queue = p.catch(function () {})
    return p
  }

  function setCount() {
    document.getElementById('count').textContent = T.count(viz.turns)
  }

  function removeStrayMermaid(id) {
    var ids = [id, 'd' + id]
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i])
      if (node && node.parentNode === document.body) node.remove()
    }
    document.querySelectorAll('body > [id^="dviz-d"]').forEach(function (n) { n.remove() })
  }

  function buildDiagram(code) {
    var src = code.textContent
    var dia = el('div', 'dia')
    dia._vizSrc = src
    var bar = el('div', 'dia-bar')
    bar.appendChild(el('span', 'kind', core.diagramKind(src)))
    bar.appendChild(el('span', 'spacer'))
    var btn = el('button', null, T.source)
    btn.type = 'button'
    btn.setAttribute('data-act', 'src')
    btn.setAttribute('aria-pressed', 'false')
    bar.appendChild(btn)
    dia.appendChild(bar)
    dia.appendChild(el('div', 'dia-body pending', T.drawing))
    var pre = el('pre', 'dia-src')
    pre.appendChild(el('code', null, src))
    dia.appendChild(pre)
    return dia
  }

  function applyWidth(body) {
    var svg = body.querySelector('svg')
    var natural = 0
    if (svg && svg.viewBox && svg.viewBox.baseVal) natural = svg.viewBox.baseVal.width
    body.setAttribute('data-natural', String(natural || 0))
    if (!svg) return
    var cs = getComputedStyle(body)
    var inner = body.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    var mode = core.fitDecision(inner, natural)
    body.classList.remove('fit', 'scroll')
    body.classList.add(mode)
    if (mode === 'fit') {
      svg.style.width = '100%'
      svg.style.maxWidth = natural > 0 ? natural + 'px' : '100%'
    } else {
      svg.style.width = natural + 'px'
      svg.style.maxWidth = 'none'
    }
  }

  async function renderDiagram(dia, turnId, index) {
    var body = dia.querySelector('.dia-body')
    var id = 'viz-d' + (++seq)
    try {
      var out = await mermaid.render(id, core.injectSemanticClasses(core.upgradeSource(dia._vizSrc), scheme))
      var svg = scrubSvg(out.svg)
      if (!svg) throw new Error('Mermaid returned no SVG')
      body.classList.remove('pending')
      body.textContent = ''
      body.appendChild(svg)
      applyWidth(body)
    } catch (e) {
      var message = String((e && e.message) || e)
      removeStrayMermaid(id)
      errors.push({ id: turnId, diagram: index, message: message })
      var box = el('div', 'dia-err', T.failed + message)
      body.replaceWith(box)
      dia.classList.add('show-src')
      var btn = dia.querySelector('button[data-act="src"]')
      if (btn) btn.setAttribute('aria-pressed', 'true')
    }
  }

  function buildCard(turn, id) {
    var card = el('section', 'turn new')
    card.setAttribute('data-id', id)
    var head = el('div', 'turn-head')
    head.appendChild(el('span', 'badge', core.agentLabel(turn.agent)))
    var t = core.timeLabel(turn.time)
    if (t) head.appendChild(el('span', null, t))
    // The title is not shown: without a heading it is just the first line, which the body repeats right below.
    var cwd = core.cwdLabel(turn.cwd)
    if (cwd) head.appendChild(el('span', null, cwd))
    card.appendChild(head)

    var md = el('div', 'md')
    // Order matters: untrusted Markdown -> HTML -> sanitize -> only then look
    // for diagram blocks. The diagram source is re-read with textContent.
    var html = marked.parse(String(turn.markdown == null ? '' : turn.markdown), { gfm: true })
    md.innerHTML = DOMPurify.sanitize(html, PURIFY)
    md.querySelectorAll('img[data-blocked]').forEach(function (img) {
      img.replaceWith(el('span', 'img-blocked', '[' + T.blocked + ': ' + (img.getAttribute('alt') || img.getAttribute('data-blocked')) + ']'))
    })
    var codes = md.querySelectorAll('pre > code')
    var dias = []
    codes.forEach(function (code) {
      if (!/(^|\s)language-mermaid(\s|$)/i.test(code.className)) return
      var dia = buildDiagram(code)
      code.parentNode.replaceWith(dia)
      dias.push(dia)
    })
    card.appendChild(md)
    card.addEventListener('animationend', function () { card.classList.remove('new') })
    return { card: card, dias: dias }
  }

  // Cards are ordered by numeric id so a push that arrives while the boot list
  // is still loading lands in the right place.
  function place(card, id) {
    var n = parseInt(id, 10)
    var before = null
    if (!isNaN(n)) {
      var all = timeline.querySelectorAll('.turn')
      for (var i = 0; i < all.length; i++) {
        var other = parseInt(all[i].getAttribute('data-id'), 10)
        if (!isNaN(other) && other > n) { before = all[i]; break }
      }
    }
    timeline.insertBefore(card, before)
  }

  function validTurnPath(p) {
    return typeof p === 'string' && TURN_PATH.test(p)
  }

  var viz = {
    version: VERSION,
    turns: 0,
    ready: null,

    boot: function (index) {
      var list = index && Array.isArray(index.turns) ? index.turns : []
      bootChain = (async function () {
        for (var i = 0; i < list.length; i++) {
          if (!validTurnPath(list[i])) continue
          try { await viz.loadScript('data/' + ws + '/' + list[i]) } catch (e) { /* pruned or unreadable turn: skip */ }
        }
      })()
      return bootChain
    },

    add: function (turn) {
      if (!turn || typeof turn !== 'object') return Promise.resolve()
      var id = turn.id == null ? 'x' + (++seq) : String(turn.id)
      var known = cards.get(id)
      if (known) return known
      var built = buildCard(turn, id)
      var empty = document.getElementById('empty')
      if (empty) empty.remove()
      place(built.card, id)
      viz.turns++
      setCount()
      var done = enqueue(async function () {
        for (var i = 0; i < built.dias.length; i++) await renderDiagram(built.dias[i], id, i)
        if (booted) built.card.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // The Enlarge button asks for the first diagram enlarged. Only a fresh request opens it:
        // the same turn replayed when the page loads again must not.
        var age = Date.now() - Date.parse(turn.time)
        if (turn.zoom === true && age >= 0 && age < ZOOM_FRESH_MS && built.dias.length) {
          openZoom(built.dias[0].querySelector('.dia-body'))
        }
      })
      cards.set(id, done)
      return done
    },

    loadScript: function (relPath) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script')
        s.src = relPath + (relPath.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() + '-' + (++scriptSeq)
        s.onload = function () { s.remove(); resolve('loaded ' + relPath) }
        s.onerror = function () { s.remove(); reject(new Error('cannot load ' + relPath)) }
        document.head.appendChild(s)
      })
    },

    errors: function () {
      return errors.map(function (e) { return { id: e.id, message: e.message, diagram: e.diagram } })
    },

    // Resolves when no diagram is waiting to be rendered.
    idle: function () { return settle() },

    // Number of remote resources removed from answers and diagrams.
    blocked: function () { return blocked }
  }
  window.viz = viz

  async function settle() {
    var q
    do { q = queue; await q } while (q !== queue)
  }

  viz.ready = viz.loadScript('data/' + ws + '/boot.js')
    .catch(function () { /* no boot file: empty timeline */ })
    .then(function () { return bootChain })
    .then(settle)
    .then(function () {
      booted = true
      var last = timeline.querySelector('.turn:last-of-type')
      if (last) last.scrollIntoView({ block: 'start' })
    })

  function closeZoom() {
    zoom.classList.remove('on')
    zoom.textContent = ''
  }

  function openZoom(body) {
    var svg = body && body.querySelector('svg')
    if (!svg) return
    var copy = svg.cloneNode(true)
    var natural = parseFloat(body.getAttribute('data-natural')) || svg.getBoundingClientRect().width
    copy.removeAttribute('style')
    copy.style.width = (natural * 1.25) + 'px'
    copy.style.maxWidth = 'none'
    zoom.textContent = ''
    zoom.appendChild(copy)
    zoom.classList.add('on')
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href]')
    if (link && link.getAttribute('href').charAt(0) !== '#') { e.preventDefault(); return }
    var btn = e.target.closest('button[data-act="src"]')
    if (btn) {
      var on = btn.closest('.dia').classList.toggle('show-src')
      btn.setAttribute('aria-pressed', String(on))
      return
    }
    if (zoom.classList.contains('on')) { closeZoom(); return }
    openZoom(e.target.closest('.dia-body'))
  })

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeZoom()
  })

  document.getElementById('btn-only').addEventListener('click', function (e) {
    var on = document.body.classList.toggle('only-diagrams')
    e.currentTarget.setAttribute('aria-pressed', String(on))
  })

  var resizeTimer = 0
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      document.querySelectorAll('.dia-body[data-natural]').forEach(applyWidth)
    }, 120)
  })
})()
