(() => {
  const $ = (id) => document.getElementById(id)
  const api = (p, body, type) => fetch('api/' + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body: type ? body : JSON.stringify(body),
  }).then((r) => r.json())
  let S = null
  let F = null // 最近一次 GET api/follow 的快照（跟随外部桥会话：来源表 + 状态）
  $('hero').addEventListener('error', () => { $('hero').style.visibility = 'hidden' })
  $('hero').addEventListener('load', () => { $('hero').style.visibility = '' })

  const toast = (t) => { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true }, 2200) }
  const save = (patch) => api('settings', patch).then((r) => { if (r.ok) { S.settings = r.settings; render() } })
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'on') for (const [e, f] of Object.entries(v)) n.addEventListener(e, f); else if (v !== undefined && v !== null) n.setAttribute(k, v) }
    for (const c of [].concat(kids || [])) n.append(c)
    return n
  }
  // 图标按钮：data-icon 填 SVG，data-tip 悬停才显示名字
  const ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    wave: '<path d="M3 12h1M7 8v8M11 5v14M15 9v6M19 7v10"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
    trash: '<path d="M3 6h18"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    zap: '<path d="M13 2 4 14h8l-1 8 9-12h-8z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M12.2 6.2 11 5"/><path d="m3 21 9-9"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4"/><path d="M12 17.5h.01"/>',
  }
  const setIcon = (n, name, tip) => {
    n.dataset.icon = name
    n.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'
    if (tip) n.dataset.tip = tip
    if (n.dataset.tip) n.setAttribute('aria-label', n.dataset.tip)
    n.classList.add('icon')
    return n
  }
  const iconBtn = (name, tip, on) => setIcon(el('button', { class: 'ghost', on }), name, tip)
  for (const n of document.querySelectorAll('[data-icon]')) setIcon(n, n.dataset.icon)
  {
    const tip = $('tip'); let timer = 0; let cur = null
    const hide = () => { clearTimeout(timer); tip.hidden = true; cur = null }
    const show = (n) => {
      cur = n; clearTimeout(timer)
      timer = setTimeout(() => {
        if (cur !== n || !n.isConnected) return
        tip.textContent = n.dataset.tip; tip.hidden = false
        const r = n.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight
        let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(x, innerWidth - w - 8))
        let y = r.bottom + 6; if (y + h > innerHeight - 8) y = r.top - h - 6
        tip.style.left = x + 'px'; tip.style.top = y + 'px'
      }, n.classList.contains('help') ? 80 : 350)
    }
    document.addEventListener('mouseover', (e) => {
      const n = e.target.closest && e.target.closest('[data-tip]')
      if (n && n.dataset.tip) { if (n !== cur) show(n) } else if (cur) hide()
    })
    document.addEventListener('focusin', (e) => { const n = e.target.closest && e.target.closest('[data-tip]'); if (n && n.dataset.tip && n.matches(':focus-visible')) show(n) })
    document.addEventListener('focusout', hide)
    document.addEventListener('mousedown', hide)
    addEventListener('scroll', hide, true)
  }

  const thumb = (kind, id) => {
    const img = el('img', { src: 'api/thumb/' + kind + '/' + id, alt: '' })
    img.onerror = () => img.replaceWith(el('div', { class: 'ph' }))
    return img
  }

  // 角色 / 家具卡左上角的移除：自己做的直接删；内置的先藏起来，末尾 ↺ 可找回
  const removeBtn = (kind, p) => {
    const b = iconBtn('x', '移除', { click: (e) => {
      e.stopPropagation()
      // an edited copy of a built-in pack is only the user layer: removing it brings the original back
      ask(p.overlay ? '放弃对「' + p.name + '」的修改，恢复原版？' : p.user ? '删掉「' + p.name + '」？删了就找不回来了。' : '隐藏「' + p.name + '」？这是插件自带的，不占你的空间，之后可以点 ↺ 找回。').then((y) => {
        if (!y) return
        api('pack/remove', { kind, id: p.id }).then((r) => { if (r.ok) { S.settings = r.settings; load() } else toast(r.message || '没删掉') })
      })
    } })
    b.classList.add('card-x')
    return b
  }
  /** 再编辑：从已装好的包反建制作记录，改完装成用户版（原始文件不动） */
  const editBtn = (kind, p) => {
    const b = iconBtn('pen', '改这个' + (kind === 'character' ? '角色' : '家具'), { click: (e) => {
      e.stopPropagation()
      openEditor(kind, p.id)
    } })
    b.classList.add('card-edit')
    return b
  }
  const restoreBtn = (kind) => {
    const n = ((S.settings.hidden || {})[kind] || []).length
    if (!n) return ''
    const b = iconBtn('undo', '找回移除的内置' + (kind === 'character' ? '角色' : '家具') + '（' + n + '）', { click: () => api('pack/restore', {}).then((r) => { if (r.ok) { S.settings = r.settings; load() } }) })
    b.classList.add('card', 'add', 'restore')
    return b
  }

  // ---------------------------------------------------------------- 跟随外部桥会话（docs/FOLLOW.md）
  // 面板只读 GET api/follow：来源表、当前有效会话、黄字警告都在里面，peer 与会话 id 已脱敏。
  const followIsOn = () => !!S && !!(S.settings.followSession && S.settings.followSession.mode === 'follow')
  const hhmm = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '' }
  const loadFollow = () => api('follow').then((r) => { F = r && r.ok ? r : null; renderFollow() }).catch(() => {})

  function renderFollow () {
    if (!S) return
    const on = followIsOn()
    setSeg('followMode', on ? 'follow' : 'manual')
    $('session').disabled = on                     // 跟随中：手填会话置灰（它仍然存着，切回手动就用它）
    $('followSource').hidden = !on
    // 一句话说清两种模式各适合谁（原来的「手动 / 跟随」一般人看不懂）
    $('followHint').textContent = on
      ? 'QQ 这类聊天桥换了新会话，桌宠自动跟过去。适合已经接好桥、不守着一个会话聊的人。'
      : '桌宠一直在上面选的这个会话里聊。适合喜欢在同一个会话里长期聊下去的人。'
    $('followGuideBtn').hidden = !on
    if (!on) { $('followGuide').hidden = true; $('followGuideBtn').setAttribute('aria-expanded', 'false') }
    const rows = (F && F.sources) || []
    // 一个通道一组：通道名原样显示（qq / discord / 自建的什么名字都行），这里没有平台白名单
    if (on) {
      const byChannel = new Map()
      for (const r of rows) { if (!byChannel.has(r.channel)) byChannel.set(r.channel, []); byChannel.get(r.channel).push(r) }
      const kids = []
      if (!rows.length) { const o = el('option', { value: '' }, '还没有接好的聊天桥'); o.selected = true; kids.push(o) }
      for (const [channel, list] of byChannel) {
        const g = el('optgroup', { label: channel })
        for (const r of list) {
          const o = el('option', { value: r.source, title: r.source }, (r.label || r.peer) + ' · ' + r.channel + (r.eligible ? '' : ' · 不适合当家'))
          if (!r.eligible) o.disabled = true
          o.selected = r.source === (F && F.source)
          g.append(o)
        }
        kids.push(g)
      }
      $('followSource').replaceChildren(...kids)
    }
    const row = $('followStateRow')
    row.hidden = !on
    if (!on) return
    const st = $('followState')
    const warn = (F && F.warning) || ''
    const pick = rows.find((r) => r.source === (F && F.source))
    if (warn) { st.dataset.s = 'warn'; st.textContent = warn; return }
    if (F && F.effectiveSessionId) {
      st.dataset.s = 'ok'
      st.textContent = '正在跟随 ' + F.effectiveSessionId + (pick ? '（' + hhmm(pick.updatedAt) + ' 更新）' : '')
      return
    }
    st.dataset.s = ''
    st.textContent = ''
  }

  /** 信箱那一行的状态点 / 重新授权 / 补收提示：设置页轮询和整页 render 都走这里，点不用等下一次改设置才变 */
  function renderAgentlyState () {
    const m = (S && S.mail) || {}
    const ag = (S && S.settings && S.settings.mail && S.settings.mail.agently) || {}
    const agS = (m.agently && m.agently.state) || 'unconfigured'
    $('agState').hidden = !ag.enabled; $('agState').dataset.s = agS
    $('agState').title = (AG_STATE[agS] || agS) + (m.agently && m.agently.quota ? ' · 今日 ' + m.agently.quota.used + '/' + m.agently.quota.limit : '')
    // 授权掉了才给按钮；补收撞到 200 封上限才提示（后端说真的没补完，不是猜的）
    $('agReauth').hidden = !(ag.enabled && agS === 'auth-required')
    $('agMore').hidden = !(ag.enabled && m.agently && m.agently.backfill && m.agently.backfill.truncated)
  }

  function render () {
    const s = S.settings
    const cur = S.characters.find((c) => c.id === s.character) || S.characters.find((c) => !c.draft) || S.characters[0]
    if (cur) { $('hero').src = 'api/thumb/character/' + cur.id; $('heroName').textContent = cur.name }
    const pn = $('partnerName')
    if (document.activeElement !== pn) pn.value = s.partnerName || ''
    pn.title = cur ? 'ta的名字 · ' + cur.name : 'ta的名字'
    const aa = $('addressAs')
    if (aa && document.activeElement !== aa) aa.value = s.addressAs || ''
    $('run').setAttribute('aria-pressed', String(S.pet.running))
    $('runText').textContent = S.pet.running ? '运行中' : '启动'

    $('chars').replaceChildren(...S.characters.map((c) => el('div', {
      class: 'card', role: 'radio', tabindex: '0',
      'aria-checked': String(cur && c.id === cur.id), 'aria-disabled': String(!c.valid && !c.user),
      on: { click: () => { if (c.draft && c.user) openCreate(c.id); else if (c.valid) save({ character: c.id }) } },
    }, [thumb('character', c.id), el('span', {}, c.name),
      c.draft ? el('span', { class: 'chip' }, c.user ? '草稿' : '骨架') : c.demo ? el('span', { class: 'chip' }, 'demo') : '',
      c.overlay ? el('span', { class: 'chip edited' }, '已改') : '',
      c.pack ? '' : removeBtn('character', c), editBtn('character', c)])),
    el('button', { class: 'card add', 'data-tip': '新建角色', on: { click: () => openCreate() } }, el('b', {}, '＋')),
    restoreBtn('character'))

    renderImagegen()

    // 书架（feature: reading）只在「一起看书」开着时出现，与桌宠侧 furniture.FEATURE_GATES 同规则
    const gateOpen = (f) => f.feature !== 'reading' || (s.reading && s.reading.enabled === true)
    $('furn').replaceChildren(...S.furniture.filter(gateOpen).map((f) => {
      const on = (s.furniture[f.id] && typeof s.furniture[f.id].enabled === 'boolean') ? s.furniture[f.id].enabled : f.defaultEnabled
      const box = el('input', { type: 'checkbox' }); box.checked = on
      box.addEventListener('change', () => save({ furniture: { [f.id]: { enabled: box.checked } } }))
      return el('div', { class: 'card', 'aria-checked': String(on) }, [thumb('furniture', f.id), el('span', {}, f.name),
        f.overlay ? el('span', { class: 'chip edited' }, '已改') : '',
        el('label', { class: 'sw' }, [box, el('i')]), f.pack ? '' : removeBtn('furniture', f), editBtn('furniture', f)])
    }), el('button', { class: 'card add', 'data-tip': '新建家具', on: { click: () => openFurniture() } }, el('b', {}, '＋')),
    restoreBtn('furniture'))

    renderPacks()

    renderVoice()
    renderVoiceprint()
    const v = s.voice
    const none = el('option', { value: '' }, '—')
    $('session').replaceChildren(none, ...S.sessions.map((x) => { const o = el('option', { value: x.id }, (x.missing ? '（已失效）' : x.archived ? '（已归档）' : '') + (x.title || '…' + x.id.slice(-6))); o.selected = x.id === v.llm.sessionId; return o }))
    renderFollow()

    const m = S.mail || { unread: 0, agently: { enabled: false } }
    $('mailCount').hidden = !m.unread; $('mailCount').textContent = m.unread
    const ag = (s.mail && s.mail.agently) || {}
    $('agently').checked = !!ag.enabled
    for (const r of document.querySelectorAll('[data-ag]')) r.hidden = !ag.enabled
    renderAgentlyState()
    if (document.activeElement !== $('agTo')) $('agTo').value = ag.to || ''
    if (document.activeElement !== $('agCmd')) $('agCmd').value = ag.command || ''

    const hub = s.hub || { show: true, autoCollapseS: 20, speak: true }
    $('hubShow').checked = !!hub.show; $('hubSpeak').checked = !!hub.speak
    for (const r of document.querySelectorAll('[data-hub]')) r.hidden = !hub.show
    keep('hubAuto', String(hub.autoCollapseS))

    $('size').value = s.size; $('sizeOut').value = Number(s.size).toFixed(2)
    for (const k of ['topmost', 'follow', 'stayPut', 'aiControl', 'autoStart']) $(k).checked = !!s[k]
    $('listenOn').checked = !!(s.listen && s.listen.enabled); $('openListen').hidden = $('listenPyRow').hidden = !$('listenOn').checked
    $('readingOn').checked = !!(s.reading && s.reading.enabled); $('readingRow').hidden = !$('readingOn').checked
    renderAudioDirs()
    $('clapOn').checked = !!(s.listen && s.listen.clap); $('clapMirror').hidden = !$('clapOn').checked
    $('calendarOn').checked = !!(s.calendar && s.calendar.enabled); $('calendarRow').hidden = !$('calendarOn').checked
    if (document.activeElement !== $('listenPython')) $('listenPython').value = (s.listen && s.listen.python) || ''
    if (document.activeElement !== $('python')) $('python').value = s.python || ''
    renderPython()
    window.dispatchEvent(new CustomEvent('pixelpet:state', { detail: S })) // web/extras.js
  }

  // ---------------------------------------------------------------- 拓展包（M1）
  const PACK_PHASE = { downloading: '下载中', verifying: '校验中', extracting: '解包中', validating: '校验资源', storing: '入库', preparing: '准备中' }
  function packStateChip (e, reg, progress) {
    const entry = reg[e.id]
    const a = entry && entry.active
    if (progress && (progress.id === e.id || !progress.id) && progress.phase && progress.phase !== 'done' && progress.phase !== 'failed') {
      const pct = progress.total ? Math.round((progress.done || 0) * 100 / progress.total) : ''
      return pct === '' ? PACK_PHASE[progress.phase] || progress.phase : (PACK_PHASE[progress.phase] || progress.phase) + ' ' + pct + '%'
    }
    if (!a) return ''
    if (entry.state === 'load-failed') return '加载失败'
    if (entry.state === 'waiting-authorization') return '待确认权限'
    const r = entry.receipt
    if (entry.wantEnabled && r && r.petRunning === false) return '待启动加载'
    if (entry.wantEnabled && r && r.ok === false) return '加载失败'
    return 'v' + (a.version || '')
  }
  function bindPackDetail (body, detail) {
    const toggle = () => {
      detail.hidden = !detail.hidden
      body.setAttribute('aria-expanded', String(!detail.hidden))
    }
    body.addEventListener('click', toggle)
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
  }
  function renderPacks () {
    const p = S.packs || { catalog: { entries: [] }, registry: { packs: {} } }
    const cat = (p.catalog && p.catalog.entries) || []
    const reg = (p.registry && p.registry.packs) || {}
    const busy = !!p.running || ['downloading', 'verifying', 'extracting', 'validating', 'storing', 'preparing'].includes(p.progress && p.progress.phase)
    const catalogLeft = cat.filter((e) => !reg[e.id])
    const installed = Object.keys(reg)
    const byId = Object.fromEntries(cat.map((e) => [e.id, e]))
    const note = $('packsNote')
    note.hidden = !busy
    if (busy && p.progress) {
      const chip = packStateChip({ id: p.progress.id }, reg, p.progress)
      note.textContent = (PACK_PHASE[p.progress.phase] || p.progress.phase) + (p.progress.message ? ' · ' + p.progress.message : '') + (chip && !chip.includes(PACK_PHASE[p.progress.phase] || '') ? ' · ' + chip : '')
    }
    // one horizontal card per pack: avatar · name + two-line summary · one primary control
    const ava = (id) => {
      const box = el('div', { class: 'pack-ava', 'data-pack': id.split('.').pop() })
      const img = el('img', { alt: '', src: 'packs/' + encodeURIComponent(id.split('.').pop()) + '.png' })
      img.hidden = true
      img.addEventListener('load', () => { img.hidden = false })
      box.append(img)
      return box
    }
    const claudeExpanded = $('claudePackDetail')?.hidden === false
    const card = (id, entry, chip, action, remove) => {
      const e = byId[id]
      const claude = id === 'builtin.claude-girl'
      const title = el('b', {}, [(e && e.name) || id.split('.').pop(),
        entry?.active?.version ? el('small', { class: 'pack-version' }, 'v' + entry.active.version) : ''])
      const body = el('div', { class: 'pack-body' }, [
        title, el('p', {}, chip && /失败|待/.test(chip) ? chip : (e?.summary || '')),
      ])
      const result = el('article', { class: 'pack' + (chip === '加载失败' ? ' bad' : '') }, [ava(id), body, action, remove || ''])
      if (claude) {
        const detail = el('div', { id: 'claudePackDetail', class: 'pack-detail' }, el('dl', {}, [
          el('dt', {}, 'Claude娘'), el('dd', {}, '平时陪你聊天，放歌时会戴上耳机。'),
          el('dt', {}, 'Clawd 书页床'), el('dd', {}, '打开家具后，可以叫桌宠上床睡觉或起床。其他角色也能用。'),
          el('dt', {}, 'Clawd 音色'), el('dd', {}, '在语音预设里选 Clawd，就能用她的声音朗读。'),
        ]))
        detail.hidden = !claudeExpanded
        body.tabIndex = 0
        body.setAttribute('role', 'button')
        body.setAttribute('aria-controls', detail.id)
        body.setAttribute('aria-expanded', String(claudeExpanded))
        bindPackDetail(body, detail)
        result.append(detail)
      }
      return result
    }
    $('packs').replaceChildren(
      ...catalogLeft.map((e) => card(e.id, null, '', el('button', {
        class: 'pill pack-act', type: 'button', title: (e.size / 1048576).toFixed(1) + ' MB',
        disabled: busy || undefined, on: { click: () => installPack(e.id) },
      }, '下载'))),
      ...installed.map((id) => {
        const entry = reg[id] || {}
        const chip = packStateChip({ id }, reg, p.progress)
        const pending = Array.isArray(entry.pendingPermissions) ? entry.pendingPermissions : []
        let act
        if (pending.length) {
          act = el('button', { class: 'pill pack-act', type: 'button', title: pending.join('、'), on: { click: () => packAction('grant', id) } }, '确认权限')
        } else {
          const box = el('input', { type: 'checkbox', 'aria-label': '启用' })
          box.checked = entry.wantEnabled === true
          box.addEventListener('change', () => packAction(box.checked ? 'grant' : 'disable', id))
          act = el('label', { class: 'sw pack-act' }, [box, el('i')])
        }
        const x = iconBtn('trash', '卸载', { click: () => uninstallPack(id) })
        x.classList.add('pack-x')
        // 更新后留着的旧版本：按钮自己带大小，不弹确认（回滚随之不可用）。没有旧版本就不显示。
        const prevBytes = entry.previous && Z && Z.previous ? Z.previous[id] : 0
        const prune = entry.previous ? el('button', { class: 'pill ghostly rm pack-act', type: 'button', disabled: busy || undefined, on: { click: () => prunePack(id) } },
          '清理旧版本' + (prevBytes > 0 ? ' · ' + fmtSize(prevBytes) : '')) : null
        const update = p.updates?.[id]
        const actions = update || prune ? el('div', { class: 'pack-actions' }, [
          ...(update ? [el('button', { class: 'pill pack-act', type: 'button', title: 'v' + update, disabled: busy || undefined,
            on: { click: () => installPack(id, true) } }, '更新')] : []),
          ...(prune ? [prune] : []), act,
        ]) : act
        return card(id, entry, chip, actions, x)
      }))
  }
  async function installPack (packId, update = false) {
    toast(update ? '正在更新' : '开始下载')
    const r = await api('packs/install', { packId, enable: !update }).catch((e) => ({ ok: false, message: String(e) }))
    toast(packToast(r, update ? '已更新' : '装好了', update ? '更新失败' : '没装上'))
    load()
  }
  function packToast (r, okText, failText) {
    if (!r.ok) return r.message || failText
    if (r.needsAuthorization) return '装好了，确认权限后启用'
    return r.receipt && r.receipt.petRunning === false ? okText + '，桌宠启动后生效' : okText
  }
  async function prunePack (packId) {
    const r = await api('packs/prune', { packId }).catch((e) => ({ ok: false, message: String(e) }))
    toast(r.ok ? '已清理' : (r.message || '没清掉'))
    await load(); loadSizes()
  }
  async function packAction (action, packId) {
    const r = await api('packs/' + action, { packId }).catch((e) => ({ ok: false, message: String(e) }))
    toast(packToast(r, action === 'grant' ? '已启用' : '已停用', '没成功'))
    load()
  }
  async function uninstallPack (packId) {
    if (!(await ask('卸载「' + packId.split('.').pop() + '」？包文件会一并删掉。'))) return
    const r = await api('packs/uninstall', { packId }).catch((e) => ({ ok: false, message: String(e) }))
    toast(r.ok ? '已卸载' : (r.message || '没卸掉'))
    load()
  }
  {
    const input = $('packFile')
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0]
      if (!f) return
      $('packFileName').textContent = f.name
      toast('导入中')
      const r = await api('packs/import?enable=1&name=' + encodeURIComponent(f.name), f, 'application/octet-stream').catch((e) => ({ ok: false, message: String(e) }))
      toast(packToast(r, '装好了', '没装上'))
      input.value = ''
      $('packFileName').textContent = '导入 .petpack'
      load()
    })
  }

  // which interpreter the pet will run: the resolved path, or how far the runtime download got
  function renderPython () {
    const p = S.python || { path: '', phase: 'idle', message: '' }
    const pr = p.progress || null
    const pct = pr && pr.total ? Math.round((pr.done / pr.total) * 100) : 0
    const text = p.phase === 'preparing'
      ? (pr && pr.phase === 'downloading' ? '准备运行时 ' + pct + '%' : pr && pr.phase === 'pip' ? '安装 Pillow…' : pr && pr.phase === 'verifying' ? '校验…' : pr && pr.phase === 'extracting' ? '解包…' : '准备运行时…')
      : p.path || (p.phase === 'error' || p.phase === 'missing' ? (p.message || '需要准备运行时') : '')
    const out = $('pythonPath')
    out.value = text
    out.title = p.path || text
    out.dataset.s = p.phase === 'error' || p.phase === 'missing' ? 'bad' : p.phase === 'ready' ? 'good' : ''
  }

  const AG_STATE = { active: '已连接', degraded: '连接不稳定，稍后重试', 'auth-required': '需要重新授权', unconfigured: '未配置', disabled: '未开启' }
  const openPage = (page, name, feat) => fetch('api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page }) })
    .then((r) => r.json()).then((r) => { if (!r.ok) throw new Error(r.message) })
    .catch(() => { if (!window.open(page, name, feat)) location.href = page })
  const openFurniture = () => openPage('create?kind=furniture', 'pixelpet-create-furniture', 'width=980,height=820')
  const openCreate = (id) => openPage('create' + (id ? '?id=' + encodeURIComponent(id) : ''), 'pixelpet-create', 'width=980,height=820')
  /** ✎ on a card: the editor reads the installed pack back on its own (create?edit=1&kind=…&id=…) */
  const openEditor = (kind, id) => openPage('create?edit=1&kind=' + kind + '&id=' + encodeURIComponent(id),
    kind === 'character' ? 'pixelpet-create' : 'pixelpet-create-furniture', 'width=980,height=820')

  // ---------------------------------------------------------------- image generation
  function renderImagegen () {
    const ig = S.imagegen || { settings: { provider: 'openai', keyRef: 'OPENAI_API_KEY' }, store: 'env', key: { configured: false } }
    const c = ig.settings
    const d = (ig.providers || { openai: { fixed: true, model: 'gpt-image-2', keyRef: 'OPENAI_API_KEY' } })[c.provider] || {}
    setSeg('igProvider', c.provider)
    for (const r of document.querySelectorAll('[data-ig]')) r.hidden = !!d.fixed
    $('igFixed').hidden = !d.fixed
    $('igFixed').value = d.model || ''
    $('igBase').placeholder = d.baseUrl || 'https://…/v1'; $('igModel').placeholder = d.model || ''; $('igRef').placeholder = d.keyRef || ''
    keep('igBase', c.baseUrl); keep('igModel', c.model); keep('igRef', c.keyRef)
    const dsh = ig.store === 'dsh'
    $('igKey').hidden = !dsh
    $('igKey').placeholder = ig.key.configured ? '••••••••' : ''
    $('igKeyState').dataset.s = ig.key.configured ? 'ok' : ''
    $('igKeyState').title = ig.key.configured ? '已设置' + (ig.key.source ? '（' + ig.key.source + '）' : '') : '未设置'
    $('igKeyDel').hidden = !(dsh && ig.key.configured && ig.key.source && !/env/i.test(ig.key.source))
  }
  const saveIg = (patch) => save({ imagegen: patch }).then(() => api('imagegen').then((r) => { S.imagegen = r; renderImagegen() }))
  $('igProvider').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveIg({ provider: b.dataset.v }) })
  $('igBase').addEventListener('change', (e) => {
    const v = e.target.value.trim()
    saveIg({ baseUrl: v }).then(() => { if (v && S.imagegen.settings.baseUrl !== v.replace(/\/+$/, '')) toast('地址格式不对') })
  })
  $('igModel').addEventListener('change', (e) => saveIg({ model: e.target.value.trim() }))
  $('igRef').addEventListener('change', (e) => {
    const v = e.target.value.trim()
    saveIg({ keyRef: v }).then(() => { if (v && S.imagegen.settings.keyRef !== v) toast('变量名只能用字母、数字、下划线') })
  })
  const putKey = (value) => api('imagegen/key', { value }).then((r) => {
    $('igKey').value = ''
    if (!r.ok) return toast(r.message || '保存失败')
    S.imagegen = { ...S.imagegen, settings: r.settings, store: r.store, key: r.key, providers: r.providers || (S.imagegen && S.imagegen.providers) }; renderImagegen(); toast(value ? '已保存' : '已移除')
  })
  $('igKey').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) putKey(v) })
  $('igKeyDel').addEventListener('click', () => { ask('移除已保存的 Key？').then((y) => { if (y) putKey('') }) })
  $('igTest').addEventListener('click', () => {
    const btn = $('igTest'); const out = $('igTestOut')
    btn.disabled = true; out.value = '…'; out.dataset.s = ''
    api('imagegen/test', {}).then((r) => {
      btn.disabled = false
      out.dataset.s = r.ok ? 'ok' : 'bad'
      out.value = r.ok ? '✓ ' + r.model + (r.listed === false ? '（模型列表里没看到它）' : '') : (r.message || '失败')
      out.title = out.value
    }, () => { btn.disabled = false; out.value = '失败'; out.dataset.s = 'bad' })
  })

  // ---------------------------------------------------------------- voice
  const HOTKEYS = ['', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Pause', 'ScrollLock', 'XButton1', 'XButton2', 'RCtrl', 'RAlt']
  const KEY_NAMES = { '': '—', XButton1: '鼠标侧键 1', XButton2: '鼠标侧键 2', RCtrl: '右 Ctrl', RAlt: '右 Alt', ScrollLock: 'Scroll Lock' }
  let uiMode = null
  const mb = (n) => (n / 1048576 >= 1000 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / 1048576) + ' MB')
  const setSeg = (id, val) => { for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === val)) }
  const keep = (id, val) => { if (document.activeElement !== $(id)) $(id).value = val || '' }

  function voiceMode () {
    const t = S.settings.voice.tts
    return uiMode || (t.engine === 'custom' ? 'custom' : t.voice.startsWith('clone-') ? 'clone' : 'preset')
  }

  function renderVoice () {
    const v = S.settings.voice
    const intr = v.interruption || { enabled: true, reply: '嗯，你说' }
    $('interruptEnabled').checked = intr.enabled
    if (document.activeElement !== $('interruptReply')) $('interruptReply').value = intr.reply
    const fl = v.failure || { enabled: true, reply: '' }
    $('failEnabled').checked = fl.enabled
    if (document.activeElement !== $('failReply')) $('failReply').value = fl.reply
    const ap = v.approval || { enabled: true, reply: '有个审批要你点一下。' }
    $('apprEnabled').checked = ap.enabled
    if (document.activeElement !== $('apprReply')) $('apprReply').value = ap.reply
    const qs = v.question || { enabled: true, reply: '这里有个问题要问你。' }
    $('qstEnabled').checked = qs.enabled
    if (document.activeElement !== $('qstReply')) $('qstReply').value = qs.reply
    $('toneEnabled').checked = (v.tone || { enabled: true }).enabled !== false
    const mode = voiceMode()
    const presets = S.voices.filter((x) => x.kind === 'preset')
    $('voiceMode').querySelector('[data-v="preset"]').textContent = presets.length > 1 ? '预设' : presets[0]?.name || '默认'
    setSeg('voiceMode', mode)
    for (const r of document.querySelectorAll('[data-mode]')) r.hidden = r.dataset.mode !== mode
    const preset = $('presetVoice')
    preset.replaceChildren(...presets.map((x) => el('option', { value: x.id }, x.name)))
    preset.value = presets.some((x) => x.id === v.tts.voice) ? v.tts.voice : presets[0]?.id || ''
    preset.closest('.row').hidden = mode !== 'preset' || presets.length < 2
    const clones = S.voices.filter((x) => x.kind === 'clone')
    $('cloneVoice').replaceChildren(...clones.map((x) => { const o = el('option', { value: x.id }, x.name); o.selected = x.id === v.tts.voice; return o }))
    $('cloneVoice').closest('.row').hidden = mode !== 'clone' || !clones.length
    setSeg('customMode', v.tts.custom.mode)
    $('customUrl').hidden = v.tts.custom.mode !== 'http'; $('customCmd').hidden = v.tts.custom.mode !== 'command'
    keep('customUrl', v.tts.custom.url); keep('customCmd', v.tts.custom.command)
    setSeg('stt', v.stt.engine)
    $('sttEndpoint').hidden = v.stt.engine !== 'local-http'
    keep('sttEndpoint', v.stt.endpoint)
    $('hotkey').replaceChildren(...HOTKEYS.map((k) => { const o = el('option', { value: k }, KEY_NAMES[k] || k); o.selected = k === (v.hotkey || ''); return o }))
    renderEngine()
  }

  function renderEngine () {
    const st = S.voice || { ready: false, deps: [] }
    const row = $('engineRow')
    row.hidden = voiceMode() === 'custom'
    const p = st.progress
    const ov = p && p.overall && p.overall.total ? p.overall : null
    const frac = st.ready ? 1 : ov ? Math.min(1, ov.done / ov.total) : 0
    $('engineBar').style.width = (frac * 100).toFixed(1) + '%'
    const failed = !st.running && !st.ready && ((p && p.phase === 'failed') || (st.last && st.last.code !== 0))
    row.dataset.state = st.running ? 'running' : failed ? 'failed' : st.ready ? 'ready' : 'idle'
    $('engineText').textContent = st.running
      ? (p && p.phase === 'pip' ? 'Python 依赖…' : ov ? mb(ov.done) + ' / ' + mb(ov.total) : '…')
      : failed ? ((p && p.message) || (st.last && st.last.message) || '失败') : st.ready ? '✓' : mb(st.total || 0)
    $('engineText').title = failed ? $('engineText').textContent : ''
    $('engineRetry').hidden = st.running || st.ready
    setIcon($('engineRetry'), failed ? 'refresh' : 'download', failed ? '重试' : '下载')
    paintClean()
  }

  let polling = false
  function pollVoice () {
    if (polling) return
    polling = true
    const tick = () => api('voice/status').then((r) => {
      const was = S.voice && S.voice.running
      S.voice = r; renderEngine()
      if (r.running && !purged) return setTimeout(tick, 1000)
      polling = false
      if (was) load()
    }, () => { polling = false })
    tick()
  }

  $('voiceMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    const m = b.dataset.v
    const clones = S.voices.filter((x) => x.kind === 'clone')
    const preset = $('presetVoice').value || 'whale-girl'
    uiMode = null
    if (m === 'preset') save({ voice: { tts: { engine: 'qwen', voice: preset } } })
    else if (m === 'custom') save({ voice: { tts: { engine: 'custom' } } })
    else if (clones.length) save({ voice: { tts: { engine: 'qwen', voice: clones.some((c) => c.id === S.settings.voice.tts.voice) ? S.settings.voice.tts.voice : clones[0].id } } })
    else { uiMode = 'clone'; renderVoice() }
  })
  $('presetVoice').addEventListener('change', (e) => save({ voice: { tts: { engine: 'qwen', voice: e.target.value } } }))
  $('cloneVoice').addEventListener('change', (e) => save({ voice: { tts: { engine: 'qwen', voice: e.target.value } } }))
  $('cloneDel').addEventListener('click', async () => {
    const id = $('cloneVoice').value; if (!id) return
    if (!(await ask('删除这个克隆音色？'))) return
    api('voice/delete', { id }).then(() => { uiMode = 'clone'; return load() })
  })
  $('cloneFile').addEventListener('change', (e) => { const f = e.target.files[0]; $('cloneFileName').textContent = f ? f.name : '参考音频' })
  $('cloneGo').addEventListener('click', () => {
    const f = $('cloneFile').files[0]
    if (!f) { $('cloneFile').click(); return }
    const btn = $('cloneGo'); btn.disabled = true; btn.classList.add('busy')
    const q = 'name=' + encodeURIComponent(f.name.replace(/\.[^.]+$/, '').slice(0, 40)) + '&text=' + encodeURIComponent($('cloneText').value.trim().slice(0, 400))
    api('voice/clone?' + q, f, f.type || 'audio/wav').then((r) => {
      btn.disabled = false; btn.classList.remove('busy')
      toast(r.ok ? '✓' : (r.message || '失败'))
      if (r.ok) { $('cloneFile').value = ''; $('cloneText').value = ''; $('cloneFileName').textContent = '参考音频'; uiMode = null }
      return load()
    })
  })
  $('customMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ voice: { tts: { engine: 'custom', custom: { mode: b.dataset.v } } } }) })
  $('customUrl').addEventListener('change', (e) => {
    const val = e.target.value.trim()
    save({ voice: { tts: { custom: { url: val } } } }).then(() => { if (val && S.settings.voice.tts.custom.url !== val) toast('只接本机地址') })
  })
  $('customCmd').addEventListener('change', (e) => {
    const val = e.target.value.trim()
    if (val && !val.includes('{text}')) toast('模板里要有 {text}')
    save({ voice: { tts: { custom: { command: val } } } })
  })
  $('engineRetry').addEventListener('click', () => api('voice/install', {}).then((r) => { S.voice = r; renderEngine(); pollVoice() }))
  $('test').addEventListener('click', () => {
    const btn = $('test'); btn.disabled = true; btn.classList.add('busy')
    api('voice/test', {}).then((r) => {
      btn.disabled = false; btn.classList.remove('busy')
      if (!r.ok) return toast(r.message || '失败')
      const a = $('testAudio'); a.src = 'api/voice/wav/' + r.wav; a.play().catch(() => {})
    }, () => { btn.disabled = false; btn.classList.remove('busy') })
  })
  $('hotkey').addEventListener('change', (e) => save({ voice: { hotkey: e.target.value } }))
  $('interruptEnabled').addEventListener('change', (e) => {
    save({ voice: { interruption: { enabled: e.target.checked } } })
  })
  $('interruptReply').addEventListener('change', (e) => save({ voice: { interruption: { reply: e.target.value } } }))
  $('failEnabled').addEventListener('change', (e) => save({ voice: { failure: { enabled: e.target.checked } } }))
  $('failReply').addEventListener('change', (e) => save({ voice: { failure: { reply: e.target.value } } }))
  $('apprEnabled').addEventListener('change', (e) => save({ voice: { approval: { enabled: e.target.checked } } }))
  $('apprReply').addEventListener('change', (e) => save({ voice: { approval: { reply: e.target.value } } }))
  $('qstEnabled').addEventListener('change', (e) => save({ voice: { question: { enabled: e.target.checked } } }))
  $('qstReply').addEventListener('change', (e) => save({ voice: { question: { reply: e.target.value } } }))
  $('toneEnabled').addEventListener('change', (e) => save({ voice: { tone: { enabled: e.target.checked } } }))

  // ---------------------------------------------------------------- 声纹
  // settings.voiceprint 里只有 enabled / mode / strictness；人名只从 /api/voiceprint/people 取。
  const VP_REASON = {
    disabled: '关着', 'no-enroll': '还没录入任何人', 'model-missing': '声纹模型还没装好',
    'model-rev': '换了模型，旧模板已作废', 'model-error': '声纹模型出错了',
    'config-error': '读不到声纹设置', 're-enroll': '换了保存方式，需要重新录入', strict: '没到门限',
  }

  // In-page confirm: window.confirm may be suppressed inside the DSH window, which made buttons look dead.
  const ask = (text) => new Promise((done) => {
    const d = document.createElement('dialog'); d.className = 'ask'
    const p = document.createElement('p'); p.textContent = text
    const row = document.createElement('div'); row.className = 'ask-row'
    const no = document.createElement('button'); no.className = 'ghost'; no.textContent = '取消'
    const yes = document.createElement('button'); yes.className = 'primary'; yes.textContent = '确定'
    row.append(no, yes); d.append(p, row); document.body.append(d)
    const end = (v) => { d.close(); d.remove(); done(v) }
    no.onclick = () => end(false); yes.onclick = () => end(true); d.oncancel = (e) => { e.preventDefault(); end(false) }
    d.showModal(); yes.focus()
  })
  const vpFail = (e) => toast((e && e.message) || '声纹操作失败')
  let vpPoll = 0
  let vpCapability
  const vpApi = async (path = '', body) => {
    if (!vpCapability) {
      const r = await fetch('api/voiceprint/session', { headers: { 'X-Pixelpet-UI': '1' }, credentials: 'same-origin' }).then((r) => r.json())
      if (!r.ok || !r.capability) throw new Error('仅本机设置页可以操作声纹')
      vpCapability = r.capability
    }
    const r = await fetch('api/voiceprint' + (path ? '/' + path : ''), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { 'X-Pixelpet-UI': '1', 'X-Pixelpet-Voiceprint': vpCapability, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (r.status === 401) vpCapability = null
    return r.json()
  }

  const vpStateText = (n, t) => { n.textContent = ''; n.dataset.tip = t; n.setAttribute('aria-label', t) }
  // 只在真要注意时说一句人话；默认（加密落盘）什么都不显示
  const vpNoteText = (n, st) => {
    const t = st.memory ? '只存在这次运行里，关掉桌宠就要重新录入' : st.encrypted === false ? '这台电脑没法加密保存声纹' : ''
    n.hidden = !t; n.textContent = t
  }
  function renderVoiceprint () {
    const v = (S.settings && S.settings.voiceprint) || { enabled: false, mode: 'disk', strictness: 0.5 }
    $('vpEnabled').checked = !!v.enabled
    setSeg('vpMode', v.mode || 'disk')
    keep('vpStrict', String(v.strictness == null ? 0.5 : v.strictness))
    $('vpStrictOut').value = Number($('vpStrict').value).toFixed(2)
    const st = S.voiceprint || {}
    const state = $('vpState')
    const note = $('vpNote')
    $('vpEnroll').disabled = false
    $('vpTest').disabled = !v.enabled
    if (!v.enabled) {
      state.hidden = true; note.hidden = true
      $('vpClear').hidden = true
      $('vpPeople').replaceChildren()
      return
    }
    $('vpEnroll').disabled = !v.enabled
    $('vpTest').disabled = !v.enabled
    const ready = st.ready === true && st.reason === 'ok'
    state.hidden = false
    state.dataset.s = ready ? 'ok' : 'bad'
    vpStateText(state, ready ? '就绪 · ' + (st.enrolled || 0) + ' 人' : (VP_REASON[st.reason] || st.reason || '未就绪'))
    vpNoteText(note, st)
    if (vpPoll) return
    vpPoll = 1
    Promise.all([vpApi(), vpApi('people')]).then(([status, r]) => {
      vpPoll = 0
      S.voiceprint = status
      state.dataset.s = status.ready ? 'ok' : 'bad'
      vpStateText(state, status.ready ? '就绪 · ' + (status.enrolled || 0) + ' 人' : (VP_REASON[status.reason] || status.reason || '未就绪'))
      vpNoteText(note, status)
      const people = (r && r.people) || []
      $('vpPeople').replaceChildren(...people.map((p) => el('div', { class: 'row vpperson' }, [
        el('span', {}, p.name),
        el('output', { class: 'mono' }, String(p.n) + ' 句'),
        iconBtn('x', '删除', { click: () => { ask('删除 ' + p.name + ' 的声纹？').then((y) => { if (y) vpApi('delete', { name: p.name }).then(load, vpFail) }) } }),
      ])))
      $('vpClear').hidden = people.length === 0
    }, () => { vpPoll = 0 })
  }

  const saveVp = (patch) => save({ voiceprint: { ...(S.settings.voiceprint || {}), ...patch } }).then(() => renderVoiceprint())
  $('vpEnabled').addEventListener('change', (e) => {
    const on = e.target.checked
    const go = () => saveVp({ enabled: on }).then(() => { if (on && !((S.voiceprint || {}).enrolled > 0)) vpApi('enroll', {}).then((r) => { if (!r.ok) toast(r.message || '桌宠没在运行，先启动再录入') }, vpFail) })
    if (!on) return go()
    e.target.checked = false
    ask('打开后只回应录入过的声音；没录入之前桌宠不会听你的话。继续？').then((y) => { if (y) { e.target.checked = true; go() } })
  })
  $('vpMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    saveVp({ mode: b.dataset.v }).then(() => toast(b.dataset.v === 'memory' ? '仅本次运行：要重新录入' : '加密保存'))
  })
  $('vpStrict').addEventListener('input', (e) => { $('vpStrictOut').value = Number(e.target.value).toFixed(2) })
  $('vpStrict').addEventListener('change', (e) => saveVp({ strictness: Number(e.target.value) }))
  const petUp = () => !!(S.pet && S.pet.running)
  $('vpEnroll').addEventListener('click', () => {
    if (!petUp()) return toast('先启动桌宠，录入窗口由桌宠打开')
    if (!((S.settings.voiceprint || {}).enabled)) return toast('先打开「只和录入过的人说话」')
    vpApi('enroll', {}).then((r) => toast(r.ok ? '录入窗口打开了' : (r.message || '打不开窗口')), vpFail)
  })
  $('vpTest').addEventListener('click', () => {
    if (!petUp()) return toast('先启动桌宠')
    vpApi('test', {}).then((r) => toast(r.ok ? '请在本地窗口点击录音' : (r.message || '打不开窗口')), vpFail)
  })
  $('vpModel').addEventListener('click', () => vpApi('model', {}).then((r) => toast(r.ok ? '正在下载公开声纹模型，完成后重新打开设置页' : '下载没启动，请稍后重试'), vpFail))
  $('vpClear').addEventListener('click', () => { ask('删掉所有人的声纹？').then((y) => { if (y) vpApi('clear', {}).then(load, vpFail) }) })

  // ---------------------------------------------------------------- 清理：每类资源一个真删除入口 + 清除全部数据（lib/cleanup.js）
  // 按钮上直接带大小；大小是异步算的，算出来之前只写「删除」，算出来是 0 就收起来。
  const fmtSize = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n > 0 ? n + ' B' : '0'
  let Z = null // 最近一次 cleanup/sizes
  let purged = false
  const sizeBtn = (id, bytes, hide = false) => {
    const b = $(id); if (!b) return
    b.textContent = '删除' + (Z && bytes > 0 ? ' · ' + fmtSize(bytes) : '')
    b.hidden = hide || (Z !== null && !(bytes > 0))
  }
  function paintClean () {
    if (!S) return
    const running = !!(S.voice && S.voice.running)
    sizeBtn('engineDelete', Z && Z.voice, running)
    sizeBtn('vpModelDelete', Z && Z.speaker)
    sizeBtn('listenDelete', Z && Z.listen)
    sizeBtn('readingDelete', Z && Z.reading)
    sizeBtn('calendarDelete', Z && Z.records)
    if (S.packs) renderPacks()
    $('purgeAll').textContent = '清除全部数据' + (Z && Z.total > 0 ? ' · ' + fmtSize(Z.total) : '')
  }
  const loadSizes = () => api('cleanup/sizes').then((r) => { if (r.ok) { Z = r.sizes; paintClean() } }).catch(() => {})
  const BUSY_TEXT = '有程序还在用，关掉桌宠再试'
  const cleanFail = (r) => toast(r && r.code === 'busy' ? BUSY_TEXT : (r && r.message) || '没删掉')
  async function exportRecords (scope) {
    try {
      const r = await fetch('api/cleanup/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) })
      if (!r.ok) throw new Error('export')
      const url = URL.createObjectURL(await r.blob())
      const a = el('a', { href: url, download: '桌宠记录导出.zip' }); document.body.append(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      toast('已导出')
    } catch { toast('导出失败') }
  }
  /** 带「先导出」的确认框：-> true / false */
  const askExport = (text, scope) => new Promise((done) => {
    const d = document.createElement('dialog'); d.className = 'ask'
    const p = document.createElement('p'); p.textContent = text
    const row = document.createElement('div'); row.className = 'ask-row'
    const out = el('button', { class: 'ghost', type: 'button', on: { click: () => exportRecords(scope) } }, '先导出')
    const no = el('button', { class: 'ghost', type: 'button' }, '取消')
    const yes = el('button', { class: 'danger', type: 'button' }, '确定')
    row.append(out, no, yes); d.append(p, row); document.body.append(d)
    const end = (v) => { d.close(); d.remove(); done(v) }
    no.onclick = () => end(false); yes.onclick = () => end(true); d.oncancel = (e) => { e.preventDefault(); end(false) }
    d.showModal(); no.focus()
  })
  async function cleanDelete (category, text, withExport) {
    const ok = withExport ? await askExport(text, withExport) : await ask(text)
    if (!ok) return
    toast('正在删除')
    const r = await api('cleanup/delete', { category }).catch(() => ({ ok: false }))
    if (r.ok) toast('已删除，腾出 ' + fmtSize(r.freed || 0)); else cleanFail(r)
    await load(); loadSizes()
  }
  $('engineDelete').addEventListener('click', () => cleanDelete('voice', '删掉语音引擎、依赖和合成缓存？删掉后桌宠不能说话，需要时可以重新下载。'))
  $('vpModelDelete').addEventListener('click', () => cleanDelete('speaker', '删掉声纹模型？删掉后声纹不能用，需要时可以重新下载。'))
  $('listenDelete').addEventListener('click', () => cleanDelete('listen', '删掉听得更细的模型和听歌缓存？歌曲文件不受影响。'))
  $('readingDelete').addEventListener('click', () => {
    const n = Z && Z.notes
    cleanDelete('reading', '阅读窗的登录状态和阅读记录会清掉。' + (n ? '你留存的 ' + n + ' 条划词笔记不会删。' : ''))
  })
  $('calendarDelete').addEventListener('click', () => cleanDelete('records', '你记的日程和桌宠写的日记会永久删除。', 'records'))

  // 清除全部数据：两步确认。第一步列清单（自己的记录在最上面，旁边「先导出」），第二步输入「清除」
  const listRow = (name, bytes, cls) => el('li', cls ? { class: cls } : {}, [el('span', {}, name), el('output', {}, fmtSize(bytes))])
  function purgeStep1 (z) {
    return new Promise((done) => {
      const d = document.createElement('dialog'); d.className = 'ask wide'
      const mine = [['日记', z.diary], ['日程', z.calendar], ['信件', z.mailbox], ['克隆音色', z.clones], ['阅读记录', z.readingRecords]].filter((x) => x[1] > 0)
      const rest = [['语音引擎', z.voice], ['声纹模型', z.speaker], ['声纹模板', z.voiceprint], ['一起听歌', z.listen], ['阅读窗数据', z.reading], ['拓展包', z.packs], ['Python 运行时', z.python], ['其它', z.other]].filter((x) => x[1] > 0)
      const ul = el('ul', { class: 'ask-list' }, [
        ...mine.map((x) => listRow(x[0], x[1])),
        ...rest.map((x, i) => listRow(x[0], x[1], i === 0 && mine.length ? 'sep' : '')),
      ])
      const row = document.createElement('div'); row.className = 'ask-row'
      const out = mine.length ? el('button', { class: 'ghost', type: 'button', on: { click: () => exportRecords('all') } }, '先导出') : ''
      const no = el('button', { class: 'ghost', type: 'button' }, '取消')
      const go = el('button', { class: 'primary', type: 'button' }, '继续')
      row.append(...[out, no, go].filter(Boolean)); d.append(ul, row); document.body.append(d)
      const end = (v) => { d.close(); d.remove(); done(v) }
      no.onclick = () => end(false); go.onclick = () => end(true); d.oncancel = (e) => { e.preventDefault(); end(false) }
      d.showModal(); no.focus()
    })
  }
  function purgeStep2 () {
    return new Promise((done) => {
      const d = document.createElement('dialog'); d.className = 'ask'
      const input = el('input', { class: 'confirm', type: 'text', placeholder: '输入「清除」', autocomplete: 'off', spellcheck: 'false', 'aria-label': '输入「清除」' })
      const row = document.createElement('div'); row.className = 'ask-row'
      const no = el('button', { class: 'ghost', type: 'button' }, '取消')
      const yes = el('button', { class: 'danger', type: 'button', disabled: 'true' }, '确定')
      row.append(no, yes); d.append(input, row); document.body.append(d)
      input.addEventListener('input', () => { if (input.value.trim() === '清除') yes.removeAttribute('disabled'); else yes.setAttribute('disabled', 'true') })
      const end = (v) => { d.close(); d.remove(); done(v) }
      no.onclick = () => end(false); yes.onclick = () => end(input.value.trim() === '清除'); d.oncancel = (e) => { e.preventDefault(); end(false) }
      d.showModal(); input.focus()
    })
  }
  /** 清完：停掉所有轮询，页面只留一句话 */
  function showPurged () {
    purged = true
    window.__pixelpetPurged = true
    window.fetch = () => new Promise(() => {})            // 页面上所有脚本的轮询到此为止，不再写出新文件
    document.querySelector('main').replaceChildren(el('div', { class: 'purged' }, [
      el('b', {}, '已清除。现在可以在 DSH 里卸载插件了'),
      el('span', {}, '你给一起听歌配的 Python 环境没有动，不需要可以自己删。'),
    ]))
  }
  $('purgeAll').addEventListener('click', async () => {
    const r0 = await fetch('api/cleanup/sizes').then((r) => r.json()).catch(() => null)
    if (!r0 || !r0.ok) return toast('读不到大小，稍后再试')
    Z = r0.sizes; paintClean()
    if (!(await purgeStep1(Z))) return
    if (!(await purgeStep2())) return
    toast('正在清除')
    const r = await api('cleanup/all', { confirm: '清除' }).catch(() => ({ ok: false }))
    if (r.ok) showPurged(); else { cleanFail(r); load(); loadSizes() }
  })

  let migrationShown = ''
  function showMigration (notice) {
    if (notice && notice !== migrationShown) {
      migrationShown = notice
      toast(notice)
    }
  }
  function load () {
    return api('state').then((r) => {
      S = r
      render()
      loadFollow()
      showMigration(r.migrationNotice)
      if (r.voice && r.voice.running) pollVoice()
    })
  }

  $('run').addEventListener('click', () => {
    const starting = !S.pet.running
    api(starting ? 'pet/start' : 'pet/stop', {}).then(() => setTimeout(() => load().then(() => {
      const x = S.pet.lastExit
      if (starting && !S.pet.running && x && x.code !== 0) toast(x.message || ('退出码 ' + x.code))
    }), 1500))
  })
  $('stt').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ voice: { stt: { engine: b.dataset.v } } }) })
  $('sttEndpoint').addEventListener('change', (e) => save({ voice: { stt: { endpoint: e.target.value.trim() } } }))
  $('session').addEventListener('change', (e) => save({ voice: { llm: { sessionId: e.target.value } } }))
  // 跟随外部桥会话：手动 / 跟随、选来源、复制接入说明
  $('followMode').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || b.dataset.v === (followIsOn() ? 'follow' : 'manual')) return
    save({ followSession: { mode: b.dataset.v } }).then(loadFollow)
  })
  $('followSource').addEventListener('change', (e) => save({ followSession: { source: e.target.value } }).then(loadFollow))
  // 「接入聊天桥」：和信箱的「连接 Agently Mail」一样，点一下在下面展开给桥那边 AI 看的接入说明，再点收起
  $('followGuideBtn').addEventListener('click', () => {
    const g = $('followGuide')
    const btn = $('followGuideBtn')
    if (!g.hidden) { g.hidden = true; btn.setAttribute('aria-expanded', 'false'); return }
    api('follow/integration').then((r) => {
      $('followGuideText').textContent = String((r && r.text) || '')
      g.hidden = false
      btn.setAttribute('aria-expanded', 'true')
    }, () => toast('接入说明没取到'))
  })
  $('followGuideCopy').addEventListener('click', () => {
    navigator.clipboard.writeText($('followGuideText').textContent).then(() => toast('已复制'), () => toast('复制失败'))
  })
  $('size').addEventListener('input', (e) => { $('sizeOut').value = Number(e.target.value).toFixed(2) })
  $('size').addEventListener('change', (e) => save({ size: Number(e.target.value) }))
  for (const k of ['topmost', 'follow', 'stayPut', 'aiControl', 'autoStart']) $(k).addEventListener('change', (e) => save({ [k]: e.target.checked }))
  function renderAudioDirs () {
    const list = $('audioDirs')
    const dirs = S.settings.listen?.audioDirs || []
    $('audioDirRow').hidden = S.settings.listen?.enabled !== true
    list.hidden = dirs.length === 0
    list.replaceChildren(...dirs.map((dir) => el('li', {}, [
      el('span', { title: dir }, dir),
      iconBtn('x', '移除文件夹', { click: () => editAudioDirs('remove', { dir }) }),
    ])))
    $('addAudioDir').disabled = dirs.length >= 10 || audioPickerOpen
  }

  async function editAudioDirs (op, body = {}) {
    if (op === 'add') {
      audioPickerOpen = true
      renderAudioDirs()
    }
    try {
      const r = await api('music/audio-dirs/' + op, body)
      if (!r.ok) toast(r.message || '文件夹没有保存。')
      if (r.ok && r.audioDirs) S.settings.listen.audioDirs = r.audioDirs
    } catch {
      toast('文件夹没有保存。')
    } finally {
      if (op === 'add') audioPickerOpen = false
      renderAudioDirs()
    }
  }
  let audioPickerOpen = false
  $('addAudioDir').addEventListener('click', () => editAudioDirs('add'))
  $('listenOn').addEventListener('change', (e) => { $('openListen').hidden = $('listenPyRow').hidden = !e.target.checked; save({ listen: { enabled: e.target.checked } }) })
  // 「一起看书」（docs/READING_CONTRACT.md）：阅读窗由桌宠运行时拉起，桌宠没在跑时宿主自己拉起
  $('readingOn').addEventListener('change', (e) => { $('readingRow').hidden = !e.target.checked; save({ reading: { enabled: e.target.checked } }) })
  $('openReading').addEventListener('click', () => api('reading/open', {}).then((r) => { if (!r.ok) toast(r.message || '阅读窗没能打开') }).catch(() => toast('阅读窗没能打开')))
  // 「听得更细」（CLAP，可选组件）：开关 / 进度 / 删除模型 / 镜像
  const clapApi = (op, body) => api('music/' + op, { op, ...(body || {}) })
  const paintClap = (st) => {
    const on = $('clapOn').checked
    const running = st.state === 'installing' // 接口给的是 state，没有 running 字段
    $('clapState').textContent = running ? (st.progress ? st.progress.message : '装着呢…') : st.installed ? '已装' : (st.error ? st.error : '')
    return st
  }
  $('clapOn').addEventListener('change', (e) => {
    const on = e.target.checked
    $('clapMirror').hidden = !on
    clapApi(on ? 'clap/enable' : 'clap/disable', { mirror: $('clapMirror').value.trim() }).then((r) => { paintClap(r); if (r.state === 'installing') toast('开始下载模型，装完自动启用') })
    save({ listen: { clap: on } })
  })
  $('clapMirror').addEventListener('change', (e) => save({ listen: { clapMirror: e.target.value.trim() } }))
  setInterval(() => {
    if (purged || document.hidden || !$('listenPyRow') || $('listenPyRow').hidden || !$('clapOn').checked) return
    api('music/clap').then((r) => { if (r.ok !== false) paintClap(r) }).catch(() => {})
  }, 3000)
  // 「日历与日记」拓展包：开关 + 打开日历窗（日历窗住宿主侧，openWindow 打开）
  $('calendarOn').addEventListener('change', (e) => { $('calendarRow').hidden = !e.target.checked; save({ calendar: { enabled: e.target.checked } }) })
  $('openCalendar').addEventListener('click', () => api('calendar/open', {}).then((r) => { if (!r.ok) toast(r.message || '日历窗没能打开') }).catch(() => toast('日历窗没能打开')))
  // 内置拓展包的头像（web/packs/<名>.png）：图加载成功才露出来，没有图就保留占位符号（2026-11-15）
  for (const img of document.querySelectorAll('.pack-ava > img[hidden]')) {
    const show = () => { if (img.naturalWidth > 0) img.hidden = false }
    if (img.complete) show(); else img.addEventListener('load', show, { once: true })
  }
  // 拓展包卡片：点标题/简介展开「这个包里有什么、能干嘛」，再点收起
  for (const body of document.querySelectorAll('.pack-body[aria-controls]')) {
    const detail = $(body.getAttribute('aria-controls'))
    if (detail) bindPackDetail(body, detail)
  }
  $('openListen').addEventListener('click', () => openPage('card', 'pet-listen-card', 'width=340,height=520'))
  $('listenPython').addEventListener('change', (e) => save({ listen: { python: e.target.value.trim() } }))
  $('python').addEventListener('change', (e) => save({ python: e.target.value.trim() }).then(load))
  $('pythonPrepare').addEventListener('click', () => api('python/prepare', {}).then((r) => { if (r.python) { S.python = r.python; renderPython() } }))
  $('hubShow').addEventListener('change', (e) => save({ hub: { show: e.target.checked } }))
  $('hubSpeak').addEventListener('change', (e) => save({ hub: { speak: e.target.checked } }))
  $('hubAuto').addEventListener('change', (e) => {
    const n = Math.round(Number(e.target.value))
    if (!Number.isFinite(n) || n < 0 || n > 3600) { e.target.value = S.settings.hub.autoCollapseS; return }
    save({ hub: { autoCollapseS: n } })
  })

  $('partnerName').addEventListener('change', (e) => save({ partnerName: e.target.value.trim() }))
  $('partnerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur() })
  $('addressAs').addEventListener('change', (e) => save({ addressAs: e.target.value.trim() }))
  $('addressAs').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur() })
  $('openMail').addEventListener('click', () => openPage('mailbox', 'pixelpet-mailbox', 'width=460,height=720'))
  $('agently').addEventListener('change', async (e) => {
    if (e.target.checked && !(await ask('允许桌宠 AI 通过这个 Agently 邮箱自动发信？'))) { e.target.checked = false; return }
    save({ mail: { agently: e.target.checked ? { enabled: true, consent: true } : { enabled: false } } }).then(() => {
      if (!e.target.checked) return
      api('mail/agently/probe', {}).then((r) => toast(r.ok ? (r.aliases[0] ? r.aliases[0].email : '✓') : (r.health === 'auth-required' ? '需要重新授权' : '没找到 agently-cli')))
    })
  })
  $('agReauth').addEventListener('click', async () => {
    const b = $('agReauth'); b.disabled = true; toast('正在取授权链接…')
    try {
      const r = await api('mail/agently/reauth', {})
      if (!r.ok) toast(r.code === 'disabled' ? '邮箱没开' : 'agently-cli 没跑起来')
      else if (r.running) toast('授权已经在进行中')
      else if (r.opened) toast('授权链接已在浏览器打开，扫完码会自动恢复')
      else toast('没拿到授权链接，去 CLI 里看看')
    } catch { toast('重新授权失败') } finally { b.disabled = false }
  })
  $('agTo').addEventListener('change', (e) => {
    const v = e.target.value.trim()
    save({ mail: { agently: { to: v } } }).then(() => { if (v && S.settings.mail.agently.to !== v) toast('邮箱格式不对') })
  })
  $('agCmd').addEventListener('change', (e) => save({ mail: { agently: { command: e.target.value.trim() } } }))
  $('agGuide').addEventListener('click', () => {
    const g = $('guide')
    if (!g.hidden) { g.hidden = true; return }
    api('mail/agently/guide').then((r) => { $('guideText').textContent = r.text || ''; g.hidden = false })
  })
  $('guideCopy').addEventListener('click', () => {
    navigator.clipboard.writeText($('guideText').textContent).then(() => toast('已复制'), () => toast('复制失败'))
  })
  $('guideSend').addEventListener('click', () => {
    api('mail/agently/guide/send', {}).then((r) => toast(r.ok ? '已发到会话' : (r.message || '失败')))
  })

  window.addEventListener('message', (e) => { if (e.origin === location.origin && (e.data === 'pixelpet:characters' || e.data === 'pixelpet:furniture')) load() })
  window.addEventListener('focus', () => { if (S) load() })
  load()
  loadSizes()
  setInterval(() => { if (!document.hidden && !purged) api('state').then((r) => { if (!S || r.settings.character !== S.settings.character) { S = r; render() } S.pet = r.pet; S.sessions = r.sessions; S.mail = r.mail; S.python = r.python; S.followMode = r.followMode; S.effectiveSessionId = r.effectiveSessionId; showMigration(r.migrationNotice); renderPython(); $('mailCount').hidden = !r.mail.unread; $('mailCount').textContent = r.mail.unread; renderAgentlyState(); $('run').setAttribute('aria-pressed', String(r.pet.running)); $('runText').textContent = r.pet.running ? '运行中' : '启动'; if (followIsOn()) loadFollow() }) }, 4000)
})()
