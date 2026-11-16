/**
 * 「主动关心」（叫醒 + 让 AI 自己判断）— 2026-11-14 方案，2026-11-15 施工。
 *
 * 大肥鱼的做法：不是定时群发，而是「叫醒 + 判断」——程序隔一阵扫一遍，发现有由头就把桌宠绑定的
 * AI 会话叫醒，让它自己决定说不说；没由头就不叫。程序管硬闸（代码里，不花 token），AI 管软判断
 * （提示里，可以选择不说）。已有的「允许感知在做什么」（awareness / activity.py）是它的眼睛。
 *
 * tick（每 60 s，只读本地状态，不调模型）：
 *   硬闸全过 + 有由头 → 组装「醒来看看」包 → relay.ask 发给桌宠绑定会话（一次）
 *   回复是「不说」暗号 → 静默丢弃；否则 → 桌宠 say speak:true（出声 + 气泡）
 *   每次叫醒记一行 <dataDir>/proactive.jsonl：{t, trigger, decision: spoke|silent|error, chars}
 *   （留 14 天；不记 AI 原话、不记活动明细——调参只需要触发与决策）
 *   状态存 <dataDir>/proactive-state.json（上次叫醒、当天计数、熔断、没回不追、由头 key），重启恢复。
 *
 * 硬闸（任一不满足就不叫醒，按顺序判断，便宜的先判）：
 *   1 总开关    autonomy.care（默认关），依赖 autonomy.enabled + aware（没开感知就没有眼睛）+ aiControl + 已绑定会话
 *   2 熔断      余额缓存 is_available=false 或低于阈值 → 停；额度类错误（429/402/401/quota/rate limit/余额不足）
 *              → 30 min → 2 h → 当天不再叫醒（指数退避，成功一次复位）；连续 2 次任何中继失败也熔断 30 min。
 *              只读 balance.js 的磁盘缓存（balance.json），绝不为了闸 2 发请求；缓存过期=未知，不阻断
 *   3 会话忙    绑定会话有 turn 在跑，或 relay 有在途任务
 *   4 用户状态  away / 打游戏（含切出来）/ 会议 / 看视频 → 不叫醒
 *   5 安静时段  autonomy.quietHours，未配置时默认 23:30–07:00；由头是 late_work 且当天还没提过 → 例外
 *   6 没回不追  上一次开口后用户没有任何回应 → 不再叫醒，直到用户说话
 *   7 间隔配额  两次叫醒至少隔 minGapMin（careLevel 少/适中/多 = 90/45/25）；每天最多说 dailyMax 次（3/6/10）；
 *              叫醒了但 AI 选择不说也算一次叫醒，但只占间隔、不占每日「说话」配额
 *   8 单飞      同时只有一个叫醒在途（tick 串行）；状态落盘，宿主重启后恢复
 *   9 别的功能在用嘴  桌宠正在说话/听写（voice ∈ listening/hearing/thinking/speaking）、
 *              用户 5 min 内说过话（一起看书提问走 relay，被闸 3 盖住）→ 跳过
 *
 * 由头（evaluateTriggers）：long_work / late_work / back / long_play / quiet_long（优先级从高到低）。
 * 同一 tick 多个由头取优先级最高的一个；回合型（long_work / back / long_play）按「这一段的起点」记 key，
 * 当天型（late_work / quiet_long）按日期记 mark，当天触发过就不再触发。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { segments, readLog, summarizeDay } from './awareness.js'
import { DEFAULT_THRESHOLD, TTL_MS as BALANCE_TTL_MS } from './balance.js'
import { petMessageId } from './relay.js'

export const CARE_LEVELS = ['little', 'medium', 'much']
export const LEVELS = Object.freeze({
  little: Object.freeze({ minGapMin: 90, dailyMax: 3 }),
  medium: Object.freeze({ minGapMin: 45, dailyMax: 6 }),
  much: Object.freeze({ minGapMin: 25, dailyMax: 10 }),
})
/** quietHours 没配置时的深夜默认窗口（沿用 autonomy.quietHours 的格式） */
export const DEFAULT_QUIET = Object.freeze({ start: '23:30', end: '07:00' })
/** 由头优先级，从高到低 */
export const TRIGGER_ORDER = Object.freeze(['long_work', 'late_work', 'back', 'long_play', 'quiet_long'])

const TICK_MS = 60_000
const LONG_WORK_MS = 90 * 60_000       // long_work：连续干活 ≥ 90 min
const GAP_MS = 5 * 60_000              // 「离开」= 一段 ≥ 5 min 的别的事（away 也一样）
const BACK_AWAY_MS = 60 * 60_000       // back：离开 ≥ 60 min
const BACK_WAIT_MS = 2 * 60_000        // 回来后等 2 min 再判断，别一坐下就说
const BACK_FRESH_MS = 15 * 60_000      // 回来太久就不算「刚回来」了
const PLAY_MIN_MS = 2 * 3600_000       // long_play：连续玩 ≥ 2 h
const PLAY_FRESH_MS = 30 * 60_000      // 且是刚切出来（≤ 30 min）
const PLAY_STATES = ['gaming', 'gaming_break', 'video']
const QUIET_MS = 4 * 3600_000          // quiet_long：≥ 4 h 没说话
const OTHER_STABLE_MS = 10 * 60_000    // 且在桌面上待了一会儿（状态平稳）
const RECENT_CHAT_MS = 5 * 60_000      // 闸 9：刚和用户聊过
const BLOCK_NOW = ['away', 'gaming', 'gaming_break', 'video', 'meeting']   // 闸 4：此刻这些状态不叫
const BUSY_VOICE = ['listening', 'hearing', 'thinking', 'speaking']        // 闸 9：桌宠的嘴正忙
const QUOTA_RE = /\b(?:429|402|401)\b|quota|rate.?limit|余额不足|额度|insufficient|欠费|balance/i
const STATE_FILE = 'proactive-state.json'
const LOG_FILE = 'proactive.jsonl'
const LOG_KEEP_MS = 14 * 86_400_000
const TURN_STALE_MS = 35 * 60_000      // turn/end 丢了不至于永久卡死「会话忙」
const STALE_AWAY_MS = 30 * 60_000      // 活动日志最后一行超过 30 分钟就不认「此刻 away」
const SPOKEN_MAX = 80                  // 出声的话截到 80 字
const QUIET_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const pad = (n) => String(n).padStart(2, '0')
const durText = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return '约 ' + m + ' 分钟'
  const h = Math.floor(m / 60); const r = m % 60
  return '约 ' + h + ' 小时' + (r ? ' ' + r + ' 分钟' : '')
}
const hmOf = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
export const dayKeyOf = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
const minuteOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() }
const endOfDayMs = (t) => { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime() }
export const keyOf = (id) => { const s = String(id ?? '').trim(); return s.startsWith('session-') ? s.slice(8) : s }

const hhmmMin = (v) => (typeof v === 'string' && QUIET_HHMM.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null)
/** 跨午夜窗口（同 autonomy.py 的 in_window）；起止相同 = 关 */
export const inWindow = (minute, start, end) => {
  const s = hhmmMin(start); const e = hhmmMin(end)
  if (s == null || e == null || s === e) return false
  return s < e ? minute >= s && minute < e : minute >= s || minute < e
}

/** autonomy.quietHours 配了就用它的，没配用深夜默认窗口；-> {start,end} | null */
export const quietWindowOf = (autonomy) => {
  const q = autonomy && typeof autonomy === 'object' ? autonomy.quietHours : null
  const start = q && typeof q.start === 'string' ? q.start : ''
  const end = q && typeof q.end === 'string' ? q.end : ''
  if (hhmmMin(start) != null && hhmmMin(end) != null && start !== end) return { start, end }
  return { ...DEFAULT_QUIET }
}

/** 闸 1：主动关心完整开关（care + enabled + aware + aiControl + 已绑定会话） */
export const careOn = (settings) => {
  try {
    if (!settings || typeof settings !== 'object' || settings.aiControl === false) return false
    const a = settings.autonomy
    if (!a || typeof a !== 'object' || a.enabled === false || a.aware !== true || a.care !== true) return false
    const v = settings.voice
    return !!(v && v.llm && typeof v.llm.sessionId === 'string' && v.llm.sessionId.trim())
  } catch { return false }
}

export const levelOf = (settings) => {
  const l = settings && settings.autonomy && settings.autonomy.careLevel
  return LEVELS[l] ? l : 'medium'
}

/**
 * 「不说」暗号：恰好是【不说】（容忍首尾空白/标点、成对的框）。正文里出现【不说】也算——
 * AI 只被教过这一种说法，宁可少说不可追着说。
 */
export function isSilentReply (text) {
  const t = String(text ?? '').trim()
  if (!t) return true // 空回复 = 没话可说（可能只做了个动作）
  if (/【\s*不\s*说\s*】/.test(t) || /\[\s*不\s*说\s*\]/.test(t)) return true
  return t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '') === '不说'
}

const WRAPS = [/^「([\s\S]*)」$/, /^『([\s\S]*)』$/, /^【([\s\S]*)】$/, /^“([\s\S]*)”$/, /^‘([\s\S]*)’$/, /^"([\s\S]*)"$/, /^'([\s\S]*)'$/, /^《([\s\S]*)》$/, /^（([\s\S]*)）$/, /^\(([\s\S]*)\)$/]

/** 出声前清理：去掉多余引号（最多两层）、压平换行、截到 80 字。空串 = 不出声。 */
export function cleanSpoken (text) {
  let t = String(text ?? '').trim().replace(/\s*\n+\s*/g, ' ')
  for (let i = 0; i < 2; i++) {
    const m = WRAPS.find((w) => w.test(t))
    if (!m) break
    t = t.replace(m, '$1').trim()
  }
  return t.slice(0, SPOKEN_MAX)
}

/** 从 i 段往回走：collect 一段连续的 states，中间只容得下 < gapMs 的小过渡。-> 这一段的起点 */
function runStart (segs, i, states, gapMs = GAP_MS) {
  let start = segs[i].start
  for (let j = i - 1; j >= 0; j--) {
    const s = segs[j]
    if (states.includes(s.state)) { start = s.start; continue }
    if (s.end - s.start >= gapMs) break
  }
  return start
}

/**
 * 由头判定（纯函数）。segs 来自 awareness.segments(rows, now)；o = { now, userLastSpokeAt, dayKey, state }。
 * -> 按优先级排好的候选 [{ type, key?, spanMs?/awayMs?/quietMs? }]；当天/本回合已触发过的不再出。
 */
export function evaluateTriggers (segs, o = {}) {
  const out = []
  if (!Array.isArray(segs) || !segs.length) return out
  const t = o.now != null ? o.now : Date.now()
  const st = o.state && typeof o.state === 'object' ? o.state : {}
  const keys = st.keys && typeof st.keys === 'object' ? st.keys : {}
  const marks = st.marks && typeof st.marks === 'object' ? st.marks : {}
  const day = o.dayKey || dayKeyOf(t)
  const cur = segs[segs.length - 1]
  // long_work：连续干活 ≥ 90 min，中间没有 ≥ 5 min 的离开；冷却 = 下一次连续干活重新计时
  if (cur.state === 'work') {
    const start = runStart(segs, segs.length - 1, ['work'])
    const span = t - start
    if (span >= LONG_WORK_MS && keys.long_work !== start) out.push({ type: 'long_work', key: start, spanMs: span })
  }
  // late_work：23:30 后仍在干活（每天最多一次）
  if (cur.state === 'work' && inWindow(minuteOfDay(t), '23:30', '05:00') && marks.late_work !== day) {
    out.push({ type: 'late_work' })
  }
  // back：离开 ≥ 60 min 后回到电脑前，回来 2 min 后才算数、15 min 内才算「刚回来」；一次离开只提一次
  if (cur.state !== 'away') {
    for (let j = segs.length - 2; j >= 0; j--) {
      if (segs[j].state === 'away') {
        const awayMs = segs[j].end - segs[j].start
        const since = t - segs[j].end
        if (awayMs >= BACK_AWAY_MS && since >= BACK_WAIT_MS && since <= BACK_FRESH_MS && keys.back !== segs[j].start) {
          out.push({ type: 'back', key: segs[j].start, awayMs })
        }
        break // 只看最近一次离开
      }
    }
  }
  // long_play：连续玩 ≥ 2 h，且现在已经切出来（在游戏/视频里不打扰）
  if (!PLAY_STATES.includes(cur.state)) {
    for (let j = segs.length - 2; j >= 0; j--) {
      if (PLAY_STATES.includes(segs[j].state)) {
        const since = t - segs[j].end
        if (since <= PLAY_FRESH_MS) {
          const start = runStart(segs, j, PLAY_STATES)
          const span = segs[j].end - start
          if (span >= PLAY_MIN_MS && keys.long_play !== start) out.push({ type: 'long_play', key: start, spanMs: span })
        }
        break
      }
    }
  }
  // quiet_long：≥ 4 h 没说话 + 此刻在桌面上且状态平稳（最低优先级，每天最多一次）
  if (o.userLastSpokeAt && t - o.userLastSpokeAt >= QUIET_MS && cur.state === 'other' &&
      t - cur.start >= OTHER_STABLE_MS && marks.quiet_long !== day) {
    out.push({ type: 'quiet_long', quietMs: t - o.userLastSpokeAt })
  }
  return out.sort((a, b) => TRIGGER_ORDER.indexOf(a.type) - TRIGGER_ORDER.indexOf(b.type))
}

const TRIGGER_LINES = {
  long_work: (p) => '她已经连续干活' + durText(p.spanMs) + '，中间没离开过。',
  late_work: () => '已经过了 23:30，她还在干活。',
  back: (p) => '她离开了' + durText(p.awayMs) + '，刚刚回到电脑前。',
  long_play: (p) => '她连续打游戏/看视频' + durText(p.spanMs) + '，现在切出来了。',
  quiet_long: (p) => '她已经' + durText(p.quietMs) + '没和你说话了，现在在桌面上，看起来很平静。',
  special_day: (p) => '今天是' + (p.names || []).join('、') + '。',
}

/** 提醒条目的人类话术：今晚 19:30 / 明天 / 还剩 N 天 / 已经晚了 X 分钟 */
const remindItemLine = (it, t = Date.now()) => {
  const occ = it.occurrenceDate || ''
  const today = dayKeyOf(t)
  const when = it.time && occ === today ? '今天 ' + it.time
    : occ === addDayStr(today, 1) ? '明天' + (it.time ? ' ' + it.time : '')
    : occ.slice(5) + (it.time ? ' ' + it.time : '')
  const days = Math.round((dayMsOf(occ) - dayMsOf(today)) / 86_400_000)
  const late = it.missed && it.dueAt < t ? '，已经晚了' + durText(t - it.dueAt).replace('约 ', '') : ''
  return it.title + '（' + when + (days > 0 && !it.time ? '，还剩 ' + days + ' 天' : '') + late + '）'
}
const addDayStr = (date, n) => { const d = new Date(dayMsOf(date)); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
const dayMsOf = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime()

/** 提醒叫醒包：列出要提醒的事，让 AI 用自己的话说出来（没有【不说】出口——用户自己要求的） */
export function buildReminderText (items, t = Date.now()) {
  const lines = ['[桌宠·提醒] 现在 ' + hmOf(t) + '（周' + '日一二三四五六'.charAt(new Date(t).getDay()) + '）。用户之前托你提醒这几件事：']
  for (const it of (items || []).slice(0, 6)) lines.push('- ' + remindItemLine(it, t))
  lines.push('用你自己的话说出来（说完桌宠会念出来），语气平常点，别添戏、别再追问。')
  return lines.join('\n')
}

/** 今天的样子：类别 + 分钟（不含程序名），挑前三件 ≥ 5 分钟的事 */
export const todayLine = (minutes) => {
  if (!minutes || typeof minutes !== 'object') return ''
  const line = Object.entries(minutes)
    .filter(([k, v]) => k !== '在桌面上' && Number(v) >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => k + ' ' + (v >= 60 ? Math.floor(v / 60) + ' 小时' + (v % 60 ? ' ' + (v % 60) + ' 分' : '') : v + ' 分'))
    .join('、')
  return line ? '今天的样子：' + line + '；' : ''
}

/**
 * 叫醒包（发给会话的提示）：只含类别、时长、时刻，不含窗口标题、进程路径、活动明细。
 * special_day 的结束语不同（可以送贺卡）。
 * @param {{type: string, spanMs?: number, awayMs?: number, quietMs?: number, names?: string[], date?: string}} pick
 * @param {{now?: number, today?: object, userLastSpokeAt?: number, lastSpokeAt?: number, spokeAnswered?: boolean}} o
 */
export function buildWakeText (pick, o = {}) {
  const t = o.now != null ? o.now : Date.now()
  const d = new Date(t)
  const lines = ['[桌宠·醒来看看] 现在 ' + hmOf(t) + '（周' + '日一二三四五六'.charAt(d.getDay()) + '）。你是被定时叫醒的，没有人在跟你说话。']
  lines.push('由头：' + ((TRIGGER_LINES[pick && pick.type] || (() => ''))(pick || {})))
  const tail = [todayLine(o.today), o.userLastSpokeAt ? '距离她上次和你说话 ' + durText(t - o.userLastSpokeAt) : '',
    o.lastSpokeAt ? '你上一次主动开口是 ' + hmOf(o.lastSpokeAt) + '（她' + (o.spokeAnswered ? '回了' : '没回') + '）' : ''].filter(Boolean).join('；')
  if (tail) lines.push(tail + '。')
  lines.push('—')
  if (pick && pick.type === 'special_day') {
    lines.push('想说点什么就说；想送张贺卡，可以用信箱。都不想就回【不说】。')
  } else {
    lines.push('要不要开口由你决定。想说就说一句（口语、一两句、不超过 40 字，像朋友随口一句，别说教、别列清单、' +
      '别提你在被叫醒或在看她的活动记录）；觉得现在不合适就只回复：【不说】')
  }
  return lines.join('\n')
}

const FRESH_STATE = () => ({
  v: 1,
  lastWakeAt: 0,          // 上次叫醒（含 AI 选择不说）；间隔闸用它
  lastSpokeAt: 0,         // 上次真的开口
  wakeDay: '', wakeCount: 0,    // 当天叫醒次数（信息）
  spokeDay: '', spokeCount: 0,  // 当天开口次数（dailyMax 管它）
  breakerLevel: 0,        // 额度熔断梯度：1=30 min，2=2 h，3=当天
  breakerUntil: 0,
  breakerDay: '',         // 最近一次熔断记档的日期（跨天时把档位归零）
  fails: 0,               // 连续失败（任何中继失败）
  awaitReply: false,      // 没回不追
  userAt: 0,              // 用户最后一次说话（任意入口；重启后要能续算「4 小时没说话」「5 分钟刚聊过」）
  keys: {},               // 回合型由头已触发的段落起点 { long_work, back, long_play }
  marks: {},              // 当天型由头已触发的日期 { late_work, quiet_long }
  wakeMessageId: '',      // 自己的叫醒消息 id（区分「用户说话」）
})

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * @param {{ dataDir: string, settings: () => any, relay: object, sendCommand?: Function,
 *          rowsFn?: Function, now?: () => number, onWake?: Function }} o
 *   settings  宿主 readSettings（含 autonomy.care / careLevel / quietHours / aiControl / voice.llm.sessionId）
 *   relay     host 的 relay（用到 ask / pending）；ask 支持第 4 参 { messageId, source } 以识别自己的叫醒消息
 *   sendCommand  (body, timeoutMs) -> { ok, running?, data? }；测状态 / 出声
 *   rowsFn    活动行 [{t, state, app}]（默认读 <dataDir>/activity-log.jsonl）；测试注入假 awareness
 *   onWake    ({ trigger, decision: spoke|silent|error })：每次叫醒出结果的回调（宿主记 pet-activity）
 *   extras    () => { reminders: [{ id, title, time, occurrenceDate, daysBefore, dueAt, missed }], specialDay: { date, names } | null }
 *             「日历与日记」包的由头（lib/calendar.js wakeContext）；reminder 由头不受主动关心开关约束
 *   onFired   ({ type: 'reminder'|'special_day', item?, date? })：日历由头叫醒成功后销账（宿主 → calendar.markReminded/markSpecialDay）
 *   onReminderBubble  (items)：AI 控制关着 / 会话不可用 / 排队超 10 分钟时，宿主直接冒气泡兜底（不出声）
 */
export function createProactive ({ dataDir, settings, relay, sendCommand = null, rowsFn = null, now = Date.now, onWake = null, extras = null, onFired = null, onReminderBubble = null }) {
  const stateFile = join(dataDir, STATE_FILE)
  const logFile = join(dataDir, LOG_FILE)
  const t0 = () => { try { return now() } catch { return Date.now() } }

  const loadState = () => {
    try {
      const j = JSON.parse(readFileSync(stateFile, 'utf8'))
      const s = FRESH_STATE()
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        s.lastWakeAt = num(j.lastWakeAt); s.lastSpokeAt = num(j.lastSpokeAt)
        s.wakeDay = typeof j.wakeDay === 'string' ? j.wakeDay : ''
        s.wakeCount = num(j.wakeCount)
        s.spokeDay = typeof j.spokeDay === 'string' ? j.spokeDay : ''
        s.spokeCount = num(j.spokeCount)
        s.breakerLevel = num(j.breakerLevel); s.breakerUntil = num(j.breakerUntil)
        s.breakerDay = typeof j.breakerDay === 'string' ? j.breakerDay : ''
        s.fails = num(j.fails); s.awaitReply = j.awaitReply === true
        s.userAt = num(j.userAt)
        s.keys = objOf(j.keys); s.marks = objOf(j.marks)
        s.wakeMessageId = typeof j.wakeMessageId === 'string' ? j.wakeMessageId : ''
      }
      return s
    } catch { return FRESH_STATE() }
  }
  let st = null
  const state = () => { if (!st) st = loadState(); return st }
  const saveState = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = stateFile + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(state(), null, 1), 'utf8')
      renameSync(tmp, stateFile)
    } catch {}
  }

  // ---- proactive.jsonl：{t, trigger, decision, chars}；留 14 天（写时顺带整枝，每小时至多一次）
  let prunedAt = 0
  const logLine = (row) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(logFile, JSON.stringify(row) + '\n', 'utf8')
      const t = t0()
      if (t - prunedAt < 3600_000) return
      prunedAt = t
      const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      const cutoff = t - LOG_KEEP_MS
      const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).t) >= cutoff } catch { return true } })
      if (keep.length !== lines.length) {
        const tmp = logFile + '.' + process.pid + '.tmp'
        writeFileSync(tmp, keep.map((l) => l + '\n').join(''), 'utf8')
        renameSync(tmp, logFile)
      }
    } catch {}
  }

  // ---- 闸 2：只读 balance.js 的磁盘缓存，绝不发请求；缓存过期 = 未知，不阻断
  const balanceView = () => {
    try {
      const c = JSON.parse(readFileSync(join(dataDir, 'balance.json'), 'utf8'))
      if (!c || typeof c !== 'object' || typeof c.total !== 'number' || typeof c.at !== 'number') return null
      if (t0() - c.at > BALANCE_TTL_MS) return null
      let threshold = DEFAULT_THRESHOLD
      try {
        const s = JSON.parse(readFileSync(join(dataDir, 'balance-settings.json'), 'utf8'))
        const n = Number(s && s.threshold)
        if (Number.isFinite(n) && n >= 0) threshold = n
      } catch {}
      return { isAvailable: c.isAvailable !== false, low: c.currency !== 'USD' && c.total < threshold }
    } catch { return null }
  }

  // ---- 闸 3：绑定会话在跑（turn 开着或 relay 有在途任务）；丢了的 turn/end 由时间兜底
  const turns = new Map() // turn 号 -> 开始时刻（只记绑定会话）
  const busyNow = (sid) => {
    const t = t0()
    for (const [k, since] of turns) if (t - since > TURN_STALE_MS) turns.delete(k)
    if (turns.size) return true
    try { return !!(relay && relay.pending && relay.pending.has(sid)) } catch { return false }
  }

  let userActivityAt = 0

  /** 用户在任意入口说了话（会话打字 / 桌宠语音 / 信箱）：解除「没回不追」；落盘可节流到 30 s 一次 */
  const noteUserActivity = () => {
    try {
      const t = t0()
      userActivityAt = t
      const s = state()
      s.userAt = t
      if (s.awaitReply) s.awaitReply = false
      if (t - userSavedAt >= 30_000) { userSavedAt = t; saveState() }
    } catch {}
  }
  let userSavedAt = 0
  let lastBound = ''   // 上次见到的绑定会话（跟随时会变）

  /**
   * 绑定会话换了（跟随外部桥会话切了会话）：`turns` 只记绑定会话的 turn 号，旧会话的 turn/end 会被过滤，
   * 残留会让「会话在跑」一直为真，直到 TURN_STALE_MS 才自己过期。切会话时清掉就好；
   * 正在叫醒的那一轮（inFlight）照常走完，不动它。
   */
  const resetSession = () => {
    turns.clear()
    try { lastBound = keyOf((settings() || {}).voice?.llm?.sessionId) } catch { lastBound = '' }
  }

  /** session/event 订阅（host 挂）：只看绑定会话。user/message = 用户说话（自己的叫醒消息除外）。 */
  const onEvent = (session, event) => {
    try {
      const want = keyOf((settings() || {}).voice?.llm?.sessionId)
      if (want !== lastBound) { lastBound = want; turns.clear() } // 会话换了：旧的 turn 记号立刻作废
      if (!want || keyOf((session && session.header && session.header.id) || (session && session.id)) !== want) return
      const type = event && event.type
      if (type === 'turn/start') {
        const n = Number(event.data && event.data.turn)
        turns.set(Number.isInteger(n) ? n : 'open', t0())
      } else if (type === 'turn/end') {
        const n = Number(event.data && event.data.turn)
        if (Number.isInteger(n)) turns.delete(n)
        else turns.delete('open')
      } else if (type === 'user/message') {
        const mid = event.data && event.data.id
        const own = state().wakeMessageId
        if (mid && mid === own) return // 自己的叫醒消息不算用户说话
        noteUserActivity()
      }
    } catch {}
  }

  // ---- 熔断梯度：30 min → 2 h → 当天
  const escalate = (t) => {
    const s = state()
    const lvl = Math.min(3, s.breakerLevel + 1)
    s.breakerLevel = lvl
    s.breakerUntil = lvl === 1 ? t + 30 * 60_000 : lvl === 2 ? t + 2 * 3600_000 : endOfDayMs(t)
    s.breakerDay = dayKeyOf(t) // 最近一次升档的日期：跨天时把档位归零（第 3 档的 until 已到当天结束）
  }
  const breakerActive = (t) => {
    const s = state()
    return s.breakerUntil > t // 是否在熔断只看到期时间；跨天归零交给下面的复位逻辑
  }

  const bumpDay = (kind, t) => {
    const day = dayKeyOf(t)
    if (st[kind + 'Day'] === day) st[kind + 'Count']++
    else { st[kind + 'Day'] = day; st[kind + 'Count'] = 1 }
  }

  let inFlight = false
  let reminderQueuedAt = 0 // 提醒因会话忙/熔断排队：第一次排队的时刻（超 10 分钟改气泡兜底）
  let timer = null

  /** 提醒的气泡兜底：AI 控制关着 / 会话不可用 / 排队超时 / say 失败。不出声。**气泡成功才销账**。 */
  const fireBubbleReminders = async (items) => {
    const t = t0()
    const text = '提醒：' + items.map((it) => it.title).join('；')
    let ok = false
    try {
      if (sendCommand) {
        const r = await Promise.resolve(sendCommand({ cmd: 'say', text, seconds: 12 }, 5_000)).catch(() => null)
        ok = !!(r && r.ok === true)
      }
    } catch { ok = false }
    if (!ok) return false // 桌宠没开 / 气泡失败：留着，下一轮再试
    logLine({ t: new Date(t).toISOString(), trigger: 'reminder', decision: 'spoke', chars: text.length })
    try { if (typeof onWake === 'function') onWake({ trigger: 'reminder', decision: 'spoke' }) } catch {}
    try { if (typeof onFired === 'function') for (const it of items) onFired({ type: 'reminder', item: it }) } catch {}
    return true
  }

  /** 活动感知开着、且最后一行足够新鲜（30 分钟内）时，最后一行是 away 才算「不在电脑前」；否则当作在 */
  const awayRightNow = (t) => {
    let s = null
    try { s = settings() } catch { return false }
    const aware = !!(s.autonomy && s.autonomy.enabled !== false && s.autonomy.aware === true)
    if (!aware) return false
    const rowsNow = (rowsFn ? rowsFn() : readLog(dataDir)).slice().sort((a, b) => a.t - b.t)
    if (!rowsNow.length) return false
    const last = rowsNow[rowsNow.length - 1]
    if (t - last.t > STALE_AWAY_MS) return false // 日志停在 away 但不新鲜：当作在
    return last.state === 'away'
  }

  /** 当前时段的活动段（提醒分支 / away 判定共用） */
  const segsNow = () => {
    const rowsNow = (rowsFn ? rowsFn() : readLog(dataDir)).slice().sort((a, b) => a.t - b.t)
    return rowsNow.length ? segments(rowsNow, t0()) : []
  }

  /** 今天是不是第一次见到用户：感知开着 = 刚从 away 回来（10 分钟内）或今天用户开过口，且 ≥ 提醒说话时间；
   *  感知没开 = 09:00 定点。 */
  const firstSeenToday = (t, segs, s) => {
    const aware = !!(s.autonomy && s.autonomy.enabled !== false && s.autonomy.aware === true)
    if (aware && Array.isArray(segs) && segs.length) {
      if (minuteOfDay(t) < (hhmmMin(s.calendar?.speakFrom || '08:00') ?? 8 * 60)) return false
      // 过了「提醒说话时间」、人在电脑前就算见到了（原先要求「10 分钟内刚从 away 回来」或「今天开过口」，
      // 7 点就坐下一直没离开、也没跟桌宠说话的话，全天提醒和特别日子会拖一整天）
      return !awayRightNow(t)
    }
    return minuteOfDay(t) >= 9 * 60
  }

  /** 一次 tick：硬闸全过 + 有由头才叫醒。绝不抛（定时器里跑）。
   * 日历提醒（calendar extras 的 reminder 由头）不受「主动关心」开关、间隔、每日配额、没回不追约束，
   * 仍受熔断、会话忙（排队最多 10 分钟后气泡兜底）、嘴忙、单飞约束；用户不在电脑前就等回来再说。 */
  const tick = async () => {
    if (inFlight) return // 闸 8：单飞
    inFlight = true
    try {
      const t = t0()
      const s = settings()
      // 日历由头（host 注入 extras）
      let calCtx = null
      try { calCtx = typeof extras === 'function' ? extras() : null } catch { calCtx = null }
      const calAll = calCtx && Array.isArray(calCtx.reminders) && calCtx.reminders.length ? calCtx.reminders : null
      const calSpecial = calCtx && calCtx.specialDay ? calCtx.specialDay : null
      // 全天 / 提前 N 天的提醒要等「提醒说话时间」之后、今天第一次见到用户；只有「定时且当天」到点就说。
      // 这道筛选原先只在「AI 控制开着」的分支里，AI 控制关着时气泡兜底会在 0 点就冒、并且销账
      let calReminders = null
      if (calAll) {
        const timedNow = calAll.filter((it) => it.time && it.daysBefore === 0)
        const dayOnes = calAll.filter((it) => !(it.time && it.daysBefore === 0))
        if (timedNow.length || (dayOnes.length && firstSeenToday(t, segsNow(), s))) calReminders = calAll
      }

      // 闸 1：总开关（有提醒要发时不拦——用户自己要求的）
      if (!calReminders && !careOn(s)) return
      const aiWake = s.aiControl !== false
      const sid = keyOf(s.voice.llm.sessionId)
      if (!aiWake || !sid) {
        // AI 控制关着 / 会话不可用：提醒直接冒气泡（不出声），销账
        if (calReminders) { await fireBubbleReminders(calReminders); return }
        return
      }
      const lvl = LEVELS[levelOf(s)]
      st = state()
      if (st.userAt > userActivityAt) userActivityAt = st.userAt // 重启后从状态文件续上
      // 熔断档位跨天复位：昨天记的档（尤其第 3 档「当天停」）不该延续到今天
      if (st.breakerDay && st.breakerDay !== dayKeyOf(t)) {
        st.breakerLevel = 0; st.breakerDay = ''
        if (st.breakerUntil <= t) st.breakerUntil = 0
        saveState()
      }

      // ---- 提醒分支（宽松闸；不占 care 的间隔 / 配额 / 没回不追）
      if (calReminders) {
        const blocked = breakerActive(t) || (() => { const b = balanceView(); return !!(b && (b.isAvailable === false || b.low === true)) })()
        if (busyNow(sid) || blocked) {
          if (!reminderQueuedAt) reminderQueuedAt = t
          if (t - reminderQueuedAt > 10 * 60_000) { await fireBubbleReminders(calReminders); reminderQueuedAt = 0 }
          return
        }
        reminderQueuedAt = 0
        // 嘴忙 / 桌宠不在线：等下一轮
        const status = sendCommand ? await Promise.resolve(sendCommand({ cmd: 'status' }, 3_000)).catch(() => null) : null
        const d = status && status.ok && status.data && typeof status.data === 'object' ? status.data : null
        if (!d) return
        if (BUSY_VOICE.includes(String(d.voice || ''))) return
        // 用户不在电脑前：等回来再说（不销账）。活动感知没开或日志不新鲜时当作在
        const awayNow = awayRightNow(t)
        if (awayNow) return
        // 到点了，见到人了：叫醒
        const wakeId = petMessageId(randomUUID())
        st.wakeMessageId = wakeId
        const text = buildReminderText(calReminders, t)
        const r = await Promise.resolve(relay.ask(sid, text, undefined, { messageId: wakeId, source: 'calendar' }))
        const code = r && r.code
        const body = r && r.body
        if (!body || body.ok !== true || !(code < 400)) {
          st.fails++
          const msg = String((body && body.message) || '')
          if (code === 402 || code === 429 || QUOTA_RE.test(msg)) escalate(t)
          else if (st.fails >= 2) st.breakerUntil = Math.max(st.breakerUntil, t + 30 * 60_000)
          logLine({ t: new Date(t).toISOString(), trigger: 'reminder', decision: 'error' })
          try { if (typeof onWake === 'function') onWake({ trigger: 'reminder', decision: 'error' }) } catch {}
          saveState()
          return
        }
        st.fails = 0; st.breakerLevel = 0; st.breakerUntil = 0; st.breakerDay = ''
        st.lastWakeAt = t; st.lastSpokeAt = t
        reminderQueuedAt = 0
        const spoken = cleanSpoken(String(body.reply || ''))
        // 回复为空 / 【不说】/ say 失败 → 气泡兜底；气泡成功才销账，否则留着下一轮再试
        if (spoken && !isSilentReply(String(body.reply || ''))) {
          const said = sendCommand ? await Promise.resolve(sendCommand({ cmd: 'say', text: spoken, speak: true }, 10_000)).catch(() => null) : null
          if (said && said.ok) {
            logLine({ t: new Date(t).toISOString(), trigger: 'reminder', decision: 'spoke', chars: spoken.length })
            try { if (typeof onWake === 'function') onWake({ trigger: 'reminder', decision: 'spoke' }) } catch {}
            try { if (typeof onFired === 'function') for (const it of calReminders) onFired({ type: 'reminder', item: it }) } catch {}
            saveState()
            return
          }
        }
        await fireBubbleReminders(calReminders) // 气泡成功才销账（fireBubbleReminders 内部判断）
        saveState()
        return
      }

      // 闸 2：熔断 / 余额（提醒分支自己排队，这里管 care 由头）
      if (breakerActive(t)) return
      const bal = balanceView()
      if (bal && (bal.isAvailable === false || bal.low === true)) return
      // 闸 7：间隔 + 当天「说话」配额（silent 只占间隔，所以间隔闸放在触发判断之前就够了）
      if (st.lastWakeAt && t - st.lastWakeAt < lvl.minGapMin * 60_000) return
      if (st.spokeDay === dayKeyOf(t) && st.spokeCount >= lvl.dailyMax) return
      // 闸 6：没回不追
      if (st.awaitReply) return
      // 闸 3：会话忙
      if (busyNow(sid)) return
      // 眼睛：活动行
      const rows = (rowsFn ? rowsFn() : readLog(dataDir)).slice().sort((a, b) => a.t - b.t)
      if (!rows.length) return
      const segs = segments(rows, t)
      // 闸 4：用户此刻状态
      if (BLOCK_NOW.includes(segs[segs.length - 1].state)) return
      // 由头
      const quiet = quietWindowOf(s.autonomy)
      const inQuiet = inWindow(minuteOfDay(t), quiet.start, quiet.end)
      let pick = null
      // special_day：第一次见到用户时（≥ 提醒说话时间 / 09:00），受主动关心开关与安静时段约束，每天最多一次
      if (calSpecial && !inQuiet && firstSeenToday(t, segs, s)) pick = { type: 'special_day', names: calSpecial.names || [], date: calSpecial.date }
      if (!pick) {
        const picks = evaluateTriggers(segs, { now: t, userLastSpokeAt: userActivityAt, dayKey: dayKeyOf(t), state: st })
        pick = picks.find((p) => !(inQuiet && p.type !== 'late_work')) || null
      }
      if (!pick) return
      // 闸 9：别的功能在用嘴（需要桌宠在线：不在线叫了也白叫）
      const status = sendCommand ? await Promise.resolve(sendCommand({ cmd: 'status' }, 3_000)).catch(() => null) : null
      const d = status && status.ok && status.data && typeof status.data === 'object' ? status.data : null
      if (!d) return
      if (BUSY_VOICE.includes(String(d.voice || ''))) return
      if (userActivityAt && t - userActivityAt < RECENT_CHAT_MS) return

      // ---- 叫醒（一次）
      const wakeId = petMessageId(randomUUID())
      st.wakeMessageId = wakeId
      const today = summarizeDay(rows, t)
      const text = buildWakeText(pick, {
        now: t, today: today && today.minutes, userLastSpokeAt: userActivityAt,
        lastSpokeAt: st.lastSpokeAt, spokeAnswered: !st.awaitReply,
      })
      // 主动关心记 care；特别日子是日历来的，记 calendar（原先这里一律写成了 calendar）
      const r = await Promise.resolve(relay.ask(sid, text, undefined, { messageId: wakeId, source: pick.type === 'special_day' ? 'calendar' : 'care' }))
      const code = r && r.code
      const body = r && r.body
      if (code === 409) return // 会话忙竞态：什么都不算，下轮再看
      if (!body || body.ok !== true || !(code < 400)) {
        // 失败：额度类 → 指数退避；连续 2 次任何失败 → 30 min。成功才复位。
        st.fails++
        const msg = String((body && body.message) || '')
        if (code === 402 || code === 429 || QUOTA_RE.test(msg)) escalate(t)
        else if (st.fails >= 2) st.breakerUntil = Math.max(st.breakerUntil, t + 30 * 60_000)
        logLine({ t: new Date(t).toISOString(), trigger: pick.type, decision: 'error' })
        try { if (typeof onWake === 'function') onWake({ trigger: pick.type, decision: 'error' }) } catch {}
        saveState()
        return
      }
      st.fails = 0; st.breakerLevel = 0; st.breakerUntil = 0; st.breakerDay = ''
      st.lastWakeAt = t
      bumpDay('wake', t)
      if (pick.key != null) st.keys[pick.type] = pick.key
      if (pick.type === 'late_work' || pick.type === 'quiet_long') st.marks[pick.type] = dayKeyOf(t)
      const reply = String(body.reply || '')
      if (isSilentReply(reply)) {
        // 选择不说：静默丢弃（AI 可能只做了个动作）；占间隔，不占每日「说话」配额
        logLine({ t: new Date(t).toISOString(), trigger: pick.type, decision: 'silent' })
        try { if (typeof onWake === 'function') onWake({ trigger: pick.type, decision: 'silent' }) } catch {}
        if (pick.type === 'special_day') {
          // 特别日子选了不说也算「今天提过了」：不销账会每隔一个最小间隔再叫一次
          try { if (typeof onFired === 'function') onFired({ type: 'special_day', date: pick.date }) } catch {}
        }
        saveState()
        return
      }
      const spoken = cleanSpoken(reply)
      if (spoken && sendCommand) {
        // 出声 + 气泡；叫醒包本身不进气泡、不进信箱。念不出来就只当没念，话已在会话里。
        await Promise.resolve(sendCommand({ cmd: 'say', text: spoken, speak: true }, 10_000)).catch(() => {})
      }
      st.lastSpokeAt = t
      st.awaitReply = true
      bumpDay('spoke', t)
      logLine({ t: new Date(t).toISOString(), trigger: pick.type, decision: 'spoke', chars: spoken.length })
      try { if (typeof onWake === 'function') onWake({ trigger: pick.type, decision: 'spoke' }) } catch {}
      if (pick.type === 'special_day') { try { if (typeof onFired === 'function') onFired({ type: 'special_day', date: pick.date }) } catch {} }
      saveState()
    } catch {} finally {
      inFlight = false
    }
  }

  const stop = () => { if (timer) { clearInterval(timer); timer = null } }
  const start = () => {
    if (timer) return stop
    timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return stop
  }

  /** AI 侧只读视图（pixelpet_status → care）：被问到「你怎么老提醒我」时能解释 */
  const view = () => {
    let s = null
    try { s = settings() } catch {}
    const x = state()
    const t = t0()
    // 是否在熔断只看 breakerUntil（第 3 档的 until 本来就设到当天结束）
    const paused = x.breakerUntil > t ? x.breakerUntil : null
    return { enabled: s ? careOn(s) : false, lastWakeAt: x.lastWakeAt || null, lastSpokeAt: x.lastSpokeAt || null, pausedUntil: paused }
  }

  /** 设置页视图（/api/state → care）：开关旁小黄点 + 悬停「额度/报错，暂停到 HH:MM」 */
  const status = () => {
    const v = view()
    const x = state()
    return { ...v, careLevel: levelOf(settings()), awaitingReply: x.awaitReply === true,
      wakeToday: x.wakeDay === dayKeyOf(t0()) ? x.wakeCount : 0,
      spokeToday: x.spokeDay === dayKeyOf(t0()) ? x.spokeCount : 0 }
  }

  return { tick, start, stop, onEvent, noteUserActivity, view, status, state, balanceView, resetSession,
    // 「绑定会话现在是不是在跑」：跟随切换会话后要立刻按新会话算（测试与面板都用这一口）
    busy: (sid) => { try { return busyNow(sid) } catch { return false } } }
}
