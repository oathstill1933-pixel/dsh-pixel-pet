// 一起看书 · 阅读窗（桌宠插件版）。阅读、划词气泡、提问卡片、留存沿用一个私用版阅读器的前端；
// 对话走宿主 /api/reading/ask（会话中继），说话走宿主 /api/reading/stt（DSH 自带语音识别）；回答一律走桌宠的说话出口（出声 + 气泡），卡片里同时显示。
// 当前划选写进宿主的阅读上下文槽（/api/reading/context）：用户从桌宠输入条打字/说话时也会带上这段。
// 没有翻译按钮：想翻译就像聊天一样直接问桌宠。扩展点（第一版不做）：OCR、Word/EPUB —— 见 docs/READING_CONTRACT.md。

const API = '../api/reading/'
const $ = (id) => document.getElementById(id)
const norm = (s) => s.replace(/\s+/g, ' ')
const pv = () => window.pywebview && window.pywebview.api

async function api (path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET'), headers: {} }
  if (opts.raw !== undefined) { init.body = opts.raw; init.headers['content-type'] = opts.type || 'application/octet-stream' }
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json' }
  const r = await fetch(API + path, init)
  let data = {}
  try { data = await r.json() } catch {}
  if (!r.ok) throw new Error(data.error || data.message || `请求失败（${r.status}）`)
  return data
}

let toastT = 0
function toast (t) { const e = $('toast'); e.textContent = String(t); e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 3400) }

const ICONS = {
  pdf: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  web: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/></svg>',
  x: '<svg class="ico" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  mic: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  trash: '<svg class="ico" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
}

// ───────────────────────── 状态 ─────────────────────────
let doc = null
let webHistory = []
let pdfState = null
let loadSeq = 0
let partner = { name: '', avatar: '' }
const host = (u) => { try { return new URL(u).host } catch { return '' } }

let view = 'home'
function setView (which) {
  view = which
  for (const [id, v] of [['home', 'home'], ['off', 'off'], ['marksView', 'marks'], ['pdfwrap', 'pdf'], ['webwrap', 'web']]) $(id).hidden = which !== v
  $('recent').setAttribute('aria-expanded', String(which === 'home' && !!doc))
  $('marks').setAttribute('aria-expanded', String(which === 'marks'))
}
function docView () { if (!doc) return showHome(); setView(doc.kind === 'pdf' ? 'pdf' : 'web') }
function loading (on) { $('loading').hidden = !on }

function renderBar () {
  const d = doc || {}
  let name = d.title || ''
  if (d.kind === 'web' && !name) name = host(d.src)
  $('name').textContent = name
  let meta = ''
  if (d.kind === 'pdf' && d.total) meta = `${d.page || 1} / ${d.total}`
  if (d.kind === 'web') { meta = host(d.src); if (meta === name) meta = '' }
  $('meta').textContent = meta
  $('back').hidden = !(d.kind === 'web' && webHistory.length)
  $('external').hidden = d.kind !== 'web'
  $('marks').hidden = !doc
  document.title = name || '一起看书'
  try { pv()?.set_title(name) } catch {}
}

// ───────────────────────── 最近 ─────────────────────────
async function showHome () {
  hideBubble()
  setView('home')
  let recent = []
  try { recent = (await api('state')).recent || [] } catch (e) { toast(e.message) }
  const list = $('recentList')
  list.textContent = ''
  $('empty').hidden = recent.length > 0
  for (const r of recent) list.appendChild(recentItem(r))
}
function recentItem (r) {
  const li = document.createElement('li')
  if (doc && r.id === doc.id) li.className = 'on'
  li.innerHTML = ICONS[r.kind === 'pdf' ? 'pdf' : 'web'] + '<span class="t"></span><span class="m"></span><button class="btn rm" title="从最近移除" aria-label="从最近移除">' + ICONS.x + '</button>'
  li.querySelector('.t').textContent = r.title || host(r.src) || ''
  li.querySelector('.m').textContent = r.kind === 'pdf' && r.total ? `${r.page || 1}/${r.total}` : (r.kind === 'web' ? host(r.src) : '')
  li.onclick = async () => { try { const res = await api('open-doc', { body: { id: r.id } }); webHistory = []; await openDoc(res.doc) } catch (e) { toast(e.message) } }
  li.querySelector('.rm').onclick = async (e) => {
    e.stopPropagation()
    try { await api('forget', { body: { id: r.id } }); li.remove(); if (!$('recentList').children.length) $('empty').hidden = false } catch (err) { toast(err.message) }
  }
  return li
}
$('recent').onclick = () => { if (view === 'home' && doc) { docView(); return } showHome() }

// ───────────────────────── 打开 ─────────────────────────
async function openDoc (d, opts = {}) {
  if (!d) return showHome()
  closeCard()
  clearContext()
  resetDocExtras()
  if (d.kind === 'pdf') return loadPdf(d)
  return loadWeb(d.src, { restore: opts.restore !== false })
}

async function loadWeb (url, { restore = false, push = false } = {}) {
  const seq = ++loadSeq
  hideBubble(); loading(true)
  try {
    const res = await api('fetch?url=' + encodeURIComponent(url))
    if (seq !== loadSeq) return
    if (res.kind === 'pdf') { if (push && doc && doc.kind === 'web') webHistory.push(doc.src); return loadPdf(res.doc) }
    if (push && doc && doc.kind === 'web' && doc.src !== res.doc.src) webHistory.push(doc.src)
    destroyPdf(); resetDocExtras()
    doc = res.doc
    renderArticle(res.html, res.url, res.plain)
    setView('web'); renderBar(); loadKept()
    const wrap = $('webwrap')
    wrap.scrollTop = 0
    if (restore && doc.scroll > 0) requestAnimationFrame(() => { wrap.scrollTop = doc.scroll * (wrap.scrollHeight - wrap.clientHeight) })
    paintSoon(); reportStatus(true)
  } catch (e) {
    if (seq !== loadSeq) return
    toast(e.message)
    if (!doc) showHome()
  } finally { if (seq === loadSeq) loading(false) }
}
$('back').onclick = () => { const prev = webHistory.pop(); if (prev) loadWeb(prev, { restore: true }); renderBar() }
$('external').onclick = () => {
  if (!doc || doc.kind !== 'web') return
  const p = pv()
  if (p && p.open_external) p.open_external(doc.src); else window.open(doc.src, '_blank', 'noopener')
}

const form = $('urlform'); const urlInput = $('url')
function urlMode (on) { form.hidden = !on; $('title').hidden = on; if (on) { urlInput.value = ''; urlInput.focus() } }
$('link').onclick = () => urlMode(form.hidden)
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') urlMode(false) })
urlInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== urlInput) urlMode(false) }, 150))
form.onsubmit = async (e) => {
  e.preventDefault()
  const v = urlInput.value.trim()
  urlMode(false)
  if (!v) return
  try { const res = await api('open-url', { body: { url: v } }); webHistory = []; await openDoc(res.doc, { restore: true }) } catch (err) { toast(err.message) }
}
$('file').onclick = async () => {
  const btn = $('file'); btn.disabled = true
  try { const res = await api('pick-file', { body: {} }); if (res.doc) { webHistory = []; await openDoc(res.doc) } } catch (e) { toast(e.message) } finally { btn.disabled = false }
}

// 拖进 PDF
let dragDepth = 0
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false })
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true })
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true
  const f = Array.from(e.dataTransfer.files).find((x) => /\.pdf$/i.test(x.name))
  if (!f) { toast('支持 PDF'); return }
  loading(true)
  try { const res = await api('upload?name=' + encodeURIComponent(f.name), { raw: f }); webHistory = []; await openDoc(res.doc) } catch (err) { toast(err.message) } finally { loading(false) }
})

// ───────────────────────── 网页阅读模式（脚本不执行、属性全剥）─────────────────────────
const DROP = 'script,style,noscript,template,iframe,frame,object,embed,form,button,input,select,textarea,nav,footer,aside,svg,canvas,video,audio,link,meta,dialog,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],[hidden]'
const NOISE = /comment|footer|sidebar|related|recommend|share|social|advert|banner|breadcrumb|popup|modal|subscribe|cookie|login|toolbar|nav/i
const KEEP_BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'FIGURE', 'FIGCAPTION', 'IMG', 'HR', 'BR', 'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'SUB', 'SUP', 'MARK', 'SMALL', 'DL', 'DT', 'DD', 'SECTION', 'DIV', 'SPAN', 'ARTICLE', 'PICTURE', 'KBD', 'Q', 'CITE', 'ABBR', 'TIME'])
const CANDIDATES = ['#js_content', '.mw-parser-output', '[itemprop=articleBody]', 'article .article-content', 'article', '.RichText', '.post-content', '.article-content', '.entry-content', '.article', '.post', 'main', '[role=main]', '#content', '.content']
const textLen = (el) => norm(el.textContent || '').trim().length

function pickRoot (d) {
  for (const sel of CANDIDATES) {
    const list = Array.from(d.querySelectorAll(sel)).filter((el) => textLen(el) > 200)
    if (list.length) return list.sort((a, b) => textLen(b) - textLen(a))[0]
  }
  const score = new Map()
  for (const p of d.querySelectorAll('p,pre,blockquote,li')) {
    const n = textLen(p)
    if (n < 20) continue
    const a = p.parentElement; const b = a && a.parentElement
    if (a) score.set(a, (score.get(a) || 0) + n)
    if (b) score.set(b, (score.get(b) || 0) + n / 2)
  }
  let best = null; let top = 0
  for (const [el, s] of score) if (s > top) { top = s; best = el }
  return best || d.body
}
function absUrl (v, base) { try { const u = new URL(v, base); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '' } catch { return '' } }
function sanitize (src, base) {
  const out = document.createDocumentFragment()
  const walk = (node, parent) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 3) { parent.appendChild(document.createTextNode(ch.nodeValue)); continue }
      if (ch.nodeType !== 1) continue
      const tag = ch.tagName
      if (ch.matches(DROP)) continue
      const cls = (ch.getAttribute('class') || '') + ' ' + (ch.id || '')
      if ((tag === 'DIV' || tag === 'SECTION' || tag === 'UL') && NOISE.test(cls) && textLen(ch) < 600) continue
      if (tag === 'IMG') {
        const s = ch.getAttribute('data-src') || ch.getAttribute('data-original') || ch.getAttribute('data-actualsrc') || ch.getAttribute('data-lazy-src') || ch.getAttribute('src') || ''
        const u = absUrl(s, base)
        if (!u) continue
        const img = document.createElement('img')
        img.src = u; img.alt = ch.getAttribute('alt') || ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.decoding = 'async'
        parent.appendChild(img); continue
      }
      if (!KEEP_BLOCK.has(tag)) { walk(ch, parent); continue }
      const el = document.createElement(tag === 'SECTION' || tag === 'ARTICLE' ? 'div' : tag.toLowerCase())
      if (tag === 'A') {
        const href = ch.getAttribute('href') || ''
        if (href.startsWith('#')) el.setAttribute('data-hash', href.slice(1))
        else { const u = absUrl(href, base); if (u) el.setAttribute('href', u) }
      }
      if (tag === 'TD' || tag === 'TH') for (const a of ['colspan', 'rowspan']) if (ch.hasAttribute(a)) el.setAttribute(a, ch.getAttribute(a))
      if (tag === 'OL' && ch.hasAttribute('start')) el.setAttribute('start', ch.getAttribute('start'))
      if (ch.id) el.setAttribute('data-anchor', ch.id)
      walk(ch, el)
      if (tag !== 'BR' && tag !== 'HR' && !el.childNodes.length) continue
      parent.appendChild(el)
    }
  }
  walk(src, out)
  return out
}
function renderArticle (html, url, plain) {
  const art = $('article')
  art.textContent = ''
  const bodyEl = document.createElement('div'); bodyEl.id = 'body'
  const h = document.createElement('h1'); h.className = 'doc-title'
  const sub = document.createElement('div'); sub.className = 'doc-host'; sub.textContent = host(url)
  if (plain) {
    h.textContent = doc.title || host(url)
    const pre = document.createElement('pre'); pre.textContent = html
    bodyEl.appendChild(pre); art.append(h, sub, bodyEl); return
  }
  const d = new DOMParser().parseFromString(html, 'text/html')
  const og = d.querySelector('meta[property="og:title"]')
  const t = norm((og && og.getAttribute('content')) || d.title || (d.querySelector('h1') || {}).textContent || '').trim() || host(url)
  h.textContent = t
  const root = pickRoot(d)
  const tmp = document.createElement('div'); tmp.appendChild(sanitize(root, url))
  if (textLen(tmp) < 160 && root !== d.body) { tmp.textContent = ''; tmp.appendChild(sanitize(d.body, url)) }
  const first = tmp.querySelector('h1')
  if (first && norm(first.textContent).trim() === t) first.remove()
  bodyEl.append(...Array.from(tmp.childNodes))
  art.append(h, sub, bodyEl)
  if (doc && t && t !== doc.title) { doc.title = t; api('status', { body: { id: doc.id, title: t } }).catch(() => {}) }
}
$('article').addEventListener('click', (e) => {
  const a = e.target.closest('a')
  if (!a) return
  e.preventDefault()
  const hash = a.getAttribute('data-hash')
  if (hash) { const t = $('article').querySelector(`[data-anchor="${CSS.escape(hash)}"]`); if (t) t.scrollIntoView({ block: 'start' }); return }
  const href = a.getAttribute('href')
  if (href) loadWeb(href, { push: true })
})

// ───────────────────────── PDF ─────────────────────────
let pdfjsReady = null
function pdfjs () {
  if (!pdfjsReady) pdfjsReady = (async () => {
    const lib = await import('./vendor/pdfjs/build/pdf.min.mjs')
    globalThis.pdfjsLib = lib
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.min.mjs', location).href
    const viewerMod = await import('./vendor/pdfjs/web/pdf_viewer.mjs')
    return { lib, viewerMod }
  })()
  return pdfjsReady
}
function destroyPdf () { if (!pdfState) return; try { pdfState.pdf.destroy() } catch {} pdfState = null; $('viewer').textContent = '' }

async function loadPdf (d) {
  const seq = ++loadSeq
  hideBubble(); loading(true)
  try {
    const { lib, viewerMod } = await pdfjs()
    if (seq !== loadSeq) return
    destroyPdf(); resetDocExtras()
    doc = d
    setView('pdf'); renderBar(); loadKept()
    const wrap = $('pdfwrap')
    const base = new URL('./vendor/pdfjs/', location).href
    const eventBus = new viewerMod.EventBus()
    const linkService = new viewerMod.PDFLinkService({ eventBus, externalLinkTarget: 2 })
    const viewer = new viewerMod.PDFViewer({ container: wrap, viewer: $('viewer'), eventBus, linkService, textLayerMode: 1, removePageBorders: true })
    linkService.setViewer(viewer)
    const pdf = await lib.getDocument({
      url: API + 'pdf?id=' + encodeURIComponent(d.id), disableRange: true, disableAutoFetch: true,
      cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', isEvalSupported: false, enableXfa: false,
    }).promise
    if (seq !== loadSeq) { pdf.destroy(); return }
    pdfState = { pdf, viewer, eventBus }
    viewer.setDocument(pdf); linkService.setDocument(pdf)
    pdf.getMetadata().then(({ info }) => {
      const t = info && String(info.Title || '').trim()
      if (t && t.length > 2 && !/^untitled$/i.test(t) && doc && doc.id === d.id) { doc.title = t; renderBar(); reportStatus(true) }
    }).catch(() => {})
    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = 'page-width'
      const page = Math.min(Math.max(d.page || 1, 1), pdf.numPages)
      viewer.currentPageNumber = page
      requestAnimationFrame(() => {
        const p = viewer.getPageView(page - 1)?.div
        if (p && d.scroll > 0) wrap.scrollTop = p.offsetTop + d.scroll * p.clientHeight
        doc.total = pdf.numPages
        renderBar(); reportStatus(true)
      })
    })
    eventBus.on('pagechanging', () => { if (doc) { doc.page = viewer.currentPageNumber; renderBar() } reportStatus() })
    eventBus.on('textlayerrendered', paintSoon)
  } catch (e) {
    if (seq !== loadSeq) return
    toast(e.message || String(e))
  } finally { if (seq === loadSeq) loading(false) }
}
let rz = 0
addEventListener('resize', () => {
  clearTimeout(rz)
  rz = setTimeout(() => { if (!pdfState) return; const pg = pdfState.viewer.currentPageNumber; pdfState.viewer.currentScaleValue = 'page-width'; pdfState.viewer.currentPageNumber = pg }, 150)
})

// ───────────────────────── 阅读位置 ─────────────────────────
let statusT = 0; let lastSent = ''
function position () {
  if (!doc) return null
  if (doc.kind === 'pdf' && pdfState) {
    const v = pdfState.viewer; const wrap = $('pdfwrap')
    const p = v.getPageView(v.currentPageNumber - 1)?.div
    const frac = p ? Math.min(Math.max((wrap.scrollTop - p.offsetTop) / Math.max(1, p.clientHeight), 0), 1) : 0
    return { id: doc.id, page: v.currentPageNumber, total: pdfState.pdf.numPages, title: doc.title || '', scroll: +frac.toFixed(4) }
  }
  if (doc.kind === 'web') {
    const w = $('webwrap'); const max = w.scrollHeight - w.clientHeight
    return { id: doc.id, title: doc.title || '', scroll: max > 0 ? +(w.scrollTop / max).toFixed(4) : 0 }
  }
  return null
}
function reportStatus (now) {
  clearTimeout(statusT)
  statusT = setTimeout(() => {
    const info = position()
    if (!info) return
    const key = JSON.stringify(info)
    if (key === lastSent) return
    lastSent = key
    api('status', { body: info }).catch(() => {})
  }, now ? 0 : 800)
}
$('pdfwrap').addEventListener('scroll', () => { hideBubble(); reportStatus() }, { passive: true })
$('webwrap').addEventListener('scroll', () => { hideBubble(); reportStatus() }, { passive: true })

// 阅读上下文槽：当前划选 → 宿主内存（10 分钟），桌宠输入条打字/说话也会带上；宿主顺带让桌宠切「在看」
let ctxKey = ''
function setContext (sel) {
  const k = sel.docId + '\n' + sel.text
  if (k === ctxKey) return
  ctxKey = k
  api('context', { body: { pick: sel } }).catch(() => { ctxKey = '' })
}
function clearContext () {
  if (!ctxKey) return
  ctxKey = ''
  api('context', { body: { clear: true } }).catch(() => {})
}
let clearT = 0
/** 选区没了、卡片也没开 → 清掉（稍等一下：点进卡片输入框时选区会短暂消失） */
function clearContextSoon () {
  clearTimeout(clearT)
  clearT = setTimeout(() => { const s = getSelection(); if (card.hidden && (!s || s.isCollapsed)) clearContext() }, 400)
}

// ───────────────────────── 留存标亮（CSS Custom Highlight，不改 DOM）─────────────────────────
let keptList = []
async function paintKept () {
  if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function' || !doc) return
  let list = []
  try { list = await api('kept?id=' + encodeURIComponent(doc.id)) } catch { return }
  keptList = Array.isArray(list) ? list : []
  updateMarksBadge()
  const ranges = []
  for (const item of keptList) {
    const needle = String(item.text || '').replace(/\s+/g, '')
    if (needle.length < 2) continue
    let scope = $('body')
    if (doc.kind === 'pdf') scope = item.page ? document.querySelector(`.page[data-page-number="${item.page}"]`) : null
    if (!scope) continue
    const r = findRange(scope, needle)
    if (r) ranges.push(r)
  }
  if (ranges.length) CSS.highlights.set('pet-kept', new Highlight(...ranges)); else CSS.highlights.delete('pet-kept')
}
function findRange (scope, needle) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  let stripped = ''
  const map = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue
    for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { stripped += s[i]; map.push([n, i]) }
    if (stripped.length > 2000000) break
  }
  const at = stripped.indexOf(needle)
  if (at < 0) return null
  const [sn, so] = map[at]; const [en, eo] = map[at + needle.length - 1]
  const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo + 1)
  return r
}
let paintT = 0
function paintSoon () { clearTimeout(paintT); paintT = setTimeout(paintKept, 250) }

// ───────────────────────── 划词气泡 ─────────────────────────
const bubble = $('bubble'); const card = $('card')
let pending = null
const inUi = (t) => t && t.closest && (t.closest('#bubble') || t.closest('#card') || t.closest('#bar') || t.closest('#marksView'))

function capture () {
  const sel = getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !doc) return null
  const range = sel.getRangeAt(0)
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
  if (!startEl || inUi(startEl) || !startEl.closest('#body,.textLayer')) return null
  const text = norm(sel.toString()).trim()
  if (text.length < 2) return null
  const rootEl = startEl.closest('.textLayer') || $('body')
  let before = ''; let after = ''
  try {
    const pre = document.createRange(); pre.setStart(rootEl, 0); pre.setEnd(range.startContainer, range.startOffset)
    const post = document.createRange(); post.setStart(range.endContainer, range.endOffset); post.setEnd(rootEl, rootEl.childNodes.length)
    before = norm(pre.toString()); after = norm(post.toString())
  } catch {}
  // PDF 一页的前后文不够时，补上一页 / 下一页的文字层
  const pageEl = startEl.closest('.page[data-page-number]')
  if (pageEl && before.length < 400) { const prev = pageEl.previousElementSibling?.querySelector('.textLayer'); if (prev) before = norm(prev.textContent || '') + ' ' + before }
  if (pageEl && after.length < 400) { const next = pageEl.nextElementSibling?.querySelector('.textLayer'); if (next) after = after + ' ' + norm(next.textContent || '') }
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  const box = range.getBoundingClientRect()
  return {
    sel: {
      docId: doc.id, kind: doc.kind, title: doc.title || '', src: doc.kind === 'web' ? doc.src : '',
      text: text.slice(0, 1500), before: before.slice(-600), after: after.slice(0, 600),
      page: pageEl ? Number(pageEl.dataset.pageNumber) : null, charOffset: before.length,
      rect: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
    },
    first: rects[0] || box, last: rects[rects.length - 1] || box,
  }
}
function showBubble () {
  pending = capture()
  if (!pending) return hideBubble()
  bubble.hidden = false
  bubble.classList.remove('on')
  const bw = bubble.offsetWidth || 104; const bh = bubble.offsetHeight || 30; const gap = 8; const topMin = 44 + gap
  const { first, last } = pending
  const x = Math.min(Math.max(last.right - bw / 2, gap), innerWidth - bw - gap)
  let y = last.bottom + gap
  if (y + bh > innerHeight - gap) y = Math.max(first.top - bh - gap, topMin)
  bubble.style.left = x + 'px'; bubble.style.top = y + 'px'
  requestAnimationFrame(() => bubble.classList.add('on'))
  setContext(pending.sel)
}
function hideBubble () { pending = null; bubble.classList.remove('on'); bubble.hidden = true }

document.addEventListener('mouseup', (e) => { if (e.button === 0 && !inUi(e.target)) setTimeout(showBubble, 0) }, true)
document.addEventListener('keyup', (e) => { if (e.key === 'Shift' || (e.shiftKey && e.key.startsWith('Arrow'))) setTimeout(showBubble, 0) }, true)
document.addEventListener('mousedown', (e) => { if (inUi(e.target)) return; hideBubble(); if (!card.hidden && idle()) closeCard() }, true)
document.addEventListener('selectionchange', () => { const s = getSelection(); if (!s || s.isCollapsed) { hideBubble(); clearContextSoon() } })
bubble.addEventListener('mousedown', (e) => e.preventDefault())
function fromBubble (then) {
  if (!pending) return
  const r = bubble.getBoundingClientRect()
  const { sel, first } = pending
  hideBubble()
  openCard(sel, { x: r.left, y: r.top, h: r.height, selTop: first.top }).then(then)
}
$('bubbleChat').addEventListener('click', (e) => { e.preventDefault(); fromBubble() })

// ───────────────────────── 提问卡片 ─────────────────────────
const q = $('q'); const send = $('send'); const keepBtn = $('keep'); const mic = $('mic')
let pick = null; let keep = false; let busy = false; let hasAnswer = false; let anchor = null
let turns = []; let keptId = ''; let spoken = false   // spoken: 这一句是说出来的（回答同时出声）

const idle = () => !busy && !q.value.trim() && !hasAnswer && !rec.on
function sync () { send.disabled = busy || rec.on || (!q.value.trim() && !(keep && !keptId)) }
function setKeep (v, save) { keep = !!v; keepBtn.setAttribute('aria-pressed', String(keep)); sync(); if (save) return api('keep-pref', { body: { keep } }).catch(() => {}) }

async function persist () {
  if (!pick || !keep) return
  try {
    const r = await api('kept/save', { body: { pick, turns, id: keptId } })
    keptId = r.id
    $('keptMark').hidden = false
    sync(); paintSoon()
  } catch (err) { $('err').textContent = err.message }
}
function place () {
  if (card.hidden || !anchor) return
  const w = card.offsetWidth; const h = card.offsetHeight; const gap = 8; const topMin = 44 + gap
  const x = Math.min(Math.max(anchor.x - 12, gap), innerWidth - w - gap)
  let y = anchor.y
  if (y + h > innerHeight - gap) { const above = anchor.selTop - h - gap; y = above >= topMin ? above : Math.max(topMin, innerHeight - h - gap) }
  card.style.left = x + 'px'; card.style.top = y + 'px'
}
function fit () { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight + 2, 140) + 'px'; place() }

async function openCard (sel, at) {
  if (rec.on) stopRec(true)
  pick = sel; anchor = at; turns = []; keptId = ''; spoken = false
  setContext(sel)
  $('quote').textContent = sel.text
  q.value = ''; hasAnswer = false; busy = false
  $('answer').hidden = true; $('answerText').textContent = ''; $('err').textContent = ''; $('keptMark').hidden = true
  showSaid('')
  try { setKeep((await api('state')).keep, false) } catch { setKeep(keep, false) }
  card.hidden = false
  card.classList.remove('on')
  fit()
  requestAnimationFrame(() => card.classList.add('on'))
  setTimeout(() => q.focus(), 30)
}
function closeCard () { if (card.hidden) return; if (rec.on) stopRec(true); card.classList.remove('on'); card.hidden = true; pick = null; clearContextSoon() }

q.addEventListener('input', () => { if (!q.value.trim()) spoken = false; sync(); fit() })
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) go() } })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!card.hidden) closeCard(); else hideBubble() } })
$('x').onclick = closeCard
keepBtn.onclick = async () => {
  await setKeep(!keep, true)
  if (!pick) return
  if (keep && turns.length) await persist()
  else if (!keep && keptId) {
    try { await api('kept/delete', { body: { docId: pick.docId, id: keptId } }) } catch {}
    keptId = ''; $('keptMark').hidden = true; sync(); paintSoon()
  }
}
send.onclick = () => go()
addEventListener('resize', () => { hideBubble(); place() })

const dots = '<span class="dots"><span></span><span></span><span></span></span>'
function showSaid (text, voice) { const s = $('said'); s.hidden = !text; s.textContent = text || ''; s.classList.toggle('voice', !!voice) }

/** 发给桌宠。opts.question + voice（阅读窗麦克风，识别完直接发） */
async function go (opts = {}) {
  if (!pick || busy) return
  if (opts.question === undefined && send.disabled) return
  const question = (opts.question !== undefined ? opts.question : q.value).trim()
  const voice = opts.voice === true || (opts.question === undefined && spoken)
  busy = true; sync(); $('err').textContent = ''
  if (!question) { await persist(); busy = false; sync(); setTimeout(closeCard, 650); return }
  showSaid(question, voice)
  if (opts.question === undefined) { q.value = ''; spoken = false }
  $('answer').hidden = false; $('answerText').innerHTML = dots
  fit()
  try {
    const r = await api('ask', { body: { pick, question, voice } })
    if (r.ok && r.answer) { $('answerText').textContent = r.answer; hasAnswer = true } else { $('answer').hidden = true; $('err').textContent = r.message || '没收到回复。' }
    turns.push({ asked: question, answer: r.answer || null, voice, at: Date.now() })
    if (keep && r.ok) await persist()
  } catch (err) {
    $('err').textContent = err.message
    if (!hasAnswer) $('answer').hidden = true
  } finally { busy = false; sync(); fit() }
}

// ───────────────────────── 说话：本页录音 → 宿主 /stt（DSH 语音识别）→ 文字进输入框（可改）─────────────────────────
const rec = { on: false, ctx: null, stream: null, node: null, chunks: [], rate: 48000, spoke: 0, quiet: 0, bars: [], levels: [] }
const BARS = 22
mic.onclick = () => { if (rec.on) stopRec(false); else startRec() }

function setRec (on) {
  rec.on = on
  mic.setAttribute('aria-pressed', String(on))
  q.classList.toggle('listening', on)
  q.placeholder = on ? '在听…' : '想说点什么…'
  $('wave').hidden = !on
  sync(); fit()
}
// 和桌宠输入条语音互斥：桌宠正在收音时不录（这段已在上下文槽里，直接对桌宠说就行）；录音期间请桌宠暂停免提监听
async function startRec () {
  $('err').textContent = ''
  if (pick) setContext(pick)
  let m = { busy: false }
  try { m = await api('mic', { body: { on: true } }) } catch {}
  if (m.busy) { $('err').textContent = '桌宠正在听，直接对它说就行，这段会跟着过去。'; fit(); return }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (err) { api('mic', { body: { on: false } }).catch(() => {}); $('err').textContent = '麦克风打不开：' + (err.name || err); fit(); return }
  rec.ctx = new AudioContext()
  if (rec.ctx.state === 'suspended') await rec.ctx.resume().catch(() => {})
  rec.rate = rec.ctx.sampleRate
  const src = rec.ctx.createMediaStreamSource(rec.stream)
  rec.node = rec.ctx.createScriptProcessor(4096, 1, 1)
  rec.chunks = []; rec.spoke = 0; rec.quiet = 0; rec.started = performance.now()
  const w = $('wave'); w.textContent = ''
  rec.bars = Array.from({ length: BARS }, () => { const i = document.createElement('i'); w.appendChild(i); return i })
  rec.levels = new Array(BARS).fill(0)
  rec.node.onaudioprocess = (e) => {
    if (!rec.on) return
    const d = e.inputBuffer.getChannelData(0)
    rec.chunks.push(new Float32Array(d))
    let sum = 0
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
    const lv = Math.min(1, Math.pow(Math.sqrt(sum / d.length) * 9, 0.7))
    rec.levels.shift(); rec.levels.push(lv)
    w.classList.toggle('quiet', lv < 0.06)
    for (let i = 0; i < BARS; i++) rec.bars[i].style.height = (3 + rec.levels[i] * 21).toFixed(1) + 'px'
    const ts = performance.now()
    if (lv > 0.12) { rec.spoke = ts; rec.quiet = 0 } else if (rec.spoke && !rec.quiet) rec.quiet = ts
    // 说过话、又安静了 1.2 秒 → 自动结束；最长 60 秒
    if ((rec.spoke && rec.quiet && ts - rec.quiet > 1200) || ts - rec.started > 60000) stopRec(false)
  }
  src.connect(rec.node); rec.node.connect(rec.ctx.destination)
  setRec(true)
}
function releaseRec () {
  try { rec.node && (rec.node.onaudioprocess = null) } catch {}
  try { rec.node && rec.node.disconnect() } catch {}
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop())
  if (rec.ctx) rec.ctx.close().catch(() => {})
  rec.node = rec.stream = rec.ctx = null
}
async function stopRec (cancel) {
  if (!rec.on) return
  const chunks = rec.chunks; const rate = rec.rate; const spoke = rec.spoke
  rec.chunks = []
  setRec(false); releaseRec()
  api('mic', { body: { on: false } }).catch(() => {})
  if (cancel || !spoke) return
  $('thinking').hidden = false; busy = true; sync()
  let text = ''
  try {
    const r = await api('stt', { raw: toWav(chunks, rate), type: 'audio/wav' })
    text = String(r.text || '').trim()
    if (!text) $('err').textContent = '没听清，再说一次？'
  } catch (err) { $('err').textContent = err.message } finally { $('thinking').hidden = true; busy = false; sync(); fit() }
  if (!text) return
  // 默认识别完直接发（文字显示成用户气泡）；开了「先确认再发」才填进输入框
  if (voiceConfirm) { q.value = (q.value.trim() ? q.value.trim() + ' ' : '') + text; spoken = true; sync(); fit(); q.focus(); return }
  go({ question: text, voice: true })
}
let voiceConfirm = false
function setConfirm (v, save) {
  voiceConfirm = !!v
  $('confirmVoice').setAttribute('aria-pressed', String(voiceConfirm))
  if (save) api('keep-pref', { body: { voiceConfirm } }).catch(() => {})
}
$('confirmVoice').onclick = () => setConfirm(!voiceConfirm, true)
/** Float32 片段 → 16 kHz 单声道 16 位 wav */
function toWav (chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0)
  const all = new Float32Array(len); let o = 0
  for (const c of chunks) { all.set(c, o); o += c.length }
  const ratio = rate / 16000; const n = Math.floor(len / ratio)
  const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf)
  const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio); const b = Math.min(len, Math.floor((i + 1) * ratio))
    let s = 0; for (let k = a; k < b; k++) s += all[k]
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// ───────────────────────── 留存列表 ─────────────────────────
function resetDocExtras () { keptList = []; updateMarksBadge(); if (window.CSS && CSS.highlights) CSS.highlights.delete('pet-kept') }
function updateMarksBadge () { const n = keptList.length; const b = $('marksCount'); b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n }
async function loadKept () {
  if (!doc) { keptList = []; updateMarksBadge(); return }
  const id = doc.id
  try { const l = await api('kept?id=' + encodeURIComponent(id)); if (doc && doc.id === id) { keptList = Array.isArray(l) ? l : []; updateMarksBadge() } } catch {}
}
$('marks').onclick = () => { if (view === 'marks') { docView(); return } showMarks() }
async function showMarks () { hideBubble(); closeCard(); await loadKept(); setView('marks'); renderMarks() }
const two = (n) => String(n).padStart(2, '0')
function stamp (ms) { if (!ms) return ''; const d = new Date(ms); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }
function renderMarks () {
  const list = $('marksList')
  list.textContent = ''
  const items = keptList.slice().sort((a, b) => ((a.page ?? 1e9) - (b.page ?? 1e9)) || ((a.createdAt || 0) - (b.createdAt || 0)))
  $('marksEmpty').hidden = items.length > 0
  for (const it of items) {
    const li = document.createElement('li'); li.className = 'mark'
    const head = document.createElement('div'); head.className = 'mhead'
    const pg = document.createElement('span'); pg.textContent = it.page ? `P${it.page}` : ''
    const tm = document.createElement('time'); tm.textContent = stamp(it.createdAt)
    const grow = document.createElement('span'); grow.className = 'grow'
    const rm = document.createElement('button'); rm.className = 'btn rm'; rm.title = '删除'; rm.setAttribute('aria-label', '删除'); rm.innerHTML = ICONS.trash
    head.append(pg, tm, grow, rm)
    const quote = document.createElement('blockquote'); quote.textContent = it.text; quote.title = '跳到原文'
    quote.onclick = () => jumpTo(it)
    li.append(head, quote)
    for (const t of it.turns || []) {
      if (t.asked) {
        const me = document.createElement('div'); me.className = 'turn me'
        if (t.voice) me.insertAdjacentHTML('beforeend', ICONS.mic)
        const p = document.createElement('p'); p.textContent = t.asked
        me.appendChild(p); li.appendChild(me)
      }
      if (t.answer) {
        const py = document.createElement('div'); py.className = 'turn pet'
        const img = document.createElement('img'); img.alt = ''; if (partner.avatar) img.src = partner.avatar
        const p = document.createElement('p'); p.textContent = t.answer
        py.append(img, p); li.appendChild(py)
      }
    }
    let armT = 0
    rm.onclick = async () => {
      if (!rm.classList.contains('armed')) {
        rm.classList.add('armed'); rm.title = '再点一次删除'
        clearTimeout(armT); armT = setTimeout(() => { rm.classList.remove('armed'); rm.title = '删除' }, 3000)
        return
      }
      try {
        await api('kept/delete', { body: { docId: doc.id, id: it.id } })
        keptList = keptList.filter((x) => x.id !== it.id)
        updateMarksBadge(); li.remove()
        $('marksEmpty').hidden = keptList.length > 0
        paintSoon()
      } catch (err) { toast(err.message) }
    }
    list.appendChild(li)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function jumpTo (it) {
  docView()
  await sleep(30)
  const needle = String(it.text || '').replace(/\s+/g, '')
  if (doc.kind === 'pdf' && pdfState) {
    if (it.page) pdfState.viewer.currentPageNumber = it.page
    for (let i = 0; i < 25; i++) {
      const scope = document.querySelector(`.page[data-page-number="${it.page || pdfState.viewer.currentPageNumber}"]`)
      const r = scope && findRange(scope, needle)
      if (r) { flash(r, $('pdfwrap')); return }
      await sleep(160)
    }
    return
  }
  const r = $('body') && findRange($('body'), needle)
  if (r) flash(r, $('webwrap')); else toast('这段在当前视图里找不到了')
}
function flash (r, wrap) {
  const rect = r.getBoundingClientRect(); const wr = wrap.getBoundingClientRect()
  wrap.scrollTop += rect.top - wr.top - wrap.clientHeight * 0.3
  if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
    CSS.highlights.set('pet-flash', new Highlight(r))
    setTimeout(() => CSS.highlights.delete('pet-flash'), 1800)
  }
}

// ───────────────────────── 启动 ─────────────────────────
// 关窗：放开桌宠的监听、清掉上下文槽
addEventListener('pagehide', () => {
  const beacon = (path, body) => { try { navigator.sendBeacon(API + path, new Blob([JSON.stringify(body)], { type: 'application/json' })) } catch {} }
  if (rec.on) beacon('mic', { on: false })
  if (ctxKey) beacon('context', { clear: true })
})
// pywebview 的 js_api 晚于页面脚本就绪：就绪后补一次窗口标题
addEventListener('pywebviewready', () => renderBar())
;(async () => {
  try {
    const s = await api('state')
    partner = s.partner || partner
    $('bubbleText').textContent = '和 ' + (partner.name || 'ta') + ' 聊'
    card.setAttribute('aria-label', '和 ' + (partner.name || 'ta') + ' 聊')
    if (partner.avatar) $('ava').src = partner.avatar
    setKeep(s.keep, false)
    setConfirm(s.voiceConfirm, false)
    if (!s.enabled) { setView('off'); for (const id of ['link', 'file', 'recent']) $(id).disabled = true; return }
    if (s.current) await openDoc(s.current, { restore: true })
    else showHome()
  } catch (e) { toast(e.message); showHome() }
})()
