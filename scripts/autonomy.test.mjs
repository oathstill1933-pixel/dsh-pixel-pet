// 「主动一点」 host side: settings.autonomy sanitizing and the base + autonomy-paragraph prompt. Run from host.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as A from '../lib/autonomy.js'
import * as P from '../lib/prompt.js'

export async function runAutonomyTests ({ t, H, fakeCtx, call }) {
  await t('autonomy: defaults, rule switches, quiet hours, speakUp stays off', () => {
    const d = H.mergeSettings({}, {}).autonomy
    assert.equal(d.enabled, true); assert.equal(d.speakUp, false)
    assert.deepEqual(Object.keys(d.rules), A.AUTONOMY_RULES)
    assert.ok(Object.values(d.rules).every((v) => v === true))
    assert.deepEqual(d.quietHours, { start: '', end: '' })
    assert.equal(d.proactivePrompt, ''); assert.equal(d.passivePrompt, '')

    let s = H.mergeSettings({}, { autonomy: { enabled: false, rules: { lateNight: false, bogus: false, idleSleep: 'no' }, speakUp: true, extra: 1 } })
    assert.equal(s.autonomy.enabled, false); assert.equal(s.autonomy.speakUp, false)
    assert.equal(s.autonomy.rules.lateNight, false); assert.equal(s.autonomy.rules.idleSleep, true)
    assert.ok(!('bogus' in s.autonomy.rules)); assert.ok(!('extra' in s.autonomy))
    // partial patches keep the rest
    s = H.mergeSettings(s, { autonomy: { rules: { newMail: false } } })
    assert.equal(s.autonomy.enabled, false); assert.equal(s.autonomy.rules.lateNight, false); assert.equal(s.autonomy.rules.newMail, false)
    s = H.mergeSettings(s, { autonomy: { enabled: 'yes' } })
    assert.equal(s.autonomy.enabled, false)
    s = H.mergeSettings(s, { autonomy: 'nope' })
    assert.equal(s.autonomy.rules.newMail, false)

    s = H.mergeSettings({}, { autonomy: { quietHours: { start: '00:00', end: '08:00' } } })
    assert.deepEqual(s.autonomy.quietHours, { start: '00:00', end: '08:00' })
    assert.deepEqual(H.mergeSettings(s, { autonomy: { quietHours: { start: '8:00' } } }).autonomy.quietHours, { start: '00:00', end: '08:00' })
    assert.deepEqual(H.mergeSettings(s, { autonomy: { quietHours: { start: '', end: '' } } }).autonomy.quietHours, { start: '', end: '' })
    assert.deepEqual(H.mergeSettings(s, { autonomy: { quietHours: { start: '08:00' } } }).autonomy.quietHours, { start: '', end: '' }) // same = off
    assert.deepEqual(H.mergeSettings({}, { autonomy: { quietHours: { start: '24:00', end: '07:61' } } }).autonomy.quietHours, { start: '', end: '' })
    // stored settings with junk are cleaned on read as well
    assert.equal(H.mergeSettings({ autonomy: { enabled: 3, speakUp: true, rules: [] } }, {}).autonomy.enabled, true)
    assert.equal(H.mergeSettings({ autonomy: { speakUp: true } }, {}).autonomy.speakUp, false)
  })

  await t('autonomy: prompt = base + proactive / passive paragraph, both editable, capped, "" = default', () => {
    assert.ok(P.DEFAULT_PROACTIVE.startsWith('主动一点') && P.DEFAULT_PROACTIVE.includes('一轮最多两个桌宠动作'))
    assert.ok(P.DEFAULT_PASSIVE.includes('只在用户明确要求时'))
    const on = H.mergeSettings({}, {})
    assert.equal(P.effectivePrompt(on), P.DEFAULT_PROMPT + '\n\n' + P.DEFAULT_PROACTIVE)
    const off = H.mergeSettings({}, { autonomy: { enabled: false } })
    assert.equal(P.effectivePrompt(off), P.DEFAULT_PROMPT + '\n\n' + P.DEFAULT_PASSIVE)
    const own = H.mergeSettings({}, { prompt: '底', autonomy: { proactivePrompt: '  多动  ', passivePrompt: '少动' } })
    assert.equal(own.autonomy.proactivePrompt, '多动')
    assert.equal(P.effectivePrompt(own), '底\n\n多动')
    assert.equal(P.effectivePrompt(H.mergeSettings(own, { autonomy: { enabled: false } })), '底\n\n少动')
    assert.equal(H.mergeSettings({}, { autonomy: { proactivePrompt: P.DEFAULT_PROACTIVE + '\n' } }).autonomy.proactivePrompt, '')
    assert.equal(H.mergeSettings({}, { autonomy: { passivePrompt: 'x'.repeat(9000) } }).autonomy.passivePrompt.length, P.PART_MAX)
    assert.equal(H.mergeSettings({}, { autonomy: { passivePrompt: 7 } }).autonomy.passivePrompt, '')
    assert.equal(P.effectivePrompt(undefined), P.DEFAULT_PROMPT + '\n\n' + P.DEFAULT_PROACTIVE)
  })

  await t('autonomy: system-prompt section follows the switch per step; /api/prompt round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-au-'))
    const sections = []
    const g = fakeCtx()
    const baseGet = g.ctx.get
    g.ctx.get = (n) => (n === 'systemPrompt' ? { section (s) { sections.push(s); return () => {} } } : baseGet(n))
    H.apply(g.ctx, { dataDir: dir, autoInstall: false })
    await call(g.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-s1' } } } })
    const text = () => sections[0].text({ agent: { session: { id: 'session-s1' } } })
    assert.ok(text().includes('主动一点') && !text().includes('只在用户明确要求时'))
    let r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.autonomy, true); assert.equal(r.json.text, P.DEFAULT_PROMPT)
    assert.equal(r.json.proactive, P.DEFAULT_PROACTIVE); assert.equal(r.json.passiveDefault, P.DEFAULT_PASSIVE)
    assert.equal(r.json.partMax, P.PART_MAX); assert.equal(r.json.full, P.DEFAULT_PROMPT + '\n\n' + P.DEFAULT_PROACTIVE)

    await call(g.route, 'POST', '/api/settings', { body: { autonomy: { enabled: false } } })
    assert.ok(text().includes('只在用户明确要求时') && !text().includes('主动一点'))
    await call(g.route, 'POST', '/api/settings', { body: { autonomy: { passivePrompt: '别动' } } })
    assert.ok(text().endsWith('别动\n</pixelpet-guide>'))
    r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.autonomy, false); assert.equal(r.json.passive, '别动')
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).autonomy
    assert.equal(saved.enabled, false); assert.equal(saved.passivePrompt, '别动'); assert.equal(saved.rules.idleSleep, true)
    await call(g.route, 'POST', '/api/settings', { body: { autonomy: { enabled: true, passivePrompt: '' } } })
    assert.ok(text().includes('主动一点'))
    r = await call(g.route, 'GET', '/api/prompt')
    assert.equal(r.json.passive, P.DEFAULT_PASSIVE)
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  await t('autonomy: settings page carries the switch, rule list and quiet hours', async () => {
    const g = fakeCtx()
    H.apply(g.ctx, { dataDir: mkdtempSync(join(tmpdir(), 'pp-aup-')), autoInstall: false })
    const page = (await call(g.route, 'GET', '/')).raw.toString()
    assert.ok(page.includes('id="autoOn"') && page.includes('id="autoBox"') && page.includes('id="promptPart"'))
    for (const k of A.AUTONOMY_RULES) assert.ok(page.includes('data-rule="' + k + '"'), k)
    assert.ok(page.includes('id="quietStart"') && page.includes('id="quietEnd"'))
    assert.ok(!page.includes('speakUp'))
    assert.ok(page.includes('id="autoAware"') && page.includes('id="awareFix"') && page.includes('id="awareLog"'))
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  // ---------------------------------------------------------------- 允许感知在做什么 (lib/awareness.js)
  const AW = await import('../lib/awareness.js')
  const ACT = await import('../lib/activity.js')
  const T0 = Date.parse('2026-11-14T20:00:00+08:00')
  const logDir = (rows) => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-aw-'))
    writeFileSync(join(dir, AW.LOG_FILE), rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n', 'utf8')
    return dir
  }
  const at = (min) => new Date(T0 + min * 60_000).toISOString()

  await t('awareness: switch defaults off, sanitized, new rules exist', () => {
    const d = H.mergeSettings({}, {}).autonomy
    assert.equal(d.aware, false)
    assert.equal(d.rules.meetingQuiet, true); assert.equal(d.rules.videoCorner, true)
    assert.equal(H.mergeSettings({}, { autonomy: { aware: true } }).autonomy.aware, true)
    assert.equal(H.mergeSettings({}, { autonomy: { aware: 'yes' } }).autonomy.aware, false)
    assert.equal(H.mergeSettings({ autonomy: { aware: true } }, { autonomy: { rules: { lateNight: false } } }).autonomy.aware, true)
    assert.equal(AW.awareOn({ autonomy: { aware: true } }), true)
    assert.equal(AW.awareOn({ autonomy: { aware: true, enabled: false } }), false)
    assert.equal(AW.awareOn(H.mergeSettings({}, {})), false)
  })

  await t('awareness: note = categories + minutes only, no titles / app names', () => {
    const dir = logDir([
      { t: at(0), state: 'gaming', app: 'genshinimpact.exe', dur: 25, title: '秘密窗口' },
      { t: at(40), state: 'work', app: 'code.exe', dur: 25 },
    ])
    const rows = AW.readLog(dir)
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => !('title' in r)))
    const note = AW.noteFrom(rows, T0 + 45 * 60_000)
    assert.equal(note, '刚才大概在：打游戏（约 40 分钟），现在在干活')
    assert.ok(!note.includes('.exe') && !note.includes('秘密'))
    assert.equal(AW.noteFrom(rows.slice(0, 1), T0 + 5 * 60_000), '现在在打游戏（约 5 分钟）')
    assert.equal(AW.noteFrom([], T0), '')
    assert.equal(AW.noteFrom(rows, T0 + 30 * 3600_000), '') // stale log says nothing
    const off = AW.createAwareness({ dataDir: dir, settings: () => ({ autonomy: { aware: false } }), now: () => T0 + 45 * 60_000 })
    assert.equal(off.note(), ''); assert.equal(off.today(), null); assert.deepEqual(off.recent(), [])
    const on = AW.createAwareness({ dataDir: dir, settings: () => ({ autonomy: { aware: true } }), now: () => T0 + 45 * 60_000 })
    assert.equal(on.note(), note)
    const day = on.today()
    assert.equal(day.minutes['打游戏'], 40); assert.equal(day.minutes['干活'], 5)
    assert.ok(!JSON.stringify(day).includes('秘密'))
    assert.equal(on.recent()[0].state, 'work')
    assert.ok(AW.renderNote(note).includes(note)); assert.equal(AW.renderNote(''), '')
  })

  await t('awareness: learn keyed by process name, bad input refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-awl-'))
    assert.deepEqual(AW.learn(dir, 'MyGame.EXE', 'gaming'), { 'mygame.exe': 'gaming' })
    assert.deepEqual(AW.readLearned(dir), { 'mygame.exe': 'gaming' })
    assert.equal(AW.learn(dir, 'x.exe', 'hacking'), null)
    assert.equal(AW.learn(dir, '..\\evil', 'work'), null)
    assert.deepEqual(AW.learn(dir, 'mygame.exe', ''), {})
  })

  await t('awareness: relayed message gets the note only while the switch is on', () => {
    const dir = logDir([{ t: new Date(Date.now() - 50 * 60_000).toISOString(), state: 'video', app: 'chrome.exe', dur: 0 },
      { t: new Date(Date.now() - 5 * 60_000).toISOString(), state: 'work', app: 'code.exe', dur: 0 }])
    let s = { aiControl: true, autonomy: { aware: false }, voice: { llm: { sessionId: 'session-a' } } }
    const aw = AW.createAwareness({ dataDir: dir, settings: () => s })
    const ch = P.createPromptChannel({ ctx: { get: () => ({ section: () => () => {} }) }, dataDir: dir, settings: () => s, note: () => AW.renderNote(aw.note()) })
    const base = [{ type: 'text', text: '你好' }]
    assert.deepEqual(ch.decorate('session-a', base).content, base)
    s = { ...s, autonomy: { aware: true } }
    const c = ch.decorate('session-a', base).content
    assert.equal(c.length, 2)
    assert.ok(c[1].text.includes('刚才大概在：看视频（约 45 分钟），现在在干活'))
    assert.ok(!c[1].text.includes('.exe'))
  })

  await t('awareness: pixelpet_status carries activityToday only when given', async () => {
    const { makeTools } = await import('../lib/tools.js')
    const send = async () => ({ ok: true, running: true, data: { state: 'idle' } })
    const st = (o) => makeTools({ dataDir: '.', enabled: () => true, send, ...o }).find((x) => x.name === 'pixelpet_status')
    let r = await st({ activity: () => ({ minutes: { 干活: 5 } }) }).execute({})
    assert.deepEqual(r.data.activityToday, { minutes: { 干活: 5 } })
    r = await st({ activity: () => null }).execute({})
    assert.ok(!('activityToday' in r.data))
  })

  await t('awareness: /api/awareness asks the pet nothing while off', async () => {
    const g = fakeCtx()
    H.apply(g.ctx, { dataDir: mkdtempSync(join(tmpdir(), 'pp-awr-')), autoInstall: false })
    const r = await call(g.route, 'GET', '/api/awareness')
    assert.deepEqual(r.json, { ok: true, aware: false })
    const l = await call(g.route, 'POST', '/api/awareness/learn', { body: { app: 'x.exe', state: 'gaming' } })
    assert.equal(l.json.ok, false)
    for (const e of g.effects) if (typeof e === 'function') e()
  })

  await t('activity follower: switching the target session resets the de-dup', () => {
    const sent = []
    let target = 'session-a'
    const f = ACT.createActivityFollower({ targetId: () => target, keyOf: (x) => String(x || '').replace(/^session-/, ''), send: (c) => sent.push(c.state) })
    f({ id: 'session-a' }, { type: 'turn/start' })
    target = 'session-b'
    f({ id: 'session-b' }, { type: 'turn/start' })
    assert.deepEqual(sent, ['working', 'working'])
    f({ id: 'session-b' }, { type: 'turn/start' })
    assert.deepEqual(sent, ['working', 'working'])
  })
}
