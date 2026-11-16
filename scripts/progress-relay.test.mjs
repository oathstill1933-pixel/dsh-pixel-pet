// node scripts/progress-relay.test.mjs — 长任务「工作过程中就念正文」的增量协议（progress v1）。
// 纯 fake：假 ctx / 假 agent / 假时钟；不 followup 真实会话、不碰音色/声纹/服务。
import assert from 'node:assert/strict'
import { createRelay, RELAY_LIMITS } from '../lib/relay.js'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.stack) || e)) }
}
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve() }

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
        for (const [id, tm] of timers) if (tm.at <= target && (!next || tm.at < next[1].at)) next = [id, tm]
        if (!next) break
        timers.delete(next[0]); now = next[1].at
        try { next[1].fn() } catch {}
        await tick(2)
      }
      now = target
      await tick(2)
    },
  }
}

function fakeAgent () {
  return { calls: [], followup (msg) { this.calls.push(msg); return Promise.resolve('sent') } }
}

function setup (opts = {}) {
  const timers = fakeTimers()
  const agent = opts.agent || fakeAgent()
  const relay = createRelay({ on () { return () => {} } }, opts.timeoutMs, {
    clock: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    findAgent: opts.findAgent || (async () => ({ agent })),
  })
  const emit = (event, session = { id: 'session-s1' }) => relay.onEvent(session, event)
  const api = {
    relay,
    timers,
    agent,
    turnStart: (turn) => emit({ type: 'turn/start', data: { turn } }),
    // 公开正文；channel/role 可显式覆盖以测试过滤
    say: (text, extra = {}) => emit({
      type: 'assistant/message',
      ...(extra.seq != null ? { seq: extra.seq } : {}),
      data: {
        ...(extra.turn != null ? { turn: extra.turn } : {}),
        ...(extra.channel ? { channel: extra.channel } : {}),
        message: { id: extra.id, role: extra.role || 'assistant', content: [{ type: 'text', text }] },
      },
    }),
    reasoning: (text, id = 'r1') => emit({
      type: 'assistant/message',
      data: { message: { id, role: 'assistant', channel: 'analysis', content: [{ type: 'text', text }] } },
    }),
    tool: (id = 't1') => emit({
      type: 'assistant/message',
      data: { message: { id, role: 'assistant', content: [{ type: 'tool_call', name: 'x' }] } },
    }),
    // 桌宠发出的消息 id 带 pixel-pet- 前缀（2026-11-15 跟随单）：事件里回显的必须是真正发出去的那个 id
    userMsg: (id = 'req-p1') => emit({ type: 'user/message', data: { id: (relay.jobs.get(id) || {}).messageId || id, role: 'user', content: [] } }),
    turnEnd: (turn = 1) => emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
  }
  return api
}

const OWN = { owner: 'pet-1', fingerprint: 'fp-1' }

async function startAndAdmit (api, id = 'req-p1', turn = 1) {
  await api.relay.start('session-s1', '做点活', null, { requestId: id, ...OWN })
  await tick()
  api.turnStart(turn)
  api.userMsg(id)
  await tick()
  return id
}

// ---------------------------------------------------------------- 1. 正文在 turn/end 之前就能读到
await t('assistant text is readable before turn/end (seq monotonic)', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('第一段进度', { id: 'm1' })
  api.say('第二段进度', { id: 'm2' })
  await tick()
  const r = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.updates.map((u) => u.text), ['第一段进度', '第二段进度'])
  assert.deepEqual(r.body.updates.map((u) => u.seq), [1, 2])
  assert.equal(r.body.updateSeq, 2)
  assert.equal(r.body.state, 'pending', '还没结束就能读到正文')
  assert.equal(r.body.protocol, 1, 'protocol 不变')
  api.relay.dispose()
})

await t('final reply is kept and marked with replySeq', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('干完了', { id: 'm1' })
  api.turnEnd(1)
  await tick()
  const body = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(body.state, 'completed')
  assert.equal(body.reply, '干完了')
  assert.ok(body.replySeq >= 1, 'replySeq 指向那条正文，供上层去重')
  assert.equal(body.updates.at(-1).text, '干完了')
  api.relay.dispose()
})

// ---------------------------------------------------------------- 2. 过滤
await t('reasoning / tool / non-assistant / analysis channel are skipped', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.reasoning('我在想……', 'r1')
  api.tool('t1')
  api.say('内部批注', { id: 'm9', channel: 'analysis' })
  api.say('用户说的话', { id: 'm8', role: 'user' })
  api.say('真正要说的话', { id: 'm1' })
  await tick()
  const body = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.deepEqual(body.updates.map((u) => u.text), ['真正要说的话'])
  api.relay.dispose()
})

await t('older turn assistant text is ignored, admitted turn is kept', async () => {
  const api = setup()
  const id = await startAndAdmit(api, 'req-p2', 2)
  api.say('旧 turn 的话', { id: 'old', turn: 1 })
  api.say('本轮的话', { id: 'new', turn: 2 })
  await tick()
  const body = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.deepEqual(body.updates.map((u) => u.text), ['本轮的话'])
  api.relay.dispose()
})

await t('events before user/message match never become updates', async () => {
  const api = setup()
  await api.relay.start('session-s1', 'x', null, { requestId: 'req-p3', ...OWN })
  await tick()
  api.turnStart(1)
  api.say('还没确认是我们这条', { id: 'pre' })       // job.seen 仍是 false
  await tick()
  assert.deepEqual(api.relay.lookup('req-p3', 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.updates, [])
  api.userMsg('req-p3')
  api.say('确认之后的话', { id: 'post' })
  await tick()
  assert.deepEqual(api.relay.lookup('req-p3', 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.updates.map((u) => u.text), ['确认之后的话'])
  api.relay.dispose()
})

// ---------------------------------------------------------------- 3. 去重
await t('same stable message id is read once; repeated event.seq is dropped', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('一次', { id: 'm1', seq: 10 })
  api.say('一次', { id: 'm1', seq: 11 })            // 同 id 重投递
  api.say('更旧的事件', { id: 'm0', seq: 9 })        // seq 倒退
  api.say('新的', { id: 'm2', seq: 12 })
  await tick()
  const body = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.deepEqual(body.updates.map((u) => u.text), ['一次', '新的'])
  api.relay.dispose()
})

// ---------------------------------------------------------------- 4. cursor 过滤
await t('afterSeq returns only newer updates, per waiter', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('A', { id: 'a' }); api.say('B', { id: 'b' }); api.say('C', { id: 'c' })
  await tick()
  const all = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  const last = all.updates.at(-1).seq
  const tail = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: last - 1 }).body
  assert.deepEqual(tail.updates.map((u) => u.text), ['C'])
  const none = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: last }).body
  assert.deepEqual(none.updates, [])
  api.relay.dispose()
})

await t('old client (no afterSeq) gets empty updates and is not woken by updates', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  const before = await api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 0 })
  assert.deepEqual(before.body.updates, [], '老客户端不下发正文')
  // 老客户端第二次轮询会带 afterAccepted=true（收据已拿到），此后只等终态/心跳
  const waiting = api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 5000, afterAccepted: true })
  await tick()
  api.say('不该唤醒老客户端', { id: 'm1' })
  await tick()
  let settled = false
  waiting.then(() => { settled = true })
  await tick()
  assert.equal(settled, false, '没有 cursor 的 waiter 不能被 update 唤醒（否则会空转）')
  await api.timers.advance(5000)                    // 心跳上限
  const beat = await waiting
  assert.deepEqual(beat.body.updates, [])
  assert.equal(beat.body.updateSeq, 1, 'updateSeq 仍然告知有增量，但不下发内容')
  api.relay.dispose()
})

// ---------------------------------------------------------------- 5. 即时唤醒
await t('a new update wakes the cursor long-poll immediately (before heartbeat)', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('第一段', { id: 'm1' })
  await tick()
  const cursor = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.updateSeq
  const waiting = api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 9000, afterSeq: cursor })
  await tick()
  let settled = false
  waiting.then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  api.say('第二段', { id: 'm2' })
  const woke = await waiting
  assert.deepEqual(woke.body.updates.map((u) => u.text), ['第二段'])
  assert.ok(api.timers.count() >= 0)
  api.relay.dispose()
})

await t('cursor waiter wakes on the update first, terminal call then reports done', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  api.say('甲', { id: 'a' })
  await tick()
  const cursor = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.updateSeq
  const waiting = api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 9000, afterSeq: cursor })
  api.say('乙', { id: 'b' })
  const woke = await waiting
  // 关键：正文在工作过程中就能读出来（这时 turn 还没结束）
  assert.equal(woke.body.state, 'pending')
  assert.deepEqual(woke.body.updates.map((u) => u.text), ['乙'])
  const nextCursor = woke.body.updateSeq
  const after = api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 0, afterSeq: nextCursor })
  api.turnEnd(1)
  const done = await api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 9000, afterSeq: nextCursor })
  assert.equal(done.body.state, 'completed')
  assert.equal(done.body.reply, '乙')
  assert.ok(done.body.replySeq === nextCursor, '最终文本就是那条 update，不额外造 seq')
  assert.deepEqual(done.body.updates, [], '已消费过的正文不重复下发')
  assert.equal((await after).body.state, 'pending')
  api.relay.dispose()
})

// ---------------------------------------------------------------- 6. turn 未绑定整数
await t('no integer turn bound: reply only, no progress; after binding, update turn matches snapshot', async () => {
  const api = setup()
  await api.relay.start('session-s1', '做点活', null, { requestId: 'req-nt', ...OWN })
  await tick()
  // 不先发 turn/start，直接来 user/message：openTurn 是 null → job.turn 绑不到整数
  api.userMsg('req-nt')
  await tick()
  api.say('没有 turn 的正文', { id: 'a' })
  await tick()
  const noTurn = api.relay.lookup('req-nt', 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(noTurn.turn, null)
  assert.deepEqual(noTurn.updates, [], 'turn 不是整数时不许产出 updates（新客户端会拒收）')

  // 之后绑定 turn 5：再来的公开正文就能进 updates，且 turn 与 snapshot.turn 一致
  api.turnStart(5)
  await tick()
  api.say('绑定后的话', { id: 'b' })
  await tick()
  const bound = api.relay.lookup('req-nt', 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(bound.turn, 5)
  assert.equal(bound.updates.length, 1)
  assert.equal(bound.updates[0].turn, 5, '每条 update 的 turn 必须等于 snapshot.turn')
  api.turnEnd(5)
  await tick()
  const done = api.relay.lookup('req-nt', 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(done.state, 'completed')
  assert.equal(done.reply, '绑定后的话')
  api.relay.dispose()
})

// ---------------------------------------------------------------- 7. 有界积压
await t('backlog is bounded (64 records) but the final reply is never lost', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  for (let i = 0; i < RELAY_LIMITS.MAX_UPDATES + 20; i++) api.say('段' + i, { id: 'm' + i })
  await tick()
  const body = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(body.updates.length, RELAY_LIMITS.MAX_UPDATES)
  assert.equal(body.updates.at(-1).text, '段' + (RELAY_LIMITS.MAX_UPDATES + 19))
  api.turnEnd(1)
  await tick()
  const done = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(done.reply, '段' + (RELAY_LIMITS.MAX_UPDATES + 19))
  assert.ok(done.updates.some((u) => u.text === done.reply), '最终回复必须在 updates 里可定位（replySeq 去重）')
  api.relay.dispose()
})

await t('oversized public text is skipped in updates but kept as final reply', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  const huge = '很'.repeat(RELAY_LIMITS.MAX_UPDATE_TEXT + 10)
  api.say(huge, { id: 'big' })
  await tick()
  assert.deepEqual(api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.updates, [])
  api.turnEnd(1)
  await tick()
  const done = api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body
  assert.equal(done.reply.length, huge.length, '最终 reply 不能被跳过')
  api.relay.dispose()
})

// ---------------------------------------------------------------- 7. 不破坏旧语义
await t('acceptance / owner guard / turn binding still hold with progress', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  const bad = api.relay.lookup(id, 'session-s1', { owner: 'other', afterSeq: 0 })
  assert.equal(bad.code, 404)
  api.say('正文', { id: 'm1' })
  api.turnEnd(99)                                   // 别的 turn 结束
  await tick()
  assert.equal(api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.state, 'pending')
  api.turnEnd(1)
  await tick()
  assert.equal(api.relay.lookup(id, 'session-s1', { owner: 'pet-1', afterSeq: 0 }).body.state, 'completed')
  api.relay.dispose()
})

await t('idempotent start still never re-sends and keeps one job', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  await tick()
  const again = await api.relay.start('session-s1', '做点活', null, { requestId: id, ...OWN })
  assert.equal(again.code, 202)
  assert.equal(api.agent.calls.length, 1)
  assert.equal(again.body.updates.length, 0)
  api.relay.dispose()
})

await t('dispose settles a cursor waiter with closed status', async () => {
  const api = setup()
  const id = await startAndAdmit(api)
  const waiting = api.relay.result('session-s1', id, { owner: 'pet-1', waitMs: 9000, afterSeq: 0 })
  await tick()
  api.relay.dispose()
  const closed = await waiting
  assert.equal(closed.code, 503)
  assert.equal(closed.body.closed, true)
})

await t('duplicate stable ID with newer event seq cannot roll final reply backwards', async () => {
  const api=setup();const id=await startAndAdmit(api)
  api.say('old opening',{id:'message-one',seq:10})
  api.say('new final',{id:'message-two',seq:11})
  api.say('old opening',{id:'message-one',seq:12})
  api.turnEnd(1)
  const r=api.relay.lookup(id,'session-s1',{owner:'pet-1',afterSeq:0})
  assert.equal(r.body.reply,'new final')
  assert.deepEqual(r.body.updates.map(x=>x.text),['old opening','new final'])
  api.relay.dispose()
})
console.log(`\nprogress-relay: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
