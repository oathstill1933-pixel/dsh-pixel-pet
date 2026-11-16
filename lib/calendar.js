/**
 * 「日历与日记」——第三个拓展包。
 *
 * 照「一起看书」的接线：settings.calendar.enabled 开着才有 API（否则 409）和 AI 工具（when 不占 token）。
 *
 * 数据（<dataDir> 下，原子写）：calendar/events.json、calendar/sources.json、calendar/cache/*、
 *   calendar/reminded.json、diary/YYYY-MM.jsonl、diary/.trash/、diary/state.json。
 *
 * 对外：
 *   handle(req, res, { path, url, send, readBody })   /api/calendar/* 路由（包关着 409）
 *   tools()                                            4 个 pixelpet_* 工具（when 收口）
 *   decorate(sessionId, content)                       日记捎带提示（复用活动感知的机制，不另发请求）
 *   onTurn({ source, ok })                             聊天轮计数（hub/mail/reading/music 且成功）
 *   nearLine()                                         提示词「近日」行（按日期缓存，一天最多变一次）
 *   wakeContext()                                      { reminders, specialDay } 给 proactive 当由头
 *   markReminded(...) / markSpecialDay(date)           叫醒成功后由宿主回调销账
 *   start() / stop()                                   订阅 6 小时刷新 + holiday 每周自动补（11 月至次年 1 月）
 *
 * 隐私：日志只记类别与计数；订阅链接可能带私密 token，界面对外只给域名。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as LUNAR from './calendar-lunar.js'
import { INTL_NAMES, intlFestivals } from './calendar-intl.js'
import { createHoliday } from './calendar-holiday.js'
import { createIcs, normalizeUrl } from './calendar-ics.js'
import { createEvents, dayKey, dayMs, addDays, weekdayOf, sanitizeEvent, KINDS, REPEATS, MAX_ITEMS } from './calendar-events.js'
import { createDiary } from './calendar-diary.js'
import { PAGES } from './open-window.js'

export const CALENDAR_DEFAULT = Object.freeze({ enabled: false, diary: 'medium', speakFrom: '08:00' })
export const DIARY_CADENCE = Object.freeze({ off: 0, few: 40, medium: 20, much: 10 })
const SUB_REFRESH_MS = 6 * 3600_000
const WEEK_MS = 7 * 24 * 3600_000
const pad2 = (n) => String(n).padStart(2, '0')
const weekdayCn = '日一二三四五六'

const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n)
const domainOf = (url) => { try { return new URL(url).hostname } catch { return '' } }

export function sanitizeCalendar (cur, patch) {
  const c = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const out = { ...CALENDAR_DEFAULT, ...c }
  if ('enabled' in p) out.enabled = p.enabled === true
  if ('diary' in p && p.diary in DIARY_CADENCE) out.diary = p.diary
  if ('speakFrom' in p) {
    const v = String(p.speakFrom || '')
    out.speakFrom = /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : CALENDAR_DEFAULT.speakFrom
  }
  return out
}

/**
 * @param {{ dataDir: string, settings: () => any, sendCommand?: Function, openWindow?: Function,
 *          fetchImpl?: Function, now?: () => number, logger?: object, vendorRoot?: string }} o
 */
export function createCalendar ({ dataDir, settings, sendCommand = null, openWindow = null, originBase = '', fetchImpl = globalThis.fetch, now = Date.now, logger = null, vendorRoot = null }) {
  const sourcesFile = dataDir ? join(dataDir, 'calendar', 'sources.json') : null

  const events = createEvents({ dataDir, now, lunar: LUNAR })
  const diary = createDiary({ dataDir, now })
  const holiday = createHoliday({ dataDir, fetchImpl, now, ...(vendorRoot ? { vendorRoot } : {}) })
  const ics = createIcs({ dataDir, fetchImpl, now })

  const on = () => { try { return settings().calendar?.enabled === true } catch { return false } }
  const cfg = () => {
    try { return sanitizeCalendar(settings().calendar, {}) } catch { return CALENDAR_DEFAULT }
  }

  // ---------------------------------------------------------------- 日历源
  const readSources = () => {
    try {
      const o = sourcesFile ? JSON.parse(readFileSync(sourcesFile, 'utf8')) : null
      const b = o && typeof o.builtin === 'object' && o.builtin ? o.builtin : {}
      return {
        builtin: { cnHoliday: b.cnHoliday === true, lunar: b.lunar === true, almanac: b.almanac === true, intl: b.intl === true },
        subs: Array.isArray(o.subs) ? o.subs.filter((s) => s && typeof s.id === 'string' && typeof s.url === 'string') : [],
      }
    } catch {
      // 默认：法定节假日 + 农历 + 国际节日开，黄历与订阅关
      return { builtin: { cnHoliday: true, lunar: true, almanac: false, intl: true }, subs: [] }
    }
  }
  const writeSources = (o) => {
    try {
      mkdirSync(dirname(sourcesFile), { recursive: true })
      const tmp = sourcesFile + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(o, null, 1), 'utf8')
      renameSync(tmp, sourcesFile)
      return true
    } catch { return false }
  }

  /** 对外视图：订阅只给域名 + 状态，绝不出完整链接（可能带私密 token） */
  const sourcesView = () => {
    const s = readSources()
    return {
      builtin: s.builtin,
      subs: s.subs.map((x) => ({ id: x.id, name: cleanText(x.name, 30), domain: domainOf(x.url), aiVisible: x.aiVisible === true, lastOk: x.lastOk || '', lastError: x.lastError || '', on: x.on !== false })),
      holidayYears: holiday.years(),
    }
  }

  const saveSources = (patch = {}) => {
    const s = readSources()
    if (patch.builtin && typeof patch.builtin === 'object') {
      for (const k of ['cnHoliday', 'lunar', 'almanac', 'intl']) {
        if (typeof patch.builtin[k] === 'boolean') s.builtin[k] = patch.builtin[k]
      }
    }
    if (Array.isArray(patch.subs)) {
      s.subs = s.subs.filter((x) => !patch.subs.some((p) => p && p.id === x.id && p.remove === true))
      for (const p of patch.subs) {
        if (!p || typeof p.id !== 'string') continue
        const cur = s.subs.find((x) => x.id === p.id)
        if (!cur) continue
        if (typeof p.name === 'string') cur.name = cleanText(p.name, 30)
        if (typeof p.on === 'boolean') cur.on = p.on
        if (typeof p.aiVisible === 'boolean') cur.aiVisible = p.aiVisible
      }
    }
    if (patch.addSub && typeof patch.addSub === 'object') {
      const url = normalizeUrl(patch.addSub.url)
      if (!url) return { ok: false, message: '订阅链接只收 https（webcal:// 会自动转）' }
      if (s.subs.length >= 20) return { ok: false, message: '订阅源最多 20 个' }
      s.subs.push({ id: 'sub-' + randomUUID().slice(0, 8), name: cleanText(patch.addSub.name, 30) || domainOf(url), url, aiVisible: false, on: true, lastOk: '', lastError: '' })
    }
    writeSources(s)
    return { ok: true, sources: sourcesView() }
  }

  /** 刷新订阅：全部 / 指定一个。单飞（定时与手动不叠跑）；抓完重读 sources 再只改 lastOk/lastError，
   *  用户在抓取期间改的开关 / 删除不会被覆盖；被删掉的源直接跳过 */
  let subRefreshing = null
  const refreshSubs = async (subId = null) => {
    if (subRefreshing) return subRefreshing // 单飞
    subRefreshing = (async () => {
      const s0 = readSources()
      const targets = s0.subs.filter((x) => x.on !== false && (!subId || x.id === subId))
      let okCount = 0
      const results = new Map()
      for (const sub of targets) {
        const r = await ics.fetchSub(sub.id, sub.url)
        results.set(sub.id, r)
        if (r.ok) okCount++
      }
      // 抓完重读：只把 lastOk / lastError 写回还活着的源
      const s1 = readSources()
      for (const sub of s1.subs) {
        if (!results.has(sub.id)) continue
        const r = results.get(sub.id)
        if (r.ok) { sub.lastOk = new Date(now()).toISOString(); sub.lastError = '' } else { sub.lastError = String(r.message || '').slice(0, 120) }
      }
      writeSources(s1)
      return { ok: okCount > 0 || targets.length === 0, count: okCount, total: targets.length }
    })()
    try { return await subRefreshing } finally { subRefreshing = null }
  }

  // ---------------------------------------------------------------- 天信息（农历 / 节假日 / 节日）
  const sources = () => readSources()

  /** 当天信息：农历、节气、宜忌（开关）、法定节假日、传统/国际节日 */
  const dayInfo = (date) => {
    const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7)); const d = Number(date.slice(8, 10))
    const s = sources()
    const info = { date, weekday: weekdayOf(date), lunarLine: null, lunarDay: '', term: '', festivals: [], holiday: null, almanac: null }
    if (s.builtin.lunar) {
      info.lunarLine = LUNAR.lunarLine(y, m, d)
      info.lunarDay = LUNAR.lunarDayLabel(y, m, d)
      info.term = LUNAR.solarTerm(y, m, d)
    }
    if (s.builtin.lunar) info.festivals.push(...LUNAR.lunarFestivals(y, m, d))
    if (s.builtin.intl) info.festivals.push(...intlFestivals(y, m, d))
    if (s.builtin.cnHoliday) info.holiday = holiday.lookup(date)
    if (s.builtin.almanac) info.almanac = LUNAR.almanacOf(y, m, d)
    return info
  }

  /** 法定节假日「首日」（前一天不是同名休日） */
  const holidayFirstDays = (date) => {
    const s = sources()
    if (!s.builtin.cnHoliday) return []
    const data = holiday.yearData(Number(date.slice(0, 4)))
    if (!data) return []
    const off = Object.entries(data.days).filter(([, v]) => v.isOff).map(([md, v]) => ({ date: date.slice(0, 5) + md, name: v.name }))
    return off.filter((x) => x.date === date && !off.some((o) => o.name === x.name && o.date === addDays(x.date, -1))).map((x) => x.name)
  }

  /** 当天的特别日子（special_day / nearLine 共用）：aiVisible 过滤由调用方传 */
  const specialDaysOf = (date, { aiVisibleOnly = true } = {}) => {
    const names = []
    const s = sources()
    const push = (n) => { if (n && !names.includes(n)) names.push(n) }
    for (const ev of events.listIn(date, addDays(date, 1), (e) => (aiVisibleOnly ? e.aiVisible !== false : true))) {
      if (['birthday', 'anniversary', 'festival'].includes(ev.kind)) push(ev.title)
    }
    const info = dayInfo(date)
    if (s.builtin.cnHoliday) for (const n of holidayFirstDays(date)) push(n + '（法定节假日）')
    for (const n of info.festivals) push(n)
    return names
  }

  // ---------------------------------------------------------------- 提醒到期 + 主动由头
  /** proactive 的由头：{ reminders, specialDay }。specialDay 的「每天一次」由宿主 markSpecialDay 销账。 */
  const wakeContext = () => {
    if (!on()) return { reminders: [], specialDay: null }
    const today = dayKey(now())
    const marks = events.readMarks()
    const reminders = events.dueReminders(now())
    const specialNames = specialDaysOf(today)
    const specialDay = specialNames.length && !marks['special:' + today] ? { date: today, names: specialNames } : null
    return { reminders, specialDay }
  }
  const markReminded = (id, date, daysBefore) => { try { events.markReminded(id, date, daysBefore) } catch {} }
  const markSpecialDay = (date) => {
    try {
      const f = dataDir ? join(dataDir, 'calendar', 'reminded.json') : null
      if (!f) return
      const j = (() => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return { v: 1, marks: {} } } })()
      j.marks = j.marks || {}
      j.marks['special:' + date] = dayKey(now())
      mkdirSync(dirname(f), { recursive: true })
      const tmp = f + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify({ v: 1, marks: j.marks }, null, 1), 'utf8')
      renameSync(tmp, f)
    } catch {}
  }

  // ---------------------------------------------------------------- nearLine（按日期缓存，一天最多变一次）
  let nearCache = { day: '', line: '' }
  const nearLine = () => {
    if (!on()) return ''
    const today = dayKey(now())
    if (nearCache.day === today) return nearCache.line
    const parts = []
    const s = sources()
    const todaySpecials = specialDaysOf(today).slice(0, 3)
    if (todaySpecials.length) parts.push('今天 ' + todaySpecials.join('、'))
    const seen = new Set(todaySpecials)
    const from = addDays(today, 1)
    for (const ev of events.listIn(from, addDays(today, 4), (e) => e.aiVisible !== false)) {
      if (parts.length >= 5) break
      if (['birthday', 'anniversary', 'festival', 'event', 'todo'].includes(ev.kind) && !seen.has(ev.title)) {
        parts.push(ev.date.slice(5) + '（周' + weekdayCn[weekdayOf(ev.date)] + '）' + ev.title)
        seen.add(ev.title)
      }
    }
    // 窗口里的农历 / 国际节日（不是事件的那些）
    if (parts.length < 5) {
      for (let dd = 1; dd <= 3 && parts.length < 5; dd++) {
        const date = addDays(today, dd)
        const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7)); const day = Number(date.slice(8, 10))
        const names = [...(s.builtin.lunar ? LUNAR.lunarFestivals(y, m, day) : []), ...(s.builtin.intl ? intlFestivals(y, m, day) : [])]
        for (const n of names) {
          if (parts.length >= 5) break
          if (!seen.has(n)) { parts.push(date.slice(5) + '（周' + weekdayCn[weekdayOf(date)] + '）' + n); seen.add(n) }
        }
      }
    }
    const line = parts.length ? '近日：' + parts.join('；') + '。' : ''
    nearCache = { day: today, line }
    return line
  }

  // ---------------------------------------------------------------- 日记捎带（decorate）
  const DIARY_HINT = '（聊了一阵了：想记的话，顺手用 pixelpet_diary_write 用第一人称记两三句今天的心情和发生的事；不想记就算了，回复里不用提这件事。）'
  const decorate = (sessionId, d) => {
    const c = cfg()
    if (!on() || c.diary === 'off' || !diary.needsHint(DIARY_CADENCE[c.diary] || 20)) return null
    const parts = Array.isArray(d?.content) ? d.content : []
    const text = parts.map((x) => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('')
    // 不附到桌宠自己发起的叫醒消息上（提醒 / 醒来看看）
    if (text.startsWith('[桌宠·')) return null
    return {
      content: [...parts, { type: 'text', text: DIARY_HINT }],
      // 消息真发出去以后才归零；发送失败不归零，下一轮再捎带
      commit () { try { d.commit() } catch {} diary.markedHint() },
    }
  }

  // ---------------------------------------------------------------- 聊天轮计数
  const onTurn = ({ source, ok } = {}) => {
    if (!on()) return
    if (!ok || !['hub', 'mail', 'reading', 'music'].includes(source)) return
    const c = cfg()
    if (c.diary === 'off') return
    diary.bumpTurns()
  }

  // ---------------------------------------------------------------- HTTP 路由
  const httpJson = (req, res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)) }
  const validDate = (v) => {
    const s = String(v || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(dayMs(s))) return null
    return dayKey(dayMs(s)) === s ? s : null // 回历校验（2026-02-30 这类不存在的日子拒绝）
  }

  /** 事件列表（含节假日 / 农历节日等源，aiVisible 过滤），≤ 60 条 */
  const gatherWindow = (fromDay, toDay, { aiVisibleOnly = false, query = '' } = {}) => {
    const s = sources()
    const out = []
    const seen = new Set()
    const push = (x) => {
      if (out.length >= 60) return
      const k = x.title + '|' + x.date + '|' + (x.time || '')
      if (seen.has(k)) return
      if (query && !x.title.toLowerCase().includes(query.toLowerCase())) return
      seen.add(k); out.push(x)
    }
    for (const ev of events.listIn(fromDay, toDay, (e) => (aiVisibleOnly ? e.aiVisible !== false : true))) {
      push({ id: ev.id, title: ev.title, kind: ev.kind, date: ev.date, time: ev.time || '', repeat: ev.repeat || 'none', note: ev.note || '', by: ev.by || 'user', aiVisible: ev.aiVisible !== false, done: ev.done === true, lunarNote: ev.lunar ? '农历' + (ev.lunar.leap ? '闰' : '') + ev.lunar.month + '月' + LUNAR.lunarDayLabel(Number(ev.date.slice(0, 4)), ev.lunar.month, Math.min(ev.lunar.day, 30)).replace(/^\d+月/, '') : '' })
    }
    for (let d = fromDay; d < toDay && out.length < 60; d = addDays(d, 1)) {
      const info = dayInfo(d)
      if (s.builtin.cnHoliday && info.holiday) push({ title: info.holiday.name + (info.holiday.isOff ? '（休）' : '（班）'), kind: 'festival', date: d, time: '', by: 'builtin' })
      for (const n of info.festivals) push({ title: n, kind: 'festival', date: d, time: '', by: 'builtin' })
    }
    // 订阅日程：界面（aiVisibleOnly=false）无论开关都显示；AI（aiVisibleOnly=true）只要开了「给 AI 看」的源
    for (const sub of s.subs) {
      if (sub.on === false) continue
      if (aiVisibleOnly && sub.aiVisible !== true) continue
      const cache = ics.readCache(sub.id)
      for (const ev of (cache && Array.isArray(cache.events) ? cache.events : [])) {
        if (ev.date >= fromDay && ev.date < toDay) push({ title: ev.title, kind: 'event', date: ev.date, time: ev.time || '', by: 'sub', aiVisible: sub.aiVisible === true, subName: sub.name })
      }
    }
    return out.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00'))).slice(0, 60)
  }

  /** -> true（已应答）；包关着时 409。originBase = 'http://host/dsh-pixel-pet'（打开日历窗用） */
  const handle = async (req, res, { path, url, send, readBody, originBase = '' }) => {
    if (!path.startsWith('/api/calendar/')) return false
    const method = req.method
    const sub = path.slice('/api/calendar/'.length)
    try {
      if (!on()) return send(res, 409, { ok: false, message: '「日历与日记」拓展包没开。' })
      // ---- 日程
      if (sub === 'events' && method === 'GET') {
        const today = dayKey(now())
        const fromRaw = url.searchParams.get('from'); const toRaw = url.searchParams.get('to')
        const from = fromRaw ? (validDate(fromRaw) || null) : addDays(today, -31)
        const to = toRaw ? (validDate(toRaw) || null) : addDays(today, 60)
        if (!from || !to) return send(res, 400, { ok: false, message: '日期要是 YYYY-MM-DD' })
        if (dayMs(to) <= dayMs(from)) return send(res, 400, { ok: false, message: '日期区间不对' })
        const days = {}
        for (let d = from; d < to; d = addDays(d, 1)) { const info = dayInfo(d); days[d] = { lunarDay: info.lunarDay, lunarLine: info.lunarLine, term: info.term, festivals: info.festivals, holiday: info.holiday } }
        // 界面用：自建（带农历备注）+ 订阅日程都给（订阅不管「给 AI 看」开关），订阅条目标只读
        const own = events.listIn(from, to).map((ev) => ({ ...ev, lunarNote: ev.lunar ? '农历' + (ev.lunar.leap ? '闰' : '') + ev.lunar.month + '月' + LUNAR.lunarDayLabel(Number(ev.date.slice(0, 4)), ev.lunar.month, Math.min(ev.lunar.day, 30)).replace(/^\d+月/, '') : '' }))
        const subEvs = gatherWindow(from, to, { aiVisibleOnly: false }).filter((x) => x.by === 'sub' || x.by === 'builtin')
        const merged = [...own, ...subEvs.filter((s) => !own.some((o) => o.id === s.id))].sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')))
        return send(res, 200, { ok: true, events: merged, days, sources: sourcesView(), speakFrom: cfg().speakFrom, diaryCadence: cfg().diary })
      }
      if (sub === 'events' && method === 'POST') {
        const body = await readBody(req, 16 * 1024).then((b) => { try { return JSON.parse(b.toString('utf8') || '{}') } catch { return {} } })
        const items = events.read()
        if (body.remove === true && typeof body.id === 'string') {
          const left = items.filter((x) => x.id !== body.id)
          if (left.length === items.length) return send(res, 404, { ok: false, message: '没有这条' })
          events.write(left)
          return send(res, 200, { ok: true })
        }
        const cur = items.find((x) => x.id === body.id) || null
        const clean = sanitizeEvent(body, cur || {})
        clean.title = cleanText(clean.title ?? cur?.title ?? '', 60) // 改日程只给部分字段时沿用原标题
        if (!clean.title) return send(res, 400, { ok: false, message: '要写个标题' })
        if (!clean.date) return send(res, 400, { ok: false, message: '日期要是 YYYY-MM-DD' })
        clean.by = 'user'
        clean.aiVisible = clean.aiVisible !== false
        clean.createdAt = clean.createdAt || new Date(now()).toISOString()
        clean.updatedAt = new Date(now()).toISOString()
        if (!cur) events.createDefaults(clean, 'remind' in body) // 新建补默认 repeat/remind；改已有条目不动没给的字段
        if (typeof body.id === 'string' && body.id) {
          const i = items.findIndex((x) => x.id === body.id)
          if (i < 0) return send(res, 404, { ok: false, message: '没有这条' })
          items[i] = { ...items[i], ...clean, id: body.id, by: items[i].by }
          events.write(items)
          return send(res, 200, { ok: true, event: items[i] })
        }
        if (items.length >= MAX_ITEMS) return send(res, 409, { ok: false, message: '日程到上限了（2000 条），先删几条' })
        const ev = { id: 'ev-' + randomUUID().slice(0, 8), ...clean }
        items.push(ev)
        events.write(items)
        return send(res, 200, { ok: true, event: ev })
      }
      const mDel = sub.match(/^events\/([a-z0-9-]+)$/)
      if (mDel && method === 'DELETE') {
        const items = events.read()
        const left = items.filter((x) => x.id !== mDel[1])
        if (left.length === items.length) return send(res, 404, { ok: false, message: '没有这条' })
        events.write(left)
        return send(res, 200, { ok: true })
      }
      // ---- 单日信息
      if (sub === 'day' && method === 'GET') {
        const dv = url.searchParams.get('date')
        const date = dv ? validDate(dv) : dayKey(now())
        if (!date) return send(res, 400, { ok: false, message: 'date 要是 YYYY-MM-DD' })
        const info = dayInfo(date)
        return send(res, 200, { ok: true, ...info, events: events.listIn(date, addDays(date, 1)) })
      }
      // ---- 日历源
      if (sub === 'sources' && method === 'GET') return send(res, 200, { ok: true, ...sourcesView(), diaryCadence: cfg().diary, speakFrom: cfg().speakFrom })
      if (sub === 'sources' && method === 'POST') {
        const body = await readBody(req, 8 * 1024).then((b) => { try { return JSON.parse(b.toString('utf8') || '{}') } catch { return {} } })
        const r = saveSources(body)
        return send(res, r.ok ? 200 : 400, { ok: r.ok, ...(r.ok ? { sources: r.sources } : { message: r.message }) })
      }
      if (sub === 'sources/refresh' && method === 'POST') {
        const body = await readBody(req, 8 * 1024).then((b) => { try { return JSON.parse(b.toString('utf8') || '{}') } catch { return {} } })
        if (Number.isInteger(body.year)) {
          // 只接受「今年 - 1」到「今年 + 1」，其余 400（防乱刷别的年份）
          const y = new Date(now()).getFullYear()
          if (body.year < y - 1 || body.year > y + 1) return send(res, 400, { ok: false, message: '年份只接受 ' + (y - 1) + ' 到 ' + (y + 1) })
          const ok = await holiday.refresh(body.year)
          return send(res, ok ? 200 : 502, { ok, holidayYears: holiday.years(), message: ok ? '' : '抓取失败，等国务院发布后再试' })
        }
        const r = await refreshSubs(body.subId && typeof body.subId === 'string' ? body.subId : null)
        return send(res, 200, { ok: r.ok, ...r, sources: sourcesView() })
      }
      // ---- 日记
      if (sub === 'diary' && method === 'GET') {
        const month = url.searchParams.get('month')
        if (month && !/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { ok: false, message: 'month 要是 YYYY-MM' })
        const entries = diary.list({ month, query: url.searchParams.get('query') || '', limit: url.searchParams.get('limit') || 100 })
        return send(res, 200, { ok: true, entries })
      }
      const mDiary = sub.match(/^diary\/([a-z0-9-]+)$/)
      if (mDiary && method === 'DELETE') {
        const r = diary.remove(mDiary[1])
        return send(res, r.ok ? 200 : 404, { ...r })
      }
      if (sub === 'open' && method === 'POST') {
        const ok = openWindow && originBase ? !!openWindow(originBase + '/calendar/', PAGES.calendar) /* open-window.js 收 [宽, 高] 数组 */ : false
        return send(res, 200, { ok, message: ok ? '' : '打不开日历窗' })
      }
      return send(res, 404, { ok: false, message: '不认识的日历接口' })
    } catch (e) {
      logger?.warn?.('[dsh-pixel-pet] calendar ' + String((e && e.message) || e).slice(0, 160))
      return send(res, 500, { ok: false, message: '日历出错' })
    }
  }

  // ---------------------------------------------------------------- AI 工具（4 个）
  const windowOf = ({ from, to } = {}) => {
    const today = dayKey(now())
    let f = validDate(from) || today
    let t = validDate(to) || addDays(today, 14)
    if (dayMs(t) < dayMs(f)) { const x = f; f = t; t = x }
    if (dayMs(t) - dayMs(f) > 92 * 86_400_000) t = addDays(f, 92)
    return { f, t }
  }
  const whenOn = (s) => !!(s && s.calendar && s.calendar.enabled === true)
  // DSH 的 tools.register 要求每个工具声明 output { schema, render }，缺了直接 TypeError，
  // 宿主只记一行 warn——4 个日历工具因此从没真正注册上（测试用的假 tools 服务不查这个）。
  // 返回值再过一遍 JSON：DSH 拒收带 undefined 的结果（not lossless JSON）。
  const output = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: !v || typeof v !== 'object' ? String(v) : v.data === undefined ? String(v.message) : String(v.message) + '\n' + JSON.stringify(v.data, null, 2) }],
  }
  const lossless = (r) => JSON.parse(JSON.stringify(r === undefined ? null : r))
  const tools = () => rawTools().map((t) => ({ ...t, output, execute: async (args, exec) => lossless(await t.execute(args, exec)) }))
  const rawTools = () => [
    {
      name: 'pixelpet_calendar_list',
      when: whenOn,
      description: '看日历 / 台历 / 日程表：一段时间里的日程、生日、纪念日、节假日、农历节日（含用户给 AI 看的订阅日程）。桌面上那个台历家具里的内容就从这里读。query 按标题找；day 给单日时附农历 / 节气 / 宜忌。',
      parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD，缺省今天' }, to: { type: 'string', description: 'YYYY-MM-DD，缺省 14 天后，跨度最多 92 天' }, query: { type: 'string', description: '按标题过滤' }, day: { type: 'string', description: 'YYYY-MM-DD：附这一天的农历 / 节气 / 宜忌' } }, additionalProperties: false },
      async execute (args) {
        const a = args && typeof args === 'object' ? args : {}
        const { f, t } = windowOf(a)
        const items = gatherWindow(f, t, { aiVisibleOnly: true, query: cleanText(a.query, 30) })
        const out = { ok: true, message: items.length ? '共 ' + items.length + ' 条。' : '这段时间没有安排。', data: { items } }
        const day = validDate(a.day)
        if (day) {
          const info = dayInfo(day)
          out.data.day = { date: day, lunarLine: info.lunarLine, term: info.term, festivals: info.festivals, holiday: info.holiday, almanac: info.almanac }
        }
        return out
      },
    },
    {
      name: 'pixelpet_calendar_save',
      when: whenOn,
      description: '替用户记日子：生日 / 纪念日 / 要办的事，到点桌宠会提醒。只有用户让你记、或主动告诉你的才记；没提的私事别擅自记。生日可以问一句农历还是公历（lunar 填农历月日）。无 id 新建，有 id 修改，remove 删除。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '修改 / 删除时给' }, remove: { type: 'boolean', description: 'true = 删除' }, title: { type: 'string', description: '≤ 60 字' }, kind: { type: 'string', enum: KINDS, description: 'todo 待办 / birthday 生日 / anniversary 纪念日 / festival 节日 / event 事项' }, date: { type: 'string', description: 'YYYY-MM-DD 公历；农历时填最近的换算结果（只读）' }, time: { type: 'string', description: 'HH:MM，可空 = 全天' }, repeat: { type: 'string', enum: REPEATS, description: '重复' }, lunar: { type: 'object', properties: { month: { type: 'number', description: '农历月 1..12' }, day: { type: 'number', description: '农历日 1..30' }, leap: { type: 'boolean', description: '闰月' } }, description: '给了就按农历每年重复' }, remind: { type: 'object', properties: { daysBefore: { type: 'array', items: { type: 'number' }, description: '提前几天提醒，0 = 当天，最多 3 个（0..30）' } } }, note: { type: 'string', description: '≤ 200 字' }, done: { type: 'boolean', description: 'todo 完成' } }, additionalProperties: false },
      async execute (args) {
        const a = args && typeof args === 'object' ? args : {}
        const items = events.read()
        if (a.remove === true) {
          const id = typeof a.id === 'string' ? a.id : ''
          if (!id) return { ok: false, message: '删除要给 id' }
          const left = items.filter((x) => x.id !== id)
          if (left.length === items.length) return { ok: false, message: '没有这条日程' }
          events.write(left)
          return { ok: true, message: '删掉了。', data: { removed: id } }
        }
        const cur = typeof a.id === 'string' && a.id ? items.find((x) => x.id === a.id) : null
        const clean = sanitizeEvent(a, cur || {})
        clean.title = cleanText(clean.title ?? cur?.title ?? '', 60) // 只给部分字段（如 {id, done}）时沿用原标题
        if (!clean.title) return { ok: false, message: '要写个标题' }
        if (!clean.date) {
          if (clean.lunar) { const occ = LUNAR.lunarToSolar(Number(dayKey(now()).slice(0, 4)), clean.lunar.month, clean.lunar.day, clean.lunar.leap); if (occ) clean.date = occ }
          if (!clean.date) return { ok: false, message: '日期要是 YYYY-MM-DD' }
        }
        clean.by = 'pet'
        clean.aiVisible = clean.aiVisible !== false
        let created = false
        if (!cur) {
          events.createDefaults(clean, 'remind' in a) // 新建补默认 repeat / remind；改已有条目不动没给的字段
          created = true
        }
        if (cur) {
          const i = items.findIndex((x) => x.id === cur.id)
          items[i] = { ...cur, ...clean, id: cur.id, by: cur.by, createdAt: cur.createdAt, updatedAt: new Date(now()).toISOString() }
          events.write(items)
          return { ok: true, message: '改好了。', data: { event: items[i] } }
        }
        if (items.length >= MAX_ITEMS) return { ok: false, message: '日程到上限了（2000 条），先删几条' }
        const ev = { id: 'ev-' + randomUUID().slice(0, 8), ...clean, createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() }
        items.push(ev)
        events.write(items)
        // 回执按实际说：有提醒就说日子，没提醒就说（不提醒）
        const hasRemind = Array.isArray(ev.remind?.daysBefore) && ev.remind.daysBefore.length > 0
        const when = ev.date.slice(5) + (ev.time ? ' ' + ev.time : '')
        return { ok: true, message: hasRemind ? '记下了，' + when + ' 会提醒。' : '记下了（不提醒）。', data: { event: ev } }
      },
    },
    {
      name: 'pixelpet_diary_write',
      when: whenOn,
      description: '写自己的日记：用第一人称记两三句今天的心情和发生了什么，流水账也行。不写密码、账号、密钥、涉密工作内容。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '两三句，≤ 300 字' }, mood: { type: 'string', description: '心情，≤ 8 字' } }, required: ['text'], additionalProperties: false },
      async execute (args) {
        const a = args && typeof args === 'object' ? args : {}
        const r = diary.write({ text: a.text, mood: a.mood })
        return r.ok
          ? { ok: true, message: '记下了。', data: { at: r.entry.at } }
          : { ok: false, message: r.message }
      },
    },
    {
      name: 'pixelpet_diary_read',
      when: whenOn,
      description: '翻自己的日记，想起以前的事时用。',
      parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, query: { type: 'string', description: '按内容或心情找' }, limit: { type: 'number', description: '≤ 30' } }, additionalProperties: false },
      async execute (args) {
        const a = args && typeof args === 'object' ? args : {}
        const lim = Math.max(1, Math.min(30, Math.round(Number(a.limit) || 30)))
        let entries = diary.list({ query: a.query, limit: 200 })
        const from = validDate(a.from); const to = validDate(a.to)
        if (from) entries = entries.filter((x) => x.date >= from)
        if (to) entries = entries.filter((x) => x.date <= to)
        entries = entries.slice(0, lim)
        return { ok: true, message: entries.length ? '共 ' + entries.length + ' 条。' : '没有找到。', data: { entries } }
      },
    },
  ]

  // ---------------------------------------------------------------- 定时器：订阅 6 h 刷新 + holiday 每周自动补
  let timer = null
  let lastSubRefresh = 0
  let lastHolidayTry = 0
  const tickTimers = async () => {
    const t = now()
    const s = sources()
    if (t - lastSubRefresh >= SUB_REFRESH_MS) {
      lastSubRefresh = t
      if (s.subs.some((x) => x.on !== false)) { try { await refreshSubs() } catch {} }
    }
    const d = new Date(t)
    // 自动补：11 月到次年 1 月（1 月时国务院补的是「当年」的公告，别盯错年份）
    if (s.builtin.cnHoliday && (d.getMonth() >= 10 || d.getMonth() === 0) && t - lastHolidayTry >= WEEK_MS) {
      lastHolidayTry = t
      const target = d.getMonth() === 0 ? d.getFullYear() : d.getFullYear() + 1
      if (!holiday.yearData(target)) { try { await holiday.refresh(target) } catch {} }
    }
  }
  const start = () => {
    if (timer) return stop
    timer = setInterval(() => { tickTimers().catch(() => {}) }, 10 * 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    return stop
  }
  const stop = () => { if (timer) { clearInterval(timer); timer = null } }

  return {
    on, handle, decorate, onTurn, nearLine, wakeContext, markReminded, markSpecialDay,
    tools, start, stop, dayInfo, specialDaysOf, gatherWindow, events, diary, sources: sourcesView,
    refreshSubs, refreshHoliday: (y) => holiday.refresh(y),
  }
}
