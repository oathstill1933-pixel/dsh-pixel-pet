// node scripts/mail-rework.test.mjs — AI likes, bubble sides, partnerName, hidden gift hint (2026-11-14 mailbox rework)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InboxStore } from '../lib/inbox.js'
import * as H from '../lib/host.js'
import * as T from '../lib/tools.js'
import * as P from '../lib/prompt.js'
import { contentMatches } from '../lib/mail-files.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
let pass = 0; let fail = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name) } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)) } }

await t('like persists across a reload and toggles off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-like-'))
  const s = new InboxStore(dir)
  const { item } = s.addIn({ body: 'hi' })
  assert.equal(s.like(item.id, true).liked, true)
  assert.equal(new InboxStore(dir).get(item.id).liked, true)            // on disk
  assert.equal(JSON.parse(readFileSync(join(dir, 'inbox.json'), 'utf8')).items[0].liked, true)
  assert.equal(s.like(item.id, false).liked, undefined)
  assert.equal(new InboxStore(dir).get(item.id).liked, undefined)
  assert.equal(s.like('nope', true), null)
  assert.equal(s.get(item.id).starred, undefined)                         // separate from the user's heart
})

await t('pixelpet_mail_like tool likes / unlikes; mail_list reports liked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-like-tool-'))
  const store = new InboxStore(dir)
  const { item } = store.addIn({ body: 'a letter I like' })
  const tools = T.makeTools({ dataDir: dir, enabled: () => true, mail: { store } })
  const like = tools.find((x) => x.name === 'pixelpet_mail_like')
  assert.ok(like)
  assert.deepEqual((await like.execute({ id: item.id })).data, { id: item.id, liked: true })
  const list = await tools.find((x) => x.name === 'pixelpet_mail_list').execute({})
  assert.equal(list.data.messages[0].liked, true)
  assert.equal((await like.execute({ id: item.id, on: false })).data.liked, false)
  assert.equal((await like.execute({ id: 'x-none' })).ok, false)
  assert.equal((await like.execute({})).ok, false)
})

await t('bubble sides: user note left, AI letter right', () => {
  const js = read('web/mailbox.js'); const css = read('web/mailbox.css')
  assert.match(js, /'letter from-ai'/)
  assert.match(js, /'note from-user'/)
  assert.match(css, /\.note \{[^}]*align-items: flex-start/)
  assert.match(css, /\.letter \{[^}]*margin: 0 0 14px 40px/)
  // likeMark takes the reaction since multi-reaction likes (2026-11-14): heart / happy / hug / sad / ...
  assert.match(js, /it\.liked\) side\.append\(likeMark\(it\.reaction\)\)/)
  assert.match(js, /it\.liked\) b\.append\(likeMark\(it\.reaction\)\)/)
})

await t('mailbox title: owner name + domain from the API', () => {
  const html = read('web/mailbox.html'); const js = read('web/mailbox.js')
  assert.match(html, /id="owner"/); assert.match(html, /id="domain" hidden/)
  assert.match(js, /o\.name \+ '的'/)
  assert.equal(H.mailDomainOf({ mail: { agently: { address: 'pet' + String.fromCharCode(64) + 'mail.example.org' } } }), 'mail.example.org')
  assert.equal(H.mailDomainOf({ mail: { agently: { address: '' } } }), '')
  assert.equal(H.mailDomainOf({}), '')
})

await t('partnerName: sanitized setting, falls back to the character name', () => {
  const chars = [{ id: 'whale-girl', name: '鲸鱼' }, { id: 'cat', name: '猫猫' }]
  assert.equal(H.partnerNameOf({ partnerName: '', character: 'cat' }, chars), '猫猫')
  assert.equal(H.partnerNameOf({ partnerName: '   ', character: 'cat' }, chars), '猫猫')
  assert.equal(H.partnerNameOf({ character: 'missing' }, chars), '鲸鱼')
  assert.equal(H.partnerNameOf({ partnerName: '小p', character: 'cat' }, chars), '小p')
  assert.equal(H.partnerNameOf({}, []), '')
  assert.equal(H.mergeSettings({}, {}).partnerName, '')
  assert.equal(H.mergeSettings({}, { partnerName: ' <b>阿p</b>\n ' }).partnerName, 'b阿p/b')
  assert.equal(H.mergeSettings({}, { partnerName: 'x'.repeat(80) }).partnerName.length, H.PARTNER_NAME_MAX)
  assert.equal(H.mergeSettings({ partnerName: 'keep' }, { partnerName: 42 }).partnerName, 'keep')
  assert.ok(H.SETTINGS_KEYS.includes('partnerName'))
  assert.match(read('web/index.html'), /<input id="partnerName"/) // settings layout reworked 2026-11-15; only presence matters
})

// The rule changed: partnerName (+ addressAs) now opens the prompt as one identity line
// (lib/prompt.js identityLine). Tool descriptions and mail still never carry it.
await t('partnerName: only in the identity line at the top of the prompt, never in tools or mail', () => {
  const name = '独一无二的名字ZQX'
  const s = H.mergeSettings({}, { partnerName: name })
  assert.equal(s.partnerName, name)
  assert.ok(P.effectivePrompt(s).startsWith(P.identityLine(s)) && P.identityLine(s).includes('「' + name + '」'))
  assert.equal(P.identityLine(H.mergeSettings({}, {})), '', 'no name, no identity line')
  assert.ok(!P.effectivePrompt(H.mergeSettings({}, {})).includes('你叫「'))
  const tools = T.makeTools({ dataDir: '.', enabled: () => true, mail: {} })
  assert.ok(!JSON.stringify(tools.map((x) => [x.description, x.parameters])).includes(name))
  for (const f of ['lib/tools.js', 'lib/mail.js']) assert.ok(!read(f).includes('partnerName'), f)
})

await t('gift hint: in the send tool description only, never in the mailbox page', () => {
  const tools = T.makeTools({ dataDir: '.', enabled: () => true, mail: {} })
  assert.ok(tools.find((x) => x.name === 'pixelpet_mail_send').description.includes(T.MAIL_GIFT_HINT))
  assert.match(T.MAIL_GIFT_HINT, /偶尔/)
  const page = read('web/mailbox.html') + read('web/mailbox.js') + read('web/mailbox.css')
  for (const bit of ['贺卡，形式随你', T.MAIL_GIFT_HINT.slice(0, 12), 'MAIL_GIFT_HINT']) assert.ok(!page.includes(bit), bit)
})

await t('pptx accepted as an attachment (zip magic), plain text renamed .pptx refused', () => {
  assert.equal(contentMatches(Buffer.from('PK\x03\x04rest', 'latin1'), '.pptx'), true)
  assert.equal(contentMatches(Buffer.from('hello world'), '.pptx'), false)
})

await t('relayed letter tells the AI its id and the like tool (deferred tools need the name)', async () => {
  const { relayPrompt } = await import('../lib/mail.js')
  const p = relayPrompt({ id: 'in-abc123', body: '你看看能不能给我点赞' })
  assert.match(p, /in-abc123/)
  assert.match(p, /pixelpet_mail_like/)
  assert.doesNotMatch(relayPrompt({ body: 'x' }), /pixelpet_mail_like/, 'no id, no hint')
})

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
