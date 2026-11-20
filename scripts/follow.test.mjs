// node scripts/follow.test.mjs — 「跟随外部桥会话」（docs/FOLLOW.md）。
// 纯 fake：假 DSH ctx / 假 agent / 假 fetch / 临时目录；不碰真实会话、不碰网络、不启动 Python。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as F from '../lib/follow.js'
import * as H from '../lib/host.js'
import { createBalance } from '../lib/balance.js'
import { createPetActivity } from '../lib/pet-activity.js'
import { createProactive } from '../lib/proactive.js'
import { createRelay } from '../lib/relay.js'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'
let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = (tag = 'pp-follow-') => mkdtempSync(join(tmpdir(), tag))
const SCHEMA = 'dsh-pixel-pet/follow@1'
const keyOf = (id) => String(id || '').replace(/^session-/, '')

/** 一个来源一个文件（dir 由调用方给） */
function writePointer (dir, name, patch = {}) {
  mkdirSync(dir, { recursive: true })
  const pointer = {
    schema: SCHEMA, channel: 'myapp', peer: '10000', scope: 'direct', petHome: true,
    sessionId: 'session-new-home', label: '私聊',
    updatedAt: new Date().toISOString(), ttlHours: 36, ...patch,
  }
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(pointer), 'utf8')
  return file
}

// ------------------------------------------------------------------ 1. 门牌是什么（纯函数）
await t('maskPeer / maskSource: 前三位 + 后三位，channel 原样（不认平台）', () => {
  assert.equal(F.maskPeer('1234567890'), '123****890')
  assert.equal(F.maskPeer('9876543210123'), '987****123')
  assert.equal(F.maskPeer('12345'), '1****')      // 太短：只留一位
  assert.equal(F.maskPeer(''), '')
  assert.equal(F.maskPeer(undefined), '')
  assert.equal(F.maskSource('myapp/1234567890'), 'myapp/123****890')
  assert.equal(F.maskSource('discord/cafe-guild-42'), 'discord/caf****-42')
  assert.equal(F.maskSource(''), '')
  assert.equal(F.maskSource('noloseslash'), 'noloseslash')
})
await t('shortSessionId: 只露后 8 位，带不带 session- 前缀都一样', () => {
  assert.equal(F.shortSessionId('session-1111aaaa-2222-3333-4444-a1f3c2d9'), '…a1f3c2d9')
  assert.equal(F.shortSessionId('1111aaaa-2222-3333-4444-a1f3c2d9'), '…a1f3c2d9')
  assert.equal(F.shortSessionId(''), '')
  assert.equal(F.shortSessionId('abc'), '…abc')
})
await t('parsePointer: 好门牌整份归一（label 去控制字符、ttl 默认 36）', () => {
  const r = F.parsePointer(JSON.stringify({ schema: SCHEMA, channel: 'qa_2-x', peer: 'room-9', scope: 'thread', petHome: true, sessionId: 'session-ab', label: '  群房\u0001 ', updatedAt: '2026-11-15T22:30:00+08:00' }))
  assert.equal(r.ok, true)
  assert.equal(r.pointer.source, 'qa_2-x/room-9')
  assert.equal(r.pointer.label, '群房')
  assert.equal(r.pointer.ttlHours, 36)
  assert.equal(Number.isFinite(r.pointer.updatedAt), true)
})
await t('parsePointer: 版本不对安静忽略；其它字段不合格整份丢掉并说明原因', () => {
  const base = { channel: 'myapp', peer: '1', petHome: true, sessionId: 'session-a', updatedAt: '2026-11-15T00:00:00Z' }
  assert.deepEqual(F.parsePointer('not json'), { ok: false, reason: 'json', silent: false })
  assert.equal(F.parsePointer(JSON.stringify({ ...base, schema: 'other/follow@9' })).silent, true)
  assert.equal(F.parsePointer(JSON.stringify(base)).silent, true)                        // 没 schema
  for (const [field, bad] of Object.entries({
    channel: 'QQ', peer: 'has space', scope: 'too long ' + 'x'.repeat(40),
    petHome: 'true', sessionId: '', updatedAt: 'yesterday', ttlHours: 0,
  })) {
    const r = F.parsePointer(JSON.stringify({ ...base, schema: SCHEMA, [field]: bad }))
    assert.equal(r.ok, false, field)
    assert.equal(r.reason, field, field)
  }
  assert.equal(F.parsePointer(JSON.stringify({ ...base, schema: SCHEMA, ttlHours: 721 })).reason, 'ttlHours')
  assert.equal(F.parsePointer(JSON.stringify({ ...base, schema: SCHEMA, petHome: false })).ok, true) // false 合法
})
await t('sanitizeFollow: 默认 manual，只认已知字段', () => {
  assert.deepEqual(F.sanitizeFollow(undefined, undefined), F.FOLLOW_DEFAULT)
  assert.equal(F.sanitizeFollow({}, {}).mode, 'manual')
  assert.equal(F.sanitizeFollow({ mode: 'guess' }, {}).mode, 'manual')
  assert.equal(F.sanitizeFollow({ mode: 'follow' }, {}).mode, 'follow')
  assert.equal(F.sanitizeFollow({ source: 'myapp/1234567890' }, {}).source, 'myapp/1234567890')
  assert.equal(F.sanitizeFollow({ source: 'nope' }, {}).source, '')
  assert.equal(F.sanitizeFollow({ source: 'QQ/1' }, {}).source, '')
  assert.equal(F.sanitizeFollow({ intervalSec: 1 }, {}).intervalSec, 5)
  assert.equal(F.sanitizeFollow({ intervalSec: 9999 }, {}).intervalSec, 300)
  assert.equal(F.sanitizeFollow({ intervalSec: 'abc' }, {}).intervalSec, 20)
  assert.equal(F.sanitizeFollow({ nope: 1 }, {}).nope, undefined)
})
await t('sanitizeLoopbackUrl 只收回环 http；sanitizeFollowDir 只收绝对路径', () => {
  assert.equal(F.sanitizeLoopbackUrl('http://127.0.0.1:8123/follow'), 'http://127.0.0.1:8123/follow')
  assert.equal(F.sanitizeLoopbackUrl('http://localhost:9000/x'), 'http://localhost:9000/x')
  assert.equal(F.sanitizeLoopbackUrl('http://10.0.0.5:9000/x'), '')
  assert.equal(F.sanitizeLoopbackUrl('https://127.0.0.1:9000/x'), '')
  assert.equal(F.sanitizeLoopbackUrl('http://user:pw@127.0.0.1:9000/x'), '')
  assert.equal(F.sanitizeLoopbackUrl('file:///c:/x'), '')
  assert.equal(F.sanitizeFollowDir('follow'), '')
  assert.equal(F.sanitizeFollowDir(join(tmpdir(), 'x')), join(tmpdir(), 'x'))
})

// ------------------------------------------------------------------ 2. 读来源表
const makeFollow = (options = {}) => {
  const dir = options.dir || tmp()
  const dataDir = options.dataDir || dir
  const state = { manual: 'session-home', mode: 'follow', source: 'myapp/10000', dir, httpUrl: '', intervalSec: 20, ...(options.state || {}) }
  const changes = []
  const follow = F.createFollow({
    dataDir,
    settings: () => ({ voice: { llm: { sessionId: state.manual } }, followSession: { ...state } }),
    verify: options.verify || (async () => ({ ok: true })),
    onChange: (info) => { changes.push(info); if (options.onChange) options.onChange(info) },
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  })
  return { follow, state, changes, dir, dataDir }
}

await t('读门牌：同来源取最新；超大 / .tmp / 隐藏 / 非 json 都跳过', async () => {
  const dir = tmp()
  // 时间用相对现在的值：写死日期几天后就会因为「门牌过期」被跳过，测试自己变红
  writePointer(dir, 'a.json', { sessionId: 'session-old', updatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(), label: '旧' })
  writePointer(dir, 'b.json', { sessionId: 'session-fresh', updatedAt: new Date(Date.now() - 60e3).toISOString(), label: '新' })
  writePointer(dir, 'c.json', { channel: 'discord', peer: 'cafe-42', scope: 'channel', sessionId: 'session-cafe' })
  writeFileSync(join(dir, 'big.json'), JSON.stringify({ schema: SCHEMA, channel: 'myapp', peer: '9', petHome: true, sessionId: 'session-x', updatedAt: new Date().toISOString(), pad: 'x'.repeat(5000) }), 'utf8')
  writeFileSync(join(dir, 'half.json.tmp'), '{"schema":', 'utf8')
  writeFileSync(join(dir, '.hidden.json'), '{}', 'utf8')
  writeFileSync(join(dir, 'notjson.txt'), 'hi', 'utf8')
  let linked = false
  try { symlinkSync(join(dir, 'a.json'), join(dir, 'link.json'), 'file'); linked = true } catch { linked = false } // 建不了就跳过
  const { follow } = makeFollow({ dir, state: { source: 'myapp/10000' } })
  await follow.tick()
  assert.deepEqual(follow.sources.map((p) => p.source).sort(), ['discord/cafe-42', 'myapp/10000'])
  assert.equal(follow.sources.find((p) => p.source === 'myapp/10000').sessionId, 'session-fresh')
  assert.equal(follow.sources.find((p) => p.source === 'myapp/10000').label, '新')
  assert.equal(follow.effectiveSessionId(), 'session-fresh')
  void linked
  follow.stop()
})

// ------------------------------------------------------------------ 3. 跟随器
await t('跟随器：手动模式一个字都不改（有效会话为空 = 用原值）', async () => {
  const { follow, state, dir } = makeFollow()
  writePointer(dir, 'p.json')
  state.mode = 'manual'
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), '')
  assert.equal(follow.view({ voice: { llm: { sessionId: 'home' } } }).voice.llm.sessionId, 'home')
  follow.stop()
})
await t('跟随器：跟到新会话、写 follow-state、回调一次；再 tick 不重复回调', async () => {
  const { follow, dir, changes } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-first' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-first')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].reason, 'initial')
  const saved = JSON.parse(readFileSync(join(dir, F.FOLLOW_STATE_FILE), 'utf8'))
  assert.deepEqual({ channel: saved.channel, peer: saved.peer, sessionId: saved.sessionId, label: saved.label }, { channel: 'myapp', peer: '10000', sessionId: 'session-first', label: '私聊' })
  writePointer(dir, 'p.json', { sessionId: 'session-second' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-second')
  assert.equal(changes.at(-1).reason, 'moved')
  const n = changes.length
  await follow.tick()
  assert.equal(changes.length, n)
  follow.stop()
})
await t('跟随器：petHome 不是 true 就不跟（只看这个布尔）', async () => {
  const { follow, dir } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-group', petHome: false })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), '')
  assert.match(follow.warning, /不适合当桌宠的家/)
  follow.stop()
})
// 只拦不放的第二道闸——scope 是多人场合时，petHome: true 也不跟
await t('跟随器：scope 声明多人场合时 petHome:true 也不跟；scope 不填照常跟', async () => {
  for (const scope of ['group', 'Channel', 'GUILD', '群聊', '频道']) {
    const { follow, dir } = makeFollow()
    writePointer(dir, 'p.json', { sessionId: 'session-g', petHome: true, scope })
    await follow.tick()
    assert.equal(follow.effectiveSessionId(), '', 'scope=' + scope)
    assert.match(follow.warning, /多人场合/)
    follow.stop()
  }
  const { follow, dir } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-dm', petHome: true, scope: 'direct' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-dm')
  follow.stop()
  const b = makeFollow()
  writePointer(b.dir, 'p.json', { sessionId: 'session-small', petHome: true, scope: undefined }) // 两人小群：桥不填 scope
  await b.follow.tick()
  assert.equal(b.follow.effectiveSessionId(), 'session-small')
  b.follow.stop()
  assert.equal(F.homeEligible({ petHome: true, scope: 'room' }), false)
  assert.equal(F.homeEligible({ petHome: true, scope: '' }), true)
  assert.equal(F.homeEligible({ petHome: false, scope: 'direct' }), false)
})
await t('跟随器：已跟着的来源被改标成多人场合 → 不再跟新会话，保持上次已知', async () => {
  const { follow, dir } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-home', petHome: true, scope: 'direct' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-home')
  writePointer(dir, 'p.json', { sessionId: 'session-now-group', petHome: true, scope: 'group' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-home')
  assert.match(follow.warning, /多人场合/)
  follow.stop()
})
await t('跟随器：删掉 / 写坏 / 过期 → 保持上次已知会话 + warning', async () => {
  const { follow, dir } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-known' })
  await follow.tick()
  const file = join(dir, 'p.json')
  rmSync(file)
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.ok(follow.warning)
  writeFileSync(file, '{"schema":"dsh-pixel-pet/follow@1","chan', 'utf8')
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.ok(follow.warning)
  writePointer(dir, 'p.json', { sessionId: 'session-stale', updatedAt: '2020-01-01T00:00:00Z', ttlHours: 1 })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.match(follow.warning, /过期/)
  follow.stop()
})
await t('跟随器：连续 3 次读不到门牌 → 换文案，会话照旧', async () => {
  const { follow, dir } = makeFollow()
  writePointer(dir, 'p.json', { sessionId: 'session-known' })
  await follow.tick()
  rmSync(join(dir, 'p.json'))
  for (let i = 0; i < 3; i++) await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.match(follow.warning, /连续读不到/)
  follow.stop()
})
await t('跟随器：指向不存在 / 已归档的会话 → 不切，且不会去跟它', async () => {
  const verdicts = { 'session-gone': { ok: false, reason: 'missing' }, 'session-archived': { ok: false, reason: 'archived' } }
  const { follow, dir } = makeFollow({ verify: async (id) => verdicts[id] || { ok: true } })
  writePointer(dir, 'p.json', { sessionId: 'session-known' })
  await follow.tick()
  writePointer(dir, 'p.json', { sessionId: 'session-gone' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.match(follow.warning, /不在了/)
  writePointer(dir, 'p.json', { sessionId: 'session-archived' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-known')
  assert.match(follow.warning, /已归档/)
  follow.stop()
})
await t('跟随器：重启（同一目录新实例）后上次已知会话还在', async () => {
  const dataDir = tmp()
  const dir = tmp()
  const first = makeFollow({ dir, dataDir })
  writePointer(dir, 'p.json', { sessionId: 'session-persisted' })
  await first.follow.tick()
  assert.equal(first.follow.effectiveSessionId(), 'session-persisted')
  first.follow.stop()
  rmSync(join(dir, 'p.json'))
  const second = makeFollow({ dir, dataDir })
  await second.follow.tick()
  assert.equal(second.follow.effectiveSessionId(), 'session-persisted')
  assert.ok(second.follow.warning)
  second.follow.stop()
})
await t('跟随器：设置里存的是**脱敏**来源键也照样跟得上（面板只显示 123****890）', async () => {
  const { follow, state, dir } = makeFollow()
  writePointer(dir, 'p.json', { peer: '1234567890', sessionId: 'session-masked' })
  state.source = 'myapp/123****890'                 // 面板下拉框里用户能看见、也是唯一能选的那个值
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-masked')
  assert.equal(follow.warning, '')
  // 再加一个来源（脱敏后不一样）不影响命中
  writePointer(dir, 'q.json', { channel: 'myapp', peer: '777888999', sessionId: 'session-other' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-masked')   // 仍跟原来那个
  assert.equal(follow.warning, '')
  follow.stop()
})
await t('跟随器：撞名的脱敏键 → warning，不猜是哪一条', async () => {
  const { follow, state, dir } = makeFollow({ state: { source: 'myapp/123****890' } })
  writePointer(dir, 'a.json', { peer: '1234567890', sessionId: 'session-a' })
  writePointer(dir, 'b.json', { peer: '123ZZZ890', sessionId: 'session-b' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), '')
  assert.match(follow.warning, /认不出/)
  follow.stop()
})

await t('跟随器：只跟设置里选中的那一个；换来源立刻换会话', async () => {
  const { follow, state, dir } = makeFollow()
  writePointer(dir, 'a.json', { sessionId: 'session-home-1' })
  writePointer(dir, 'b.json', { channel: 'discord', peer: 'cafe-guild', scope: 'dm', sessionId: 'session-cafe' })
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-home-1')
  state.source = 'discord/cafe-guild'
  await follow.tick()
  assert.equal(follow.effectiveSessionId(), 'session-cafe')
  follow.stop()
})
await t('跟随器：HTTP 门牌（数组）也认；非回环地址一个请求都不发', async () => {
  const dir = tmp()
  const body = JSON.stringify([{ schema: SCHEMA, channel: 'myapp', peer: '77', petHome: true, sessionId: 'session-http', updatedAt: new Date().toISOString(), label: 'http' }])
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    assert.equal(url, 'http://127.0.0.1:8123/follow')
    return { status: 200, headers: { get: () => String(body.length) }, text: async () => body }
  }
  const { follow, state } = makeFollow({ dir, fetchImpl })
  state.source = 'myapp/77'
  state.httpUrl = 'http://127.0.0.1:8123/follow'
  await follow.tick()
  assert.equal(calls, 1)
  assert.equal(follow.effectiveSessionId(), 'session-http')
  state.httpUrl = 'http://example.com/follow'
  await follow.tick()
  assert.equal(calls, 1)                     // 非回环：不请求
  follow.stop()
})

// ------------------------------------------------------------------ 4. 宿主接线（真 apply + 假 ctx）
// 这些会话 id 在假 DSH 里都是「活的」；要测「不存在 / 已归档」的用例自己传 live / known / archived
const LIVE = ['session-home', 'session-followed', 'session-cafe', 'session-custom-dir', 'session-group',
  'session-typed', 'session-timer-a', 'session-timer-b', 'session-persisted', 'session-after-delete',
  'session-aaaaaaaa-bbbb-cccc-dddd-a1f3c2d9']

function fakeCtx ({ live = LIVE, known = null, archived = [] } = {}) {
  const handlers = {}
  const effects = []
  let route = null
  const agents = new Map()
  const reg = new Map()
  const services = {
    webServer: { register (r) { route = r; return () => {} } },
    sessions: { list: () => live.map((id) => ({ id, header: { id } })) },
    sessionQuery: { listSessions: async () => (known || live).map((id) => ({ header: { id, cwd: 'D:\\synthetic' }, live: true })) },
    workspaceRegistry: { archivedSessionIds: archived },
    tools: { register (def) { reg.set(def.name, def); return () => reg.delete(def.name) } },
  }
  const ctx = {
    logger: { warn () {}, info () {} },
    get: (n) => services[n],
    agents: { get: (id) => agents.get(keyOf(id)) },
    on (ev, fn) { handlers[ev] = fn; return () => {} },
    effect (fn) { effects.push(fn()) },
    _emit: (session, event) => { const h = handlers['session/event']; if (h) h(session, event) },
    _agents: agents,
  }
  return { ctx, agents, get route () { return route }, effects, reg }
}

function agentAt (f, sid) {
  const k = keyOf(sid)
  if (!f.agents.has(k)) f.agents.set(k, { calls: [], async followup (msg) { this.calls.push(msg); return 'sent' } })
  return f.agents.get(k)
}
function fakeChild () {
  const c = new EventEmitter()
  c.exitCode = null; c.signalCode = null; c.stderr = new EventEmitter()
  c.kill = () => { c.exitCode = 0; c.emit('exit', 0) }
  return c
}

/** 剩下的字段就是 settings.json 的内容（voice / followSession / …），ctx 相关的单独挑出来 */
async function hostWith ({ live = LIVE, known = null, archived = [], dataDir = null, ...settings } = {}) {
  const dir = dataDir || tmp()
  const base = { voice: { llm: { sessionId: 'session-home' } }, autoStart: false, followSession: { mode: 'manual', source: '', dir: '', httpUrl: '', intervalSec: 20 } }
  const merged = { ...base, ...settings, voice: { ...base.voice, ...(settings.voice || {}) }, followSession: { ...base.followSession, ...(settings.followSession || {}) } }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(merged), 'utf8')
  const f = fakeCtx({ live, known, archived })
  const keys = []
  H.apply(f.ctx, {
    dataDir: dir,
    autoInstall: false,
    pythonManager: { path: 'synthetic-python', quick: () => '', detect: async () => ({}), snapshot: () => ({}) },
    spawn: (exe, args, options) => { keys.push(options.env.PIXELPET_BRIDGE_KEY); return fakeChild() },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  f.dir = dir
  f.keys = keys
  return f
}

async function call (route, method, path, { body, headers = {} } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080', ...headers }
  let status = 0; let out = ''
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = String(b) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : JSON.stringify(body))
  await p
  return { status, json: JSON.parse(out || 'null') }
}
const followDirOf = (dir) => join(dir, 'follow')
const settingsOnDisk = (dir) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
const petKey = async (f) => { await call(f.route, 'POST', '/api/pet/start'); return f.keys.at(-1) }

/** 桌宠发一次问（ask/start，不 await 整轮），收尾时把这一轮结束掉，免得同一会话的下一条被 409 */
async function askOnce (f, key, requestId, text = '在吗') {
  const r = await call(f.route, 'POST', '/api/ask/start', { body: { sessionId: 'session-home', requestId, text }, headers: { 'x-pixelpet-key': key } })
  await tick()
  assert.ok(r.status === 202 || r.status === 200, 'ask/start ' + r.status + ' ' + JSON.stringify(r.json))
  const sid = r.json.sessionId
  const msg = agentAt(f, sid).calls.at(-1) || { id: requestId, content: [] }
  f.ctx._emit({ id: sid }, { type: 'turn/start', data: { turn: 1 } })
  f.ctx._emit({ id: sid }, { type: 'user/message', data: { id: msg.id, role: 'user', content: [] } })
  f.ctx._emit({ id: sid }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  return { status: r.status, sid, msg }
}

await t('宿主：默认手动模式与今天一致', async () => {
  const f = await hostWith()
  const st = await call(f.route, 'GET', '/api/state')
  assert.equal(st.json.settings.voice.llm.sessionId, 'session-home')
  assert.equal(st.json.effectiveSessionId, '')
  assert.equal(st.json.followMode, 'manual')
  const r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.mode, 'manual')
  assert.deepEqual(r.json.sources, [])
  assert.equal(r.json.manualSessionId, F.shortSessionId('session-home'))
  assert.equal(r.json.effectiveSessionId, '')
  assert.equal(r.json.warning, '')
})

await t('宿主：跟随模式下保存别的设置，绝不把手填会话写成有效会话', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-followed' })
  await call(f.route, 'GET', '/api/follow')                  // 与 tick 同一条重算路径
  assert.equal(settingsOnDisk(f.dir).voice.llm.sessionId, 'session-home')
  const r = await call(f.route, 'POST', '/api/settings', { body: { size: 0.72 } })
  assert.equal(r.status, 200)
  assert.equal(settingsOnDisk(f.dir).voice.llm.sessionId, 'session-home')   // 手填值没被覆盖
  assert.equal(r.json.effectiveSessionId, 'session-followed')
  const r2 = await call(f.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-typed' } } } })
  assert.equal(r2.status, 200)
  assert.equal(settingsOnDisk(f.dir).voice.llm.sessionId, 'session-typed')  // 用户真的改了就照写
})

await t('宿主：跟随模式下 relay 发给有效会话，请求体里的 sessionId 被忽略', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-followed' })
  const oldAgent = agentAt(f, 'session-home')
  const newAgent = agentAt(f, 'session-followed')
  const key = await petKey(f)
  await call(f.route, 'GET', '/api/follow')
  const sent = await askOnce(f, key, 'req-follow-1')
  assert.equal(sent.sid, 'session-followed')
  assert.equal(oldAgent.calls.length, 0)                     // 旧会话一条都没收到
  assert.equal(newAgent.calls.length, 1)
  assert.equal(newAgent.calls[0].source.kind, 'pixel-pet')
  assert.ok(newAgent.calls[0].id.startsWith('pixel-pet-'), newAgent.calls[0].id)
  // 回来取结果：仍按发出时的会话认（带着手填的 sessionId 也找得到）
  const res = await call(f.route, 'POST', '/api/ask/result', { body: { sessionId: 'session-home', requestId: 'req-follow-1', waitMs: 0 }, headers: { 'x-pixelpet-key': key } })
  assert.equal(res.status, 200)
  assert.equal(res.json.requestId, 'req-follow-1')
  assert.equal(res.json.sessionId, 'session-followed')
})

await t('宿主：切回手动立刻恢复手填会话', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-followed' })
  const oldAgent = agentAt(f, 'session-home')
  const newAgent = agentAt(f, 'session-followed')
  const key = await petKey(f)
  await call(f.route, 'GET', '/api/follow')
  await askOnce(f, key, 'req-follow-mode')
  await call(f.route, 'POST', '/api/settings', { body: { followSession: { mode: 'manual' } } })
  await sleep(50)                                            // kick() 排的是 0 ms 定时器
  await askOnce(f, key, 'req-back-manual')
  assert.equal(newAgent.calls.length, 1)
  assert.equal(oldAgent.calls.length, 1)
})

await t('宿主：切到新会话后，消息模式的提示词会在新会话第一条消息里再附一次', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-followed' })
  agentAt(f, 'session-home')
  const newAgent = agentAt(f, 'session-followed')
  const key = await petKey(f)
  await call(f.route, 'GET', '/api/follow')
  const hasGuide = (msg) => JSON.stringify(msg.content).includes('<pixelpet-guide>')
  await askOnce(f, key, 'req-guide-1')
  assert.equal(hasGuide(newAgent.calls[0]), true)
  await askOnce(f, key, 'req-guide-2')
  assert.equal(hasGuide(newAgent.calls[1]), false)            // 同一会话第二次不再附
})

await t('宿主：门牌删掉 → /api/follow 黄字，桌宠仍用上次的会话', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  const file = writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-followed' })
  const newAgent = agentAt(f, 'session-followed')
  const key = await petKey(f)
  let r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, F.shortSessionId('session-followed'))
  rmSync(file)
  r = await call(f.route, 'GET', '/api/follow')
  assert.ok(r.json.warning)
  assert.equal(r.json.effectiveSessionId, F.shortSessionId('session-followed'))
  await askOnce(f, key, 'req-after-delete')
  assert.equal(newAgent.calls.length, 1)
})

await t('宿主：petHome 不是 true → 不跟随，sources.eligible 为 false', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-group', petHome: false })
  const r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, '')
  assert.equal(r.json.sources[0].eligible, false)
  assert.equal(r.json.sources[0].petHome, false)
  assert.match(r.json.warning, /不适合当桌宠的家/)
})

await t('宿主：指向已归档 / 已不存在的会话 → 不切，给 warning', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000' }, known: ['session-home', 'session-dead'], archived: ['session-old-home'] })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-old-home' })
  let r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, '')
  assert.match(r.json.warning, /已归档/)
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-nowhere' })
  r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, '')
  assert.match(r.json.warning, /不在了/)
})

await t('宿主：平台无关（discord 私信 id / scope=dm 照样跟得上；代码里没有平台分支；scope=channel 属于多人场合，见上面的闸）', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'discord/cafe-guild' } })
  writePointer(followDirOf(f.dir), 'p.json', { channel: 'discord', peer: 'cafe-guild', scope: 'dm', sessionId: 'session-cafe', label: '私信' })
  const newAgent = agentAt(f, 'session-cafe')
  const key = await petKey(f)
  const r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, F.shortSessionId('session-cafe'))
  assert.equal(r.json.sources[0].channel, 'discord')
  await askOnce(f, key, 'req-discord')
  assert.equal(newAgent.calls.length, 1)
  const src = readFileSync(join(H.PLUGIN_ROOT, 'lib', 'follow.js'), 'utf8')
  for (const platform of ['qq', 'discord', 'telegram', 'feishu', 'matrix', 'slack', 'wechat']) {
    assert.ok(!new RegExp('[\'"]' + platform + '[\'"]').test(src), 'follow.js 出现平台字面：' + platform)
  }
})

await t('宿主：/api/follow 脱敏；接入说明里没有 {{，也没有会话 id / 号码', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/1234567890' } })
  writePointer(followDirOf(f.dir), 'p.json', { peer: '1234567890', sessionId: 'session-aaaaaaaa-bbbb-cccc-dddd-a1f3c2d9', label: '私聊' })
  const r = await call(f.route, 'GET', '/api/follow')
  const raw = JSON.stringify(r.json)
  assert.ok(!raw.includes('1234567890'), 'peer 露出了原文')
  assert.ok(!raw.includes('aaaaaaaa-bbbb'), '会话 id 露出了完整值')
  assert.equal(r.json.sources[0].peer, '123****890')
  assert.equal(r.json.sources[0].source, 'myapp/123****890')
  assert.equal(r.json.source, 'myapp/123****890')
  assert.equal(r.json.effectiveSessionId, '…a1f3c2d9')
  assert.equal(r.json.lastKnown.sessionId, '…a1f3c2d9')
  const it = await call(f.route, 'GET', '/api/follow/integration')
  assert.equal(it.status, 200)
  assert.ok(!it.json.text.includes('{{'), '渲染后还留着占位符')
  assert.ok(it.json.text.includes(followDirOf(f.dir)))
  assert.ok(!it.json.text.includes('a1f3c2d9'))
  assert.ok(!it.json.text.includes('1234567890'))
  assert.ok(it.json.text.includes(SCHEMA))
  assert.ok(it.json.text.includes('/dsh-pixel-pet'), '接口地址要换成真实端口')
  assert.ok(it.json.text.startsWith('前提：'))
  // 只认本机同源
  assert.equal((await call(f.route, 'GET', '/api/follow', { headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await call(f.route, 'GET', '/api/follow/integration', { headers: { origin: 'http://evil.example' } })).status, 403)
})

await t('宿主：门牌目录（绝对路径）生效；相对路径被拒', async () => {
  const custom = tmp('pp-follow-dir-')
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000', dir: custom } })
  writePointer(custom, 'p.json', { sessionId: 'session-custom-dir' })
  const r = await call(f.route, 'GET', '/api/follow')
  assert.equal(r.json.effectiveSessionId, F.shortSessionId('session-custom-dir'))
  const r2 = await call(f.route, 'POST', '/api/settings', { body: { followSession: { dir: 'relative/dir' } } })
  assert.equal(r2.status, 200)
  assert.equal(settingsOnDisk(f.dir).followSession.dir, '')
})

await t('宿主：跟随器自己按 intervalSec 跑（不靠任何请求推动）', async () => {
  const f = await hostWith({ followSession: { mode: 'follow', source: 'myapp/10000', intervalSec: 5 } })
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-timer-a' })
  await call(f.route, 'GET', '/api/follow')
  assert.equal((await call(f.route, 'GET', '/api/follow')).json.effectiveSessionId, F.shortSessionId('session-timer-a'))
  writePointer(followDirOf(f.dir), 'p.json', { sessionId: 'session-timer-b' })
  let seen = null
  for (let i = 0; i < 14 && !seen; i++) {
    await sleep(500)
    const st = JSON.parse(readFileSync(join(f.dir, 'follow-state.json'), 'utf8'))
    if (st.sessionId === 'session-timer-b') seen = st
  }
  assert.ok(seen, '5 秒周期内没跟上（follow-state.json）')
})

await t('出站标记：余额行也带 source.kind=pixel-pet 与 pixel-pet- 前缀', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'balance-settings.json'), JSON.stringify({ key: 'sk-synthetic-follow-0123456789', threshold: 5, inject: true }), 'utf8')
  const b = createBalance({
    dataDir: dir,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '23.40' }] }) }),
    pointed: () => 'session-home',
  })
  const listeners = {}
  b.attach({ on: (ev, fn) => { listeners[ev] = fn; return () => {} } })
  const out = await listeners['agent/pre-step']({ agent: { session: { id: 'session-home' } }, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].source.kind, 'pixel-pet')
  assert.ok(out.messages[0].id.startsWith('pixel-pet-'))
})

await t('切会话：主动关心的「在跑」判断立刻按新会话算；pet-activity 记一行 follow', async () => {
  const dir = tmp()
  const bound = { sid: 'session-a' }
  const p = createProactive({
    dataDir: dir,
    settings: () => ({ voice: { llm: { sessionId: bound.sid } }, autonomy: { enabled: true, care: false } }),
    relay: { ask: async () => ({ code: 200, body: { ok: true } }), pending: new Map() },
    now: () => 1_700_000_000_000,
  })
  p.onEvent({ id: 'session-a' }, { type: 'turn/start', data: { turn: 7 } })
  assert.equal(p.busy('a'), true)                       // 旧会话在跑
  bound.sid = 'session-b'                               // 跟随切到新会话
  p.resetSession()                                      // 宿主在 onChange 里调的那一下
  assert.equal(p.busy('b'), false)                      // 立刻按新会话算，不被旧 turn 卡住
  // onEvent 侧也一样：会话变了，旧的 turn 记号作废
  p.onEvent({ id: 'session-b' }, { type: 'turn/start', data: { turn: 8 } })
  assert.equal(p.busy('b'), true)
  bound.sid = 'session-c'
  p.onEvent({ id: 'session-c' }, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
  assert.equal(p.busy('c'), false)
  p.stop()
  // pet-activity 记得到这一行（只记变化本身，不记会话 id）
  const log = createPetActivity({ dataDir: dir })
  assert.equal(log.record('follow', { changed: true }), true)
  const rows = readFileSync(join(dir, 'pet-activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows.at(-1).kind, 'follow')
  assert.equal(rows.at(-1).changed, true)
  assert.ok(!JSON.stringify(rows.at(-1)).includes('session-'))
})

await t('出站标记：relay.post 的 id 也带前缀', async () => {
  const calls = []
  const relay = createRelay({ on: () => () => {} }, undefined, { findAgent: async () => ({ agent: { followup: async (m) => { calls.push(m) } } }) })
  await relay.post('session-x', '你好')
  assert.equal(calls[0].source.kind, 'pixel-pet')
  assert.ok(calls[0].id.startsWith('pixel-pet-'))
  relay.dispose()
})

await t('协议字面：文档 / 模板 / 示例里没有部署方私有前缀', async () => {
  // 协议字面（schema、字段、示例、面板文案）里不许出现任何人的私有前缀；插件自身的其它名字（窗口名等）不算
  const files = ['lib/follow.js', 'docs/FOLLOW.md', 'prompts/follow-integration.md', 'examples/follow/write-pointer.mjs', 'examples/follow/write_pointer.py', 'examples/follow/skip-pet-turns.md', 'web/index.html']
  for (const file of files) {
    const text = readFileSync(join(H.PLUGIN_ROOT, file), 'utf8')
    // 协议里出现的每一个 schema 字面都必须是公开的那一个（不带任何部署方的私有前缀）
    for (const m of text.matchAll(/schema"?\s*[:=]\s*["']([^"'\s]+)["']/gi)) assert.equal(m[1], SCHEMA, file + ' 的 schema 带了别的前缀：' + m[1])
  }
  // 面板逻辑也不能有：跟随只认 petHome
  const app = readFileSync(join(H.PLUGIN_ROOT, 'web', 'app.js'), 'utf8')
  for (const m of app.matchAll(/schema"?\s*[:=]\s*["']([^"'\s]+)["']/gi)) assert.equal(m[1], SCHEMA, 'web/app.js 的 schema 带了别的前缀：' + m[1])
  assert.ok(readFileSync(join(H.PLUGIN_ROOT, 'docs', 'FOLLOW.md'), 'utf8').includes(SCHEMA))
})

console.log(`\nfollow: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
