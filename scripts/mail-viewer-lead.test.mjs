// Host-level HTML wrapper / sibling resource regression. Synthetic inbox and context only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as H from '../lib/host.js'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

async function call (route, path, headers = {}) {
  const req = new PassThrough()
  req.method = 'GET'; req.url = '/dsh-pixel-pet' + path
  req.headers = { host: '127.0.0.1:3080', ...headers }
  const out = { code: 0, headers: {}, body: Buffer.alloc(0) }
  const res = { writeHead (code, values) { out.code = code; out.headers = values || {} }, end (body) { out.body = Buffer.from(body || '') } }
  const task = route.handler(req, res); req.end(); await task
  return out
}

test('host card wrapper confines navigation and the raw card resolves only its own sibling attachments', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pixelpet-mail-viewer-lead-')))
  const effects = []; const tools = new Map(); let route
  const ctx = { logger: { warn () {}, info () {} }, on: () => () => {}, effect: (fn) => effects.push(fn()),
    get: (name) => name === 'webServer' ? { register: (r) => { route = r; return () => {} } }
      : name === 'tools' ? { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }
        : name === 'sessions' ? { list: () => [] } : undefined }
  const pythonManager = { path: 'fixture-not-launched', detect: async () => ({}), ensure: async () => ({}), snapshot: () => ({ phase: 'ready' }), reset () {} }
  try {
    H.apply(ctx, { dataDir: root, autoInstall: false, pythonManager })
    const image = join(root, 'flower.png'); const html = join(root, 'fixture.html')
    writeFileSync(image, png)
    writeFileSync(html, '<!doctype html><html><body><img src="flower.png"><script>document.body.dataset.executed="yes"</script></body></html>')
    const result = await tools.get('pixelpet_mail_send').execute({ body: 'synthetic card', attachments: [html, image] })
    assert.equal(result.ok, true)
    const oversized = await tools.get('pixelpet_mail_send').execute({ body: 'must not silently truncate', attachments: Array(7).fill(image) })
    assert.equal(oversized.ok, false)
    const malformed = await tools.get('pixelpet_mail_send').execute({ body: 'must not silently filter', attachments: [image, 42] })
    assert.equal(malformed.ok, false)
    assert.equal(JSON.parse(readFileSync(join(root, 'mailbox', 'inbox.json'), 'utf8')).items.length, 1)
    const letter = JSON.parse(readFileSync(join(root, 'mailbox', 'inbox.json'), 'utf8')).items[0]
    const card = letter.attachments.find((a) => a.kind === 'html')
    const base = '/api/mail/file/' + letter.id + '/'
    const view = await call(route, base + card.id)
    assert.equal(view.code, 200)
    assert.match(view.body.toString(), /<iframe[^>]+sandbox="allow-scripts"/)
    assert.match(view.headers['Content-Security-Policy'], /frame-src http:\/\/127\.0\.0\.1:3080\/dsh-pixel-pet\/api\/mail\/file\//)
    assert.equal(view.body.toString().includes('dataset.executed'), false, 'raw untrusted code must not run in the outer document')
    const raw = await call(route, base + card.id + '?raw=1', { 'sec-fetch-dest': 'iframe' })
    assert.match(raw.body.toString(), /dataset.executed/)
    assert.ok(raw.headers['Content-Security-Policy'].includes('http://127.0.0.1:3080/dsh-pixel-pet' + base))
    assert.ok(!raw.headers['Content-Security-Policy'].includes('img-src http://127.0.0.1:3080 data:'), 'whole-origin resources are not permitted')
    const sibling = await call(route, base + 'flower.png')
    assert.equal(sibling.code, 200); assert.deepEqual(sibling.body, png)
    const top = await call(route, base + card.id + '?raw=1')
    assert.equal(top.headers['Content-Type'], 'application/octet-stream')
    assert.match(top.headers['Content-Disposition'], /^attachment;/)
    assert.equal((await call(route, base + '..%2Finbox.json')).code, 404)
    assert.equal((await call(route, '/api/mail/file/o-other/flower.png')).code, 404)
  } finally {
    for (const off of effects.reverse()) if (typeof off === 'function') await off()
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-mail-viewer-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
})
