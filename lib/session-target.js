/**
 * Which DSH session the pet talks to: list choices (incl. sessions not loaded since DSH started) and
 * wake a cold one on demand.
 *
 * Host APIs (all optional, looked up with ctx.get so the plugin still loads without them):
 *   sessionQuery.listSessions(signal)         -> [{ header: { id, origin?, parentSession?, cwd? }, live, persisted }]
 *                                                every live + persisted session, newest first, without loading any
 *   sessionQuery.readTitleSnapshots(ids)      -> [{ status, value: { title?: { title } } }] title folded from the log
 *   sessions.list() / sessionTitle.get(s)     -> live sessions only (fallback when sessionQuery is absent)
 *   workspaceRegistry.archivedSessionIds      -> archived ids (hidden from the list; never woken)
 *   typert.lookups.get('agent').resolve(id)   -> the same resume the DSH GUI uses (presets / tools / model mounted,
 *                                                concurrent resumes deduplicated by the host)
 *   agents.resume({ resumeSessionId, agentOptions, signal }) -> { agent, dispose } fallback when the lookup is absent
 *
 * Lifetime of a fallback resume: DSH binds the resumed agent to the calling ctx (agent-loop prepare() registers
 * its teardown as an effect of ownerCtx, and teardown is idempotent). We still keep the handle and release it in
 * dispose() so the plugin's own teardown is explicit and ordered; a second release by the host is a no-op.
 * Agents obtained through the typert lookup belong to the GUI's resume and are never released here.
 */

const COLD_LIMIT = 30          // cold sessions offered besides the live ones (titles cost one log fold each)
const LIST_TTL_MS = 8000       // the settings page polls every 4 s
const RESUME_TIMEOUT_MS = 60_000

const key = (id) => { const s = String(id ?? '').trim(); return s.startsWith('session-') ? s.slice(8) : s }
const svc = (ctx, name) => { try { return (ctx.get && ctx.get(name)) || ctx[name] } catch { return undefined } }

export function archivedKeys (ctx) {
  const out = new Set()
  try { for (const x of (svc(ctx, 'workspaceRegistry')?.archivedSessionIds || [])) out.add(key(x)) } catch {}
  return out
}

/** live agent for an id, tolerant of the "session-" prefix */
export function liveAgent (ctx, id) {
  const raw = String(id || '').trim()
  if (!raw) return undefined
  for (const c of [raw, raw.startsWith('session-') ? raw.slice(8) : 'session-' + raw]) {
    try { const a = ctx.agents && ctx.agents.get(c); if (a) return a } catch {}
  }
  return undefined
}

function errorText (e) {
  const code = String((e && (e.code || e.name)) || '')
  const msg = String((e && e.message) || e || '')
  if (/not-found|NOT_FOUND|not found|not resumable/i.test(code + ' ' + msg)) return { code: 404, message: '会话已被删除，换一个会话' }
  if (/writer-held|AlreadyOwned/i.test(code + ' ' + msg)) return { code: 409, message: '会话被别处占用，稍后再试' }
  if (/abort|timeout/i.test(code + ' ' + msg)) return { code: 504, message: '唤醒会话超时' }
  return { code: 502, message: '唤醒会话失败：' + msg.slice(0, 160) }
}

const release = (handle) => Promise.resolve().then(() => handle.dispose()).catch(() => {})

export function createSessionTarget (ctx, { coldLimit = COLD_LIMIT, listTtlMs = LIST_TTL_MS, resumeTimeoutMs = RESUME_TIMEOUT_MS } = {}) {
  const titles = new Map()     // cold session id -> title ('' = none); a cold log does not change until it is woken
  const resuming = new Map()   // key -> Promise<{ agent } | { code, message }>
  let cache = null             // { at, records: [{ header, live }] | null }
  const handles = new Map()    // key -> AgentHandle from ctx.agents.resume (ours to release)
  let disposed = false

  const liveTitle = (s) => {
    try { const t = svc(ctx, 'sessionTitle')?.get?.(s); return t && t.title ? String(t.title) : '' } catch { return '' }
  }

  /** every session the host knows about, or null when sessionQuery is unavailable */
  const records = async () => {
    if (cache && Date.now() - cache.at < listTtlMs) return cache.records
    const q = svc(ctx, 'sessionQuery')
    let out = null
    if (q && typeof q.listSessions === 'function') {
      try { out = await q.listSessions() } catch { out = null }
    }
    cache = { at: Date.now(), records: Array.isArray(out) ? out : null }
    return cache.records
  }

  const coldTitles = async (ids) => {
    const need = ids.filter((id) => !titles.has(id))
    const q = svc(ctx, 'sessionQuery')
    if (!need.length || !q || typeof q.readTitleSnapshots !== 'function') return
    try {
      const got = await q.readTitleSnapshots(need)
      need.forEach((id, i) => {
        const r = got && got[i]
        const t = r && r.status === 'fulfilled' && r.value && r.value.title ? r.value.title.title : ''
        titles.set(id, t ? String(t) : '')
      })
    } catch {}
  }

  /**
   * Choices for the settings page. `savedId` is always present: as a cold entry when it exists but is not
   * loaded, with `missing: true` when the host no longer has it, with `archived: true` when archived.
   * Live entries stay `{ id, title }`.
   */
  const list = async (savedId) => {
    const archived = archivedKeys(ctx)
    const live = []
    try { for (const s of (svc(ctx, 'sessions')?.list?.() || [])) live.push(s) } catch {}
    const out = []
    const seen = new Set()
    for (const s of live) {
      const id = String(s.id)
      if (archived.has(key(id)) || (s.header && (s.header.origin === 'subagent' || s.header.parentSession !== undefined))) continue
      seen.add(key(id)); out.push({ id, title: liveTitle(s) })
    }
    const all = await records()
    const known = new Set(all ? all.map((r) => key(r.header && r.header.id)) : [])
    const saved = key(savedId)
    if (all) {
      const cold = []
      for (const r of all) {
        const h = r && r.header
        if (!h || !h.id || seen.has(key(h.id)) || archived.has(key(h.id))) continue
        if (h.origin === 'subagent' || h.parentSession !== undefined || h.cwd === undefined) continue
        if (cold.length < coldLimit || key(h.id) === saved) cold.push(String(h.id))
      }
      await coldTitles(cold)
      for (const id of cold) { seen.add(key(id)); out.push({ id, title: titles.get(id) || '', cold: true }) }
    }
    if (saved && !seen.has(saved)) {
      const id = String(savedId).trim()
      const e = { id, title: '', cold: true }
      if (archived.has(saved)) e.archived = true
      else if (all && !known.has(saved)) e.missing = true
      if (e.archived && all) { await coldTitles([id]); e.title = titles.get(id) || '' }
      out.push(e)
    }
    return out
  }

  const exactId = async (id) => {
    const all = await records()
    const k = key(id)
    const r = all && all.find((x) => x && x.header && key(x.header.id) === k)
    return { id: r ? String(r.header.id) : String(id).trim(), known: !!r, all }
  }

  const wake = async (id) => {
    if (archivedKeys(ctx).has(key(id))) return { code: 409, message: '会话已归档，先在 DSH 里取消归档' }
    const { id: exact, known, all } = await exactId(id)
    if (all && !known) return { code: 404, message: '会话已被删除，换一个会话' }
    const lookup = (() => { try { return svc(ctx, 'typert')?.lookups?.get?.('agent') } catch { return undefined } })()
    const canResume = ctx.agents && typeof ctx.agents.resume === 'function'
    if (!(lookup && typeof lookup.resolve === 'function') && !canResume) return { code: 404, message: '会话不在线' }
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(resumeTimeoutMs) : undefined
    try {
      let agent
      if (lookup && typeof lookup.resolve === 'function') {
        agent = await Promise.race([
          lookup.resolve(exact),
          new Promise((_, bad) => { const t = setTimeout(() => bad(Object.assign(new Error('timeout'), { code: 'timeout' })), resumeTimeoutMs); t.unref?.() }),
        ])
      } else {
        let agentOptions
        try { const sel = svc(ctx, 'agentDefaultModel')?.currentSelection?.(); if (sel && sel.provider && sel.model) agentOptions = { provider: sel.provider, model: sel.model } } catch {}
        const handle = await ctx.agents.resume({ resumeSessionId: exact, ...(agentOptions ? { agentOptions } : {}), ...(signal ? { signal } : {}) })
        if (handle && typeof handle.dispose === 'function') {
          if (disposed) { release(handle); return { code: 503, message: '桌宠插件正在关闭' } }
          const old = handles.get(key(exact)); if (old && old !== handle) release(old)
          handles.set(key(exact), handle)
        }
        agent = handle && handle.agent
      }
      agent = liveAgent(ctx, exact) || agent
      if (!agent || typeof agent.followup !== 'function') return { code: 502, message: '唤醒会话失败：没拿到会话' }
      cache = null
      return { agent }
    } catch (e) {
      const raced = liveAgent(ctx, exact)
      if (raced) return { agent: raced }
      return errorText(e)
    }
  }

  /** live agent, or wake the session once (concurrent callers share the same resume) */
  const agentFor = async (id) => {
    const a = liveAgent(ctx, id)
    if (a) return { agent: a }
    const k = key(id)
    if (!k) return { code: 400, message: '没选会话' }
    let p = resuming.get(k)
    if (!p) {
      p = wake(id).finally(() => resuming.delete(k))
      resuming.set(k, p)
    }
    return p
  }

  /** release every agent this plugin resumed through the fallback path */
  const dispose = async () => {
    disposed = true
    const all = [...handles.values()]; handles.clear()
    await Promise.all(all.map(release))
  }

  return { list, agentFor, resuming, handles, dispose }
}
