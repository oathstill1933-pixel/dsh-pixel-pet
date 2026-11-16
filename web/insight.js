// 「活动与额度」页签 v2（2026-11-15 改版）：监测桌宠自己——状态带 / 余额曲线 / 今日桌宠做了什么。
// 数据只读自 /api/insight/pet 与 /api/insight/quota；纯 SVG，不引任何图表库；页面不触发采样。
// 用户自己的活动记录不在这里（只在「AI 行为」页签的感知日志里）。颜色类（ps-* / st-*）定义在 insight.css。
(() => {
  const $ = (id) => document.getElementById(id)
  const api = (p) => fetch('api/' + p).then((r) => r.json())
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const pad = (n) => String(n).padStart(2, '0')
  const STATE_LABELS = { idle: '待机', walk: '走动', speaking: '说话', thinking: '思考', working: '工作中', inside: '在家具里', hidden: '隐藏', offline: '没在运行' }
  const SOURCE_LABELS = { hub: '输入条', mail: '信箱', reading: '看书', music: '听歌', care: '主动关心', calendar: '提醒', other: '其它' }

  const svgEl = (name, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, name)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    return n
  }
  const money = (v) => '¥' + (Math.round(v * 100) / 100).toFixed(2)
  const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
  const shiftDay = (key, days) => {
    const d = new Date(key + 'T00:00:00')
    d.setDate(d.getDate() + days)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }
  const fmtDay = (key) => {
    const d = new Date(key + 'T00:00:00')
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 周' + '日一二三四五六'.charAt(d.getDay())
  }
  const hhmm = (i) => pad(Math.floor(i / 12)) + ':' + pad((i % 12) * 5)

  let date = todayKey()
  let data = null // { pet, quota }

  // ---------------------------------------------------------------- 桌宠状态带
  function renderBand () {
    const band = $('petBand')
    const empty = $('petBandEmpty')
    const p = data && data.pet
    band.replaceChildren()
    band.setAttribute('viewBox', '0 0 288 16') // 288 格铺满整个宽度（preserveAspectRatio=none 拉伸）
    if (!p || !p.slots.some((s) => s.state !== 'offline')) {
      band.hidden = true; empty.hidden = false
      empty.textContent = '这天没有桌宠状态记录（桌宠没在运行，或那时还没有这个记录）'
      return
    }
    band.hidden = false; empty.hidden = true
    const frag = document.createDocumentFragment()
    for (const s of p.slots) {
      const rect = svgEl('rect', { x: s.i, y: 0, width: 1.06, height: 16, class: 'ps-' + s.state })
      const t = svgEl('title')
      t.textContent = hhmm(s.i) + ' · ' + (STATE_LABELS[s.state] || s.state)
      rect.appendChild(t)
      frag.appendChild(rect)
    }
    band.appendChild(frag)
  }

  // ---------------------------------------------------------------- 余额曲线（整个账户）
  function renderQuota () {
    const svg = $('insightQuota')
    const empty = $('insightQuotaEmpty')
    const foot = $('insightSpent')
    const q = data && data.quota
    svg.replaceChildren(); foot.textContent = ''
    const W = Math.max(320, svg.clientWidth || 0)
    const H = 190
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
    if (!q || !q.points.length) {
      svg.hidden = true; empty.hidden = false
      empty.textContent = q && q.configured === false
        ? '没配 DeepSeek 余额 Key，不会记录额度（在「额度感知」页签里配）'
        : '这天还没有额度记录'
      return
    }
    svg.hidden = false; empty.hidden = true
    const P = { l: 52, r: 14, t: 12, b: 22 }
    const xOf = (ms) => {
      const d = new Date(ms)
      const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
      return P.l + (mins / 1440) * (W - P.l - P.r)
    }
    const ys = q.points.map((p) => p.balance)
    let lo = Math.min(...ys); let hi = Math.max(...ys)
    if (hi - lo < 0.5) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5 }
    const span = hi - lo
    lo -= span * 0.08; hi += span * 0.08
    const yOf = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b)
    const frag = document.createDocumentFragment()
    for (const f of [0, 0.5, 1]) {
      const v = lo + (hi - lo) * f
      const y = yOf(v)
      frag.appendChild(svgEl('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid' }))
      const t = svgEl('text', { x: P.l - 6, y: y + 3.5, 'text-anchor': 'end', class: 'axis' })
      t.textContent = money(v)
      frag.appendChild(t)
    }
    for (const h of [0, 6, 12, 18, 24]) {
      const x = P.l + (h / 24) * (W - P.l - P.r)
      const t = svgEl('text', { x, y: H - 6, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', class: 'axis' })
      t.textContent = pad(h) + ':00'
      frag.appendChild(t)
      frag.appendChild(svgEl('line', { x1: x, x2: x, y1: H - P.b, y2: H - P.b + 3, class: 'grid' }))
    }
    frag.appendChild(svgEl('polyline', {
      points: q.points.map((p) => xOf(Date.parse(p.t)) + ',' + yOf(p.balance)).join(' '), class: 'line',
    }))
    for (const p of q.points) {
      const dot = svgEl('circle', { cx: xOf(Date.parse(p.t)), cy: yOf(p.balance), r: 2.6, class: 'dot' })
      const d = new Date(Date.parse(p.t))
      const t = svgEl('title')
      t.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + money(p.balance)
      dot.appendChild(t)
      frag.appendChild(dot)
    }
    svg.appendChild(frag)
    // 这是整个账户的消耗：同一个 key 可能还有别的会话在用，不是桌宠一家花的
    if (q.spent != null) foot.textContent = q.spent >= 0 ? '账户今日消耗 ' + money(q.spent) : '账户今日余额净增 ' + money(-q.spent)
  }

  // ---------------------------------------------------------------- 今日桌宠做了什么
  function renderStats () {
    const box = $('insightStats')
    const empty = $('statsEmpty')
    box.replaceChildren()
    const p = data && data.pet
    const c = p && p.counts
    // 主动关心：说了 x / 没说 y（error 只进悬停）
    const care = p && p.care ? p.care : { spoke: 0, silent: 0, error: 0 }
    const careText = '说了 ' + (care.spoke || 0) + ' / 没说 ' + (care.silent || 0) + (care.error ? ' / 失败 ' + care.error : '')
    // 按来源细分（只列非零，其它放最后）
    const by = (p && p.bySource) || {}
    const parts = []
    for (const k of ['hub', 'mail', 'reading', 'music', 'care', 'calendar']) {
      if (by[k]) parts.push((SOURCE_LABELS[k] || k) + ' ' + by[k])
    }
    if (by.other) parts.push('其它 ' + by.other)
    // token（有才显示）：来源细分进悬停
    const tk = p && p.tokens
    const toolTip = ((p && p.tools) || []).map((x) => x.name + ' ' + (x.ok + x.fail) + (x.fail ? '（失败 ' + x.fail + '）' : '')).join('、')
    const rows = [
      { n: c ? c.turn : 0, label: '模型请求', sub: parts.join(' · ') },
      ...(tk ? [{ n: tk.total, label: 'token', title: Object.entries(tk.bySource || {}).map(([k, v]) => (SOURCE_LABELS[k] || k) + ' ' + v).join('、') }] : []),
      { n: c ? c.speak : 0, label: '出声', sub: c && c.bubble ? '气泡 ' + c.bubble : '' },
      { n: c ? c.tool : 0, label: '工具调用', title: toolTip },
      { n: c ? c.care : 0, label: '主动关心', sub: careText },
    ]
    for (const r of rows) {
      if (!r.n) continue
      const d = document.createElement('div')
      d.className = 'insight-stat'
      const b = document.createElement('b')
      b.textContent = String(r.n)
      const s = document.createElement('span')
      s.textContent = r.label
      d.append(b, s)
      if (r.sub) {
        const sub = document.createElement('span')
        sub.className = 'sub'
        sub.textContent = r.sub
        d.appendChild(sub)
      }
      if (r.title) d.title = r.title
      box.appendChild(d)
    }
    if (box.children.length === 0) {
      box.hidden = true
      empty.hidden = false
      empty.textContent = '这天桌宠没有活动记录'
    } else {
      box.hidden = false
      empty.hidden = true
    }
  }

  const renderAll = () => { renderBand(); renderQuota(); renderStats() }

  // ---------------------------------------------------------------- 取数 / 页签（按 id 定位，不写死序号）
  const load = async () => {
    try {
      const [pet, quota] = await Promise.all([api('insight/pet?date=' + date), api('insight/quota?date=' + date)])
      if (!pet || pet.ok !== true || !quota || quota.ok !== true) return
      data = { pet, quota }
      renderAll()
    } catch {}
  }
  const go = (key) => {
    if (key > todayKey()) return
    date = key
    syncNav()
    load()
  }
  const syncNav = () => {
    $('insightDate').textContent = fmtDay(date)
    $('insightNext').disabled = date >= todayKey()
    $('insightToday').hidden = date === todayKey()
  }

  $('insightPrev').addEventListener('click', () => go(shiftDay(date, -1)))
  $('insightNext').addEventListener('click', () => go(shiftDay(date, 1)))
  $('insightToday').addEventListener('click', () => go(todayKey()))

  const pane = $('paneInsight')
  // 页签刚打开时才有真实宽度：切换进来重画一次（隐藏时画过的是按估宽画的）
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tab === 'insight') setTimeout(() => { if (data) renderAll() }, 0)
  }))
  let resizeT = 0
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (pane && pane.classList.contains('on')) renderAll() }, 200) })
  // 今天 + 页签开着：每分钟跟一次最新数据
  setInterval(() => {
    if (window.__pixelpetPurged || document.hidden || !pane || !pane.classList.contains("on") || date !== todayKey()) return
    load()
  }, 60_000)

  syncNav()
  load()
})()
