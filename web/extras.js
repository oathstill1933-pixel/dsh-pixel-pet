// Settings page additions: the "动作" preview grid, the AI section (screen sense, 主动一点, usage prompt).
// app.js fires `pixelpet:state` after every render with the full state.
(() => {
  const $ = (id) => document.getElementById(id)
  const api = (p, body) => fetch('api/' + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())
  const toast = (t) => { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true }, 2200) }
  const save = (patch) => api('settings', patch)

  // ------------------------------------------------------------------ moves
  const DESKTOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M6.6 5v3.6L9.8 6.8z" fill="currentColor"/></svg>'
  let shownId = null
  let listenEnabled = false
  const headphoneTip = () => listenEnabled ? '放歌时会自动戴上耳机' : '打开『一起听歌』拓展包后，放歌时会戴上耳机'
  function syncHeadphoneTips (enabled) {
    if (listenEnabled === enabled) return
    listenEnabled = enabled
    for (const tile of $('moves').querySelectorAll('[data-requires="listen"]')) tile.dataset.tip = headphoneTip()
  }
  let playing = null // { tile, timer }

  const stop = () => {
    if (!playing) return
    clearTimeout(playing.timer)
    playing.tile.img.src = playing.tile.src(0)
    playing.tile.el.removeAttribute('data-playing')
    playing = null
  }

  function play (tile) {
    const again = playing && playing.tile === tile
    stop()
    if (again) return
    const st = tile.st
    const frames = Array.from({ length: st.frames }, (_, i) => { const im = new Image(); im.src = tile.src(i); return im })
    let i = 0
    const p = { tile, timer: 0 }
    playing = p
    tile.el.dataset.playing = ''
    const step = () => {
      if (playing !== p) return
      tile.img.src = frames[i].src
      const d = st.durationsMs[i]
      i++
      if (i >= st.frames) {
        if (!st.loop) { p.timer = setTimeout(stop, d); return }
        i = 0
      }
      p.timer = setTimeout(step, d)
    }
    step()
  }

  function renderMoves (id) {
    if (!id || id === shownId) return
    shownId = id
    stop()
    api('preview?id=' + encodeURIComponent(id)).then((r) => {
      if (shownId !== id) return
      const box = $('moves')
      if (!r.ok) { box.replaceChildren(); return }
      box.replaceChildren(...r.states.map((st) => {
        const src = (i) => 'api/frame/' + encodeURIComponent(id) + '/' + encodeURIComponent(st.id) + '/' + i
        const img = document.createElement('img')
        img.alt = ''; img.src = src(0); img.loading = 'lazy'
        const name = document.createElement('span')
        name.textContent = st.label
        const el = document.createElement('div')
        el.className = 'move'
        el.tabIndex = 0
        el.setAttribute('role', 'button')
        if (st.requires?.feature === 'listen') {
          el.dataset.requires = 'listen'
          el.dataset.tip = headphoneTip()
        } else el.title = st.id
        el.append(img, name)
        const tile = { el, img, st, src }
        el.addEventListener('click', () => play(tile))
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(tile) } })
        if (st.play) {
          const b = document.createElement('button')
          b.className = 'act'
          b.title = '让桌宠演一遍'
          b.setAttribute('aria-label', '让桌宠演一遍：' + st.label)
          b.innerHTML = DESKTOP
          b.addEventListener('click', (e) => {
            e.stopPropagation()
            b.disabled = true
            api('preview/play', { id, state: st.id }).then((x) => { b.disabled = false; if (!x.ok) toast(x.message || '失败') }, () => { b.disabled = false })
          })
          el.append(b)
        }
        return el
      }))
    })
  }

  // ------------------------------------------------------------------ AI
  // prompt box: base text (settings.prompt) + the paragraph 主动一点 appends (proactive / passive, by the switch)
  let P = null // /api/prompt
  let A = null // settings.autonomy as last seen
  const partKey = () => (P && P.autonomy ? 'proactive' : 'passive')
  const count = () => {
    const v = $('prompt').value; const w = $('promptPart').value
    const near = P && (v.length > P.max * 0.8 || w.length > P.partMax * 0.8)
    $('promptCount').value = near ? (v.length + w.length) + ' / ' + (P.max + P.partMax) : ''
    $('promptReset').disabled = !P || (v.trim() === P.default && w.trim() === P[partKey() + 'Default'])
  }
  const loadPrompt = () => api('prompt').then((r) => {
    if (!r.ok) return
    P = r
    if (document.activeElement !== $('prompt')) $('prompt').value = r.text
    if (document.activeElement !== $('promptPart')) $('promptPart').value = r[partKey()]
    $('promptPart').maxLength = r.partMax
    count()
  })

  $('prompt').maxLength = 4000
  $('prompt').addEventListener('input', count)
  $('promptPart').addEventListener('input', count)
  $('prompt').addEventListener('change', (e) => {
    const v = e.target.value
    save({ prompt: v.trim() ? v : '' }).then((r) => { if (r.ok) { toast('已保存'); loadPrompt() } })
  })
  $('promptPart').addEventListener('change', (e) => {
    const v = e.target.value
    save({ autonomy: { [partKey() + 'Prompt']: v.trim() ? v : '' } }).then((r) => { if (r.ok) { A = r.settings.autonomy; toast('已保存'); loadPrompt() } })
  })
  $('promptReset').addEventListener('click', () => {
    save({ prompt: '', autonomy: { [partKey() + 'Prompt']: '' } }).then((r) => {
      if (!r.ok) return
      A = r.settings.autonomy
      $('prompt').value = P ? P.default : ''
      $('promptPart').value = P ? P[partKey() + 'Default'] : ''
      toast('已恢复默认'); loadPrompt()
    })
  })
  $('screen').addEventListener('change', (e) => save({ screen: e.target.checked }).then((r) => { if (r.ok) e.target.checked = r.settings.screen === true }))

  // 主动一点: switch, foldable rule list, quiet hours
  let open = false
  const renderAuto = () => {
    if (!A) return
    $('autoOn').checked = A.enabled !== false
    $('autoMore').hidden = A.enabled === false
    $('autoBox').hidden = A.enabled === false || !open
    $('autoMore').setAttribute('aria-expanded', String(open && A.enabled !== false))
    for (const n of document.querySelectorAll('[data-rule]')) n.checked = A.rules[n.dataset.rule] !== false
    const q = A.quietHours || {}
    if (document.activeElement !== $('quietStart')) $('quietStart').value = q.start || ''
    if (document.activeElement !== $('quietEnd')) $('quietEnd').value = q.end || ''
    $('quietClear').hidden = !q.start && !q.end
    $('autoAware').checked = A.aware === true
    if (A.aware !== true) { $('awareNow').hidden = true; $('awareLog').hidden = true; logOpen = false; $('awareLogBox').hidden = true }
    // 主动关心：感知没开时整行置灰；三档 = 叫醒间隔/每日上限（lib/proactive.js LEVELS）
    const aware = A.aware === true
    $('autoCare').checked = A.care === true
    $('autoCare').disabled = !aware
    for (const b of $('careLevel').querySelectorAll('button')) {
      b.disabled = !aware
      b.setAttribute('aria-pressed', String(b.dataset.v === (A.careLevel || 'medium')))
    }
  }

  // 允许感知在做什么: current guess + 「认不准就学」 + recent log (folded)
  const KINDS = [['gaming', '游戏'], ['video', '视频'], ['work', '干活'], ['meeting', '会议'], ['browsing', '浏览']]
  let logOpen = false
  let fixing = false
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
  const loadAware = () => {
    if (!A || A.aware !== true || A.enabled === false) return
    api('awareness' + (logOpen ? '?log=1' : '')).then((r) => {
      if (!r.ok || !r.aware) return
      $('awareLog').hidden = false
      const sel = $('awareFix')
      const known = KINDS.some(([k]) => k === r.state)
      if (!fixing && document.activeElement !== sel) {
        sel.replaceChildren(...(known || !r.state ? [] : [new Option(r.label, '', true, true)]).concat(
          KINDS.map(([k, n]) => new Option(n, k, false, k === r.state))))
        sel.dataset.app = r.app || ''
        $('awareApp').value = r.app || ''
      }
      $('awareNow').hidden = !r.state || !r.app
      if (logOpen && Array.isArray(r.log)) {
        $('awareLogBox').replaceChildren(...r.log.map((x) => {
          const li = document.createElement('li')
          const t = document.createElement('time'); t.textContent = fmtTime(x.t)
          const s = document.createElement('b'); s.textContent = x.label || x.state
          const a = document.createElement('span'); a.textContent = x.app || ''
          li.append(t, s, a)
          return li
        }))
      }
    }, () => {})
  }
  $('autoAware').addEventListener('change', (e) => saveAuto({ aware: e.target.checked }).then(loadAware))
  $('autoCare').addEventListener('change', (e) => saveAuto({ care: e.target.checked }))
  $('careLevel').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (b && !b.disabled && b.getAttribute('aria-pressed') !== 'true') saveAuto({ careLevel: b.dataset.v })
  })
  $('awareFix').addEventListener('change', (e) => {
    const app = e.target.dataset.app; const state = e.target.value
    if (!app || !state) return
    fixing = true
    api('awareness/learn', { app, state }).then((r) => { fixing = false; toast(r.ok ? '记住了' : (r.message || '失败')); loadAware() }, () => { fixing = false })
  })
  $('awareLog').addEventListener('click', () => {
    logOpen = !logOpen
    $('awareLog').setAttribute('aria-expanded', String(logOpen))
    $('awareLogBox').hidden = !logOpen
    loadAware()
  })
  setInterval(() => { if (!document.hidden && !window.__pixelpetPurged && open) loadAware() }, 5000)
  const saveAuto = (patch) => save({ autonomy: patch }).then((r) => { if (r.ok) { A = r.settings.autonomy; renderAuto() } return r })
  $('autoOn').addEventListener('change', (e) => saveAuto({ enabled: e.target.checked }).then((r) => { if (r.ok) loadPrompt() }))
  $('autoMore').addEventListener('click', () => { open = !open; renderAuto(); if (open) loadAware() })
  for (const n of document.querySelectorAll('[data-rule]')) n.addEventListener('change', (e) => saveAuto({ rules: { [n.dataset.rule]: e.target.checked } }))
  const saveQuiet = () => saveAuto({ quietHours: { start: $('quietStart').value || '', end: $('quietEnd').value || '' } })
  $('quietStart').addEventListener('change', saveQuiet)
  $('quietEnd').addEventListener('change', saveQuiet)
  $('quietClear').addEventListener('click', () => { $('quietStart').value = ''; $('quietEnd').value = ''; saveQuiet() })

  window.addEventListener('pixelpet:state', (e) => {
    const S = e.detail
    const s = S.settings
    const cur = S.characters.find((c) => c.id === s.character) || S.characters.find((c) => !c.draft) || S.characters[0]
    syncHeadphoneTips(s.listen?.enabled === true)
    renderMoves(cur && cur.id)
    $('screen').checked = s.screen === true
    if (s.autonomy) {
      const flipped = A && (A.enabled !== false) !== (s.autonomy.enabled !== false)
      A = s.autonomy; renderAuto()
      if (flipped) loadPrompt()
    }
    // 熔断小黄点：额度/报错暂停中才亮，悬停看到暂停到几点
    const paused = S.care && Number(S.care.pausedUntil) > Date.now()
    $('carePaused').hidden = !paused
    if (paused) $('carePaused').title = '额度/报错，暂停到 ' + (() => { const d = new Date(S.care.pausedUntil); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') })()
    if (!P) loadPrompt()
  })
})()
