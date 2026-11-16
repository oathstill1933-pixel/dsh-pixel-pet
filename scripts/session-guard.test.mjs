// node scripts/session-guard.test.mjs — lib/session-guard.js (tool gap) and its host wiring, fake DSH ctx only
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as G from '../lib/session-guard.js'
import * as H from '../lib/host.js'

const { createSessionGuard, toolNamesOf } = G

process.env.PIXELPET_NO_AUTO_INSTALL = '1'
let n = 0
const test = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const tmp = () => mkdtempSync(join(tmpdir(), 'pp-guard-'))
const schemas = (...names) => names.map((name) => ({ name, description: 'x', parameters: { type: 'object' } }))

await test('the "don\'t tell" privacy list is gone (switch the feature / plugin off instead)', () => {
  assert.equal('sanitizePrivacy' in G, false); assert.equal('isExcludedHeader' in G, false)
  assert.equal(H.SETTINGS_KEYS.includes('privacy'), false)
  assert.equal('privacy' in H.mergeSettings({}, {}), false)
  assert.equal('privacy' in H.mergeSettings({}, { privacy: { excludePresets: ['clawd'] } }), false) // an old saved value is dropped
})

await test('toolNamesOf: tools / omitted empty list / no header', () => {
  assert.deepEqual(toolNamesOf({ config: {}, tools: schemas('a', 'b') }), ['a', 'b'])
  assert.deepEqual(toolNamesOf({ config: {} }), [])
  assert.equal(toolNamesOf(undefined), null)
})

const REG = ['pixelpet_status', 'pixelpet_say', 'pixelpet_mail_like']
const guardFor = (sid = 'session-s1', registered = REG) => {
  const dir = tmp()
  const g = createSessionGuard({ dataDir: dir, settings: () => ({ voice: { llm: { sessionId: sid } } }), registered: () => registered, now: () => 1_700_000_000_000 })
  return { g, dir }
}

await test('tool gap: missing (fake pre-step with requestHeader)', () => {
  const { g, dir } = guardFor()
  const session = { id: 's1', header: { id: 's1', agentPreset: 'clawd', cwd: 'D:\\workspace-sandbox' }, requestHeader: () => ({ config: {}, tools: schemas('qq_reply_gate', 'pixelpet_status', 'pixelpet_say') }) }
  g.onStep({ session })
  const v = g.view()
  assert.equal(v.available, true); assert.deepEqual(v.missing, ['pixelpet_mail_like']); assert.equal(v.preset, 'clawd'); assert.equal(v.sessionId, 's1')
  assert.equal(typeof v.checkedAt, 'number')
  const file = JSON.parse(readFileSync(join(dir, 'toolgap.json'), 'utf8'))
  assert.deepEqual(file.missing, ['pixelpet_mail_like'])
  assert.ok(!JSON.stringify(file).includes('qq_reply_gate')) // only our tool names are kept
  assert.ok(!JSON.stringify(file).includes('Clawd的小屋')) // cwd never written
})

await test('tool gap: none missing; request/header event updates; other sessions ignored', () => {
  const { g } = guardFor()
  g.onEvent({ id: 's1', header: { id: 's1' } }, { type: 'request/header', data: { header: { config: {}, tools: schemas(...REG, 'bash') } } })
  assert.deepEqual(g.view().missing, []); assert.equal(g.view().available, true)
  g.onEvent({ id: 'other', header: { id: 'other' } }, { type: 'request/header', data: { header: { config: {}, tools: [] } } })
  assert.deepEqual(g.view().missing, [])
  g.onEvent({ id: 's1', header: { id: 's1' } }, { type: 'request/header', data: { header: { config: {} } } }) // tools all blocked
  assert.deepEqual(g.view().missing, [...REG].sort())
})

await test('tool gap: no tool list -> not available, never a guessed list', () => {
  const a = guardFor().g
  a.onStep({ session: { id: 's1', header: { id: 's1' } } }) // DSH without requestHeader()
  assert.deepEqual([a.view().available, a.view().reason, a.view().missing], [false, 'no-header-api', []])
  const b = guardFor().g
  b.onStep({ session: { id: 's1', header: { id: 's1' }, requestHeader: () => undefined } }) // first request not logged yet
  assert.deepEqual([b.view().available, b.view().reason, b.view().missing], [false, 'pending', []])
  const c = guardFor('').g
  assert.equal(c.view().reason, 'unbound')
})

// ------------------------------------------------------------------ host wiring
const KEY = 'sk-FAKE-guard-0123456789'
const OK = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '23.40', granted_balance: '0', topped_up_balance: '23.40' }] }
function fakeCtx () {
  const handlers = {}; let route = null
  const reg = new Map()
  const tools = { register (def) { reg.set(def.name, def); return () => reg.delete(def.name) } }
  const services = { webServer: { register (r) { route = r; return () => {} } }, sessions: { list: () => [] }, tools }
  const ctx = { logger: { warn () {}, info () {} }, get: (k) => services[k], agents: { get: () => undefined }, on: (ev, fn) => { handlers[ev] = fn; return () => {} }, effect: (fn) => { fn() } }
  return { ctx, handlers, reg, get route () { return route } }
}
async function call (route, method, path, { body, headers = {} } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080', ...headers }
  let status = 0; let out = ''
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = String(b) } }
  const p = route.handler(req, res); req.end(body === undefined ? undefined : JSON.stringify(body)); await p
  return { status, json: JSON.parse(out || 'null') }
}
const hostWith = async (privacy) => {
  const dir = tmp()
  const now = new Date()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voice: { llm: { sessionId: 'session-s1' } }, autonomy: { enabled: true, aware: true }, privacy }))
  writeFileSync(join(dir, 'activity-log.jsonl'), JSON.stringify({ t: new Date(now.getTime() - 10 * 60_000).toISOString(), state: 'work', app: 'code.exe' }) + '\n')
  const f = fakeCtx()
  H.apply(f.ctx, { dataDir: dir, fetch: async () => ({ ok: true, status: 200, json: async () => OK }) })
  await call(f.route, 'POST', '/api/balance/settings', { body: { key: KEY } })
  return f
}
const clawd = { id: 's1', header: { id: 's1', agentPreset: 'clawd', cwd: 'D:\\workspace-sandbox' }, requestHeader: () => ({ config: {}, tools: schemas('pixelpet_status', 'pixelpet_say') }) }
const step = (f, session, turn = 1) => f.handlers['agent/pre-step']({ agent: { session }, turn, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))

await test('host: the bound session gets the balance line + deepseekBalance + activityToday, whatever its preset', async () => {
  // an old saved "privacy" value no longer hides anything: only 「告诉 AI」 / the plugin switch decide
  const f = await hostWith({ excludePresets: ['clawd'] })
  const d = await step(f, clawd)
  assert.equal(d.messages.length, 1); assert.match(d.messages[0].content[0].text, /DeepSeek 余额 ¥23\.40/)
  const st = await f.reg.get('pixelpet_status').execute({}, { agent: { session: clawd } })
  assert.equal(st.data.deepseekBalance.total, 23.4); assert.ok(st.data.activityToday)
})

await test('host: GET /api/toolgap reports observed gap + preset, origin checked', async () => {
  const f = await hostWith({})
  let r = await call(f.route, 'GET', '/api/toolgap')
  assert.equal(r.status, 200); assert.equal(r.json.available, false); assert.deepEqual(r.json.missing, [])
  await step(f, clawd)
  r = await call(f.route, 'GET', '/api/toolgap')
  assert.equal(r.json.sessionId, 's1'); assert.equal(r.json.preset, 'clawd'); assert.equal(r.json.available, true)
  assert.ok(r.json.missing.includes('pixelpet_mail_like') && !r.json.missing.includes('pixelpet_status') && !r.json.missing.includes('pixelpet_say'))
  assert.ok(r.json.missing.every((x) => f.reg.has(x)))
  assert.equal((await call(f.route, 'GET', '/api/toolgap', { headers: { origin: 'http://evil.example' } })).status, 403)
})

console.log(n + ' session-guard tests passed')
