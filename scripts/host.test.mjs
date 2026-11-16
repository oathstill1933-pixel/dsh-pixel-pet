// node scripts/host.test.mjs — host helpers + routes against a fake DSH ctx (no real DSH, no Python).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as H from '../lib/host.js'
import * as T from '../lib/tools.js'
import * as V from '../lib/voice.js'
import * as HUB from '../lib/hub.js'
import { MailService } from '../lib/mail.js'
import { runMailTests } from './mail.test.mjs'
import { runCreateTests } from './create.test.mjs'
import { runProviderTests } from './providers.test.mjs'
import { runNextBTests } from './next-b.test.mjs'
import { runAutonomyTests } from './autonomy.test.mjs'
import { runRemoveTests } from './remove.test.mjs'
import { runReeditTests } from './reedit.test.mjs'
import { runMailAttachTests } from './mail-attach.test.mjs'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'   // never start a real 1.3 GB install from tests

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}

// ------------------------------------------------------------------ pure helpers
await t('child liveness handles Windows signal exits and kill before exit event', () => {
  assert.equal(H.childAlive({ exitCode: null, signalCode: null }), true)
  assert.equal(H.childAlive({ exitCode: null, signalCode: 'SIGTERM' }), false)
  assert.equal(H.childAlive({ exitCode: null, killed: true }), false)
  assert.equal(H.childAlive({ exitCode: 0 }), false)
})
await t('interruption settings preserve partial patches and validate values', () => {
  const d = V.sanitizeVoice(null, {})
  assert.deepEqual(d.interruption, { enabled: true, reply: '嗯，你说' })
  const custom = V.sanitizeVoice(d, { interruption: { reply: ' 请讲 ' } })
  const off = V.sanitizeVoice(custom, { interruption: { enabled: false } })
  assert.deepEqual(off.interruption, { enabled: false, reply: '请讲' })
  assert.deepEqual(V.sanitizeVoice(off, { hotkey: 'F9' }).interruption, off.interruption)
  assert.deepEqual(V.sanitizeVoice(d, { interruption: { enabled: 'false', reply: 8 } }).interruption, d.interruption)
  assert.equal(V.sanitizeVoice(d, { interruption: { reply: '海'.repeat(200) } }).interruption.reply.length, 120)
})
await t('mergeSettings whitelists and validates', () => {
  const s = H.mergeSettings({}, { character: 'Bad Id', size: 9, topmost: 'yes', evil: 1, python: 'py' })
  assert.equal(s.character, ''); assert.equal(s.size, 0.65); assert.equal(s.topmost, true); assert.equal(s.evil, undefined); assert.equal(s.python, 'py')
  const v = H.mergeSettings({}, { voice: { stt: { engine: 'local-http', endpoint: 'http://10.0.0.1/x' }, tts: { voice: '../x' }, llm: { sessionId: 's1' } } })
  assert.equal(v.voice.stt.engine, 'local-http'); assert.equal(v.voice.stt.endpoint, ''); assert.equal(v.voice.tts.voice, 'whale-girl'); assert.equal(v.voice.llm.sessionId, 's1')
  const f = H.mergeSettings({ furniture: { bed: { x: 5, y: 6 } } }, { furniture: { bed: { enabled: false, x: 99 }, 'BAD!': { enabled: true } } })
  assert.deepEqual(f.furniture, { bed: { x: 5, y: 6, enabled: false } })
})
await t('listPacks hides _template and .bak, flags draft', () => {
  const ids = H.listPacks(H.PLUGIN_ROOT, 'character').map((c) => c.id)
  assert.ok(ids.includes('whale-girl'))
  assert.equal(H.listPacks(H.PLUGIN_ROOT, 'character').find((c) => c.id === 'whale-girl').draft, false)
  assert.ok(!H.listPacks(H.PLUGIN_ROOT, 'furniture').some((f) => f.id.startsWith('_')))
})
await t('extractText / sessionKey / keyMatches', () => {
  assert.equal(H.extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(H.sessionKey('session-abc'), 'abc')
  assert.equal(H.keyMatches('k', 'k'), true); assert.equal(H.keyMatches('k', 'x'), false); assert.equal(H.keyMatches(undefined, 'x'), false); assert.equal(H.keyMatches('', ''), false)
})
await t('depsStatus reads shared catalog', () => {
  const d = H.depsStatus(mkdtempSync(join(tmpdir(), 'pp-')))
  assert.deepEqual(d.map((x) => x.id), ['speaker-model', 'py-deps', 'qwen3-tts-engine', 'qwen3-tts-model', 'python-runtime'])
  assert.ok(d.every((x) => x.installed === false && x.configured === true))
  assert.equal(d.find((x) => x.id === 'speaker-model').auto, false)
  assert.ok(d.filter((x) => x.id !== 'speaker-model').every((x) => x.auto === true))
  assert.ok(d.find((x) => x.id === 'qwen3-tts-model').size > 1e9)
  assert.equal(d.find((x) => x.id === 'python-runtime').size, 39573204)
})
await t('dependency status rejects stale CPU policy markers before a DML upgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-lead-revision-'))
  const target = join(dir, 'pylibs', 'py312')
  mkdirSync(target, { recursive: true })
  try {
    const comp = V.readCatalog(H.PLUGIN_ROOT).find((c) => c.id === 'py-deps')
    const marker = join(target, '.installed-py-deps')
    writeFileSync(marker, JSON.stringify({ rev: 'old-cpu-policy' }))
    assert.equal(H.depsStatus(dir).find((c) => c.id === 'py-deps').installed, false)
    writeFileSync(marker, JSON.stringify({ rev: V.dependencyRevision(comp) }))
    assert.equal(H.depsStatus(dir).find((c) => c.id === 'py-deps').installed, true)
    assert.notEqual(V.dependencyRevision(comp, 'win32'), V.dependencyRevision(comp, 'linux'))
  } finally {
    const fs = await import('node:fs'); const path = await import('node:path')
    const actual = fs.realpathSync(dir)
    assert.equal(path.dirname(actual), fs.realpathSync(tmpdir()))
    assert.ok(path.basename(actual).startsWith('pp-lead-revision-'))
    fs.rmSync(actual, { recursive: true, force: true })
  }
})
await t('sanitizeVoice: defaults, migration, loopback-only channels', () => {
  const d = V.sanitizeVoice(null, {})
  assert.deepEqual(d, V.DEFAULT_VOICE)
  const old = V.sanitizeVoice({ stt: { engine: 'stub' }, tts: { engine: 'local-model', voice: 'default' } }, {})
  assert.equal(old.stt.engine, 'dsh'); assert.equal(old.tts.engine, 'qwen'); assert.equal(old.tts.voice, 'whale-girl')
  const c = V.sanitizeVoice(d, { tts: { engine: 'custom', voice: 'clone-0123456789', custom: { mode: 'command', command: 'mytts --text {text} --out {out}', url: 'http://192.168.1.2/tts' } }, hotkey: 'F9' })
  assert.equal(c.tts.engine, 'custom'); assert.equal(c.tts.voice, 'clone-0123456789'); assert.equal(c.tts.custom.mode, 'command')
  assert.equal(c.tts.custom.url, ''); assert.equal(c.hotkey, 'F9')
  const keep = V.sanitizeVoice(c, { tts: { custom: { url: 'http://127.0.0.1:9880/tts' } } })
  assert.equal(keep.tts.custom.command, 'mytts --text {text} --out {out}'); assert.equal(keep.tts.custom.url, 'http://127.0.0.1:9880/tts')
  assert.equal(V.sanitizeVoice(c, { tts: { custom: { command: 'a\nb' } } }).tts.custom.command, '')
  assert.equal(V.sanitizeVoice(c, { hotkey: 'A' }).hotkey, 'F8'); assert.equal(V.sanitizeVoice(c, { hotkey: '' }).hotkey, '')
})
await t('transcribeWithDsh: uses ctx speechToText, reports missing / failing', async () => {
  const seen = []
  const svc = { resolve: (o) => { seen.push(o.audio); return { provider: 'sensevoice-local' } }, transcribe: async (spec, signal) => { assert.ok(signal instanceof AbortSignal); return { text: ' 你好 ', audioSeconds: 1, inferenceSeconds: 0.1 } } }
  const ok = await V.transcribeWithDsh({ get: (n) => (n === 'speechToText' ? svc : undefined) }, Buffer.from('RIFFxxxx'))
  assert.equal(ok.code, 200); assert.equal(ok.body.text, '你好'); assert.ok(seen[0] instanceof Uint8Array)
  assert.equal((await V.transcribeWithDsh({ get: () => undefined }, Buffer.alloc(4))).code, 503)
  const bad = await V.transcribeWithDsh({ get: () => ({ resolve: () => ({}), transcribe: async () => { throw new Error('model busy') } }) }, Buffer.alloc(4))
  assert.equal(bad.code, 502); assert.match(bad.body.message, /model busy/)
})
await t('installer: one child at a time, utf8 env, failure recorded, retry allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-inst-'))
  const kids = []
  const spawn = (py, args, opts) => { const k = new EventEmitter(); k.stdout = new EventEmitter(); k.stderr = new EventEmitter(); k.kill = () => {}; k.py = py; k.args = args; k.opts = opts; kids.push(k); return k }
  const warns = []
  const inst = V.createInstaller({ root: H.PLUGIN_ROOT, dataDir: dir, python: () => 'mypy', logger: { warn: (m) => warns.push(m) }, spawn, env: {} })
  assert.equal(inst.start().running, true); assert.equal(inst.start().running, true)
  assert.equal(kids.length, 1)
  assert.equal(kids[0].py, 'mypy'); assert.deepEqual(kids[0].args.slice(-6), ['--data-dir', dir, 'install', 'py-deps', 'qwen3-tts-engine', 'qwen3-tts-model'])
  assert.ok(!kids[0].args.includes('python-runtime'), 'the python runtime is prepared by pyruntime.js, not here')
  assert.equal(kids[0].opts.env.PYTHONUTF8, '1'); assert.equal(kids[0].opts.windowsHide, true)
  mkdirSync(join(dir, 'models'), { recursive: true })
  writeFileSync(join(dir, 'models', 'progress.json'), JSON.stringify({ phase: 'download', overall: { done: 5, total: 10 } }))
  assert.equal(inst.status().progress.overall.done, 5)
  kids[0].stdout.emit('data', Buffer.from('{"ok": false, "message": "网络断了"}\n'))
  kids[0].emit('close', 1)
  const s = inst.status()
  assert.equal(s.running, false); assert.equal(s.ready, false); assert.equal(s.last.message, '网络断了'); assert.equal(warns.length, 1)
  assert.ok(s.total > 1e9)
  inst.start(); assert.equal(kids.length, 2)
  kids[1].emit('error', new Error('ENOENT')); assert.match(inst.status().last.message, /找不到 Python/)
})

// ------------------------------------------------------------------ routes with a fake ctx
function fakeTools () {
  const reg = new Map()
  return { reg, register (def) {
    if (reg.has(def.name)) throw new Error('tool "' + def.name + '" is already registered in this scope')
    if (!def.output || typeof def.output.render !== 'function') throw new TypeError('must declare output')
    reg.set(def.name, def); return () => { if (reg.get(def.name) === def) reg.delete(def.name) }
  } }
}

function fakeCtx (tools = fakeTools()) {
  const handlers = {}; const effects = []
  let route = null
  const emit = (...a) => { if (handlers['session/event']) handlers['session/event'](...a) }
  let turnNo = 0
  const agent = { calls: [], async followup (msg) { this.calls.push(msg); setTimeout(() => {
    const turn = ++turnNo
    emit({ id: 'session-s1' }, { type: 'turn/start', data: { turn } })
    emit({ id: 'session-s1' }, { type: 'user/message', data: msg })
    emit({ id: 'session-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } })
    emit({ id: 'session-s1' }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }, 5) } }
  const services = {
    webServer: { register (r) { route = r; return () => {} } },
    sessions: { list: () => [{ id: 'session-s1' }] },
    sessionTitle: { get: () => ({ title: '主会话' }) },
    tools,
  }
  const ctx = {
    logger: { warn () {}, info () {} },
    get: (n) => services[n],
    agents: { get: (id) => (id === 'session-s1' ? agent : undefined) },
    on: (ev, fn) => { handlers[ev] = fn; return () => {} },
    effect: (fn) => { effects.push(fn()) },
    _emit: emit,
  }
  return { ctx, agent, tools, get route () { return route }, effects }
}

async function call (route, method, path, { body, headers = {}, peer } = {}) {
  const req = new PassThrough()
  if (peer) req.socket = { remoteAddress: peer }
  req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080', ...headers }
  let status = 0; let out = Buffer.alloc(0)
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = Buffer.from(b) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)))
  await p
  let json = null; try { json = JSON.parse(out.toString('utf8')) } catch {}
  return { status, json, raw: out }
}

const data = mkdtempSync(join(tmpdir(), 'pp-host-'))
const f = fakeCtx()
H.apply(f.ctx, { dataDir: data })

await t('registers one prefix route', () => { assert.equal(f.route.kind, 'prefix'); assert.equal(f.route.path, '/dsh-pixel-pet') })
await t('GET / serves settings page', async () => {
  const r = await call(f.route, 'GET', '/'); assert.equal(r.status, 200); assert.ok(r.raw.toString().includes('<main>'))
})
await t('GET /api/state', async () => {
  const r = await call(f.route, 'GET', '/api/state')
  assert.equal(r.status, 200); assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.sessions, [{ id: 'session-s1', title: '主会话' }])
  assert.equal(r.json.pet.running, false)
  assert.ok(r.json.voices.some((v) => v.id === 'whale-girl' && v.kind === 'preset'))
  assert.equal(r.json.settings.voice.tts.voice, 'whale-girl'); assert.equal(r.json.settings.voice.stt.engine, 'dsh')
  assert.equal(r.json.voice.running, false); assert.equal(r.json.voice.ready, false)
})
await t('GET /api/voice/status', async () => {
  const r = await call(f.route, 'GET', '/api/voice/status')
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.deps.length, 3)
})
await t('voice settings round-trip through POST /api/settings', async () => {
  const r = await call(f.route, 'POST', '/api/settings', { body: { voice: { tts: { engine: 'custom', custom: { mode: 'http', url: 'http://127.0.0.1:9880/tts' } }, hotkey: 'F9' } } })
  assert.equal(r.json.settings.voice.tts.engine, 'custom'); assert.equal(r.json.settings.voice.hotkey, 'F9')
  const back = await call(f.route, 'POST', '/api/settings', { body: { voice: { tts: { engine: 'qwen' }, hotkey: 'F8' } } })
  assert.equal(back.json.settings.voice.tts.custom.url, 'http://127.0.0.1:9880/tts'); assert.equal(back.json.settings.voice.tts.engine, 'qwen')
})
await t('voice settings do not wait for an unrelated mail reconnect', async () => {
  const original = MailService.prototype.syncAgently
  let calls = 0
  MailService.prototype.syncAgently = async () => { calls++ }
  try {
    const r = await call(f.route, 'POST', '/api/settings', { body: { voice: { interruption: { enabled: false, reply: '请讲' } } } })
    assert.equal(r.json.settings.voice.interruption.enabled, false)
    assert.equal(calls, 0)
    await call(f.route, 'POST', '/api/settings', { body: { voice: { interruption: { enabled: true, reply: '嗯，你说' } } } })
  } finally { MailService.prototype.syncAgently = original }
})
await t('/api/stt is pet-only', async () => {
  const r = await call(f.route, 'POST', '/api/stt', { body: Buffer.from('RIFF' + 'x'.repeat(60)), headers: { 'x-pixelpet-key': 'guess' } })
  assert.equal(r.status, 401)
})
await t('POST /api/settings persists', async () => {
  const r = await call(f.route, 'POST', '/api/settings', { body: { size: 1.5, voice: { llm: { sessionId: 'session-s1' } } } })
  assert.equal(r.json.settings.size, 1.5)
  const again = await call(f.route, 'GET', '/api/state'); assert.equal(again.json.settings.voice.llm.sessionId, 'session-s1')
})
await t('corrupt saved settings stay fail-closed and cannot be overwritten by unrelated edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-lead-badsettings-'))
  const own = fakeCtx()
  writeFileSync(join(dir, 'settings.json'), '{synthetic-broken-json')
  H.apply(own.ctx, { dataDir: dir, autoInstall: false })
  const fs = await import('node:fs'); const path = await import('node:path')
  try {
    const state = await call(own.route, 'GET', '/api/state')
    assert.equal(state.json.settings.voiceprint.enabled, true)
    const write = await call(own.route, 'POST', '/api/settings', { body: { size: 1.2 } })
    assert.equal(write.json.ok, false)
    assert.equal(fs.readFileSync(join(dir, 'settings.json'), 'utf8'), '{synthetic-broken-json')
  } finally {
    for (const off of own.effects.reverse()) if (typeof off === 'function') off()
    const actual = fs.realpathSync(dir)
    assert.equal(path.dirname(actual), fs.realpathSync(tmpdir()))
    assert.ok(path.basename(actual).startsWith('pp-lead-badsettings-'))
    fs.rmSync(actual, { recursive: true, force: true })
  }
})
await t('voiceprint settings whitelist preserves partial patches and cannot retain personal fields', () => {
  const first = H.mergeSettings({}, { voiceprint: { enabled: true, mode: 'memory', strictness: 0.7, people: [{ name: 'fixture' }], vector: [1] } })
  assert.deepEqual(first.voiceprint, { enabled: true, mode: 'memory', strictness: 0.7 })
  const next = H.mergeSettings(first, { voiceprint: { strictness: 0.2 } })
  assert.deepEqual(next.voiceprint, { enabled: true, mode: 'memory', strictness: 0.2 })
  assert.equal(H.mergeSettings(next, { voiceprint: { enabled: 'false' } }).voiceprint.enabled, true)
})
await t('voiceprint host route requires local UI capability and unwraps real control data without vectors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-lead-vp-host-'))
  const own = fakeCtx()
  H.apply(own.ctx, { dataDir: dir, autoInstall: false })
  const controlKey = String(Date.now())
  const ctrl = createServer((req, res) => {
    let raw = ''
    req.on('data', (b) => { raw += b })
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer ' + controlKey)
      const b = JSON.parse(raw)
      const data = b.action === 'people'
        ? { people: [{ name: 'fixture-person', n: 5, embedding: [123] }] }
        : { enabled: true, enrolled: 1, ready: true, vector: [123], name: 'must-not-escape' }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, data }))
    })
  })
  await new Promise((r) => ctrl.listen(0, '127.0.0.1', r))
  try {
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ port: ctrl.address().port, token: controlKey }))
    const headers = { origin: 'http://127.0.0.1:3080', 'x-pixelpet-ui': '1' }
    assert.equal((await call(own.route, 'GET', '/api/voiceprint/session', { headers })).status, 403)
    const boot = await call(own.route, 'GET', '/api/voiceprint/session', { headers, peer: '127.0.0.1' })
    assert.equal(boot.status, 200)
    assert.equal(typeof boot.json.capability, 'string')
    assert.equal((await call(own.route, 'GET', '/api/voiceprint', { headers, peer: '127.0.0.1' })).status, 401)
    headers['x-pixelpet-voiceprint'] = boot.json.capability
    const st = await call(own.route, 'GET', '/api/voiceprint', { headers, peer: '127.0.0.1' })
    assert.equal(st.json.enabled, true); assert.equal(st.json.enrolled, 1)
    assert.equal(st.json.vector, undefined); assert.equal(st.json.name, undefined)
    const people = await call(own.route, 'GET', '/api/voiceprint/people', { headers, peer: '127.0.0.1' })
    assert.deepEqual(people.json.people, [{ name: 'fixture-person', n: 5 }])
    assert.equal((await call(own.route, 'GET', '/api/voiceprint/audio', { headers, peer: '127.0.0.1' })).status, 404)
    assert.equal((await call(own.route, 'GET', '/api/voiceprint', { headers, peer: '192.0.2.4' })).status, 403)
  } finally {
    for (const off of own.effects.reverse()) if (typeof off === 'function') off()
    await new Promise((r) => ctrl.close(r))
    const fs = await import('node:fs')
    const path = await import('node:path')
    const actual = fs.realpathSync(dir)
    assert.equal(path.dirname(actual), fs.realpathSync(tmpdir()))
    assert.ok(path.basename(actual).startsWith('pp-lead-vp-host-'))
    fs.rmSync(actual, { recursive: true, force: true })
  }
})
await t('cross-origin POST refused', async () => {
  const r = await call(f.route, 'POST', '/api/settings', { body: {}, headers: { origin: 'http://evil.test' } }); assert.equal(r.status, 403)
})
await t('thumb path cannot escape pack', async () => {
  const r = await call(f.route, 'GET', '/api/thumb/character/whale-girl'); assert.equal(r.status, 200)
  const r2 = await call(f.route, 'GET', '/api/thumb/character/..%2F..'); assert.equal(r2.status, 404)
})
await t('/api/ask needs the per-launch key', async () => {
  const r = await call(f.route, 'POST', '/api/ask', { body: { sessionId: 'session-s1', text: 'hi' }, headers: { 'x-pixelpet-key': 'guess' } })
  assert.equal(r.status, 401)
})

await t('relay: followup into the session, reply on turn/end', async () => {
  const g = fakeCtx()
  const relay = H.createRelay(g.ctx)
  g.ctx.on('session/event', relay.onEvent)
  const r = await relay.ask('s1', '在吗')
  assert.deepEqual(r, { code: 200, body: { ok: true, reply: '在的' } })
  assert.equal(g.agent.calls.length, 1)
  assert.equal(g.agent.calls[0].role, 'user'); assert.equal(g.agent.calls[0].source.kind, 'pixel-pet')
  assert.deepEqual(g.agent.calls[0].content, [{ type: 'text', text: '在吗' }])
  assert.equal(relay.pending.size, 0)
})
await t('relay: another turn already running in the session never settles our ask', async () => {
  const g = fakeCtx()
  const relay = H.createRelay(g.ctx)
  g.ctx.on('session/event', relay.onEvent)
  const say = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const s = { id: 'session-s1' }
  g.ctx._emit(s, { type: 'turn/start', data: { turn: 7 } })           // someone else's turn, already running
  g.agent.followup = async function (msg) {
    this.calls.push(msg)
    setTimeout(() => {
      g.ctx._emit(s, say('别人的答复'))
      g.ctx._emit(s, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })   // not ours: no user/message yet
      g.ctx._emit(s, { type: 'user/message', data: { id: 'someone-else', role: 'user', content: [] } })
      g.ctx._emit(s, { type: 'turn/start', data: { turn: 8 } })
      g.ctx._emit(s, { type: 'user/message', data: msg })
      g.ctx._emit(s, say('桌宠的答复'))
      g.ctx._emit(s, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    }, 5)
  }
  const r = await relay.ask('s1', '在吗')
  assert.deepEqual(r, { code: 200, body: { ok: true, reply: '桌宠的答复' } })
  // spliced into the running turn (next-step inbox): that turn's end answers it, an unrelated turn number does not
  g.agent.followup = async function (msg) { this.calls.push(msg) }
  const r2p = relay.ask('s1', '再问')
  await new Promise((done) => setTimeout(done, 1))
  const msg2 = g.agent.calls.at(-1)
  g.ctx._emit(s, { type: 'turn/start', data: { turn: 9 } })
  g.ctx._emit(s, { type: 'user/message', data: msg2 })
  g.ctx._emit(s, say('接着答'))
  g.ctx._emit(s, { type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } })
  g.ctx._emit(s, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  assert.deepEqual(await r2p, { code: 200, body: { ok: true, reply: '接着答' } })
  assert.equal(relay.pending.size, 0)
})
await t('relay: busy / offline / timeout / followup error', async () => {
  const g = fakeCtx()
  const slow = H.createRelay(g.ctx, 30)          // no event handler wired -> never answers -> timeout
  const first = slow.ask('session-s1', 'a')
  assert.equal((await slow.ask('s1', 'b')).code, 409)
  assert.equal((await first).code, 504)
  assert.equal((await slow.ask('nobody', 'x')).code, 404)
  assert.equal((await slow.ask('', 'x')).code, 400)
  g.agent.followup = async () => { throw new Error('gone') }
  const e = await slow.ask('s1', 'x'); assert.equal(e.code, 502); assert.match(e.body.message, /gone/)
})
// ------------------------------------------------------------------ pointed session survives a DSH restart
function coldCtx ({ resume, lookup } = {}) {
  const g = fakeCtx()
  const woken = new Map()   // id -> agent once resumed
  const mkAgent = (id) => ({ id, calls: [], async followup (msg) { this.calls.push(msg); setTimeout(() => {
    g.ctx._emit({ id }, { type: 'user/message', data: msg })
    g.ctx._emit({ id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '醒了' }] } } })
    g.ctx._emit({ id }, { type: 'turn/end', data: {} })
  }, 5) } })
  const headers = [
    { id: 'session-s1', cwd: 'ws' },
    { id: 'session-cold', cwd: 'ws' },
    { id: 'session-arch', cwd: 'ws' },
    { id: 'session-kid', cwd: 'ws', origin: 'subagent', parentSession: 'session-s1' },
  ]
  const calls = { resume: [], list: 0, titles: [] }
  const services = {
    sessions: { list: () => [{ id: 'session-s1', header: headers[0] }] },
    sessionTitle: { get: () => ({ title: '主会话' }) },
    sessionQuery: {
      async listSessions () { calls.list++; return headers.map((h) => ({ header: h, live: h.id === 'session-s1', persisted: true })) },
      async readTitleSnapshots (ids) { calls.titles.push(...ids); return ids.map((id) => ({ status: 'fulfilled', value: id === 'session-cold' ? { title: { title: '昨天的会话' } } : {} })) },
    },
    workspaceRegistry: { archivedSessionIds: ['session-arch'] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  if (lookup) services.typert = { lookups: { get: (k) => (k === 'agent' ? { resolve: (id) => lookup(id, woken, mkAgent) } : undefined) } }
  const handlers = {}
  const baseGet = g.ctx.get
  g.ctx.get = (n) => services[n] ?? baseGet(n)
  g.ctx.on = (ev, fn) => { handlers[ev] = fn; return () => {} }
  g.ctx._emit = (...a) => handlers['session/event'] && handlers['session/event'](...a)
  const liveGet = g.ctx.agents.get
  g.ctx.agents = { get: (id) => woken.get(id) || liveGet(id) }
  if (resume) g.ctx.agents.resume = async (opts) => { calls.resume.push(opts); return resume(opts, woken, mkAgent) }
  return { ctx: g.ctx, effects: g.effects, get route () { return g.route }, woken, calls, services }
}
const wakeOk = async (opts, woken, mkAgent) => { await new Promise((r) => setTimeout(r, 10)); const a = mkAgent(opts.resumeSessionId); woken.set(opts.resumeSessionId, a); return { agent: a, dispose: async () => {} } }

await t('session list: cold sessions listed with title, archived / subagent hidden', async () => {
  const c = coldCtx()
  const relay = H.createRelay(c.ctx)
  const list = await relay.target.list('session-cold')
  assert.deepEqual(list, [{ id: 'session-s1', title: '主会话' }, { id: 'session-cold', title: '昨天的会话', cold: true }])
  await relay.target.list('session-cold')
  assert.equal(c.calls.titles.filter((x) => x === 'session-cold').length, 1, 'cold title folded once, then cached')
})
await t('session list: saved session that no longer exists stays, flagged missing', async () => {
  const c = coldCtx()
  const list = await H.createRelay(c.ctx).target.list('session-gone')
  assert.deepEqual(list.at(-1), { id: 'session-gone', title: '', cold: true, missing: true })
  const arch = await H.createRelay(c.ctx).target.list('session-arch')
  assert.equal(arch.at(-1).archived, true); assert.equal(arch.filter((x) => x.id === 'session-arch').length, 1)
})
await t('/api/state lists the saved cold session; a deleted one does not clear the setting', async () => {
  const c = coldCtx()
  const dir = mkdtempSync(join(tmpdir(), 'pp-sess-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voice: { llm: { sessionId: 'session-cold' } } }))
  H.apply(c.ctx, { dataDir: dir })
  const r = await call(c.route, 'GET', '/api/state')
  assert.ok(r.json.sessions.some((x) => x.id === 'session-cold' && x.title === '昨天的会话'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voice: { llm: { sessionId: 'session-gone' } } }))
  const r2 = await call(c.route, 'GET', '/api/state')
  assert.ok(r2.json.sessions.some((x) => x.id === 'session-gone' && x.missing === true))
  assert.equal(r2.json.settings.voice.llm.sessionId, 'session-gone')
  const r3 = await call(c.route, 'POST', '/api/settings', { body: { size: 1.2 } })
  assert.equal(r3.json.settings.voice.llm.sessionId, 'session-gone')
  for (const e of c.effects) if (typeof e === 'function') e()
})
await t('relay: cold session is resumed once, then followup + reply', async () => {
  const c = coldCtx({ resume: wakeOk })
  const relay = H.createRelay(c.ctx)
  c.ctx.on('session/event', relay.onEvent)
  const [a, b] = await Promise.all([relay.ask('session-cold', '在吗'), relay.post('cold', '顺便一句')])
  assert.deepEqual(a, { code: 200, body: { ok: true, reply: '醒了' } })
  assert.deepEqual(b, { code: 200, body: { ok: true } })
  assert.equal(c.calls.resume.length, 1, 'one resume for concurrent callers')
  assert.equal(c.calls.resume[0].resumeSessionId, 'session-cold')
  assert.deepEqual(c.calls.resume[0].agentOptions, { provider: 'p', model: 'm' })
  assert.equal(c.woken.get('session-cold').calls.length, 2)
  assert.equal((await relay.ask('session-cold', '再来')).code, 200)
  assert.equal(c.calls.resume.length, 1, 'already live: no second resume')
})
await t('relay: an agent woken through ctx.agents.resume is released on dispose (lookup agents are not)', async () => {
  let released = 0
  const c = coldCtx({ resume: async (opts, woken, mkAgent) => { const h = await wakeOk(opts, woken, mkAgent); return { ...h, dispose: async () => { released++ } } } })
  const relay = H.createRelay(c.ctx)
  c.ctx.on('session/event', relay.onEvent)
  assert.equal((await relay.ask('session-cold', '在吗')).code, 200)
  assert.equal(relay.target.handles.size, 1)
  await relay.dispose(); await relay.dispose()
  assert.equal(released, 1); assert.equal(relay.target.handles.size, 0)
  const viaLookup = coldCtx({ resume: async () => { throw new Error('unused') }, lookup: async (id, woken, mkAgent) => { const a = mkAgent(id); woken.set(id, a); return a } })
  const r2 = H.createRelay(viaLookup.ctx); viaLookup.ctx.on('session/event', r2.onEvent)
  assert.equal((await r2.ask('session-cold', 'hi')).code, 200)
  assert.equal(r2.target.handles.size, 0)
})
await t('relay: prefers the host agent lookup (same resume as the DSH GUI)', async () => {
  let n = 0
  const c = coldCtx({
    resume: async () => { throw new Error('should not be used') },
    lookup: async (id, woken, mkAgent) => { n++; const a = mkAgent(id); woken.set(id, a); return a },
  })
  const relay = H.createRelay(c.ctx)
  c.ctx.on('session/event', relay.onEvent)
  assert.equal((await relay.ask('session-cold', 'hi')).code, 200)
  assert.equal(n, 1); assert.equal(c.calls.resume.length, 0)
})
await t('relay: resume failures come back readable, nothing left pending', async () => {
  const held = coldCtx({ resume: async () => { throw Object.assign(new Error('held by another writer'), { name: 'SessionAlreadyOwnedError' }) } })
  const r1 = H.createRelay(held.ctx)
  const e1 = await r1.ask('session-cold', 'x')
  assert.equal(e1.code, 409); assert.match(e1.body.message, /占用/); assert.equal(r1.pending.size, 0)
  const boom = coldCtx({ resume: async () => { throw new Error('disk on fire') } })
  const r2 = H.createRelay(boom.ctx)
  const e2 = await r2.ask('session-cold', 'x')
  assert.equal(e2.code, 502); assert.match(e2.body.message, /^唤醒会话失败：disk on fire/)
  const e3 = await r2.post('session-cold', 'x'); assert.equal(e3.code, 502)
  assert.equal(boom.calls.resume.length, 2, 'a failed resume is not cached')
  const gone = await r2.ask('session-gone', 'x'); assert.equal(gone.code, 404); assert.match(gone.body.message, /已被删除/)
  const arch = await r2.ask('session-arch', 'x'); assert.equal(arch.code, 409); assert.match(arch.body.message, /归档/)
  assert.equal(boom.calls.resume.length, 2, 'deleted / archived sessions are never resumed')
})

// ------------------------------------------------------------------ AI tools
const TOOL_NAMES = ['pixelpet_move', 'pixelpet_pose', 'pixelpet_look', 'pixelpet_mood', 'pixelpet_say', 'pixelpet_furniture', 'pixelpet_stop', 'pixelpet_status', 'pixelpet_mail_send', 'pixelpet_mail_list', 'pixelpet_mail_like'] // pixelpet_screen only while settings.screen is on (next-b.test)
const runTool = (g, name, args = {}) => g.tools.reg.get(name).execute(args, {})

await t('tools: 11 pixelpet_* registered globally with schema + output', () => {
  assert.deepEqual([...f.tools.reg.keys()].sort(), [...TOOL_NAMES].sort())
  for (const d of f.tools.reg.values()) {
    assert.equal(d.parameters.type, 'object'); assert.equal(typeof d.execute, 'function')
    assert.ok(/[一-鿿]/.test(d.description))
    assert.equal(d.output.render({}, { ok: true, message: 'x' })[0].text, 'x')
  }
})
await t('tools: second instance on same registry does not throw', () => {
  const g = fakeCtx(f.tools)
  H.apply(g.ctx, { dataDir: data })
  assert.equal(f.tools.reg.size, 11)
})
await t('tools: a settings save only re-registers tools that changed (no churn for open sessions)', async () => {
  const tools = fakeTools()
  let regs = 0; let offs = 0
  const reg0 = tools.register.bind(tools)
  tools.register = (def) => { regs++; const off = reg0(def); return () => { offs++; off() } }
  const g = fakeCtx(tools)
  const dir = mkdtempSync(join(tmpdir(), 'pp-churn-'))
  H.apply(g.ctx, { dataDir: dir, autoInstall: false })
  const first = regs
  assert.ok(first >= 11)
  await call(g.route, 'POST', '/api/settings', { body: { size: 0.7 } })            // unrelated to any tool
  assert.equal(regs, first); assert.equal(offs, 0)
  await call(g.route, 'POST', '/api/settings', { body: { screen: true } })         // adds pixelpet_screen only
  assert.equal(regs, first + 1); assert.equal(offs, 0); assert.ok(tools.reg.has('pixelpet_screen'))
  await call(g.route, 'POST', '/api/settings', { body: { aiControl: false } })     // all off
  assert.equal(tools.reg.size, 0)
  await call(g.route, 'POST', '/api/settings', { body: { aiControl: true } })      // all back
  assert.ok(tools.reg.has('pixelpet_move') && tools.reg.has('pixelpet_screen'))
  for (const e of g.effects || []) if (typeof e === 'function') e()
})
await t('tools: pet not running -> readable message, no throw', async () => {
  const r = await runTool(f, 'pixelpet_status')
  assert.equal(r.ok, false); assert.equal(r.running, false); assert.match(r.message, /没在运行/)
  // stale control.json pointing at a closed port
  const srv = createServer(); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok)); const port = srv.address().port
  await new Promise((ok) => srv.close(ok))
  const d2 = mkdtempSync(join(tmpdir(), 'pp-stale-'))
  const stale = 'stale-' + port
  writeFileSync(join(d2, 'control.json'), JSON.stringify({ v: 1, port, token: stale, pid: 1 }))
  const r2 = await T.sendCommand(d2, { cmd: 'status' })
  assert.equal(r2.running, false); assert.match(r2.message, /没在运行/); assert.ok(!JSON.stringify(r2).includes(stale))
})
await t('tools: bad arguments refused before sending', async () => {
  assert.match((await runTool(f, 'pixelpet_move', {})).message, /to/)
  assert.match((await runTool(f, 'pixelpet_furniture', { action: 'use' })).message, /list/)
  assert.match((await runTool(f, 'pixelpet_say', { text: '  ' })).message, /text/)
})

await t('tools: commands forwarded to control port with Bearer token', async () => {
  const token = 'tok-' + Math.random().toString(36).slice(2) + '-secret'
  const seen = []
  const srv = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url !== '/cmd' || req.headers.origin || req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{"ok":false}') }
      seen.push(body)
      const out = body.cmd === 'status' ? { ok: true, message: 'ok', data: { character: 'c1', state: 'idle', moving: false } }
        : body.cmd === 'furniture' ? { ok: true, message: 'ok', data: [{ id: 'demo-bed', name: '小床', interactions: [{ verb: 'sleep' }, { verb: 'wake' }] }] }
          : { ok: true, message: '好了。' }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
    })
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const d3 = mkdtempSync(join(tmpdir(), 'pp-ctl-'))
  writeFileSync(join(d3, 'control.json'), JSON.stringify({ v: 1, port: srv.address().port, token, pid: 1 }))
  const g = fakeCtx(); H.apply(g.ctx, { dataDir: d3 })
  const results = []
  try {
    results.push(await runTool(g, 'pixelpet_move', { to: 'taskbar', pose: 'sit' }))
    results.push(await runTool(g, 'pixelpet_move', { dx: -80 }))
    results.push(await runTool(g, 'pixelpet_move', { x: 300, y: 500, wait: false }))
    results.push(await runTool(g, 'pixelpet_pose', { name: 'lie', holdMs: 2000.4 }))
    results.push(await runTool(g, 'pixelpet_look', { target: 'up-left' }))
    results.push(await runTool(g, 'pixelpet_look', { x: 10, y: 20 }))
    results.push(await runTool(g, 'pixelpet_mood', { tag: '开心', seconds: 3 }))
    results.push(await runTool(g, 'pixelpet_say', { text: '你好' }))
    results.push(await runTool(g, 'pixelpet_say', { text: '念出来', speak: true }))
    const list = await runTool(g, 'pixelpet_furniture', { action: 'list' }); results.push(list)
    results.push(await runTool(g, 'pixelpet_furniture', { action: 'use', id: 'demo-bed', verb: 'sleep' }))
    results.push(await runTool(g, 'pixelpet_stop'))
    const st = await runTool(g, 'pixelpet_status'); results.push(st)
    assert.deepEqual(seen, [
      { cmd: 'move_to', anchor: 'taskbar', pose: 'sit' },
      { cmd: 'walk', dx: -80 },
      { cmd: 'move_to', x: 300, y: 500, wait: false },
      { cmd: 'pose', name: 'lie', holdMs: 2000 },
      { cmd: 'look', target: 'up-left' },
      { cmd: 'look', target: { x: 10, y: 20 } },
      { cmd: 'mood', tag: '开心', seconds: 3 },
      { cmd: 'say', text: '你好' },
      { cmd: 'say', text: '念出来', speak: true },
      { cmd: 'furniture' },
      { cmd: 'use', id: 'demo-bed', verb: 'sleep' },
      { cmd: 'stop' },
      { cmd: 'status' },
    ])
    assert.equal(list.data[0].interactions[1].verb, 'wake')
    assert.equal(st.ok, true); assert.equal(st.running, true); assert.equal(st.data.character, 'c1')
    assert.ok(results.every((r) => r.ok === true))
    assert.ok(!JSON.stringify(results).includes(token))
    // wrong token -> treated as not running, still no token in result
    writeFileSync(join(d3, 'control.json'), JSON.stringify({ v: 1, port: srv.address().port, token: token + 'x', pid: 1 }))
    const bad = await runTool(g, 'pixelpet_status')
    assert.equal(bad.ok, false); assert.match(bad.message, /没在运行/); assert.ok(!JSON.stringify(bad).includes(token))
  } finally { await new Promise((ok) => srv.close(ok)) }
})

await t('tools: aiControl off unregisters and refuses; on re-registers', async () => {
  const kept = f.tools.reg.get('pixelpet_say')
  const r = await call(f.route, 'POST', '/api/settings', { body: { aiControl: false } })
  assert.equal(r.json.settings.aiControl, false)
  assert.equal(f.tools.reg.size, 0)
  const refused = await kept.execute({ text: 'hi' }, {})
  assert.equal(refused.ok, false); assert.match(refused.message, /关闭/)
  const st = await call(f.route, 'GET', '/api/state'); assert.equal(st.json.settings.aiControl, false)
  await call(f.route, 'POST', '/api/settings', { body: { aiControl: true } })
  assert.equal(f.tools.reg.size, 11)
  assert.equal(H.mergeSettings({}, {}).aiControl, true)
  assert.equal(H.mergeSettings({}, { aiControl: 'no' }).aiControl, true)
})

// ------------------------------------------------------------------ hub bar: settings, screenshots, attachments
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

await t('hub settings: defaults, whitelist, bounds', () => {
  assert.deepEqual(HUB.sanitizeHub(null, {}), HUB.DEFAULT_HUB)
  assert.ok(!('handsFree' in HUB.DEFAULT_HUB)); assert.equal(HUB.DEFAULT_HUB.show, true)
  const s = H.mergeSettings({}, { hub: { show: false, autoCollapseS: 45.4, speak: 'no', handsFree: true, evil: 1 } })
  assert.deepEqual(s.hub, { show: false, autoCollapseS: 45, speak: true })
  assert.deepEqual(HUB.sanitizeHub({ handsFree: true, speak: false }, {}), { show: true, autoCollapseS: 20, speak: false })
  assert.equal(H.mergeSettings({}, { hub: { autoCollapseS: -1 } }).hub.autoCollapseS, 20)
  assert.equal(H.mergeSettings({}, { hub: { autoCollapseS: 0 } }).hub.autoCollapseS, 0)
  assert.equal(H.mergeSettings({ hub: { show: false } }, { size: 1 }).hub.show, false)
  assert.ok(H.inject.includes('attachments'))
})
await t('hub settings round-trip through POST /api/settings', async () => {
  const r = await call(f.route, 'POST', '/api/settings', { body: { hub: { autoCollapseS: 8, handsFree: true } } })
  assert.equal(r.status, 200)
  assert.equal(r.json.settings.hub.autoCollapseS, 8); assert.ok(!('handsFree' in r.json.settings.hub))
  const back = await call(f.route, 'POST', '/api/settings', { body: { hub: { speak: false } } })
  assert.equal(back.json.settings.hub.autoCollapseS, 8); assert.equal(back.json.settings.hub.speak, false)
})
await t('shot store: magic check, size cap, pending cap, sweep, per-message cap', () => {
  const sdir = mkdtempSync(join(tmpdir(), 'pp-shot-'))
  const st = HUB.createShotStore(sdir)
  assert.equal(st.save(Buffer.from('GIF89a......')).code, 415)
  assert.equal(st.save(Buffer.concat([PNG, Buffer.alloc(HUB.SHOT_LIMIT)])).code, 413)
  const ids = []
  for (let i = 0; i < HUB.SHOT_MAX_PENDING; i++) { const r = st.save(PNG); assert.equal(r.code, 200); ids.push(r.body.id) }
  assert.equal(st.save(PNG).code, 429)
  assert.ok(ids.every((id) => /^shot-[0-9a-f]{16}$/.test(id)))
  assert.equal(st.blocks(ids).length, HUB.SHOT_MAX_PER_MESSAGE)
  assert.equal(st.blocks(['../settings', 'shot-zz']).length, 0)
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
  st.drop(ids.slice(0, 1)); const j = st.save(jpg); assert.equal(st.blocks([j.body.id])[0].mediaType, 'image/jpeg')
  assert.equal(st.sweep(), 0, 'fresh files survive the TTL sweep')
  const later = HUB.createShotStore(sdir, { now: () => Date.now() + HUB.SHOT_TTL_MS + 5000 })
  assert.equal(later.sweep(), HUB.SHOT_MAX_PENDING); assert.equal(st.files().length, 0)
})
await t('buildContent: admits images through attachments; text-only fallback counts dropped', async () => {
  const img = { type: 'image', data: PNG.toString('base64'), mediaType: 'image/png', name: 'shot-0.png' }
  const seen = []
  const svc = { admitPromptContent: async (blocks) => { seen.push(blocks); return blocks.map((b) => (b.type === 'image' ? { type: 'image', attachment: { attachmentId: 'att-1' } } : b)) } }
  const ok = await HUB.buildContent({ attachments: svc }, '看这个', [img])
  assert.equal(ok.attached, 1); assert.equal(ok.dropped, 0)
  assert.deepEqual(seen[0][0], { type: 'text', text: '看这个' }); assert.equal(seen[0][1].mediaType, 'image/png')
  assert.equal(ok.content[1].attachment.attachmentId, 'att-1')
  const viaGet = await HUB.buildContent({ get: (n) => (n === 'attachments' ? svc : undefined) }, '', [img])
  assert.equal(viaGet.content[0].text, '（截图）'); assert.equal(viaGet.attached, 1)
  const none = await HUB.buildContent({ get: () => undefined }, 'x', [img])
  assert.deepEqual(none, { content: [{ type: 'text', text: 'x' }], attached: 0, dropped: 1 })
  const bad = await HUB.buildContent({ attachments: { admitPromptContent: async () => { throw new Error('nope') } } }, 'x', [img])
  assert.equal(bad.dropped, 1); assert.equal(bad.content.length, 1)
  assert.deepEqual(await HUB.buildContent({}, 'x', []), { content: [{ type: 'text', text: 'x' }], attached: 0, dropped: 0 })
})
await t('/api/shot + /api/ask: per-launch key, size limit, image attached to followup, temp files removed', async () => {
  const g = fakeCtx()
  const admitted = []
  g.ctx.attachments = { admitPromptContent: async (blocks) => { admitted.push(blocks); return blocks.map((b, i) => (b.type === 'image' ? { type: 'image', attachment: { attachmentId: 'att-' + i } } : b)) } }
  const kids = []
  const spawn = (py, args, opts) => { const k = new EventEmitter(); k.stderr = new EventEmitter(); k.exitCode = null; k.kill = () => { k.exitCode = 0 }; k.opts = opts; k.py = py; kids.push(k); return k }
  const dir = mkdtempSync(join(tmpdir(), 'pp-hub-'))
  mkdirSync(join(dir, 'tmp'), { recursive: true }); writeFileSync(join(dir, 'tmp', 'shot-00000000000000aa.png'), PNG)
  H.apply(g.ctx, { dataDir: dir, spawn })
  assert.ok(!existsSync(join(dir, 'tmp', 'shot-00000000000000aa.png')), 'leftover from last run cleared')
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': 'x' } })).status, 401) // pet not started
  await call(g.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-s1' } } } })
  // a configured interpreter is taken as given (no probing, no download) — see lib/pyruntime.js
  await call(g.route, 'POST', '/api/settings', { body: { python: 'py-test' } })
  assert.equal((await call(g.route, 'POST', '/api/pet/start', { body: {} })).json.running, true)
  assert.equal(kids[0].py, 'py-test')
  const key = kids[0].opts.env.PIXELPET_BRIDGE_KEY
  assert.ok(key && key.length >= 24)
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: PNG })).status, 401)
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': key + 'x' } })).status, 401)
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': key, 'content-length': String(HUB.SHOT_LIMIT + 1) } })).status, 413)
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: Buffer.concat([PNG, Buffer.alloc(HUB.SHOT_LIMIT)]), headers: { 'x-pixelpet-key': key } })).status, 413)
  assert.equal((await call(g.route, 'POST', '/api/shot', { body: Buffer.from('not an image at all'), headers: { 'x-pixelpet-key': key } })).status, 415)
  const up = await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': key } })
  assert.equal(up.status, 200); assert.match(up.json.id, /^shot-[0-9a-f]{16}$/)
  assert.equal(readdirSync(join(dir, 'tmp')).length, 1)
  const r = await call(g.route, 'POST', '/api/ask', { body: { text: '这是什么', shots: [up.json.id, 'shot-ffffffffffffffff'] }, headers: { 'x-pixelpet-key': key } })
  assert.equal(r.status, 200); assert.equal(r.json.reply, '在的'); assert.equal(r.json.attached, 1); assert.equal(r.json.dropped, 0)
  const msg = g.agent.calls.at(-1)
  assert.equal(msg.source.kind, 'pixel-pet'); assert.equal(msg.content[0].text, '这是什么')
  assert.deepEqual(msg.content[1], { type: 'image', attachment: { attachmentId: 'att-1' } })
  assert.equal(admitted[0][1].data, PNG.toString('base64'))
  assert.equal(readdirSync(join(dir, 'tmp')).filter((n) => n.startsWith('shot-')).length, 0, 'temp shot deleted after send')
  // image only, no text
  const up2 = await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': key } })
  const r2 = await call(g.route, 'POST', '/api/ask', { body: { shots: [up2.json.id] }, headers: { 'x-pixelpet-key': key } })
  assert.equal(r2.status, 200); assert.equal(g.agent.calls.at(-1).content[0].text, '（截图）')
  // unknown ids and no text -> 400; plain text keeps the old shape
  assert.equal((await call(g.route, 'POST', '/api/ask', { body: { shots: ['shot-0123456789abcdef'] }, headers: { 'x-pixelpet-key': key } })).status, 400)
  const plain = await call(g.route, 'POST', '/api/ask', { body: { text: 'hi' }, headers: { 'x-pixelpet-key': key } })
  assert.deepEqual(plain.json, { ok: true, reply: '在的' }); assert.deepEqual(g.agent.calls.at(-1).content, [{ type: 'text', text: 'hi' }])
  // failed followup still cleans up
  const up3 = await call(g.route, 'POST', '/api/shot', { body: PNG, headers: { 'x-pixelpet-key': key } })
  g.agent.followup = async () => { throw new Error('gone') }
  assert.equal((await call(g.route, 'POST', '/api/ask', { body: { text: 'x', shots: [up3.json.id] }, headers: { 'x-pixelpet-key': key } })).status, 502)
  assert.equal(readdirSync(join(dir, 'tmp')).filter((n) => n.startsWith('shot-')).length, 0)
  for (const e of g.effects) if (typeof e === 'function') e()
  assert.equal(kids[0].exitCode, 0)
})

await runMailTests({ t, H, fakeCtx, call })
await runCreateTests({ t, H, fakeCtx, call })
await runProviderTests({ t, H, fakeCtx, call })
await runNextBTests({ t, H, fakeCtx, call })
await runAutonomyTests({ t, H, fakeCtx, call })
await runRemoveTests(t)
await runReeditTests({ t, H, fakeCtx, call })
await runMailAttachTests({ t, H, fakeCtx, call })

{
  const { activityFor, createActivityFollower } = await import('../lib/activity.js')
  await t('activity: session events map to pet states, only for the pointed session', async () => {
    const eq = (a, b) => { if (a !== b) throw new Error(JSON.stringify(a) + ' !== ' + JSON.stringify(b)) }
    eq(activityFor({ type: 'turn/start', data: { turn: 1 } }), 'working')
    eq(activityFor({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'done')
    eq(activityFor({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'x' } } } }), 'failed')
    eq(activityFor({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), 'idle')
    eq(activityFor({ type: 'approval/asked', data: {} }), 'waiting')
    eq(activityFor({ type: 'assistant/message' }), null)
    const sent = []
    const f = createActivityFollower({ targetId: () => 'session-abc', keyOf: (id) => String(id || '').replace(/^session-/, ''), send: (c) => sent.push(c.state) })
    f({ id: 'other' }, { type: 'turn/start' })
    f({ id: 'abc' }, { type: 'turn/start' })
    f({ id: 'session-abc' }, { type: 'turn/start' })
    f({ id: 'abc' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    eq(sent.join(','), 'working,done')
  })
}

await t('mail window: owner name falls back to the character, partnerName wins, liked shows up', async () => {
  const st = await call(f.route, 'GET', '/api/state')
  const curName = (st.json.characters.find((c) => c.id === st.json.settings.character) || st.json.characters.find((c) => !c.draft) || st.json.characters[0]).name
  await call(f.route, 'POST', '/api/settings', { body: { partnerName: '' } })
  let r = await call(f.route, 'GET', '/api/mail')
  assert.equal(r.json.owner.name, curName); assert.equal(r.json.owner.domain, '')
  await call(f.route, 'POST', '/api/settings', { body: { partnerName: '阿p' } })
  r = await call(f.route, 'GET', '/api/mail')
  assert.equal(r.json.owner.name, '阿p')
  await call(f.route, 'POST', '/api/settings', { body: { partnerName: '' } })
})

await t('stop + dispose', async () => {
  const r = await call(f.route, 'POST', '/api/pet/stop', { body: {} }); assert.equal(r.json.running, false)
  for (const e of f.effects) if (typeof e === 'function') e()
  assert.equal(f.tools.reg.size, 0)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
