/**
 * 「允许感知在做什么」 host side (settings.autonomy.aware, off by default).
 *
 * The pet (runtime/pixelpet/activity.py) appends one line per settled state change to
 * <dataDir>/activity-log.jsonl: {"t": ISO, "state": category, "app": process name, "dur": s}. No titles, ever.
 * Here we only read it back:
 *   - activityNote()   one sentence for the AI when the user messages the pet's session
 *                      「刚才大概在：打游戏（约 40 分钟），现在在干活」 — categories and durations only, no app names
 *   - todaySummary()   per-category minutes for today (pixelpet_status → activityToday)
 *   - recent()         last N rows for the settings page's log viewer
 *   - learn()          「认不准就学」: <dataDir>/activity.json {"learned": {"x.exe": "gaming"}}
 * Everything returns empty / null while the switch is off.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_FILE = 'activity-log.jsonl'
export const LEARN_FILE = 'activity.json'
export const STATES = ['gaming', 'gaming_break', 'video', 'work', 'meeting', 'browsing', 'other', 'away']
export const LEARNABLE = ['gaming', 'video', 'work', 'meeting', 'browsing']
export const LABELS = {
  gaming: '打游戏', gaming_break: '打游戏中途切出来', video: '看视频', work: '干活', meeting: '开会',
  browsing: '浏览', other: '在桌面上', away: '不在电脑前',
}
const NOW_PHRASE = { other: '现在在桌面上', away: '现在不在电脑前', gaming_break: '现在打游戏中途切出来了' }
const MAX_BYTES = 4 * 1024 * 1024
const NOTE_LOOKBACK_MS = 3 * 3600_000
const STALE_MS = 12 * 3600_000

export const awareOn = (settings) => !!(settings && settings.autonomy && settings.autonomy.enabled !== false && settings.autonomy.aware === true)

/** -> [{t: ms, state, app}] oldest first; junk lines skipped */
export function readLog (dataDir) {
  let text = ''
  try {
    text = readFileSync(join(dataDir, LOG_FILE), 'utf8')
    if (text.length > MAX_BYTES) text = text.slice(-MAX_BYTES)
  } catch { return [] }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const t = Date.parse(j.t)
      if (!Number.isFinite(t) || !STATES.includes(j.state)) continue
      rows.push({ t, state: j.state, app: typeof j.app === 'string' ? j.app.slice(0, 64) : '' })
    } catch {}
  }
  rows.sort((a, b) => a.t - b.t)
  return rows
}

/** consecutive rows -> segments {state, app, start, end}; the last one runs until `now` */
export function segments (rows, now) {
  return rows.map((r, i) => ({ state: r.state, app: r.app, start: r.t, end: Math.max(r.t, i + 1 < rows.length ? rows[i + 1].t : now) }))
}

const mins = (ms) => Math.max(1, Math.round(ms / 60_000))
const dur = (ms) => {
  const m = mins(ms)
  if (m < 60) return '约 ' + m + ' 分钟'
  const h = Math.floor(m / 60); const r = m % 60
  return '约 ' + h + ' 小时' + (r >= 10 ? ' ' + r + ' 分钟' : '')
}

/** one sentence: what came just before (≥ 2 min, within 3 h) and what is going on now. Categories only. */
export function noteFrom (rows, now = Date.now()) {
  if (!rows.length) return ''
  const segs = segments(rows, now)
  const cur = segs[segs.length - 1]
  if (now - cur.start > STALE_MS) return ''
  const nowText = (NOW_PHRASE[cur.state] || ('现在在' + (LABELS[cur.state] || cur.state)))
  let prev = null
  for (let i = segs.length - 2; i >= 0; i--) {
    const s = segs[i]
    if (s.end < now - NOTE_LOOKBACK_MS) break
    if (s.state === cur.state || s.end - s.start < 120_000) continue
    prev = s; break
  }
  if (!prev) return nowText + '（' + dur(now - cur.start) + '）'
  return '刚才大概在：' + (LABELS[prev.state] || prev.state) + '（' + dur(prev.end - prev.start) + '），' + nowText
}

/** today's minutes per category (local day), plus switch count; categories + process names only */
export function summarizeDay (rows, now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0)
  const from = d.getTime()
  const by = {}
  const apps = {}
  for (const s of segments(rows, now)) {
    const a = Math.max(s.start, from); const b = Math.min(s.end, now)
    if (b <= a) continue
    by[s.state] = (by[s.state] || 0) + (b - a)
    if (s.app && s.state !== 'away') apps[s.app] = (apps[s.app] || 0) + (b - a)
  }
  const minutes = Object.fromEntries(Object.entries(by).sort((x, y) => y[1] - x[1]).map(([k, v]) => [LABELS[k] || k, Math.round(v / 60_000)]))
  const topApps = Object.entries(apps).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => ({ app: k, minutes: Math.round(v / 60_000) }))
  return { date: new Date(from).toISOString().slice(0, 10), minutes, topApps, now: noteFrom(rows, now) }
}

export function readLearned (dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, LEARN_FILE), 'utf8'))
    const l = j && typeof j.learned === 'object' && !Array.isArray(j.learned) ? j.learned : {}
    return Object.fromEntries(Object.entries(l).filter(([k, v]) => typeof k === 'string' && LEARNABLE.includes(v)))
  } catch { return {} }
}

const PROC = /^[^\\/:*?"<>|\u0000-\u001f]{1,64}$/
/** state '' / null forgets the correction. -> learned table, or null on bad input */
export function learn (dataDir, proc, state) {
  const p = typeof proc === 'string' ? proc.trim().toLowerCase() : ''
  if (!PROC.test(p) || (state && !LEARNABLE.includes(state))) return null
  const l = readLearned(dataDir)
  if (state) l[p] = state; else delete l[p]
  const keys = Object.keys(l)
  for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete l[k]
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, LEARN_FILE)
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify({ learned: l }, null, 1), 'utf8')
  renameSync(tmp, file)
  return l
}

/**
 * @param {{ dataDir: string, settings: () => any, now?: () => number }} o
 */
export function createAwareness ({ dataDir, settings, now = Date.now }) {
  const on = () => { try { return awareOn(settings()) } catch { return false } }
  return {
    on,
    note: () => (on() ? noteFrom(readLog(dataDir), now()) : ''),
    today: () => (on() ? summarizeDay(readLog(dataDir), now()) : null),
    recent: (n = 60) => (on() ? readLog(dataDir).slice(-n).reverse().map((r) => ({ t: new Date(r.t).toISOString(), state: r.state, label: LABELS[r.state], app: r.app })) : []),
    learned: () => readLearned(dataDir),
    learn: (p, s) => learn(dataDir, p, s),
  }
}

/** the trailing block a relayed message gets; '' = nothing to add */
export const renderNote = (note) => (note ? '（桌宠观察，只含活动类别和时长）' + note : '')
