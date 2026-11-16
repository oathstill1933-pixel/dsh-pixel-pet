(() => {
  const $ = (id) => document.getElementById(id)
  const api = (p, body, type) => fetch('api/' + p, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body: type ? body : JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({ ok: false, message: 'HTTP ' + r.status })))
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'on') for (const [e, f] of Object.entries(v)) n.addEventListener(e, f); else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v) }
    for (const c of [].concat(kids || [])) n.append(c)
    return n
  }
  const toast = (t) => { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true }, 2600) }
  const msg = (t, bad) => { $('msg').value = t || ''; $('msg').dataset.s = bad ? 'bad' : ''; $('msg').title = t || '' }
  const key = (i, sid = 'empty') => sid + '_' + String(i).padStart(2, '0')
  const SID_RE = /^[a-z][a-z0-9-]{0,23}$/
  const FNAME_RE = /^([a-z][a-z0-9-]{0,23})_(\d{2})\.(png|jpe?g|webp)$/i
  const DONE = { sleep: '{name}在{furniture}里睡下了。', use: '{name}到{furniture}旁边了。' }
  const POSE_LABEL = { waving: '招手', 'mood-happy': '开心', review: '检查', running: '忙', lie: '躺', jumping: '跳' }
  const NOKEY = '先在设置页「出图」里配好接口和 Key'
  const SPECS0 = {
    small: { label: '小摆件', icon: '▫', size: [160, 160], stateFrames: 2 },
    nest: { label: '窝/床', icon: '▭', size: [360, 300], stateFrames: 2 },
    desk: { label: '桌柜', icon: '▬', size: [300, 260], stateFrames: 2 },
    tall: { label: '高件', icon: '▯', size: [200, 360], stateFrames: 2 },
    custom: { label: '自定义', icon: '✎', size: null, stateFrames: 2 },
  }

  let J = null
  let META = { poses: Object.keys(POSE_LABEL), charPoses: [], specs: SPECS0, maxStates: 6, maxInteractions: 8, maxStateFrames: 6, imagegen: false }
  let step = 'card'; let route = 'session'; let chars = []; let who = ''
  const open = new Set()   // interaction rows showing their extra fields
  const params = new URLSearchParams(location.search)
  const img = (slot, k, v) => 'api/fcreate/' + J.id + '/img/' + slot + '/' + k + '?v=' + (v || J.updatedAt || 0)

  async function ensureJob () {
    if (J) return J
    const r = await api('fcreate/new', collect())
    if (!r.ok) throw new Error(r.message || '失败')
    J = r.job
    history.replaceState(null, '', '?kind=furniture&id=' + J.id)
    return J
  }
  const collect = () => {
    const c = card()
    return { name: $('name').value.trim(), desc: $('desc').value.trim(), done: $('done').value.trim(), spec: c.spec,
      ...(c.spec === 'custom' ? { size: [Number($('w').value) || 360, Number($('h').value) || 300] } : {}) }
  }
  const meta = (patch) => { $('brief').textContent = ''; return metaSend(patch) }
  const metaSend = (patch) => (J ? api('fcreate/' + J.id + '/meta', patch).then(reload) : ensureJob().then(() => api('fcreate/' + J.id + '/meta', patch)).then(reload))
  const reload = () => (J ? api('fcreate/' + J.id).then((r) => { if (r.ok) { J = r.job; render() } }) : Promise.resolve())
  const card = () => (J ? J.card : { spec: 'nest', name: '', desc: '', kind: 'sleep', size: [360, 300], anchor: [180, 230], clipY: null, area: null, clipPath: null, pose: 'waving', done: '', frames: 1,
    mainState: null, extraStates: [], interactions: [], idleState: 'empty', floorPad: 14, feature: null, featureCfg: null, main: null, exit: null,
    pack: { order: 40, defaultEnabled: false, anchor: 'bottom-right', stand: null } })
  /** the idle state's name: "empty" for new pieces, whatever the pack used when re-editing one */
  const idleOf = (c) => (c && c.idleState) || 'empty'
  const idleKey = (c, i = 0) => idleOf(c) + '_' + String(i).padStart(2, '0')
  /** every frame slot, grouped: idle first, then each extra animation */
  const groups = (c) => [{ id: idleOf(c), label: '空着', frames: c.frames, desc: '' }, ...(c.extraStates || [])]
  const allKeys = (c) => groups(c).flatMap((g) => Array.from({ length: g.frames }, (_, i) => key(i, g.id)))
  const hasInside = (c) => c.kind === 'sleep' || (c.interactions || []).some((i) => i.mode === 'inside')

  // ---------------------------------------------------------------- render
  function render () {
    const c = card()
    const thumb = J && J.frames[idleKey(c)] === 'done' ? img(J.build && J.build.ok ? 'frame' : 'raw', idleKey(c)) : ''
    $('hero').src = thumb; $('hero').style.visibility = thumb ? '' : 'hidden'
    if (document.activeElement !== $('name')) $('name').value = J ? c.name : ''
    for (const b of $('steps').querySelectorAll('button')) {
      const s = b.dataset.step
      b.setAttribute('aria-current', s === step ? 'step' : 'false')
      b.disabled = (s === 'art' && !J) || (s === 'place' && !(J && J.frames[idleKey(c)] === 'done'))
      b.dataset.done = String((s === 'card' && !!J) || (s === 'art' && !!J && J.plan.pending === 0) || (s === 'place' && !!(J && J.installed)))
    }
    for (const s of ['card', 'art', 'place']) $(s).hidden = s !== step
    $('tools').hidden = !hasInside(c)
    if (step === 'card') renderCard(c); else if (step === 'art') renderArt(c); else renderPlace(c)
    renderDock()
  }

  function renderCard (c) {
    const keep = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v }
    keep('desc', c.desc); keep('w', c.size[0]); keep('h', c.size[1]); keep('done', c.done)
    $('done').placeholder = '到了说：' + DONE[c.kind].replaceAll('{furniture}', c.name || '新家具')
    const specs = META.specs || SPECS0
    if (!$('spec').children.length) {
      $('spec').replaceChildren(...Object.entries(specs).map(([k, s]) => el('button', { 'data-v': k, 'data-tip': s.size ? s.size.join(' × ') + ' 像素' : '自己定尺寸' },
        [el('i', {}, s.icon || ''), s.label])))
    }
    for (const b of $('spec').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === c.spec))
    const free = c.spec === 'custom'
    $('w').disabled = $('h').disabled = !free
    $('dims').dataset.locked = String(!free)
    for (const b of $('kind').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === c.kind))
    for (const b of $('nframes').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === c.frames))
    if (!$('poseList').children.length) $('poseList').replaceChildren(...(META.charPoses || []).map((p) => el('option', { value: p })))
    const has = J && J.frames[idleKey(c)] === 'done'
    $('cardImg').hidden = !has
    if (has) $('cardImg').src = img(J.build && J.build.ok ? 'frame' : 'raw', idleKey(c))
    renderLists(c)
  }

  // ---- 动画 / 互动 rows: edits go out as whole arrays, the host bounds every field
  const stateOpts = (c, v) => [el('option', { value: '' }, '—'), ...(c.extraStates || []).map((s) => el('option', { value: s.id, selected: s.id === v ? '' : undefined }, s.label || s.id))]
  const xBtn = (tip, on) => el('button', { class: 'x', 'data-tip': tip, 'aria-label': tip, on: { click: on } }, '✕')
  const field = (list, i, f, attrs) => el('input', { ...attrs, 'data-l': list, 'data-i': i, 'data-f': f, spellcheck: 'false' })
  function renderLists (c) {
    const a = document.activeElement
    const focus = a && a.dataset && a.dataset.f ? [a.dataset.l, a.dataset.i, a.dataset.f, a.selectionStart] : null
    $('addState').disabled = c.extraStates.length >= (META.maxStates || 6)
    $('addInter').disabled = c.interactions.length >= (META.maxInteractions || 8)

    $('stateRows').replaceChildren(...c.extraStates.map((s, i) => el('div', { class: 'xr st-row' }, [
      field('extraStates', i, 'id', { value: s.id, class: 'mono', placeholder: 'open', maxlength: 24, 'data-tip': '英文名，图片按它命名：' + s.id + '_00.png' }),
      field('extraStates', i, 'label', { value: s.label === s.id ? '' : s.label, placeholder: '叫什么，如 开门', maxlength: 12 }),
      field('extraStates', i, 'desc', { value: s.desc, placeholder: '怎么动：门慢慢打开，露出里面的小灯', maxlength: 300 }),
      el('span', { class: 'num', 'data-tip': '帧数' }, [field('extraStates', i, 'frames', { type: 'number', min: 1, max: META.maxStateFrames || 6, value: s.frames }), el('i', {}, '帧')]),
      xBtn('删掉这段动画', () => meta({ extraStates: c.extraStates.filter((_, k) => k !== i) })),
    ])))

    const sleep = c.kind === 'sleep'
    const mainPose = sleep
      ? el('span', { class: 'muted' }, '睡姿')
      : el('select', { 'data-tip': '到了摆的姿势', on: { change: (e) => meta({ pose: e.target.value }) } },
        (META.poses || []).map((p) => el('option', { value: p, selected: p === c.pose ? '' : undefined }, POSE_LABEL[p] || p)))
    const rows = [el('div', { class: 'xr in-row main' }, [
      el('b', { class: 'verb mono', 'data-tip': '主要互动；新建的家具跟着上面「躺进去 / 站旁边」' }, (c.main && c.main.verb) || (sleep ? 'sleep' : 'use')),
      el('span', { class: 'mode' }, sleep ? '进去' : '旁边'),
      el('span', { class: 'muted say' }, sleep ? '去睡觉' : '去旁边'),
      mainPose,
      el('select', { 'data-tip': sleep ? '睡着时家具播的动画' : '家具同时播的动画', on: { change: (e) => meta({ mainState: e.target.value || null }) } }, stateOpts(c, c.mainState)),
      el('span'), el('span'), el('span'),
    ])]
    c.interactions.forEach((it, i) => {
      const inside = it.mode === 'inside'
      rows.push(el('div', { class: 'xr in-row' }, [
        field('interactions', i, 'verb', { value: it.verb, class: 'mono verb', placeholder: 'peek', maxlength: 24, 'data-tip': '动作名（英文），AI 用它来叫' }),
        el('select', { 'data-l': 'interactions', 'data-i': i, 'data-f': 'mode', 'data-tip': '去旁边，还是钻进去' },
          [el('option', { value: 'beside', selected: inside ? undefined : '' }, '旁边'), el('option', { value: 'inside', selected: inside ? '' : undefined }, '进去')]),
        field('interactions', i, 'say', { value: it.say, class: 'say', placeholder: '叫法，如 去看看窗外', maxlength: 24 }),
        field('interactions', i, 'pose', { value: it.pose || '', list: 'poseList', placeholder: inside ? 'curl-sleep' : '角色姿势', maxlength: 40, 'data-tip': '角色的动作名；角色没有这个动作就跳过' }),
        el('select', { 'data-l': 'interactions', 'data-i': i, 'data-f': 'furnitureState', 'data-tip': inside ? '进去后家具播的动画' : '家具同时播的动画' }, stateOpts(c, it.furnitureState)),
        inside ? el('span') : el('span', { class: 'num', 'data-tip': '持续多久' },
          [field('interactions', i, 'holdMs', { type: 'number', min: 0.5, max: 10, step: 0.5, value: it.holdMs / 1000 }), el('i', {}, '秒')]),
        el('button', { class: 'more', 'aria-pressed': String(open.has(i) || !!it.brief), 'data-tip': '什么时候用、到了说什么、想要的效果', 'aria-label': '更多',
          on: { click: () => { if (open.has(i)) open.delete(i); else open.add(i); renderLists(card()) } } }, '✎'),
        xBtn('删掉这个互动', () => { open.clear(); meta({ interactions: c.interactions.filter((_, n) => n !== i) }) }),
      ]))
      if (open.has(i)) {
        rows.push(el('div', { class: 'xr-more' }, [
          field('interactions', i, 'hint', { value: it.hint, placeholder: '什么时候用：用户说想看风景时', maxlength: 80 }),
          field('interactions', i, 'done', { value: it.done, placeholder: '到了说：{name}趴在窗边看风景', maxlength: 80 }),
          el('textarea', { rows: 2, 'data-l': 'interactions', 'data-i': i, 'data-f': 'brief', spellcheck: 'false', maxlength: 600,
            placeholder: '想要的效果，写给会话看：走到窗边踮脚往外看，窗帘被风吹起来……' }, it.brief || ''),
        ]))
      }
    })
    $('interRows').replaceChildren(...rows)
    if (focus) {
      const n = document.querySelector('[data-l="' + focus[0] + '"][data-i="' + focus[1] + '"][data-f="' + focus[2] + '"]')
      if (n) { n.focus(); try { if (focus[3] != null) n.setSelectionRange(focus[3], focus[3]) } catch {} }
    }
  }
  function listEdit (e) {
    const n = e.target; const { l, f } = n.dataset; const i = Number(n.dataset.i)
    if (!l || !f) return
    const c = card()
    const arr = c[l].map((x) => ({ ...x }))
    if (!arr[i]) return
    let v = n.value
    if (f === 'id' || f === 'verb') {
      v = v.trim().toLowerCase()
      if (!SID_RE.test(v)) { n.setAttribute('aria-invalid', 'true'); return toast('英文小写字母开头，只能用 a-z、0-9、-') }
      n.removeAttribute('aria-invalid')
    }
    if (f === 'frames') v = Number(v)
    if (f === 'holdMs') v = Math.round(Number(v) * 1000)
    if (f === 'furnitureState' || f === 'pose') v = v.trim() || null
    if (f === 'id' && arr[i].id !== v) {
      // a renamed animation keeps what pointed at it
      const old = arr[i].id
      arr[i].id = v
      return meta({ extraStates: arr, interactions: c.interactions.map((x) => (x.furnitureState === old ? { ...x, furnitureState: v } : x)),
        ...(c.mainState === old ? { mainState: v } : {}) })
    }
    arr[i][f] = v
    meta({ [l]: arr })
  }
  const uniqId = (base, taken) => { let n = 1; while (taken.includes(base + n)) n++; return base + n }

  function renderArt (c) {
    $('frames').replaceChildren(...groups(c).map((g) => el('div', { class: 'fg' }, [
      el('span', { class: 'gl', title: g.desc || '' }, [g.id === 'empty' ? '空着' : (g.label || g.id), el('small', { class: 'mono' }, g.id)]),
      el('div', { class: 'frow' }, Array.from({ length: g.frames }, (_, i) => {
        const k = key(i, g.id); const st = J.frames[k]
        return el('button', { class: 'fr' + (st === 'done' ? ' checker' : ''), 'data-s': st, 'data-tip': k + '.png', on: { click: () => pickSlot(k) } },
          st === 'done' ? el('img', { src: img('raw', k), alt: '' }) : el('i', {}, String(i + 1)))
      })),
    ])))
    for (const b of $('route').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.v === route))
      if (b.dataset.v === 'gen') { b.disabled = !META.imagegen; b.title = META.imagegen ? '' : NOKEY }
    }
    for (const n of document.querySelectorAll('#art [data-route]')) n.hidden = !n.dataset.route.split(' ').includes(route)
    if (route === 'session' && !$('brief').textContent) api('fcreate/' + J.id + '/handoff', {}).then((r) => { if (r.ok) $('brief').textContent = r.text })
  }
  let slotKey = ''
  const pickSlot = (k) => { if (J && J.run && J.run.running) return; slotKey = k; $('slotFile').click() }

  // ---- place: furniture frame + the chosen character's sleeping frame, as the runtime lays them
  const cache = new Map()
  const load = (src) => {
    if (!cache.has(src)) cache.set(src, new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src }))
    return cache.get(src)
  }
  const bboxOf = (im) => {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height
    const x = c.getContext('2d'); x.drawImage(im, 0, 0)
    const d = x.getImageData(0, 0, im.width, im.height).data
    let l = im.width; let t = im.height; let r = 0; let b = 0
    for (let y = 0; y < im.height; y++) for (let xx = 0; xx < im.width; xx++) if (d[(y * im.width + xx) * 4 + 3] >= 128) { l = Math.min(l, xx); t = Math.min(t, y); r = Math.max(r, xx + 1); b = Math.max(b, y + 1) }
    return r > l ? [l, t, r, b] : [0, 0, im.width, im.height]
  }
  // same rules as runtime/pixelpet/furniture.py: area -> scale down to fit (never up), bottom-centre on the
  // area's bottom-centre; no area -> anchor at 1:1. Furniture pixels on / below the front line go back on top.
  let tool = 'area'; let pts = null; let drag = null
  const frontPts = (c) => pts || c.clipPath || []
  const hasClipY = (c) => c.clipY !== null && c.clipY !== undefined
  const lineAt = (c, w) => {
    const p = frontPts(c)
    if (p.length >= 2) {
      return Array.from({ length: w }, (_, x) => {
        if (x <= p[0][0]) return p[0][1]
        if (x >= p[p.length - 1][0]) return p[p.length - 1][1]
        const i = p.findIndex((q) => x <= q[0]); const [xa, ya] = p[i - 1]; const [xb, yb] = p[i]
        return ya + (yb - ya) * (x - xa) / (xb - xa)
      })
    }
    return hasClipY(c) ? Array(w).fill(c.clipY) : null
  }
  const frontLayer = (furn, w, h, line) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const x = cv.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(furn, 0, 0, w, h)
    const im = x.getImageData(0, 0, w, h); const d = im.data
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const k = (yy * w + xx) * 4
        if (d[k + 3] < 128 || yy < Math.round(line[xx])) d[k + 3] = 0
      }
    }
    x.putImageData(im, 0, 0)
    return cv
  }
  async function draw () {
    if (!J || step !== 'place') return
    const c = card(); const [w, h] = c.size
    const furn = await load(img(J.build && J.build.ok ? 'frame' : 'raw', idleKey(c), J.build ? J.build.at : 0))
    const pose = hasInside(c) && who ? await load('api/fcreate/pose/' + who) : null
    const cv = $('stage'); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, w, h)
    if (furn) ctx.drawImage(furn, 0, 0, w, h)
    if (!hasInside(c)) return
    const area = drag && drag.area ? drag.area : c.area
    if (pose) {
      if (!pose.box) pose.box = bboxOf(pose)
      const [l, t, r, b] = pose.box
      const s = area ? Math.min(1, (area[2] - area[0]) / Math.max(1, r - l), (area[3] - area[1]) / Math.max(1, b - t)) : 1
      const [ax, ay] = area ? [(area[0] + area[2]) / 2, area[3]] : c.anchor
      ctx.drawImage(pose, Math.round(ax - (l + r) * s / 2), Math.round(ay - b * s), Math.round(pose.width * s), Math.round(pose.height * s))
      const line = lineAt(c, w)
      if (furn && line) ctx.drawImage(frontLayer(furn, w, h, line), 0, 0)
    }
    // guides: dashed box (or the old anchor cross), front polyline with its points
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#4c7dff'
    ctx.save(); ctx.lineWidth = 1
    if (area) {
      ctx.strokeStyle = accent; ctx.setLineDash([4, 3])
      ctx.strokeRect(area[0] + 0.5, area[1] + 0.5, area[2] - area[0] - 1, area[3] - area[1] - 1)
    } else {
      ctx.fillStyle = '#ff3b6b'; ctx.fillRect(c.anchor[0] - 3, c.anchor[1] - 1, 7, 3); ctx.fillRect(c.anchor[0] - 1, c.anchor[1] - 3, 3, 7)
    }
    const p = frontPts(c)
    ctx.strokeStyle = '#ff3b6b'; ctx.fillStyle = '#ff3b6b'
    if (p.length) {
      ctx.setLineDash([]); ctx.globalAlpha = 0.75
      ctx.beginPath(); ctx.moveTo(0, p[0][1] + 0.5)
      for (const q of p) ctx.lineTo(q[0] + 0.5, q[1] + 0.5)
      ctx.lineTo(w, p[p.length - 1][1] + 0.5); ctx.stroke()
      ctx.globalAlpha = 1
      for (const q of p) ctx.fillRect(q[0] - 2, q[1] - 2, 5, 5)
    } else if (hasClipY(c)) {
      ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6
      ctx.beginPath(); ctx.moveTo(0, c.clipY + 0.5); ctx.lineTo(w, c.clipY + 0.5); ctx.stroke()
    }
    ctx.restore()
  }
  const areaText = (a) => a.slice(0, 2).join(',') + ' – ' + a.slice(2).join(',')
  function renderPlace (c) {
    const b = J.build
    $('verdict').hidden = !b
    $('issues').hidden = true
    if (b) {
      $('vDot').dataset.s = b.ok ? 'ok' : 'bad'
      $('vText').textContent = (b.ok ? '校验通过' : (b.message || '校验没过')) + (J.handEdited ? ' · 互动被会话改过' : '')
      $('vMore').hidden = !(b.issues || []).length
      $('issues').textContent = (b.issues || []).join('\n')
    }
    for (const n of $('tools').querySelectorAll('[data-tool]')) n.setAttribute('aria-pressed', String(n.dataset.tool === tool))
    $('tClear').dataset.tip = tool === 'area' ? '清掉框' : '清掉前沿'
    $('tClear').disabled = tool === 'area' ? !c.area : !(frontPts(c).length || hasClipY(c))
    $('stage').dataset.tool = tool
    $('who').hidden = !hasInside(c) || chars.length < 2
    $('who').replaceChildren(...chars.map((ch) => el('button', { 'aria-pressed': String(ch.id === who), on: { click: () => { who = ch.id; render() } } }, ch.name)))
    $('anchorOut').value = c.area ? areaText(c.area) : c.anchor.join(', ')
    if (document.activeElement !== $('floorPad')) $('floorPad').value = c.floorPad
    draw()
  }

  function renderDock () {
    const run = J && J.run; const running = !!(run && run.running)
    $('prog').hidden = !(step === 'art' && J && running)
    if (step === 'art' && J) {
      const done = J.plan.total - J.plan.pending
      $('progBar').style.width = (J.plan.total ? done / J.plan.total * 100 : 0).toFixed(1) + '%'
      if (run && run.error) msg(run.error, true); else msg(done + ' / ' + J.plan.total)
    } else msg('')
    $('stop').hidden = !(step === 'art' && running)
    $('build').hidden = step !== 'place'
    const next = $('next'); next.hidden = false; next.disabled = false
    if (step === 'card') next.textContent = '下一步'
    else if (step === 'art') {
      if (running) next.hidden = true
      else if (J.plan.pending && route === 'gen') {
        next.textContent = '生成 ' + J.plan.pending + ' 张'
        next.disabled = !META.imagegen
        if (!META.imagegen) msg(NOKEY, true)
      } else { next.textContent = '下一步'; next.disabled = J.frames[idleKey(card())] !== 'done' }
    } else { next.textContent = J && J.installed ? '重新安装' : '安装'; next.disabled = !(J && J.build && J.build.ok) }
  }

  // ---------------------------------------------------------------- actions
  const ask = (n) => new Promise((done) => {
    $('cNum').textContent = n
    const d = $('confirm'); d.returnValue = ''
    d.onclose = () => done(d.returnValue === 'ok')
    d.showModal(); $('cOk').focus()
  })
  async function generate () {
    let n = J.plan.pending
    for (let tries = 0; tries < 2; tries++) {
      if (!(await ask(n))) return
      const r = await api('fcreate/' + J.id + '/run', { confirm: n })
      if (r.ok) { if (r.job) J = r.job; render(); return poll() }
      if (r.code === 'confirm') { n = r.total; continue }
      return toast(r.message || '失败')
    }
  }
  let polling = false
  function poll () {
    if (polling) return
    polling = true
    const tick = () => api('fcreate/' + J.id).then((r) => {
      if (r.ok) { J = r.job; render() }
      if (r.ok && J.run && J.run.running) return setTimeout(tick, 1200)
      polling = false
    }, () => { polling = false })
    tick()
  }
  /** named files go to their own slot; unnamed ones fill the empty slots in order; `target` = one slot picked by click */
  async function importFiles (files, target) {
    files = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name))
    if (!files.length) return
    try { await ensureJob() } catch (e) { return toast(e.message) }
    const free = allKeys(card()).filter((k) => J.frames[k] !== 'done')
    let bad = 0
    for (const f of files) {
      const name = target ? target + '.png' : FNAME_RE.test(f.name) ? f.name.toLowerCase() : (free.shift() || key(0)) + '.png'
      target = ''
      const r = await api('fcreate/' + J.id + '/import?name=' + encodeURIComponent(name), f, f.type || 'image/png')
      if (!r.ok) { bad++; toast(r.message || '导入失败') }
    }
    await reload()
    if (!bad) toast(files.length + ' 张')
  }
  async function build () {
    const b = $('build'); b.disabled = true; msg('…')
    const r = await api('fcreate/' + J.id + '/build', {})
    b.disabled = false
    if (r.job) J = r.job
    render()
    if (!r.ok && r.message) msg(r.message, true)
  }

  // ---------------------------------------------------------------- wiring
  $('steps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { step = b.dataset.step; render(); if (step === 'place' && !J.build) build() } })
  $('spec').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) meta({ spec: b.dataset.v }) })
  $('kind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) meta({ kind: b.dataset.v }) })
  $('nframes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) meta({ frames: Number(b.dataset.v) }) })
  $('route').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { route = b.dataset.v; render() } })
  for (const id of ['stateRows', 'interRows']) $(id).addEventListener('change', listEdit)
  $('addState').addEventListener('click', () => {
    const c = card(); const s = (META.specs || SPECS0)[c.spec] || {}
    meta({ extraStates: [...c.extraStates, { id: uniqId('anim', c.extraStates.map((x) => x.id)), label: '', frames: s.stateFrames || 2, desc: '' }] })
  })
  $('addInter').addEventListener('click', () => {
    const c = card()
    open.add(c.interactions.length)
    meta({ interactions: [...c.interactions, { verb: uniqId('act-', c.interactions.map((x) => x.verb)), mode: 'beside', say: '', holdMs: 3000 }] })
  })
  for (const id of ['desc', 'done']) $(id).addEventListener('change', () => meta({ [id]: $(id).value.trim() }))
  for (const id of ['w', 'h']) $(id).addEventListener('change', () => meta({ size: [Number($('w').value), Number($('h').value)] }))
  $('name').addEventListener('change', () => meta({ name: $('name').value.trim() }))
  $('floorPad').addEventListener('change', () => meta({ floorPad: Number($('floorPad').value) }))
  $('file').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = '' })
  $('slotFile').addEventListener('change', (e) => { importFiles([...e.target.files], slotKey); e.target.value = '' })
  const drop = $('drop'); let depth = 0
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('over') })
  drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over') } })
  drop.addEventListener('dragover', (e) => e.preventDefault())
  drop.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; drop.classList.remove('over'); importFiles([...e.dataTransfer.files]) })
  $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('brief').textContent); toast('已复制') } catch { toast('复制失败') } })
  $('send').addEventListener('click', async () => {
    const r = await api('fcreate/' + J.id + '/handoff', { send: true })
    toast(r.ok ? '已发到会话' : (r.message || '发送失败'))
    if (r.ok) poll2()
  })
  // a session saving straight into raw/ shows up without a click
  let watch = 0
  const poll2 = () => { clearInterval(watch); let n = 0; watch = setInterval(() => { if (++n > 200 || (J && J.plan.pending === 0)) clearInterval(watch); reload() }, 3000) }
  $('stop').addEventListener('click', () => api('fcreate/' + J.id + '/stop', {}).then(reload))
  $('vMore').addEventListener('click', () => { $('issues').hidden = !$('issues').hidden })
  $('build').addEventListener('click', build)
  const stagePoint = (e) => {
    const cv = $('stage'); const r = cv.getBoundingClientRect()
    return [Math.max(0, Math.min(cv.width, Math.round((e.clientX - r.left) * cv.width / r.width))),
      Math.max(0, Math.min(cv.height, Math.round((e.clientY - r.top) * cv.height / r.height)))]
  }
  const rectOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  $('stage').addEventListener('pointerdown', (e) => {
    if (!J || !hasInside(card())) return
    const p = stagePoint(e)
    if (tool === 'area') { drag = { from: p, area: null }; try { $('stage').setPointerCapture(e.pointerId) } catch {} return }
    // 前沿: a click adds a point (same x replaces it); a click on a point removes it
    const cur = frontPts(card()).map((q) => [...q])
    const near = cur.findIndex((q) => Math.abs(q[0] - p[0]) <= 5 && Math.abs(q[1] - p[1]) <= 5)
    const next = near >= 0 ? cur.filter((_, i) => i !== near) : [...cur.filter((q) => q[0] !== p[0]), p].sort((a, b) => a[0] - b[0]).slice(0, 24)
    const line = next.length >= 2
    pts = line ? null : next                     // a single point stays on the page until the second one makes a line
    J.card.clipPath = line ? next : null
    if (line || near >= 0 || cur.length >= 2) meta({ clipPath: J.card.clipPath })
    else renderPlace(card())
  })
  $('stage').addEventListener('pointermove', (e) => {
    if (!drag) return
    const a = rectOf(drag.from, stagePoint(e))
    drag.area = a[2] - a[0] >= 4 && a[3] - a[1] >= 4 ? a : null
    if (drag.area) $('anchorOut').value = areaText(a)
    draw()
  })
  const endDrag = () => {
    if (!drag) return
    const a = drag.area; drag = null
    if (a) { J.card.area = a; meta({ area: a }) } else draw()
  }
  $('stage').addEventListener('pointerup', endDrag)
  $('stage').addEventListener('pointercancel', endDrag)
  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return
    if (b.dataset.tool) { tool = b.dataset.tool; return renderPlace(card()) }
    if (tool === 'area') meta({ area: null }); else { pts = null; meta({ clipPath: null, clipY: null }) }
  })
  $('next').addEventListener('click', async () => {
    if (step === 'card') { try { await ensureJob(); await meta(collect()) } catch (e) { return toast(e.message) } step = 'art'; return render() }
    if (step === 'art') {
      if (J.plan.pending && route === 'gen') return META.imagegen ? generate() : toast(NOKEY)
      step = 'place'; render(); if (!J.build || !J.build.ok) build(); return
    }
    const r = await api('fcreate/' + J.id + '/install', {})
    if (!r.ok) return toast(r.message || '安装失败')
    J = r.job; render(); toast('已安装')
    try { window.opener && window.opener.postMessage('pixelpet:furniture', location.origin) } catch {}
  })
  $('hero').addEventListener('error', () => { $('hero').style.visibility = 'hidden' })

  /** hover names for [data-tip] (same #tip look as the main panel) */
  function tips () {
    const tip = $('tip'); let cur = null
    const show = (n) => {
      cur = n; tip.textContent = n.dataset.tip; tip.hidden = false
      const r = n.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'
      tip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px'
    }
    const hide = () => { cur = null; tip.hidden = true }
    document.addEventListener('pointerover', (e) => { const n = e.target.closest && e.target.closest('[data-tip]'); if (n && n !== cur) show(n); else if (!n && cur) hide() })
    document.addEventListener('focusin', (e) => { const n = e.target.closest && e.target.closest('[data-tip]'); if (n) show(n) })
    document.addEventListener('focusout', hide)
    document.addEventListener('scroll', hide, true)
  }
  tips()

  // ---------------------------------------------------------------- boot
  Promise.all([api('fcreate/meta'), api('fcreate/jobs'), api('state')]).then(async ([m, jobs, st]) => {
    META = m.ok ? { ...META, ...m } : META
    route = META.imagegen ? 'gen' : 'session'
    chars = ((st && st.characters) || []).filter((c) => !c.draft)
    who = (st && st.settings && chars.some((c) => c.id === st.settings.character) && st.settings.character) || (chars[0] && chars[0].id) || ''
    const id = params.get('id')
    if (params.get('edit') === '1' && id) {
      // ✎ on a furniture card: read the installed piece back, then edit that job
      const r = await api('fcreate/reverse', { id })
      if (r.ok && r.job) { J = r.job; history.replaceState(null, '', '?kind=furniture&id=' + J.id) } else toast((r && r.message) || '这件家具读不出来')
    } else if (id) { const r = await api('fcreate/' + id); if (r.ok) J = r.job }
    const list = (jobs.jobs || []).filter((j) => !J || j.id !== J.id)
    if (list.length) {
      $('jobs').hidden = false
      $('jobs').replaceChildren(el('option', { value: J ? J.id : '', selected: '' }, J ? J.card.name : '＋'), ...(J ? [el('option', { value: 'new' }, '＋')] : []),
        ...list.map((j) => el('option', { value: j.id }, j.name)))
      $('jobs').addEventListener('change', (e) => { const v = e.target.value; location.search = '?kind=furniture' + (v === 'new' || !v ? '' : '&id=' + v) })
    }
    if (J) step = params.get('step') || (J.build ? 'place' : 'art')
    render()
    if (J && J.run && J.run.running) poll()
  }, () => render())
})()
