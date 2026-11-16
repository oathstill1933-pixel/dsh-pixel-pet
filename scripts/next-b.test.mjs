// Next-phase B: action preview, usage prompt delivery, pixelpet_screen (host side). Run from host.test.mjs.
// No real pet, no real screen: the pet is a tiny HTTP stand-in that records control commands.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as P from '../lib/prompt.js'
import * as PV from '../lib/preview.js'
import * as SCR from '../lib/screen.js'
import * as T from '../lib/tools.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

/** fake pet control endpoint: writes control.json into dataDir, answers with reply(body) */
async function fakePet (dataDir, reply = () => ({ ok: true, message: 'ok' })) {
  const got = []
  const srv = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      got.push({ body, auth: req.headers.authorization })
      const out = Buffer.from(JSON.stringify(reply(body)))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': out.length }); res.end(out)
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  writeFileSync(join(dataDir, 'control.json'), JSON.stringify({ port: srv.address().port, token: CTL }))
  return { got, close: () => new Promise((r) => srv.close(r)) }
}

const CTL = ['pp', 'ctl', randomBytes(6).toString('hex')].join('-') // throwaway control credential for the fake pet

const settingsOf = (dir, H) => () => H.mergeSettings((() => { try { return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) } catch { return {} } })(), {})
const writeSettings = (dir, s) => writeFileSync(join(dir, 'settings.json'), JSON.stringify(s))

export async function runNextBTests ({ t, H, fakeCtx, call }) {
  // ---------------------------------------------------------------- preview
  await t('preview: every state with timing, pose / mood mapping, frames served, traversal refused', async () => {
    const v = PV.previewOf(H.PLUGIN_ROOT, null, 'whale-girl')
    const by = Object.fromEntries(v.states.map((s) => [s.id, s]))
    assert.ok(v.states.length >= 20)
    assert.deepEqual(by['mood-happy'].play, { cmd: 'mood', tag: '开心', seconds: 3 })
    assert.deepEqual(by.waving.play, { cmd: 'pose', name: 'wave' })
    assert.deepEqual(by.lie.play, { cmd: 'pose', name: 'lie', holdMs: 4000 })
    assert.deepEqual(by.idle.play, { cmd: 'pose', name: 'sit' })
    assert.equal(by['walk-left'].play, null)
    assert.equal(by.jumping.loop, false); assert.deepEqual(by.jumping.durationsMs, [120, 110, 200, 110, 160, 500])
    assert.equal(PV.previewOf(H.PLUGIN_ROOT, null, '../x'), null)
    assert.equal(PV.frameFile(H.PLUGIN_ROOT, null, 'whale-girl', 'idle', '99'), null)
    assert.equal(PV.frameFile(H.PLUGIN_ROOT, null, 'whale-girl', '..', '0'), null)

    const dir = mkdtempSync(join(tmpdir(), 'pp-pv-'))
    const g = fakeCtx()
    H.apply(g.ctx, { dataDir: dir, autoInstall: false })
    const r = await call(g.route, 'GET', '/api/preview?id=whale-girl')
    assert.equal(r.status, 200); assert.equal(r.json.name, v.name); assert.equal(r.json.states.length, v.states.length)
    const def = await call(g.route, 'GET', '/api/preview')
    assert.equal(def.json.id, 'whale-girl')
    assert.equal((await call(g.route, 'GET', '/api/preview?id=nope')).status, 404)
    const f = await call(g.route, 'GET', '/api/frame/whale-girl/mood-happy/2')
    assert.equal(f.status, 200); assert.equal(f.raw.subarray(1, 4).toString('latin1'), 'PNG')
    assert.equal((await call(g.route, 'GET', '/api/frame/whale-girl/mood-happy/9')).status, 404)
    assert.equal((await call(g.route, 'GET', '/api/frame/whale-girl/..%2f..%2fx/0')).status, 404)
    for (const p of ['/extras.js', '/extras.css']) assert.equal((await call(g.route, 'GET', p)).status, 200)
    const page = (await call(g.route, 'GET', '/')).raw.toString()
    assert.ok(page.includes('id="moves"') && page.includes('id="prompt"') && page.includes('id="screen"') && page.includes('extras.js'))

    // play on the desktop: not running -> readable refusal; running -> exactly the pose / mood command
    const off = await call(g.route, 'POST', '/api/preview/play', { body: { id: 'whale-girl', state: 'mood-sad' } })
    assert.equal(off.json.ok, false); assert.equal(off.json.running, false)
    assert.equal((await call(g.route, 'POST', '/api/preview/play', { body: { id: 'whale-girl', state: 'walk-left' } })).status, 400)
    const pet = await fakePet(dir)
    try {
      const on = await call(g.route, 'POST', '/api/preview/play', { body: { id: 'whale-girl', state: 'mood-sad' } })
      assert.equal(on.json.ok, true)
      await call(g.route, 'POST', '/api/preview/play', { body: { state: 'jumping' } })
      assert.deepEqual(pet.got.map((x) => x.body), [{ cmd: 'mood', tag: '委屈', seconds: 3 }, { cmd: 'pose', name: 'jump' }])
      assert.equal(pet.got[0].auth, 'Bearer ' + CTL)
    } finally { await pet.close() }
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  // ---------------------------------------------------------------- prompt
  await t('prompt: default bundled, stored as "" when unchanged, cleaned and capped', () => {
    assert.ok(P.DEFAULT_PROMPT.includes('pixelpet_mood') && P.DEFAULT_PROMPT.includes('pixelpet_screen'))
    for (const tag of ['开心', '惊讶', '疑惑', '思考', '困', '委屈', '闯祸']) assert.ok(P.DEFAULT_PROMPT.includes(tag + '：'), tag)
    assert.equal(P.sanitizePrompt(P.DEFAULT_PROMPT + '\n\n'), '')
    assert.equal(P.sanitizePrompt('a\r\nb' + String.fromCharCode(0, 7, 0x202e) + 'c\n\n\n\nd'), 'a\nbc\n\nd')
    assert.equal(P.sanitizePrompt('x'.repeat(9000)).length, P.PROMPT_MAX)
    assert.equal(P.sanitizePrompt(42), '')
    const s = H.mergeSettings({}, {})
    assert.equal(s.prompt, ''); assert.equal(s.screen, false)
    assert.equal(H.mergeSettings({}, { prompt: '  自定义  ', screen: true }).prompt, '自定义')
    assert.equal(H.mergeSettings({}, { screen: 'yes' }).screen, false)
    assert.ok(!P.renderAttachment('a</pixelpet-guide>b').includes('a</pixelpet-guide>b'))
  })

  await t('prompt: host system-prompt section only for the pointed session, nothing attached to messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-sp-'))
    writeSettings(dir, { voice: { llm: { sessionId: 'session-s1' } } })
    const sections = []
    const g = fakeCtx()
    const baseGet = g.ctx.get
    g.ctx.get = (n) => (n === 'systemPrompt' ? { section (s) { sections.push(s); return () => { s.disposed = true } } } : baseGet(n))
    H.apply(g.ctx, { dataDir: dir, autoInstall: false })
    assert.equal(sections.length, 1)
    const sec = sections[0]
    assert.equal(sec.name, P.SECTION_NAME); assert.ok(Number.isFinite(sec.order)); assert.equal(sec.interpolate, false)
    const mine = sec.text({ agent: { session: { id: 'session-s1' } }, scope: {} })
    assert.ok(mine.includes('pixelpet_mood') && mine.includes('<pixelpet-guide>'))
    assert.equal(sec.text({ agent: { session: { id: 'session-other' } } }), '')
    assert.equal(sec.text({}), '')
    await call(g.route, 'POST', '/api/settings', { body: { prompt: '只用开心表情' } })
    assert.ok(sec.text({ agent: { session: { id: 's1' } } }).includes('只用开心表情'))
    await call(g.route, 'POST', '/api/settings', { body: { aiControl: false } })
    assert.equal(sec.text({ agent: { session: { id: 'session-s1' } } }), '')
    const pr = await call(g.route, 'GET', '/api/prompt')
    assert.equal(pr.json.mode, 'system'); assert.equal(pr.json.text, '只用开心表情'); assert.equal(pr.json.custom, true); assert.equal(pr.json.default, P.DEFAULT_PROMPT)
    // relayed messages stay untouched
    const ch = P.createPromptChannel({ ctx: g.ctx, dataDir: dir, settings: settingsOf(dir, H) })
    const relay = H.createRelay(g.ctx, 3000, { decorate: ch.decorate })
    g.ctx.on('session/event', relay.onEvent)
    await call(g.route, 'POST', '/api/settings', { body: { aiControl: true } })
    await relay.ask('session-s1', '在吗')
    assert.deepEqual(g.agent.calls.at(-1).content, [{ type: 'text', text: '在吗' }])
    for (const e of g.effects) if (typeof e === 'function') e()
    assert.equal(sec.disposed, true)
  })

  await t('prompt: without the host service it rides along once per session, again after an edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-pm-'))
    writeSettings(dir, { voice: { llm: { sessionId: 'session-s1' } } })
    const g = fakeCtx()
    const ch = P.createPromptChannel({ ctx: g.ctx, dataDir: dir, settings: settingsOf(dir, H) })
    assert.equal(ch.mode, 'message')
    const relay = H.createRelay(g.ctx, 3000, { decorate: ch.decorate })
    g.ctx.on('session/event', relay.onEvent)
    const guide = (msg) => msg.content.filter((b) => b.type === 'text' && b.text.includes('<pixelpet-guide>'))

    assert.equal((await relay.ask('session-s1', '第一句')).code, 200)
    let msg = g.agent.calls.at(-1)
    assert.equal(msg.content[0].text, '第一句')
    assert.equal(guide(msg).length, 1); assert.ok(guide(msg)[0].text.includes('pixelpet_mood'))
    assert.equal(JSON.parse(readFileSync(join(dir, 'prompt-sent.json'), 'utf8')).s1, P.promptHash(P.effectivePrompt(H.mergeSettings({}, {})))) // base + 主动一点 paragraph

    await relay.ask('session-s1', '第二句')
    assert.deepEqual(g.agent.calls.at(-1).content, [{ type: 'text', text: '第二句' }])
    await relay.ask('s1', '第三句')                                   // same session without the prefix
    assert.equal(guide(g.agent.calls.at(-1)).length, 0)

    writeSettings(dir, { voice: { llm: { sessionId: 'session-s1' } }, prompt: '改过的说明' })
    // a failed followup does not count as sent
    const ok = g.agent.followup
    g.agent.followup = async () => { throw new Error('offline') }
    assert.equal((await relay.ask('session-s1', '丢了')).code, 502)
    g.agent.followup = ok
    await relay.ask('session-s1', '第四句')
    msg = g.agent.calls.at(-1)
    assert.equal(guide(msg).length, 1); assert.ok(guide(msg)[0].text.includes('改过的说明'))
    await relay.ask('session-s1', '第五句')
    assert.equal(guide(g.agent.calls.at(-1)).length, 0)

    // tools off: no guide at all
    writeSettings(dir, { voice: { llm: { sessionId: 'session-s1' } }, prompt: '再改', aiControl: false })
    await relay.ask('session-s1', '第六句')
    assert.equal(guide(g.agent.calls.at(-1)).length, 0)
  })

  await t('prompt: settings page round-trip and restore default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-pr-'))
    const g = fakeCtx()
    H.apply(g.ctx, { dataDir: dir, autoInstall: false })
    let r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.mode, 'message'); assert.equal(r.json.custom, false); assert.equal(r.json.text, P.DEFAULT_PROMPT); assert.equal(r.json.max, P.PROMPT_MAX)
    await call(g.route, 'POST', '/api/settings', { body: { prompt: 'x'.repeat(5000) } })
    r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.text.length, P.PROMPT_MAX); assert.equal(r.json.custom, true)
    await call(g.route, 'POST', '/api/settings', { body: { prompt: '' } })
    r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.custom, false); assert.equal(r.json.text, P.DEFAULT_PROMPT)
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  // ---------------------------------------------------------------- screen tool
  await t('pixelpet_screen: not registered while the switch is off; registered once on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-scr-'))
    const g = fakeCtx()
    H.apply(g.ctx, { dataDir: dir, autoInstall: false })
    assert.equal(g.tools.reg.get('pixelpet_screen'), undefined, 'off: invisible to the AI, no tokens')
    assert.ok(g.tools.reg.get('pixelpet_move'), 'the rest of the pet tools are there')
    const pet = await fakePet(dir)
    try {
      await call(g.route, 'POST', '/api/settings', { body: { screen: true } })
      const tool = g.tools.reg.get('pixelpet_screen')
      assert.ok(tool, 'on: registered')
      assert.match(tool.description, /pixelpet_move/); assert.match(tool.description, /同一套/)
      assert.equal(pet.got.length, 0, 'nothing reaches the pet just by switching on')
      await call(g.route, 'POST', '/api/settings', { body: { aiControl: false } })
      assert.equal(g.tools.reg.get('pixelpet_screen'), undefined, 'aiControl off unregisters it with the rest')
      assert.equal((await tool.execute({ mode: 'windows' })).message, SCR.AI_OFF)
      await call(g.route, 'POST', '/api/settings', { body: { aiControl: true } })
      const live = g.tools.reg.get('pixelpet_screen')
      assert.equal((await live.execute({ mode: 'windows' })).ok, true)
      assert.deepEqual(pet.got.map((x) => x.body), [{ cmd: 'screen', mode: 'windows' }])
    } finally { await pet.close() }
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  await t('pixelpet_screen: shot goes to the attachment store, base64 never reaches the transcript', async () => {
    const saved = []
    const attachments = { async saveImage (x) { saved.push(x); return { attachmentId: 'att-9', mediaType: x.mediaType, bytes: x.data.length, width: 1, height: 1 } } }
    const sent = []
    const send = async (_d, body) => {
      sent.push(body)
      return { ok: true, message: '拍好了', data: { region: { x: 0, y: 0, w: 1707, h: 960 }, grid: 200, pet: { x: 1, y: 2 }, image: { mediaType: 'image/png', width: 1280, height: 720, base64: PNG.toString('base64') } } }
    }
    let on = true
    let clock = 0
    const tool = T.makeTools({ dataDir: 'x', enabled: () => true, send, screen: { screenEnabled: () => on, attachments: () => attachments, now: () => clock } })
      .find((d) => d.name === 'pixelpet_screen')
    const r = await tool.execute({ mode: 'shot', monitor: 1, region: { x: 10.4, y: 20, w: 300, h: 200 }, hidePet: false })
    assert.deepEqual(sent[0], { cmd: 'screen', mode: 'shot', monitor: 1, region: { x: 10, y: 20, w: 300, h: 200 }, hidePet: false })
    assert.equal(r.ok, true); assert.deepEqual(r.image, { type: 'image', attachment: saved.length && { attachmentId: 'att-9', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 } })
    assert.equal(saved[0].mediaType, 'image/png')
    assert.deepEqual(r.data.image, { width: 1280, height: 720 })
    const blocks = tool.output.render({}, r)
    assert.equal(blocks.length, 2); assert.equal(blocks[1].type, 'image')
    assert.ok(!blocks[0].text.includes(PNG.toString('base64').slice(0, 12)))
    assert.ok(blocks[0].text.includes('"grid": 200'))
    assert.equal((await tool.execute({ mode: 'shot', region: { x: 1 } })).ok, false)
    assert.equal((await tool.execute({ mode: 'peek' })).ok, false)
    // rate limit, then the window passes
    for (let i = 0; i < 7; i++) await tool.execute({ mode: 'shot' })
    assert.match((await tool.execute({ mode: 'shot' })).message, /太多/)
    clock = 61_000
    assert.equal((await tool.execute({ mode: 'shot' })).ok, true)
    // no attachment service -> refusal, not a silent text-only result
    const bare = T.makeTools({ dataDir: 'x', enabled: () => true, send, screen: { screenEnabled: () => true, attachments: () => null } }).find((d) => d.name === 'pixelpet_screen')
    assert.match((await bare.execute({ mode: 'shot' })).message, /附件/)
    on = false
    assert.equal((await tool.execute({ mode: 'shot' })).message, SCR.SCREEN_OFF)
    assert.ok(!existsSync(join('x', 'tmp')))
  })
}
