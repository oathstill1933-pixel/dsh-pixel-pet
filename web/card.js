// 「一起听歌」 桌宠小卡片 v2. Data per docs/MUSIC_CONTRACT.md: /api/music/now (1 s), /api/music/live (~15 fps),
// POST /api/music/control, GET /api/music/local. Runs in a pywebview window (runtime/music/pixelmusic/cardwin.py):
// mode + close go to window.pywebview.api.set_mode / close; the window process resizes and docks itself.
// (the pet runtime re-clips / re-docks the window). #demo[&mode=mini][&shift=1] runs on fictional data.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const hash = new URLSearchParams(location.hash.slice(1).replace(/;/g, '&'))
  const DEMO = hash.has('demo')
  const base = location.pathname.replace(/\/card(\.html)?$/, '')
  const api = (p) => base + '/api/' + p
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const BARS = 72
  const ROW = 21
  const IDLE_MS = 15000
  const MODES = ['list', 'one', 'shuffle']

  const body = document.body
  const card = $('card')
  const state = { now: null, pos: 0, playing: false, at: performance.now(), bars: null, env: [], mode: 'full', playMode: 'list', lyricKey: '' }

  // ---------- helpers
  const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
  function envelope (key) { // stable whole-song contour when the service has no energy curve
    let x = hashStr(key) || 1; const rnd = () => ((x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0) / 4294967296)
    return Array.from({ length: BARS }, (_, i) => {
      const t = i / (BARS - 1)
      const arc = 0.35 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.12 * Math.sin(t * 19)
      return Math.max(0.14, Math.min(1, arc * (0.55 + 0.45 * rnd())))
    })
  }
  const resample = (a) => Array.from({ length: BARS }, (_, i) => Math.max(0.1, Math.min(1, +a[Math.floor(i * a.length / BARS)] || 0)))
  const placeholder = (key) => {
    const h = hashStr(key) % 360
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},45%,78%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},40%,42%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="70" cy="32" r="18" fill="#fff" opacity=".22"/><path d="M0 78 Q30 62 55 74 T100 70 V100 H0z" fill="#000" opacity=".12"/></svg>`
    return 'data:image/svg+xml,' + encodeURIComponent(svg)
  }
  function tintFrom (img) { // average colour of the artwork -> --tint (soft glow / shadows / lyric hue)
    try {
      const c = document.createElement('canvas'); c.width = c.height = 8
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 8, 8)
      const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2] }
      const n = d.length / 4
      document.documentElement.style.setProperty('--tint', `rgb(${r / n | 0},${gg / n | 0},${b / n | 0})`)
    } catch {}
  }
  $('cover').addEventListener('load', (e) => tintFrom(e.target))

  // ---------- progress: a calliper-style ruler (even ticks, minor / mid / major every 1 / 5 / 10)
  // Known duration: ticks stay put, the playhead walks left -> right, played part is ink.
  // Unknown duration (e.g. NetEase over SMTC reports none): the playhead stays centred and the ruler
  // scrolls under it like a tape measure, 1 tick per second -- never a fake percentage.
  const wave = $('wave')
  const cv = document.createElement('canvas')
  wave.appendChild(cv)
  const g = cv.getContext('2d')
  const STEP = 5            // css px between ticks
  const TAPE_PX_PER_S = STEP
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
  const curPos = () => state.pos + (state.playing ? (performance.now() - state.at) / 1000 : 0)
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
  let inkOn = '#1d1f25', inkOff = '#d5d8de'
  const readInk = () => { inkOn = css('--wave-on') || inkOn; inkOff = css('--wave-off') || inkOff }
  readInk()
  function drawWave () {
    const w = wave.clientWidth, h = wave.clientHeight
    if (!w || !h) return
    const dpr = devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); readInk()
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const d = state.now?.track?.duration || 0
    const pos = curPos()
    const tape = !d
    const head = tape ? Math.round(w / 2) : Math.round(Math.min(1, pos / d) * (w - 1))
    const base = h - 1
    // tick k: tape -> the k-th second, x = head + (k - pos) * px/s ; fixed -> evenly spread over the width
    const from = tape ? Math.floor(pos - head / TAPE_PX_PER_S) - 1 : 0
    const to = tape ? Math.ceil(pos + (w - head) / TAPE_PX_PER_S) + 1 : Math.floor((w - 1) / STEP)
    g.lineWidth = 1
    for (let k = from; k <= to; k++) {
      const x0 = tape ? head + (k - pos) * TAPE_PX_PER_S : k * STEP
      if (x0 < 0 || x0 > w) continue
      const x = Math.round(x0) + 0.5
      const n = ((k % 10) + 10) % 10
      const len = n === 0 ? h * 0.78 : n === 5 ? h * 0.52 : h * 0.3
      g.strokeStyle = x <= head ? inkOn : inkOff
      g.globalAlpha = tape ? Math.max(0.25, 1 - Math.abs(x - head) / (w / 2) * 0.75) : 1
      g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - len); g.stroke()
    }
    g.globalAlpha = 1
    g.strokeStyle = inkOn; g.lineWidth = 1.5
    g.beginPath(); g.moveTo(head + 0.5, 0); g.lineTo(head + 0.5, h); g.stroke()
    g.fillStyle = inkOn
    g.beginPath(); g.arc(head + 0.5, 1.5, 2, 0, Math.PI * 2); g.fill()
    const tp = $('tPos'), td = $('tDur')
    if (tp) { const t = fmt(pos); if (tp.textContent !== t) tp.textContent = t }
    if (td) { const t = d ? fmt(d) : ''; if (td.textContent !== t) td.textContent = t }
    wave.classList.toggle('tape', tape)
  }
  wave.addEventListener('click', (e) => {
    const d = state.now?.track?.duration || 0
    if (!state.now?.capabilities?.seek || !d) return
    const r = wave.getBoundingClientRect()
    control('seek', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d)
  })

  // ---------- lyrics: keyed rows, each placed by its distance d from the current line
  const track = $('track')
  const rows = new Map() // absolute index -> <p>
  const LOOK = { 0: [1.1, 1], 1: [0.95, 0.9], 2: [0.86, 0.6] }
  function setLyrics (ly) {
    let cur = -1; let lines = []
    if (ly && ly.available) {
      cur = Number(ly.index) | 0
      const w = ly.window
      if (w && typeof w === 'object') {
        const before = (w.before || []).slice(-2); const after = (w.after || []).slice(0, 2)
        lines = [...before.map((t, k) => [cur - before.length + k, t]), [cur, w.current ?? ly.line ?? ''], ...after.map((t, k) => [cur + 1 + k, t])]
      } else {
        lines = [[cur, ly.line || '']]
        if (ly.next) lines.push([cur + 1, ly.next])
        for (const [i, p] of rows) if (i < cur && i >= cur - 2) lines.push([i, p.textContent]) // keep what we saw
      }
    }
    const key = cur + '|' + lines.map((l) => l[1]).join('\u0001')
    if (key === state.lyricKey) return
    state.lyricKey = key
    if (!lines.length) {
      for (const p of rows.values()) p.remove()
      rows.clear()
      if (!track.querySelector('.none')) { const p = document.createElement('p'); p.className = 'none'; p.dataset.d = '0'; p.textContent = '暂无歌词'; track.append(p) }
      return
    }
    track.querySelector('.none')?.remove()
    const want = new Map(lines)
    for (const [i, t] of want) {
      let p = rows.get(i)
      if (!p) { // enters from below (or above), invisible, then glides into place
        p = document.createElement('p'); rows.set(i, p); track.append(p)
        place(p, i > cur ? 3 : -3, true)
      }
      if (p.textContent !== (t || '♪')) p.textContent = t || '♪'
    }
    void track.offsetHeight
    for (const [i, p] of rows) {
      const d = i - cur
      if (!want.has(i) || Math.abs(d) > 2) {
        place(p, Math.sign(d) * 3, false)
        rows.delete(i)
        setTimeout(() => p.remove(), reduced ? 0 : 480)
      } else place(p, d, false)
    }
  }
  function place (p, d, instant) {
    const [s, o] = LOOK[Math.abs(d)] || [0.8, 0]
    if (instant) p.style.transition = 'none'
    p.dataset.d = String(Math.max(-2, Math.min(2, d)))
    p.style.transform = `translateY(${d * ROW}px) scale(${s})`
    p.style.opacity = String(o)
    if (instant) { void p.offsetHeight; p.style.transition = '' }
  }

  // ---------- render snapshot
  let lastKey = null
  function render () {
    const n = state.now || {}
    const t = n.track || {}
    body.classList.toggle('playing', !!state.playing)
    body.classList.toggle('paused', !state.playing)
    card.classList.toggle('seekable', !!n.capabilities?.seek)
    const key = (t.title || '') + '\u0000' + (t.artist || '')
    if (key !== lastKey) {
      const first = lastKey === null
      lastKey = key
      const apply = () => {
        state.env = Array.isArray(n.energy) && n.energy.length ? resample(n.energy) : envelope(key)
        const src = t.cover ? base + t.cover : placeholder(key)
        for (const id of ['cover', 'discLabel', 'miniLabel']) $(id).src = src
        const label = [t.title, t.artist].filter(Boolean).join(' — ')
        $('cover').alt = label; $('mini').title = label
        $('title').textContent = t.title || ''; $('artist').textContent = t.artist || ''
        $('title').title = t.title || ''; $('artist').title = t.artist || ''
      }
      if (first || reduced || state.mode !== 'full') apply()
      else swapTrack(apply)
    }
    if (n.mode && MODES.includes(n.mode)) state.playMode = n.mode
    $('bMode').dataset.mode = state.playMode
    // 「列表和循环用不了」：云端播放时这两项本来就操作不了——
    // 队列在网易云手里，SMTC 也不给改重复模式。按钮留着，但把原因写清楚，别让人以为坏了。
    const cloudNoList = n.source === 'cloud'
    const noMode = !!(n.capabilities && n.capabilities.mode === false)
    $('bList').disabled = cloudNoList
    $('bList').title = cloudNoList ? '云端播放时列表由网易云管，这里改不了' : '播放列表'
    $('bVol').disabled = n.capabilities && n.capabilities.volume === false
    $('bMode').disabled = noMode
    $('bMode').title = noMode ? '这个播放器不开放循环模式切换' : '播放模式：列表 / 单曲 / 随机'
    if (typeof n.volume === 'number' && document.activeElement !== $('vol')) $('vol').value = String(Math.round(n.volume))
  }

  // ---------- track change: cover / record / title slide out one way and the new ones slide in from the other.
  // 下一首（或歌自己播完换了）= 往左走、新的从右边进来；上一首反过来。用独立的 translate 属性，
  // 不跟唱片自转的 transform 打架。连续快速切歌时只保留最后一次。
  let navDir = 0; let navAt = 0
  let swapSeq = 0; let swapLive = []
  function swapTrack (apply) {
    const seq = ++swapSeq
    for (const a of swapLive) a.cancel()
    const dir = navDir && performance.now() - navAt < 5000 ? navDir : 1
    navDir = 0
    const els = [$('cover'), $('disc'), document.querySelector('.meta')].filter(Boolean)
    const D = 22 * dir
    const outs = els.map((el, i) => el.animate(
      [{ translate: '0 0', opacity: 1 }, { translate: -D + 'px 0', opacity: 0 }],
      { duration: 150, delay: i * 25, easing: 'cubic-bezier(.32, 0, .67, 0)', fill: 'forwards' }))
    swapLive = outs
    Promise.all(outs.map((a) => a.finished.catch(() => {}))).then(() => {
      if (seq !== swapSeq) return // a newer change took over; it applies its own content
      apply()
      for (const a of outs) a.cancel()
      swapLive = els.map((el, i) => el.animate(
        [{ translate: D + 'px 0', opacity: 0 }, { translate: '0 0', opacity: 1 }],
        { duration: 280, delay: i * 40, easing: EASE, fill: 'backwards' }))
    })
  }

  // ---------- controls
  async function post (p, b) {
    const r = await fetch(api(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    return r.json().catch(() => null)
  }
  async function control (action, value) {
    if (DEMO) return demoControl(action, value)
    try { await post('music/control', value === undefined ? { action } : { action, value }) } catch {}
    pollNow()
  }
  $('bToggle').onclick = () => { state.pos = curPos(); state.at = performance.now(); state.playing = !state.playing; render(); control('toggle') }
  $('bPrev').onclick = () => { navDir = -1; navAt = performance.now(); control('prev') }
  $('bNext').onclick = () => { navDir = 1; navAt = performance.now(); control('next') }
  $('bMode').onclick = () => {
    state.playMode = MODES[(MODES.indexOf(state.playMode) + 1) % MODES.length]
    render(); control('mode', state.playMode)
  }
  let volTimer = 0
  $('vol').addEventListener('input', (e) => { clearTimeout(volTimer); volTimer = setTimeout(() => control('volume', +e.target.value), 120) })

  function popup (which) {
    for (const [btn, pop] of [['bVol', 'volPop'], ['bList', 'listPop']]) {
      const open = pop === which && $(pop).hidden
      $(pop).hidden = !open; $(btn).classList.toggle('on', open)
    }
    if (which === 'listPop' && !$('listPop').hidden) loadQueue()
  }
  $('bVol').onclick = (e) => { e.stopPropagation(); popup('volPop') }
  $('bList').onclick = (e) => { e.stopPropagation(); popup('listPop') }
  document.addEventListener('click', (e) => { if (!e.target.closest('.pop')) popup(null) })

  async function loadQueue () {
    const q = DEMO ? demoQueue() : await getJSON('music/local').catch(() => null)
    const ol = $('queue')
    ol.replaceChildren(...(q?.items || []).map((it) => {
      const li = document.createElement('li'); li.className = it.index === q.index ? 'cur' : ''
      const b = document.createElement('b'); b.textContent = it.title || '未命名'
      const s = document.createElement('span'); s.textContent = it.artist || ''
      li.append(b, s); li.onclick = () => { control('local_play', it.index); popup(null) }
      return li
    }))
    if (!ol.children.length) { const li = document.createElement('li'); li.innerHTML = '<span>队列是空的</span>'; ol.append(li) }
  }

  // ---------- full <-> mini
  // The window keeps the full card's size; collapsed it is a round region at state.mini (pushed by the window
  // process via __cardMini). Expanding/collapsing: the window morphs its region circle <-> card on a timer while
  // the record flies between that circle and its place in the card, same duration (info.ms) and ease-out cubic.
  const EASE = 'cubic-bezier(.33, 1, .68, 1)'
  const FADE = ['.meta', '.ctl', '.wave', '.times', '.lyrics', '.x']
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
  const mini = $('mini')
  state.mini = { x: 6, y: 6, d: 64 }
  let morphing = false
  function placeMini () { const s = mini.style; s.left = state.mini.x + 'px'; s.top = state.mini.y + 'px'; s.width = s.height = state.mini.d + 'px' }
  window.__cardMini = (x, y, d) => { state.mini = { x, y, d }; if (!morphing) placeMini() }
  placeMini()
  function discBox () { // the disc spins, so its bounding rect is useless: stage rect + layout offsets instead
    const st = card.querySelector('.stage').getBoundingClientRect(); const d = $('disc')
    return { x: st.left + d.offsetLeft, y: st.top + d.offsetTop, d: d.offsetWidth }
  }
  const flight = (to) => { const f = state.mini; return `translate(${to.x - f.x}px, ${to.y - f.y}px) scale(${to.d / f.d})` }
  const fades = () => [...FADE.map((q) => card.querySelector(q)), $('cover')].filter(Boolean)
  async function tellWindow (m, animate) {
    const r = await Promise.resolve(native('set_mode', m, animate)).catch(() => null)
    if (r && r.d) { state.mini = { x: r.x, y: r.y, d: r.d } }
    return r && r.ms ? r.ms : 300
  }
  async function setMode (m, tell = true) {
    if (m === state.mode || morphing) return
    popup(null)
    if (!tell || reduced) {
      state.mode = m
      body.classList.toggle('is-mini', m === 'mini')
      if (m === 'full') poke()
      if (tell) tellWindow(m, false)
      return
    }
    morphing = true
    try { await (m === 'full' ? expand() : collapse()) } finally { morphing = false; placeMini() }
  }
  async function expand () {
    state.mode = 'full'
    body.classList.add('flying', 'morph-in')
    body.classList.remove('is-mini')
    const ms = await tellWindow('full', true)           // the window prepares its region morph
    placeMini()
    $('disc').style.visibility = 'hidden'
    await nextFrame()
    native('go')                                         // region morph and record flight start together
    const fly = mini.animate([{ transform: 'none' }, { transform: flight(discBox()) }], { duration: ms, easing: EASE, fill: 'forwards' })
    fades().forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, delay: el.id === 'cover' ? ms : 70 + i * 35, easing: EASE, fill: 'backwards' }))
    body.classList.remove('morph-in')                    // the animations' backwards fill keeps them hidden until their turn
    await fly.finished.catch(() => {})
    $('disc').style.visibility = ''
    body.classList.remove('flying')
    fly.cancel()
    poke()
  }
  async function collapse () {
    clearTimeout(idle)
    const outs = fades().map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' }))
    await sleep(140)
    const from = discBox()
    body.classList.add('flying')
    $('disc').style.visibility = 'hidden'
    mini.style.transform = flight(from)                  // record sits exactly on the disc before the window shrinks
    const ms = await tellWindow('mini', true)
    await nextFrame()
    native('go')
    const fly = mini.animate([{ transform: flight(from) }, { transform: 'none' }], { duration: ms, easing: EASE, fill: 'forwards' })
    mini.style.transform = ''
    await fly.finished.catch(() => {})
    state.mode = 'mini'
    body.classList.add('is-mini')
    body.classList.remove('flying')
    fly.cancel(); outs.forEach((a) => a.cancel())
    $('disc').style.visibility = ''
  }
  function native (fn, ...args) { try { const a = window.pywebview && window.pywebview.api; if (a && a[fn]) return a[fn](...args) } catch {} return null }
  function closeCard () { if (native('close') === null && !DEMO) window.close() }
  addEventListener('pywebviewready', () => tellWindow(state.mode, false))
  $('bClose').onclick = closeCard
  $('mini').addEventListener('contextmenu', (e) => { e.preventDefault(); closeCard() })
  $('mini').onclick = () => setMode('full')
  let idle = 0
  function poke () { clearTimeout(idle); if (state.mode === 'full') idle = setTimeout(() => setMode('mini'), IDLE_MS) }
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input']) addEventListener(ev, poke, { passive: true })
  addEventListener('blur', () => { if (!DEMO) setMode('mini') })
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); $('bToggle').click() }
    if (e.key === 'Escape') setMode('mini')
  })

  // ---------- data
  function applyNow (n) {
    state.now = n
    if (typeof n.position === 'number') { state.pos = n.position; state.at = performance.now() }
    state.playing = !!n.playing
    if (n.spectrum?.available) state.bars = n.spectrum.bars
    setLyrics(n.lyric)
    render()
  }
  let lastIdx = null
  function applyLive (l) {
    if (typeof l.position === 'number') { state.pos = l.position; state.at = performance.now() }
    if (typeof l.playing === 'boolean' && l.playing !== state.playing) { state.playing = l.playing; render() }
    state.bars = l.spectrum?.bars || null
    const idx = l.lyric?.index
    if (typeof idx === 'number' && idx !== lastIdx) {
      lastIdx = idx
      if (l.lyric.window && state.now?.lyric) setLyrics({ ...state.now.lyric, available: idx >= 0, index: idx, window: l.lyric.window })
      pollNow()
    }
  }
  async function getJSON (p) { const r = await fetch(api(p), { cache: 'no-store' }); return r.json() }
  let busy = false
  async function pollNow () {
    if (busy) return; busy = true
    try { const n = await getJSON('music/now'); if (n) applyNow(n) } catch {} finally { busy = false }
  }
  function liveLoop () {
    if (document.hidden || state.mode === 'mini') return setTimeout(liveLoop, 500)
    getJSON('music/live').then(applyLive).catch(() => {}).finally(() => setTimeout(liveLoop, 66))
  }
  function frame () { if (state.mode === 'full') drawWave(); requestAnimationFrame(frame) }

  // ---------- demo (fictional track, artist and lyrics only)
  const DEMO_LINES = ['（示例歌词）清晨的窗台落下一点光', '风把昨天的话吹得很轻', '我们沿着河慢慢走', '影子比脚步先到家', '把这一段旋律留给晚上', '灯一盏一盏亮起来', '说好明天还在这里']
  const demo = { line: 2, playing: true, pos: 96, mode: 'list', vol: 62 }
  function demoNow () {
    const i = demo.line
    return {
      ok: true, enabled: true, source: 'local', playing: demo.playing, mode: demo.mode, volume: demo.vol,
      track: { title: '示例曲目' + (demo.song ? ' ' + (demo.song + 1) : ''), artist: '示例艺人', album: '', duration: hash.has('nodur') ? null : 214, cover: null },
      position: demo.pos,
      lyric: { available: true, index: i, line: DEMO_LINES[i], next: DEMO_LINES[i + 1] || '', window: { before: DEMO_LINES.slice(Math.max(0, i - 2), i), current: DEMO_LINES[i], after: DEMO_LINES.slice(i + 1, i + 3) } },
      spectrum: { available: true, bars: Array.from({ length: 48 }, (_, k) => 0.3 + 0.5 * Math.abs(Math.sin(k * 0.7 + demo.pos * 3))) },
      capabilities: { seek: true, playSpecific: true, loopback: true, volume: true }
    }
  }
  const demoQueue = () => ({ index: 1, items: [['示例曲目甲', '示例艺人'], ['示例曲目', '示例艺人'], ['示例曲目乙', '另一位示例艺人'], ['示例曲目丙', '示例艺人']].map(([title, artist], index) => ({ index, title, artist })) })
  function demoControl (a, v) {
    if (a === 'toggle') demo.playing = !demo.playing
    if (a === 'mode') demo.mode = v
    if (a === 'volume') demo.vol = v
    if (a === 'next' || a === 'prev') { demo.song = ((demo.song || 0) + (a === 'next' ? 1 : 2)) % 3; demo.line = 0; demo.pos = 0 }
    applyNow(demoNow())
  }
  function startDemo () {
    if (hash.get('paused')) demo.playing = false
    applyNow(demoNow())
    if (hash.get('mode') === 'mini') setMode('mini', false)
    if (hash.get('pop') === 'list') popup('listPop')
    if (hash.get('shift')) setTimeout(() => { demo.line++; applyNow(demoNow()) }, +hash.get('shift') || 1000)
    else setInterval(() => { if (!demo.playing) return; demo.pos += 0.25; state.bars = demoNow().spectrum.bars; if (Math.round(demo.pos * 4) % 16 === 0) { demo.line = (demo.line + 1) % (DEMO_LINES.length - 2); setLyrics(demoNow().lyric) } }, 250)
  }

  // ---------- boot
  requestAnimationFrame(frame)
  poke()
  if (DEMO) { startDemo(); return }
  setMode('mini', false)        // the window process starts collapsed too; told on pywebviewready
  pollNow(); setInterval(pollNow, 1000)
  liveLoop()
})()
