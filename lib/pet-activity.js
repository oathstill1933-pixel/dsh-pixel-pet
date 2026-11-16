/**
 * 「活动与额度」页签 v2 —— 监测桌宠自己（2026-11-15 改版；上一版画的是用户活动，已下线）。
 *
 * 两个日志，都只记类别 / 计数 / 时长 / 结果，绝不记对话原文、歌词、文档内容、窗口标题、本地路径、key：
 *
 *   <dataDir>/pet-activity.jsonl（宿主侧写，本模块；30 天滚动，写时整枝，每小时至多一次）
 *     { t, kind: 'turn',  source: hub|mail|reading|music|care|other, ok, ms, tokens?: { input, output } }
 *       —— relay.js 的 ask / job 结束（完成或失败）时经 hooks.onTurn 写入；usage 来自
 *          DSH session 事件 assistant/message 的 usage 字段（turn/end 不带），拿不到就省略，不估算
 *     { t, kind: 'tool',  name, ok }          —— syncTools 注册处统一包裹 execute
 *     { t, kind: 'say',   speak, chars }      —— 宿主下发 say 命令时（出声 / 气泡）
 *     { t, kind: 'care',  trigger, decision } —— 主动关心每次叫醒（lib/proactive.js 的判定结果）
 *     { t, kind: 'follow', changed }          —— 跟随外部桥会话时有效会话变了（lib/host.js 的 onChange）
 *
 *   <dataDir>/pet-state.jsonl（Python 运行时写，去抖 10 s 的桌宠状态行 { t, state }）
 *     本模块只读：聚合 288 个 5 分钟格的状态带；没被任何状态行覆盖的格 = offline（桌宠没在运行）。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayBounds } from './activity-day.js'

export const PET_ACTIVITY_FILE = 'pet-activity.jsonl'
export const PET_STATE_FILE = 'pet-state.jsonl'
export const KEEP_DAYS = 30
export const SLOT_COUNT = 288

export const SOURCES = ['hub', 'mail', 'reading', 'music', 'care', 'calendar', 'other']
export const PET_STATES = ['idle', 'walk', 'speaking', 'thinking', 'working', 'inside', 'hidden', 'offline']
export const PET_STATE_LABELS = {
  idle: '待机', walk: '走动', speaking: '说话', thinking: '思考', working: '工作中',
  inside: '在家具里', hidden: '隐藏', offline: '没在运行',
}

const pad = (n) => String(n).padStart(2, '0')
const isoLocal = (t = Date.now()) => {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
}

/** 事件行白名单化：只留已知字段，数值化，绝不透传未知内容 */
function sanitizeEvent (kind, fields = {}) {
  const e = { kind }
  if (kind === 'turn') {
    e.source = SOURCES.includes(fields.source) ? fields.source : 'other'
    e.ok = fields.ok === true
    e.ms = Number.isFinite(fields.ms) ? Math.max(0, Math.round(fields.ms)) : 0
    if (fields.tokens && Number.isFinite(fields.tokens.input) && Number.isFinite(fields.tokens.output) &&
        (fields.tokens.input > 0 || fields.tokens.output > 0)) {
      e.tokens = { input: Math.round(fields.tokens.input), output: Math.round(fields.tokens.output) }
    }
  } else if (kind === 'tool') {
    if (typeof fields.name !== 'string' || !fields.name.trim()) return null
    e.name = fields.name.trim().slice(0, 60)
    e.ok = fields.ok === true
  } else if (kind === 'say') {
    e.speak = fields.speak === true
    e.chars = Number.isFinite(fields.chars) ? Math.max(0, Math.round(fields.chars)) : 0
  } else if (kind === 'care') {
    if (!SOURCES.includes('care') || typeof fields.trigger !== 'string' || !fields.trigger.trim()) return null
    e.trigger = fields.trigger.trim().slice(0, 24)
    e.decision = ['spoke', 'silent', 'error'].includes(fields.decision) ? fields.decision : 'error'
  } else if (kind === 'follow') {
    // 跟随外部桥会话：只记「有效会话变了」这件事本身，不记会话 id、不记 peer、不记来源名
    e.changed = fields.changed === true
  } else {
    return null // state 由 Python 运行时写 pet-state.jsonl，不走这里；其它 kind 一律不收
  }
  return e
}

/**
 * 宿主侧事件写入器。
 * @param {{ dataDir: string, now?: () => number }} o
 */
export function createPetActivity ({ dataDir, now = Date.now }) {
  const file = join(dataDir, PET_ACTIVITY_FILE)
  let prunedAt = 0
  const prune = (t) => {
    if (t - prunedAt < 3600_000) return
    prunedAt = t
    try {
      const cutoff = t - KEEP_DAYS * 86_400_000
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).t) >= cutoff } catch { return true } })
      if (keep.length !== lines.length) {
        const tmp = file + '.' + process.pid + '.tmp'
        writeFileSync(tmp, keep.map((l) => l + '\n').join(''), 'utf8')
        renameSync(tmp, file)
      }
    } catch {}
  }
  /** -> bool（写没写成）；坏事件（未知 kind / 空 name）静默丢弃 */
  const record = (kind, fields) => {
    const e = sanitizeEvent(kind, fields)
    if (!e) return false
    try {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(file, JSON.stringify({ t: isoLocal(now()), ...e }) + '\n', 'utf8')
      prune(now())
      return true
    } catch { return false }
  }
  return { record }
}

/** 状态行 [{t, state, hb?}] -> 288 个 {i, state}。状态只延续到「下一行」与「本行 + 6 分钟」中较早者，
 *  超出算 offline（有心跳的行每 5 分钟续一次）；最后一段同样封顶 min(now, t + 6 分钟)。offline 行本身
 *  也是一行（桌宠 quit 时写），格内取占多数的状态。 */
export function stateSlots (rows, from, to, now = Date.now()) {
  const SLOT_MS = 5 * 60_000
  const ROW_TTL_MS = 6 * 60_000
  const valid = (rows || []).filter((r) => Number.isFinite(r.t) && PET_STATES.includes(r.state))
    .sort((a, b) => a.t - b.t)
  const acc = new Array(SLOT_COUNT)
  const fill = (a, b, state) => {
    if (b <= a || !state) return
    let s = a
    let i = Math.floor((s - from) / SLOT_MS)
    while (s < b && i >= 0 && i < SLOT_COUNT) {
      const slotEnd = from + (i + 1) * SLOT_MS
      const take = Math.min(b, slotEnd) - s
      if (take > 0) {
        const per = acc[i] || (acc[i] = new Map())
        per.set(state, (per.get(state) || 0) + take)
      }
      s = Math.min(b, slotEnd)
      i++
    }
  }
  let cursor = from
  for (let i = 0; i < valid.length; i++) {
    const r = valid[i]
    const start = Math.max(r.t, from)
    if (start > cursor) fill(cursor, start, 'offline') // 上一行 TTL 到期 / 从未运行 → 没在运行
    const next = i + 1 < valid.length ? valid[i + 1].t : Math.max(r.t, now)
    const end = Math.min(to, next, r.t + ROW_TTL_MS)
    if (end > start) fill(start, end, r.state)
    cursor = Math.max(cursor, end)
    if (cursor >= to) break
  }
  if (cursor < to) fill(cursor, to, 'offline')
  const out = new Array(SLOT_COUNT)
  for (let i = 0; i < SLOT_COUNT; i++) {
    const per = acc[i]
    if (!per) { out[i] = { i, state: 'offline' }; continue }
    let best = 'offline'; let bestMs = -1
    for (const [state, ms] of per) {
      if (ms > bestMs) { bestMs = ms; best = state }
    }
    out[i] = { i, state: best }
  }
  return out
}

/**
 * 按本地日聚合两个日志。
 * -> { slots, counts: {turn, say, tool, care}, bySource, tools: [{name, ok, fail}], tokens: {total, bySource}|null,
 *     care: {spoke, silent, error} }；date 非法回 null（host 400）。
 */
export function petDay (dataDir, date, now = Date.now()) {
  const b = dayBounds(date)
  if (!b) return null
  const readLines = (file) => {
    let text = ''
    try { text = readFileSync(join(dataDir, file), 'utf8') } catch { return [] }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const ms = Date.parse(j.t)
        if (!Number.isFinite(ms)) continue
        rows.push({ ...j, ms })
      } catch {}
    }
    return rows
  }
  const events = readLines(PET_ACTIVITY_FILE).filter((e) => e.ms >= b.from && e.ms < b.to && e.kind)
  const stateRows = readLines(PET_STATE_FILE).map((r) => ({ t: r.ms, state: r.state }))

  const counts = { turn: 0, speak: 0, bubble: 0, tool: 0, care: 0 }
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]))
  const toolMap = new Map()
  const care = { spoke: 0, silent: 0, error: 0 }
  let tokensTotal = 0
  const tokensBySource = {}
  let tokensSeen = false
  for (const e of events) {
    if (e.kind === 'turn') {
      counts.turn++
      bySource[SOURCES.includes(e.source) ? e.source : 'other']++
      if (e.tokens && Number.isFinite(e.tokens.input) && Number.isFinite(e.tokens.output)) {
        tokensSeen = true
        const sum = e.tokens.input + e.tokens.output
        tokensTotal += sum
        const src = SOURCES.includes(e.source) ? e.source : 'other'
        tokensBySource[src] = (tokensBySource[src] || 0) + sum
      }
    } else if (e.kind === 'say') {
      if (e.speak === true) counts.speak++; else counts.bubble++
    } else if (e.kind === 'tool') {
      const k = typeof e.name === 'string' ? e.name.slice(0, 60) : ''
      if (!k) continue
      counts.tool++
      const m = toolMap.get(k) || { name: k, ok: 0, fail: 0 }
      if (e.ok === true) m.ok++; else m.fail++
      toolMap.set(k, m)
    } else if (e.kind === 'care') {
      counts.care++
      if (e.decision === 'spoke' || e.decision === 'silent' || e.decision === 'error') care[e.decision]++
    }
  }
  return {
    slots: stateSlots(stateRows, b.from, b.to, now),
    counts, bySource,
    tools: [...toolMap.values()].sort((a, b2) => (b2.ok + b2.fail) - (a.ok + a.fail)),
    tokens: tokensSeen ? { total: tokensTotal, bySource: tokensBySource } : null,
    care,
  }
}
