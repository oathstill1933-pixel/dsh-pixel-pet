/**
 * 「跟随外部桥会话」——桌宠只认门牌，不认桥，也不认平台。
 *
 * 桥（任何把某个平台的消息转进 DSH 的程序）每次给某个来源新建或切换会话之后，原子地写一个门牌：
 *
 *   <dataDir>/follow/<channel>-<peer>.json
 *   {
 *     "schema": "dsh-pixel-pet/follow@1",
 *     "channel": "myapp",            // ^[a-z0-9_-]{1,32}$
 *     "peer": "10000",               // ^\S{1,64}$（号码 / 频道 id / 房间名）
 *     "scope": "direct",             // 可选，只用于面板显示，不参与任何判断
 *     "petHome": true,               // 桥声明「这个来源适合当桌宠的家」；缺失按 false
 *     "sessionId": "session-…",       // 带不带 session- 前缀都行
 *     "label": "私聊",                // 可选，只用于面板显示
 *     "updatedAt": "2026-11-15T22:30:00+08:00",
 *     "ttlHours": 36                 // 可选，1..720，默认 36
 *   }
 *
 * 本模块做四件事，别的什么都不做：
 *   1. 扫目录（可选再读一个本机 HTTP 门牌）→ 来源表；坏文件 / 超大 / 符号链接 / .tmp 一律跳过
 *   2. 按设置里选中的来源决定「有效会话」（effective）；任何失败都退回「上次已知会话」，再退回手填值
 *   3. 「上次已知会话」存 <dataDir>/follow-state.json，重启后能接着跟
 *   4. 有效会话变了就回调宿主（冒气泡、记账、复位动画），这里不碰桌宠
 *
 * 铁律（这份东西会开源）：
 *   - 协议字面只用包名 `dsh-pixel-pet`，没有任何部署方的私有前缀。
 *   - **主要看 `petHome` 这个布尔**：channel 是什么一概不看（这里没有平台分支，也没有平台白名单），
 *     哪个来源算「适合当家」由桥自己判断。唯一例外是只拦不放的第二道闸：scope 是「多人场合」
 *     词表里的词（MULTI_PARTY_SCOPES）时，petHome 填 true 也不跟。
 *   - 绝不写、绝不删门牌：门牌目录是桥的地盘，我们只读。
 *   - 日志和接口不出现完整会话 id、也不出现 peer 原文（一律 123****890）。
 */
import { mkdirSync, readFileSync, lstatSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { sessionKey } from './relay.js'

export const FOLLOW_SCHEMA = 'dsh-pixel-pet/follow@1'
export const FOLLOW_DEFAULT = { mode: 'manual', source: '', dir: '', httpUrl: '', intervalSec: 20 }
export const POINTER_MAX_BYTES = 4096
export const POINTER_TTL_DEFAULT_HOURS = 36
export const POINTER_TTL_MAX_HOURS = 720
export const FOLLOW_INTERVAL_MIN = 5
export const FOLLOW_INTERVAL_MAX = 300
export const FOLLOW_FAIL_LIMIT = 3     // 连续这么多次读不到门牌 → 警告换一句话（会话照旧不动）
export const FOLLOW_STATE_FILE = 'follow-state.json'
export const FOLLOW_DIR_NAME = 'follow'

const RE_CHANNEL = /^[a-z0-9_-]{1,32}$/
const RE_PEER = /^\S{1,64}$/
const RE_SCOPE = /^\S{1,32}$/
const RE_LABEL_BAD = /[\u0000-\u001f\u007f]/g
const LABEL_MAX = 48

/**
 * 只拦不放的第二道闸：scope 明显是多人场合时，petHome 填什么都不跟。
 * 不认识任何平台，只是一个很短的「多人场合」词表；scope 不填就完全按 petHome 来
 * （「两个人的小群」这种特殊情况，桥不填 scope、填 petHome: true 即可）。
 * 理由：petHome 一旦被桥误标成 true，桌宠给绑定会话塞的私人上下文（日历近日、余额、活动、划词）会进群。
 */
export const MULTI_PARTY_SCOPES = Object.freeze([
  'group', 'groups', 'supergroup', 'channel', 'guild', 'server', 'room', 'chatroom', 'forum', 'community', 'team', 'public',
  '群', '群聊', '群组', '频道', '房间', '社区', '公开',
])
export const isMultiPartyScope = (scope) => {
  const s = String(scope ?? '').trim().toLowerCase()
  return !!s && MULTI_PARTY_SCOPES.includes(s)
}
/** 能不能当桌宠的家：桥说可以，而且 scope 没声明是多人场合 */
export const homeEligible = (p) => !!p && p.petHome === true && !isMultiPartyScope(p.scope)

// --------------------------------------------------------------------------- 脱敏

/** 面板 / 日志里的对端标识：前三位 + 后三位；太短的干脆只留一位 */
export function maskPeer (peer) {
  const s = String(peer ?? '')
  if (!s) return ''
  if (s.length <= 6) return s.slice(0, 1) + '****'
  return s.slice(0, 3) + '****' + s.slice(-3)
}

/** `channel/peer` 里的 peer 段同样脱敏；channel 不是敏感信息，原样留着 */
export function maskSource (source) {
  const s = String(source ?? '')
  const i = s.indexOf('/')
  if (i <= 0) return s
  return s.slice(0, i) + '/' + maskPeer(s.slice(i + 1))
}

/** 设置里存的来源键可能已经是脱敏串（面板只显示前三位 + 后三位），两边都认 */
export function sourceMatches (source, want) {
  const s = String(source ?? '')
  const w = String(want ?? '')
  if (!s || !w) return false
  return s === w || maskSource(s) === w
}

/** 会话 id 只露出后 8 位（`…a1f3c2d9`）；完整值只在本机同源的设置页里用 */
export function shortSessionId (id) {
  const k = sessionKey(id)
  return k ? '…' + k.slice(-8) : ''
}

// --------------------------------------------------------------------------- 设置项

/** `channel/peer`；只做形状校验，不认识任何平台 */
export function sanitizeSourceKey (v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  const i = s.indexOf('/')
  if (i <= 0) return ''
  const channel = s.slice(0, i)
  const peer = s.slice(i + 1)
  return RE_CHANNEL.test(channel) && RE_PEER.test(peer) ? channel + '/' + peer : ''
}

/** 门牌目录：空 = <dataDir>/follow；给了就必须是绝对路径（相对路径会随 cwd 漂） */
export function sanitizeFollowDir (v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s && isAbsolute(s) ? s : ''
}

/** HTTP 门牌只收回环地址：别让它变成往外打请求的口子 */
export function sanitizeLoopbackUrl (v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:') return ''
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return ''
    if (u.username || u.password) return ''
    return s
  } catch { return '' }
}

/** `follow` 这一组的 sanitize：只认已知字段，未知值原样退回旧值 */
export function sanitizeFollow (v, cur) {
  const base = { ...FOLLOW_DEFAULT, ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}) }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base
  const out = { ...base }
  if ('mode' in v) out.mode = v.mode === 'follow' ? 'follow' : 'manual'
  if ('source' in v) out.source = sanitizeSourceKey(v.source)
  if ('dir' in v) out.dir = sanitizeFollowDir(v.dir)
  if ('httpUrl' in v) out.httpUrl = sanitizeLoopbackUrl(v.httpUrl)
  if ('intervalSec' in v) {
    const n = Number(v.intervalSec)
    out.intervalSec = Number.isFinite(n)
      ? Math.max(FOLLOW_INTERVAL_MIN, Math.min(FOLLOW_INTERVAL_MAX, Math.round(n)))
      : base.intervalSec
  }
  return out
}

export function followDirOf (dataDir, settings) {
  const own = settings && settings.followSession && settings.followSession.dir
  return typeof own === 'string' && own ? own : join(dataDir, FOLLOW_DIR_NAME)
}

/** 门牌目录（跟随器内部用：手上只有 followSession 这一组设置，不是整份 settings） */
export function dirOfFollowSettings (dataDir, followSettings) {
  const own = followSettings && followSettings.dir
  return typeof own === 'string' && own ? own : join(dataDir, FOLLOW_DIR_NAME)
}

// --------------------------------------------------------------------------- 门牌

/**
 * 一个门牌的文本 -> { ok, pointer } 或 { ok: false, reason, silent }。
 *   silent = 版本不对：不认识就安静忽略（别的版本的桥写的，不是错误）
 */
export function parsePointer (text) {
  let obj
  try { obj = JSON.parse(String(text ?? '')) } catch { return { ok: false, reason: 'json', silent: false } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'shape', silent: false }
  if (obj.schema !== FOLLOW_SCHEMA) return { ok: false, reason: 'schema', silent: true }
  if (typeof obj.channel !== 'string' || !RE_CHANNEL.test(obj.channel)) return { ok: false, reason: 'channel', silent: false }
  if (typeof obj.peer !== 'string' || !RE_PEER.test(obj.peer)) return { ok: false, reason: 'peer', silent: false }
  const scope = obj.scope === undefined || obj.scope === null ? '' : obj.scope
  if (typeof scope !== 'string' || (scope && !RE_SCOPE.test(scope))) return { ok: false, reason: 'scope', silent: false }
  if (typeof obj.petHome !== 'boolean') return { ok: false, reason: 'petHome', silent: false }
  const rawSession = typeof obj.sessionId === 'string' ? obj.sessionId.trim() : ''
  if (!sessionKey(rawSession)) return { ok: false, reason: 'sessionId', silent: false }
  const at = typeof obj.updatedAt === 'string' ? Date.parse(obj.updatedAt) : NaN
  if (!Number.isFinite(at)) return { ok: false, reason: 'updatedAt', silent: false }
  let ttl = POINTER_TTL_DEFAULT_HOURS
  if (obj.ttlHours !== undefined && obj.ttlHours !== null) {
    const n = Number(obj.ttlHours)
    if (!Number.isFinite(n) || n < 1 || n > POINTER_TTL_MAX_HOURS) return { ok: false, reason: 'ttlHours', silent: false }
    ttl = n
  }
  const label = typeof obj.label === 'string' ? obj.label.replace(RE_LABEL_BAD, '').trim().slice(0, LABEL_MAX) : ''
  return {
    ok: true,
    pointer: {
      schema: FOLLOW_SCHEMA,
      channel: obj.channel,
      peer: obj.peer,
      source: obj.channel + '/' + obj.peer,
      scope,
      petHome: obj.petHome,          // 只有这个布尔参与判断
      sessionId: rawSession,
      label,
      updatedAt: at,                 // 归一成毫秒，比较新旧不用再解析
      ttlHours: ttl,
    },
  }
}

/** 同一个来源出现在多个文件里时取 updatedAt 最新的那个（顺序稳定：先按来源名） */
function dedupe (list) {
  const best = new Map()
  for (const p of list) {
    const cur = best.get(p.source)
    if (!cur || p.updatedAt > cur.updatedAt) best.set(p.source, p)
  }
  return [...best.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : b.updatedAt - a.updatedAt))
}

/**
 * 设置里存的是「用户看见的那个来源键」。面板上 peer 是脱敏的（123****890），用户能选的只能是脱敏串，
 * 所以这里既认原始键，也认脱敏键——但脱敏键必须**唯一命中**，两个来源撞名就明说认不出，绝不猜。
 */
function resolveSource (list, want) {
  const exact = list.filter((p) => p.source === want)
  if (exact.length === 1) return { pick: exact[0] }
  if (exact.length > 1) return { pick: null, ambiguous: true }
  const masked = list.filter((p) => maskSource(p.source) === want)
  if (masked.length === 1) return { pick: masked[0] }
  return { pick: null, ambiguous: masked.length > 1 }
}

// --------------------------------------------------------------------------- 跟随器

/**
 * @param {object} o
 *   dataDir   数据目录（follow-state.json 落这里）
 *   settings  () => 磁盘原值设置（**不是**有效视图：否则有效会话会被当成手填值）
 *   verify    async (sessionId) => { ok, reason? }  「会话存在且未归档」由宿主查（DSH 的会话表）
 *   onChange  ({ from, to, label, reason }) => void，reason: 'initial' | 'moved' | 'fallback'
 *   logger    { warn }
 *   now       () => ms
 *   timers    { setTimeout, clearTimeout }（测试注入假时钟）
 *   fetchImpl 注入的 fetch（测试用）
 */
export function createFollow ({ dataDir, settings, verify, onChange = null, logger = null, now = Date.now, timers = null, fetchImpl = null }) {
  const setT = (timers && timers.setTimeout) || setTimeout
  const clearT = (timers && timers.clearTimeout) || clearTimeout
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const stateFile = join(dataDir, FOLLOW_STATE_FILE)

  let lastKnown = readState()
  let cached = { mode: 'manual', manual: '', effective: '', warning: '', source: '', label: '', sources: [], checkedAt: 0 }
  let timer = null
  let disposed = false
  let ticking = false
  let failures = 0
  let loggedWarning = ''

  function readState () {
    try {
      const j = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null
      const channel = typeof j.channel === 'string' ? j.channel : ''
      const peer = typeof j.peer === 'string' ? j.peer : ''
      const sessionId = typeof j.sessionId === 'string' ? j.sessionId : ''
      if (!RE_CHANNEL.test(channel) || !RE_PEER.test(peer) || !sessionKey(sessionId)) return null
      return {
        channel, peer, sessionId,
        label: typeof j.label === 'string' ? j.label.replace(RE_LABEL_BAD, '').trim().slice(0, LABEL_MAX) : '',
        at: Number.isFinite(j.at) ? j.at : 0,
      }
    } catch { return null }
  }

  const writeState = (next) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = stateFile + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(next), 'utf8')
      renameSync(tmp, stateFile)
      lastKnown = next
      return true
    } catch { return false }
  }

  const logWarn = (msg) => {
    if (!logger || typeof logger.warn !== 'function' || msg === loggedWarning) return
    loggedWarning = msg
    try { logger.warn('[dsh-pixel-pet] 跟随：' + msg) } catch {}
  }

  // ------------------------------------------------------------------ 读来源表

  /** 文件名就是 <channel>-<peer>，peer 段照样脱敏后才写进日志 / 面板（不记原件名） */
  const maskedFileName = (name) => {
    const base = String(name || '')
    const i = base.indexOf('-')
    return i > 0 ? base.slice(0, i) + '-****.json' : base.slice(0, 4) + '****'
  }

  /** 目录里的门牌；坏一个只丢一个，记一条 warning（不带原文） */
  function readDir (dir, warnings) {
    const out = []
    let names
    try { names = readdirSync(dir) } catch { return { list: out, ok: false } }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      if (/\.tmp$/i.test(name)) continue           // 半写状态的文件
      const file = join(dir, name)
      let st
      try { st = lstatSync(file) } catch { continue }
      if (!st.isFile()) continue                    // 符号链接 / 目录 / 设备一律不跟
      if (st.size > POINTER_MAX_BYTES) { warnings.push('门牌太大，已忽略：' + maskedFileName(name)); continue }
      let text
      try { text = readFileSync(file, 'utf8') } catch { warnings.push('门牌读不了：' + maskedFileName(name)); continue }
      const r = parsePointer(text)
      if (!r.ok) {
        if (!r.silent) warnings.push('门牌格式不对（' + r.reason + '）：' + maskedFileName(name))
        continue
      }
      out.push(r.pointer)
    }
    return { list: out, ok: true }
  }

  /** 可选的本机 HTTP 门牌：只收回环、3 秒超时、不跟随重定向、响应 ≤ 4 KB */
  async function readHttp (url, warnings) {
    if (!doFetch) { warnings.push('没有可用的 fetch，跳过 HTTP 门牌'); return [] }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const kill = ctrl ? setT(() => { try { ctrl.abort() } catch {} }, 3000) : null
    try {
      const res = await doFetch(url, { method: 'GET', redirect: 'manual', ...(ctrl ? { signal: ctrl.signal } : {}), headers: { accept: 'application/json' } })
      if (!res || res.status !== 200) { warnings.push('HTTP 门牌没有应答'); return [] }
      const len = Number((res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : '') || 0)
      if (Number.isFinite(len) && len > POINTER_MAX_BYTES) { warnings.push('HTTP 门牌太大'); return [] }
      const text = await res.text()
      if (typeof text !== 'string' || text.length > POINTER_MAX_BYTES) { warnings.push('HTTP 门牌太大'); return [] }
      const one = (raw, what) => {
        // 数组里的条目已经是对象了；返回体是单个对象时也一样（文本先解析）
        const r = parsePointer(typeof raw === 'string' ? raw : JSON.stringify(raw))
        if (!r.ok) { if (!r.silent) warnings.push('HTTP 门牌格式不对（' + r.reason + '）' + what); return [] }
        return [r.pointer]
      }
      if (/^\s*\[/.test(text)) {
        let arr
        try { arr = JSON.parse(text) } catch { warnings.push('HTTP 门牌不是合法 JSON'); return [] }
        if (!Array.isArray(arr) || arr.length > 64) { warnings.push('HTTP 门牌条目太多或不是数组'); return [] }
        return arr.flatMap((item, i) => one(item, ' #' + (i + 1)))
      }
      return one(text, '')
    } catch { warnings.push('HTTP 门牌没读成'); return [] } finally { if (kill) clearT(kill) }
  }

  async function loadTable (f) {
    const warnings = []
    const dir = dirOfFollowSettings(dataDir, f)
    const local = readDir(dir, warnings)
    let http = []
    const url = sanitizeLoopbackUrl(f.httpUrl)
    if (url) http = await readHttp(url, warnings)
    const list = dedupe([...local.list, ...http])
    return { list, warnings, ok: local.ok, dir }
  }

  // ------------------------------------------------------------------ 有效会话

  const fireChange = (from, to, label, reason) => {
    if (typeof onChange !== 'function') return
    try { onChange({ from, to, label, reason }) } catch {}
  }

  /** 失败时：这个来源的上次已知会话还在就用它，否则退回手填值；绝不清空、绝不静默 */
  function hold (f, msg, label = '') {
    const prev = cached.effective
    const savedSource = lastKnown ? lastKnown.channel + '/' + lastKnown.peer : ''
    // 设置里可能是脱敏键（面板只显示前三位+后三位），两边都按「原值或脱敏值相等」认
    const sameSource = !!(lastKnown && f.source && (savedSource === f.source || maskSource(savedSource) === f.source))
    const next = sameSource ? lastKnown.sessionId : ''
    cached.effective = next
    cached.source = f.source
    cached.label = label || (sameSource ? lastKnown.label : '')
    cached.warning = msg
    logWarn(msg)
    if (sessionKey(prev) !== sessionKey(next)) fireChange(prev, next, cached.label, 'fallback')
  }

  function adopt (f, pick) {
    const prev = cached.effective
    const moved = sessionKey(prev) !== sessionKey(pick.sessionId)
    cached.effective = pick.sessionId
    cached.source = f.source
    cached.label = pick.label
    cached.warning = ''
    loggedWarning = ''
    // 只有真的换了会话（或换了来源）才落盘，省掉每 20 秒一次的无谓写入
    if (!lastKnown || lastKnown.channel !== pick.channel || lastKnown.peer !== pick.peer ||
        sessionKey(lastKnown.sessionId) !== sessionKey(pick.sessionId)) {
      writeState({ channel: pick.channel, peer: pick.peer, sessionId: pick.sessionId, label: pick.label, at: now() })
    }
    if (moved) fireChange(prev, pick.sessionId, pick.label, prev ? 'moved' : 'initial')
  }

  async function recompute () {
    let s
    try { s = settings() } catch { s = null }
    const f = { ...FOLLOW_DEFAULT, ...((s && s.followSession) || {}) }
    cached.manual = String((s && s.voice && s.voice.llm && s.voice.llm.sessionId) || '')
    cached.mode = f.mode
    if (f.mode !== 'follow') {
      const prev = cached.effective
      cached.effective = ''                 // 手动模式：一个字都不改，回到手填值
      cached.warning = ''
      cached.source = ''
      cached.label = ''
      cached.sources = []
      failures = 0
      if (sessionKey(prev)) fireChange(prev, '', '', 'fallback')
      return
    }
    const table = await loadTable(f)
    cached.sources = table.list
    cached.checkedAt = now()
    if (!f.source) { failures = 0; return hold(f, '还没选跟哪个聊天桥') }
    const found = resolveSource(table.list, f.source)
    if (!table.ok || !found.pick) failures++
    else failures = 0
    if (failures >= FOLLOW_FAIL_LIMIT) return hold(f, '连续读不到聊天桥的门牌（它告诉桌宠去哪个会话的那个文件），先用上次的会话')
    const pick = found.pick
    if (!pick) {
      if (found.ambiguous) return hold(f, '有几个来源的脱敏名一样，认不出是哪一个', f.source)
      return hold(f, table.ok ? '这个聊天桥还没告诉桌宠它在哪个会话' : '找不到聊天桥写门牌的目录')
    }
    if (pick.petHome !== true) return hold(f, '这个来源不适合当桌宠的家', pick.label)
    if (isMultiPartyScope(pick.scope)) return hold(f, '聊天桥标明这是多人场合（scope=' + String(pick.scope).slice(0, 16) + '），桌宠不跟', pick.label)
    if (now() - pick.updatedAt > pick.ttlHours * 3600_000) return hold(f, '聊天桥很久没更新会话了（过期），先用上次的会话', pick.label)
    if (cached.effective && sessionKey(cached.effective) === sessionKey(pick.sessionId)) {
      cached.warning = ''
      cached.label = pick.label
      loggedWarning = ''
      return
    }
    const v = await verify(pick.sessionId).catch(() => ({ ok: false, reason: 'error' }))
    if (!v || v.ok !== true) {
      return hold(f, v && v.reason === 'archived' ? '聊天桥指的那个会话已归档，先用上次的会话' : '聊天桥指的那个会话不在了，先用上次的会话', pick.label)
    }
    adopt(f, pick)
  }

  const intervalMs = () => {
    const f = (() => { try { return (settings() || {}).followSession || {} } catch { return {} } })()
    const n = Number(f.intervalSec)
    const sec = Number.isFinite(n) ? Math.max(FOLLOW_INTERVAL_MIN, Math.min(FOLLOW_INTERVAL_MAX, n)) : FOLLOW_DEFAULT.intervalSec
    return sec * 1000
  }

  function schedule (ms) {
    if (disposed) return
    if (timer) { try { clearT(timer) } catch {} timer = null }
    timer = setT(() => { timer = null; run() }, ms)
    timer?.unref?.()
  }

  async function run () {
    if (disposed) return
    if (!ticking) {
      ticking = true
      try { await recompute() } catch {} finally { ticking = false }
    }
    schedule(intervalMs())
  }

  /** 立刻重算一次（面板打开、刚存完设置时用），不改变周期 */
  const kick = () => schedule(0)

  const start = () => {
    if (disposed) return () => {}
    schedule(0)
    return stop
  }

  function stop () {
    if (timer) { try { clearT(timer) } catch {} timer = null }
    disposed = true
  }

  // ------------------------------------------------------------------ 对外

  /** 有效会话；'' = 手动模式或还没跟到（调用方回落到手填值） */
  const effectiveSessionId = () => (cached.mode === 'follow' ? cached.effective : '')

  /** 读设置时的「有效视图」：跟随模式下把 voice.llm.sessionId 换成有效会话，别的字段原样 */
  const view = (raw) => {
    const eff = effectiveSessionId()
    if (!eff || !raw || typeof raw !== 'object') return raw
    const voice = raw.voice && typeof raw.voice === 'object' ? raw.voice : {}
    const llm = voice.llm && typeof voice.llm === 'object' ? voice.llm : {}
    return { ...raw, voice: { ...voice, llm: { ...llm, sessionId: eff } } }
  }

  /** 面板 / 接入方自检用的只读快照（peer、会话 id 都已脱敏） */
  const snapshot = async () => {
    await recompute().catch(() => {})
    const f = (() => { try { return (settings() || {}).followSession || FOLLOW_DEFAULT } catch { return FOLLOW_DEFAULT } })()
    const rows = []
    for (const p of cached.sources.slice(0, 20)) {
      const v = await verify(p.sessionId).catch(() => ({ ok: false }))
      const sessionOk = !!(v && v.ok === true)
      rows.push({
        source: maskSource(p.source),
        channel: p.channel,
        peer: maskPeer(p.peer),
        label: p.label,
        scope: p.scope,
        petHome: p.petHome === true,
        updatedAt: new Date(p.updatedAt).toISOString(),
        stale: now() - p.updatedAt > p.ttlHours * 3600_000,
        sessionOk,
        multiParty: isMultiPartyScope(p.scope),
        eligible: homeEligible(p) && sessionOk,
      })
    }
    const pick = cached.sources.find((p) => sourceMatches(p.source, f.source))
    return {
      ok: true,
      mode: f.mode === 'follow' ? 'follow' : 'manual',
      source: cached.source ? maskSource(cached.source) : '',
      label: cached.label || (pick ? pick.label : ''),
      effectiveSessionId: shortSessionId(effectiveSessionId()),
      manualSessionId: shortSessionId(cached.manual),
      lastKnown: lastKnown ? { sessionId: shortSessionId(lastKnown.sessionId), label: lastKnown.label, at: lastKnown.at } : null,
      sources: rows,
      warning: cached.warning || '',
      dir: dirOfFollowSettings(dataDir, f),
    }
  }

  return {
    start, stop, kick, tick: () => recompute(),
    effectiveSessionId, view, snapshot,
    get warning () { return cached.warning },
    get sources () { return cached.sources },
    get state () { return { ...cached, lastKnown } },
  }
}
