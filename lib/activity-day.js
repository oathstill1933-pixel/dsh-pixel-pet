/**
 * 「活动与额度」页签 · 活动侧（2026-11-15 需求 04）。
 *
 * 读 <dataDir>/activity-log.jsonl —— 和 lib/awareness.js 同一份日志、同一套口径：
 * 只记类别 + 进程名 + 分钟数，永远没有窗口标题 / 文件名 / 内容。这里只读，不采集、不落盘。
 *
 * GET /api/insight/activity?date=YYYY-MM-DD（host.js 调）：
 *   slots    i = 0..287（0 = 00:00–00:05，5 分钟一格）；格内取占比最高的 (state, app)，
 *            minutes 为该类在该格内的分钟数（≤5）；没有活动的格 state = ''
 *   summary  [{state, minutes, label}] 按分钟数降序（< 1 分钟的丢掉）
 *   switches 当天状态切换次数（= 当天日志行数）
 */
import { segments, readLog, LABELS } from './awareness.js'

export const SLOT_COUNT = 288
export const SLOT_MS = 5 * 60_000

const pad = (n) => String(n).padStart(2, '0')
/** 本地日 'YYYY-MM-DD'（与 proactive.js dayKeyOf 同式，这里独立一份免拉依赖） */
export const todayKey = (t = Date.now()) => {
  const d = new Date(t)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 'YYYY-MM-DD' -> 本地当日 [from, from + 24h)；格式错 / 不是真实日历日 -> null */
export function dayBounds (date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7)); const d = Number(date.slice(8, 10))
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  return { from: dt.getTime(), to: dt.getTime() + 86_400_000 }
}

/** 覆盖 [from, to) 的段：整份日志建段再裁剪（跨日的段也能裁进来，前一天的尾巴算今天的头）。
 * 最后一段只延伸到 now（今天的色带不画未来）；查过去的日子且日志被截断时，最后一段会铺到当天结束。 */
export function daySegments (rows, from, to, now = Date.now()) {
  return segments((rows || []).slice().sort((a, b) => a.t - b.t), now)
    .map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.end > s.start)
}

/** -> 288 个 {i, state, app, minutes}；格内取占比最高的 (state, app) */
export function slotify (rows, from, to, now = Date.now()) {
  const acc = new Array(SLOT_COUNT)
  for (const seg of daySegments(rows, from, to, now)) {
    let s = seg.start
    let i = Math.floor((s - from) / SLOT_MS)
    while (s < seg.end && i >= 0 && i < SLOT_COUNT) {
      const slotEnd = from + (i + 1) * SLOT_MS
      const take = Math.min(seg.end, slotEnd) - s
      if (take > 0) {
        const per = acc[i] || (acc[i] = new Map())
        const key = seg.state + '\u0000' + (seg.app || '')
        per.set(key, (per.get(key) || 0) + take)
      }
      s = Math.min(seg.end, slotEnd)
      i++
    }
  }
  const out = new Array(SLOT_COUNT)
  for (let i = 0; i < SLOT_COUNT; i++) {
    const per = acc[i]
    if (!per) { out[i] = { i, state: '', app: '', minutes: 0 }; continue }
    let best = null; let bestMs = 0
    for (const [key, ms] of per) {
      if (ms > bestMs) { bestMs = ms; best = key }
    }
    const [state, app] = best.split('\u0000')
    out[i] = { i, state, app, minutes: Math.min(5, Math.round(bestMs / 60_000)) }
  }
  return out
}

/** -> [{state, minutes, label}] 降序；不足 1 分钟的不出现 */
export function summarize (rows, from, to, now = Date.now()) {
  const by = new Map()
  for (const seg of daySegments(rows, from, to, now)) {
    by.set(seg.state, (by.get(seg.state) || 0) + (seg.end - seg.start))
  }
  return [...by.entries()]
    .map(([state, ms]) => ({ state, minutes: Math.round(ms / 60_000), label: LABELS[state] || state }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
}

/** 当天状态切换次数（= 当天的日志行数） */
export const switchesOf = (rows, from, to) =>
  (rows || []).filter((r) => r.t >= from && r.t < to).length
