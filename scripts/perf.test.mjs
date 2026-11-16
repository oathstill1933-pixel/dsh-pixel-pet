// node scripts/perf.test.mjs — the parts of 提速/减负 that are pure wiring and need no model:
//   M5  the pet is started with OpenBLAS pinned to one thread (and run_pet.py does it for hand starts)
//   M6  the Agently watcher only runs while the mailbox furniture AND Agently are both on
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as H from '../lib/host.js'
import { MailService } from '../lib/mail.js'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}
const made = []
const tmp = (p) => { const dir = mkdtempSync(join(tmpdir(), p)); made.push(dir); return dir }
process.on('exit', () => { for (const dir of made) { try { rmSync(dir, { recursive: true, force: true }) } catch {} } })

function fakeCtx (routeHolder) {
  const effects = []
  const tools = { register: () => () => {} }
  const services = {
    webServer: { register (r) { routeHolder.route = r; return () => {} } },
    sessions: { list: () => [] },
    sessionTitle: { get: () => ({}) },
    tools,
  }
  return {
    logger: { warn () {}, info () {} },
    get: (n) => services[n],
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (fn) => effects.push(fn()),
  }
}

await t('M5: the pet process is started with OPENBLAS/OMP pinned to 1, and the old value is preserved', async () => {
  const holder = {}
  const ctx = fakeCtx(holder)
  const kids = []
  const spawn = (exe, args, opts) => { const k = new EventEmitter(); k.stderr = new EventEmitter(); k.exitCode = null; k.kill = () => { k.exitCode = 0 }; k.opts = opts; k.exe = exe; kids.push(k); return k }
  const dir = tmp(tmpdir.name + 'pp-perf-')
  process.env.PIXELPET_NO_AUTO_INSTALL = '1'
  H.apply(ctx, { dataDir: dir, spawn, pythonManager: { path: 'py', quick: () => 'py', detect: () => Promise.resolve(null), ensure: () => Promise.resolve({ path: 'py' }), snapshot: () => ({}) } })
  const call = async (method, path, body) => {
    const req = new PassThrough(); req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080' }
    let status = 0; let out = Buffer.alloc(0)
    const res = { writeHead (c) { status = c }, end (b) { if (b) out = Buffer.from(b) } }
    const p = holder.route.handler(req, res)
    req.end(body === undefined ? undefined : JSON.stringify(body))
    await p
    return { status, json: (() => { try { return JSON.parse(out.toString('utf8')) } catch { return null } })() }
  }
  await call('POST', '/api/settings', { body: { python: 'py' } })
  const r = await call('POST', '/api/pet/start', { body: {} })
  assert.equal(r.json.running, true)
  assert.equal(kids.length, 1)
  assert.equal(kids[0].opts.env.OPENBLAS_NUM_THREADS, '1')
  assert.equal(kids[0].opts.env.OMP_NUM_THREADS, '1')
  assert.equal(kids[0].opts.env.PYTHONUTF8, '1', 'other env entries are still there')
})

await t('M5: run_pet.py sets the same defaults itself (a hand start gets them too)', () => {
  const src = readFileSync(new URL('../runtime/run_pet.py', import.meta.url), 'utf8')
  assert.match(src, /os\.environ\.setdefault\("OPENBLAS_NUM_THREADS", "1"\)/)
  assert.match(src, /os\.environ\.setdefault\("OMP_NUM_THREADS", "1"\)/)
  // and it has to happen before numpy could ever be imported (the voice package is imported later)
  assert.ok(src.indexOf('OPENBLAS_NUM_THREADS') < src.indexOf('from pixelpet'))
})

await t('M6: the Agently watcher runs only with the mailbox furniture AND Agently on', async () => {
  const dir = tmp('pp-perf-mail-')
  const settings = {
    voice: { llm: { sessionId: '' } },
    furniture: {},
    mail: { agently: { enabled: true, consentAt: '2026-01-01T00:00:00Z', to: 'a@b.c', command: '' } },
  }
  const made = []
  const factory = () => {
    const w = { state: 'ok', watch: async () => {}, stop () {}, quota: () => ({ used: 0, limit: 1 }), _stopped: false }
    w.stop = () => { w._stopped = true }
    made.push(w)
    return w
  }
  const m = new MailService({ dataDir: dir, relay: { ask: async () => ({ code: 404 }) }, settings: () => settings, agentlyFactory: factory })
  await m.syncAgently()
  assert.equal(made.length, 1, 'mailbox ships enabled by default → watcher starts')

  settings.furniture = { mailbox: { enabled: false } }
  await m.syncAgently()
  assert.equal(m.agently, null, 'furniture off → watcher stopped')
  assert.equal(made[0]._stopped, true)

  settings.furniture = { mailbox: { enabled: true } }
  await m.syncAgently()
  assert.equal(made.length, 2, 'furniture back on → watcher starts again')

  // unchanged settings must not restart it
  await m.syncAgently()
  assert.equal(made.length, 2)

  settings.mail.agently.enabled = false
  await m.syncAgently()
  assert.equal(m.agently, null, 'Agently off → no watcher at all')
  assert.equal(made[1]._stopped, true)
})

await t('M6: mailboxOn defaults to on and only an explicit false turns it off', () => {
  const m = new MailService({ dataDir: tmp('pp-perf-mail2-'), relay: { ask: async () => ({ code: 404 }) }, settings: () => ({}) })
  assert.equal(m.mailboxOn(), true)
  const m2 = new MailService({ dataDir: tmp('pp-perf-mail3-'), relay: { ask: async () => ({ code: 404 }) }, settings: () => ({ furniture: { mailbox: { enabled: true } } }) })
  assert.equal(m2.mailboxOn(), true)
  const m3 = new MailService({ dataDir: tmp('pp-perf-mail4-'), relay: { ask: async () => ({ code: 404 }) }, settings: () => ({ furniture: { mailbox: { enabled: false } } }) })
  assert.equal(m3.mailboxOn(), false)
})

await t('M6: raw enabled settings without explicit consent never create a watcher', async () => {
  let calls = 0
  const s = { mail: { agently: { enabled: true, consentAt: '' } }, furniture: { mailbox: { enabled: true } } }
  const m = new MailService({ dataDir: tmp('pp-perf-no-consent-'), relay: {}, settings: () => s, agentlyFactory: () => { calls++; throw new Error('must not start') } })
  await m.syncAgently()
  assert.equal(calls, 0)
  assert.equal(m.agently, null)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
