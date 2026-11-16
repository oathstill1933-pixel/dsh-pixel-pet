(() => {
  const $ = (id) => document.getElementById(id)
  const NAME_RE = /^([a-z][a-z0-9-]{0,39})_(\d{2})\.(png|jpe?g|webp)$/i
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

  let IG_READY = true; let SPEC = []; let J = null; let SPEC_META = { customMax: 16, customFramesMax: 12, durRange: [40, 5000] }
  let step = 'look'; let source = 'text'; let count = 4; let generating = 0; let genBusy = false; let importing = false
  const params = new URLSearchParams(location.search)
  const img = (slot, name, v) => 'api/create/' + J.id + '/img/' + slot + (name ? '/' + name : '') + '?v=' + (v || J.updatedAt || 0)
  const key = (s, i) => s + '_' + String(i).padStart(2, '0')
  const doneCount = () => J ? Object.values(J.frames).filter((s) => s === 'done').length : 0

  async function ensureJob () {
    if (J) return J
    const r = await api('create/new', { name: $('name').value.trim(), desc: $('desc').value.trim() })
    if (!r.ok) throw new Error(r.message || '失败')
    J = r.job
    history.replaceState(null, '', '?id=' + J.id)
    return J
  }
  const meta = (patch) => (J ? api('create/' + J.id + '/meta', patch) : Promise.resolve())
  const reload = () => (J ? api('create/' + J.id).then((r) => { if (r.ok) { J = r.job; render() } }) : Promise.resolve())

  // ---------------------------------------------------------------- render
  function render () {
    const hasRef = !!(J && J.ref)
    $('hero').src = hasRef ? img('ref') : ''
    $('hero').style.visibility = hasRef ? '' : 'hidden'
    if (J && document.activeElement !== $('name')) $('name').value = J.name
    if (J && document.activeElement !== $('desc') && !$('desc').value) $('desc').value = J.desc || ''
    for (const b of $('steps').querySelectorAll('button')) {
      const s = b.dataset.step
      b.setAttribute('aria-current', s === step ? 'step' : 'false')
      b.disabled = (s === 'acts' && !hasRef) || (s === 'preview' && !doneCount())
      b.dataset.done = String((s === 'look' && hasRef) || (s === 'acts' && J && J.plan.pending === 0 && J.plan.total > 0) || (s === 'preview' && !!(J && J.installed)))
    }
    for (const s of ['look', 'acts', 'preview']) $(s).hidden = s !== step
    if (step === 'look') renderLook(); else if (step === 'acts') renderActs(); else renderPreview()
    renderDock()
  }

  function renderLook () {
    for (const b of $('source').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === source))
    for (const n of document.querySelectorAll('#look [data-src]')) n.hidden = !n.dataset.src.split(' ').includes(source)
    for (const b of $('count').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === count))
    const hasRef = !!(J && J.ref)
    $('refImg').hidden = !hasRef
    if (hasRef) $('refImg').src = img('ref')
    $('upImg').hidden = !(J && J.upload)
    if (J && J.upload) $('upImg').src = img('upload')
    $('gen').disabled = generating > 0 || genBusy || !IG_READY
    $('gen').title = IG_READY ? '' : '先在设置页「出图」里配好接口和 Key'
    $('desc').placeholder = source === 'upload' ? '想在参考图上改什么，比如：全身站立、正面、透明底' : '外貌、发型、服装、配色……比如：橙色长卷发的大小姐，白色洋装'
    const list = (J && J.candidates) || []
    $('refHint').hidden = !!(J && J.ref)
    $('refHint').textContent = list.length ? '点一张候选定为形象' : '定稿形象'
    if (!IG_READY && source !== 'import') msg('出图接口还没配，可以先用「导入」')
    $('cands').replaceChildren(
      ...Array.from({ length: generating }, () => el('div', { class: 'cand wait checker' })),
      ...list.map((c) => el('button', {
        class: 'cand checker', role: 'radio', 'aria-checked': String(!!(J.ref && J.ref.candidate === c)),
        on: { click: () => pick(c) },
      }, el('img', { src: img('cand', c, 1), alt: '' }))))
  }

  function renderActs () {
    if (!J) return
    const present = new Map((J.states || []).map((s) => [s.id, s]))
    const rows = [
      ...(J.states || []),
      // optional states the pack does not have yet: still offered, ticking one adds it to the plan
      ...SPEC.filter((s) => !s.req && !present.has(s.id)).map((s) => ({ id: s.id, label: s.label, frames: s.n, durationsMs: s.ms, loop: !!s.loop, required: false, custom: false, single: !!s.single, mood: '' })),
    ].map((st) => {
      // a frame that already exists (a reversed pack) means the state is part of the pack
      const on = st.required || st.custom || (J.optional || []).includes(st.id) || J.frames[key(st.id, 0)] === 'done'
      const box = el('input', { type: 'checkbox', title: st.required ? '必需' : '', 'data-on': String(on) })
      box.checked = on; box.disabled = !!st.required
      box.addEventListener('change', () => {
        const opt = new Set(J.optional || []); if (box.checked) opt.add(st.id); else opt.delete(st.id)
        J.optional = [...opt]; meta({ optional: J.optional }).then(reload)
      })
      const label = el('input', { class: 'lbl-in', value: st.label, maxlength: 12, spellcheck: 'false', title: '展示名', disabled: !on })
      label.addEventListener('change', () => { if (label.value.trim()) meta({ labels: { [st.id]: label.value.trim() } }).then(reload) })
      const cells = Array.from({ length: st.frames }, (_, i) => {
        const k = key(st.id, i); const state = J.frames[k]
        const kids = state === 'done' ? el('img', { src: img('raw', k, J.stamps[k]), alt: '', loading: 'lazy' }) : []
        const btn = el('button', {
          class: 'fr' + (state === 'done' ? ' checker' : ''), 'data-s': state, title: k + (J.errors[k] ? ' · ' + J.errors[k] : '') + '（点一下重画这张）',
          on: { click: () => { if (state === 'done' || state === 'failed') redo([k], k) } },
        }, kids)
        // replace exactly this frame with a picture you already have
        const pick = el('label', { class: 'sub', title: '换成这张图', 'aria-label': '换成这张图' }, [
          '✎', el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: '' , on: { change: (e) => importOne(st.id, i, e.target.files[0], e.target) } }),
        ])
        return el('span', { class: 'cell' }, [btn, pick])
      })
      const durs = el('div', { class: 'durs', title: '每帧停留多少毫秒（40–5000）' },
        st.durationsMs.map((ms, i) => {
          const input = el('input', { type: 'number', min: 40, max: 5000, step: 10, value: ms, disabled: !on, 'aria-label': st.id + ' 第 ' + (i + 1) + ' 帧时长' })
          input.addEventListener('change', () => {
            const list = st.durationsMs.slice(); list[i] = Number(input.value)
            meta({ durations: { [st.id]: list } }).then(reload)
          })
          return input
        }))
      const tools = el('div', { class: 'row2' }, [
        st.single ? '' : durs,
        st.custom && st.mood ? el('span', { class: 'mood' }, '心情：' + st.mood) : '',
        st.custom ? el('button', { class: 'link del', 'data-tip': '删掉这个自定义动作', on: { click: () => {
          meta({ custom: J.custom.filter((c) => c.id !== st.id) }).then(reload)
        } } }, '删掉') : '',
      ])
      return el('div', { class: 'st edit', 'data-on': String(on) }, [
        box, label, el('div', { class: 'frames' }, cells),
        el('button', { class: 'redo', title: '整组重画', on: { click: () => redo(Array.from({ length: st.frames }, (_, i) => key(st.id, i)), st.label) } }, '↻'),
        tools,
      ])
    })
    $('states').replaceChildren(...rows)
    $('addCustom').disabled = (J.custom || []).length >= (SPEC_META.customMax || 16)
  }

  /** one frame from a file: replace in place, no generation */
  async function importOne (sid, i, file, input) {
    if (!file) return
    try { await ensureJob() } catch (e) { return toast(e.message) }
    const k = key(sid, i)
    const r = await api('create/' + J.id + '/import?name=' + encodeURIComponent(k + '.png'), file, file.type || 'image/png')
    if (input) input.value = ''
    if (!r.ok) return toast(r.message || '这张没导进去')
    await reload()
  }

  function renderPreview () {
    const b = J.build
    $('verdict').hidden = !b
    $('issues').hidden = true
    if (b) {
      $('vDot').dataset.s = b.ok ? (b.draft ? 'degraded' : 'ok') : 'bad'
      $('vText').textContent = b.ok ? (b.draft ? '草稿 · 必需动作还没齐' : '校验通过') : (b.message || '校验没过')
      const lines = [...(b.issues || [])]
      $('vMore').hidden = !lines.length
      $('issues').textContent = lines.join('\n')
    }
    stopAnims()
    if (!b || !b.states) { $('anims').replaceChildren(); return }
    const states = (J.states && J.states.length ? J.states : SPEC).filter((s) => b.states[s.id] !== undefined)
    $('anims').replaceChildren(...states.map((s) => {
      const n = b.states[s.id] || 0
      const im = el('img', { alt: '' })
      const card = el('div', { class: 'anim checker', 'data-missing': String(!n), title: s.id }, [im, el('span', {}, (s.label || s.id) + (n && n < s.frames ? ' ' + n + '/' + s.frames : ''))])
      if (n) animate(im, Array.from({ length: n }, (_, i) => 'api/create/' + J.id + '/img/frame/' + key(s.id, i) + '.png?v=' + b.at), s.single ? Array(n).fill(160) : (s.durationsMs || s.ms || []))
      return card
    }))
  }
  let timers = []
  const stopAnims = () => { for (const t of timers) clearTimeout(t); timers = [] }
  function animate (im, srcs, ms) {
    let i = 0
    const slot = timers.length; timers.push(0)
    for (const s of srcs) new Image().src = s
    const tick = () => { im.src = srcs[i]; const d = ms[i] || 160; i = (i + 1) % srcs.length; timers[slot] = setTimeout(tick, d) }
    tick()
  }

  function renderDock () {
    const run = J && J.run
    const running = !!(run && run.running)
    $('prog').hidden = !(step === 'acts' && J && J.plan.total)
    if (step === 'acts' && J) {
      const done = J.plan.total - J.plan.pending
      $('progBar').style.width = (J.plan.total ? done / J.plan.total * 100 : 0).toFixed(1) + '%'
      if (importing) {} else if (running) msg(done + ' / ' + J.plan.total)
      else if (run && run.error) msg(run.error, true)
      else msg(done + ' / ' + J.plan.total + (run && run.failed ? ' · ' + run.failed + ' 张失败' : ''), !!(run && run.failed))
    } else if (step === 'preview') msg('')
    $('dirBtn').hidden = step !== 'acts' || running
    $('stop').hidden = !(step === 'acts' && running)
    $('build').hidden = step !== 'preview'
    const next = $('next')
    next.hidden = false; next.disabled = false
    if (step === 'look') { next.textContent = '下一步'; next.disabled = !(J && J.ref) }
    else if (step === 'acts') {
      if (running) next.hidden = true
      else if (J.plan.pending) next.textContent = '生成 ' + J.plan.pending + ' 张'
      else next.textContent = '下一步'
    } else { next.textContent = J && J.installed ? '重新安装' : '安装'; next.disabled = !(J && J.build && J.build.ok) }
  }

  // ---------------------------------------------------------------- actions
  async function generate () {
    if (genBusy) return
    genBusy = true; $('gen').disabled = true
    try {
      try { await ensureJob() } catch (e) { return toast(e.message) }
      if (source === 'text' && !$('desc').value.trim()) { $('desc').focus(); return }
      if (source === 'upload' && !J.upload) { $('upFile').click(); return }
      await meta({ desc: $('desc').value.trim(), name: $('name').value.trim() })
      generating = count; render()
      const r = await api('create/' + J.id + '/candidates', { n: count, useUpload: source === 'upload' })
      if (!r.ok) toast(r.message || '出图失败')
      if (r.job) J = r.job
    } finally {
      genBusy = false; generating = 0
      render()
    }
  }
  async function pick (c) {
    const r = await api('create/' + J.id + '/pick', { candidate: c })
    if (r.job) J = r.job
    render()
  }
  async function putImage (slot, file) {
    if (!file) return
    try { await ensureJob() } catch (e) { return toast(e.message) }
    const r = await api('create/' + J.id + '/upload?slot=' + slot, file, file.type || 'image/png')
    if (!r.ok) toast(r.message || '上传失败')
    await reload()
  }

  const ask = (n, what) => new Promise((done) => {
    $('cNum').textContent = n; $('cWhat').textContent = what || ''
    const d = $('confirm')
    d.returnValue = ''
    d.onclose = () => done(d.returnValue === 'ok')
    d.showModal()
    $('cOk').focus()
  })
  async function start (keys, what) {
    let n = keys ? keys.length : J.plan.pending
    for (let tries = 0; tries < 2; tries++) {
      if (!(await ask(n, what))) return
      const r = await api('create/' + J.id + '/run', keys ? { keys, confirm: n } : { confirm: n })
      if (r.ok) { if (r.job) J = r.job; render(); return poll() }
      if (r.code === 'confirm') { n = r.total; continue } // plan changed meanwhile: show the real number again
      toast(r.message || '失败'); return
    }
  }
  const redo = (keys, what) => start(keys, what)

  let polling = false
  function poll () {
    if (polling) return
    polling = true
    const tick = () => api('create/' + J.id).then((r) => {
      if (r.ok) { J = r.job; render() }
      if (r.ok && J.run && J.run.running) return setTimeout(tick, 1200)
      polling = false
    }, () => { polling = false })
    tick()
  }

  // folder import: <state>_<NN>.png files, dropped as a folder or picked
  async function importFiles (files) {
    if (!J) return
    const ok = files.filter((f) => NAME_RE.test(f.name))
    if (!ok.length) return toast('没有 <状态>_<两位帧号>.png 的文件')
    importing = true
    let bad = 0
    for (let i = 0; i < ok.length; i++) {
      msg('导入 ' + (i + 1) + ' / ' + ok.length)
      const r = await api('create/' + J.id + '/import?name=' + encodeURIComponent(ok[i].name), ok[i], ok[i].type || 'image/png')
      if (!r.ok) bad++
    }
    importing = false
    await reload()
    toast((ok.length - bad) + ' 张' + (bad ? ' · ' + bad + ' 张没认出' : '') + (files.length > ok.length ? ' · 跳过 ' + (files.length - ok.length) : ''))
  }
  const walk = (entry) => new Promise((done) => {
    if (!entry) return done([])
    if (entry.isFile) return entry.file((f) => done([f]), () => done([]))
    const reader = entry.createReader(); const all = []
    const more = () => reader.readEntries(async (list) => {
      if (!list.length) { const nested = await Promise.all(all.map(walk)); return done(nested.flat()) }
      all.push(...list); more()
    }, () => done([]))
    more()
  })

  function bindDrop (target, onFiles, { folder } = {}) {
    let depth = 0
    target.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; target.classList.add('over') })
    target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; target.classList.remove('over') } })
    target.addEventListener('dragover', (e) => e.preventDefault())
    target.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; target.classList.remove('over')
      if (folder && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].webkitGetAsEntry) {
        const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry()).filter(Boolean)
        onFiles((await Promise.all(entries.map(walk))).flat())
      } else onFiles([...e.dataTransfer.files])
    })
  }

  // ---------------------------------------------------------------- wiring
  $('steps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { step = b.dataset.step; render(); if (step === 'acts' && J.run && J.run.running) poll() } })
  $('source').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { source = b.dataset.v; render() } })
  $('count').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { count = Number(b.dataset.v); render() } })
  $('gen').addEventListener('click', generate)
  $('upFile').addEventListener('change', (e) => putImage('upload', e.target.files[0]))
  $('impFile').addEventListener('change', (e) => putImage('ref', e.target.files[0]))
  bindDrop($('upDrop'), (f) => putImage('upload', f[0]))
  bindDrop($('impDrop'), (f) => putImage('ref', f[0]))
  bindDrop($('acts'), importFiles, { folder: true })
  $('dirFile').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = '' })
  $('name').addEventListener('change', () => { const v = $('name').value.trim(); if (J) meta({ name: v }).then(reload) })
  $('desc').addEventListener('change', () => meta({ desc: $('desc').value.trim() }))
  $('stop').addEventListener('click', () => api('create/' + J.id + '/stop', {}).then(reload))
  $('vMore').addEventListener('click', () => { $('issues').hidden = !$('issues').hidden })
  // 自定义动作 / 表情：中文名 + 怎么动 + 帧数 + 可选的心情标签（挂进 moods，pixelpet_mood 就能用）
  $('addCustom').addEventListener('click', () => {
    if (!J) return
    $('cLabel').value = ''; $('cDesc').value = ''; $('cFrames').value = 4; $('cMood').value = ''
    const d = $('cdlg'); d.returnValue = ''
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '')
    $('cLabel').focus()
  })
  $('cdlg').addEventListener('close', () => {
    const d = $('cdlg')
    if (d.returnValue !== 'ok') return
    const label = $('cLabel').value.trim()
    if (!label) return toast('给它起个名字')
    const frames = Math.max(1, Math.min(SPEC_META.customFramesMax || 12, Math.round(Number($('cFrames').value) || 4)))
    const mood = $('cMood').value.trim().slice(0, 12)
    const custom = [...(J.custom || []), { id: '', label, desc: $('cDesc').value.trim(), frames, ms: 250, loop: true, mood }]
    meta({ custom }).then((r) => { reload() })
  })
  $('build').addEventListener('click', async () => {
    const b = $('build'); b.disabled = true; msg('…')
    const r = await api('create/' + J.id + '/build', {})
    b.disabled = false
    if (r.job) J = r.job
    render()
    if (!r.ok && r.message) msg(r.message, true)
  })
  $('next').addEventListener('click', async () => {
    if (step === 'look') { step = 'acts'; return render() }
    if (step === 'acts') {
      if (J.plan.pending) return start(null, (J.optional || []).length ? '' : '只生成必需动作')
      step = 'preview'; render()
      if (!J.build) $('build').click()
      return
    }
    const r = await api('create/' + J.id + '/install', {})
    if (!r.ok) return toast(r.message || '安装失败')
    J = r.job; render()
    toast(r.draft ? '已安装（草稿）' : '已安装')
    try { window.opener && window.opener.postMessage('pixelpet:characters', location.origin) } catch {}
  })
  $('hero').addEventListener('error', () => { $('hero').style.visibility = 'hidden' })

  // ---------------------------------------------------------------- boot
  Promise.all([api('create/spec'), api('create/jobs'), api('imagegen')]).then(async ([sp, jobs, ig]) => {
    SPEC = sp.spec || []
    SPEC_META = { customMax: sp.customMax || 16, customFramesMax: sp.customFramesMax || 12, durRange: sp.durRange || [40, 5000] }
    if (ig && ig.settings) count = ig.settings.candidates || 4
    IG_READY = !!(ig && ig.key && ig.key.configured)
    const id = params.get('id')
    const editId = params.get('edit') === '1' ? id : ''
    if (editId) {
      // ✎ on a settings card: read the installed pack back into a job, then edit this URL as that job
      const r = await api('create/reverse', { id: editId })
      if (r.ok && r.job) {
        J = r.job
        history.replaceState(null, '', '?id=' + J.id)
        if (J.origin && J.origin.missing && J.origin.missing.length) toast('有 ' + J.origin.missing.length + ' 帧读不出来')
      } else toast((r && r.message) || '这个包读不出来')
    } else if (id) {
      const r = await api('create/' + id)
      if (r.ok) J = r.job
    }
    const list = (jobs.jobs || []).filter((j) => !J || j.id !== J.id)
    if (list.length) {
      $('jobs').hidden = false
      $('jobs').replaceChildren(el('option', { value: J ? J.id : '', selected: '' }, J ? J.name : '草稿'), ...(J ? [el('option', { value: 'new' }, '＋ 新建')] : []),
        ...list.map((j) => el('option', { value: j.id }, j.name)))
      $('jobs').addEventListener('change', (e) => { const v = e.target.value; location.search = v === 'new' || !v ? '' : '?id=' + v })
    }
    if (J) {
      step = params.get('step') || (J.build ? 'preview' : J.ref ? 'acts' : 'look')
      if (J.upload && !J.candidates.length) source = 'upload'
    }
    render()
    if (J && J.run && J.run.running) poll()
  })
})()
