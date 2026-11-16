// Mail attachments: validation, copy-on-send, rollback, purge, HTTP headers/CSP, Agently --attachment.
// Run from host.test.mjs. All files are synthetic; nothing is ever sent anywhere.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailService } from '../lib/mail.js'
import { AgentlyBackend } from '../lib/mail-backend.js'
import * as MF from '../lib/mail-files.js'

const EMAIL = 'u' + String.fromCharCode(64) + 'example.invalid'   // no literal address in the repo
const tmp = (p) => mkdtempSync(join(tmpdir(), 'pp-mattach-' + p + '-'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>')
const HTML = Buffer.from('<!doctype html><html><body><h1>贺卡</h1><img src="a.png"><script>document.title="x"</script></body></html>')

export async function runMailAttachTests ({ t, H, fakeCtx, call }) {
  const files = tmp('src')
  const put = (name, buf) => { const p = join(files, name); writeFileSync(p, buf); return p }
  const png = put('card.png', PNG)
  const pdf = put('note.pdf', PDF)
  const svg = put('badge.svg', SVG)
  const html = put('card.html', HTML)
  const htmlRef = put('a.png', PNG)

  // ------------------------------------------------------------------ pure validation
  await t('attachments: whitelist, magic-vs-extension, 10 MB, 6 per letter, duplicates, no symlink', () => {
    const txt = put('note.txt', Buffer.from('hello'))
    const fake = put('lies.png', Buffer.from('I am not a png'))
    const big = put('big.pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))
    const empty = put('empty.png', Buffer.alloc(0))
    assert.deepEqual(MF.planAttachments([png, pdf, svg, html]).errors, [])
    assert.equal(MF.planAttachments([png, pdf, svg, html]).files.length, 4)
    assert.match(MF.planAttachments([txt]).errors[0], /不支持/)
    assert.match(MF.planAttachments([fake]).errors[0], /不一致/)
    assert.match(MF.planAttachments([big]).errors[0], /太大/)
    assert.match(MF.planAttachments([empty]).errors[0], /空文件|不一致/)
    assert.match(MF.planAttachments([join(files, 'missing.png')]).errors[0], /不存在/)
    assert.match(MF.planAttachments([png, pdf, svg, html, pdf, png, pdf]).errors[0], /最多/)
    assert.match(MF.planAttachments([png, png, png, png, png, png, png]).errors[0], /最多/)
    assert.match(MF.planAttachments('card.png').errors[0], /数组/)
    assert.deepEqual(MF.planAttachments([png, png, pdf]).files.map((f) => f.kind), ['image', 'pdf']) // same path twice = one
    assert.deepEqual(MF.planAttachments(null), { files: [], errors: [] })
    // names are made safe and never carry a directory
    assert.equal(MF.safeFileName('../../etc/passwd'), 'passwd')
    assert.equal(MF.safeFileName('a"b\u0001.png'), 'a_b_.png')
    assert.equal(MF.safeFileName('...'), 'file')
    assert.equal(MF.safeFileName('', '.png'), 'file.png')
    const disp = MF.disposition('x"; evil\r\n.png')
    assert.match(disp, /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/)
    assert.equal(/[\r\n]/.test(disp), false, 'no header injection')
    assert.equal(MF.disposition('x.png').includes('"x.png"'), true)
    assert.match(MF.disposition('贺卡.html', true), /^inline;/)
    // staging writes nothing into the letter tree until commit
    const md = tmp('stage')
    const st = MF.stageAttachments(md, MF.planAttachments([png, pdf]).files)
    assert.ok(st.dir.startsWith(join(md, '.staging-')))
    assert.equal(readdirSync(st.dir).length, 2)
    assert.equal(existsSync(join(md, 'files')), false)
    const done = MF.commitAttachments(md, st, 'o-abc123')
    assert.deepEqual(done.map((f) => f.name), ['card.png', 'note.pdf'])
    assert.equal(existsSync(st.dir), false)
    assert.equal(readFileSync(join(md, 'files', 'o-abc123', 'card.png')).length, PNG.length)
    assert.deepEqual(Object.keys(done[0]).sort(), ['filename', 'id', 'kind', 'mime', 'name', 'size'])
    MF.dropStaging({ dir: st.dir })
  })

  // ------------------------------------------------------------------ service
  await t('sendOut: copies into mailbox/files/<id>, source untouched, idempotent key, dedupe', async () => {
    const d = tmp('svc')
    const mail = new MailService({ dataDir: d, relay: { ask: async () => ({ code: 200, body: { ok: true, reply: '嗯' } }) }, settings: () => ({}) })
    const r = await mail.sendOut({ subject: '看图', body: '给你画了张图', attachments: [png] })
    assert.equal(r.item.attachments.length, 1)
    const a = r.item.attachments[0]
    assert.deepEqual([a.filename, a.kind, a.size], ['card.png', 'image', PNG.length])
    assert.equal(JSON.stringify(r.item).includes(files), false, 'no host path on the letter')
    const copied = join(d, 'mailbox', 'files', r.item.id, 'card.png')
    assert.equal(readFileSync(copied).length, PNG.length)
    assert.equal(existsSync(png), true, 'the source file stays')
    // deleting the source later does not break the letter
    writeFileSync(join(files, 'temp.png'), PNG)
    const r2 = await mail.sendOut({ body: '临时', attachments: [join(files, 'temp.png')] })
    assert.ok(r2.item.attachments.length === 1)
    // idempotent: same key -> the same letter, no second copy
    const again = await mail.sendOut({ subject: '看图', body: 'duplicate', key: 'k1' })
    const dup = await mail.sendOut({ subject: '看图', body: 'duplicate', key: 'k1', attachments: [pdf] })
    assert.equal(dup.duplicate, true); assert.equal(dup.item.id, again.item.id)
    assert.equal(dup.item.attachments, undefined)
    assert.equal(readdirSync(join(d, 'mailbox')).filter((n) => n.startsWith('.staging-')).length, 0)
    assert.equal(mail.attachmentPaths(r.item).length, 1)
    // an attachment of a letter never resolves for a made-up id
    assert.equal(MF.findAttachment(join(d, 'mailbox'), r.item, 'a9'), null)
  })

  await t('sendOut rollback: an empty body or a blocked copy leaves no half letter and no staging folder', async () => {
    const d = tmp('fail')
    const mail = new MailService({ dataDir: d, relay: { ask: async () => ({}) }, settings: () => ({}) })
    await assert.rejects(() => mail.sendOut({ body: '   ', attachments: [png] }), /body/)
    assert.equal(mail.store.stats().total, 0)
    assert.equal(readdirSync(join(d, 'mailbox')).filter((n) => n.startsWith('.staging-')).length, 0)
    // a plain file where the files/ folder should be makes the commit fail
    mkdirSync(join(d, 'mailbox'), { recursive: true })
    writeFileSync(join(d, 'mailbox', 'files'), 'blocked')
    await assert.rejects(() => mail.sendOut({ body: '有附件', attachments: [png] }), /附件/)
    assert.equal(mail.store.stats().total, 0, 'the half-made letter was taken back')
    assert.equal(readdirSync(join(d, 'mailbox')).filter((n) => n.startsWith('.staging-')).length, 0)
  })

  await t('purge follows the star rule: delete / clear only remove their own files', async () => {
    const d = tmp('purge')
    const mail = new MailService({ dataDir: d, relay: { ask: async () => ({}) }, settings: () => ({}) })
    const a = (await mail.sendOut({ body: '甲', attachments: [png] })).item
    const b = (await mail.sendOut({ body: '乙', attachments: [pdf] })).item
    const c = (await mail.sendOut({ body: '丙', attachments: [svg] })).item
    mail.manage('star', { id: b.id, on: true })
    const del = mail.manage('delete', { ids: [a.id] })
    assert.equal(del.changed, 1)
    assert.equal(existsSync(join(d, 'mailbox', 'files', a.id)), false)
    assert.equal(existsSync(join(d, 'mailbox', 'files', b.id)), true)
    const cleared = mail.manage('clear', { keepStarred: true })
    assert.equal(cleared.changed, 1) // only c
    assert.equal(existsSync(join(d, 'mailbox', 'files', c.id)), false)
    assert.equal(existsSync(join(d, 'mailbox', 'files', b.id)), true, 'a starred letter keeps its attachments')
    assert.equal(mail.store.get(b.id).starred, true)
    // clear(keepStarred:false) does remove the starred letter's files too
    mail.manage('clear', { keepStarred: false })
    assert.equal(existsSync(join(d, 'mailbox', 'files', b.id)), false)
  })

  // ------------------------------------------------------------------ routes + headers
  const data = tmp('routes')
  const opened = []
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: data, openFile: (p) => { opened.push(p); return true } })
  const route = g.route
  const store = []

  await t('route: bytes only for a stored letter+attachment, with sandbox/CSP/no-sniff headers', async () => {
    // seed through the tool so the letter looks exactly like production
    const tool = [...g.tools.reg.values()].find((x) => x.name === 'pixelpet_mail_send')
    const res = await tool.execute({ subject: '贺卡', body: '生日快乐', attachments: [html, png, pdf] })
    assert.equal(res.ok, true)
    const letter = JSON.parse(readFileSync(join(data, 'mailbox', 'inbox.json'), 'utf8')).items.find((x) => x.dir === 'out')
    store.push(letter)
    const byKind = (k) => letter.attachments.find((a) => a.kind === k)
    const r = await call(route, 'GET', '/api/mail/file/' + letter.id + '/' + byKind('image').id)
    assert.equal(r.status, 200)
    assert.equal(r.raw.length, PNG.length)
    const h = (await call(route, 'GET', '/api/mail/file/' + letter.id + '/' + byKind('html').id)).raw.toString()
    assert.match(h, /贺卡/)
    // headers are what keep the card harmless: sandboxed + no network + no sniff + no inline execution outside
    const head = await new Promise((ok) => {
      const req = new EventEmitter(); req.method = 'GET'; req.url = '/dsh-pixel-pet/api/mail/file/' + letter.id + '/' + byKind('html').id
      req.headers = { host: '127.0.0.1:3080' }; req.on = () => {}; req.end = () => {}
      const res2 = { writeHead (code, headers) { ok({ code, headers }) }, end () {}, setHeader () {} }
      const p2 = route.handler(req, res2); req.end(); return p2
    })
    assert.equal(head.code, 200)
    assert.match(head.headers['Content-Security-Policy'], /sandbox allow-scripts/)
    assert.match(head.headers['Content-Security-Policy'], /default-src 'none'/)
    assert.match(head.headers['Content-Security-Policy'], /connect-src 'none'/)
    assert.equal(head.headers['X-Content-Type-Options'], 'nosniff')
    assert.match(head.headers['Content-Disposition'], /^inline;/)
    const dl = await new Promise((ok) => {
      const req = new EventEmitter(); req.method = 'GET'; req.url = '/dsh-pixel-pet/api/mail/file/' + letter.id + '/' + byKind('html').id + '?dl=1'
      req.headers = { host: '127.0.0.1:3080' }; req.on = () => {}; req.end = () => {}
      const res2 = { writeHead (code, headers) { ok({ code, headers }) }, end () {} }
      return route.handler(req, res2).then(() => { req.end() })
    })
    assert.match(dl.headers['Content-Disposition'], /^attachment;/)
    assert.equal(dl.headers['Content-Type'], 'application/octet-stream')
    // wrong / foreign ids resolve to nothing
    assert.equal((await call(route, 'GET', '/api/mail/file/' + letter.id + '/a99')).status, 404)
    assert.equal((await call(route, 'GET', '/api/mail/file/o-nope/a1')).status, 404)
    assert.equal((await call(route, 'GET', '/api/mail/file/' + letter.id + '/..%2F..%2Finbox.json')).status, 404)
    // the list never leaks a host path or the private html source
    const list = await call(route, 'GET', '/api/mail')
    assert.equal(list.raw.toString().includes(data), false)
    assert.equal(list.raw.toString().includes('<h1>'), false)
    assert.deepEqual(list.json.items[0].attachments.map((a) => a.kind).sort(), ['html', 'image', 'pdf'])
  })

  await t('route: system open only for a copied pdf, on an explicit click, never for html/svg', async () => {
    const letter = store[0]
    const byKind = (k) => letter.attachments.find((a) => a.kind === k)
    assert.equal((await call(route, 'POST', '/api/mail/open', { body: { id: letter.id, att: byKind('html').id } })).status, 400)
    assert.equal((await call(route, 'POST', '/api/mail/open', { body: { id: letter.id, att: byKind('image').id } })).status, 400)
    assert.equal((await call(route, 'POST', '/api/mail/open', { body: { id: letter.id, att: 'a99' } })).status, 404)
    assert.equal((await call(route, 'POST', '/api/mail/open', { body: { id: 'o-nope', att: 'a1' } })).status, 404)
    const ok = await call(route, 'POST', '/api/mail/open', { body: { id: letter.id, att: byKind('pdf').id } })
    assert.equal(ok.json.ok, true)
    assert.equal(opened.length, 1)
    assert.equal(opened[0], join(data, 'mailbox', 'files', letter.id, 'note.pdf'))
    assert.ok(opened[0].startsWith(join(data, 'mailbox', 'files')))
  })

  // ------------------------------------------------------------------ agently
  await t('mirrorOut: --attachment for every copied file; an HTML card needs a real screenshot', async () => {
    const d = tmp('ag')
    const settings = () => ({ mail: { agently: { enabled: true, consentAt: 'now', to: EMAIL, command: 'agently' } }, furniture: {} })
    const shot = join(tmp('shot'), 'card.png')
    writeFileSync(shot, PNG)
    let cleaned = 0
    const seen = []
    const mail = new MailService({
      dataDir: d, relay: { ask: async () => ({}) }, settings,
      snapshot: async ({ html: h, files: fs }) => { assert.ok(h.endsWith('card.html')); assert.ok(fs.some((f) => f.kind === 'image')); return { path: shot, cleanup: () => { cleaned++ } } },
    })
    mail.agently = { send: async (to, subj, body, atts) => { seen.push({ to, subj, atts }); return { ref: 'r1' } } }
    const r = await mail.sendOut({ subject: '贺卡', body: '看这个', attachments: [html, png] })
    assert.deepEqual(r.ext.ok, true)
    assert.equal(r.ext.screenshot, true)
    const atts = seen[0].atts
    assert.equal(atts.length, 3, 'html + image + screenshot')
    assert.ok(atts.every((p) => p.startsWith(join(d, 'mailbox', 'files')) || p === shot))
    assert.equal(cleaned, 1, 'the screenshot is temporary')
    // no renderer -> nothing is claimed and nothing is sent
    const d2 = tmp('ag2')
    const seen2 = []
    const mail2 = new MailService({ dataDir: d2, relay: { ask: async () => ({}) }, settings, snapshot: async () => null })
    mail2.agently = { send: async () => { seen2.push(1); return { ref: 'x' } } }
    const r2 = await mail2.sendOut({ body: '贺卡', attachments: [html] })
    assert.equal(r2.ext.ok, false); assert.equal(r2.ext.code, 'screenshot')
    assert.equal(seen2.length, 0, 'no mail without the picture')
    assert.equal(mail2.store.stats().total, 1, 'the letter itself still exists locally')
    // a plain picture letter needs no screenshot
    const mail3 = new MailService({ dataDir: d2, relay: { ask: async () => ({}) }, settings, snapshot: async () => { throw new Error('not used') } })
    mail3.agently = { send: async (to, s, b, a) => { seen2.push(a.length); return { ref: 'y' } } }
    const r3 = await mail3.sendOut({ body: '图', attachments: [png] })
    assert.deepEqual([r3.ext.ok, seen2.at(-1)], [true, 1])
  })

  await t('AgentlyBackend: attachments are copied into the work dir and passed as --attachment args (no shell string)', async () => {
    const calls = []
    const spawnImpl = (cmd, args, opts) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
      const bare = args.map((a) => a.replace(/^"|"$/g, ''))
      calls.push({ cmd, args, opts, present: bare.filter((a) => a.startsWith('att-')).map((a) => existsSync(join(work, a))) })
      setTimeout(() => { child.stdout.emit('data', Buffer.from('{"message_id":"m1"}\n')); child.emit('close', 0) }, 5)
      return child
    }
    const work = tmp('agwork')
    const be = new AgentlyBackend({ workDir: work, command: 'agently-cli', consent: () => true, spawnImpl, now: () => Date.now() })
    const r = await be.send(EMAIL, 's', 'b', [png, pdf])
    assert.equal(r.ref, 'm1')
    // on Windows the command goes through cmd.exe, so every argument is quoted — compare the unquoted form
    const args = calls[0].args.map((a) => a.replace(/^"|"$/g, ''))
    assert.equal(args.filter((a) => a === '--attachment').length, 2)
    assert.ok(args.includes('--body-file'))
    assert.equal(args.at(-1), '--confirmed')
    const atts = args.filter((x, i) => args[i - 1] === '--attachment')
    assert.equal(atts.length, 2)
    assert.ok(calls[0].present.every(Boolean), 'copied into the work dir while the CLI runs')
    for (const a of atts) assert.equal(/[\\/]/.test(a), false, 'a bare file name, the CLI takes relative paths')
    assert.equal(args.filter((x) => /attachment/.test(x)).some((x) => /\s/.test(x)), false, 'no argument quoting games')
    // the temporary copies are cleaned up afterwards
    assert.deepEqual(readdirSync(work).filter((n) => n.startsWith('att-')), [])
    assert.equal(existsSync(png), true)
  })

  for (const e of g.effects) if (typeof e === 'function') e()
}
