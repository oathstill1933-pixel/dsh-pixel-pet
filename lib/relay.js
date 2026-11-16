/**
 * Long-task relay v1: accept a DSH followup immediately, then poll/stream its result.
 *
 * 为什么不复用 host.js 里的 createRelay：那个是「一问一答、等整轮结束」的实现，请求进来要等
 * resume + followup + 整轮生成才能返回；长任务会撞 HTTP 超时，而且丢了「到底发出去没有」。
 * 这个模块提供 start/lookup/result 三段式（202 立即回执 → 轮询/心跳 → 终态），
 * 同时**保留**旧 ask/post/onEvent/pending/target 语义，host.js 只要把导出换成这里就行
 * （本文件不 import host.js，避免环）。
 *
 * 关键不变量（与 .tmp/long-task-v1-contract.md 对齐）：
 *  - start() 先占额度、同步返回 202，绝不 await resume/followup；
 *  - 同一 requestId + owner + session + fingerprint 永不重发；改内容 → 409；
 *  - owner/session 不符 → 404（不泄露「这个 ID 存在但属于别人」）；
 *  - 该会话在跑别的任务 → 409；全局容量满 → 503（都不发 followup）；
 *  - delivery: 调 followup 之前是 not-sent，调之前一瞬置 unknown（同步抛也可能已经跨界）；
 *    只有 followup 正回执或看到匹配的 user/message 才变 accepted；
 *  - 只认「接纳了这条消息的那个 turn」的 assistant/message + turn/end；
 *  - 30 分钟硬上界（含提交 + 等待）；终态记录留 5 分钟供重试/轮询；不驱逐在途任务腾容量；
 *  - 迟到回调不能结束/删除更新的 job；dispose 只结算自己的 waiter，不取消 DSH 任务。
 */
import { randomUUID } from 'node:crypto'
import { cleanReplyText } from './reply-clean.js'
import { createSessionTarget } from './session-target.js'

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const TTL_TERMINAL_MS = 5 * 60_000
const MAX_JOBS = 128
const MAX_ID_LEN = 120
const DEFAULT_WAIT_MS = 10_000
const TERMINAL = new Set(['completed', 'failed', 'expired'])

// progress v1（可选增量）：有界积压 + job 内单调 seq
const MAX_UPDATES = 64
const MAX_UPDATE_CHARS = 32_000
const MAX_UPDATE_TEXT = 4_000     // 单条超过这个就不进 updates（只留作最终 reply）
const MAX_SEEN_IDS = 128
const SKIP_CHANNEL = /analysis|reasoning|thinking|internal|tool/i

export const RELAY_LIMITS = {
  DEFAULT_TIMEOUT_MS, TTL_TERMINAL_MS, MAX_JOBS, MAX_ID_LEN, DEFAULT_WAIT_MS,
  MAX_UPDATES, MAX_UPDATE_CHARS, MAX_UPDATE_TEXT, MAX_SEEN_IDS,
}

export const sessionKey = (id) => {
  const s = String(id ?? '').trim()
  return s.startsWith('session-') ? s.slice(8) : s
}

/**
 * 桌宠发出的每条消息 id 都带这个前缀（`pixel-pet-<uuid>`）。
 * 桥那边判断「这一轮要不要发回平台」时，除了看 `source.kind === 'pixel-pet'`，还可以按这个前缀兜底
 * （读不到 source 字段的老桥）。两样都不改变对话正文。
 */
export const PET_MESSAGE_PREFIX = 'pixel-pet-'
export const petMessageId = (id) => PET_MESSAGE_PREFIX + String(id ?? '')

/** assistant message -> plain text（本地实现，避免 import host.js） */
export function extractText (message) {
  const parts = message && Array.isArray(message.content) ? message.content : []
  return parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('').trim()
}

const badId = (v) => typeof v !== 'string' || !v.trim() || v.length > MAX_ID_LEN || /[\u0000-\u001f]/.test(v)

function snapshot (job, timeoutMs) {
  const out = {
    ok: true,
    protocol: 1,
    requestId: job.requestId,
    sessionId: job.sessionId,
    state: job.state,
    delivery: job.delivery,
    accepted: job.delivery === 'accepted',
    turn: job.turn == null ? null : job.turn,
    timeoutMs,
    updateSeq: job.updateSeq || 0,
    updates: [],
  }
  if (job.reply !== undefined) out.reply = job.reply
  if (job.message) out.message = job.message
  if (job.replySeq != null) out.replySeq = job.replySeq
  return out
}

/** 带 cursor 的快照：只有「非负整数 afterSeq」才 opt-in，老客户端永远拿空 updates，不会空转。 */
function snapshotFor (job, timeoutMs, afterSeq) {
  const out = snapshot(job, timeoutMs)
  if (!Number.isInteger(afterSeq) || afterSeq < 0) return out
  out.updates = (job.updates || []).filter((u) => u.seq > afterSeq)
  out.afterSeq = afterSeq
  return out
}

const closedBody = (message) => ({ ok: false, closed: true, protocol: 1, message: message || '桌宠插件正在关闭' })

/**
 * @param {object} ctx DSH host ctx（透传给 createSessionTarget）
 * @param {number} timeoutMs 单任务硬上界，默认 30 分钟
 * @param {{decorate?:Function, clock?:Function, setTimeout?:Function, clearTimeout?:Function,
 *          findAgent?:Function, target?:object, onTurn?:Function}} hooks 测试注入点（timer/clock/findAgent）
 *   onTurn({ source, ok, ms, tokens? })：桌宠发起的一次模型请求（ask / job）结束时回调一次，
 *   source 是调用方在 opts.source 里标的（hub/mail/reading/music/care，缺省 other），ok = 是否正常完成，
 *   ms = 耗时，tokens = 该轮 assistant/message 的 usage 累计（DSH 事件带才有，不带就省略，不估算）。
 */
export function createRelay (ctx, timeoutMs = DEFAULT_TIMEOUT_MS, hooks = {}) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  const clock = hooks.clock || (() => Date.now())
  const setT = hooks.setTimeout || setTimeout
  const clearT = hooks.clearTimeout || clearTimeout

  const pending = new Map()   // sessionKey -> 在途 job 或旧式 ask slot（同一会话同时只允许一个）
  const jobs = new Map()      // requestId -> job（含终态，供 TTL 内重试/轮询）
  const openTurns = new Map() // sessionKey -> 当前 turn（哪怕没有 pending 也跟）
  const waiters = new Set()   // 旧式 ask 的 settle 函数（dispose 用）
  let disposed = false
  let target = hooks.target || null
  const targetOf = () => {
    if (!target) target = createSessionTarget(ctx)
    return target
  }
  const findAgent = hooks.findAgent || ((id) => targetOf().agentFor(id))

  const turnOf = (event) => (event && event.data && Number.isInteger(event.data.turn) ? event.data.turn : null)

  // ---------------------------------------------------------------- 内部：记账
  const dropSlot = (job) => {
    if (pending.get(job.key) === job) pending.delete(job.key)
  }

  /**
   * 结算 job 的 waiter。**每个 waiter 用自己的 cursor 生成 body**（progress v1 的关键）：
   * settleWaiters 只负责「现在该醒了」，过滤永远按 waiter 的 afterSeq 来，所以 terminal、
   * 重试、owner 轮换之后 cursor 语义都还在。
   */
  const settleWaiters = (job, { code = 200, closed = null } = {}) => {
    const list = job.waiters.splice(0)
    for (const w of list) {
      try { clearT(w.timer) } catch {}
      try { w.settle(closed || w.build(), code) } catch {}
    }
  }

  /** 有新的可读正文时，只唤醒「带了 cursor 且确实有增量」的 waiter；老客户端不动。 */
  const wakeProgressWaiters = (job) => {
    const list = job.waiters.slice()
    for (const w of list) {
      if (!Number.isInteger(w.cursor)) continue
      if (!(job.updates || []).some((u) => u.seq > w.cursor)) continue
      const i = job.waiters.indexOf(w)
      if (i >= 0) job.waiters.splice(i, 1)
      try { clearT(w.timer) } catch {}
      try { w.settle(w.build(), 200) } catch {}
    }
  }

  /** 追加一条公开正文（有界）。返回是否新写入。 */
  const pushUpdate = (job, { text, messageId, turn }) => {
    if (!text) return false
    if (text.length > MAX_UPDATE_TEXT) return false          // 太长：只留作最终 reply（走 Bridge fallback）
    if (!Number.isSafeInteger(job.updateSeq) || job.updateSeq >= Number.MAX_SAFE_INTEGER - 1) return false
    const seq = (job.updateSeq || 0) + 1
    job.updateSeq = seq
    // 信封只放 seq / text / messageId? / turn，绝不透传 role/channel 等内部字段
    const mid = typeof messageId === 'string' && messageId.length <= 120 && !/[\u0000-\u001f]/.test(messageId)
      ? messageId
      : ''
    job.updates.push({ seq, text, ...(mid ? { messageId: mid } : {}), turn: turn == null ? null : turn })
    // 上界：条数 + 总字数；从最老的开始丢。最终回复不靠这条记录（见 finalizeReply）
    let total = job.updates.reduce((a, u) => a + u.text.length, 0)
    while (job.updates.length > MAX_UPDATES || total > MAX_UPDATE_CHARS) {
      const gone = job.updates.shift()
      if (!gone) break
      total -= gone.text.length
    }
    job.updatedAt = clock()
    wakeProgressWaiters(job)
    return true
  }

  /**
   * turn/end 时定下最终正文。**不往 updates 里补**（超长或已被 ring 挤掉的都不补）：
   *  - 已经有同文本的 update → 记 replySeq，供上层「最终不重读」去重；
   *  - 没有（>4000 字 / 被挤掉）→ replySeq = null，走 Bridge 的最终 fallback 正常念一遍。
   */
  const finalizeReply = (job) => {
    const reply = cleanReplyText(job.reply || '')
    job.reply = reply
    if (!reply) { job.replySeq = null; return }
    const have = (job.updates || []).find((u) => u.text === reply)
    job.replySeq = have ? have.seq : null
  }

  const armTtl = (job) => {
    if (job.ttlTimer) return
    job.ttlTimer = setT(() => {
      if (jobs.get(job.requestId) === job && TERMINAL.has(job.state)) jobs.delete(job.requestId)
    }, TTL_TERMINAL_MS)
    job.ttlTimer?.unref?.()
  }

  const enterTerminal = (job, state, extra) => {
    if (job.settled && job.state !== 'submitting' && job.state !== 'pending') return
    job.state = state
    job.settled = true
    job.updatedAt = clock()
    if (extra) Object.assign(job, extra)
    dropSlot(job)
    if (job.timer) { try { clearT(job.timer) } catch {} job.timer = null }
    armTtl(job)
    // 模型请求结束（job 已发出才记；expired 由 dispose 直接改 state，不走这里）
    if (job.armed && typeof hooks.onTurn === 'function') {
      try {
        hooks.onTurn({
          source: job.source, ok: state === 'completed',
          ms: Math.max(0, clock() - job.createdAt),
          tokens: job.usage.seen ? { input: job.usage.input, output: job.usage.output } : undefined,
        })
      } catch {}
    }
    settleWaiters(job)
  }

  const markAccepted = (job) => {
    if (job.delivery === 'accepted') return
    if (job.state === 'failed' || job.state === 'expired') return
    job.delivery = 'accepted'
    if (job.state === 'submitting') job.state = 'pending'
    job.updatedAt = clock()
    settleWaiters(job)
  }

  const failJob = (job, code, message, delivery) => {
    if (TERMINAL.has(job.state)) return
    if (delivery && job.delivery !== 'accepted') job.delivery = delivery
    enterTerminal(job, 'failed', { message, code })
    job.failCode = code
  }

  const expireJob = (job) => {
    if (TERMINAL.has(job.state)) return
    enterTerminal(job, 'expired', { message: '任务超时未完成' })
  }

  // ---------------------------------------------------------------- onEvent
  const onJobEvent = (job, event) => {
    if (TERMINAL.has(job.state)) return
    if (event.type === 'turn/start') {
      job.openTurn = turnOf(event)
      if (job.seen && job.turn == null) job.turn = job.openTurn
      return
    }
    if (event.type === 'user/message') {
      // 只认我们自己发出去的那条（id 用 requestId 派生，见 start）
      if (!job.armed || job.seen || !event.data || event.data.id !== job.messageId) return
      job.seen = true
      // 被塞进一个已经开着的 turn（next-step inbox）时，答它的是那个 turn
      job.turn = job.openTurn
      markAccepted(job)
      return
    }
    if (!job.seen) {
      if (event.type === 'turn/end') job.openTurn = null
      return
    }
    if (event.type === 'assistant/message') {
      const turn = turnOf(event) ?? job.openTurn
      if (job.turn != null && turn != null && turn !== job.turn) return
      const data = event.data || {}
      const message = data.message || {}
      // 只收公开正文：非 assistant 角色、analysis/reasoning/tool 通道一律跳过
      if (message.role && message.role !== 'assistant') return
      const chan = String(data.channel || message.channel || '')
      if (chan && SKIP_CHANNEL.test(chan)) return
      // event.seq 单调闸：重投递/更旧的事件直接丢
      if (Number.isInteger(event.seq)) {
        if (Number.isInteger(job.lastEventSeq) && event.seq <= job.lastEventSeq) return
        job.lastEventSeq = event.seq
      }
      const raw = extractText(message)
      if (!raw) return
      const u = data.usage
      if (u) {
        job.usage.seen = true
        job.usage.input += Number(u.inputTokens) || 0
        job.usage.output += Number(u.outputTokens) || 0
      }
      // 稳定 message.id 去重（有界）：同一条助手消息重复到达只读一次
      const mid = typeof message.id === 'string' ? message.id : (typeof data.id === 'string' ? data.id : '')
      if (mid) {
        if (job.seenIds.has(mid)) return
        job.seenIds.add(mid)
        if (job.seenIds.size > MAX_SEEN_IDS) {
          const oldest = job.seenIds.values().next().value
          job.seenIds.delete(oldest)
        }
      }
      // Re-delivery must not roll the final reply back to an earlier assistant message.
      job.reply = raw
      if (!Number.isInteger(job.turn)) return // legacy unbound-turn messages keep final fallback only
      // turn 用**已绑定**的那个整数（不漂移），保证每条 update 的 turn 与 snapshot.turn 一致
      pushUpdate(job, { text: cleanReplyText(raw), messageId: mid || undefined, turn: job.turn })
      return
    }
    if (event.type === 'turn/end') {
      const turn = turnOf(event)
      // A mismatched end must not erase the still-active turn identity.
      if (job.turn != null && turn != null && turn !== job.turn) return
      job.openTurn = null
      const reason = event.data?.reason?.kind
      if (reason && reason !== 'completed') return failJob(job, 502, reason === 'aborted' ? '会话任务已停止' : '会话执行失败', job.delivery)
      finalizeReply(job)
      enterTerminal(job, 'completed')
    }
  }

  const onEvent = (session, event) => {
    const k = sessionKey(session && session.id)
    if (event && event.type === 'turn/start') openTurns.set(k, turnOf(event))
    else if (event && event.type === 'turn/end') {
      const ended = turnOf(event)
      if (ended == null || openTurns.get(k) === ended) openTurns.delete(k)
    }
    const p = pending.get(k)
    if (!p || !event) return
    if (p.kind === 'job') return onJobEvent(p, event)
    onLegacyEvent(p, event)   // 旧式 ask slot（下面定义）
  }

  // ---------------------------------------------------------------- 旧式 ask
  // 语义与 host.js 原实现一致：等整轮结束、resolves {code,body:{ok,reply}}。
  // 第 4 参 opts.messageId（可选）：调用方自带的消息 id（proactive 用它识别「自己的叫醒消息」，
  // 不把 echo 回来的 user/message 当成用户说话）。不给就照旧随机生成。
  let onLegacyEvent = () => {}
  const ask = (sessionId, text, content, opts = {}) => new Promise((done) => {
    const k = sessionKey(sessionId)
    if (!k) return done({ code: 400, body: { ok: false, message: '没选会话' } })
    if (pending.has(k)) return done({ code: 409, body: { ok: false, message: '上一句还没回完' } })
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      waiters.delete(finish)
      const p = pending.get(k)
      if (p && p.kind !== 'job') { try { clearT(p.timer) } catch {} pending.delete(k) }
      // 模型请求结束（完成或失败；没发出去的不算）：宿主的 pet-activity 记一笔
      if (slot.armed && typeof hooks.onTurn === 'function') {
        try {
          hooks.onTurn({
            source: slot.source, ok: r.code === 200 && !!(r.body && r.body.ok === true),
            ms: Math.max(0, clock() - slot.startedAt),
            tokens: slot.usage.seen ? { input: slot.usage.input, output: slot.usage.output } : undefined,
          })
        } catch {}
      }
      done(r)
    }
    const slot = {
      kind: 'ask',
      text: '',
      armed: false,
      seen: false,
      open: null,
      turn: null,
      messageId: typeof opts.messageId === 'string' && opts.messageId ? opts.messageId : petMessageId(randomUUID()),
      source: typeof opts.source === 'string' && opts.source ? opts.source.slice(0, 16) : 'other',
      startedAt: clock(),
      usage: { input: 0, output: 0, seen: false },
      resolve: (reply) => finish({ code: 200, body: { ok: true, reply: cleanReplyText(reply) } }),
      timer: setT(() => finish({ code: 504, body: { ok: false, message: '会话超时没回' } }), limit),
    }
    slot.open = openTurns.has(k) ? openTurns.get(k) : null
    pending.set(k, slot)
    waiters.add(finish)
    Promise.resolve(findAgent(sessionId))
      .then((found) => {
        if (settled) return
        const agent = found && found.agent
        if (!agent || typeof agent.followup !== 'function') {
          return finish({ code: (found && found.code) || 404, body: { ok: false, message: (found && found.message) || '会话不在线' } })
        }
        slot.armed = true
        return Promise.resolve()
          .then(() => {
            const d = hooks.decorate ? hooks.decorate(sessionId, content || [{ type: 'text', text }]) : null
            return Promise.resolve(agent.followup({
              id: slot.messageId,
              role: 'user',
              content: d ? d.content : (content || [{ type: 'text', text }]),
              source: { kind: 'pixel-pet' },
            })).then(() => { if (d) d.commit() })
          })
          .catch((e) => finish({ code: 502, body: { ok: false, message: 'followup 失败：' + String((e && e.message) || e) } }))
      })
      .catch((e) => finish({ code: 502, body: { ok: false, message: '唤醒会话失败：' + String((e && e.message) || e) } }))
  })

  onLegacyEvent = (p, event) => {
    if (event.type === 'turn/start') {
      p.open = turnOf(event)
      if (p.seen && p.turn == null) p.turn = p.open
      return
    }
    if (event.type === 'user/message') {
      if (!p.armed || p.seen || !event.data || event.data.id !== p.messageId) return
      p.seen = true
      p.text = ''
      p.turn = p.open
      return
    }
    if (!p.armed || !p.seen) {
      if (event.type === 'turn/end') p.open = null
      return
    }
    if (event.type === 'assistant/message') {
      const t = extractText(event.data && event.data.message)
      if (t) p.text = t
      const u = event.data && event.data.usage
      if (u) {
        p.usage.seen = true
        p.usage.input += Number(u.inputTokens) || 0
        p.usage.output += Number(u.outputTokens) || 0
      }
    } else if (event.type === 'turn/end') {
      const turn = turnOf(event)
      p.open = null
      if (p.turn != null && turn != null && turn !== p.turn) return
      p.resolve(p.text || '')
    }
  }

  // ---------------------------------------------------------------- post
  const post = async (sessionId, text) => {
    if (!sessionKey(sessionId)) return { code: 400, body: { ok: false, message: '没选会话' } }
    const found = await findAgent(sessionId)
    const agent = found && found.agent
    if (!agent || typeof agent.followup !== 'function') {
      return { code: (found && found.code) || 404, body: { ok: false, message: (found && found.message) || '会话不在线' } }
    }
    try {
      await agent.followup({ id: petMessageId(randomUUID()), role: 'user', content: [{ type: 'text', text }], source: { kind: 'pixel-pet' } })
    } catch (e) {
      return { code: 502, body: { ok: false, message: 'followup 失败：' + String((e && e.message) || e) } }
    }
    return { code: 200, body: { ok: true } }
  }

  // ---------------------------------------------------------------- 新协议
  const pruneExpiredRecords = () => {
    const now = clock()
    for (const [id, j] of jobs) {
      if (TERMINAL.has(j.state) && now - j.updatedAt >= TTL_TERMINAL_MS) jobs.delete(id)
    }
  }

  const start = (sessionId, text, content, opts = {}) => {
    if (disposed) return Promise.resolve({ code: 503, body: closedBody() })
    const requestId = opts.requestId
    const key = sessionKey(sessionId)
    const owner = opts.owner == null ? '' : String(opts.owner)
    const fingerprint = opts.fingerprint == null ? '' : String(opts.fingerprint)
    if (badId(requestId)) return Promise.resolve({ code: 400, body: { ok: false, message: 'requestId 不合法' } })
    if (!key) return Promise.resolve({ code: 400, body: { ok: false, message: '没选会话' } })

    const existing = jobs.get(requestId)
    if (existing) {
      if (existing.key !== key || existing.owner !== owner) {
        return Promise.resolve({ code: 404, body: { ok: false, message: '没有这个任务' } })
      }
      if (existing.fingerprint && fingerprint && existing.fingerprint !== fingerprint) {
        return Promise.resolve({ code: 409, body: { ok: false, message: '同一个 requestId 的内容变了，不能复用' } })
      }
      const code = TERMINAL.has(existing.state) ? 200 : 202
      return Promise.resolve({ code, body: snapshot(existing, limit) })
    }
    // 该会话已经有在途任务（新协议或旧 ask）→ 明确不接受
    if (pending.has(key)) return Promise.resolve({ code: 409, body: { ok: false, message: '上一句还没回完' } })
    // 容量：先清掉过期的终态记录，仍然满就 503（绝不驱逐在途任务）
    if (jobs.size >= MAX_JOBS) {
      pruneExpiredRecords()
      if (jobs.size >= MAX_JOBS) return Promise.resolve({ code: 503, body: { ok: false, message: '任务队列满了，稍后再试' } })
    }

    const job = {
      kind: 'job',
      requestId,
      sessionId: String(sessionId),
      key,
      owner,
      fingerprint,
      messageId: petMessageId(requestId),  // requestId + 前缀：事件里能直接对上，桥也能按前缀认出来
      source: typeof opts.source === 'string' && opts.source ? opts.source.slice(0, 16) : 'other',
      state: 'submitting',
      delivery: 'not-sent',
      seen: false,
      armed: false,
      openTurn: openTurns.has(key) ? openTurns.get(key) : null,
      turn: null,
      reply: undefined,
      message: undefined,
      usage: { input: 0, output: 0, seen: false },
      // progress v1（可选增量）：有界积压 + job 内单调 seq + 去重集合
      updates: [],
      updateSeq: 0,
      replySeq: null,
      seenIds: new Set(),
      lastEventSeq: null,
      waiters: [],
      timer: null,
      ttlTimer: null,
      createdAt: clock(),
      updatedAt: clock(),
      settled: false,
    }
    jobs.set(requestId, job)
    pending.set(key, job)            // 先占位，再异步干活
    job.timer = setT(() => expireJob(job), limit)
    job.timer?.unref?.()

    // 异步部分：不 await，start 立刻返回 202
    Promise.resolve()
      .then(() => findAgent(sessionId))
      .then((found) => {
        if (job.settled) return
        const agent = found && found.agent
        if (!agent || typeof agent.followup !== 'function') {
          // 根本没发出去 → definitely not-sent
          return failJob(job, (found && found.code) || 404, (found && found.message) || '会话不在线', 'not-sent')
        }
        job.armed = true
        // 越过这条线就不再是「肯定没发」：同步抛也可能是发出去了
        if (job.delivery !== 'accepted') job.delivery = 'unknown'
        return Promise.resolve()
          .then(() => {
            const d = hooks.decorate ? hooks.decorate(sessionId, content || [{ type: 'text', text }]) : null
            return Promise.resolve(agent.followup({
              id: job.messageId,
              role: 'user',
              content: d ? d.content : (content || [{ type: 'text', text }]),
              source: { kind: 'pixel-pet' },
            })).then(() => {
              if (d) d.commit()
              // 正回执 = 已受理（即使 user/message 还没到）
              if (!TERMINAL.has(job.state)) markAccepted(job)
            })
          })
          .catch((e) => {
            // 已被 user/message 证实送达（accepted）→ 任务其实已经在跑；这次 rejection 只说明
            // 回执通道断了，不能把 job 判失败、也不能把 delivery 降级。
            if (job.delivery === 'accepted') return
            // 只有在 accepted 之前失败才落到这里；delivery 保持 unknown（不确定是否跨界）
            failJob(job, 502, 'followup 失败：' + String((e && e.message) || e), job.delivery === 'not-sent' ? 'not-sent' : 'unknown')
          })
      })
      .catch((e) => {
        failJob(job, 502, '唤醒会话失败：' + String((e && e.message) || e), 'not-sent')
      })

    return Promise.resolve({ code: 202, body: snapshot(job, limit) })
  }

  const lookup = (requestId, sessionId, opts = {}) => {
    if (badId(requestId)) return { code: 400, body: { ok: false, message: 'requestId 不合法' } }
    const job = jobs.get(requestId)
    if (!job) return { code: 404, body: { ok: false, message: '没有这个任务' } }
    const key = sessionKey(sessionId)
    const owner = opts.owner == null ? '' : String(opts.owner)
    if (job.key !== key || job.owner !== owner) return { code: 404, body: { ok: false, message: '没有这个任务' } }
    if (opts.fingerprint != null && job.fingerprint && String(opts.fingerprint) !== job.fingerprint) {
      return { code: 409, body: { ok: false, message: '同一个 requestId 的内容变了，不能复用' } }
    }
    return { code: 200, body: snapshotFor(job, limit, opts.afterSeq) }
  }

  const result = (sessionId, requestId, opts = {}) => {
    if (disposed) return Promise.resolve({ code: 503, body: closedBody() })
    const got = lookup(requestId, sessionId, opts)
    if (got.code !== 200) return Promise.resolve(got)
    const job = jobs.get(requestId)
    const waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, Math.min(DEFAULT_WAIT_MS, opts.waitMs)) : DEFAULT_WAIT_MS
    // cursor 只有「非负整数」才算 opt-in；老客户端一律走旧语义（不会被 update 唤醒）
    const cursor = Number.isInteger(opts.afterSeq) && opts.afterSeq >= 0 ? opts.afterSeq : null
    const bodyOf = () => (cursor == null ? snapshot(job, limit) : snapshotFor(job, limit, cursor))
    const hasNew = () => cursor != null && (job.updates || []).some((u) => u.seq > cursor)
    // cursor waiter：只在「有新正文」或「终态」时返回。accepted 只是开始，不能让带 cursor 的
    // 客户端在 accepted 之后每次立即返回（那就变成忙轮询了）。
    // 老客户端（无 cursor）：保留旧语义——首次遇到 accepted 立即回，之后带 afterAccepted 等终态/心跳。
    const ready = () => TERMINAL.has(job.state) ||
      (cursor == null && job.delivery === 'accepted' && opts.afterAccepted !== true)
    if (ready() || waitMs === 0 || hasNew()) return Promise.resolve({ code: 200, body: bodyOf() })

    return new Promise((resolve) => {
      const w = {
        cursor,
        build: bodyOf,
        settle: (b, code = 200) => resolve({ code, body: b || bodyOf() }),
        timer: null,
      }
      job.waiters.push(w)
      w.timer = setT(() => {
        const i = job.waiters.indexOf(w)
        if (i >= 0) job.waiters.splice(i, 1)
        resolve({ code: 200, body: bodyOf() })   // 心跳：还没受理/终态（≤10s）
      }, waitMs)
      w.timer?.unref?.()
    })
  }

  // ---------------------------------------------------------------- dispose
  const dispose = () => {
    if (disposed) return undefined
    disposed = true
    for (const job of jobs.values()) {
      if (job.timer) { try { clearT(job.timer) } catch {} job.timer = null }
      if (job.ttlTimer) { try { clearT(job.ttlTimer) } catch {} job.ttlTimer = null }
      if (!TERMINAL.has(job.state)) {
        job.state = 'expired'
        job.settled = true
        job.message = '桌宠插件正在关闭'
      }
      settleWaiters(job, { code: 503, closed: closedBody() })
    }
    for (const p of pending.values()) {
      if (p.kind !== 'job' && p.timer) { try { clearT(p.timer) } catch {} }
    }
    pending.clear()
    openTurns.clear()
    for (const fn of Array.from(waiters)) {
      try { fn({ code: 503, body: closedBody() }) } catch {}
    }
    waiters.clear()
    const t = target
    target = null
    return t && typeof t.dispose === 'function' ? t.dispose() : undefined
  }

  const status = () => ({
    protocol: 1,
    disposed,
    jobs: jobs.size,
    active: Array.from(jobs.values()).filter((j) => !TERMINAL.has(j.state)).length,
    pendingSessions: pending.size,
    timeoutMs: limit,
  })

  return {
    // 旧接口（host.js 原样换过来即可）
    ask, post, onEvent, dispose, pending,
    get target () { return targetOf() },
    // 新接口
    start, lookup, result, jobs, status,
  }
}
