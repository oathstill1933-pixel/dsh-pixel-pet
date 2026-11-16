// node scripts/insight.test.mjs — 「活动与额度」页签 v2：监测桌宠自己。
// pet-activity 事件写入与只记类别 / 30 天整枝 / 状态带分格 / petDay 聚合（token 有无两种情况）/
// relay onTurn（source + usage）+ /api/insight/pet 路由与非法日期 + 工具包裹不改返回值 + say 路径。
// 全假依赖（假时钟、假 balance、假 agent），不连真会话、不发网络请求。旧的用户活动不再出现在该接口。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as H from '../lib/host.js'
import * as P from '../lib/pet-activity.js'
import * as R from '../lib/relay.js'
import * as Q from '../lib/quota-log.js'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n')) }
}

const MIN = 60_000
const DAY = (h, m = 0, d = 15) => new Date(2026, 10, d, h, m, 0).getTime()

// ------------------------------------------------------------------ 事件写入与白名单
await t('record: 只记已知字段；未知 kind / 空 name / offline 状态一律丢弃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pa-'))
  let T = DAY(9, 0, 15)
  const log = P.createPetActivity({ dataDir: dir, now: () => T })
  assert.equal(log.record('turn', { source: 'hub', ok: true, ms: 1234, tokens: { input: 100, output: 20 } }), true)
  assert.equal(log.record('turn', { source: 'bogus', ok: false, ms: 5 }), true) // 未知来源归 other
  assert.equal(log.record('tool', { name: 'pixelpet_say', ok: true }), true)
  assert.equal(log.record('tool', { name: '', ok: true }), false)
  assert.equal(log.record('say', { speak: true, chars: 12 }), true)
  assert.equal(log.record('care', { trigger: 'long_work', decision: 'spoke' }), true)
  assert.equal(log.record('care', { trigger: '', decision: 'spoke' }), false)
  assert.equal(log.record('state', { state: 'idle' }), false) // state 由 Python 写，宿主不收
  assert.equal(log.record('state', { state: 'offline' }), false)
  assert.equal(log.record('junk', {}), false)
  const lines = readFileSync(join(dir, P.PET_ACTIVITY_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.kind), ['turn', 'turn', 'tool', 'say', 'care'])
  assert.deepEqual(lines[0], { t: lines[0].t, kind: 'turn', source: 'hub', ok: true, ms: 1234, tokens: { input: 100, output: 20 } })
  assert.deepEqual(lines[1], { t: lines[1].t, kind: 'turn', source: 'other', ok: false, ms: 5 }) // tokens 没有就省略
  assert.equal(lines[2].name, 'pixelpet_say')
  assert.deepEqual(lines[3], { t: lines[3].t, kind: 'say', speak: true, chars: 12 })
  assert.deepEqual(lines[4], { t: lines[4].t, kind: 'care', trigger: 'long_work', decision: 'spoke' })
})

await t('record: token 全 0 / 缺字段不写 tokens（不估算，不造假点）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pa2-'))
  const log = P.createPetActivity({ dataDir: dir })
  log.record('turn', { source: 'hub', ok: true, ms: 1, tokens: { input: 0, output: 0 } })
  log.record('turn', { source: 'hub', ok: true, ms: 1, tokens: { input: NaN, output: 5 } })
  const lines = readFileSync(join(dir, P.PET_ACTIVITY_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.every((l) => !('tokens' in l)))
})

await t('30 天滚动：31 天前的记录在下一次写入时被整枝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pa3-'))
  let T = DAY(9, 0, 15)
  const log = P.createPetActivity({ dataDir: dir, now: () => T })
  log.record('tool', { name: 'old', ok: true })
  // 手工把那条记录的时间改到 31 天前；整枝每小时至多一次 → 拨过 1 小时再写
  const f = join(dir, P.PET_ACTIVITY_FILE)
  const old = JSON.parse(readFileSync(f, 'utf8').trim())
  writeFileSync(f, JSON.stringify({ ...old, t: new Date(T - 31 * 86_400_000).toISOString() }) + '\n')
  T = DAY(10, 1, 15)
  log.record('tool', { name: 'new', ok: true })
  const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.name), ['new'])
})

// ------------------------------------------------------------------ 状态带
await t('stateSlots: 状态 6 分钟 TTL（心跳续命）/ 最后一段到 min(now, t+6)；没覆盖的格 = offline；格内取占多数', () => {
  const from = DAY(0, 0, 15)
  // 02:00 起工作中，心跳每 5 分钟续命；02:10 有 3 分钟的 speaking（无心跳行落在心跳之间）
  const rows = [{ t: from + 120 * MIN, state: 'working' }]
  for (let t = from + 125 * MIN; t <= from + 179 * MIN; t += 5 * MIN) {
    if (t === from + 130 * MIN) continue // 02:10 让位给 speaking 行
    rows.push({ t, state: 'working', hb: true })
  }
  rows.push({ t: from + 130 * MIN, state: 'speaking' }) // 02:10–02:13 的说话（无心跳落在它上面）
  rows.push({ t: from + 181 * MIN, state: 'idle', hb: true }) // 03:01 待机 + 心跳
  const now = from + 184 * MIN // 03:04：最后一行（03:01）延伸到 min(now, t+6) = now
  const slots = P.stateSlots(rows, from, from + 86_400_000, now)
  assert.equal(slots.length, 288)
  assert.ok(slots.slice(0, 24).every((s) => s.state === 'offline')) // 00:00–02:00 没在运行
  assert.equal(slots[24].state, 'working')
  assert.equal(slots[25].state, 'working')
  assert.equal(slots[26].state, 'speaking')                         // 02:10–02:15：speaking 独占（心跳让位）
  assert.equal(slots[27].state, 'working')                          // 心跳续着
  assert.equal(slots[35].state, 'working')                          // 02:55 心跳续到 03:01
  assert.equal(slots[36].state, 'idle')                             // 03:01 起 idle（3min > working 尾巴 1min）
  assert.ok(slots.slice(37, 38).every((s) => s.state === 'idle' || s.state === 'offline')) // idle 到 now（03:04）
  assert.ok(slots.slice(38).every((s) => s.state === 'offline'))    // now 之后不画未来
  // 无心跳的工作段：01:00 的行没有心跳 → 01:06 起算 offline（单独造一组验证 TTL）
  const rowsNoHb = [{ t: from + 60 * MIN, state: 'working' }, { t: from + 180 * MIN, state: 'idle', hb: true }]
  const slots2 = P.stateSlots(rowsNoHb, from, from + 86_400_000, from + 300 * MIN)
  assert.equal(slots2[12].state, 'working') // 01:00–01:05
  assert.equal(slots2[13].state, 'offline') // 01:06 起超过 6 分钟没有续命
  assert.equal(slots2[36].state, 'idle')    // 03:00 待机 + 心跳
})

// ------------------------------------------------------------------ petDay 聚合
await t('petDay: counts / bySource / tools 排序 / care；token 有则聚合、无则 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pa4-'))
  const T = DAY(9, 0, 15)
  const log = P.createPetActivity({ dataDir: dir, now: () => T })
  log.record('turn', { source: 'hub', ok: true, ms: 100, tokens: { input: 500, output: 100 } })
  log.record('turn', { source: 'care', ok: true, ms: 200, tokens: { input: 300, output: 50 } })
  log.record('turn', { source: 'mail', ok: false, ms: 10 })
  log.record('say', { speak: true, chars: 8 })
  log.record('say', { speak: false, chars: 3 })
  log.record('tool', { name: 'pixelpet_say', ok: true })
  log.record('tool', { name: 'pixelpet_say', ok: true })
  log.record('tool', { name: 'pixelpet_status', ok: true })
  log.record('tool', { name: 'pixelpet_move', ok: false })
  log.record('care', { trigger: 'long_work', decision: 'spoke' })
  log.record('care', { trigger: 'back', decision: 'silent' })
  writeFileSync(join(dir, P.PET_STATE_FILE),
    JSON.stringify({ t: new Date(DAY(1, 0, 15)).toISOString(), state: 'idle' }) + '\n' +
    JSON.stringify({ t: new Date(DAY(2, 0, 15)).toISOString(), state: 'working' }) + '\n')
  const d = P.petDay(dir, '2026-11-15', DAY(10, 0, 15))
  assert.deepEqual(d.counts, { turn: 3, speak: 1, bubble: 1, tool: 4, care: 2 })
  assert.deepEqual(d.bySource, { hub: 1, mail: 1, reading: 0, music: 0, care: 1, calendar: 0, other: 0 })
  assert.deepEqual(d.tools.map((x) => [x.name, x.ok, x.fail]), [['pixelpet_say', 2, 0], ['pixelpet_status', 1, 0], ['pixelpet_move', 0, 1]])
  assert.deepEqual(d.tokens, { total: 950, bySource: { hub: 600, care: 350 } })
  assert.deepEqual(d.care, { spoke: 1, silent: 1, error: 0 })
  assert.equal(d.slots.length, 288)
  assert.equal(d.slots[0].state, 'offline')  // 01:00 之前没记录
  assert.equal(d.slots[12].state, 'idle')    // 01:00–02:00 待机
  assert.equal(d.slots[24].state, 'working') // 02:00 起工作中
  assert.equal(d.slots[150].state, 'offline') // 12:30 超出 now（10:00）不画未来
  // 跨日不串：昨天的记录不在今天
  const d2 = P.petDay(dir, '2026-11-14')
  assert.deepEqual(d2.counts, { turn: 0, speak: 0, bubble: 0, tool: 0, care: 0 })
})

await t('petDay: 没有任何 token → tokens = null；日期非法 → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pa5-'))
  const log = P.createPetActivity({ dataDir: dir })
  log.record('turn', { source: 'hub', ok: true, ms: 5 })
  const d = P.petDay(dir, '2026-11-15')
  assert.equal(d.tokens, null)
  assert.equal(P.petDay(dir, '2026-02-30'), null)
})

// ------------------------------------------------------------------ relay onTurn（source + usage）
function fakeRelayWorld () {
  const turns = []
  const relay = R.createRelay(null, 5000, {
    onTurn: (info) => turns.push(info),
    findAgent: async () => ({ agent: { followup: async () => {} } }),
  })
  const emit = (event) => relay.onEvent({ id: 'session-s1' }, event)
  return { turns, relay, emit }
}

await t('relay onTurn: ask 完成 → source / ok / usage 累计；多步 usage 累加', async () => {
  const w = fakeRelayWorld()
  const p = w.relay.ask('session-s1', '你好', undefined, { source: 'care', messageId: 'wake-1' })
  await new Promise((done) => setImmediate(done)) // 让 findAgent 链把 slot armed，再放事件
  w.emit({ type: 'turn/start', data: { turn: 1 } })
  w.emit({ type: 'user/message', data: { id: 'wake-1' } })
  w.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯' }] }, usage: { inputTokens: 100, outputTokens: 20 } } })
  w.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] }, usage: { inputTokens: 50, outputTokens: 10 } } })
  w.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const r = await p
  assert.equal(r.code, 200)
  assert.equal(w.turns.length, 1)
  assert.deepEqual(w.turns[0], { source: 'care', ok: true, ms: w.turns[0].ms, tokens: { input: 150, output: 30 } })
  assert.ok(w.turns[0].ms >= 0)
})

await t('relay onTurn: usage 缺失 → tokens 省略；followup 失败 ok:false；没发出去的不记', async () => {
  const w = fakeRelayWorld()
  const p = w.relay.ask('session-s1', 'hi', undefined, { source: 'mail', messageId: 'm-1' })
  await new Promise((done) => setImmediate(done))
  w.emit({ type: 'turn/start', data: { turn: 1 } })
  w.emit({ type: 'user/message', data: { id: 'm-1' } })
  w.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } }) // 没有 usage
  w.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const r = await p
  assert.equal(r.code, 200)
  assert.equal(w.turns.length, 1)
  assert.equal(w.turns[0].ok, true)
  assert.equal(w.turns[0].tokens, undefined)
  // followup 失败：也算一次请求，ok:false
  const w2 = R.createRelay(null, 5000, { onTurn: (info) => w.turns.push(info), findAgent: async () => ({ agent: { followup: async () => { throw new Error('boom') } } }) })
  const r2 = await w2.ask('session-s1', 'hi', undefined, { source: 'mail' })
  assert.equal(r2.code, 502)
  assert.equal(w.turns[1].ok, false)
  assert.equal(w.turns[1].source, 'mail')
  // 会话不在线：followup 没发出去，不记
  const w3 = R.createRelay(null, 5000, { onTurn: (info) => w.turns.push(info), findAgent: async () => ({ code: 404, message: '会话不在线' }) })
  await w3.ask('session-s1', 'hi')
  assert.equal(w.turns.length, 2)
})

// ------------------------------------------------------------------ 路由（fakeCtx + agent 事件）
function fakeCtx () {
  const handlers = {}; const effects = []
  const reg = new Map()
  let route = null
  let turnNo = 0
  const agent = { calls: [], async followup (msg) { this.calls.push(msg); setTimeout(() => {
    const turn = ++turnNo
    emit({ id: 'session-s1' }, { type: 'turn/start', data: { turn } })
    emit({ id: 'session-s1' }, { type: 'user/message', data: msg })
    emit({ id: 'session-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] }, usage: { inputTokens: 10, outputTokens: 2 } } })
    emit({ id: 'session-s1' }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }, 5) } }
  const emit = (...a) => { if (handlers['session/event']) handlers['session/event'](...a) }
  const ctx = {
    logger: { warn () {}, info () {} },
    get: (n) => (n === 'webServer' ? { register (r) { route = r; return () => {} } } : null),
    agents: { get: (id) => (id === 'session-s1' ? agent : undefined) },
    tools: { register (def) { reg.set(def.name, def); return () => { if (reg.get(def.name) === def) reg.delete(def.name) } } },
    on: (ev, fn) => { handlers[ev] = fn; return () => {} },
    effect: (fn) => { effects.push(fn()) },
  }
  return { ctx, effects, reg, agent, get route () { return route } }
}

async function call (route, method, path, { body } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080' }
  let status = 0; let out = Buffer.alloc(0)
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = Buffer.from(b) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : JSON.stringify(body))
  await p
  let json = null; try { json = JSON.parse(out.toString('utf8')) } catch {}
  return { status, json, raw: out }
}

async function world (dir) {
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  await call(g.route, 'POST', '/api/settings', { body: { autonomy: { enabled: true, aware: true }, voice: { llm: { sessionId: 'session-s1' } }, insight: { on: false } } })
  return g
}

await t('路由: /api/insight/pet 非法日期 400；合法日期聚合；用户活动日志不再出现在响应里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pet1-'))
  const g = await world(dir)
  for (const bad of ['2026-2-3', '2026-02-30', 'garbage']) {
    assert.equal((await call(g.route, 'GET', '/api/insight/pet?date=' + bad)).status, 400, bad)
  }
  // 用过去一天（2026-11-14）：最后一段被裁到当天 24:00，与真实时钟无关
  writeFileSync(join(dir, 'activity-log.jsonl'),
    JSON.stringify({ t: new Date(DAY(9, 0, 14)).toISOString(), state: 'work', app: 'secretgame.exe', dur: 60 }) + '\n')
  writeFileSync(join(dir, P.PET_ACTIVITY_FILE),
    JSON.stringify({ t: Q.isoLocal(DAY(10, 0, 14)), kind: 'turn', source: 'hub', ok: true, ms: 900, tokens: { input: 11, output: 3 } }) + '\n' +
    JSON.stringify({ t: Q.isoLocal(DAY(10, 1, 14)), kind: 'say', speak: true, chars: 5 }) + '\n' +
    JSON.stringify({ t: Q.isoLocal(DAY(10, 2, 14)), kind: 'care', trigger: 'long_work', decision: 'spoke' }) + '\n')
  // 状态行带心跳（每行 6 分钟 TTL，没心跳的中间时段会算 offline）
  const stateRows = []
  for (let h = 1; h <= 6; h += 5) stateRows.push({ t: Q.isoLocal(DAY(h, 0, 14)), state: 'idle' })
  for (let h = 9; h <= 18; h += 1) stateRows.push({ t: Q.isoLocal(DAY(h, 0, 14)), state: 'working', hb: true })
  stateRows.push({ t: Q.isoLocal(DAY(20, 0, 14)), state: 'idle' })
  writeFileSync(join(dir, P.PET_STATE_FILE), stateRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const r = await call(g.route, 'GET', '/api/insight/pet?date=2026-11-14')
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.date, '2026-11-14')
  assert.deepEqual(r.json.counts, { turn: 1, speak: 1, bubble: 0, tool: 0, care: 1 })
  assert.deepEqual(r.json.bySource.hub, 1)
  assert.deepEqual(r.json.tokens, { total: 14, bySource: { hub: 14 } })
  assert.deepEqual(r.json.care, { spoke: 1, silent: 0, error: 0 })
  assert.equal(r.json.slots[12].state, 'idle'); assert.equal(r.json.slots[120].state, 'working')
  const raw = JSON.stringify(r.json)
  assert.ok(!raw.includes('secretgame'), '用户活动进程名不出现')
  assert.ok(!raw.includes('"summary"') && !raw.includes('"aware"') && !raw.includes('activity-log'), '用户活动字段不出现')
  for (const e of g.effects) if (typeof e === 'function') e()
})

await t('路由: 工具包裹不改返回值且记 tool 事件；say 路径记 say（tool + say 两笔）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-pet2-'))
  const g = await world(dir)
  const st = g.reg.get('pixelpet_status')
  assert.ok(st, 'pixelpet_status 已注册')
  const before = await st.execute({}) // 桌宠没运行：ok:false，但返回值结构照旧（包裹不改返回值）
  assert.equal(before.ok, false); assert.equal(before.running, false)
  const say = g.reg.get('pixelpet_say')
  const out = await say.execute({ text: '今天也要加油' })
  assert.equal(out.ok, false) // 桌宠没运行：命令失败，但事件照记
  const lines = readFileSync(join(dir, P.PET_ACTIVITY_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.kind === 'tool' && l.name === 'pixelpet_say' && l.ok === false))
  assert.ok(lines.some((l) => l.kind === 'say' && l.speak === false && l.chars === 6))
  for (const e of g.effects) if (typeof e === 'function') e()
})

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail ? 1 : 0)
