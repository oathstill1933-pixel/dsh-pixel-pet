/**
 * 声纹（voiceprint）host 侧胶水：设置收口 + 一个路由处理器。
 *
 * 三条边界的落点：
 *  1. settings 里只留 `{enabled, mode, strictness}`——`/api/state` 会把 settings 发给每个会话，
 *     写人名就等于向所有会话泄露。所以 sanitizeVoiceprint 是白名单，多余字段一律丢掉。
 *  2. 人名只走 `/api/voiceprint/people`（用户自己打开设置页才会请求），并且只回 `{name, n}`。
 *  3. agent 侧只拿得到 `{enabled, enrolled, last}`：`agentSummary()` 里没有姓名、没有分数、
 *     没有槽位、没有向量；`last` 只可能是 'pass' | 'reject' | null。
 *
 * 与桌宠的通信只有一件事：`{cmd: 'voiceprint', action: ...}` 走本机控制口（一次性 token）。
 * 没有「传音频」或「取向量」的动作，也不会有。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

export const VOICEPRINT_DEFAULT = { enabled: false, mode: 'disk', strictness: 0.5 }

const MODES = new Set(['disk', 'memory'])
const ACTIONS = new Set(['enroll', 'delete', 'clear', 'test'])

const loopback = (s) => /^(127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/.test(s || '')
const equalKey = (a, b) => {
  const x = Buffer.from(typeof a === 'string' ? a : '')
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Browser-only gate: loopback socket AND loopback Host AND same-origin provenance.
 * Custom header prevents simple form/CSRF requests. Never trust forwarded headers.
 * A per-process capability additionally authenticates each operation after bootstrap.
 */
export function localUiRequest (req) {
  if (!req || !loopback(req.socket?.remoteAddress)) return false
  try {
    const base = new URL('http://' + req.headers.host)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) return false
    if (req.headers['x-pixelpet-ui'] !== '1') return false
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '')
    // No Origin/Referer (GET from a no-referrer frame, e.g. inside the DSH window): the custom
    // X-Pixelpet-UI header already forces a CORS preflight for any other origin, which this server
    // never answers, so a loopback socket + loopback Host + that header is enough. A present but
    // different origin is still refused.
    if (!origin) return true
    return origin === base.origin
  } catch { return false }
}

export function sanitizeVoiceprint (value) {
  const out = { ...VOICEPRINT_DEFAULT }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  // Malformed enabled must never silently turn an active gate off.
  out.enabled = value.enabled === undefined ? false : (typeof value.enabled === 'boolean' ? value.enabled : true)
  out.mode = MODES.has(value.mode) ? value.mode : 'disk'
  const s = Number(value.strictness)
  out.strictness = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5
  return out
}

/** 从桌宠 status 里挑出可以给 agent 看的部分（白名单，别透传）。 */
export function agentSummary (raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const enrolled = Number.isInteger(v.enrolled) && v.enrolled >= 0 ? Math.min(v.enrolled, 5) : 0
  return {
    enabled: v.enabled === true,
    enrolled: v.enabled === true ? enrolled : 0,
    last: v.last === 'pass' || v.last === 'reject' ? v.last : null,
  }
}

/** 设置页可见状态：可以带 reason/encrypted/echo 这类说明，但**不含姓名与向量**。 */
export function uiStatus (raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const allow = ['enabled', 'mode', 'enrolled', 'ready', 'reason', 'encrypted', 'memory',
    'echoReady', 'echo', 'last', 'message', 'strictness']
  const out = {}
  for (const k of allow) if (['string', 'number', 'boolean'].includes(typeof v[k]) || v[k] === null) out[k] = v[k]
  return out
}

/** short human message from the pet (Chinese text it wrote itself); never data fields */
const withMsg = (r) => { const m = safeMsg(r); return m ? { ok: r.ok === true, message: m } : { ok: r.ok === true } }
function safeMsg (r) {
  const m = r && typeof r.message === 'string' ? r.message : ''
  return m.slice(0, 60)
}

function personList (raw) {
  const list = raw && Array.isArray(raw.people) ? raw.people : []
  return list
    .filter((p) => p && typeof p.name === 'string')
    .slice(0, 5)
    .map((p) => ({ name: p.name.slice(0, 24), n: Number.isInteger(p.n) ? p.n : 0 }))
}

/**
 * @param {{ send: (body: object) => Promise<object> }} o  send = tools.js 的 sendCommand(dataDir, body)
 */
export function createVoicePrintApi ({ send, installModel }) {
  const capability = randomBytes(32).toString('base64url')
  const call = async (action, extra) => {
    const body = { cmd: 'voiceprint', action, ...(extra || {}) }
    try {
      const r = await send(body)
      return r && typeof r === 'object' ? r : { ok: false, message: '桌宠没有回应' }
    } catch (e) {
      return { ok: false, message: '桌宠声纹控制暂时不可用' }
    }
  }

  return {
    status: async () => {
      const r = await call('status')
      return { ok: r.ok !== false, ...uiStatus(r.data || r.extra || r) }
    },
    people: async () => {
      const r = await call('people')
      const src = r.data || r.extra || r
      return { ok: r.ok !== false, people: personList(src), max: 5 }
    },
    enroll: async () => { const r = await call('enroll'); return withMsg(r) },
    remove: async (name) => { const r = await call('delete', { name: String(name || '').slice(0, 24) }); return { ok: r.ok === true } },
    clear: async () => { const r = await call('clear'); return { ok: r.ok === true } },
    test: async () => { const r = await call('test'); return withMsg(r) },

    /** host.js 只需要这一行：返回 null 表示「不是声纹的路径」。 */
    async handle (method, path, body, req) {
      if (path !== '/api/voiceprint' && !path.startsWith('/api/voiceprint/')) return null
      if (!localUiRequest(req)) return { code: 403, body: { ok: false } }
      if (path === '/api/voiceprint/session' && method === 'GET') return { body: { ok: true, capability } }
      if (!equalKey(req.headers['x-pixelpet-voiceprint'], capability)) return { code: 401, body: { ok: false } }
      if (method === 'GET') {
        if (path === '/api/voiceprint') return { body: await this.status() }
        if (path === '/api/voiceprint/people') return { body: await this.people() }
        return { code: 404, body: { ok: false } }
      }
      if (method !== 'POST') return { code: 405, body: { ok: false } }
      const action = path.slice('/api/voiceprint/'.length)
      if (action === 'model') {
        const r = typeof installModel === 'function' ? await installModel() : { ok: false }
        return { body: { ok: r?.ok === true } }
      }
      if (!ACTIONS.has(action)) return { code: 404, body: { ok: false } }
      if (action === 'delete') {
        const all = body && body.all === true
        const name = body && typeof body.name === 'string' ? body.name.slice(0, 24) : ''
        if (!all && !name) return { code: 400, body: { ok: false, message: '没说删谁' } }
        const r = await call('delete', all ? { all: true } : { name })
        return { body: { ok: r.ok === true } }
      }
      const r = await call(action)
      return { body: withMsg(r) }
    },
  }
}
