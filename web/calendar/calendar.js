// 日历窗（「日历与日记」拓展包）：月历 + 当日栏 + 日记本 + 日历源弹层。数据来自 /api/calendar/*。
// 不画假数据；空态一句人话；订阅链接对外只见域名。
(() => {
  const $ = (id) => document.getElementById(id)
  let petLabel = '桌宠'
const api = (p, body) => fetch('../api/' + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())
  const del = (p) => fetch('../api/' + p, { method: 'DELETE' }).then((r) => r.json())
  const pad = (n) => String(n).padStart(2, '0')
  const WD = '日一二三四五六'
  const KIND_ICON = { yearly: '↻年', monthly: '↻月', weekly: '↻周' }
  let toastTimer = 0
  const toast = (t) => { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true }, 2200) }

  const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
  const dayMs = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))).getTime()
  const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  const addDays = (s, n) => { const d = new Date(dayMs(s)); d.setDate(d.getDate() + n); return keyOf(d) }
  const fmtDay = (s) => Number(s.slice(5, 7)) + ' 月 ' + Number(s.slice(8, 10)) + ' 日 周' + WD[new Date(dayMs(s)).getDay()]

  let viewMonth = todayKey().slice(0, 7)   // YYYY-MM
  let selected = todayKey()
  let monthData = null                     // { events, days, sources }
  let diaryDays = new Set()                // 这个月写过日记的日期（格子上的笔记标记）
  let editing = null                       // 正在改的日程
  let page = 'cal'
  let diaryMonth = todayKey().slice(0, 7)

  // ---------------------------------------------------------------- 月历
  async function loadMonth () {
    const [y, m] = viewMonth.split('-').map(Number)
    const from = y + '-' + pad(m) + '-01'
    const to = keyOf(new Date(y, m, 1))
    const [r, dr] = await Promise.all([
      api('calendar/events?from=' + from + '&to=' + to).catch(() => null),
      api('calendar/diary?month=' + viewMonth).catch(() => null),
    ])
    if (!r || r.ok !== true) return
    monthData = r
    diaryDays = new Set(((dr && dr.entries) || []).map((x) => x.date))
    renderGrid()
    renderDay()
  }

  function renderGrid () {
    const grid = $('grid')
    grid.replaceChildren()
    const [y, m] = viewMonth.split('-').map(Number)
    $('monTitle').textContent = y + ' 年 ' + m + ' 月'
    $('monToday').hidden = viewMonth === todayKey().slice(0, 7)
    const firstWd = new Date(y, m - 1, 1).getDay()
    const days = new Date(y, m, 0).getDate()
    const today = todayKey()
    const byDate = {}
    for (const ev of (monthData && monthData.events) || []) (byDate[ev.date] = byDate[ev.date] || []).push(ev)
    const daysMap = (monthData && monthData.days) || {}
    for (let i = 0; i < firstWd; i++) grid.appendChild(document.createElement('div'))
    for (let dd = 1; dd <= days; dd++) {
      const date = y + '-' + pad(m) + '-' + pad(dd)
      const info = daysMap[date] || {}
      const cell = document.createElement('div')
      cell.className = 'cell' + (date === today ? ' today' : '') + (date === selected ? ' sel' : '')
      const b = document.createElement('b'); b.textContent = String(dd)
      const sub = document.createElement('span')
      const fest = (info.festivals && info.festivals[0]) || (info.holiday && info.holiday.isOff ? info.holiday.name : '') || info.term || ''
      sub.textContent = fest || info.lunarDay || ''
      sub.className = 'sub' + (fest ? ' fest' : '')
      cell.append(b, sub)
      if (info.holiday) {
        const badge = document.createElement('span')
        badge.className = 'badge ' + (info.holiday.isOff ? 'off' : 'work')
        badge.textContent = info.holiday.isOff ? '休' : '班'
        cell.appendChild(badge)
      }
      const evs = byDate[date]
      if (evs && evs.length) {
        const dots = document.createElement('div'); dots.className = 'dots'
        for (const ev of evs.slice(0, 3)) {
          const i2 = document.createElement('i')
          if (ev.kind === 'birthday' || ev.kind === 'anniversary') i2.className = 'bday'
          else if (ev.by === 'sub' || ev.by === 'builtin') i2.className = 'sub'
          dots.appendChild(i2)
        }
        cell.appendChild(dots)
      }
      if (diaryDays.has(date)) {
        const mark = document.createElement('span'); mark.className = 'note-mark'; mark.title = '这天写过日记'
        cell.appendChild(mark)
      }
      cell.addEventListener('click', () => { selected = date; renderGrid(); renderDay() })
      cell.addEventListener('dblclick', () => { $('addTitle').focus() })
      grid.appendChild(cell)
    }
  }

  function renderDay () {
    const info = (monthData && monthData.days && monthData.days[selected]) || {}
    $('dayTitle').textContent = fmtDay(selected)
    $('dayLunar').textContent = info.lunarLine || ''
    const al = info.almanac
    $('almanacBox').hidden = !al
    if (al) $('almanac').textContent = '宜 ' + (al.yi || []).join('、') + ' / 忌 ' + (al.ji || []).join('、') + (al.chong ? ' · ' + al.chong + ' 煞' + al.sha : '')
    const list = $('evList')
    list.replaceChildren()
    const evs = ((monthData && monthData.events) || []).filter((e) => e.date === selected)
    if (!evs.length) {
      const li = document.createElement('li'); li.className = 'empty'
      li.textContent = selected === todayKey() ? '今天还没有安排，记一件事吧。' : '这天没有安排。'
      list.appendChild(li)
    }
    for (const ev of evs) {
      const li = document.createElement('li')
      const readOnly = ev.by === 'sub' // 订阅日程只读：不能改 / 删 / 勾
      if (ev.kind === 'todo' && ev.done) li.className = 'done'
      if (ev.time) { const t = document.createElement('time'); t.textContent = ev.time; li.appendChild(t) }
      const b = document.createElement('b'); b.textContent = ev.title; li.appendChild(b)
      if (ev.by === 'pet') { const tag = document.createElement('span'); tag.className = 'by-pet'; tag.textContent = petLabel + '记的'; li.appendChild(tag) }
      if (readOnly) { const tag = document.createElement('span'); tag.className = 'by-pet'; tag.textContent = ev.subName || '订阅'; li.appendChild(tag) }
      if (ev.repeat && ev.repeat !== 'none') { const r = document.createElement('span'); r.className = 'rep'; r.textContent = KIND_ICON[ev.repeat] || ''; li.appendChild(r) }
      if (!readOnly) li.addEventListener('click', () => editEvent(ev))
      list.appendChild(li)
    }
    $('addDate').value = selected
  }

  /** 点一条 → 表单进入编辑（改 / 勾完成 / 删）；保存或删完回新增态 */
  function editEvent (ev) {
    editing = ev
    $('addTitle').value = ev.title
    $('addDate').value = ev.date
    $('addTime').value = ev.time || ''
    $('addRepeat').value = ev.repeat || 'none'
    const days = (ev.remind && ev.remind.daysBefore) || []
    $('addRemind').value = days.join(',')
    const doneBox = $('addDone').querySelector('input')
    $('addDone').hidden = ev.kind !== 'todo'
    doneBox.checked = ev.done === true
    $('addRemove').hidden = false
    $('addCancel').hidden = false
    $('editingTag').textContent = '正在改：' + ev.title
    $('editingTag').hidden = false
    $('addTitle').focus()
  }
  const resetAdd = () => {
    editing = null
    $('addTitle').value = ''
    $('addTime').value = ''
    $('addRepeat').value = 'none'
    $('addRemind').value = ''
    $('addDone').hidden = true
    $('addRemove').hidden = true
    $('addCancel').hidden = true
    $('editingTag').hidden = true
    $('addDate').value = selected
  }

  // ---------------------------------------------------------------- 日记本
  async function loadDiary () {
    const q = $('dSearch').value.trim()
    const r = await api('calendar/diary?month=' + diaryMonth + (q ? '&query=' + encodeURIComponent(q) : '')).catch(() => null)
    if (!r || r.ok !== true) return
    const [y, m] = diaryMonth.split('-').map(Number)
    $('dMonTitle').textContent = y + ' 年 ' + m + ' 月'
    const list = $('diaryList')
    list.replaceChildren()
    if (!r.entries.length) {
      const li = document.createElement('li'); li.className = 'diary-empty'
      li.textContent = q ? '没找到。' : '这个月还没有日记。'
      list.appendChild(li)
      return
    }
    for (const e of r.entries) {
      const li = noteEl(e)
      li.tabIndex = 0
      li.addEventListener('click', (ev) => { if (!ev.target.closest('.del')) zoomNote(e) })
      li.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === li) { ev.preventDefault(); zoomNote(e) } })
      list.appendChild(li)
    }
    markLong()
  }
  // 正文超出便签高度的，底部渐隐；窗口宽窄一变列数就变，要重算
  const markLong = () => {
    for (const li of $('diaryList').querySelectorAll('.note')) {
      const p = li.querySelector('.note-text')
      li.classList.toggle('long', p.scrollHeight > p.clientHeight + 2)
    }
  }
  let longTimer = 0
  window.addEventListener('resize', () => { clearTimeout(longTimer); longTimer = setTimeout(markLong, 120) })

  function noteEl (e) {
    const li = document.createElement('li')
    li.className = 'note'
    // 按日记 id 固定轻微倾角，搜索和翻月后同一张纸卡的倾角一致。
    let hash = 2166136261
    for (const c of String(e.id)) hash = Math.imul(hash ^ c.codePointAt(0), 16777619)
    li.style.setProperty('--tilt', (((hash >>> 0) % 13 - 6) / 10).toFixed(1) + 'deg')
    const sheet = document.createElement('div'); sheet.className = 'paper'
    fillNote(sheet, e, true)
    li.appendChild(sheet)
    return li
  }

  function fillNote (box, e, compact = false) {
    const head = document.createElement('div'); head.className = 'note-head'
    const t = document.createElement('time')
    t.dateTime = e.at
    const day = document.createElement('span'); day.textContent = compact ? e.date.slice(5).replace('-', '.') : fmtDay(e.date)
    const clock = document.createElement('span'); clock.textContent = e.at.slice(11, 16)
    t.append(day, clock)
    head.appendChild(t)
    box.appendChild(head)

    const p = document.createElement('p'); p.className = 'note-text'; p.textContent = e.text
    box.appendChild(p)
    if (e.mood) {
      const mood = document.createElement('span'); mood.className = 'mood'
      const heart = document.createElement('span'); heart.className = 'mood-heart'; heart.textContent = '♥'
      heart.setAttribute('aria-hidden', 'true')
      mood.append(heart, e.mood)
      box.appendChild(mood)
    }

    const delBtn = document.createElement('button')
    delBtn.type = 'button'; delBtn.className = 'ghost del'; delBtn.setAttribute('aria-label', '删除这条日记')
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (!confirm('删掉这条日记？会先放进回收站。')) return
      del('calendar/diary/' + e.id).then((r2) => {
        if (r2.ok) { closeZoom(); loadDiary() } else toast(r2.message || '没删掉')
      }, () => toast('没删掉'))
    })
    box.appendChild(delBtn)
  }

  let zoomFrom = null
  function zoomNote (e) {
    const box = $('noteZoom')
    zoomFrom = document.activeElement
    const sheet = document.createElement('div'); sheet.className = 'note-sheet'
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true')
    sheet.setAttribute('aria-label', '日记全文'); sheet.tabIndex = -1
    const close = document.createElement('button')
    close.type = 'button'; close.className = 'ghost close-note'; close.setAttribute('aria-label', '关闭日记')
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    close.addEventListener('click', closeZoom)
    sheet.appendChild(close)
    fillNote(sheet, e)
    box.replaceChildren(sheet)
    box.hidden = false
    sheet.focus()
  }
  function closeZoom () {
    const box = $('noteZoom')
    if (box.hidden) return
    box.hidden = true
    box.replaceChildren()
    if (zoomFrom && zoomFrom.isConnected) zoomFrom.focus()
    zoomFrom = null
  }
  $('noteZoom').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) closeZoom() })
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeZoom() })

  // ---------------------------------------------------------------- 日历源弹层
  async function openSources () {
    const r = await api('calendar/sources').catch(() => null)
    if (!r || r.ok !== true) { toast(r && r.message ? r.message : '日历包没开'); return }
    $('srcHoliday').checked = r.builtin.cnHoliday
    $('srcLunar').checked = r.builtin.lunar
    $('srcIntl').checked = r.builtin.intl
    $('srcAlmanac').checked = r.builtin.almanac
    $('holidayYears').textContent = r.holidayYears.length ? '已有 ' + r.holidayYears.join('、') : '还没有快照'
    const list = $('subList')
    list.replaceChildren()
    for (const s of r.subs) {
      const li = document.createElement('li')
      const sw = document.createElement('label'); sw.className = 'sw'
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.on !== false
      cb.addEventListener('change', () => saveSources({ subs: [{ id: s.id, on: cb.checked }] }))
      const i = document.createElement('i'); sw.append(cb, i)
      const name = document.createElement('span'); name.className = 'name'; name.textContent = s.name
      const dom = document.createElement('span'); dom.className = 'domain'; dom.textContent = s.domain
      const err = s.lastError ? document.createElement('span') : null
      if (err) { err.className = 'err'; err.title = s.lastError }
      const give = document.createElement('label'); give.className = 'give'
      const gv = document.createElement('input'); gv.type = 'checkbox'; gv.checked = s.aiVisible === true
      gv.addEventListener('change', () => saveSources({ subs: [{ id: s.id, aiVisible: gv.checked }] }))
      give.append(gv, document.createTextNode('给 AI 看'))
      const delSub = document.createElement('button'); delSub.className = 'del'; delSub.textContent = '删'
      delSub.addEventListener('click', () => saveSources({ subs: [{ id: s.id, remove: true }] }).then(() => openSources()))
      li.append(sw, name, dom, ...(err ? [err] : []), give, delSub)
      list.appendChild(li)
    }
    const c = r.diaryCadence || 'medium'
    for (const b of $('diaryCadence').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === c))
    $('speakFrom').value = r.speakFrom || '08:00'
    $('sourcesPop').hidden = false
  }

  const saveSources = async (patch) => {
    const r = await api('calendar/sources', patch)
    if (!r.ok) toast(r.message || '没保存上')
    return r
  }

  // ---------------------------------------------------------------- 事件绑定
  for (const b of $('pageTabs').querySelectorAll('.ptab')) {
    b.addEventListener('click', () => {
      page = b.dataset.page
      for (const x of $('pageTabs').querySelectorAll('.ptab')) x.classList.toggle('on', x === b)
      $('calPage').hidden = page !== 'cal'
      $('diaryPage').hidden = page !== 'diary'
      if (page === 'diary') loadDiary()
    })
  }
  $('gear').addEventListener('click', openSources)
  $('popClose').addEventListener('click', () => { $('sourcesPop').hidden = true })
  $('sourcesPop').addEventListener('click', (e) => { if (e.target === $('sourcesPop')) $('sourcesPop').hidden = true })
  for (const [id, key] of [['srcHoliday', 'cnHoliday'], ['srcLunar', 'lunar'], ['srcIntl', 'intl'], ['srcAlmanac', 'almanac']]) {
    $(id).addEventListener('change', (e) => saveSources({ builtin: { [key]: e.target.checked } }).then(loadMonth))
  }
  $('holidayUpdate').addEventListener('click', () => {
    const year = new Date().getFullYear() + (new Date().getMonth() >= 10 ? 1 : 0)
    api('calendar/sources/refresh', { year }).then((r) => { toast(r.ok ? '更新好了' : (r.message || '没更新上')); openSources() })
  })
  $('addSubForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const url = $('subUrl').value.trim()
    if (!url) return
    api('calendar/sources', { addSub: { name: $('subName').value.trim(), url } }).then((r) => {
      if (!r.ok) { toast(r.message || '没加上'); return }
      $('subName').value = ''; $('subUrl').value = ''
      toast('加上了，正在抓第一次'); openSources()
    })
  })
  for (const b of $('diaryCadence').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      fetch('../api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendar: { diary: b.dataset.v } }) })
        .then((r) => r.json()).then((r) => { if (r.ok) for (const x of $('diaryCadence').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)) })
    })
  }
  $('speakFrom').addEventListener('change', (e) => {
    fetch('../api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendar: { speakFrom: e.target.value } }) })
      .then((r) => r.json()).then((r) => { if (!r.ok) toast('没保存上') })
  })

  $('monPrev').addEventListener('click', () => { const [y, m] = viewMonth.split('-').map(Number); viewMonth = keyOf(new Date(y, m - 2, 1)).slice(0, 7); loadMonth() })
  $('monNext').addEventListener('click', () => { const [y, m] = viewMonth.split('-').map(Number); viewMonth = keyOf(new Date(y, m, 1)).slice(0, 7); loadMonth() })
  $('monToday').addEventListener('click', () => { viewMonth = todayKey().slice(0, 7); loadMonth() })
  $('dMonPrev').addEventListener('click', () => { const [y, m] = diaryMonth.split('-').map(Number); diaryMonth = keyOf(new Date(y, m - 2, 1)).slice(0, 7); loadDiary() })
  $('dMonNext').addEventListener('click', () => { const [y, m] = diaryMonth.split('-').map(Number); diaryMonth = keyOf(new Date(y, m, 1)).slice(0, 7); loadDiary() })
  let searchT = 0
  $('dSearch').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(loadDiary, 250) })

  $('addRow').addEventListener('submit', (e) => {
    e.preventDefault()
    const title = $('addTitle').value.trim()
    if (!title) { $('addTitle').focus(); return }
    const date = $('addDate').value || selected
    const remind = $('addRemind').value
    const payload = {
      title, date, time: $('addTime').value || '', repeat: $('addRepeat').value,
      kind: editing ? editing.kind : 'event',
      done: editing ? $('addDone').querySelector('input').checked : false,
      remind: remind ? { daysBefore: remind.split(',').map(Number) } : { daysBefore: [] },
      ...(editing ? { id: editing.id } : {}),
    }
    api('calendar/events', payload).then((r) => {
      if (!r.ok) { toast(r.message || '没记上'); return }
      resetAdd()
      loadMonth()
    })
  })
  $('addRemove').addEventListener('click', () => {
    if (!editing) return
    api('calendar/events', { id: editing.id, remove: true }).then((r) => { if (r.ok) { resetAdd(); loadMonth() } else toast(r.message || '没删掉') })
  })
  $('addCancel').addEventListener('click', resetAdd)

  // 桌宠名字：记的日程标签显示「<名字>记的」，跟着当前角色走
fetch('../api/state').then((r) => r.json()).then((s) => {
  const chars = s.characters || []
  const cur = (s.settings && s.settings.character) || ''
  const hit = chars.find((c) => c.id === cur)
  petLabel = (s.settings && s.settings.partnerName) || (hit && hit.name) || '桌宠'
  renderDay()
}).catch(() => {})

loadMonth()
})()
