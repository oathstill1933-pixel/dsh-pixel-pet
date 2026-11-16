(() => {
  const $ = (id) => document.getElementById(id)
  const api = (p, body) => fetch('api/' + p, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())

  // ------------------------------------------------------------------ markdown (escape first, then a small safe subset)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  function inline (s) {
    const codes = []
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>')
  }
  function md (src) {
    const lines = esc(String(src || '').replace(/\r\n?/g, '\n')).split('\n')
    const out = []; let para = []; let list = null
    const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = [] } }
    const flushL = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + list.tag + '>'); list = null } }
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/^```/.test(ln)) {
        flushP(); flushL()
        const buf = []
        while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i])
        out.push('<pre><code>' + buf.join('\n') + '</code></pre>')
        continue
      }
      let m
      if (!ln.trim()) { flushP(); flushL(); continue }
      if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); const n = Math.min(4, m[1].length + 1); out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); continue }
      if (/^(-{3,}|\*{3,})\s*$/.test(ln)) { flushP(); flushL(); out.push('<hr>'); continue }
      if ((m = ln.match(/^&gt;\s?(.*)$/))) { flushP(); flushL(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue }
      if ((m = ln.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        flushP()
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul'
        if (!list || list.tag !== tag) { flushL(); list = { tag, items: [] } }
        list.items.push(m[2]); continue
      }
      flushL(); para.push(ln)
    }
    flushP(); flushL()
    return out.join('').replace(/<\/blockquote><blockquote>/g, '<br>')
  }

  // ------------------------------------------------------------------ render
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n }
  const two = (n) => String(n).padStart(2, '0')
  const hm = (d) => two(d.getHours()) + ':' + two(d.getMinutes())
  function dayLabel (d) {
    const today = new Date(); const y = new Date(Date.now() - 864e5)
    const same = (a, b) => a.toDateString() === b.toDateString()
    if (same(d, today)) return '今天'
    if (same(d, y)) return '昨天'
    return (d.getFullYear() === today.getFullYear() ? '' : d.getFullYear() + ' 年 ') + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
  }
  const GLYPH = { queued: '·', delivered: '↗', replied: '✓', failed: '!' }
  const WHY = { 'no-session': '设置页还没选会话', offline: '会话不在线', timeout: '会话没回', busy: '会话正忙', empty: '没有回复', failed: '没送到' }

  let items = []; let pending = []; let sig = ''; let stats = { unread: 0 }; let starOnly = false

  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3s-7.6-4.6-9.2-9.4C1.8 7.6 4 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.3 0 5.5 3.1 4.5 6.4-1.6 4.8-9.2 9.4-9.2 9.4z"/></svg>'
  const BIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 4h4M6.5 7l.9 12.1c.1 1 .9 1.9 2 1.9h5.2c1.1 0 1.9-.9 2-1.9L17.5 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  /* AI 的反应从单一红心扩成一组表情。
     沿用 HEART / BIN 那套 24×24 线条风格，其余六个全部走 stroke，颜色由 CSS 按 data-reaction 上。 */
  const svg = (body) => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>'
  /* 二版（12px 下线条全糊，只有红心和差评认得出）：
     改成 emoji 画法——大色块打底、深色五官、靠颜色和剪影区分，不靠细节；
     尺寸同时抬到 14px。 */
  const REACTS = {
    heart: HEART,
    happy: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.4" fill="#F5C33B"/><circle cx="8.9" cy="9.8" r="1.45" fill="#4A3A10"/><circle cx="15.1" cy="9.8" r="1.45" fill="#4A3A10"/><path d="M7.6 12.9c1.1 2.2 2.6 3.3 4.4 3.3s3.3-1.1 4.4-3.3" fill="none" stroke="#4A3A10" stroke-width="2" stroke-linecap="round"/></svg>',
    hug: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="4.9" cy="14.9" rx="2.5" ry="2" fill="#2E9C5A" transform="rotate(-20 4.9 14.9)"/><ellipse cx="19.1" cy="14.9" rx="2.5" ry="2" fill="#2E9C5A" transform="rotate(20 19.1 14.9)"/><path d="M8.6 13.2h6.8c1.5 0 2.6 1.2 2.6 2.6v2.9c0 1.5-1.1 2.6-2.6 2.6H8.6C7.1 21.3 6 20.2 6 18.7v-2.9c0-1.4 1.1-2.6 2.6-2.6z" fill="#2E9C5A"/><circle cx="12" cy="8.3" r="5.5" fill="#F5C33B"/><circle cx="10" cy="7.9" r="1.05" fill="#4A3A10"/><circle cx="14" cy="7.9" r="1.05" fill="#4A3A10"/><path d="M10.3 10.5c.5.55 1.05.8 1.7.8s1.2-.25 1.7-.8" fill="none" stroke="#4A3A10" stroke-width="1.25" stroke-linecap="round"/></svg>',
    sad: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.4" fill="#6FA3D6"/><circle cx="9" cy="10.1" r="1.35" fill="#12304D"/><circle cx="15" cy="10.1" r="1.35" fill="#12304D"/><path d="M8.3 15.9c1-1.6 2.2-2.4 3.7-2.4s2.7.8 3.7 2.4" fill="none" stroke="#12304D" stroke-width="1.9" stroke-linecap="round"/><path d="M5.6 12.6c0 1.6-.6 2.6-1.5 2.6s-1.5-1-1.5-2.6c0-1.3 1.5-3 1.5-3s1.5 1.7 1.5 3z" fill="#CDE8FF"/></svg>',
    shock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.4" fill="#9B84D9"/><circle cx="9" cy="9.8" r="2.2" fill="#fff"/><circle cx="15" cy="9.8" r="2.2" fill="#fff"/><circle cx="9" cy="9.8" r="1" fill="#2C1D4D"/><circle cx="15" cy="9.8" r="1" fill="#2C1D4D"/><ellipse cx="12" cy="15.7" rx="1.8" ry="2.3" fill="#2C1D4D"/></svg>',
    angry: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.4" fill="#E0564A"/><path d="M6.9 7.6l3.4 1.8M17.1 7.6l-3.4 1.8" fill="none" stroke="#4E120C" stroke-width="2.1" stroke-linecap="round"/><circle cx="9" cy="11.6" r="1.25" fill="#4E120C"/><circle cx="15" cy="11.6" r="1.25" fill="#4E120C"/><path d="M9.1 16.3c.9-1 1.9-1.5 2.9-1.5s2 .5 2.9 1.5" fill="none" stroke="#4E120C" stroke-width="1.9" stroke-linecap="round"/></svg>',
    dislike: svg('<path d="M7.2 4.2v9.6"/><path d="M7.2 4.2h7c1.2 0 2.2.8 2.5 1.9l1.1 4.2c.4 1.5-.7 3-2.3 3h-3l.6 3.1c.2 1.2-.7 2.3-1.9 2.3-.7 0-1.3-.4-1.6-1L7.2 13.8"/><rect x="3.6" y="4.2" width="3.4" height="9.6" rx="1"/>'),
  }
  const REACT_LABEL = { heart: '♥', happy: '开心', hug: '抱抱', sad: '难过', shock: '震惊', angry: '生气', dislike: '差评' }

  /** the AI's own reaction on the bubble, nothing to click */
  function likeMark (reaction) {
    const key = REACTS[reaction] ? reaction : 'heart'
    const m = el('span', 'like', REACTS[key])
    m.setAttribute('role', 'img')
    m.setAttribute('aria-label', REACT_LABEL[key] || '')
    m.dataset.reaction = key
    return m
  }

  /** heart + delete for one saved item (pending notes have no id yet -> nothing) */
  function acts (it) {
    const g = el('span', 'acts')
    if (!it.id) return g
    const h = el('button', 'ib heart', HEART); h.type = 'button'
    h.setAttribute('aria-pressed', String(!!it.starred)); h.title = it.starred ? '取消收藏' : '收藏'
    h.onclick = () => {
      const on = !it.starred; it.starred = on
      stats.starred = Math.max(0, (stats.starred || 0) + (on ? 1 : -1))
      if (starOnly && !on) items = items.filter((x) => x.id !== it.id)
      sig = ''; render()
      api('mail/star', { id: it.id, on }).then(load, load)
    }
    const d = el('button', 'ib del', BIN); d.type = 'button'; d.title = '删除'
    d.onclick = () => {
      items = items.filter((x) => x.id !== it.id); sig = ''; render()
      api('mail/delete', { ids: [it.id] }).then(load, load)
    }
    g.append(h, d)
    return g
  }

  const toast = (t) => {
    const e = $('toast'); if (!e) return
    e.textContent = t; e.hidden = false
    clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true }, 2600)
  }
  const fileUrl = (it, a, dl) => 'api/mail/file/' + encodeURIComponent(it.id) + '/' + encodeURIComponent(a.id) + (dl ? '?dl=1' : '')
  const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')

  /** a picture sent with a letter: shown inline, click to enlarge */
  function picture (it, a) {
    const fig = el('figure', 'att-pic')
    const im = el('img')
    im.src = fileUrl(it, a); im.alt = a.filename; im.loading = 'lazy'
    im.addEventListener('click', () => openBox(fileUrl(it, a), a.filename))
    const cap = el('figcaption'); cap.textContent = a.filename
    fig.append(im, cap)
    return fig
  }

  /** an HTML card: its own sandboxed frame (scripts yes, same origin no), inside the letter */
  function card (it, a) {
    const box = el('div', 'card')
    const bar = el('div', 'card-bar')
    const name = el('span', 'card-name'); name.textContent = a.filename; name.title = a.filename
    const fs = el('button', 'card-btn'); fs.type = 'button'; fs.textContent = '全屏看'
    const sv = el('button', 'card-btn'); sv.type = 'button'; sv.textContent = '另存'
    fs.onclick = () => openBox(fileUrl(it, a), a.filename, true)
    sv.onclick = () => saveAs(fileUrl(it, a, 1), a.filename)
    bar.append(name, fs, sv)
    const body = el('div', 'card-body')
    const frame = el('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')       // never allow-same-origin / popups / forms / downloads
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('loading', 'lazy')
    frame.title = a.filename
    frame.src = fileUrl(it, a)
    body.append(frame)
    box.append(bar, body)
    return box
  }

  /** pdf / other file: a card; only pdf may be handed to the system's default program, on this click */
  function fileCard (it, a) {
    const box = el('div', 'att-file')
    const ico = el('span', 'ico'); ico.textContent = a.kind === 'pdf' ? 'PDF' : a.kind === 'pptx' ? 'PPT' : 'FILE'
    const meta = el('span', 'fmeta')
    const nm = el('span', 'fname'); nm.textContent = a.filename; nm.title = a.filename
    const sz = el('span', 'fsize'); sz.textContent = sizeText(a.size || 0)
    meta.append(nm, sz)
    box.append(ico, meta)
    if (a.kind === 'pdf') {
      const open = el('button', 'card-btn'); open.type = 'button'; open.textContent = '打开'
      open.onclick = () => {
        open.disabled = true
        api('mail/open', { id: it.id, att: a.id }).then((r) => { open.disabled = false; if (!r || !r.ok) toast((r && r.message) || '打不开') }, () => { open.disabled = false })
      }
      box.append(open)
    }
    const sv = el('button', 'card-btn'); sv.type = 'button'; sv.textContent = '另存'
    sv.onclick = () => saveAs(fileUrl(it, a, 1), a.filename)
    box.append(sv)
    return box
  }

  function attachments (it) {
    if (!Array.isArray(it.attachments) || !it.attachments.length) return null
    const wrap = el('div', 'atts')
    for (const a of it.attachments) {
      if (!a || !a.id) continue
      if (a.kind === 'image' || a.kind === 'svg') wrap.append(picture(it, a))
      else if (a.kind === 'html') wrap.append(card(it, a))
      else wrap.append(fileCard(it, a))
    }
    return wrap.childElementCount ? wrap : null
  }

  function saveAs (href, filename) {
    const a = document.createElement('a')
    a.href = href; a.download = filename || 'file'
    document.body.append(a); a.click(); a.remove()
  }

  /** 放大 / 全屏看: the same isolated frame or the picture, in a dialog of this page */
  let boxOn = false
  function openBox (src, title, isCard) {
    const dlg = $('box')
    const im = $('boxImg'); const fr = $('boxFrame')
    $('boxName').textContent = title || ''
    if (isCard) { fr.src = src; fr.hidden = false; im.hidden = true } else { im.src = src; im.hidden = false; fr.hidden = true }
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '')
    boxOn = true
  }
  function closeBox () {
    const dlg = $('box')
    $('boxImg').removeAttribute('src'); $('boxFrame').removeAttribute('src')
    if (dlg.open && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open')
    boxOn = false
  }

  function letter (it) {
    const n = el('article', 'letter from-ai' + (it.read ? '' : ' unread') + (it.liked ? ' liked' : ''))
    n.dataset.id = it.id
    const side = el('div', 'side')
    const t = el('time'); t.textContent = hm(new Date(it.createdAt)); t.dateTime = it.createdAt
    side.append(acts(it), t)
    if (it.liked) side.append(likeMark(it.reaction))
    n.append(side)
    if (it.subject) { const h = el('h3'); h.textContent = it.subject; n.append(h) }
    n.append(el('div', 'md', md(it.body)))
    const atts = attachments(it)
    if (atts) n.append(atts)
    if (it.ext && it.ext.ok === false) {
      const f = el('div', 'foot'); f.textContent = '没同步到邮箱：' + (it.ext.message || it.ext.code || '失败'); n.append(f)
    }
    return n
  }

  function note (it) {
    const n = el('div', 'note from-user' + (it.liked ? ' liked' : '')); n.dataset.status = it.status || 'queued'
    const b = el('div', 'bubble')
    b.textContent = it.body || (it.attachments ? it.attachments.map((a) => '📎 ' + a.filename).join('\n') : '')
    if (it.body && it.attachments) b.textContent += '\n' + it.attachments.map((a) => '📎 ' + a.filename).join('\n')
    const meta = el('div', 'meta')
    if (it.via === 'agently') { const f = el('span', 'from'); f.textContent = '✉'; f.title = (it.from && it.from.email) || ''; meta.append(f) }
    const tm = el('time'); tm.textContent = hm(new Date(it.createdAt)); meta.append(tm)
    const st = el('span', 'st'); st.textContent = GLYPH[it.status] || '·'
    if (it.status === 'failed') st.title = WHY[it.error] || WHY.failed
    meta.append(st)
    meta.prepend(acts(it))
    if (it.liked) b.append(likeMark(it.reaction))
    if (it.status === 'failed' && it.id) {
      const r = el('button', 'retry'); r.type = 'button'; r.textContent = '重寄'
      r.onclick = () => { r.disabled = true; api('mail/retry', { id: it.id }).then(load) }
      meta.append(r)
    }
    n.append(b, meta)
    if (it.via === 'agently' && it.footer) { const f = el('div', 'meta'); f.textContent = it.footer; f.style.maxWidth = '100%'; n.append(f) }
    return n
  }

  function render () {
    const feed = $('feed')
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
    const all = (starOnly ? items : items.concat(pending)).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    if (!all.length) {
      const e = el('div', 'empty')
      if (starOnly) e.append(el('div', 'ghost', HEART))
      else {
        const img = el('img'); img.src = 'api/thumb/furniture/mailbox'; img.alt = ''
        img.onerror = () => img.remove()
        const p = el('div'); p.textContent = '还没有信'
        e.append(img, p)
      }
      feed.replaceChildren(e)
    } else {
      const frag = []; let lastDay = ''
      for (const it of all) {
        const d = new Date(it.createdAt); const k = d.toDateString()
        if (k !== lastDay) { lastDay = k; const s = el('div', 'day'); s.textContent = dayLabel(d); frag.push(s) }
        frag.push(it.dir === 'out' ? letter(it) : note(it))
      }
      feed.replaceChildren(...frag)
      if (atBottom || render.first) feed.scrollTop = feed.scrollHeight
    }
    render.first = false
    head()
  }

  function owner (o) {
    if (!o) return
    const t = (o.name ? o.name + '的' : '') + '邮箱'
    if ($('owner').textContent !== t) { $('owner').textContent = t; document.title = t }
    $('domain').textContent = o.domain || ''; $('domain').hidden = !o.domain
  }

  function head () {
    $('count').hidden = !stats.unread; $('count').textContent = stats.unread
    $('readAll').hidden = !stats.unread
    $('clear').disabled = !stats.total
  }
  render.first = true

  function load () {
    const want = starOnly
    return api('mail?limit=200' + (want ? '&starred=1' : '')).then((r) => {
      if (want !== starOnly) return
      if (!r || !r.ok) return
      stats = r.stats
      owner(r.owner)
      const ext = $('ext'); ext.hidden = !(r.agently && r.agently.enabled)
      if (r.agently) { ext.dataset.state = r.agently.state; ext.title = 'Agently Mail · ' + r.agently.state + (r.agently.quota ? ' · ' + r.agently.quota.used + '/' + r.agently.quota.limit : '') }
      const s = JSON.stringify(r.items)
      pending = pending.filter((p) => !r.items.some((x) => x.key === p.key || (x.dir === 'in' && x.body === p.body && Math.abs(new Date(x.createdAt) - new Date(p.createdAt)) < 60000)))
      if (s !== sig || pending.length) { sig = s; items = r.items; render() } else head()
      markSoon()
    }).catch(() => {})
  }

  let readTimer = null
  function markSoon () {
    if (!stats.unread || document.hidden || readTimer) return
    readTimer = setTimeout(() => {
      readTimer = null
      if (document.hidden) return
      api('mail/read', { all: true }).then(() => setTimeout(load, 900))
    }, 1600)
  }

  // ------------------------------------------------------------------ toolbar
  $('readAll').onclick = () => {
    for (const x of items) if (x.dir === 'out') x.read = true
    stats.unread = 0; sig = ''; render()
    api('mail/read', { all: true }).then(load, load)
  }
  $('starOnly').onclick = () => {
    starOnly = !starOnly
    $('starOnly').setAttribute('aria-pressed', String(starOnly))
    $('starOnly').title = starOnly ? '全部' : '收藏'
    document.body.classList.toggle('star-only', starOnly)
    items = starOnly ? items.filter((x) => x.starred) : items
    sig = ''; render.first = true; render(); load()
  }
  const dlg = $('confirm')
  function cfSync () {
    const total = stats.total || 0; const kept = stats.starred || 0
    const keep = $('cfKeepBox').checked
    const n = keep ? total - kept : total
    $('cfKeep').hidden = !kept; $('cfKeepN').textContent = kept ? '♥ ' + kept : ''
    $('cfText').textContent = '清空 ' + n + ' 封？'
    $('cfOk').disabled = !n
  }
  $('cfKeepBox').addEventListener('change', cfSync)
  $('clear').onclick = () => {
    $('cfKeepBox').checked = true; dlg.returnValue = ''; cfSync()
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '')
    $('cfOk').blur(); dlg.querySelector('button[value="cancel"]').focus()
  }
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return
    const keepStarred = $('cfKeepBox').checked
    items = keepStarred ? items.filter((x) => x.starred) : []
    pending = []; sig = ''; render()
    api('mail/clear', { keepStarred }).then(load, load)
  })

  // ------------------------------------------------------------------ compose
  const ta = $('text'); const btn = $('send')
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(168, ta.scrollHeight + 2) + 'px'; btn.disabled = !ta.value.trim() }
  ta.addEventListener('input', grow)
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('compose').requestSubmit() } })
  $('compose').addEventListener('submit', (e) => {
    e.preventDefault()
    const body = ta.value.trim()
    if (!body) return
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    pending.push({ dir: 'in', body, createdAt: new Date().toISOString(), status: 'queued', key })
    ta.value = ''; grow(); render.first = true; render()
    api('mail/write', { body, key }).then(load, load)
  })

  // 放大 / 全屏看 dialog
  $('boxClose').addEventListener('click', closeBox)
  $('box').addEventListener('close', () => { $('boxImg').removeAttribute('src'); $('boxFrame').removeAttribute('src'); boxOn = false })
  $('box').addEventListener('click', (e) => { if (e.target === $('box')) closeBox() })
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && boxOn) closeBox() })

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load() })
  load()
  setInterval(() => { if (!document.hidden) load() }, 2500)
})()
