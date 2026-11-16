/**
 * 日程存储 + 重复展开 + 提醒到期计算。
 *
 * `calendar/events.json`：{ v: 1, items: [...] }，上限 2000 条，原子写。
 * `calendar/reminded.json`：{ v: 1, marks: { '<id>:<date>:<daysBefore>': ' firedDay' } }，每条提醒只提醒一次。
 *
 * 重复规则：yearly / monthly / weekly / none；lunar 有则按农历每年重复：
 *   当年该月没有三十 → 廿九（钳到当月最后一天）；闰月生日在非闰年按正月份；
 *   monthly 的 31 号遇小月钳到当月最后一天（2 月按 28/29 提醒）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as LUNAR from './calendar-lunar.js'

export const KINDS = ['todo', 'birthday', 'anniversary', 'festival', 'event']
export const REPEATS = ['none', 'yearly', 'monthly', 'weekly']
export const MAX_ITEMS = 2000

const pad = (n) => String(n).padStart(2, '0')
export const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function dayMs (date) { const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))); return d.getTime() }
export const addDays = (date, n) => { const t = new Date(dayMs(date)); t.setDate(t.getDate() + n); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) }
export const weekdayOf = (date) => new Date(dayMs(date)).getDay()

/** 字段清洗；非法字段保留当前值 / 丢弃。by 由宿主强制，这里不管。 */
export function sanitizeEvent (patch, cur = {}) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = { ...cur }
  if ('title' in p) out.title = String(p.title == null ? '' : p.title).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)
  if ('kind' in p && KINDS.includes(p.kind)) out.kind = p.kind
  if ('date' in p && DATE_RE.test(String(p.date || '')) && dayKey(dayMs(p.date)) === String(p.date)) out.date = p.date
  if ('time' in p) out.time = p.time && TIME_RE.test(String(p.time)) ? p.time : ''
  if ('repeat' in p && REPEATS.includes(p.repeat)) out.repeat = p.repeat
  if ('lunar' in p) {
    const l = p.lunar && typeof p.lunar === 'object' ? p.lunar : null
    out.lunar = l && Number.isInteger(l.month) && l.month >= 1 && l.month <= 12 && Number.isInteger(l.day) && l.day >= 1 && l.day <= 30
      ? { month: l.month, day: l.day, leap: l.leap === true }
      : null
  }
  if ('remind' in p) {
    const r = p.remind && typeof p.remind === 'object' && Array.isArray(p.remind.daysBefore) ? p.remind.daysBefore : []
    out.remind = { daysBefore: [...new Set(r.map((n) => Math.round(Number(n))).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30))].sort((a, b) => a - b).slice(0, 3) }
  }
  if ('note' in p) out.note = String(p.note == null ? '' : p.note).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  if ('aiVisible' in p) out.aiVisible = p.aiVisible !== false
  if ('done' in p) out.done = p.done === true
  return out
}

export function createEvents ({ dataDir, now = Date.now, lunar = LUNAR }) {
  const file = dataDir ? join(dataDir, 'calendar', 'events.json') : null
  const remindedFile = dataDir ? join(dataDir, 'calendar', 'reminded.json') : null

  const readJson = (f, fallback) => {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      return j && typeof j === 'object' && !Array.isArray(j) ? j : fallback
    } catch { return fallback }
  }
  const writeJson = (f, obj) => {
    try {
      mkdirSync(dirname(f), { recursive: true })
      const tmp = f + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8')
      renameSync(tmp, f)
      return true
    } catch { return false }
  }

  /** 新建时的默认值：repeat（给了 lunar 或生日/纪念日 → yearly，否则 none）、remind（生日/纪念日 → [0,1]，否则 [0]）。
   *  hadRemind = 调用方确认 patch 里给了 remind（哪怕 daysBefore 为空 = 明确不提醒），此时不补默认。 */
  const createDefaults = (clean, hadRemind = false) => {
    const special = clean.kind === 'birthday' || clean.kind === 'anniversary'
    if (!REPEATS.includes(clean.repeat)) clean.repeat = (clean.lunar || special) ? 'yearly' : 'none'
    if (!hadRemind && (!Array.isArray(clean.remind?.daysBefore) || !clean.remind.daysBefore.length)) {
      clean.remind = { daysBefore: special ? [0, 1] : [0] }
    }
    return clean
  }

  const read = () => {
    const j = file ? readJson(file, { v: 1, items: [] }) : { v: 1, items: [] }
    const items = Array.isArray(j.items) ? j.items : []
    // 迁移：repeat 缺失的旧条目按新建规则补上并写回一次（防旧数据落进按月分支）
    let touched = false
    for (const ev of items) {
      if (!REPEATS.includes(ev.repeat)) {
        const special = ev.kind === 'birthday' || ev.kind === 'anniversary'
        ev.repeat = (ev.lunar || special) ? 'yearly' : 'none'
        touched = true
      }
    }
    if (touched && file) writeJson(file, { v: 1, items })
    return items
  }
  const write = (items) => (file ? writeJson(file, { v: 1, items }) : false)

  const readMarks = () => {
    const j = remindedFile ? readJson(remindedFile, { v: 1, marks: {} }) : { v: 1, marks: {} }
    return j.marks && typeof j.marks === 'object' && !Array.isArray(j.marks) ? j.marks : {}
  }
  const markFired = (key) => {
    const j = remindedFile ? readJson(remindedFile, { v: 1, marks: {} }) : { v: 1, marks: {} }
    j.marks = j.marks || {}
    j.marks[key] = dayKey(now())
    if (remindedFile) writeJson(remindedFile, { v: 1, marks: j.marks })
  }
  const firedKey = (id, date, daysBefore) => id + ':' + date + ':' + daysBefore

  /** 某个事件在 [fromDay, toDay)（'YYYY-MM-DD'）内的发生日期 */
  const occurrencesIn = (ev, fromDay, toDay) => {
    const out = []
    if (!ev || !DATE_RE.test(String(ev.date || ''))) return out
    // repeat 缺失 / 不认识一律按 none（防旧数据落进按月分支）
    const repeat = REPEATS.includes(ev.repeat) ? ev.repeat : 'none'
    const lunarMode = !!(ev.lunar && repeat === 'yearly')
    const fromMs = dayMs(fromDay); const toMs = dayMs(toDay)
    if (repeat === 'none') {
      if (dayMs(ev.date) >= fromMs && dayMs(ev.date) < toMs) out.push(ev.date)
      return out
    }
    if (lunarMode) {
      // 农历生日：窗口里每一年都按农历换算（12 月的窗口里也能查到次年 1 月的生日）
      const y0 = Number(fromDay.slice(0, 4)); const y1 = Number(toDay.slice(0, 4))
      for (let y = y0 - 1; y <= y1; y++) {
        const occ = lunar ? lunar.lunarToSolar(y, ev.lunar.month, ev.lunar.day, ev.lunar.leap) : null
        if (occ && dayMs(occ) >= fromMs && dayMs(occ) < toMs && !out.includes(occ)) out.push(occ)
      }
      return out
    }
    if (repeat === 'weekly') {
      const base = dayMs(ev.date)
      const step = 604_800_000
      let t = base + Math.ceil((fromMs - base) / step) * step
      if (t < base) t = base
      for (; t < toMs; t += step) if (t >= fromMs) out.push(dayKey(t))
      return out
    }
    // yearly / monthly：逐月逐格（钳到当月最后一天）
    const y0 = Number(fromDay.slice(0, 4)); const m0 = Number(fromDay.slice(5, 7))
    const y1 = Number(toDay.slice(0, 4)); const m1 = Number(toDay.slice(5, 7))
    const month = Number(ev.date.slice(5, 7))
    const dom = Number(ev.date.slice(8, 10))
    for (let y = y0; y <= y1; y++) {
      const mStart = y === y0 ? m0 : 1
      const mEnd = y === y1 ? m1 - 1 : 12
      for (let m = mStart; m <= mEnd; m++) {
        if (repeat === 'yearly' && m !== month) continue
        const last = new Date(y, m, 0).getDate()
        const dd = Math.min(dom, last) // 31 号遇小月 → 钳到当月最后一天
        const occ = key3(y, m, dd)
        if (dayMs(occ) >= fromMs && dayMs(occ) < toMs) out.push(occ)
      }
    }
    return out
  }
  const key3 = (y, m, d) => y + '-' + pad(m) + '-' + pad(d)

  /** 窗口内事项（带发生日期），按日期+时间排序。sourceFilter 可选（aiVisible 等） */
  const listIn = (fromDay, toDay, filter = null) => {
    const out = []
    for (const ev of read()) {
      if (filter && !filter(ev)) continue
      for (const occ of occurrencesIn(ev, fromDay, toDay)) {
        out.push({ ...ev, date: occ })
      }
    }
    return out.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')))
  }

  /**
   * 到期的提醒（now 起算）。-> [{ id, title, time, occurrenceDate, daysBefore, dueAt, missed }]
   * - time 且 daysBefore=0：到点就提醒（missed = 已经过了还没提）
   * - 其余（全天或提前 N 天）：到期日当天提；到期日已过还没提 = 错过（只回看 3 天）
   * - done 的 todo 不再提醒
   * - createdAt 有效时，创建之前的发生日不提醒（新建不追既往）
   */
  const dueReminders = (nowTs = now()) => {
    const today = dayKey(nowTs)
    const threeAgo = addDays(today, -3)
    const marks = readMarks()
    const out = []
    const seen = new Set()
    for (const ev of read()) {
      if (ev.kind === 'todo' && ev.done === true) continue
      const createdDay = DATE_RE.test(String(ev.createdAt || '').slice(0, 10)) ? String(ev.createdAt).slice(0, 10) : null
      for (const daysBefore of (Array.isArray(ev.remind?.daysBefore) ? ev.remind.daysBefore : [])) {
        // 发生日窗口放宽到今天 + 31 天：提前 N 天（最多 30）的提醒要看「明天/后天」的发生日
        for (const occ of occurrencesIn(ev, threeAgo, addDays(today, 31))) {
          if (createdDay && occ < createdDay) continue // 新建条目不提醒创建之前的发生日
          const remindDay = addDays(occ, -daysBefore)
          const markKey = firedKey(ev.id, occ, daysBefore)
          if (marks[markKey]) continue
          const timed = !!(ev.time && daysBefore === 0)
          const item = {
            id: ev.id, title: ev.title, time: ev.time || '', occurrenceDate: occ, daysBefore,
            dueAt: timed ? dayMs(occ) + Number(ev.time.slice(0, 2)) * 3600_000 + Number(ev.time.slice(3)) * 60_000 : dayMs(remindDay),
            missed: false,
          }
          if (timed) {
            if (nowTs < item.dueAt) continue // 还没到点
            item.missed = nowTs - item.dueAt > 60_000
          } else {
            if (dayMs(today) < dayMs(remindDay)) continue // 还没到提醒日
            item.missed = dayMs(remindDay) < dayMs(today) // 提醒日不是今天 = 错过
          }
          const dedup = ev.id + ':' + occ + ':' + daysBefore
          if (seen.has(dedup)) continue
          seen.add(dedup)
          out.push(item)
        }
      }
    }
    return out.sort((a, b) => a.dueAt - b.dueAt)
  }

  const markReminded = (id, date, daysBefore) => markFired(firedKey(id, date, daysBefore))

  return { read, write, listIn, occurrencesIn, dueReminders, markReminded, readMarks, createDefaults, MAX_ITEMS }
}
