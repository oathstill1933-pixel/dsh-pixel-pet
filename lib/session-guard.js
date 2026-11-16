/**
 * The pet's bound session (settings.voice.llm.sessionId), seen from the host: tool gap.
 *
 * Which pixelpet_* tools this plugin registered are NOT offered to the model in that session.
 * Observed, not guessed: DSH logs a `request/header` session event whose `data.header.tools` is the exact
 * ToolSchema[] sent to the model (after tools.restrict and system-prompt/assemble filtering, e.g. clawd's
 * allowlist). It is only re-logged when tools change; `session.requestHeader()` is the live fold of it.
 * We read both: the event when it arrives, the fold on every agent/pre-step of the bound session.
 * No header (new session, old DSH) -> { available: false, reason } and never a made-up "missing" list.
 * Memory + <dataDir>/toolgap.json keep tool names (and the preset name) only.
 *
 * (There is no per-preset "don't tell" privacy list: to keep something from an AI, switch the feature or the
 * plugin off.)
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const sessionKey = (id) => { const s = String(id ?? '').trim(); return s.startsWith('session-') ? s.slice(8) : s }

/** EpochHeader-ish -> tool names, or null when there is no tool list to read */
export function toolNamesOf (header) {
  if (!header || typeof header !== 'object') return null
  const t = header.tools
  if (t === undefined) return [] // canonicalHeader drops an empty list
  if (!Array.isArray(t)) return null
  return t.map((x) => (x && typeof x.name === 'string' ? x.name : '')).filter(Boolean)
}

/**
 * @param {{ dataDir: string, settings: () => any, registered: () => string[], now?: () => number }} o
 *   registered: pixelpet_* names this plugin currently has registered (after def.when)
 */
export function createSessionGuard ({ dataDir, settings, registered, now = Date.now }) {
  const file = join(dataDir, 'toolgap.json')
  const pointed = () => { try { return sessionKey(settings().voice.llm.sessionId) } catch { return '' } }
  const ours = () => { try { return (registered() || []).filter((n) => /^pixelpet_/.test(n)) } catch { return [] } }

  /** sessionKey -> preset name seen on live session objects (memory only) */
  const meta = new Map()
  let seen = (() => {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j.sessionId === 'string' ? j : null } catch { return null }
  })()
  let headerApi = null // true once a session exposed requestHeader / a request/header event was seen

  const noteHeader = (session) => {
    const h = session && session.header
    const id = sessionKey((h && h.id) || (session && session.id))
    if (!id || !h || typeof h !== 'object') return
    meta.set(id, typeof h.agentPreset === 'string' ? h.agentPreset : null)
    if (meta.size > 200) meta.delete(meta.keys().next().value)
  }

  const save = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(seen), 'utf8')
      renameSync(tmp, file)
    } catch {}
  }

  /** names: full tool list the model got this step (only pixelpet_* are kept) */
  const record = (id, names) => {
    const mine = ours()
    const offered = names.filter((n) => /^pixelpet_/.test(n))
    const missing = mine.filter((n) => !names.includes(n)).sort()
    const next = { sessionId: id, preset: meta.get(id) || null, offered: offered.sort(), missing, checkedAt: now() }
    const changed = !seen || seen.sessionId !== next.sessionId || seen.preset !== next.preset ||
      JSON.stringify(seen.offered) !== JSON.stringify(next.offered) || JSON.stringify(seen.missing) !== JSON.stringify(next.missing)
    const savedAt = seen && seen.savedAt
    seen = next
    if (changed || !savedAt || next.checkedAt - savedAt > 10 * 60_000) { seen.savedAt = next.checkedAt; save() } else seen.savedAt = savedAt
  }

  /** session/event listener: request/header carries the exact tool list of the next request */
  const onEvent = (session, event) => {
    try {
      noteHeader(session)
      if (!event || event.type !== 'request/header') return
      headerApi = true
      const id = sessionKey((session && session.header && session.header.id) || (session && session.id))
      if (!id || id !== pointed()) return
      const names = toolNamesOf(event.data && event.data.header)
      if (names) record(id, names)
    } catch {}
  }

  /** agent/pre-step: header metadata + the folded current request header */
  const onStep = (agent) => {
    try {
      const session = agent && agent.session
      if (!session) return
      noteHeader(session)
      const id = sessionKey((session.header && session.header.id) || session.id || agent.id)
      if (!id || id !== pointed()) return
      if (typeof session.requestHeader !== 'function') { if (headerApi === null) headerApi = false; return }
      headerApi = true
      const names = toolNamesOf(session.requestHeader())
      if (names) record(id, names)
    } catch {}
  }

  const attach = (ctx) => {
    if (!ctx || typeof ctx.on !== 'function') return null
    return ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      onStep(payload && payload.agent)
      return decision
    })
  }

  /** GET /api/toolgap */
  const view = () => {
    const id = pointed()
    const preset = meta.get(id) || (seen && seen.sessionId === id ? seen.preset : null) || null
    const base = { ok: true, sessionId: id || null, preset }
    if (!id) return { ...base, available: false, reason: 'unbound', missing: [], checkedAt: null }
    if (!seen || seen.sessionId !== id) {
      return { ...base, available: false, reason: headerApi === false ? 'no-header-api' : 'pending', missing: [], checkedAt: null }
    }
    // registrations may have changed since the check: recompute against what we have registered now
    const mine = ours()
    const missing = mine.filter((n) => !seen.offered.includes(n)).sort()
    return { ...base, available: true, missing, checkedAt: seen.checkedAt }
  }

  return { onEvent, onStep, attach, view, meta }
}
