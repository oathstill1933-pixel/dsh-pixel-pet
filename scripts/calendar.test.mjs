// node scripts/calendar.test.mjs — 「日历与日记」拓展包。
// 农历换算 / 重复规则 / 提醒调度 / special_day / nearLine / ICS 订阅 / holiday-cn / 日记 / 计数捎带 / 包关着。
// 全假依赖（假时钟、假 fetch、假 agent），不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as H from '../lib/host.js'
import * as LUNAR from '../lib/calendar-lunar.js'
import { intlFestivals, intlDate } from '../lib/calendar-intl.js'
import { createHoliday, parseHoliday, HOLIDAY_FILE } from '../lib/calendar-holiday.js'
import { parseIcs, normalizeUrl, createIcs } from '../lib/calendar-ics.js'
import { createEvents, dayKey, addDays } from '../lib/calendar-events.js'
import { createDiary } from '../lib/calendar-diary.js'
import { createCalendar, sanitizeCalendar } from '../lib/calendar.js'
import * as P from '../lib/proactive.js'
import * as PA from '../lib/pet-activity.js'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n')) }
}
const MIN = 60_000
const DAY = (h, m = 0, d = 15) => new Date(2026, 10, d, h, m, 0).getTime() // 2026-11-15（周日）
const pad = (n) => String(n).padStart(2, '0')

// ------------------------------------------------------------------ 农历
await t('农历换算：十月初一、小月没有三十记在廿九、闰月生日非闰年按正月份', () => {
  // 锚点：2026-11-15 是农历十月初七（lunarLine 自洽）→ 十月初一 = 2026-11-09
  assert.equal(LUNAR.lunarLine(2026, 11, 15), '十月初七 · 丙午年')
  assert.equal(LUNAR.lunarToSolar(2026, 10, 1), '2026-11-09')
  assert.equal(LUNAR.lunarToSolar(2026, 10, 7), '2026-11-15')
  // 小月三十 → 廿九：找一个 29 天的农历月
  let found = null
  for (let m = 1; m <= 12 && !found; m++) {
    const days = LUNAR.lunarMonthDays(2026, m)
    if (days === 29) found = m
  }
  assert.ok(found, '2026 年应有小月')
  assert.equal(LUNAR.lunarToSolar(2026, found, 30), LUNAR.lunarToSolar(2026, found, 29))
  // 闰月：2025 闰六月确实存在 → 两个日期不同；2024 没有闰六月 → 按正月份
  const leap2025 = LUNAR.lunarToSolar(2025, 6, 15, true)
  const plain2025 = LUNAR.lunarToSolar(2025, 6, 15)
  assert.ok(LUNAR.lunarMonthDays(2025, 6, true), '2025 有闰六月')
  assert.ok(leap2025 && plain2025 && leap2025 !== plain2025)
  assert.equal(LUNAR.lunarToSolar(2024, 6, 15, true), LUNAR.lunarToSolar(2024, 6, 15))
  assert.equal(LUNAR.lunarToSolar(2026, 13, 1), null)
  assert.equal(LUNAR.lunarToSolar(2026, 10, 0), null)
})

await t('节气 / 传统节日 / 宜忌 / 国际节日规则', () => {
  assert.equal(LUNAR.solarTerm(2026, 12, 22), '冬至')
  assert.deepEqual(LUNAR.lunarFestivals(2027, 2, 6), ['春节'])
  const al = LUNAR.almanacOf(2026, 11, 15)
  assert.ok(Array.isArray(al.yi) && Array.isArray(al.ji) && al.chong && al.sha)
  assert.ok(intlFestivals(2026, 5, 10).includes('母亲节')) // 5 月第二个周日
  assert.equal(intlDate(2026, '母亲节'), '2026-05-10')
  assert.ok(intlFestivals(2026, 12, 25).includes('圣诞节'))
})

// ------------------------------------------------------------------ 重复规则 + 提醒
function eventsWorld (rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-ev-'))
  const ev = createEvents({ dataDir: dir, now: () => DAY(10, 0, 15) })
  for (const r of rows) writeFileSync(join(dir, 'x'), '') // noop, keep helper shape
  return { dir, ev }
}

await t('重复规则：yearly / monthly 31 号遇小月钳到月底 / weekly；lunar yearly', () => {
  const { ev } = eventsWorld()
  const mk = (date, repeat, extra = {}) => ({ id: 'ev-' + date + '-' + repeat, title: 'x', kind: 'event', date, time: '', repeat, lunar: null, remind: { daysBefore: [] }, note: '', by: 'user', aiVisible: true, done: false, createdAt: '', updatedAt: '', ...extra })
  assert.deepEqual(ev.occurrencesIn(mk('2026-01-31', 'monthly'), '2026-01-01', '2026-04-01'), ['2026-01-31', '2026-02-28', '2026-03-31'])
  assert.deepEqual(ev.occurrencesIn(mk('2025-03-10', 'yearly'), '2026-01-01', '2027-01-01'), ['2026-03-10'])
  const weekly = ev.occurrencesIn(mk('2026-11-16', 'weekly'), '2026-11-01', '2026-12-08')
  assert.deepEqual(weekly, ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'])
  // 农历生日：每年按农历换算（2026 十月初一 = 2026-11-09）
  const lunarBday = { ...mk('2026-11-09', 'yearly'), lunar: { month: 10, day: 1, leap: false } }
  assert.deepEqual(ev.occurrencesIn(lunarBday, '2026-11-01', '2026-11-20'), ['2026-11-09'])
  const nextYear = LUNAR.lunarToSolar(2027, 10, 1)
  assert.deepEqual(ev.occurrencesIn(lunarBday, '2027-01-01', '2027-12-01'), [nextYear])
})

await t('提醒调度：到点 / 提前 N 天 / 错过 / 只提醒一次 / done 不提醒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rm-'))
  const ev = createEvents({ dataDir: dir, now: () => DAY(19, 32, 15) }) // 19:32：过了 2 分钟，标「晚了」 // 今晚 19:30 已过 1 分钟
  const base = { kind: 'event', time: '', repeat: 'none', lunar: null, note: '', by: 'user', aiVisible: true, done: false, createdAt: '', updatedAt: '' }
  const write = (items) => ev.write(items)
  write([
    { id: 'a', title: '交房租', ...base, date: '2026-11-15', time: '19:30', remind: { daysBefore: [0] } },
    { id: 'b', title: '妈妈生日', ...base, date: '2026-11-16', remind: { daysBefore: [1] } },
    { id: 'c', title: '错过的', ...base, date: '2026-11-13', time: '09:00', remind: { daysBefore: [0] } },
    { id: 'd', title: '完成的待办', ...base, date: '2026-11-15', time: '10:00', kind: 'todo', done: true, remind: { daysBefore: [0] } },
    { id: 'e', title: '还没到点的', ...base, date: '2026-11-15', time: '23:00', remind: { daysBefore: [0] } },
  ])
  const due = ev.dueReminders(DAY(19, 32, 15))
  const byId = Object.fromEntries(due.map((x) => [x.id, x]))
  assert.ok(byId.a && byId.a.missed === true && byId.a.time === '19:30') // 过了 1 分钟，标晚
  assert.ok(byId.b && byId.b.missed === false && byId.b.daysBefore === 1) // 提前一天，今天提
  assert.ok(byId.c && byId.c.missed === true) // 错过汇总
  assert.ok(!byId.d, 'done 的 todo 不提醒')
  assert.ok(!byId.e, '还没到点')
  ev.markReminded('a', '2026-11-15', 0)
  ev.markReminded('b', '2026-11-16', 1)
  ev.markReminded('c', '2026-11-13', 0)
  assert.deepEqual(ev.dueReminders(DAY(19, 32, 15)), []) // 只提醒一次
})

// ------------------------------------------------------------------ holiday-cn
await t('holiday-cn：解析 / 快照兜底 / 缓存优先 / refresh 主地址失败回落', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-hd-'))
  const vendorRoot = join(import.meta.url.replace(/^file:\/\/\//, '').replace(/ scripts..*$/, ''), '..', 'vendor', 'holiday-cn').replace(/\\/g, '/')
  const h0 = createHoliday({ dataDir: null }) // 无 dataDir：只读快照
  const look = h0.lookup('2026-01-01')
  assert.ok(look && look.isOff === true && look.name === '元旦')
  const h = createHoliday({ dataDir: dir })
  assert.deepEqual(h.years().filter((y) => y >= 2026), [2026, 2027]) // 快照有 2026、2027
  // 用户更新：主地址 404 → 回落地址给数据 → 写缓存；缓存优先于快照
  let calls = []
  const fake = (url) => {
    calls.push(url)
    return { ok: calls.length === 1 ? false : true, text: async () => JSON.stringify({ year: 2030, days: [{ name: '元旦', date: '2030-01-01', isOffDay: true }, { name: '补班', date: '2030-01-04', isOffDay: false }] }) }
  }
  const h2 = createHoliday({ dataDir: dir, fetchImpl: fake })
  assert.equal(await h2.refresh(2030), true)
  assert.ok(calls[0].includes('cdn.jsdelivr.net') && calls[1].includes('raw.githubusercontent.com'), '主地址失败回落')
  assert.ok(existsSync(join(dir, 'calendar', 'cache', HOLIDAY_FILE(2030))))
  const bad = createHoliday({ dataDir: dir, fetchImpl: async () => ({ ok: true, text: async () => '{"year":2049,"days":"junk"}' }) })
  assert.equal(await bad.refresh(2049), false) // 坏数据不写
  assert.equal(parseHoliday({ year: 2030, days: [{ name: '元旦', date: '2030-01-01', isOffDay: true }] }).days['01-01'].isOff, true)
  assert.equal(parseHoliday('junk'), null)
})

// ------------------------------------------------------------------ ICS 订阅
await t('ICS 解析：RRULE / EXDATE / TZID / 全天；非 https 拒收；5 MB 上限；aiVisible 默认 false', async () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:周会', 'DTSTART;TZID=Asia/Shanghai:20261116T100000',
    'DTEND;TZID=Asia/Shanghai:20261116T110000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'EXDATE;TZID=Asia/Shanghai:20261123T100000',
    'END:VEVENT', 'BEGIN:VEVENT', 'SUMMARY:放假一天', 'DTSTART;VALUE=DATE:20261225', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const from = DAY(8, 0, 15)
  const evs = parseIcs(ics, from, from + 92 * 86_400_000)
  const zhou = evs.filter((x) => x.title === '周会')
  assert.equal(zhou.length, 3) // 4 次里 EXDATE 掉一次
  assert.equal(zhou[0].allDay, false)
  assert.ok(zhou[0].endDate) // 有结束日期（本地墙钟）
  assert.ok(zhou.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)))
  const off = evs.find((x) => x.title === '放假一天')
  assert.equal(off.allDay, true)
  assert.equal(off.date, '2026-12-25') // 全天：用 ICS 里的日期本身
  assert.equal(parseIcs('not a calendar'), null)
  assert.equal(normalizeUrl('webcal://example.com/x.ics'), 'https://example.com/x.ics')
  assert.equal(normalizeUrl('http://example.com/x.ics'), null)
  assert.equal(normalizeUrl('ftp://x'), null)
  // 5 MB 上限 + aiVisible 默认 false
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-ics-'))
  const big = 'x'.repeat(5 * 1024 * 1024 + 1)
  const icsMod = createIcs({ dataDir: dir, fetchImpl: async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from(big).buffer, text: async () => big }) })
  const r = await icsMod.fetchSub('sub-big', 'https://example.com/big.ics')
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('5 MB'))
  const okMod = createIcs({ dataDir: dir, fetchImpl: async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(ics).buffer }) })
  const r2 = await okMod.fetchSub('sub-ok', 'https://example.com/c.ics')
  assert.equal(r2.ok, true)
  assert.ok(existsSync(join(dir, 'calendar', 'cache', 'sub-ok.json')))
})

// ------------------------------------------------------------------ 日记
await t('日记：宿主时间戳 / 每天 8 条上限 / 删除进回收站 / 查询', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-dy-'))
  let T = DAY(21, 0, 15)
  const dy = createDiary({ dataDir: dir, now: () => T })
  for (let i = 0; i < 8; i++) {
    T = DAY(21, 0 + i, 15)
    const r = dy.write({ text: '第 ' + i + ' 句', mood: i === 0 ? '开心' : '' })
    assert.equal(r.ok, true)
    assert.equal(r.entry.at.startsWith('2026-11-15T21:0'), i === 0 || true)
    assert.ok(r.entry.id.startsWith('dy-'))
  }
  const r9 = dy.write({ text: '第九条' })
  assert.equal(r9.ok, false) // 每天上限
  // 时间戳由宿主生成：AI 给的 at 被忽略
  T = DAY(9, 0, 16)
  const r10 = dy.write({ text: '第二天', mood: '平静' })
  assert.ok(r10.entry.at.startsWith('2026-11-16T09:00'), r10.entry.at)
  const month = '2026-11'
  const all = dy.list({ month })
  assert.equal(all.length, 9)
  assert.equal(all[0].text, '第二天') // 倒序
  assert.deepEqual(dy.list({ month, query: '第 3' })[0].text, '第 3 句')
  // 删除 → 回收站
  const victim = all[1]
  assert.equal(dy.remove(victim.id).ok, true)
  assert.ok(!dy.list({ month }).some((x) => x.id === victim.id))
  const trashDir = join(dir, 'diary', '.trash')
  assert.ok(readdirSync(trashDir).some((f) => f.startsWith(month)))
  assert.equal(dy.remove('dy-nope').ok, false)
})

// ------------------------------------------------------------------ 计数 + 捎带
await t('日记计数：只数 hub/mail/reading/music 成功轮；care 不算；到阈值捎带一次；写入或捎带后清零；关了永不捎带', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-cnt-'))
  const cal = createCalendar({
    dataDir: dir, settings: () => ({ calendar: { enabled: true, diary: 'much' } }), now: () => DAY(10, 0, 15),
  })
  cal.onTurn({ source: 'hub', ok: true })
  cal.onTurn({ source: 'care', ok: true })   // 主动关心不算
  cal.onTurn({ source: 'hub', ok: false })   // 失败不算
  cal.onTurn({ source: 'mail', ok: true })
  assert.equal(cal.diary.turnsSince(), 2)
  // 没到阈值：decorate 不附
  const d0 = { content: [{ type: 'text', text: '用户的话' }], commit () {} }
  assert.equal(cal.decorate('session-s1', d0), null)
  for (let i = 0; i < 8; i++) cal.onTurn({ source: 'reading', ok: true }) // 10 轮（much）
  const d1 = { content: [{ type: 'text', text: '用户的话' }], commit () {} }
  const decorated = cal.decorate('session-s1', d1)
  assert.ok(decorated && JSON.stringify(decorated.content).includes('pixelpet_diary_write'))
  decorated.commit() // 消息真发出去才归零
  // 捎带过一次即清零：再 decorate 不附
  assert.equal(cal.decorate('session-s1', { content: [...d1.content], commit () {} }), null)
  assert.equal(cal.diary.turnsSince(), 0)
  // 写入成功也清零（先攒回阈值）
  for (let i = 0; i < 10; i++) cal.onTurn({ source: 'hub', ok: true })
  const wr = cal.diary.write({ text: '今天很开心' })
  assert.equal(wr.ok, true)
  assert.equal(cal.diary.turnsSince(), 0)
  // 「关」：不计数、不捎带
  const cal2 = createCalendar({ dataDir: mkdtempSync(join(tmpdir(), 'pp-cal-cnt2-')), settings: () => ({ calendar: { enabled: true, diary: 'off' } }) })
  for (let i = 0; i < 30; i++) cal2.onTurn({ source: 'hub', ok: true })
  assert.equal(cal2.decorate('session-s1', d0), null)
  // 重启接着数：新实例读同一 state.json
  const cal3 = createCalendar({ dataDir: dir, settings: () => ({ calendar: { enabled: true, diary: 'much' } }), now: () => DAY(10, 1, 15) })
  assert.ok(cal3.diary.turnsSince() >= 0)
  cal3.onTurn({ source: 'hub', ok: true })
  assert.equal(cal3.diary.turnsSince(), 1)
})

// ------------------------------------------------------------------ 服务面（API / nearLine / 工具收口 / 包关着）
function fakeCtx () {
  const handlers = {}; const effects = []
  const reg = new Map()
  let route = null
  const ctx = {
    logger: { warn () {}, info () {} },
    get: (n) => (n === 'webServer' ? { register (r) { route = r; return () => {} } } : null),
    agents: { get: () => undefined },
    // 照 DSH dsh-tools 的 register 校验：没有 output.render 直接 TypeError（2026-11-15：日历工具就是栽在这里）
    tools: {
      register (def) {
        if (!def.output || typeof def.output !== 'object' || typeof def.output.render !== 'function') throw new TypeError(`tool "${def.name}" must declare output { schema, render, presentationMeta? }`)
        if (def.timeoutMs !== undefined && !(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0)) throw new TypeError(`tool "${def.name}" timeoutMs must be a positive finite number`)
        reg.set(def.name, def); return () => {}
      },
    },
    on: (ev, fn) => { handlers[ev] = fn; return () => {} },
    effect: (fn) => { effects.push(fn()) },
  }
  return { ctx, effects, reg, get route () { return route } }
}
async function call (route, method, path, { body, origin } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path
  req.headers = { host: '127.0.0.1:3080', ...(origin ? { origin } : {}) }
  let status = 0; let out = Buffer.alloc(0)
  const res = { writeHead (c) { status = c }, end (b) { if (b) out = Buffer.from(b) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : JSON.stringify(body))
  await p
  let json = null; try { json = JSON.parse(out.toString('utf8')) } catch {}
  return { status, json, raw: out }
}
const SETTINGS_ON = { aiControl: true, autonomy: { enabled: false }, calendar: { enabled: true, diary: 'much', speakFrom: '08:00' }, voice: { llm: { sessionId: 'session-s1' } }, insight: { on: false } }

await t('包关着：API 409、工具不注册；开着：4 个工具注册、API 可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-svc-'))
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  assert.equal(g.reg.has('pixelpet_calendar_list'), false)
  const off = await call(g.route, 'GET', '/api/calendar/sources')
  assert.equal(off.status, 409)
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true, diary: 'much' } } })
  for (const n of ['pixelpet_calendar_list', 'pixelpet_calendar_save', 'pixelpet_diary_write', 'pixelpet_diary_read']) {
    assert.ok(g.reg.has(n), n)
  }
  // 建日程（用户）→ 事件出现 → 到期提醒进 proactive 由头
  const r = await call(g.route, 'POST', '/api/calendar/events', { body: { title: '交房租', date: '2026-11-15', time: '19:30', remind: { daysBefore: [0] } }, origin: 'http://127.0.0.1:3080' })
  assert.equal(r.status, 200); assert.equal(r.json.event.by, 'user')
  const day = await call(g.route, 'GET', '/api/calendar/day?date=2026-11-15')
  assert.equal(day.status, 200)
  assert.equal(day.json.lunarLine, '十月初七 · 丙午年')
  const bad = await call(g.route, 'GET', '/api/calendar/day?date=2026-02-30')
  assert.equal(bad.status, 400)
  // 订阅添加：非 https 拒收
  const sub = await call(g.route, 'POST', '/api/calendar/sources', { body: { addSub: { name: '工作', url: 'http://example.com/x.ics' } }, origin: 'http://127.0.0.1:3080' })
  assert.equal(sub.status, 400)
  // aiVisible 默认 false 的订阅，AI 工具看不到（先真加一个 https 源）
  const sub2 = await call(g.route, 'POST', '/api/calendar/sources', { body: { addSub: { name: '工作', url: 'https://example.com/work.ics' } }, origin: 'http://127.0.0.1:3080' })
  assert.equal(sub2.status, 200)
  const sv = sub2.json.sources.subs[0]
  assert.equal(sv.aiVisible, false)
  assert.equal(sv.domain, 'example.com')
  assert.ok(!JSON.stringify(sv).includes('work.ics'), '订阅链接不出现在对外视图')
  // 日记 API：写走 AI 工具（宿主时间戳），读 / 删
  const wr = g.reg.get('pixelpet_diary_write').execute({ text: '今天陪她听了一下午的歌', mood: '开心' })
  const wr2 = await wr
  assert.equal(wr2.ok, true)
  const diary = await call(g.route, 'GET', '/api/calendar/diary?month=2026-11')
  assert.equal(diary.json.entries.length, 1)
  const del = await call(g.route, 'DELETE', '/api/calendar/diary/' + diary.json.entries[0].id, { origin: 'http://127.0.0.1:3080' })
  assert.equal(del.status, 200)
  for (const e of g.effects) if (typeof e === 'function') e()
})

await t('nearLine：只列 aiVisible、3 天内、≤ 5 条；关着为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-near-'))
  const ev = createEvents({ dataDir: dir, now: () => DAY(10, 0, 15) })
  const base = { kind: 'event', time: '', repeat: 'none', lunar: null, remind: { daysBefore: [] }, note: '', by: 'user', done: false, createdAt: '', updatedAt: '' }
  ev.write([
    { id: 'a', title: '交房租', ...base, date: '2026-11-17', aiVisible: true },
    { id: 'b', title: '私事', ...base, date: '2026-11-16', aiVisible: false },
    { id: 'c', title: '她的生日', ...base, date: '2026-11-18', kind: 'birthday', aiVisible: true },
  ])
  const mk = (on) => createCalendar({ dataDir: dir, settings: () => ({ calendar: { enabled: on, diary: 'medium' } }), now: () => DAY(10, 0, 15) })
  const cal = mk(true)
  const line = cal.nearLine()
  assert.ok(line.startsWith('近日：'))
  assert.ok(line.includes('交房租') && line.includes('11-17') && line.includes('周'))
  assert.ok(line.includes('她的生日'))
  assert.ok(!line.includes('私事'), 'aiVisible=false 不进提示词')
  // 一天最多变一次（按日期缓存）
  assert.equal(cal.nearLine(), line)
  // 关着为空
  assert.equal(mk(false).nearLine(), '')
})

// ------------------------------------------------------------------ proactive 集成：提醒 / special_day
function wakeWorld ({ extras, care = true, aiControl = true, petVoice = 'idle', rows = [], pending = false, settingsPatch = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-wake-'))
  const fired = []
  const bubbles = []
  const says = []
  const asks = []
  let T = DAY(10, 0, 15)
  const pendingMap = pending ? new Map([['s1', {}]]) : new Map()
  const w = {
    dir, fired, bubbles, says, asks,
    get T () { return T }, adv (ms) { T += ms }, setT (v) { T = v },
    settings: { aiControl, autonomy: { enabled: true, aware: care, care }, calendar: { enabled: true, diary: 'medium', speakFrom: '08:00' }, voice: { llm: { sessionId: 'session-s1' } }, insight: { on: false }, ...settingsPatch },
    rows, pendingMap, petVoice,
  }
  w.relay = { pending: pendingMap, ask: async (sid, text, content, opts) => { w.asks.push({ sid, text, opts }); return { code: 200, body: { ok: true, reply: w.reply != null ? w.reply : '好的' } } } }
  w.sendCommand = async (body) => {
    if (body.cmd === 'status') return { ok: true, data: { voice: w.petVoice } }
    if (body.cmd === 'say') { w.says.push(body); return { ok: true } }
    return { ok: false }
  }
  w.p = P.createProactive({
    dataDir: dir, settings: () => w.settings, relay: w.relay, sendCommand: (body, ms) => w.sendCommand(body, ms),
    rowsFn: () => w.rows, now: () => T,
    extras, onFired: (x) => fired.push(x),
    onWake: () => {},
  })
  w.p.state()
  return w
}

const reminderItems = () => [{ id: 'a', title: '交房租', time: '19:30', occurrenceDate: '2026-11-15', daysBefore: 0, dueAt: DAY(19, 30, 15), missed: false }]
const R = (t, minAgo, state, app = '') => ({ t: t - minAgo * 60000, state, app })

await t('提醒：不受主动关心开关 / 配额 / 没回不追约束；回复照说出声；销账', async () => {
  const w = wakeWorld({ care: false, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w.p.tick()
  assert.equal(w.asks.length, 1)
  assert.ok(w.asks[0].text.includes('[桌宠·提醒]') && w.asks[0].text.includes('交房租'))
  assert.equal(w.says.length, 1) // 提醒没有【不说】出口：回复照说
  assert.equal(w.says[0].speak, true)
  assert.deepEqual(w.fired.map((x) => x.type), ['reminder'])
  assert.equal(w.fired[0].item.id, 'a')
  // 销账后：extras 不再给 → 不再叫
  const w2 = wakeWorld({ care: false, extras: () => ({ reminders: [], specialDay: null }) })
  w2.rows = w.rows
  await w2.p.tick()
  assert.equal(w2.asks.length, 0)
})

await t('提醒：AI 控制关着 → 气泡兜底（不出声）并销账；排队超 10 分钟同样兜底', async () => {
  const w = wakeWorld({ aiControl: false, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w.p.tick()
  assert.equal(w.asks.length, 0)
  assert.equal(w.bubbles.length + w.says.filter((s) => s.speak !== true).length >= 1, true, '气泡兜底')
  assert.ok(w.says[0].text.includes('交房租'))
  assert.deepEqual(w.fired.map((x) => x.type), ['reminder'])
  // 排队超 10 分钟
  const w2 = wakeWorld({ extras: () => ({ reminders: reminderItems(), specialDay: null }), pending: true })
  w2.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w2.p.tick(); assert.equal(w2.asks.length, 0)
  w2.adv(9 * MIN); await w2.p.tick(); assert.equal(w2.asks.length, 0)
  w2.adv(2 * MIN); await w2.p.tick() // 排了 11 分钟 → 兜底
  assert.equal(w2.asks.length, 0)
  assert.equal(w2.says.some((s) => s.text.includes('交房租')), true)
})

// AI 控制关着时，全天提醒原先绕过「提醒说话时间」，0 点就冒气泡并销账
await t('提醒：AI 控制关着时，全天提醒同样等到「提醒说话时间」之后才冒气泡', async () => {
  const allDay = () => [{ id: 'b', title: '交水费', time: '', occurrenceDate: '2026-11-15', daysBefore: 0, dueAt: DAY(0, 0, 15), missed: false }]
  const w = wakeWorld({ aiControl: false, care: false, extras: () => ({ reminders: allDay(), specialDay: null }) })
  w.setT(DAY(0, 30, 15))
  await w.p.tick()
  assert.equal(w.says.length, 0, '0:30 不冒')
  assert.equal(w.fired.length, 0, '0:30 不销账')
  w.setT(DAY(9, 5, 15))
  await w.p.tick()
  assert.ok(w.says.some((s) => s.text.includes('交水费')), '过了提醒时间冒气泡')
  assert.deepEqual(w.fired.map((x) => x.type), ['reminder'])
})

await t('统计来源：主动关心的叫醒记 care，特别日子记 calendar', async () => {
  const w = wakeWorld({ extras: () => ({ reminders: [], specialDay: null }) })
  w.rows = [R(DAY(10, 0, 15), 100, 'work')]
  await w.p.tick()
  for (const a of w.asks) assert.equal(a.opts.source, a.text.includes('今天是') ? 'calendar' : 'care')
  const w2 = wakeWorld({ extras: () => ({ reminders: [], specialDay: { date: '2026-11-15', names: ['冬至'] } }) })
  w2.rows = [R(DAY(10, 0, 15), 30, 'other')]
  await w2.p.tick()
  assert.equal(w2.asks.length, 1)
  assert.equal(w2.asks[0].opts.source, 'calendar')
})

await t('提醒：用户不在电脑前（away）就等；特殊日子受主动关心开关与每日一次约束', async () => {
  // 提醒定在今天早上 09:00（away 之前就到期）；extras 按当前时钟动态算 missed（真实由 calendar.dueReminders 重算）
  const lateItems = () => [{ id: 'a', title: '交房租', time: '09:00', occurrenceDate: '2026-11-15', daysBefore: 0, dueAt: DAY(9, 0, 15), missed: false }]
  const allRows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }, { t: DAY(9, 30, 15), state: 'away', app: '' }, { t: DAY(11, 0, 15), state: 'work', app: '' }]
  const w = wakeWorld({
    care: true, // 活动感知开着（否则 away 不可判定，按「在」处理）
    extras: () => ({ reminders: lateItems().map((x) => ({ ...x, missed: w.T > x.dueAt + 60_000 })), specialDay: null }),
  })
  w.rows = allRows.filter((r) => r.t <= w.T) // 活动日志只有已发生的行
  await w.p.tick()
  assert.equal(w.asks.length, 0) // away：等
  assert.equal(w.fired.length, 0)
  // 回来了：立刻提，并注明晚了
  w.setT(DAY(11, 5, 15))
  w.rows = allRows.filter((r) => r.t <= w.T)
  await w.p.tick()
  assert.equal(w.asks.length, 1)
  assert.ok(w.asks[0].text.includes('晚'), w.asks[0].text)
  // special_day：care 关 → 不叫；care 开 → 第一次见到用户时叫一次（销账后当天不再叫）
  const special = { date: '2026-11-15', names: ['冬至'] }
  const wOff = wakeWorld({ care: false, extras: () => ({ reminders: [], specialDay: special }) })
  wOff.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await wOff.p.tick(); assert.equal(wOff.asks.length, 0)
  let specialNow = special
  const wOn = wakeWorld({ care: true, extras: () => ({ reminders: [], specialDay: specialNow }) })
  wOn.setT(DAY(9, 5, 15)) // 刚回来 5 分钟 = 第一次见到用户（≥ 08:00）
  wOn.rows = [{ t: DAY(8, 0, 15), state: 'away', app: '' }, { t: DAY(9, 0, 15), state: 'work', app: '' }]
  await wOn.p.tick()
  assert.equal(wOn.asks.length, 1)
  assert.ok(wOn.asks[0].text.includes('今天是冬至') && wOn.asks[0].text.includes('【不说】'))
  assert.deepEqual(wOn.fired.map((x) => x.type), ['special_day'])
  specialNow = null // 宿主销账（markSpecialDay）后 wakeContext 不再给
  await wOn.p.tick()
  assert.equal(wOn.fired.length, 1)
  assert.equal(wOn.asks.length, 1)
})

await t('special_day：没到「提醒说话时间」/ quiet hours 不叫', () => {
  const special = { date: '2026-11-15', names: ['冬至'] }
  // 10:00 < speakFrom 20:00：不叫
  const r = createProactiveHelper(special, { speakFrom: '20:00' }, DAY(10, 0, 15))
  r.tick()
  assert.equal(r.asks.length, 0)
  // 静默时段（23:30–07:00 默认）：23:40 不叫
  const r2 = createProactiveHelper(special, {}, DAY(23, 40, 15))
  r2.tick()
  assert.equal(r2.asks.length, 0)
})
function createProactiveHelper (special, calSettings, at) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-sp-'))
  const asks = []
  const fired = []
  const T = { v: at }
  const p = P.createProactive({
    dataDir: dir,
    settings: () => ({ aiControl: true, autonomy: { enabled: true }, calendar: { enabled: true, diary: 'medium', speakFrom: calSettings.speakFrom || '08:00' }, voice: { llm: { sessionId: 'session-s1' } }, insight: { on: false } }),
    relay: { pending: new Map(), ask: async (sid, text, c, opts) => { asks.push({ sid, text, opts }); return { code: 200, body: { ok: true, reply: '冬至快乐' } } } },
    sendCommand: async (body) => (body.cmd === 'status' ? { ok: true, data: { voice: 'idle' } } : { ok: true }),
    rowsFn: () => [{ t: DAY(9, 0, 15), state: 'work', app: '' }],
    now: () => T.v,
    extras: () => ({ reminders: [], specialDay: special }),
    onFired: (x) => fired.push(x),
  })
  return { p, asks, fired, tick: () => p.tick() }
}

// ================================================================== review 修复（09 号单，2026-11-15）
import { spawnSync } from 'node:child_process'

await t('review1: 日历窗脚本不得用相对路径 fetch(\'api/\')（日历窗在 /calendar/ 子路径下）', () => {
  const src = readFileSync(join(H.PLUGIN_ROOT, 'web', 'calendar', 'calendar.js'), 'utf8')
  assert.ok(!/fetch\('api\//.test(src), 'calendar.js 里不许出现 fetch(\'api/…\')——日历窗在子路径下会 404')
  assert.ok(!/fetch\("api\//.test(src))
})

await t('review2: AI 新建补默认 repeat/remind；旧数据缺 repeat 不再按月展开；回执按实际说', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv2-'))
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true } } })
  // todo 新建：repeat=none、remind=[0]；回执提日期
  const r = await call(g.route, 'POST', '/api/calendar/events', { body: { title: '交房租', kind: 'todo', date: '2026-11-20' }, origin: 'http://127.0.0.1:3080' })
  assert.equal(r.status, 200)
  assert.equal(r.json.event.repeat, 'none')
  assert.deepEqual(r.json.event.remind.daysBefore, [0])
  // 生日新建：yearly + [0,1]
  const r2 = await call(g.route, 'POST', '/api/calendar/events', { body: { title: '妈妈生日', kind: 'birthday', date: '2026-11-16' }, origin: 'http://127.0.0.1:3080' })
  assert.equal(r2.json.event.repeat, 'yearly')
  assert.deepEqual(r2.json.event.remind.daysBefore, [0, 1])
  // 旧数据（repeat 缺失）读入后不再按月展开，且被迁移写回
  const f = join(dir, 'calendar', 'events.json')
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  raw.items.push({ id: 'old', title: '旧条目', kind: 'event', date: '2026-11-25', remind: { daysBefore: [0] }, by: 'user', aiVisible: true, createdAt: '', updatedAt: '' })
  writeFileSync(f, JSON.stringify(raw), 'utf8')
  const ev = (await import('../lib/calendar-events.js')).createEvents({ dataDir: dir, now: () => DAY(10, 0, 15) })
  const old = ev.read().find((x) => x.id === 'old')
  assert.equal(old.repeat, 'none') // 读时迁移
  const occ = ev.occurrencesIn(old, '2026-11-01', '2027-03-01')
  assert.deepEqual(occ, ['2026-11-25'])
  // 工具回执按实际说
  const save = g.reg.get('pixelpet_calendar_save')
  const receipt = await save.execute({ title: '去看牙', kind: 'todo', date: '2026-11-21' })
  assert.ok(receipt.ok && receipt.message.includes('11-21'), receipt.message)
  const noRemind = await save.execute({ title: '随手记', kind: 'event', date: '2026-11-22', remind: { daysBefore: [] } })
  assert.ok(noRemind.message.includes('不提醒'), noRemind.message)
  for (const e of g.effects) if (typeof e === 'function') e()
}).catch?.()

await t('review3: 捎带过没写，再聊满阈值还能再次捎带', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv3-'))
  const cal = createCalendar({ dataDir: dir, settings: () => ({ calendar: { enabled: true, diary: 'much' } }), now: () => DAY(10, 0, 15) })
  for (let i = 0; i < 10; i++) cal.onTurn({ source: 'hub', ok: true })
  const d = { content: [{ type: 'text', text: '用户的话' }], commit () {} }
  assert.ok(cal.decorate('session-s1', d))
  d.commit()
  // 没写，再聊满 10 轮 → 还能再捎带
  for (let i = 0; i < 10; i++) cal.onTurn({ source: 'hub', ok: true })
  const d2 = { content: [{ type: 'text', text: '用户的话' }], commit () {} }
  assert.ok(cal.decorate('session-s1', d2))
})

await t('review4: ICS 缓存存本地墙钟 date/time；TZ 子进程两种时区；旧格式缓存丢弃', async () => {
  // 旧格式缓存读到就丢（等下次刷新）
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv4-'))
  mkdirSync(join(dir, 'calendar', 'cache'), { recursive: true })
  writeFileSync(join(dir, 'calendar', 'cache', 'sub-old.json'), JSON.stringify({ fetchedAt: 'x', url: 'https://leaky.example.com/token', events: [{ title: '旧', start: '2026-11-16T01:00:00.000Z', allDay: false }] }))
  const mod = createIcs({ dataDir: dir, fetchImpl: async () => ({ ok: false, headers: new Map() }) })
  const cache = mod.readCache('sub-old')
  assert.equal(cache, null, '旧格式缓存应被丢弃')
  // TZ 子进程：同一份 ICS，上海时区与洛杉矶时区下的本地墙钟（runner 写成真 .mjs 文件，顶层 await 才合法）
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:全天事件', 'DTSTART;VALUE=DATE:20261118', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:上海会', 'DTSTART;TZID=Asia/Shanghai:20261118T090000', 'DTEND;TZID=Asia/Shanghai:20261118T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:UTC会', 'DTSTART:20261118T010000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  writeFileSync(join(dir, 'ics.txt'), ics, 'utf8')
  const libPath = fileURLToPath(new URL('../lib/calendar-ics.js', import.meta.url))
  const runnerPath = join(dir, 'runner.mjs')
  writeFileSync(runnerPath, [
    "import { pathToFileURL } from 'node:url'",
    "import { readFileSync } from 'node:fs'",
    "const { parseIcs } = await import(pathToFileURL(process.argv[2]).href)",
    "const ics = readFileSync(process.argv[3], 'utf8')",
    "const from = new Date('2026-11-01T00:00:00').getTime()",
    "const evs = parseIcs(ics, from, from + 92 * 86400000)",
    "const pick = (t) => { const x = evs.find((e) => e.title === t); return { date: x.date, time: x.time, allDay: x.allDay } }",
    "console.log(JSON.stringify({ 全天: pick('全天事件'), 上海会: pick('上海会'), UTC会: pick('UTC会') }))",
  ].join('\n'), 'utf8')
  const runTz = (tz) => spawnSync(process.execPath, [runnerPath, libPath, join(dir, 'ics.txt')], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
  const sh = JSON.parse(runTz('Asia/Shanghai').stdout.trim())
  const la = JSON.parse(runTz('America/Los_Angeles').stdout.trim())
  assert.equal(sh.全天.date, '2026-11-18'); assert.equal(sh.全天.allDay, true); assert.equal(sh.全天.time, '')
  assert.equal(sh.上海会.date, '2026-11-18'); assert.equal(sh.上海会.time, '09:00')
  assert.equal(sh.UTC会.date, '2026-11-18'); assert.equal(sh.UTC会.time, '09:00')
  assert.equal(la.全天.date, '2026-11-18'); assert.equal(la.全天.allDay, true)
  assert.equal(la.上海会.date, '2026-11-17'); assert.equal(la.上海会.time, '17:00')
  assert.equal(la.UTC会.date, '2026-11-17'); assert.equal(la.UTC会.time, '17:00')
  // 新格式缓存不存 url
  const dir2 = mkdtempSync(join(tmpdir(), 'pp-cal-rv4b-'))
  const mod2 = createIcs({ dataDir: dir2, fetchImpl: async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(ics).buffer }) })
  await mod2.fetchSub('sub-x', 'https://secret.example.com/token?private=1')
  const cached = JSON.parse(readFileSync(join(dir2, 'calendar', 'cache', 'sub-x.json'), 'utf8'))
  assert.ok(!('url' in cached), '缓存不得存订阅链接')
  assert.ok(cached.events.every((e) => typeof e.date === 'string' && typeof e.time === 'string'), '缓存条目用 date/time 字段')
})

await t('review5: 全天 / 提前 N 天的提醒要等 speakFrom + firstSeen；只有「定时且当天」到点就说', async () => {
  const dayItem = () => [{ id: 'a', title: '交房租', time: '', occurrenceDate: '2026-11-15', daysBefore: 0, dueAt: DAY(0, 0, 15), missed: false }]
  // 没开感知、电脑开着过夜：0 点 / 早上 7 点都不说；speakFrom(08:00) 后、「第一次见到用户」才说
  const w1 = wakeWorld({ care: true, extras: () => ({ reminders: dayItem(), specialDay: null }), settingsPatch: { calendar: { enabled: true, diary: 'medium', speakFrom: '08:00' } } })
  w1.setT(DAY(0, 5, 15)) // 半夜 00:05
  w1.rows = [{ t: DAY(0, 0, 15), state: 'other', app: '' }]
  await w1.p.tick(); assert.equal(w1.asks.length, 0, '半夜全天提醒不说')
  w1.setT(DAY(7, 30, 15)); await w1.p.tick(); assert.equal(w1.asks.length, 0, 'speakFrom 前不说')
  // 感知开着：10:00 刚从 away 回来 → 第一次见到用户 → 说
  w1.setT(DAY(10, 0, 15))
  w1.rows = [{ t: DAY(0, 0, 15), state: 'other', app: '' }, { t: DAY(9, 55, 15), state: 'away', app: '' }, { t: DAY(9, 58, 15), state: 'work', app: '' }]
  await w1.p.tick(); assert.equal(w1.asks.length, 1, 'speakFrom 后 + 刚回来 → 说')
  // 感知没开：09:00 定点后说
  const w2 = wakeWorld({ care: true, extras: () => ({ reminders: dayItem(), specialDay: null }), settingsPatch: { autonomy: { enabled: true, aware: false, care: true } } })
  w2.setT(DAY(8, 30, 15)); w2.rows = [{ t: DAY(0, 0, 15), state: 'other', app: '' }]
  await w2.p.tick(); assert.equal(w2.asks.length, 0, '感知没开 08:30 不说')
  w2.setT(DAY(9, 5, 15)); await w2.p.tick(); assert.equal(w2.asks.length, 1, '感知没开 09:05 定点说')
  // 定时且当天的提醒不受 speakFrom 限制（半夜到点也说）
  const timedMidnight = () => [{ id: 't', title: '凌晨吃药', time: '00:30', occurrenceDate: '2026-11-15', daysBefore: 0, dueAt: DAY(0, 30, 15), missed: false }]
  const w3 = wakeWorld({ care: false, extras: () => ({ reminders: timedMidnight(), specialDay: null }) })
  w3.setT(DAY(0, 31, 15)); w3.rows = [{ t: DAY(0, 0, 15), state: 'other', app: '' }]
  await w3.p.tick(); assert.equal(w3.asks.length, 1, '定时提醒半夜到点就说')
})

await t('review6: 气泡失败不销账；AI 回复为空 /【不说】改走气泡；say 失败下一轮走气泡', async () => {
  // 气泡失败（桌宠没开）：不销账
  const w = wakeWorld({ aiControl: false, extras: () => ({ reminders: reminderItems(), specialDay: null }), petVoice: 'off' })
  w.sendCommand = async (body) => (body.cmd === 'status' ? { ok: false } : { ok: false, running: false }) // say 也失败
  w.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w.p.tick()
  assert.deepEqual(w.fired, [], '气泡失败不销账')
  // AI 回复【不说】→ 气泡兜底，气泡成功才销账
  const w2 = wakeWorld({ care: true, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w2.reply = '【不说】'
  w2.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w2.p.tick()
  assert.equal(w2.asks.length, 1)
  assert.equal(w2.fired.length, 1, '气泡成功 → 销账')
  assert.equal(w2.says[0].speak !== true, true, '兜底气泡不出声')
  // say 失败 → 不销账，下一轮（extras 还给）改走气泡
  const w3 = wakeWorld({ care: true, extras: () => ({ reminders: reminderItems(), specialDay: null }), petVoice: 'broken' })
  w3.sendCommand = async (body) => (body.cmd === 'status' ? { ok: true, data: { voice: 'idle' } } : { ok: false })
  w3.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w3.p.tick()
  assert.equal(w3.asks.length, 1)
  assert.deepEqual(w3.fired, [], 'say 失败不销账')
})

await t('review7: 活动感知关着或日志不新鲜时不认 away，提醒不会被卡死', async () => {
  // 感知开着但最后一行停在 away 且超过 30 分钟 → 当作在，照提
  const w = wakeWorld({ care: true, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w.rows = [{ t: DAY(9, 0, 15), state: 'away', app: '' }] // 停在 away，T=10:00（60 分钟前）
  await w.p.tick()
  assert.equal(w.asks.length, 1, '不新鲜的 away 当作在')
  // 感知开着且 away 新鲜 → 等
  const w2 = wakeWorld({ care: true, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w2.rows = [{ t: DAY(9, 45, 15), state: 'away', app: '' }] // 15 分钟前
  await w2.p.tick()
  assert.equal(w2.asks.length, 0, '新鲜的 away 继续等')
})

await t('review8: special_day AI 回【不说】也销账，当天不再反复叫醒', async () => {
  let special = { date: '2026-11-15', names: ['冬至'] }
  const w = wakeWorld({
    care: true,
    extras: () => ({ reminders: [], specialDay: special }),
    settingsPatch: { autonomy: { enabled: true, aware: true, care: true } },
  })
  w.reply = '【不说】'
  w.setT(DAY(9, 5, 15)) // 刚回来
  w.rows = [{ t: DAY(8, 0, 15), state: 'away', app: '' }, { t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w.p.tick()
  assert.equal(w.asks.length, 1)
  assert.deepEqual(w.fired.map((x) => x.type), ['special_day'])
  special = null // 宿主销账
  w.adv(30 * MIN)
  await w.p.tick()
  assert.equal(w.asks.length, 1) // 当天不再叫
})

await t('review9: 熔断第 2 档跨天复位；view().pausedUntil 跟 until 走', async () => {
  const w = wakeWorld()
  w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 502, body: { ok: false, message: '429 quota exceeded' } } }
  await w.p.tick(); assert.equal(w.p.state().breakerLevel, 1)
  w.adv(31 * MIN); await w.p.tick(); assert.equal(w.p.state().breakerLevel, 2)
  assert.ok(w.p.state().breakerDay, '升档必写 breakerDay')
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 2) // 2 h 内不再发
  // 跨天：档位归零，第一次失败只停 30 分钟
  w.setT(DAY(10, 0, 17)); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick()
  assert.equal(w.p.state().breakerLevel, 1)
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 3)
  w.adv(30 * MIN); await w.p.tick(); assert.equal(w.asks.length, 4)
  // pausedUntil 跟 until 走：刚升档（第 2 档，+2h）非空
  assert.equal(w.p.view().pausedUntil, w.p.state().breakerUntil)
  // 成功一次 → 复位 → pausedUntil null
  w.relay.ask = async () => { w.asks.push({}); return { code: 200, body: { ok: true, reply: '【不说】' } } }
  w.adv(2 * 3600_000 + MIN); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick()
  assert.equal(w.p.view().pausedUntil, null)
  assert.equal(w.p.state().breakerLevel, 0)
})

await t('review10: 状态行 6 分钟封顶；两行隔 2 小时中间 offline；offline 行也是一行', () => {
  const from = DAY(0, 0, 15)
  const rows = [
    { t: from + 60 * MIN, state: 'working' },              // 01:00 起工作中，没有心跳
    { t: from + 180 * MIN, state: 'idle' },                // 03:00 才下一行 → 01:06 起就该 offline
    { t: from + 181 * MIN, state: 'idle', hb: true },      // 心跳续命
    { t: from + 240 * MIN, state: 'working' },
  ]
  const slots = PA.stateSlots(rows, from, from + 86_400_000, from + 300 * MIN)
  assert.equal(slots[12].state, 'working')  // 01:00–01:05
  assert.equal(slots[13].state, 'offline')  // 01:05–01:10 起：超过 6 分钟没有续命
  assert.equal(slots[36].state, 'idle')     // 03:00 心跳续上
  assert.equal(slots[37].state, 'offline')  // 03:05 心跳间隔内（181 分那行只到 181+6=187 分）
  assert.equal(slots[48].state, 'working')  // 04:00 起工作中
})

await t('review11: 改日程只给部分字段沿用原值（工具 + HTTP）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv11-'))
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true } } })
  await call(g.route, 'POST', '/api/calendar/events', { body: { title: '交房租', kind: 'todo', date: '2026-11-20', time: '19:30' }, origin: 'http://127.0.0.1:3080' })
  const allEvs = (await call(g.route, 'GET', '/api/calendar/events?from=2026-11-01&to=2026-12-01')).json.events
  const id = allEvs.find((x) => x.by === 'user').id
  // 工具只给 { id, done: true }
  const save = g.reg.get('pixelpet_calendar_save')
  const r = await save.execute({ id, done: true })
  assert.equal(r.ok, true, r.message)
  const pickUser = (r) => r.json.events.find((x) => x.by === 'user')
  const ev = pickUser(await call(g.route, 'GET', '/api/calendar/events?from=2026-11-01&to=2026-12-01'))
  assert.equal(ev.title, '交房租'); assert.equal(ev.done, true); assert.equal(ev.time, '19:30')
  // HTTP 同样只给部分字段
  const r2 = await call(g.route, 'POST', '/api/calendar/events', { body: { id, note: '带好证件' }, origin: 'http://127.0.0.1:3080' })
  assert.equal(r2.status, 200)
  const ev2 = pickUser(await call(g.route, 'GET', '/api/calendar/events?from=2026-11-01&to=2026-12-01'))
  assert.equal(ev2.title, '交房租'); assert.equal(ev2.note, '带好证件')
  for (const e of g.effects) if (typeof e === 'function') e()
})

await t('review12: refreshSubs 单飞；抓取期间用户改的开关 / 删除不被覆盖；被删的源跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv12-'))
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:x', 'DTSTART:20261118T010000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  let release = []
  const fetchImpl = async () => new Promise((done) => release.push(done))
  const cal = createCalendar({ dataDir: dir, settings: () => ({ calendar: { enabled: true, diary: 'medium' } }), fetchImpl, now: () => DAY(10, 0, 15) })
  cal.start()
  const added1 = await call2(cal, 'POST', 'sources', { addSub: { name: '工作', url: 'https://a.example.com/x.ics' } })
  const added2 = await call2(cal, 'POST', 'sources', { addSub: { name: '球赛', url: 'https://b.example.com/y.ics' } })
  const id1 = added1.body.sources.subs[0].id
  const p1 = cal.refreshSubs() // 两个源顺序抓
  const p2 = cal.refreshSubs() // 单飞：立即返回同一次结果
  // refreshSubs 顺序抓：每放行一个，等下一个 fetch 发出来
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 50 && release.length <= round; i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(release.length > round, '第 ' + (round + 1) + ' 个 fetch 发出去了')
    release[round]({ ok: true, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(ics).buffer })
  }
  const r1 = await p1; const r2 = await p2
  assert.equal(r1.total, 2); assert.deepEqual(r2, r1)
  // 抓取结束后用户删一个源：不被覆盖
  await call2(cal, 'POST', 'sources', { subs: [{ id: id1, remove: true }] })
  const sv = (await call2(cal, 'GET', 'sources')).body.subs
  assert.equal(sv.length, 1); assert.equal(sv[0].name, '球赛')
  cal.stop()
})

// 「台历点了打不开」：host 没把 openWindow 传给 createCalendar，/api/calendar/open 永远 ok:false
await t('台历 / 「打开日历」：/api/calendar/open 真的会开窗（openWindow 已接上，尺寸按 [宽, 高]）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-open-'))
  const g = fakeCtx()
  const opened = []
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, openWindow: (url, size) => { opened.push({ url, size }); return true }, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true } } })
  const r = await call(g.route, 'POST', '/api/calendar/open', { body: {} })
  assert.equal(r.status, 200); assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(opened.length, 1)
  assert.match(opened[0].url, /^http:\/\/127\.0\.0\.1:3080\/dsh-pixel-pet\/calendar\/$/)
  assert.deepEqual(opened[0].size, (await import('../lib/open-window.js')).PAGES.calendar)   // 大小只在 open-window.js 定一处
})

async function call2 (cal, method, path, body = {}) {
  const sub = String(path).replace(/^api\/calendar\//, '')
  const req = new PassThrough()
  req.method = method
  const res = { code: 0, body: null }
  const url = new URL('http://local/dsh-pixel-pet/api/calendar/' + sub)
  await cal.handle(req, res, {
    path: '/api/calendar/' + sub, url,
    send: (r2, code, obj) => { res.code = code; res.body = obj },
    readBody: async () => Buffer.from(JSON.stringify(body)),
    originBase: '',
  })
  return res
}

await t('review13/21: events GET 带开着的订阅日程（不管 aiVisible）；lunarNote 年份用 Number', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv13-'))
  // 订阅事件放在「今天起第 3 天」：宿主用真实时钟，写死日期会随着日子过去掉出 92 天窗口（2026-11-15 踩过）
  const ahead = new Date(Date.now() + 3 * 86_400_000)
  const ymd = ahead.getFullYear() + String(ahead.getMonth() + 1).padStart(2, '0') + String(ahead.getDate()).padStart(2, '0')
  const fakeFetch = async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:周会', 'DTSTART:' + ymd + 'T100000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')).buffer })
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) }, fetch: fakeFetch })
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true } } })
  await call(g.route, 'POST', '/api/calendar/events', { body: { title: '她的生日', kind: 'birthday', date: '2026-11-18', lunar: { month: 10, day: 1, leap: false } }, origin: 'http://127.0.0.1:3080' })
  await call(g.route, 'POST', '/api/calendar/sources', { body: { addSub: { name: '工作', url: 'https://a.example.com/x.ics' } }, origin: 'http://127.0.0.1:3080' })
  await call(g.route, 'POST', '/api/calendar/sources/refresh', { body: {}, origin: 'http://127.0.0.1:3080' })
  const span = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const r = await call(g.route, 'GET', '/api/calendar/events?from=' + span(new Date(Date.now() - 30 * 86_400_000)) + '&to=' + span(new Date(Date.now() + 30 * 86_400_000)))
  const subs = r.json.events.filter((x) => x.by === 'sub')
  assert.ok(subs.length >= 1 && subs[0].title === '周会', '订阅日程进 events 列表（不管 aiVisible）')
  const bday = r.json.events.find((x) => x.kind === 'birthday')
  assert.ok(bday.lunarNote.includes('农历'), bday.lunarNote)
  for (const e of g.effects) if (typeof e === 'function') e()
})

await t('review15: 日记捎带不附到桌宠自己发起的叫醒消息上；归零在 commit 里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv15-'))
  const cal = createCalendar({ dataDir: dir, settings: () => ({ calendar: { enabled: true, diary: 'much' } }), now: () => DAY(10, 0, 15) })
  for (let i = 0; i < 10; i++) cal.onTurn({ source: 'hub', ok: true })
  // 叫醒消息：不附、不归零
  const wake = { content: [{ type: 'text', text: '[桌宠·醒来看看] …' }], commit () {} }
  assert.equal(cal.decorate('session-s1', wake), null)
  assert.equal(cal.diary.turnsSince(), 10)
  // 用户消息：附上；commit 才归零，发送失败（不 commit）不归零
  const user = { content: [{ type: 'text', text: '用户的话' }], commit () {} }
  const d = cal.decorate('session-s1', user)
  assert.ok(d)
  assert.equal(cal.diary.turnsSince(), 10)
  d.commit()
  assert.equal(cal.diary.turnsSince(), 0)
})

await t('review16: 新建条目不提醒创建之前的发生日', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv16-'))
  const T = DAY(19, 32, 15)
  const ev = createEvents({ dataDir: dir, now: () => T })
  const base = { kind: 'event', time: '09:00', repeat: 'none', lunar: null, note: '', by: 'user', aiVisible: true, done: false, updatedAt: '' }
  ev.write([
    { id: 'new', title: '新建的', ...base, time: '09:00', date: '2026-11-14', remind: { daysBefore: [0] }, createdAt: '2026-11-15T19:00:00+08:00' },
    { id: 'old-style', title: '旧数据无 createdAt', ...base, time: '09:00', date: '2026-11-13', remind: { daysBefore: [0] } },
  ])
  const due = ev.dueReminders(T)
  assert.ok(due.some((x) => x.id === 'old-style' && x.missed), '旧数据（无 createdAt）按原规则算错过')
  assert.ok(!due.some((x) => x.id === 'new'), '新建条目不追创建之前的发生日（昨天 09:00，昨晚 19:00 才建）')
})

await t('review17: 2020 年开始的每日重复事件，2026 年仍能看到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv17-'))
  const ev = createEvents({ dataDir: dir, now: () => DAY(10, 0, 15) })
  const evDaily = { id: 'daily', title: '每日站会', kind: 'event', date: '2020-03-02', time: '09:00', repeat: 'none', lunar: null, remind: { daysBefore: [] }, note: '', by: 'user', aiVisible: true, done: false, createdAt: '', updatedAt: '' }
  // RRULE 由 ICS 侧测（上面），这里测 events 侧 none；ICS 侧用 parseIcs 覆盖
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:每日站会', 'DTSTART;TZID=Asia/Shanghai:20200302T090000', 'DTEND;TZID=Asia/Shanghai:20200302T093000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const from = DAY(8, 0, 15)
  const evs = parseIcs(ics, from, from + 92 * 86_400_000)
  assert.ok(evs.some((x) => x.title === '每日站会' && x.date === '2026-11-16'), '2020 年开始的每日事件 2026 年仍可见（迭代 5000 + 跳过不收集）')
  void evDaily
})

await t('review18: sources/refresh 的 year 只接受今年-1 到今年+1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cal-rv18-'))
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: dir, autoInstall: false, balance: { get: async () => null, attach: () => null, status: () => ({}) } })
  await call(g.route, 'POST', '/api/settings', { body: { calendar: { enabled: true } } })
  const y = new Date().getFullYear()
  const bad = await call(g.route, 'POST', '/api/calendar/sources/refresh', { body: { year: y + 5 }, origin: 'http://127.0.0.1:3080' })
  assert.equal(bad.status, 400)
  const okish = await call(g.route, 'POST', '/api/calendar/sources/refresh', { body: { year: y + 1 }, origin: 'http://127.0.0.1:3080' })
  assert.ok([200, 502].includes(okish.status), '范围内年份照常（快照有就直接 200）')
  for (const e of g.effects) if (typeof e === 'function') e()
})

await t('review19: 提醒叫醒的模型请求 source=calendar（活动与额度按来源显示「提醒」）', async () => {
  const w = wakeWorld({ care: false, extras: () => ({ reminders: reminderItems(), specialDay: null }) })
  w.rows = [{ t: DAY(9, 0, 15), state: 'work', app: '' }]
  await w.p.tick()
  assert.equal(w.asks.length, 1)
  assert.equal(w.asks[0].opts.source, 'calendar')
})

await t('日记墙：删除按钮不遮住 del()；便签纸型/角度按 id 算死；日历窗首开大小登记在 PAGES', async () => {
  const src = readFileSync(fileURLToPath(new URL('../web/calendar/calendar.js', import.meta.url)), 'utf8')
  // 2026-11-16 的 bug：按钮变量叫 del，点了调用的是按钮自己，DELETE 从没发出去
  assert.ok(!/\b(const|let|var)\s+del\s*=\s*document\.createElement/.test(src), '删除按钮变量不能叫 del')
  assert.match(src, /del\('calendar\/diary\/' \+ e\.id\)/)
  assert.ok(!/Math\.random/.test(src), '纸型、角度、撕边不能随机，每次打开要一样')
  const { PAGES } = await import('../lib/open-window.js')
  assert.ok(Array.isArray(PAGES.calendar) && PAGES.calendar.length === 2 && PAGES.calendar.every((n) => Number.isInteger(n) && n >= 600))
})

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail ? 1 : 0)
