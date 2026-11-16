// node scripts/relay-jobs.test.mjs — long-task relay v1（纯 fake：假 ctx / 假 agent / 假时钟，
// 不碰真实 DSH 会话、不 followup、不读用户数据）。
import assert from 'node:assert/strict'
import { createRelay, RELAY_LIMITS, sessionKey } from '../lib/relay.js'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.stack) || e)) }
}

// ---------------------------------------------------------------- fakes
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve() }

function fakeTimers () {
  let now = 0
  let seq = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout (fn, ms) { const id = seq++; timers.set(id, { at: now + Math.max(0, ms | 0), fn }); return id },
    clearTimeout (id) { timers.delete(id) },
    count: () => timers.size,
    async advance (ms) {
      const target = now + ms
      for (;;) {
        let next = null
        for (const [id, tm] of timers) {
          if (tm.at <= target && (!next || tm.at < next[1].at)) next = [id, tm]
        }
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        try { next[1].fn() } catch (e) { /* 回调异常不影响推进 */ }
        await tick(2)
      }
      now = target
      await tick(2)
    },
  }
}

function fakeAgent (impl) {
  const agent = {
    calls: [],
    followup (msg) {
      this.calls.push(msg)
      return impl ? impl.call(this, msg) : Promise.resolve('sent')
    },
  }
  return agent
}

function setup (opts = {}) {
  const timers = fakeTimers()
  const agent = opts.agent || fakeAgent()
  const handlers = []
  const ctx = {
    on (evt, fn) { handlers.push(fn); return () => {} },
    _emit (session, event) { for (const fn of handlers) fn(session, event) },
  }
  const relay = createRelay(ctx, opts.timeoutMs, {
    clock: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    findAgent: opts.findAgent || (async () => ({ agent })),
    decorate: opts.decorate,
  })
  const emit = (event, session = { id: 'session-s1' }) => relay.onEvent(session, event)
  const say = (text, turn) => emit({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
  // Echo the id that was actually sent (it now carries the pixel-pet- prefix, 2026-11-15)
  const userMsg = (id) => emit({ type: 'user/message', data: { id: (relay.jobs.get(id) || {}).messageId || id, role: 'user', content: [] } })
  const turnStart = (turn) => emit({ type: 'turn/start', data: { turn } })
  const turnEnd = (turn) => emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  const opts0 = { owner: 'pet-1', fingerprint: 'fp-1' }
  return { relay, timers, agent, ctx, emit, say, userMsg, turnStart, turnEnd, opts: opts0 }
}

const startOk = async (relay, id, texts = 'hi', opts = { owner: 'pet-1', fingerprint: 'fp-1' }, session = 'session-s1') =>
  relay.start(session, texts, null, { requestId: id, ...opts })

// ---------------------------------------------------------------- 1. 立即回执
await t('start returns 202 immediately, before followup settles', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay, timers } = setup({ agent })
  const r = await startOk(relay, 'req-1')
  assert.equal(r.code, 202)
  assert.equal(r.body.protocol, 1)
  assert.equal(r.body.requestId, 'req-1')
  assert.equal(r.body.state, 'submitting')
  assert.equal(r.body.delivery, 'not-sent')
  assert.equal(r.body.accepted, false)
  // 202 先回，followup 是随后在微任务里才真正调用的（这正是「不 await 生成」的意思）
  await tick()
  assert.equal(agent.calls.length, 1)
  // 调 followup 之前一瞬就已经是 unknown（同步抛也算跨界）
  assert.equal(relay.lookup('req-1', 'session-s1', { owner: 'pet-1' }).body.delivery, 'unknown')
  release()
  await tick()
  const lk = relay.lookup('req-1', 'session-s1', { owner: 'pet-1' })
  assert.equal(lk.body.delivery, 'accepted')
  assert.equal(lk.body.state, 'pending')
  assert.equal(relay.pending.has(sessionKey('session-s1')), true)
  timers.clearTimeout && timers.clearTimeout(0)
  relay.dispose()
})

// ---------------------------------------------------------------- 2. 幂等
await t('same requestId never sends followup twice; changed body is 409', async () => {
  const { relay, agent } = setup()
  const a = await startOk(relay, 'req-2', '你好')
  const b = await startOk(relay, 'req-2', '你好')
  assert.equal(a.body.requestId, b.body.requestId)
  assert.equal(agent.calls.length, 1, 'same id must not re-send')
  const c = await relay.start('session-s1', '换了内容', null, { requestId: 'req-2', owner: 'pet-1', fingerprint: 'fp-2' })
  assert.equal(c.code, 409)
  assert.equal(agent.calls.length, 1)
  relay.dispose()
})

await t('wrong owner / wrong session are 404 (missing ID is 404 too)', async () => {
  const { relay } = setup()
  await startOk(relay, 'req-3')
  assert.equal(relay.lookup('req-3', 'session-s1', { owner: 'someone-else' }).code, 404)
  assert.equal(relay.lookup('req-3', 'session-other', { owner: 'pet-1' }).code, 404)
  assert.equal(relay.lookup('nope', 'session-s1', { owner: 'pet-1' }).code, 404)
  const again = await relay.start('session-s1', 'hi', null, { requestId: 'req-3', owner: 'intruder' })
  assert.equal(again.code, 404)
  relay.dispose()
})

// ---------------------------------------------------------------- 3. 忙 / 容量
await t('busy session is 409 and the second job is never sent', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay } = setup({ agent })
  await startOk(relay, 'req-busy-1')
  const second = await startOk(relay, 'req-busy-2', '再问')
  assert.equal(second.code, 409)
  assert.equal(agent.calls.length, 1)
  release()
  relay.dispose()
})

await t('capacity 128 → 503, and nothing is sent for the rejected one', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay } = setup({ agent })
  for (let i = 0; i < RELAY_LIMITS.MAX_JOBS; i++) {
    const r = await relay.start('session-cap-' + i, 'hi', null, { requestId: 'cap-' + i, owner: 'pet-1', fingerprint: 'f' })
    assert.equal(r.code, 202, 'job ' + i)
  }
  await tick(8)   // followup 在微任务里才发，等它们落地再断言
  assert.equal(agent.calls.length, RELAY_LIMITS.MAX_JOBS)
  const over = await relay.start('session-cap-over', 'hi', null, { requestId: 'cap-over', owner: 'pet-1', fingerprint: 'f' })
  assert.equal(over.code, 503)
  assert.equal(agent.calls.length, RELAY_LIMITS.MAX_JOBS, 'overflow must not be sent')
  release()
  relay.dispose()
})

// ---------------------------------------------------------------- 4. 时间上界
await t('progress does not extend the 30-minute bound; >3min still pending', async () => {
  const { relay, timers, agent, turnStart, userMsg } = setup()
  await startOk(relay, 'req-t')
  await tick()
  turnStart(1)
  userMsg('req-t')
  await tick()
  await timers.advance(3.5 * 60_000)          // 虚拟时间 3.5 分钟
  const mid = relay.lookup('req-t', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(mid.state, 'pending')
  assert.equal(mid.delivery, 'accepted')
  await timers.advance(27 * 60_000)           // 越过 30 分钟硬上界
  const done = relay.lookup('req-t', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(done.state, 'expired')
  relay.dispose()
})

await t('terminal records expire after TTL, lookup then 404', async () => {
  const { relay, timers, turnStart, userMsg, say, turnEnd } = setup()
  await startOk(relay, 'req-ttl')
  await tick()
  turnStart(1)
  userMsg('req-ttl')
  say('好了')
  turnEnd(1)
  await tick()
  assert.equal(relay.lookup('req-ttl', 'session-s1', { owner: 'pet-1' }).body.state, 'completed')
  await timers.advance(RELAY_LIMITS.TTL_TERMINAL_MS + 1000)
  assert.equal(relay.lookup('req-ttl', 'session-s1', { owner: 'pet-1' }).code, 404)
  relay.dispose()
})

// ---------------------------------------------------------------- 5. delivery 分类
await t('seen-before-reject stays accepted (never downgraded to not-sent)', async () => {
  let rejectIt
  const agent = fakeAgent(() => new Promise((_, bad) => { rejectIt = bad }))
  const { relay } = setup({ agent })
  await startOk(relay, 'req-seen')
  await tick()
  relay.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: relay.jobs.get('req-seen').messageId, role: 'user', content: [] } })
  assert.equal(relay.lookup('req-seen', 'session-s1', { owner: 'pet-1' }).body.delivery, 'accepted')
  rejectIt(new Error('socket closed'))
  await tick()
  const body = relay.lookup('req-seen', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(body.delivery, 'accepted', 'already seen must not be reported as not-sent')
  assert.equal(body.state, 'pending')
  relay.dispose()
})

await t('synchronous followup throw is unknown, not not-sent', async () => {
  const agent = fakeAgent(() => { throw new Error('sync boom') })
  const { relay } = setup({ agent })
  const r = await startOk(relay, 'req-sync')
  assert.equal(r.code, 202)
  await tick(8)
  const body = relay.lookup('req-sync', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(body.state, 'failed')
  assert.equal(body.delivery, 'unknown')
  assert.match(body.message, /followup 失败/)
  relay.dispose()
})

await t('no agent (never invoked) is definitely not-sent', async () => {
  const { relay } = setup({ findAgent: async () => ({ code: 404, message: '会话不在线' }) })
  await startOk(relay, 'req-off')
  await tick(6)
  const body = relay.lookup('req-off', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(body.state, 'failed')
  assert.equal(body.delivery, 'not-sent')
  assert.equal(body.message, '会话不在线')
  relay.dispose()
})

// ---------------------------------------------------------------- 6. turn 绑定
await t('late turn/end from an older turn cannot finish a newer job', async () => {
  const { relay, turnStart, userMsg, say, turnEnd } = setup()
  await startOk(relay, 'req-old')
  await tick()
  turnStart(1); userMsg('req-old'); say('旧答复'); turnEnd(1)
  await tick()
  assert.equal(relay.lookup('req-old', 'session-s1', { owner: 'pet-1' }).body.state, 'completed')
  await startOk(relay, 'req-new', '新的')
  await tick()
  turnEnd(1)                                  // 迟到的旧 turn 结束
  await tick()
  const body = relay.lookup('req-new', 'session-s1', { owner: 'pet-1' }).body
  assert.notEqual(body.state, 'completed', 'old turn/end must not finish the new job')
  turnStart(2); userMsg('req-new'); say('新答复'); turnEnd(2)
  await tick()
  assert.equal(relay.lookup('req-new', 'session-s1', { owner: 'pet-1' }).body.reply, '新答复')
  relay.dispose()
})

await t('another turn\'s assistant message is ignored', async () => {
  const { relay, turnStart, userMsg, say, turnEnd } = setup()
  await startOk(relay, 'req-turn')
  await tick()
  turnStart(1); userMsg('req-turn')
  say('别人的话', 9)
  say('我的话', 1)
  turnEnd(9)                                   // 别人的 turn 结束
  await tick()
  assert.equal(relay.lookup('req-turn', 'session-s1', { owner: 'pet-1' }).body.state, 'pending')
  turnEnd(1)
  await tick()
  const body = relay.lookup('req-turn', 'session-s1', { owner: 'pet-1' }).body
  assert.equal(body.state, 'completed')
  assert.equal(body.reply, '我的话')
  relay.dispose()
})

// ---------------------------------------------------------------- 7. result 轮询
await t('result: waitMs=0 heartbeat, resolves on acceptance, 404 on wrong owner', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay } = setup({ agent })
  await startOk(relay, 'req-res')
  const beat = await relay.result('session-s1', 'req-res', { owner: 'pet-1', waitMs: 0 })
  assert.equal(beat.code, 200)
  assert.equal(beat.body.state, 'submitting')
  assert.equal(beat.body.delivery, 'not-sent')
  const waiting = relay.result('session-s1', 'req-res', { owner: 'pet-1', waitMs: 50 })
  await tick()
  release()
  await tick()
  const settled = await waiting
  assert.equal(settled.body.delivery, 'accepted')
  const bad = await relay.result('session-s1', 'req-res', { owner: 'nobody', waitMs: 0 })
  assert.equal(bad.code, 404)
  relay.dispose()
})

// ---------------------------------------------------------------- 8. dispose
await t('dispose settles waiters with a readable closed status and clears timers', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay, timers } = setup({ agent })
  await startOk(relay, 'req-dispose')
  const waiting = relay.result('session-s1', 'req-dispose', { owner: 'pet-1', waitMs: 5000 })
  await tick()
  assert.ok(timers.count() > 0)
  relay.dispose()
  const closed = await waiting
  assert.equal(closed.code, 503)
  assert.equal(closed.body.closed, true)
  assert.equal(relay.status().disposed, true)
  assert.equal(timers.count(), 0, 'timers must be cleared on dispose')
  assert.equal(relay.dispose(), undefined, 'second dispose is a no-op')
  release()
})

// ---------------------------------------------------------------- 9. 旧接口兼容
await t('legacy ask still resolves {code:200,body:{ok,reply}} and clears pending', async () => {
  const { relay, agent, turnStart, userMsg, say, turnEnd } = setup()
  const p = relay.ask('session-s1', '在吗')
  await tick()
  const msg = agent.calls.at(-1)
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'pixel-pet')
  assert.deepEqual(msg.content, [{ type: 'text', text: '在吗' }])
  turnStart(1)
  userMsg(msg.id)
  say('在的')
  turnEnd(1)
  const r = await p
  assert.deepEqual(r, { code: 200, body: { ok: true, reply: '在的' } })
  assert.equal(relay.pending.size, 0)
  relay.dispose()
})

await t('legacy ask busy/timeout keep their old codes', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay, timers } = setup({ agent, timeoutMs: 30 })
  const first = relay.ask('session-s1', 'a')
  await tick()
  const busy = await relay.ask('session-s1', 'b')
  assert.equal(busy.code, 409)
  await timers.advance(50)
  const timedOut = await first
  assert.equal(timedOut.code, 504)
  release()
  relay.dispose()
})

await t('pending is keyed by the normalized session id', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const agent = fakeAgent(() => gate)
  const { relay } = setup({ agent })
  await relay.start('session-s1', 'hi', null, { requestId: 'req-key', owner: 'pet-1', fingerprint: 'f' })
  assert.equal(relay.pending.has('s1'), true)
  assert.equal(relay.pending.has('session-s1'), false)
  release()
  relay.dispose()
})

await t('late wrong-turn assistant cannot poison the matching final reply', async () => {
  const f = setup(); await startOk(f.relay,'req-wrong-turn'); await tick(10)
  f.turnStart(87); f.userMsg('req-wrong-turn'); f.say('correct',87); f.say('stale',86); f.turnEnd(87)
  assert.equal(f.relay.lookup('req-wrong-turn','s1',f.opts).body.reply,'correct'); f.relay.dispose()
})
await t('accepted heartbeat waits after its receipt and resolves immediately on completion', async () => {
  const f = setup(); await startOk(f.relay,'req-poll-wait'); await tick(10)
  const first = await f.relay.result('s1','req-poll-wait',{owner:'pet-1',waitMs:10000})
  assert.equal(first.body.accepted,true)
  let settled=false
  const waiting=f.relay.result('s1','req-poll-wait',{owner:'pet-1',waitMs:10000,afterAccepted:true}).then(r=>{settled=true;return r})
  await f.timers.advance(9000); assert.equal(settled,false)
  f.turnStart(88); f.userMsg('req-poll-wait'); f.say('finished',88); f.turnEnd(88)
  assert.equal((await waiting).body.reply,'finished'); f.relay.dispose()
})
await t('failed model turn is not mislabeled as a completed answer', async () => {
  const f = setup(); await startOk(f.relay,'req-model-error'); await tick(10)
  f.turnStart(89); f.userMsg('req-model-error')
  f.emit({type:'turn/end',data:{turn:89,reason:{kind:'error'}}})
  const result=f.relay.lookup('req-model-error','s1',f.opts).body
  assert.equal(result.state,'failed'); assert.equal(result.accepted,true); f.relay.dispose()
})
console.log(`\nrelay-jobs: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
