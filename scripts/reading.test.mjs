// node scripts/reading.test.mjs — 一起看书：路由 / 开关 / when / 不泄露路径 / 留存只在开关开时落盘 / 导入旧留存不改旧文件
// 不起真窗口、不联网：spawn、网页抓取、文件框、语音识别、会话中继全部用假对象。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { cleanPick, composePrompt, createReading, fnv, isPrivateHost, pdfId, READING_DEFAULT, resolveReadingPython, sanitizeReading, webGet, webId } from '../lib/reading.js'
import { createReadingTools } from '../lib/reading-tools.js'
import * as H from '../lib/host.js'

let n = 0
const test = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const SECRET_DIR = '私密目录-不应外泄'
const tmp = (p) => mkdtempSync(join(tmpdir(), p))
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function rig ({ enabled = true, session = 'sess-1', reply = '这段说的是示例。', getter, pickFile, sendCommand, transcribe } = {}) {
  const dataDir = tmp('pp-read-')
  const st = { reading: { enabled, python: '' }, listen: { python: '' }, voice: { llm: { sessionId: session } }, character: 'whale-girl' }
  const asks = []
  const cmds = []
  const relay = { ask: async (id, text) => { asks.push({ id, text }); return reply ? { code: 200, body: { ok: true, reply } } : { code: 504, body: { ok: false } } } }
  const r = createReading({
    dataDir, settings: () => st, relay, getter, pickFile, transcribe, watchMs: 20,
    sendCommand: sendCommand || (async (b) => { cmds.push(b); return b.cmd === 'status' ? { ok: true, data: { inside: null, moving: false } } : { ok: true } }),
    partner: () => ({ name: '小鲸', character: 'whale-girl' }),
  })
  return { r, st, dataDir, asks, cmds }
}

async function hit (r, method, path, { body, raw, type, headers = {}, petKeyOk } = {}) {
  const url = new URL(path, 'http://local')
  const h = { host: '127.0.0.1:3080', ...headers }
  if (body !== undefined) h['content-type'] = 'application/json'
  if (raw !== undefined) h['content-type'] = type || 'application/octet-stream'
  const req = { method, headers: h }
  const out = { code: 0, body: null, raw: null, headers: null }
  const res = { writeHead: (c, hd) => { out.code = c; out.headers = hd }, end: (b) => { out.raw = b }, on () { return this }, once () { return this }, emit () {}, write () { return true } }
  const send = (_r, c, o) => { out.code = c; out.body = o }
  const readBody = async () => raw !== undefined ? raw : Buffer.from(JSON.stringify(body || {}))
  const handled = await r.handle(req, res, { path: url.pathname, url, host: '127.0.0.1:3080', send, readBody, petKeyOk, base: 'http://127.0.0.1:3080/dsh-pixel-pet/' })
  return { handled, ...out }
}
const deepStr = (o) => JSON.stringify(o)

await test('sanitizeReading + default off', () => {
  assert.deepEqual(READING_DEFAULT, { enabled: false, python: '' })
  assert.deepEqual(sanitizeReading(undefined, {}), { enabled: false, python: '' })
  assert.deepEqual(sanitizeReading({ enabled: true }, { enabled: 'yes', python: ' C:\\p.exe\n' }), { enabled: true, python: 'C:\\p.exe' })
  const merged = H.mergeSettings({}, { reading: { enabled: true, bogus: 1 } })
  assert.deepEqual(merged.reading, { enabled: true, python: '' })
  assert.deepEqual(H.mergeSettings({}, {}).reading, { enabled: false, python: '' })
})

await test('python: reading.python → listen.python → listen.json; missing files ignored', () => {
  const d = tmp('pp-rpy-')
  const a = join(d, 'a.exe'); const b = join(d, 'b.exe'); const c = join(d, 'c.exe')
  for (const f of [a, b, c]) writeFileSync(f, '')
  assert.equal(resolveReadingPython({ settings: { reading: { python: a }, listen: { python: b } }, dataDir: d }).python, a)
  assert.equal(resolveReadingPython({ settings: { reading: { python: join(d, 'no.exe') }, listen: { python: b } }, dataDir: d }).python, b)
  writeFileSync(join(d, 'listen.json'), JSON.stringify({ python: c }))
  assert.equal(resolveReadingPython({ settings: {}, dataDir: d }).python, c)
  assert.equal(resolveReadingPython({ settings: {}, dataDir: tmp('pp-rpy2-') }).ok, false)
})

await test('docId algorithm identical to the private version (FNV-1a 64)', () => {
  assert.equal(fnv(''), 'cbf29ce484222325')
  assert.equal(fnv('a'), 'af63dc4c8601ec8c')
  assert.equal(pdfId('D:\\Books\\X.PDF'), 'pdf-' + fnv('d:\\books\\x.pdf'))
  assert.equal(webId(new URL('https://example.com/a#frag')), 'web-' + fnv('https://example.com/a'))
})

await test('SSRF guard: private hosts refused on every hop', async () => {
  for (const h of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1', 'a.local']) assert.equal(isPrivateHost(h), true, h)
  assert.equal(isPrivateHost('example.com'), false)
  await assert.rejects(webGet(new URL('http://127.0.0.1:8088/'), 1000, { getter: async () => ({ status: 200, headers: {}, body: Buffer.from('x') }) }), /不抓本机/)
  const hop = async (u) => u.hostname === 'example.com' ? { status: 302, headers: { location: 'http://192.168.0.2/x' }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.from('in') }
  await assert.rejects(webGet(new URL('https://example.com/'), 1000, { getter: hop }), /不抓本机/)
})

await test('disabled: state says off, everything else 409, no window', async () => {
  const { r } = rig({ enabled: false })
  const s = await hit(r, 'GET', '/api/reading/state')
  assert.equal(s.code, 200); assert.equal(s.body.enabled, false)
  for (const [m, p, b] of [['GET', '/api/reading/fetch?url=https://example.com'], ['GET', '/api/reading/pdf?id=pdf-0123456789abcdef'], ['POST', '/api/reading/ask', {}], ['POST', '/api/reading/kept/save', {}], ['POST', '/api/reading/open', {}], ['POST', '/api/reading/import-legacy', {}]]) {
    assert.equal((await hit(r, m, p, { body: b })).code, 409, p)
  }
  r.dispose()
})

await test('origin: cross-site refused; static page served without api gate', async () => {
  const { r } = rig()
  assert.equal((await hit(r, 'GET', '/api/reading/state', { headers: { origin: 'http://evil.example' } })).code, 403)
  assert.equal((await hit(r, 'POST', '/api/reading/keep-pref', { body: { keep: true }, headers: { 'sec-fetch-site': 'cross-site' } })).code, 403)
  assert.equal((await hit(r, 'POST', '/api/reading/keep-pref', { raw: Buffer.from('{"keep":true}'), type: 'text/plain' })).code, 415)
  const page = await hit(r, 'GET', '/reading/')
  assert.equal(page.code, 200); assert.ok(String(page.raw).includes('id="bubble"'))
  assert.equal((await hit(r, 'GET', '/reading/..%2F..%2Flib%2Fhost.js')).code, 403)
  assert.equal((await hit(r, 'GET', '/reading/..%5C..%5Clib%5Chost.js')).code, 403)
  assert.equal((await hit(r, 'GET', '/reading/vendor/pdfjs/build/pdf.min.mjs')).code, 200)
  r.dispose()
})

await test('PDF: upload stored by hash, served by id, no local path in any response', async () => {
  const { r, dataDir } = rig()
  const up = await hit(r, 'POST', '/api/reading/upload?name=' + encodeURIComponent('示例讲义.pdf'), { raw: PDF })
  assert.equal(up.code, 200)
  const doc = up.body.doc
  assert.match(doc.id, /^pdf-[0-9a-f]{16}$/); assert.equal(doc.kind, 'pdf'); assert.equal(doc.title, '示例讲义.pdf')
  assert.equal(doc.src, undefined)
  assert.ok(readdirSync(join(dataDir, 'reading', 'docs')).length === 1)
  const st = await hit(r, 'GET', '/api/reading/state')
  assert.ok(!deepStr(st.body).includes(dataDir) && !deepStr(st.body).includes('docs'))
  assert.equal(st.body.partner.name, '小鲸'); assert.equal(st.body.partner.avatar, '../api/thumb/character/whale-girl')
  const bad = await hit(r, 'POST', '/api/reading/upload?name=x.pdf', { raw: Buffer.from('not a pdf') })
  assert.equal(bad.code, 400)
  assert.equal((await hit(r, 'GET', '/api/reading/pdf?id=pdf-ffffffffffffffff')).code, 404)
  r.dispose()
})

await test('pick-file: explicit choice only; path opened by id, never echoed', async () => {
  const d = tmp('pp-pick-' + SECRET_DIR)
  const f = join(d, '自造示例.pdf'); writeFileSync(f, PDF)
  const { r } = rig({ pickFile: async () => f })
  const p = await hit(r, 'POST', '/api/reading/pick-file', { body: {} })
  assert.equal(p.body.doc.id, pdfId(f)); assert.ok(!deepStr(p.body).includes(SECRET_DIR))
  const r2 = rig({ pickFile: async () => '' }).r
  assert.equal((await hit(r2, 'POST', '/api/reading/pick-file', { body: {} })).body.doc, null)
  assert.equal((await hit(r, 'POST', '/api/reading/open-path', { body: { path: join(d, 'x.txt') } })).code, 400)
  r.dispose(); r2.dispose()
})

await test('web: fetched through the getter, html returned for the page; web PDF link becomes a doc', async () => {
  const getter = async (u) => u.pathname.endsWith('.pdf')
    ? { status: 200, headers: { 'content-type': 'application/pdf' }, body: PDF }
    : { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<html><head><title>示例页</title></head><body><article><p>自造正文</p></article><script>alert(1)</script></body></html>') }
  const { r } = rig({ getter })
  const w = await hit(r, 'GET', '/api/reading/fetch?url=' + encodeURIComponent('https://example.com/post'))
  assert.equal(w.code, 200); assert.equal(w.body.kind, 'web'); assert.ok(w.body.html.includes('自造正文')); assert.equal(w.body.doc.src, 'https://example.com/post')
  const p = await hit(r, 'GET', '/api/reading/fetch?url=' + encodeURIComponent('https://example.com/a/示例.pdf'))
  assert.equal(p.body.kind, 'pdf'); assert.equal(p.body.doc.src, undefined)
  assert.equal((await hit(r, 'GET', '/api/reading/fetch?url=' + encodeURIComponent('http://127.0.0.1:8088/state'))).code, 400)
  r.dispose()
})

const PICK = { docId: 'pdf-0123456789abcdef', kind: 'pdf', title: '示例讲义', src: 'D:\\' + SECRET_DIR + '\\a.pdf', text: '被选中的示例句子', before: '前'.repeat(900), after: '后'.repeat(900), page: 3 }

await test('prompt: selection + 200–400 chars each side + title/page, no local path', () => {
  const p = composePrompt(cleanPick(PICK), '这段什么意思？')
  assert.ok(p.includes('《示例讲义》第 3 页')); assert.ok(p.includes('被选中的示例句子')); assert.ok(p.includes('这段什么意思？'))
  const before = (/前文：…(前+)/.exec(p) || [])[1] || ''; const after = (/后文：(后+)/.exec(p) || [])[1] || ''
  assert.ok(before.length >= 200 && before.length <= 400, 'before ' + before.length)
  assert.ok(after.length >= 200 && after.length <= 400, 'after ' + after.length)
  assert.ok(!p.includes(SECRET_DIR))
  assert.ok(composePrompt(cleanPick(PICK), '问').includes('念出来'))
  assert.throws(() => cleanPick({ text: 'a' }), /没有选中/)
})

await test('ask: relayed to the bound session, answer back; typed AND voice both go out through the pet (speak + bubble)', async () => {
  const { r, asks, cmds } = rig()
  const a = await hit(r, 'POST', '/api/reading/ask', { body: { pick: PICK, question: '这段什么意思？' } })
  assert.equal(a.code, 200); assert.equal(a.body.ok, true); assert.equal(a.body.answer, '这段说的是示例。')
  assert.equal(asks.length, 1); assert.equal(asks[0].id, 'sess-1'); assert.ok(!asks[0].text.includes(SECRET_DIR))
  assert.equal(a.body.spoke, true)
  assert.deepEqual(cmds.filter((c) => c.cmd === 'say'), [{ cmd: 'say', text: '这段说的是示例。', speak: true }])
  const v = await hit(r, 'POST', '/api/reading/ask', { body: { pick: PICK, question: '说说看', voice: true } })
  assert.equal(v.body.spoke, true)
  assert.equal(cmds.filter((c) => c.cmd === 'say').length, 2)
  assert.ok(asks[1].text.includes('用户（说话）问：说说看'))
  // TTS refused -> bubble only
  const mute = rig({ sendCommand: async (b) => (b.cmd === 'say' && b.speak ? { ok: false, message: 'tts' } : { ok: true }) })
  const m = await hit(mute.r, 'POST', '/api/reading/ask', { body: { pick: PICK, question: 'q' } })
  assert.equal(m.body.ok, true); assert.equal(m.body.spoke, false)
  mute.r.dispose()
  const none = rig({ session: '' }).r
  assert.match((await hit(none, 'POST', '/api/reading/ask', { body: { pick: PICK, question: 'q' } })).body.message, /绑定会话/)
  const late = rig({ reply: '' }).r
  assert.equal((await hit(late, 'POST', '/api/reading/ask', { body: { pick: PICK, question: 'q' } })).body.ok, false)
  r.dispose(); none.dispose(); late.dispose()
})

await test('keep red line: nothing written unless 留存 is on; asking never writes', async () => {
  const { r, dataDir } = rig()
  const file = join(dataDir, 'reading', PICK.docId + '.json')
  await hit(r, 'POST', '/api/reading/ask', { body: { pick: PICK, question: 'q' } })
  assert.equal(existsSync(file), false)
  const off = await hit(r, 'POST', '/api/reading/kept/save', { body: { pick: PICK, turns: [{ asked: 'q', answer: 'a' }] } })
  assert.equal(off.code, 409); assert.equal(existsSync(file), false)
  assert.equal((await hit(r, 'POST', '/api/reading/keep-pref', { body: { keep: true } })).body.keep, true)
  const on = await hit(r, 'POST', '/api/reading/kept/save', { body: { pick: PICK, turns: [{ asked: 'q', answer: 'a' }] } })
  assert.equal(on.code, 200); assert.ok(existsSync(file))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(!JSON.stringify(saved).includes(SECRET_DIR), 'pdf src path not stored with the highlight')
  assert.equal(saved.highlights[0].turns[0].asked, 'q')
  const list = await hit(r, 'GET', '/api/reading/kept?id=' + PICK.docId)
  assert.equal(list.body.length, 1); assert.equal(list.body[0].page, 3)
  // remembers the last choice
  assert.equal(rig().r.state().keep, false)
  const again = createReading({ dataDir, settings: () => ({ reading: { enabled: true } }), relay: {} })
  assert.equal(again.state().keep, true); again.dispose()
  assert.equal((await hit(r, 'POST', '/api/reading/kept/delete', { body: { docId: PICK.docId, id: on.body.id } })).body.ok, true)
  r.dispose()
})

await test('导入旧留存已移除：路由不存在，也不去读任何旧目录', async () => {
  const { r } = rig()
  const res = await hit(r, 'POST', '/api/reading/import-legacy', { body: {} })
  assert.equal(res.code, 404)
  r.dispose()
})

await test('stt: wav only → transcribe hook; context poses the pet (throttled, not inside furniture)', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)])
  const { r, cmds } = rig({ transcribe: async (b) => ({ code: 200, body: { ok: true, text: '这是什么意思' } }) })
  assert.equal((await hit(r, 'POST', '/api/reading/stt', { raw: wav, type: 'audio/wav' })).body.text, '这是什么意思')
  assert.equal((await hit(r, 'POST', '/api/reading/stt', { raw: Buffer.from('nope'), type: 'text/plain' })).code, 415)
  const g = await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })
  assert.equal(g.body.pose, true)
  assert.deepEqual(cmds.find((c) => c.cmd === 'pose'), { cmd: 'pose', name: 'attentive', holdMs: 8000 })
  assert.equal((await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })).body.pose, false)
  const inside = rig({ sendCommand: async (b) => (b.cmd === 'status' ? { ok: true, data: { inside: 'nest' } } : { ok: true }) }).r
  assert.equal((await hit(inside, 'POST', '/api/reading/context', { body: { pick: PICK } })).body.pose, false)
  r.dispose(); inside.dispose()
})

await test('tool pixelpet_reading_now: when-gated, read-only, no local path', async () => {
  const d = tmp('pp-tool-' + SECRET_DIR)
  const f = join(d, '示例.pdf'); writeFileSync(f, PDF)
  const { r, st } = rig({ pickFile: async () => f })
  await hit(r, 'POST', '/api/reading/pick-file', { body: {} })
  await hit(r, 'POST', '/api/reading/context', { body: { pick: { ...PICK, docId: pdfId(f) } } })
  const { tools } = createReadingTools({ reading: r, settings: () => st })
  const [tool] = tools()
  assert.equal(tool.name, 'pixelpet_reading_now')
  assert.equal(tool.when({ reading: { enabled: true } }), true)
  assert.equal(tool.when({ reading: { enabled: false } }), false); assert.equal(tool.when({}), false)
  const out = await tool.execute({})
  assert.equal(out.ok, true)
  assert.equal(out.data.doc.title, '示例.pdf'); assert.equal(out.data.selection.text, '被选中的示例句子')
  assert.ok(!deepStr(out).includes(SECRET_DIR) && !deepStr(out).includes(d))
  st.reading.enabled = false
  assert.equal((await tool.execute({})).ok, false)
  r.dispose()
})

// ------------------------------------------------------------------ v2: context slot / translate / mic
const decorated = (r, sid, text) => r.decorate(sid, { content: [{ type: 'text', text }], commit () {} })
const noteOf = (d) => d.content.slice(1).map((b) => b.text).join('\n')

await test('context slot: full once, then a short pointer; own [一起看书] ask counts as sent; other tags / sessions untouched', async () => {
  const { r } = rig()
  assert.equal(decorated(r, 'sess-1', '这段什么意思').content.length, 1, 'no slot -> nothing added')
  await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })
  const d1 = decorated(r, 'session-sess-1', '这段什么意思')
  assert.equal(d1.content.length, 2)
  const full = noteOf(d1)
  assert.ok(full.includes('《示例讲义》第 3 页') && full.includes('被选中的示例句子') && full.includes('前文：…') && full.includes('后文：'))
  assert.ok(!full.includes(SECRET_DIR))
  // not committed (followup failed) -> still full next time; committed -> pointer only
  assert.equal(noteOf(decorated(r, 'sess-1', 'x')).includes('前文'), true)
  const d2 = decorated(r, 'sess-1', 'x'); d2.commit()
  const d3 = decorated(r, 'sess-1', '再说说')
  assert.equal(d3.content.length, 2); assert.ok(!noteOf(d3).includes('前文') && noteOf(d3).includes('被选中的示例'))
  // exactly one note per message
  assert.equal(d3.content.filter((b) => /一起看书/.test(b.text)).length, 1)
  // a new selection is attached in full again
  await hit(r, 'POST', '/api/reading/context', { body: { pick: { ...PICK, text: '另一段示例文字' } } })
  assert.ok(noteOf(decorated(r, 'sess-1', 'x')).includes('前文'))
  // the reading card's own prompt already carries it: nothing appended, but it counts as sent
  const own = decorated(r, 'sess-1', '[一起看书] 用户在阅读窗里读…'); assert.equal(own.content.length, 1); own.commit()
  assert.ok(!noteOf(decorated(r, 'sess-1', 'x')).includes('前文'))
  for (const t of ['[桌宠信箱] 用户在信箱里给你写了一封信', '[一起听歌] 用户在桌宠的听歌小卡片里对你说：']) assert.equal(decorated(r, 'sess-1', t).content.length, 1, t)
  assert.equal(decorated(r, 'other-session', 'x').content.length, 1)
  r.dispose()
})

await test('context slot: TTL ~10 min, clear route, doc change, switched off, never on disk', async () => {
  const dataDir = tmp('pp-ctx-')
  let t = 1_000_000
  const st = { reading: { enabled: true }, voice: { llm: { sessionId: 's' } } }
  const r = createReading({ dataDir, settings: () => st, relay: {}, clock: () => t, sendCommand: async () => ({ ok: false, running: false }) })
  const set = await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })
  assert.equal(set.body.ttlMs, 600_000)
  t += 9 * 60_000; assert.ok(r.context(), 'alive at 9 min')
  await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })      // refreshed while the selection is still there
  t += 9 * 60_000; assert.ok(r.context())
  t += 2 * 60_000; assert.equal(r.context(), null, 'expired after 10 min idle'); assert.equal(decorated(r, 's', 'x').content.length, 1)
  await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })
  assert.equal((await hit(r, 'POST', '/api/reading/context', { body: { clear: true } })).body.cleared, true)
  assert.equal(r.context(), null)
  // another document becomes current -> the old selection no longer counts
  const up = await hit(r, 'POST', '/api/reading/upload?name=a.pdf', { raw: PDF })
  await hit(r, 'POST', '/api/reading/context', { body: { pick: PICK } })
  await hit(r, 'POST', '/api/reading/status', { body: { id: up.body.doc.id, page: 1 } })
  assert.equal(r.context(), null)
  await hit(r, 'POST', '/api/reading/context', { body: { pick: { ...PICK, docId: up.body.doc.id } } })
  st.reading.enabled = false
  assert.equal(r.context(), null); assert.equal(decorated(r, 's', 'x').content.length, 1)
  st.reading.enabled = true
  // memory only: no file under the data dir carries the selection
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
  for (const f of walk(dataDir)) assert.ok(!readFileSync(f).toString('utf8').includes('被选中的示例句子'), f)
  r.dispose()
})

await test('no translate action: asking for a translation is just a normal question', async () => {
  const { r, asks, cmds } = rig()
  const a = await hit(r, 'POST', '/api/reading/ask', { body: { pick: PICK, question: '这句是什么意思', mode: 'translate' } })
  assert.equal(a.body.ok, true); assert.equal(a.body.spoke, true)
  assert.ok(asks[0].text.includes('这句是什么意思') && !asks[0].text.includes('请你帮忙翻译'), 'a stray mode is ignored')
  assert.ok(cmds.some((c) => c.cmd === 'say' && c.speak))
  assert.equal((await hit(r, 'POST', '/api/reading/ask', { body: { pick: PICK, mode: 'translate' } })).body.ok, false, 'no question, no ask')
  assert.equal(asks.length, 1)
  r.dispose()
})

await test('mic: reading window recording holds the pet listener; busy when the pet is capturing; no pet = free', async () => {
  const seen = []
  const busy = { v: false }
  const { r } = rig({ sendCommand: async (b) => { seen.push(b); return b.cmd === 'reading' ? { ok: true, data: { busy: busy.v } } : { ok: true } } })
  assert.deepEqual((await hit(r, 'POST', '/api/reading/mic', { body: { on: true } })).body, { ok: true, busy: false, pet: true })
  assert.deepEqual(seen.at(-1), { cmd: 'reading', op: 'mic', on: true })
  await hit(r, 'POST', '/api/reading/mic', { body: { on: false } })
  assert.deepEqual(seen.at(-1), { cmd: 'reading', op: 'mic', on: false })
  busy.v = true
  assert.equal((await hit(r, 'POST', '/api/reading/mic', { body: { on: true } })).body.busy, true)
  const lone = rig({ sendCommand: async () => ({ ok: false, running: false }) }).r
  assert.deepEqual((await hit(lone, 'POST', '/api/reading/mic', { body: { on: true } })).body, { ok: true, busy: false, pet: false })
  r.dispose(); lone.dispose()
})

await test('page: mic result is sent right away (unless 先确认再发), no translate button, context set/cleared', () => {
  const src = readFileSync(new URL('../web/reading/app.js', import.meta.url), 'utf8')
  assert.match(src, /if \(voiceConfirm\) \{[^\n]*return \}\n\s*go\(\{ question: text, voice: true \}\)/)
  assert.match(src, /api\('mic', \{ body: \{ on: true \} \}\)/); assert.match(src, /api\('mic', \{ body: \{ on: false \} \}\)/)
  assert.ok(!src.includes("'translate'") && !src.includes('bubbleTr'), 'no translate mode left in the page')
  assert.match(src, /api\('context', \{ body: \{ pick: sel \} \}\)/); assert.match(src, /api\('context', \{ body: \{ clear: true \} \}\)/)
  const html = readFileSync(new URL('../web/reading/index.html', import.meta.url), 'utf8')
  assert.ok(!html.includes('bubbleTr') && !html.includes('翻译'), 'the selection bubble has only 「和 ta 聊」')
  for (const f of ['../web/reading/app.js', '../lib/reading.js']) assert.ok(!readFileSync(new URL(f, import.meta.url), 'utf8').includes('composeTranslate'), f)
})

// ------------------------------------------------------------------ host wiring
function fakeTools () {
  const reg = new Map()
  return { reg, register (def) { if (reg.has(def.name)) throw new Error('dup'); reg.set(def.name, def); return () => { if (reg.get(def.name) === def) reg.delete(def.name) } } }
}
function fakeCtx () {
  let route = null; const tools = fakeTools()
  const services = { webServer: { register (r) { route = r; return () => {} } }, sessions: { list: () => [] }, sessionTitle: { get: () => ({ title: '' }) }, tools }
  const effects = []
  const handlers = {}
  const emit = (...a) => { if (handlers['session/event']) handlers['session/event'](...a) }
  let turnNo = 0
  // the bound session: records every followup and answers like DSH does (turn/start → user/message → assistant → turn/end)
  const agent = { calls: [], async followup (msg) { this.calls.push(msg); setTimeout(() => {
    const turn = ++turnNo
    emit({ id: 'session-s1' }, { type: 'turn/start', data: { turn } })
    emit({ id: 'session-s1' }, { type: 'user/message', data: msg })
    emit({ id: 'session-s1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } })
    emit({ id: 'session-s1' }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }, 5) } }
  const ctx = { logger: { warn () {}, info () {} }, get: (k) => services[k], agents: { get: (id) => (id === 'session-s1' ? agent : undefined) }, on: (ev, fn) => { handlers[ev] = fn; return () => {} }, effect: (fn) => { effects.push(fn()) } }
  return { ctx, tools, effects, agent, get route () { return route } }
}
async function call (route, method, path, { body, headers = {} } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path; req.headers = { host: '127.0.0.1:3080', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }
  let status = 0; let out = Buffer.alloc(0)
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = Buffer.from(b) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : JSON.stringify(body))
  await p
  let json = null; try { json = JSON.parse(out.toString('utf8')) } catch {}
  return { status, json, raw: out }
}

await test('host: settings key, tool registered only while on, routes mounted, host spawns the window when no pet', async () => {
  const dataDir = tmp('pp-rhost-')
  const py = join(dataDir, 'python.exe'); writeFileSync(py, '')
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ autoStart: false, listen: { python: py } }))
  const spawned = []
  const readingSpawn = (cmd, args, opts) => { const c = new EventEmitter(); c.exitCode = null; c.kill = () => { c.killed = true; c.emit('exit', 0) }; spawned.push({ cmd, args, opts, c }); return c }
  const f = fakeCtx()
  H.apply(f.ctx, { dataDir, autoInstall: false, readingSpawn })
  assert.equal(f.tools.reg.has('pixelpet_reading_now'), false)
  assert.equal((await call(f.route, 'GET', '/api/reading/state')).json.enabled, false)
  assert.equal((await call(f.route, 'POST', '/api/reading/open', { body: {} })).status, 409)
  const s = await call(f.route, 'POST', '/api/settings', { body: { reading: { enabled: true } } })
  assert.equal(s.json.settings.reading.enabled, true)
  assert.equal(f.tools.reg.has('pixelpet_reading_now'), true)
  const page = await call(f.route, 'GET', '/reading/')
  assert.equal(page.status, 200)
  // a wrong pet key is refused; no key + same origin opens the window from the host (pet not running)
  assert.equal((await call(f.route, 'POST', '/api/reading/open', { body: {}, headers: { 'x-pixelpet-key': 'nope' } })).status, 401)
  const o = await call(f.route, 'POST', '/api/reading/open', { body: { source: 'furniture', furnitureId: 'bookshelf' } })
  assert.equal(o.status, 200); assert.equal(o.json.ok, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cmd, py)
  assert.deepEqual(spawned[0].args.slice(0, 5), ['-X', 'utf8', '-m', 'pixelpet.reading_win', '--url'])
  assert.equal(spawned[0].args[5], 'http://127.0.0.1:3080/dsh-pixel-pet/reading/')
  assert.ok(spawned[0].args.includes('--parent'))
  assert.ok(String(spawned[0].opts.cwd).replace(/\\/g, '/').endsWith('/runtime'))
  await call(f.route, 'POST', '/api/reading/open', { body: {} })
  assert.equal(spawned.length, 1, 'already open: no second process')
  // switching off stops the host-owned window and hides the tool
  await call(f.route, 'POST', '/api/settings', { body: { reading: { enabled: false } } })
  assert.equal(f.tools.reg.has('pixelpet_reading_now'), false)
  assert.equal((await call(f.route, 'POST', '/api/reading/ask', { body: {} })).status, 409)
  assert.equal(spawned[0].c.killed, true)
  for (const e of f.effects) if (typeof e === 'function') { try { e() } catch {} }
})

await test('host: hub text and hub voice (both /api/ask/start from the pet) carry the reading context; reading card ask not doubled', async () => {
  const dataDir = tmp('pp-rhub-')
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ autoStart: false, python: 'py-test', aiControl: false, reading: { enabled: true }, voice: { llm: { sessionId: 'session-s1' } } }))
  const kids = []
  const spawn = (py, args, opts) => { const k = new EventEmitter(); k.stderr = new EventEmitter(); k.exitCode = null; k.kill = () => { k.exitCode = 0 }; k.opts = opts; kids.push(k); return k }
  const f = fakeCtx()
  H.apply(f.ctx, { dataDir, autoInstall: false, spawn })
  assert.equal((await call(f.route, 'POST', '/api/pet/start', { body: {} })).json.running, true)
  const key = kids[0].opts.env.PIXELPET_BRIDGE_KEY
  const start = (text, n) => call(f.route, 'POST', '/api/ask/start', { body: { text, requestId: 'req-reading-' + n }, headers: { 'x-pixelpet-key': key } })
  const sent = () => f.agent.calls.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text)
  // no selection yet: the hub message goes out as is
  await start('今天读到哪了', 1); await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(sent(), ['今天读到哪了'])
  // the reading window has a selection -> typed in the input bar
  assert.equal((await call(f.route, 'POST', '/api/reading/context', { body: { pick: PICK } })).status, 200)
  await start('这段什么意思', 2); await new Promise((r) => setTimeout(r, 30))
  let t = sent()
  assert.equal(t[0], '这段什么意思'); assert.equal(t.length, 2)
  assert.ok(t[1].includes('被选中的示例句子') && t[1].includes('《示例讲义》第 3 页') && t[1].includes('前文：…'))
  // said into the input bar's mic (the pet transcribes, then sends the same way): pointer, not the whole passage again
  await start('那下一句呢', 3); await new Promise((r) => setTimeout(r, 30))
  t = sent()
  assert.equal(t.length, 2); assert.ok(t[1].includes('被选中的示例') && !t[1].includes('前文'))
  // the reading card's own question: carries the passage itself, nothing appended
  const a = await call(f.route, 'POST', '/api/reading/ask', { body: { pick: { ...PICK, text: '再划一段示例' }, question: '为什么' } })
  assert.equal(a.json.ok, true); assert.equal(a.json.answer, '在的')
  t = sent(); assert.equal(t.length, 1); assert.ok(t[0].startsWith('[一起看书]') && t[0].includes('再划一段示例'))
  // cleared -> nothing attached
  await call(f.route, 'POST', '/api/reading/context', { body: { clear: true } })
  await start('随便聊聊', 4); await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(sent(), ['随便聊聊'])
  for (const e of f.effects) if (typeof e === 'function') { try { e() } catch {} }
})

await test('source has no hardcoded machine paths', () => {
  for (const f of ['../lib/reading.js', '../lib/reading-tools.js', '../runtime/pixelpet/reading_dock.py', '../runtime/pixelpet/reading_win.py', '../web/reading/app.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!/(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}(?:Users|[A-Za-z]*Workspace)|[\w-]+-music[\\/]+venv/.test(src), f + ' 里不许有本机路径')
  }
})

console.log(`${n} passed`)
process.exit(0)
