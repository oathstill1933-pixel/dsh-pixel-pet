// 豆包 (Volcengine Ark Seedream) + Gemini image providers, run from host.test.mjs. Local mock HTTP only — no real API.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as IG from '../lib/imagegen.js'
import { drawCritter } from './fixtures/mock-imagegen.mjs'

const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walkFiles(join(dir, d.name)) : [join(dir, d.name)])

/** one server answering both the Ark (/api/v3/...) and the Gemini (/v1beta/...) shapes */
function startMock (key) {
  const m = { log: [], fail: null, key, ark: { mode: 'b64' }, gem: { mode: 'image' } }
  const reply = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b) }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text ? JSON.parse(text) : null
      m.log.push({ method: req.method, path: req.url, headers: req.headers, body })
      if (req.url === '/files/out.png') { const b = drawCritter('Action: idle'); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(b) }
      if (m.fail && m.fail.hang) return
      if (m.fail) return reply(res, m.fail.status, m.fail.body)
      if (req.url.startsWith('/api/v3/')) {
        if (req.headers.authorization !== 'Bearer ' + m.key) return reply(res, 401, { error: { code: 'AuthenticationError', message: 'The API key or AK/SK in the request is missing or invalid. Request ID: x', type: 'Unauthorized' } })
        if (req.method === 'GET' && req.url === '/api/v3/models') return reply(res, 200, { object: 'list', data: [{ id: IG.SEEDREAM_MODEL }, { id: 'doubao-seedream-4-5-251128' }] })
        if (req.method === 'POST' && req.url === '/api/v3/images/generations') {
          const png = drawCritter(body.prompt)
          if (m.ark.mode === 'url') return reply(res, 200, { model: body.model, created: 1, data: [{ url: 'http://127.0.0.1:' + server.address().port + '/files/out.png', size: '2048x2048' }], usage: { generated_images: 1 } })
          return reply(res, 200, { model: body.model, created: 1, data: [{ b64_json: png.toString('base64'), size: '2048x2048' }], usage: { generated_images: 1 } })
        }
        return reply(res, 404, { error: { code: 'NotFound', message: 'no' } })
      }
      if (req.url.startsWith('/v1beta/')) {
        if (req.headers['x-goog-api-key'] !== m.key) return reply(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } })
        if (req.method === 'GET' && req.url.startsWith('/v1beta/models?')) return reply(res, 200, { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/' + IG.GEMINI_MODEL }] })
        const mm = req.url.match(/^\/v1beta\/models\/([^/:]+):generateContent$/)
        if (req.method === 'POST' && mm) {
          const g = m.gem.mode
          if (g === 'blocked') return reply(res, 200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })
          if (g === 'imgsafety') return reply(res, 200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] })
          if (g === 'noimage') return reply(res, 200, { candidates: [{ finishReason: 'NO_IMAGE', content: { parts: [{ text: 'I cannot draw that' }] } }] })
          const prompt = body.contents[0].parts.find((p) => p.text).text
          return reply(res, 200, { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: drawCritter(prompt).toString('base64') } }] } }] })
        }
        return reply(res, 404, { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } })
      }
      reply(res, 404, {})
    })
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    m.origin = 'http://127.0.0.1:' + server.address().port
    m.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
    ok(m)
  }))
}

export async function runProviderTests ({ t, H, fakeCtx, call }) {
  const KEY = ['pp', 'prov', randomBytes(8).toString('hex')].join('-')
  const mock = await startMock(KEY)
  const keys = (v = KEY) => ({ kind: 'env', resolve: async () => v, describe: async () => ({ configured: true }) })
  const client = (provider, over = {}, k) => IG.createImageClient({
    settings: () => ({ provider, baseUrl: mock.origin + (provider === 'doubao' ? '/api/v3' : '/v1beta'), ...over }),
    keys: keys(k), timeoutMs: 400, testTimeoutMs: 400,
  })
  const ref1 = drawCritter('Action: idle'); const ref2 = drawCritter('Action: walking', 1)
  const fail = async (cli, f, run = (c) => c.generate({ prompt: 'p' })) => { mock.fail = f; try { await run(cli); return null } catch (e) { return e } finally { mock.fail = null } }

  await t('providers: whitelist, per-provider defaults, user edits kept across switches', () => {
    let s = IG.sanitizeImagegen({}, { provider: 'doubao' })
    assert.equal(s.provider, 'doubao'); assert.equal(s.keyRef, 'ARK_API_KEY'); assert.equal(s.baseUrl, ''); assert.equal(s.model, '')
    assert.deepEqual(IG.endpointOf(s), { provider: 'doubao', base: 'https://ark.cn-beijing.volces.com/api/v3', model: IG.SEEDREAM_MODEL })
    s = IG.sanitizeImagegen(s, { model: 'doubao-seedream-4-5-251128' })
    s = IG.sanitizeImagegen(s, { provider: 'gemini' })
    assert.equal(s.keyRef, 'GEMINI_API_KEY'); assert.equal(s.model, '')
    assert.deepEqual(IG.endpointOf(s), { provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: IG.GEMINI_MODEL })
    s = IG.sanitizeImagegen(s, { keyRef: 'MY_GEMINI' })
    s = IG.sanitizeImagegen(s, { provider: 'doubao' }); assert.equal(s.model, 'doubao-seedream-4-5-251128'); assert.equal(s.keyRef, 'ARK_API_KEY')
    s = IG.sanitizeImagegen(s, { provider: 'gemini' }); assert.equal(s.keyRef, 'MY_GEMINI')
    s = IG.sanitizeImagegen(s, { provider: 'openai' }); assert.equal(s.keyRef, 'OPENAI_API_KEY')
    assert.deepEqual(IG.endpointOf(s), { provider: 'openai', base: IG.OPENAI_BASE, model: IG.OPENAI_MODEL })
    assert.equal(IG.sanitizeImagegen(s, { provider: 'midjourney' }).provider, 'openai')
    assert.equal(IG.sanitizeImagegen({ provider: 'evil' }, {}).provider, 'openai')
    // baseUrl rule unchanged: https, or http to this machine only — also inside stored profiles
    const g = IG.sanitizeImagegen({ provider: 'gemini' }, { baseUrl: 'http://relay.example/v1beta' }); assert.equal(g.baseUrl, '')
    const dirty = IG.sanitizeImagegen({ provider: 'openai', profiles: { doubao: { baseUrl: 'http://evil.example/api/v3', key: KEY, model: 'x y' }, evil: { a: 1 } } }, { provider: 'doubao' })
    assert.equal(dirty.baseUrl, ''); assert.equal(dirty.model, ''); assert.equal(JSON.stringify(dirty).includes(KEY), false); assert.equal('evil' in dirty.profiles, false)
  })

  await t('doubao: Ark request format, references as data URIs, prompt keyed to #00FF00, one call per image', async () => {
    mock.log.length = 0
    const out = await client('doubao').generate({ prompt: 'Subject: a fox', n: 3, references: [{ name: 'ref.png', data: ref1 }] })
    assert.equal(out.length, 3); for (const b of out) assert.equal(IG.imageType(b), 'image/png')
    const posts = mock.log.filter((l) => l.method === 'POST')
    assert.equal(posts.length, 3, 'no n parameter on Ark: looped')
    const r = posts[0]
    assert.equal(r.path, '/api/v3/images/generations'); assert.equal(r.headers.authorization, 'Bearer ' + KEY)
    assert.equal(r.body.model, IG.SEEDREAM_MODEL); assert.equal(r.body.size, '2K'); assert.equal(r.body.response_format, 'b64_json'); assert.equal(r.body.watermark, false)
    assert.equal('n' in r.body, false)
    assert.equal(typeof r.body.image, 'string'); assert.match(r.body.image, /^data:image\/png;base64,/)
    assert.equal(Buffer.from(r.body.image.split(',')[1], 'base64').equals(ref1), true)
    assert.match(r.body.prompt, /^Subject: a fox/); assert.match(r.body.prompt, /#00FF00/); assert.match(r.body.prompt, /无阴影/); assert.match(r.body.prompt, /像素/)
    mock.log.length = 0
    await client('doubao').generate({ prompt: 'p', references: [{ data: ref1 }, { data: ref2 }] })
    const multi = mock.log.find((l) => l.method === 'POST').body.image
    assert.equal(Array.isArray(multi), true); assert.equal(multi.length, 2)
    mock.log.length = 0
    await client('doubao').generate({ prompt: 'p' })
    assert.equal('image' in mock.log.find((l) => l.method === 'POST').body, false)
  })

  await t('doubao: url responses are downloaded; test lists models and never generates', async () => {
    mock.ark.mode = 'url'
    try { const [b] = await client('doubao').generate({ prompt: 'p' }); assert.ok(IG.isPng(b)) } finally { mock.ark.mode = 'b64' }
    mock.log.length = 0
    const r = await client('doubao').test()
    assert.equal(r.ok, true); assert.equal(r.model, IG.SEEDREAM_MODEL); assert.equal(r.listed, true)
    assert.deepEqual(mock.log.map((l) => l.method + ' ' + l.path), ['GET /api/v3/models'])
    assert.equal((await client('doubao', { model: 'doubao-seedream-9' }).test()).listed, false)
  })

  await t('doubao: errors in Chinese — 401, 429, overdue, sensitive content, not activated, timeout, unreachable; key never echoed', async () => {
    const d = client('doubao')
    const bad = await client('doubao', {}, 'wrong-key').test(); assert.equal(bad.code, 'auth'); assert.match(bad.message, /Key 无效.*401/)
    let e = await fail(d, { status: 429, body: { error: { code: 'RateLimitExceeded.EndpointRPMExceeded', message: 'rpm' } } }); assert.equal(e.code, 'rate'); assert.match(e.message, /限流/)
    e = await fail(d, { status: 403, body: { error: { code: 'AccountOverdueError', message: 'The request failed because your account has an overdue balance.' } } }); assert.equal(e.code, 'quota'); assert.match(e.message, /余额不足/)
    for (const c of ['InputTextSensitiveContentDetected', 'InputImageSensitiveContentDetected', 'OutputImageSensitiveContentDetected.PolicyViolation']) {
      e = await fail(d, { status: 400, body: { error: { code: c, message: 'sensitive' } } }); assert.equal(e.code, 'policy', c); assert.match(e.message, /安全策略拦截/)
    }
    e = await fail(d, { status: 404, body: { error: { code: 'ModelNotOpen', message: 'Your account has not activated the model' } } }); assert.equal(e.code, 'notopen'); assert.match(e.message, /开通/)
    e = await fail(d, { status: 400, body: { error: { code: 'InvalidParameter', message: 'bad key ' + KEY + ' in request' } } }); assert.equal(e.code, 'bad'); assert.equal(e.message.includes(KEY), false)
    e = await fail(d, { hang: true }); assert.equal(e.code, 'timeout'); assert.match(e.message, /超时/)
    const off = await client('doubao', { baseUrl: 'http://127.0.0.1:9/api/v3' }).test(); assert.equal(off.ok, false); assert.match(off.message, /连不上|网络/)
  })

  await t('gemini: generateContent format, x-goog-api-key, inlineData references, IMAGE modality, looped n', async () => {
    mock.log.length = 0
    const out = await client('gemini').generate({ prompt: 'Subject: a fox', n: 2, references: [{ name: 'ref.png', data: ref1 }, { name: 'b.png', data: ref2 }] })
    assert.equal(out.length, 2); for (const b of out) assert.ok(IG.isPng(b))
    const posts = mock.log.filter((l) => l.method === 'POST'); assert.equal(posts.length, 2)
    const r = posts[0]
    assert.equal(r.path, '/v1beta/models/' + IG.GEMINI_MODEL + ':generateContent')
    assert.equal(r.headers['x-goog-api-key'], KEY); assert.equal(r.headers.authorization, undefined)
    assert.equal(r.path.includes(KEY), false, 'key not in the URL')
    const parts = r.body.contents[0].parts
    assert.equal(parts.length, 3); assert.equal(parts[0].inlineData.mimeType, 'image/png')
    assert.equal(Buffer.from(parts[0].inlineData.data, 'base64').equals(ref1), true)
    assert.match(parts[2].text, /^Subject: a fox/); assert.match(parts[2].text, /#00FF00/); assert.match(parts[2].text, /像素/)
    assert.deepEqual(r.body.generationConfig.responseModalities, ['IMAGE']); assert.equal(r.body.generationConfig.imageConfig.aspectRatio, '1:1')
    mock.log.length = 0
    const tr = await client('gemini').test()
    assert.equal(tr.ok, true); assert.equal(tr.listed, true)
    assert.deepEqual(mock.log.map((l) => l.method), ['GET'], 'probe only lists models')
  })

  await t('gemini: safety blocks, no image, bad key, 429, 403, timeout — readable Chinese', async () => {
    const g = client('gemini')
    const block = async (mode) => { mock.gem.mode = mode; try { await g.generate({ prompt: 'p' }); return null } catch (e) { return e } finally { mock.gem.mode = 'image' } }
    let e = await block('blocked'); assert.equal(e.code, 'policy'); assert.match(e.message, /拦截.*PROHIBITED_CONTENT/)
    e = await block('imgsafety'); assert.equal(e.code, 'policy'); assert.match(e.message, /IMAGE_SAFETY/)
    e = await block('noimage'); assert.equal(e.code, 'empty'); assert.match(e.message, /没有画出/)
    const bad = await client('gemini', {}, 'AIzaWRONGWRONGWRONGWRONG').test(); assert.equal(bad.code, 'auth'); assert.match(bad.message, /Key 无效/)
    e = await fail(g, { status: 401, body: { error: { code: 'authentication', message: 'The API key is missing, invalid, or expired.' } } }); assert.equal(e.code, 'auth')
    e = await fail(g, { status: 429, body: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } } }); assert.equal(e.code, 'rate'); assert.match(e.message, /429/)
    e = await fail(g, { status: 402, body: { error: { code: 'payment_required', message: 'prepay credit depleted' } } }); assert.equal(e.code, 'quota')
    e = await fail(g, { status: 400, body: { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } } }); assert.equal(e.code, 'region')
    e = await fail(g, { status: 403, body: { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } } }); assert.equal(e.code, 'forbidden')
    e = await fail(g, { hang: true }); assert.equal(e.code, 'timeout')
  })

  await t('doubao + gemini through the host: key in the credential store only, never in settings, responses, logs or files', async () => {
    for (const provider of ['doubao', 'gemini']) {
      const store = new Map()
      const creds = { async resolve (r) { return store.has(r) ? { value: store.get(r), source: 'store' } : undefined }, async describe (r) { return { configured: store.has(r), source: store.has(r) ? 'store' : undefined } }, async set (r, v) { store.set(r, v) }, async unset (r) { store.delete(r) } }
      const dir = mkdtempSync(join(tmpdir(), 'pp-prov-'))
      const g = fakeCtx(); const warns = []
      g.ctx.logger = { warn: (...a) => warns.push(a.join(' ')), info: (...a) => warns.push(a.join(' ')) }
      const get = g.ctx.get; g.ctx.get = (n) => (n === 'credentials' ? creds : get(n))
      H.apply(g.ctx, { dataDir: dir, convert: async () => ({ ok: false, message: 'n/a' }) })
      const route = g.route
      const base = mock.origin + (provider === 'doubao' ? '/api/v3' : '/v1beta')
      let r = await call(route, 'POST', '/api/settings', { body: { imagegen: { provider, baseUrl: base, key: KEY, apiKey: KEY } } })
      r = await call(route, 'GET', '/api/imagegen')
      assert.equal(r.json.settings.keyRef, provider === 'doubao' ? 'ARK_API_KEY' : 'GEMINI_API_KEY')
      assert.equal(r.json.providers[provider].model, provider === 'doubao' ? IG.SEEDREAM_MODEL : IG.GEMINI_MODEL)
      r = await call(route, 'POST', '/api/imagegen/key', { body: { value: KEY } }); assert.equal(r.json.key.configured, true); assert.equal(r.raw.includes(KEY), false)
      r = await call(route, 'POST', '/api/imagegen/test', { body: {} }); assert.equal(r.json.ok, true, JSON.stringify(r.json)); assert.equal(r.raw.includes(KEY), false)
      const job = await call(route, 'POST', '/api/create/new', { body: { name: '测', desc: 'a tiny fox' } })
      const c = await call(route, 'POST', '/api/create/' + job.json.job.id + '/candidates', { body: { n: 2 } })
      assert.equal(c.json.ok, true, JSON.stringify(c.json)); assert.equal(c.json.candidates.length, 2); assert.equal(c.raw.includes(KEY), false)
      const st = await call(route, 'GET', '/api/state'); assert.equal(st.raw.includes(KEY), false)
      assert.deepEqual(walkFiles(dir).filter((p) => readFileSync(p).includes(KEY)), [])
      assert.equal(warns.some((w) => w.includes(KEY)), false)
      for (const e of g.effects || []) if (typeof e === 'function') { try { e() } catch {} }
    }
  })

  await mock.close()
}
