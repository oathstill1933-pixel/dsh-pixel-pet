// "+ 新建角色" + image provider tests, run from host.test.mjs. Fake image service only (scripts/fixtures/mock-imagegen.mjs).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as IG from '../lib/imagegen.js'
import * as CR from '../lib/create.js'
import * as FC from '../lib/furniture-create.js'
import * as PYR from '../lib/pyruntime.js'
import { drawCritter, startMockImagegen } from './fixtures/mock-imagegen.mjs'

const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walkFiles(join(dir, d.name)) : [join(dir, d.name)])
const anyFileContains = (dir, needle) => walkFiles(dir).filter((p) => readFileSync(p).includes(needle))

/** in-memory stand-in for DSH's ctx.credentials (dsh-credentials-local surface) */
function fakeCredentials () {
  const store = new Map()
  return {
    store,
    async resolve (ref) { return store.has(ref) ? { value: store.get(ref), source: 'store' } : undefined },
    async describe (ref) { return store.has(ref) ? { configured: true, source: 'store', writable: true } : { configured: false, writable: true } },
    async set (ref, v) { if (!v) throw new Error('empty'); store.set(ref, v) },
    async unset (ref) { store.delete(ref) },
  }
}

export async function runCreateTests ({ t, H, fakeCtx, call }) {
  const FAKE = ['pp', 'fake', randomBytes(8).toString('hex')].join('-')
  const mock = await startMockImagegen({ key: FAKE })
  const REF = 'PP_TEST_IMAGE_KEY'

  const boot = ({ creds, convert } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-create-'))
    const g = fakeCtx()
    const warns = []
    g.ctx.logger = { warn: (...a) => warns.push(a.join(' ')), info: (...a) => warns.push(a.join(' ')) }
    if (creds) { const get = g.ctx.get; g.ctx.get = (n) => (n === 'credentials' ? creds : get(n)) }
    H.apply(g.ctx, { dataDir: dir, convert })
    return { g, dir, warns, route: g.route }
  }
  const waitRun = async (route, id) => {
    for (let i = 0; i < 400; i++) {
      const r = await call(route, 'GET', '/api/create/' + id)
      if (!(r.json.job.run && r.json.job.run.running)) return r.json.job
      await new Promise((ok) => setTimeout(ok, 15))
    }
    throw new Error('run did not finish')
  }

  await t('imagegen settings: whitelist, URL / ref validation, unknown fields (a pasted key) dropped', () => {
    const s = IG.sanitizeImagegen({ provider: 'openai', key: 'x', apiKey: 'y' }, { provider: 'compatible', baseUrl: 'https://relay.example/v1/', model: 'gpt-image-2', keyRef: 'MY_KEY', value: 'z' })
    assert.deepEqual(Object.keys(s).sort(), Object.keys(IG.DEFAULT_IMAGEGEN).sort())
    assert.equal(s.baseUrl, 'https://relay.example/v1'); assert.equal(s.keyRef, 'MY_KEY')
    assert.equal(IG.sanitizeImagegen(s, { baseUrl: 'ftp://x', keyRef: 'bad ref', provider: 'evil' }).baseUrl, 'https://relay.example/v1')
    assert.equal(IG.sanitizeImagegen(s, { keyRef: 'bad ref' }).keyRef, 'MY_KEY')
    assert.equal(IG.sanitizeImagegen(s, { baseUrl: 'https://' + 'u:p' + String.fromCharCode(64) + 'relay.example/v1' }).baseUrl, 'https://relay.example/v1')
    // plain http only to this machine; anything remote must be https (the key rides in Authorization)
    assert.equal(IG.sanitizeImagegen(s, { baseUrl: 'http://relay.example/v1' }).baseUrl, 'https://relay.example/v1')
    assert.equal(IG.sanitizeImagegen(s, { baseUrl: 'http://192.168.1.5:8080/v1' }).baseUrl, 'https://relay.example/v1')
    for (const ok of ['http://127.0.0.1:8080/v1', 'http://localhost:7860/v1', 'http://[::1]:9/v1']) assert.equal(IG.sanitizeImagegen(s, { baseUrl: ok }).baseUrl, ok)
    assert.equal(IG.endpointOf({ provider: 'compatible', baseUrl: 'http://relay.example/v1' }).base, '', 'an old saved remote http URL is not used')
    const m = H.mergeSettings({ imagegen: { key: 'leak' } }, { imagegen: { apiKey: 'leak', provider: 'compatible' } })
    assert.equal(JSON.stringify(m).includes('leak'), false)
  })

  await t('key via DSH credential store: never in settings.json, responses, logs or any file under the data dir', async () => {
    const creds = fakeCredentials()
    const { route, dir, warns } = boot({ creds })
    await call(route, 'POST', '/api/settings', { body: { imagegen: { provider: 'compatible', baseUrl: mock.url, keyRef: REF, key: FAKE, apiKey: FAKE } } })
    let r = await call(route, 'GET', '/api/imagegen')
    assert.equal(r.json.store, 'dsh'); assert.equal(r.json.key.configured, false)
    r = await call(route, 'POST', '/api/imagegen/key', { body: { value: FAKE } })
    assert.equal(r.status, 200); assert.equal(r.json.key.configured, true); assert.equal(r.raw.includes(FAKE), false)
    assert.equal(creds.store.get(REF), FAKE)
    const state = await call(route, 'GET', '/api/state'); assert.equal(state.raw.includes(FAKE), false); assert.equal(state.json.imagegen.key.configured, true)
    const test = await call(route, 'POST', '/api/imagegen/test', { body: {} })
    assert.equal(test.json.ok, true); assert.equal(test.raw.includes(FAKE), false)
    await call(route, 'POST', '/api/imagegen/key', { body: '{"value": "' + FAKE }) // malformed JSON quoting the key
    assert.deepEqual(anyFileContains(dir, FAKE), [])
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8').includes(FAKE), false)
    assert.equal(warns.some((w) => w.includes(FAKE)), false)
    r = await call(route, 'POST', '/api/imagegen/key', { body: { value: '' } })
    assert.equal(r.json.key.configured, false); assert.equal(creds.store.has(REF), false)
  })

  await t('no credential store: env-variable name only, key read from the environment, set refused', async () => {
    const { route, dir } = boot()
    await call(route, 'POST', '/api/settings', { body: { imagegen: { provider: 'compatible', baseUrl: mock.url, keyRef: REF } } })
    let r = await call(route, 'GET', '/api/imagegen')
    assert.equal(r.json.store, 'env'); assert.equal(r.json.key.configured, false)
    r = await call(route, 'POST', '/api/imagegen/test', { body: {} })
    assert.equal(r.json.ok, false); assert.match(r.json.message, /PP_TEST_IMAGE_KEY/)
    r = await call(route, 'POST', '/api/imagegen/key', { body: { value: FAKE } })
    assert.equal(r.status, 501)
    process.env[REF] = FAKE
    try {
      r = await call(route, 'GET', '/api/imagegen'); assert.equal(r.json.key.configured, true)
      r = await call(route, 'POST', '/api/imagegen/test', { body: {} }); assert.equal(r.json.ok, true); assert.equal(r.json.listed, true)
    } finally { delete process.env[REF] }
    assert.deepEqual(anyFileContains(dir, FAKE), [])
  })

  await t('provider errors are readable: 401, 429 rate, 429 quota, 402, 5xx, timeout, unreachable', async () => {
    const keys = { kind: 'env', resolve: async () => FAKE, describe: async () => ({ configured: true }) }
    const cli = (over = {}) => IG.createImageClient({ settings: () => ({ provider: 'compatible', baseUrl: mock.url, ...over }), keys, timeoutMs: 300, testTimeoutMs: 300 })
    const err = async (fail) => { mock.fail = fail; mock.failAfter = 0; try { await cli().generate({ prompt: 'p' }); return null } catch (e) { return e } finally { mock.fail = null } }
    assert.match((await err({ status: 429, code: 'rate_limit_exceeded' })).message, /限流/)
    assert.match((await err({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' })).message, /余额不足/)
    assert.match((await err({ status: 402 })).message, /余额不足/)
    assert.match((await err({ status: 503 })).message, /503/)
    const to = await err({ hang: true }); assert.equal(to.code, 'timeout'); assert.match(to.message, /超时/)
    const bad = IG.createImageClient({ settings: () => ({ provider: 'compatible', baseUrl: mock.url }), keys: { ...keys, resolve: async () => 'wrong' } })
    const t401 = await bad.test(); assert.equal(t401.ok, false); assert.equal(t401.code, 'auth'); assert.match(t401.message, /401/)
    const off = await cli({ baseUrl: 'http://127.0.0.1:9/v1' }).test(); assert.equal(off.ok, false); assert.match(off.message, /连不上|网络/)
  })

  // ------------------------------------------------------------------ creation flow against the mock service
  const creds = fakeCredentials(); creds.store.set(REF, FAKE)
  const convert = async ({ out, specFile }) => {
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    mkdirSync(join(out, 'sprites'), { recursive: true })
    const states = {}
    for (const s of spec.states) states[s.id] = s.frames.length
    const draft = spec.states.some((s) => s.required && !s.frames.length)
    writeFileSync(join(out, 'character.json'), JSON.stringify({ id: spec.id, name: spec.name, draft, canvas: [192, 208], logicalScale: 1, states: { idle: { label: 'idle', frames: ['sprites/idle_00.png'], durationsMs: [100], loop: true } } }))
    writeFileSync(join(out, 'sprites', 'idle_00.png'), drawCritter('Action: idle'))
    return { ok: true, validated: true, draft, states, issues: [] }
  }
  const env = boot({ creds, convert })
  const route = env.route
  await call(route, 'POST', '/api/settings', { body: { imagegen: { provider: 'compatible', baseUrl: mock.url, keyRef: REF } } })
  let id

  await t('create: candidates from a description, pick one as the reference', async () => {
    const r = await call(route, 'POST', '/api/create/new', { body: { name: '小测试', desc: 'a tiny round test critter' } })
    id = r.json.job.id; assert.match(id, /^my-[0-9a-f]{6}$/)
    const before = mock.log.length
    const c = await call(route, 'POST', '/api/create/' + id + '/candidates', { body: { n: 3 } })
    assert.equal(c.json.ok, true); assert.equal(c.json.candidates.length, 3)
    assert.equal(mock.log.length, before + 1); assert.equal(mock.log.at(-1).path, '/v1/images/generations'); assert.equal(mock.log.at(-1).n, 3)
    assert.match(mock.log.at(-1).prompt, /Purpose:.*\n.*Subject: a tiny round test critter/)
    const p = await call(route, 'POST', '/api/create/' + id + '/pick', { body: { candidate: c.json.candidates[1] } })
    assert.equal(p.json.ok, true); assert.equal(p.json.job.ref.source, 'candidate')
    const img = await call(route, 'GET', '/api/create/' + id + '/img/ref'); assert.equal(img.status, 200); assert.ok(IG.isPng(img.raw))
  })

  await t('create: one candidate request per job at a time', async () => {
    const before = mock.log.length
    const [a, b] = await Promise.all([
      call(route, 'POST', '/api/create/' + id + '/candidates', { body: { n: 1 } }),
      call(route, 'POST', '/api/create/' + id + '/candidates', { body: { n: 1 } }),
    ])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.equal((a.status === 409 ? a : b).json.code, 'busy')
    assert.equal(mock.log.length, before + 1, 'only one request reached the image service')
    assert.equal((await call(route, 'POST', '/api/create/' + id + '/candidates', { body: { n: 1 } })).status, 200, 'free again afterwards')
  })
  await t('create: candidates from an uploaded picture go through /images/edits with that picture', async () => {
    const up = await call(route, 'POST', '/api/create/' + id + '/upload?slot=upload', { body: drawCritter('Action: idle', 2) })
    assert.equal(up.json.ok, true)
    const c = await call(route, 'POST', '/api/create/' + id + '/candidates', { body: { n: 2, useUpload: true } })
    assert.equal(c.json.ok, true); assert.equal(mock.log.at(-1).path, '/v1/images/edits'); assert.equal(mock.log.at(-1).refs, 1)
    const bad = await call(route, 'POST', '/api/create/' + id + '/upload?slot=upload', { body: Buffer.from('not an image at all') })
    assert.equal(bad.status, 415)
  })

  await t('create: run needs the confirmed count, generates required states only, every request carries the reference', async () => {
    const plan = CR.planKeys([])
    assert.equal(plan.length, 50) // 10 required states per the Codex spec
    const no = await call(route, 'POST', '/api/create/' + id + '/run', { body: {} })
    assert.equal(no.status, 409); assert.equal(no.json.total, 50)
    const before = mock.log.length
    const go = await call(route, 'POST', '/api/create/' + id + '/run', { body: { confirm: 50 } })
    assert.equal(go.json.ok, true); assert.equal(go.json.total, 50)
    const job = await waitRun(route, id)
    assert.equal(job.plan.pending, 0); assert.equal(job.run.done, 50)
    const reqs = mock.log.slice(before)
    assert.equal(reqs.length, 50)
    assert.ok(reqs.every((x) => x.path === '/v1/images/edits' && x.refs >= 1))
    assert.ok(reqs.filter((x) => /Frame [2-9] of/.test(x.prompt)).every((x) => x.refs >= 2)) // + frame 00 of the same action
    assert.equal(job.frames['mood-happy_00'], 'pending')
  })

  await t('create: optional states are added on request; failure mid-run then resume skips finished frames', async () => {
    await call(route, 'POST', '/api/create/' + id + '/meta', { body: { optional: ['speaking', 'mood-oops', 'nope'] } })
    let v = (await call(route, 'GET', '/api/create/' + id)).json.job
    assert.deepEqual(v.optional, ['speaking', 'mood-oops']); assert.equal(v.plan.pending, 8)
    const doneBefore = statSync(join(env.dir, 'create', id, 'raw', 'idle_00.png')).mtimeMs
    mock.served = 0; mock.failAfter = 3; mock.fail = { status: 429, code: 'insufficient_quota' }
    const before = mock.log.length
    await call(route, 'POST', '/api/create/' + id + '/run', { body: { confirm: 8 } })
    v = await waitRun(route, id)
    assert.equal(v.run.done, 3); assert.match(v.run.error, /余额不足/)
    assert.equal(mock.log.length - before, 4) // stopped at the first fatal error, not 8 failures
    assert.equal(v.plan.pending, 5)
    mock.fail = null
    // host restart: a fresh plugin instance on the same data dir picks the job up
    const g2 = fakeCtx(); const get = g2.ctx.get; g2.ctx.get = (n) => (n === 'credentials' ? creds : get(n))
    H.apply(g2.ctx, { dataDir: env.dir, convert })
    const r2 = g2.route
    const again = await call(r2, 'POST', '/api/create/' + id + '/run', { body: { confirm: 8 } })
    assert.equal(again.status, 409); assert.equal(again.json.total, 5)
    const mark = mock.log.length
    await call(r2, 'POST', '/api/create/' + id + '/run', { body: { confirm: 5 } })
    v = await waitRun(r2, id)
    assert.equal(v.plan.pending, 0); assert.equal(mock.log.length - mark, 5)
    assert.equal(statSync(join(env.dir, 'create', id, 'raw', 'idle_00.png')).mtimeMs, doneBefore)
    assert.ok(mock.log.slice(mark).filter((x) => /speaking/.test(x.prompt)).every((x) => x.refs >= 2)) // idle_00 rides along
  })

  await t('create: redo one frame / one state regenerates exactly those', async () => {
    const mark = mock.log.length
    let r = await call(route, 'POST', '/api/create/' + id + '/run', { body: { keys: ['waving_02'], confirm: 1 } })
    assert.equal(r.json.total, 1)
    await waitRun(route, id)
    r = await call(route, 'POST', '/api/create/' + id + '/run', { body: { keys: ['lie_00', 'lie_01', 'lie_02', 'lie_03', 'bogus_00', 'idle_99'], confirm: 4 } })
    assert.equal(r.json.total, 4)
    const v = await waitRun(route, id)
    assert.equal(mock.log.length - mark, 5); assert.equal(v.plan.pending, 0)
  })

  await t('create: manual frames by file name; unknown names refused', async () => {
    let r = await call(route, 'POST', '/api/create/' + id + '/import?name=drag-left_01.png', { body: drawCritter('Action: dragged') })
    assert.equal(r.json.ok, true); assert.equal(r.json.key, 'drag-left_01')
    r = await call(route, 'POST', '/api/create/' + id + '/import?name=whatever.png', { body: drawCritter('x') }); assert.equal(r.status, 400)
    r = await call(route, 'POST', '/api/create/' + id + '/import?name=idle_07.png', { body: drawCritter('x') }); assert.equal(r.status, 400)
    const v = (await call(route, 'GET', '/api/create/' + id)).json.job
    assert.ok(v.optional.includes('drag-left')); assert.equal(v.frames['drag-left_01'], 'done')
  })

  await t('create: import-only job (own drawings) works without any image service', async () => {
    const r = await call(route, 'POST', '/api/create/new', { body: { name: '手绘' } })
    const jid = r.json.job.id
    await call(route, 'POST', '/api/create/' + jid + '/upload?slot=ref', { body: drawCritter('ref') })
    const mark = mock.log.length
    for (const k of ['idle_00', 'idle_01']) await call(route, 'POST', '/api/create/' + jid + '/import?name=' + k + '.png', { body: drawCritter(k) })
    const b = await call(route, 'POST', '/api/create/' + jid + '/build', { body: {} })
    assert.equal(b.json.ok, true); assert.equal(b.json.build.draft, true)
    assert.equal(mock.log.length, mark)
  })

  await t('create: build -> install into <data>/characters, listed in /api/state, thumb served', async () => {
    const b = await call(route, 'POST', '/api/create/' + id + '/build', { body: {} })
    assert.equal(b.json.ok, true); assert.equal(b.json.build.draft, false); assert.equal(b.json.build.states.idle, 6)
    const spec = JSON.parse(readFileSync(join(env.dir, 'create', id, 'spec.json'), 'utf8'))
    assert.deepEqual(spec.states.find((s) => s.id === 'speaking').frames, ['speaking_00', 'speaking_01', 'speaking_02', 'speaking_03'])
    const i = await call(route, 'POST', '/api/create/' + id + '/install', { body: {} })
    assert.equal(i.json.ok, true)
    assert.ok(existsSync(join(env.dir, 'characters', id, 'character.json')))
    const st = await call(route, 'GET', '/api/state')
    const c = st.json.characters.find((x) => x.id === id)
    assert.ok(c && c.user === true && c.name === '小测试')
    assert.ok(st.json.characters.some((x) => x.id === 'whale-girl' && !x.user)) // default untouched
    const th = await call(route, 'GET', '/api/thumb/character/' + id); assert.equal(th.status, 200)
    const s = await call(route, 'POST', '/api/settings', { body: { character: id } }); assert.equal(s.json.settings.character, id)
    await call(route, 'POST', '/api/settings', { body: { character: '' } })
  })

  await t('create: pages served; job paths cannot escape', async () => {
    const p = await call(route, 'GET', '/create'); assert.equal(p.status, 200); assert.ok(p.raw.includes('create.js'))
    assert.equal((await call(route, 'GET', '/api/create/' + id + '/img/raw/..%2F..%2Fjob')).status, 404)
    assert.equal((await call(route, 'GET', '/api/create/' + id + '/img/frame/../character.json')).status, 404)
    assert.equal((await call(route, 'GET', '/api/create/..%2F..')).status, 404)
    assert.deepEqual(anyFileContains(env.dir, FAKE), [])
  })

  // ------------------------------------------------------------------ "+ 新建家具"
  const fconvert = async ({ out, frames }) => {
    for (const k of frames) writeFileSync(join(out, 'sprites', k + '.png'), drawCritter('furniture ' + k))
    return { ok: true, validated: true, issues: [], message: 'OK' }
  }
  const fboot = (withKey) => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-fcreate-'))
    const g = fakeCtx()
    if (withKey) { const get = g.ctx.get; g.ctx.get = (n) => (n === 'credentials' ? creds : get(n)) }
    H.apply(g.ctx, { dataDir: dir, convertFurniture: fconvert })
    return { g, dir, route: g.route }
  }
  const fwait = async (route, fid) => {
    for (let i = 0; i < 400; i++) {
      const r = await call(route, 'GET', '/api/fcreate/' + fid)
      if (!(r.json.job.run && r.json.job.run.running)) return r.json.job
      await new Promise((ok) => setTimeout(ok, 15))
    }
    throw new Error('furniture run did not finish')
  }

  await t('furniture card: bounded fields, manifest has only empty frames + occupant anchor, done text uses {name}', () => {
    const c = FC.cleanCard(null, { name: '  猫窝\n', kind: 'sleep', size: [5000, 'x'], anchor: [10, 99999], clipY: '', frames: 9, pose: 'evil' })
    assert.equal(c.name, '猫窝'); assert.deepEqual(c.size, [1200, 300]); assert.deepEqual(c.anchor, [10, 300]); assert.equal(c.clipY, null); assert.equal(c.frames, 4); assert.equal(c.pose, 'waving')
    const m = FC.buildManifest('furn-abcdef', { ...c, clipY: 200 }, ['empty_00'])
    assert.deepEqual(Object.keys(m.states), ['empty'])
    const sleep = m.interactions.find((i) => i.verb === 'sleep')
    assert.equal(sleep.mode, 'inside'); assert.equal(sleep.state, undefined)
    assert.deepEqual(sleep.occupant, { pose: 'curl-sleep', fallback: ['lie'], anchor: [10, 300], clipY: 200, area: FC.SPECS.nest.area, clipPath: FC.SPECS.nest.clipPath })
    assert.match(sleep.done, /^\{name\}/); assert.ok(m.interactions.some((i) => i.mode === 'exit'))
    assert.equal(m.defaultEnabled, false)
    const use = FC.buildManifest('furn-abcdef', FC.cleanCard(null, { kind: 'use', pose: 'mood-happy', done: '到了' }), ['empty_00'])
    assert.equal(use.interactions.length, 1); assert.equal(use.interactions[0].pose, 'mood-happy'); assert.equal(use.interactions[0].done, '到了')
    const p = FC.buildFurniturePrompt(c)
    assert.match(p, /EMPTY/); assert.match(p, /#00FF00/)
  })

  await t('furniture specs: preset fills size/kind/anchor, size edit -> custom, old cards keep working', () => {
    const d = FC.cleanCard(null, { spec: 'desk' })
    assert.equal(d.spec, 'desk'); assert.deepEqual(d.size, [300, 260]); assert.equal(d.kind, 'use'); assert.deepEqual(d.anchor, [150, 200])
    assert.equal(FC.cleanCard(d, { spec: 'tall', kind: 'sleep' }).kind, 'sleep', 'explicit fields win over the preset')
    const c = FC.cleanCard(d, { size: [310, 260] }); assert.equal(c.spec, 'custom'); assert.deepEqual(c.size, [310, 260])
    assert.equal(FC.cleanCard(d, { size: [300, 260] }).spec, 'desk')
    assert.equal(FC.cleanCard(c, { spec: 'evil' }).spec, 'custom')
    // a job.json from before specs / animations / interactions
    const old = { name: '旧窝', desc: '', kind: 'sleep', size: [360, 300], anchor: [180, 230], clipY: null, pose: 'waving', done: '', frames: 2 }
    const o = FC.cleanCard(old); assert.equal(o.spec, 'nest'); assert.deepEqual(o.extraStates, []); assert.deepEqual(o.interactions, []); assert.equal(o.frames, 2)
    assert.equal(FC.cleanCard({ ...old, size: [240, 180] }).spec, 'custom')
    const m = FC.buildManifest('furn-abcdef', old, ['empty_00', 'empty_01'])
    assert.deepEqual(Object.keys(m.states), ['empty']); assert.equal(m.states.empty.frames.length, 2); assert.equal(m.floorY, 286)
    for (const [k, s] of Object.entries(FC.SPECS)) if (s.size) assert.ok(s.anchor[0] <= s.size[0] && s.anchor[1] <= s.size[1], k)
  })

  await t('furniture card: area + clipPath sanitized, emitted, old cards untouched', () => {
    const size = [360, 300]
    assert.deepEqual(FC.cleanArea([300, 250, 10, -20], size), [10, 0, 300, 250], 'corners sorted + clamped')
    assert.equal(FC.cleanArea([10, 10, 12, 80], size), null, 'too thin')
    assert.equal(FC.cleanArea([1, 2, 'x', 4], size), null)
    assert.equal(FC.cleanArea('evil', size), null)
    assert.deepEqual(FC.cleanClipPath([[200, 9999], [10, 5], ['x', 1], [10, 7], [-5, 3]], size), [[0, 3], [10, 7], [200, 300]], 'sorted, same x -> last, clamped, junk dropped')
    assert.equal(FC.cleanClipPath([[5, 5]], size), null, 'one point is not a line')
    assert.equal(FC.cleanClipPath(Array.from({ length: 40 }, (_, i) => [i * 5, 100]), size).length, FC.MAX_CLIP_POINTS)
    const c = FC.cleanCard(null, { area: [100, 40, 260, 230], clipPath: [[60, 220], [300, 210]] })
    assert.deepEqual(c.area, [100, 40, 260, 230]); assert.deepEqual(c.clipPath, [[60, 220], [300, 210]])
    const occ = FC.buildManifest('furn-abcdef', c, ['empty_00']).interactions.find((i) => i.verb === 'sleep').occupant
    assert.deepEqual(occ.area, [100, 40, 260, 230]); assert.deepEqual(occ.clipPath, [[60, 220], [300, 210]]); assert.ok(Array.isArray(occ.anchor), 'anchor kept for older runtimes')
    const cleared = FC.cleanCard(c, { area: null, clipPath: [] })
    assert.equal(cleared.area, null); assert.equal(cleared.clipPath, null)
    const occ2 = FC.buildManifest('furn-abcdef', cleared, ['empty_00']).interactions.find((i) => i.verb === 'sleep').occupant
    assert.equal('area' in occ2, false); assert.equal('clipPath' in occ2, false)
    // a session-edited file with an old clipPath does not resurrect it once the card cleared it
    const merged = FC.mergeInteractions([{ verb: 'sleep', occupant: occ2 }], [{ verb: 'sleep', occupant: { ...occ, extra: 1 } }])
    assert.equal('clipPath' in merged[0].occupant, false); assert.equal(merged[0].occupant.extra, 1)
    const old = FC.cleanCard({ name: '旧窝', kind: 'sleep', size: [360, 300], anchor: [180, 230], clipY: 200, frames: 1 })
    assert.equal(old.area, null); assert.equal(old.clipPath, null)
    assert.deepEqual(FC.cleanCard(old, { spec: 'nest' }).area, null, 'same preset: nothing reset')
    assert.deepEqual(FC.cleanCard(FC.cleanCard(old, { spec: 'desk' }), { spec: 'nest' }).area, FC.SPECS.nest.area, 'picking 窝/床 fills the default area')
    for (const [k, s] of Object.entries(FC.SPECS)) {
      if (s.area) assert.deepEqual(FC.cleanArea(s.area, s.size), s.area, k)
      if (s.clipPath) assert.deepEqual(FC.cleanClipPath(s.clipPath, s.size), s.clipPath, k)
    }
    assert.match(FC.contractSummary(), /clipPath/)
  })

  await t('furniture extra animations + custom interactions: ids, limits, references sanitized', () => {
    const c = FC.cleanCard(null, {
      spec: 'desk',
      extraStates: [{ id: 'Open Door', label: '开门\n很长很长很长很长的名字', frames: 99, desc: 'x'.repeat(900) }, { id: 'empty' }, { id: 'open-door' }, null, 'x',
        ...Array.from({ length: 9 }, (_, i) => ({ id: 's' + i }))],
      interactions: [{ verb: 'Peek!', mode: 'beside', pose: 'Mood-Happy', furnitureState: 'open-door', holdMs: 99999, brief: '探头\n看看', say: '去\n看看' },
        { verb: 'sleep' }, { verb: 'nap', mode: 'inside', furnitureState: 'nope', pose: '../evil' }, { verb: 'x', mode: 'teleport', holdMs: 'abc' },
        ...Array.from({ length: 9 }, (_, i) => ({ verb: 'v' + i }))],
    })
    assert.equal(c.extraStates.length, FC.MAX_STATES)
    const [a, b, d] = c.extraStates
    assert.equal(a.id, 'open-door'); assert.equal(a.frames, FC.MAX_STATE_FRAMES); assert.equal(a.label.length, 12); assert.equal(a.desc.length, 300)
    assert.notEqual(b.id, 'empty'); assert.notEqual(d.id, 'open-door', 'duplicate ids are renamed')
    assert.ok(c.extraStates.every((s) => FC.SID_RE.test(s.id)))
    assert.equal(c.interactions.length, FC.MAX_INTERACTIONS)
    const [p, s2, n, x] = c.interactions
    assert.equal(p.verb, 'peek'); assert.equal(p.pose, 'mood-happy'); assert.equal(p.furnitureState, 'open-door'); assert.equal(p.holdMs, 10000)
    assert.equal(p.say, '去 看看'); assert.equal(p.brief, '探头\n看看')
    assert.ok(!FC.RESERVED_VERBS.includes(s2.verb), 'built-in verbs are not taken')
    assert.equal(n.mode, 'inside'); assert.equal(n.furnitureState, null); assert.equal(n.pose, null)
    assert.equal(x.mode, 'beside'); assert.equal(x.holdMs, 3000)
    assert.deepEqual(FC.cardKeys({ ...c, extraStates: [a] }).slice(0, 3), ['empty_00', 'open-door_00', 'open-door_01'])
    // removing an animation drops what pointed at it
    const r = FC.cleanCard({ ...c, mainState: 'open-door' }, { extraStates: [] })
    assert.equal(r.mainState, null); assert.ok(r.interactions.every((i) => i.furnitureState === null))
  })

  await t('furniture manifest: extra states + custom beside/inside interactions, wake added, brief stays out', () => {
    const c = FC.cleanCard(null, { spec: 'desk', name: '书桌', mainState: 'lamp',
      extraStates: [{ id: 'lamp', label: '亮灯', frames: 2, ms: 300 }, { id: 'drawer', frames: 2 }],
      interactions: [{ verb: 'read', say: '去{furniture}看书', pose: 'review', furnitureState: 'lamp', holdMs: 4000, brief: '坐下翻书' },
        { verb: 'hide', mode: 'inside', furnitureState: 'drawer', pose: 'lie' }] })
    const m = FC.buildManifest('furn-abcdef', c, ['empty_00', 'lamp_00', 'lamp_01'])
    assert.deepEqual(Object.keys(m.states), ['empty', 'lamp'], 'animations without frames are left out')
    assert.deepEqual(m.states.lamp, { frames: ['sprites/lamp_00.png', 'sprites/lamp_01.png'], durationsMs: [300, 300] })
    const by = Object.fromEntries(m.interactions.map((i) => [i.verb, i]))
    assert.equal(by.use.furnitureState, 'lamp')
    assert.deepEqual({ ...by.read }, { verb: 'read', mode: 'beside', say: '去书桌看书', hint: '', done: '{name}到书桌旁边了。', pose: 'review', holdMs: 4000, furnitureState: 'lamp' })
    assert.equal(by.hide.mode, 'inside'); assert.equal(by.hide.occupant.pose, 'lie'); assert.equal(by.hide.occupant.under, undefined, 'drawer has no frames')
    assert.deepEqual(by.hide.occupant.anchor, [150, 200])
    assert.equal(by.wake.mode, 'exit')
    assert.ok(!JSON.stringify(m).includes('坐下翻书'))
    const h = FC.buildHandoff({ id: 'furn-abcdef', card: c }, join(tmpdir(), 'raw'))
    assert.match(h, /规格：桌柜 · 300×260/); assert.match(h, /lamp_01\.png/); assert.match(h, /drawer_00\.png/); assert.match(h, /想要的效果：坐下翻书/)
    assert.match(h, /docs\/FURNITURE_SPEC\.md/); assert.match(h, /validate\.py --strict/); assert.match(h, /interactions/)
    assert.ok(existsSync(join(H.PLUGIN_ROOT, FC.SPEC_DOC)), 'the doc the brief points at exists')
    const merged = FC.mergeInteractions(m.interactions, [{ verb: 'read', say: 'old', extra: 1 }, { verb: 'dance', mode: 'beside', pose: 'jumping' }])
    assert.equal(merged.find((i) => i.verb === 'read').say, '去书桌看书'); assert.equal(merged.find((i) => i.verb === 'read').extra, 1)
    assert.ok(merged.some((i) => i.verb === 'dance'))
  })

  await t('furniture with an extra animation + custom interaction: real convert + validate --strict, session edits survive', async () => {
    const py = [process.env.PIXELPET_TEST_PY, ...PYR.pathCandidates(), 'py'].find((p) => p && spawnSync(p, ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0)
    if (!py) { console.log('     (skipped: no python with Pillow)'); return }
    const dir = mkdtempSync(join(tmpdir(), 'pp-fspec-'))
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    const convert = async ({ src, out, frames, size }) => {
      const p = spawnSync(py, [join(H.PLUGIN_ROOT, 'runtime', 'furniture_convert.py'), '--src', src, '--out', out, '--frames', frames.join(','), '--size', size.join(',')], { env })
      return JSON.parse(p.stdout.toString('utf8').trim().split('\n').pop())
    }
    const st = FC.createFurnitureStudio({ dataDir: dir, images: null, convert, relay: null, sessionId: () => '' })
    const job = st.create({ name: '小书桌', spec: 'desk' })
    st.update(job.id, { extraStates: [{ id: 'lamp', label: '亮灯', frames: 2 }],
      interactions: [{ verb: 'read', say: '去看书', pose: 'review', furnitureState: 'lamp', holdMs: 4000, brief: '坐下翻书' }] })
    for (const k of ['empty_00', 'lamp_00', 'lamp_01']) assert.equal(st.importFrame(job.id, k + '.png', drawCritter('desk ' + k)).code, 200)
    assert.equal(st.importFrame(job.id, 'lamp_06.png', drawCritter('x')).code, 400)
    assert.equal(st.view(job.id).plan.pending, 0)
    assert.ok(st.file(job.id, 'raw', 'lamp_01')); assert.equal(st.file(job.id, 'raw', 'nope_00'), null); assert.equal(st.file(job.id, 'raw', '../job'), null)
    const b = await st.build(job.id)
    assert.equal(b.body.ok, true, JSON.stringify(b.body))
    const out = join(dir, 'create-furniture', job.id, 'build', job.id)
    const v = spawnSync(py, [join(H.PLUGIN_ROOT, 'runtime', 'validate.py'), '--strict', out], { env })
    assert.equal(v.status, 0, v.stdout.toString('utf8'))
    let m = JSON.parse(readFileSync(join(out, 'furniture.json'), 'utf8'))
    assert.deepEqual(Object.keys(m.states), ['empty', 'lamp'])
    assert.equal(m.interactions.find((i) => i.verb === 'read').furnitureState, 'lamp')
    // a session adds its own interaction to the built manifest; card edits and a rebuild keep it
    m.interactions.push({ verb: 'dance', mode: 'beside', pose: 'jumping', holdMs: 2000, furnitureState: 'lamp', say: '跳舞' })
    writeFileSync(join(out, 'furniture.json'), JSON.stringify(m, null, 2))
    assert.equal(st.view(job.id).handEdited, true)
    st.update(job.id, { anchor: [120, 190] })
    m = JSON.parse(readFileSync(join(out, 'furniture.json'), 'utf8'))
    assert.ok(m.interactions.some((i) => i.verb === 'dance'))
    // a raw picture for an animation the card does not list yet is adopted on rebuild
    writeFileSync(join(dir, 'create-furniture', job.id, 'raw', 'glow_00.png'), drawCritter('desk glow'))
    assert.equal((await st.build(job.id)).body.ok, true)
    assert.ok(st.read(job.id).card.extraStates.some((s) => s.id === 'glow'))
    m = JSON.parse(readFileSync(join(out, 'furniture.json'), 'utf8'))
    assert.ok(m.states.glow && m.interactions.some((i) => i.verb === 'dance'))
    assert.equal(spawnSync(py, [join(H.PLUGIN_ROOT, 'runtime', 'validate.py'), '--strict', out], { env }).status, 0)
    assert.equal(st.install(job.id).body.ok, true)
    assert.ok(existsSync(join(dir, 'furniture', job.id, 'sprites', 'lamp_01.png')))
  })

  await t('furniture create, image-service path: confirmed count, empty frames only, build -> install -> listed', async () => {
    const f = fboot(true)
    await call(f.route, 'POST', '/api/settings', { body: { imagegen: { provider: 'compatible', baseUrl: mock.url, keyRef: REF } } })
    assert.equal((await call(f.route, 'GET', '/api/fcreate/meta')).json.imagegen, true)
    const n = await call(f.route, 'POST', '/api/fcreate/new', { body: { name: '猫窝', desc: 'a round cat basket', kind: 'sleep', size: [200, 160], frames: 2 } })
    const fid = n.json.job.id; assert.match(fid, /^furn-[0-9a-f]{6}$/)
    const no = await call(f.route, 'POST', '/api/fcreate/' + fid + '/run', { body: {} })
    assert.equal(no.status, 409); assert.equal(no.json.total, 2)
    const mark = mock.log.length
    assert.equal((await call(f.route, 'POST', '/api/fcreate/' + fid + '/run', { body: { confirm: 2 } })).json.ok, true)
    let job = await fwait(f.route, fid)
    assert.equal(job.plan.pending, 0)
    const reqs = mock.log.slice(mark)
    assert.equal(reqs.length, 2)
    assert.ok(reqs.every((x) => /Subject: a round cat basket/.test(x.prompt) && /EMPTY/.test(x.prompt)))
    assert.equal(reqs[1].refs, 1, 'frame 2 carries frame 1')
    const b = await call(f.route, 'POST', '/api/fcreate/' + fid + '/build', { body: {} })
    assert.equal(b.json.ok, true)
    await call(f.route, 'POST', '/api/fcreate/' + fid + '/meta', { body: { anchor: [100, 140], clipY: 120 } })
    const built = JSON.parse(readFileSync(join(f.dir, 'create-furniture', fid, 'build', fid, 'furniture.json'), 'utf8'))
    assert.deepEqual(built.interactions[0].occupant.anchor, [100, 140], 'anchor change rewrites the built manifest')
    assert.equal(built.states.empty.frames.length, 2)
    const i = await call(f.route, 'POST', '/api/fcreate/' + fid + '/install', { body: {} })
    assert.equal(i.json.ok, true)
    assert.ok(existsSync(join(f.dir, 'furniture', fid, 'sprites', 'empty_01.png')))
    const st = await call(f.route, 'GET', '/api/state')
    const it = st.json.furniture.find((x) => x.id === fid)
    assert.ok(it && it.user === true && it.name === '猫窝' && it.defaultEnabled === false)
    assert.ok(st.json.furniture.some((x) => x.id === 'whale-nest' && !x.user))
    assert.equal((await call(f.route, 'GET', '/api/thumb/furniture/' + fid)).status, 200)
    job = (await call(f.route, 'GET', '/api/fcreate/' + fid)).json.job; assert.equal(job.installed, true)
    for (const e of f.g.effects) if (typeof e === 'function') e()
  })

  await t('furniture create, session path: no image service, brief to the pointed session, import fills the frame', async () => {
    const f = fboot(false)
    assert.equal((await call(f.route, 'GET', '/api/fcreate/meta')).json.imagegen, false)
    const fid = (await call(f.route, 'POST', '/api/fcreate/new', { body: { name: '小床', kind: 'sleep', size: [240, 180] } })).json.job.id
    const mark = mock.log.length
    const txt = await call(f.route, 'POST', '/api/fcreate/' + fid + '/handoff', { body: {} })
    assert.equal(txt.json.ok, true)
    assert.match(txt.json.text, /empty_00\.png/); assert.match(txt.json.text, /#00FF00/); assert.match(txt.json.text, /240×180/)
    assert.ok(txt.json.text.includes(join(f.dir, 'create-furniture', fid, 'raw')))
    const none = await call(f.route, 'POST', '/api/fcreate/' + fid + '/handoff', { body: { send: true } })
    assert.equal(none.status, 400); assert.equal(none.json.code, 'nosession')
    await call(f.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-s1' } } } })
    const before = f.g.agent.calls.length
    const sent = await call(f.route, 'POST', '/api/fcreate/' + fid + '/handoff', { body: { send: true } })
    assert.equal(sent.json.ok, true)
    assert.equal(f.g.agent.calls.length, before + 1)
    assert.match(f.g.agent.calls.at(-1).content[0].text, /画一件桌宠家具：小床/)
    const bad = await call(f.route, 'POST', '/api/fcreate/' + fid + '/import?name=bed.png', { body: Buffer.from('nope') })
    assert.equal(bad.status, 415)
    assert.equal((await call(f.route, 'POST', '/api/fcreate/' + fid + '/import?name=empty_09.png', { body: drawCritter('x') })).status, 400)
    const ok = await call(f.route, 'POST', '/api/fcreate/' + fid + '/import?name=empty_00.png', { body: drawCritter('bed') })
    assert.equal(ok.json.ok, true); assert.equal(ok.json.job.frames.empty_00, 'done'); assert.equal(ok.json.job.plan.pending, 0)
    assert.equal((await call(f.route, 'POST', '/api/fcreate/' + fid + '/build', { body: {} })).json.ok, true)
    assert.equal((await call(f.route, 'POST', '/api/fcreate/' + fid + '/install', { body: {} })).json.ok, true)
    assert.equal(mock.log.length, mark, 'no image request on this path')
    const page = await call(f.route, 'GET', '/create?kind=furniture'); assert.equal(page.status, 200); assert.ok(page.raw.includes('furniture.js'))
    assert.equal((await call(f.route, 'GET', '/furniture.js')).status, 200)
    assert.equal((await call(f.route, 'GET', '/api/fcreate/' + fid + '/img/raw/..%2Fjob')).status, 404)
    assert.equal((await call(f.route, 'GET', '/api/fcreate/..%2F..')).status, 404)
    assert.equal((await call(f.route, 'GET', '/api/fcreate/pose/whale-girl')).status, 200)
    assert.equal((await call(f.route, 'GET', '/api/fcreate/pose/..%2Fx')).status, 404)
    for (const e of f.g.effects) if (typeof e === 'function') e()
  })

  for (const e of env.g.effects) if (typeof e === 'function') e()
  await mock.close()
}
