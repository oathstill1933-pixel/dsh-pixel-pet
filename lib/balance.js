/**
 * DeepSeek API 余额（宿主侧，懒取；做法同其它 DSH 插件的余额读取）。
 *
 *   GET https://api.deepseek.com/user/balance, Authorization: Bearer <key>
 *   -> { is_available, balance_infos: [{ currency: 'CNY'|'USD', total_balance, granted_balance, topped_up_balance }] }
 *
 * - 用到才查：缓存 5 分钟（内存 + <dataDir>/balance.json，只存数字/币种/时间/low），超时 8 s；失败静默返回旧缓存或 null。
 * - key 只存 <dataDir>/balance-settings.json，只出现在请求头；不进日志、缓存、接口返回、提示词。
 * - baseUrl 不是官方 https://api.deepseek.com 时功能不可用，绝不发出 key。
 * - 注入：agent/pre-step，只给桌宠绑定的会话，每轮最多一次、同会话至少隔 60 s，追加一行「DeepSeek 余额 ¥23.40（偏低）」。
 *
 * Routes (host.js mounts them behind its origin check):
 *   GET  /api/balance            -> view (cached, may trigger a lazy fetch)
 *   POST /api/balance/refresh    -> force fetch
 *   POST /api/balance/settings   { key?, threshold?, baseUrl?, inject? }   key '' removes it
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { petMessageId } from './relay.js'

export const OFFICIAL_BASE = 'https://api.deepseek.com'
export const DEFAULT_THRESHOLD = 10
export const TTL_MS = 5 * 60_000
export const TIMEOUT_MS = 8_000
const MIN_INJECT_GAP_MS = 60_000
const KEY_MAX = 300

/** Only the official host, https, default port. A proxy / mirror is refused (the key never goes there). */
export function isOfficialBase (raw) {
  const s = String(raw == null || raw === '' ? OFFICIAL_BASE : raw).trim()
  let u
  try { u = new URL(s) } catch { return false }
  return u.protocol === 'https:' && u.hostname === 'api.deepseek.com' && (u.port === '' || u.port === '443') &&
    !u.username && !u.password && /^\/?(v1\/?)?$/.test(u.pathname) && !u.search && !u.hash
}

const money = (v) => { const n = Number(String(v ?? '').trim()); return v !== '' && v != null && Number.isFinite(n) ? Math.round(n * 100) / 100 : null }

/** Response JSON -> { isAvailable, currency, total, granted, toppedUp }; throws on an unknown shape. */
export function parseBalance (j) {
  if (!j || typeof j !== 'object' || typeof j.is_available !== 'boolean' || !Array.isArray(j.balance_infos)) throw new Error('shape')
  const infos = j.balance_infos.filter((x) => x && typeof x === 'object' && /^[A-Z]{3}$/.test(String(x.currency || '')))
  const main = infos.find((x) => x.currency === 'CNY') || infos[0]
  const total = main ? money(main.total_balance) : null
  if (total === null) throw new Error('total')
  return { isAvailable: j.is_available, currency: main.currency, total, granted: money(main.granted_balance), toppedUp: money(main.topped_up_balance) }
}

const cleanThreshold = (v) => { const n = Number(v); return v !== '' && v !== null && Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : undefined }
const sessionKey = (v) => { const s = String(v || '').trim(); return s.startsWith('session-') ? s.slice(8) : s }

export function balanceLine (b) {
  if (!b || typeof b.total !== 'number') return null
  return 'DeepSeek 余额 ' + (b.currency === 'USD' ? '$' : '¥') + b.total.toFixed(2) + (b.low ? '（偏低）' : '')
}

/**
 * @param {{ dataDir: string, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number, pointed?: () => string }} o
 *   pointed: the pet's bound session id (settings.voice.llm.sessionId)
 */
export function createBalance ({ dataDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS, pointed = () => '', onStep = null }) {
  const settingsFile = join(dataDir, 'balance-settings.json')
  const cacheFile = join(dataDir, 'balance.json')
  const writeJson = (file, obj) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    renameSync(tmp, file)
  }
  const readJson = (file) => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} } }
  const readSettings = () => {
    const j = readJson(settingsFile)
    return {
      key: typeof j.key === 'string' ? j.key : '',
      baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl.trim() : '',
      threshold: cleanThreshold(j.threshold) ?? DEFAULT_THRESHOLD,
      inject: j.inject !== false,
    }
  }

  let cache = (() => { const c = readJson(cacheFile); return typeof c.at === 'number' && typeof c.total === 'number' ? c : null })()
  let inflight = null

  const fetchOnce = async (key, base) => {
    const ctl = new AbortController()
    let to
    const timeout = new Promise((_, bad) => { to = setTimeout(() => { ctl.abort(); bad(new Error('timeout')) }, timeoutMs) })
    try {
      const url = (base || OFFICIAL_BASE).replace(/\/+$/, '').replace(/\/v1$/, '') + '/user/balance'
      const res = await Promise.race([fetchImpl(url, { method: 'GET', headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: ctl.signal }), timeout])
      if (!res.ok) throw new Error('http')
      return parseBalance(await Promise.race([res.json(), timeout]))
    } finally { clearTimeout(to) }
  }

  /** -> cached { currency, total, granted, toppedUp, isAvailable, low, at } | null. Never throws. */
  const get = (force = false) => {
    const s = readSettings()
    if (!s.key || !isOfficialBase(s.baseUrl)) return Promise.resolve(null)
    if (!force && cache && now() - cache.at < TTL_MS) return Promise.resolve(withLow(cache, s))
    if (inflight) return inflight
    inflight = fetchOnce(s.key, s.baseUrl).then((r) => {
      cache = { ...r, at: now() }
      cache.low = cache.currency !== 'USD' && cache.total < s.threshold
      try { writeJson(cacheFile, cache) } catch {}
      return cache
    }, () => (cache ? withLow(cache, readSettings()) : null)).finally(() => { inflight = null })
    return inflight
  }
  const withLow = (c, s) => ({ ...c, low: c.currency !== 'USD' && c.total < s.threshold })

  const view = async (force) => {
    const s = readSettings()
    const b = await get(force)
    return { configured: !!s.key, official: isOfficialBase(s.baseUrl), threshold: s.threshold, inject: s.inject, balance: b }
  }

  /** AI-facing (pixelpet_status), synchronous: last cached numbers only, kicks a lazy refresh when stale. */
  const status = () => {
    const s = readSettings()
    if (!s.key) return { available: false, reason: 'nokey' }
    if (!isOfficialBase(s.baseUrl)) return { available: false, reason: 'unofficial' }
    get().catch(() => {})
    if (!cache) return { available: false, reason: 'pending' }
    const c = withLow(cache, s)
    return { available: true, currency: c.currency, total: c.total, granted: c.granted, toppedUp: c.toppedUp, isAvailable: c.isAvailable, low: c.low, threshold: s.threshold, at: c.at }
  }

  const saveSettings = (patch) => {
    const p = patch && typeof patch === 'object' ? patch : {}
    const next = readSettings()
    if (typeof p.key === 'string') {
      const k = p.key.trim()
      if (k.length > KEY_MAX || /[\s\x00-\x1f]/.test(k)) return { ok: false, message: 'Key 格式不对' }
      if (k !== next.key) cache = null
      next.key = k
    }
    if (typeof p.baseUrl === 'string') { const b = p.baseUrl.trim().slice(0, 300); if (b !== next.baseUrl) cache = null; next.baseUrl = b }
    if (p.threshold !== undefined) { const t = cleanThreshold(p.threshold); if (t === undefined) return { ok: false, message: '阈值不对' }; next.threshold = t }
    if (typeof p.inject === 'boolean') next.inject = p.inject
    writeJson(settingsFile, next)
    return { ok: true }
  }

  /** -> { code, body } */
  const handle = async (method, path, body) => {
    if (path === '/api/balance' && method === 'GET') return { code: 200, body: { ok: true, ...(await view(false)) } }
    if (path === '/api/balance/refresh' && method === 'POST') return { code: 200, body: { ok: true, ...(await view(true)) } }
    if (path === '/api/balance/settings' && method === 'POST') {
      const r = saveSettings(body)
      return r.ok ? { code: 200, body: { ok: true, ...(await view(false)) } } : { code: 400, body: r }
    }
    return { code: 404, body: { ok: false } }
  }

  /** One line for the pet's bound session, or null (not that session / off / no data). */
  const injectLine = async (sessionId) => {
    const s = readSettings()
    const want = sessionKey(pointed())
    if (!s.inject || !want || sessionKey(sessionId) !== want) return null
    return balanceLine(await get())
  }

  /** agent/pre-step hook (same shape as other DSH context plugins). Returns the disposer or null. */
  const attach = (ctx) => {
    if (!ctx || typeof ctx.on !== 'function') return null
    const injected = new WeakMap()
    return ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
      const decision = await next()
      // one pre-step listener for the plugin: lib/session-guard.js reads the tool header here as well
      if (typeof onStep === 'function') { try { onStep(agent) } catch {} }
      try {
        if (!decision || decision.kind === 'reject' || signal?.aborted) return decision
        const session = agent && agent.session
        if (!session) return decision
        const t = now()
        const prev = injected.get(session)
        if (prev && (prev.turn === turn || t - prev.at < MIN_INJECT_GAP_MS)) return decision
        const text = await injectLine(session.id || agent.id)
        if (!text || signal?.aborted) return decision
        injected.set(session, { turn, at: t })
        const message = { role: 'user', id: petMessageId(randomUUID()), content: [{ type: 'text', text }], source: { kind: 'pixel-pet', form: 'snapshot', sections: [{ name: 'dsh-pixel-pet-balance', text }] } }
        return { ...decision, messages: [...(decision.messages || []), message] }
      } catch { return decision }
    }, { prepend: true })
  }

  return { get, view, status, saveSettings, handle, injectLine, attach }
}
