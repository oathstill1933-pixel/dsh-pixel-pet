// node scripts/balance.test.mjs — lib/balance.js with a fake fetch (never touches the network or a real key)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { balanceLine, createBalance, isOfficialBase, parseBalance } from '../lib/balance.js'
import { makeTools } from '../lib/tools.js'

const KEY = 'sk-FAKE-test-0123456789abcdef'
const OK = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.50', granted_balance: '0.00', topped_up_balance: '1.50' }, { currency: 'CNY', total_balance: '23.40', granted_balance: '3.40', topped_up_balance: '20.00' }] }
const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json })

let n = 0
const test = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const make = (fetchImpl, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-bal-'))
  const calls = []
  const clock = { t: 1_700_000_000_000 }
  const b = createBalance({ dataDir: dir, fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init) }, now: () => clock.t, pointed: () => 'session-abc', ...extra })
  return { b, dir, calls, clock }
}
const noKeyOutside = (dir) => readdirSync(dir).filter((f) => f !== 'balance-settings.json').every((f) => !readFileSync(join(dir, f), 'utf8').includes(KEY))

await test('parse: CNY preferred, strings to numbers, bad shapes throw', () => {
  const r = parseBalance(OK)
  assert.deepEqual(r, { isAvailable: true, currency: 'CNY', total: 23.4, granted: 3.4, toppedUp: 20 })
  assert.throws(() => parseBalance({ balance_infos: [] }))
  assert.throws(() => parseBalance({ is_available: true, balance_infos: [] }))
  assert.equal(balanceLine({ currency: 'CNY', total: 3.2, low: true }), 'DeepSeek 余额 ¥3.20（偏低）')
})

await test('official base only; unofficial never sends the key', async () => {
  for (const u of ['', 'https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1']) assert.ok(isOfficialBase(u), u)
  for (const u of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.io', 'https://proxy.example/v1', 'https://api.deepseek.com:8443', 'https://u:p@api.deepseek.com', 'https://api.deepseek.com/x']) assert.ok(!isOfficialBase(u), u)
  const { b, calls } = make(async () => reply(200, OK))
  const r = await b.handle('POST', '/api/balance/settings', { key: KEY, baseUrl: 'https://proxy.example/v1' })
  assert.equal(r.body.official, false); assert.equal(r.body.balance, null); assert.equal(calls.length, 0)
  assert.equal(await b.injectLine('abc'), null)
})

await test('5-minute cache (memory + file), forced refresh bypasses it', async () => {
  const { b, dir, calls, clock } = make(async () => reply(200, OK))
  b.saveSettings({ key: KEY, threshold: 30 })
  assert.equal((await b.get()).total, 23.4)
  await b.get(); clock.t += 4 * 60_000; await b.get()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance'); assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY)
  clock.t += 2 * 60_000; await b.get(); assert.equal(calls.length, 2)
  await b.handle('POST', '/api/balance/refresh', {}); assert.equal(calls.length, 3)
  const file = JSON.parse(readFileSync(join(dir, 'balance.json'), 'utf8'))
  assert.equal(file.total, 23.4); assert.equal(file.low, true); assert.deepEqual(Object.keys(file).sort(), ['at', 'currency', 'granted', 'isAvailable', 'low', 'toppedUp', 'total'])
  // a new instance reads the file cache: no request within TTL
  const calls2 = []
  const b2 = createBalance({ dataDir: dir, fetchImpl: async () => { calls2.push(1); return reply(200, OK) }, now: () => clock.t })
  assert.equal((await b2.get()).total, 23.4); assert.equal(calls2.length, 0)
})

await test('failures are silent: old cache or null', async () => {
  let mode = 'ok'
  const { b, clock } = make(async () => { if (mode === 'throw') throw new Error('boom ' + KEY); if (mode === 'http') return reply(401, {}); if (mode === 'bad') return reply(200, { x: 1 }); return reply(200, OK) })
  b.saveSettings({ key: KEY })
  for (const m of ['throw', 'http', 'bad']) { mode = m; assert.equal(await b.get(true), null) }
  mode = 'ok'; await b.get(true)
  for (const m of ['throw', 'http', 'bad']) { mode = m; clock.t += 10 * 60_000; assert.equal((await b.get()).total, 23.4) }
  const slow = make(() => new Promise(() => {}), { timeoutMs: 30 })
  slow.b.saveSettings({ key: KEY }); assert.equal(await slow.b.get(), null)
})

await test('injection: pointed session only, toggle, pre-step shape, once per turn', async () => {
  const { b } = make(async () => reply(200, OK))
  b.saveSettings({ key: KEY, threshold: 30 })
  assert.equal(await b.injectLine('session-abc'), 'DeepSeek 余额 ¥23.40（偏低）')
  assert.equal(await b.injectLine('other'), null)
  b.saveSettings({ inject: false }); assert.equal(await b.injectLine('abc'), null); b.saveSettings({ inject: true })
  let hook
  const ctx = { on: (ev, fn) => { assert.equal(ev, 'agent/pre-step'); hook = fn; return () => {} } }
  b.attach(ctx)
  const session = { id: 'abc' }
  const run = (turn) => hook({ agent: { session }, turn, signal: { aborted: false } }, async () => ({ kind: 'continue', messages: [] }))
  const d1 = await run(1)
  assert.equal(d1.messages.length, 1); assert.equal(d1.messages[0].content[0].text, 'DeepSeek 余额 ¥23.40（偏低）')
  assert.equal((await run(1)).messages.length, 0)
  assert.ok(!JSON.stringify(d1).includes(KEY))
  const rej = await hook({ agent: { session: { id: 'abc' } }, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'reject', messages: [] }))
  assert.equal(rej.kind, 'reject')
})

await test('key never in cache / API / status / prompt', async () => {
  const { b, dir } = make(async () => reply(200, OK))
  b.saveSettings({ key: KEY }); await b.get()
  assert.ok(noKeyOutside(dir))
  for (const [m, p] of [['GET', '/api/balance'], ['POST', '/api/balance/refresh'], ['POST', '/api/balance/settings']]) assert.ok(!JSON.stringify(await b.handle(m, p, {})).includes(KEY))
  const tool = makeTools({ dataDir: 'x', enabled: () => true, send: async () => ({ ok: true, message: 'ok', data: { state: 'idle' } }), balance: () => b.status() }).find((t) => t.name === 'pixelpet_status')
  const r = await tool.execute({})
  assert.equal(r.data.deepseekBalance.total, 23.4); assert.ok(!JSON.stringify(r).includes(KEY))
  const { DEFAULT_PROMPT } = await import('../lib/prompt.js')
  assert.ok(!String(DEFAULT_PROMPT).includes(KEY))
})

console.log(n + ' balance tests passed')
