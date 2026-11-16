// node scripts/proactive.test.mjs — 「主动关心」(lib/proactive.js)。
// 全部用假时钟、假 awareness（内存 rows）、假 relay、假 balance（只写磁盘缓存）、假桌宠命令，不连真会话。
// 硬闸逐道测：开关 / 余额与熔断 / 会话忙 / 用户状态 / 安静时段 / 没回不追 / 间隔配额 / 单飞 / 重启恢复 / 桌宠在用嘴。
// 由头测：long_work 边界与重置、back 2 min 延迟、long_play 切出才触发、late_work / quiet_long 每天一次。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { segments } from '../lib/awareness.js'
import * as P from '../lib/proactive.js'
import * as H from '../lib/host.js'
import { makeTools } from '../lib/tools.js'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n')) }
}

const MIN = 60_000
// 全部用本地时间构造（quietHours / dayKey 都是本地时区），基准：2026-11-12 10:00（白天，不在安静窗口）
const at = (h, m = 0, day = 12) => new Date(2026, 10, day, h, m, 0).getTime()
const R = (T, minAgo, state, app = '') => ({ t: T - minAgo * MIN, state, app })

function world (o = {}) {
  const dir = o.dir || mkdtempSync(join(tmpdir(), 'pp-care-'))
  let T = o.start != null ? o.start : at(10, 0)
  const cfg = o.settings || { aiControl: true, autonomy: { enabled: true, aware: true, care: true, careLevel: o.level || 'medium', quietHours: { start: '', end: '' } }, voice: { llm: { sessionId: 'session-s1' } } }
  const w = {
    dir, settings: cfg, rows: [], asks: [], says: [],
    pending: new Map(),
    petVoice: o.petVoice || 'idle',
    reply: o.reply != null ? o.reply : '今天也加油哦',
    code: o.code != null ? o.code : 200,
    ok: o.ok !== false,
    statusOk: o.statusOk !== false,
    get T () { return T },
    adv (ms) { T += ms },
    setT (v) { T = v },
    setReply (reply, { code = 200, ok = true } = {}) { w.reply = reply; w.code = code; w.ok = ok },
  }
  w.relay = {
    pending: w.pending,
    ask: async (sid, text, content, opts) => { w.asks.push({ sid, text, opts }); return { code: w.code, body: { ok: w.ok, reply: w.reply } } },
  }
  w.sendCommand = async (body) => {
    if (body.cmd === 'status') return w.statusOk ? { ok: true, data: { voice: w.petVoice } } : { ok: false }
    if (body.cmd === 'say') { w.says.push(body); return { ok: true } }
    return { ok: false }
  }
  w.p = P.createProactive({ dataDir: dir, settings: () => w.settings, relay: w.relay, sendCommand: w.sendCommand, rowsFn: () => w.rows, now: () => T })
  return w
}

// ------------------------------------------------------------------ 纯函数
await t('sanitize: autonomy.care / careLevel 默认关 + medium，垃圾值拒绝，部分补丁保留', () => {
  const d = H.mergeSettings({}, {}).autonomy
  assert.equal(d.care, false); assert.equal(d.careLevel, 'medium')
  let s = H.mergeSettings({}, { autonomy: { care: true, careLevel: 'much', extra: 1 } })
  assert.equal(s.autonomy.care, true); assert.equal(s.autonomy.careLevel, 'much'); assert.ok(!('extra' in s.autonomy))
  s = H.mergeSettings(s, { autonomy: { careLevel: 'bogus' } })
  assert.equal(s.autonomy.care, true); assert.equal(s.autonomy.careLevel, 'much') // 垃圾档位不动原来的
  s = H.mergeSettings(s, { autonomy: { care: 'yes', careLevel: 9 } })
  assert.equal(s.autonomy.care, true); assert.equal(s.autonomy.careLevel, 'much')
  s = H.mergeSettings(s, { autonomy: { care: false } })
  assert.equal(s.autonomy.care, false); assert.equal(s.autonomy.careLevel, 'much')
  assert.equal(H.mergeSettings({}, { autonomy: { careLevel: 'little' } }).autonomy.careLevel, 'little')
})

await t('careOn: care + enabled + aware + aiControl + 绑定会话，缺一不可', () => {
  const mk = (o) => ({ aiControl: true, autonomy: { enabled: true, aware: true, care: true, ...o }, voice: { llm: { sessionId: 'session-s1' } } })
  assert.equal(P.careOn(mk({})), true)
  assert.equal(P.careOn(mk({ care: false })), false)
  assert.equal(P.careOn(mk({ aware: false })), false)
  assert.equal(P.careOn(mk({ enabled: false })), false)
  assert.equal(P.careOn({ ...mk({}), aiControl: false }), false)
  assert.equal(P.careOn({ ...mk({}), voice: { llm: { sessionId: '' } } }), false)
  assert.equal(P.careOn(null), false)
})

await t('isSilentReply / cleanSpoken:【不说】各种写法静默；引号剥掉、80 字截断', () => {
  for (const x of ['【不说】', '  【不说】  ', '【 不 说 】', '【不说】。', '"不说"', '「不说」', '（不说）', '不说', '我只回复【不说】', '']) {
    assert.equal(P.isSilentReply(x), true, JSON.stringify(x))
  }
  for (const x of ['今天也加油哦', '要歇会儿呀！', '我只回复【不】']) assert.equal(P.isSilentReply(x), false, JSON.stringify(x))
  assert.equal(P.cleanSpoken('「辛苦了」'), '辛苦了')
  assert.equal(P.cleanSpoken('  “多喝水”  '), '多喝水')
  assert.equal(P.cleanSpoken('『『双层』』'), '双层')
  assert.equal(P.cleanSpoken('第一行\n第二行'), '第一行 第二行')
  assert.equal(P.cleanSpoken('x'.repeat(100)).length, 80)
  assert.equal(P.cleanSpoken('“”'), '')
})

await t('quietWindowOf: 没配置用默认 23:30–07:00；配置了用配置；起止相同 = 关(退默认)', () => {
  assert.deepEqual(P.quietWindowOf({ quietHours: { start: '', end: '' } }), P.DEFAULT_QUIET)
  assert.deepEqual(P.quietWindowOf({}), P.DEFAULT_QUIET)
  assert.deepEqual(P.quietWindowOf({ quietHours: { start: '01:00', end: '09:00' } }), { start: '01:00', end: '09:00' })
  assert.deepEqual(P.quietWindowOf({ quietHours: { start: '08:00', end: '08:00' } }), P.DEFAULT_QUIET)
  assert.equal(P.inWindow(at(23, 40) && 23 * 60 + 40, '23:30', '07:00'), true)
  assert.equal(P.inWindow(6 * 60 + 30, '23:30', '07:00'), true)
  assert.equal(P.inWindow(12 * 60, '23:30', '07:00'), false)
})

await t('buildWakeText: 只有类别/时长/时刻，无程序名；含【不说】暗号与说明', () => {
  const T = at(21, 40)
  const text = P.buildWakeText({ type: 'long_work', spanMs: 115 * MIN }, { now: T, today: { 干活: 130, 看视频: 40 }, userLastSpokeAt: T - 3 * 3600_000, lastSpokeAt: T - 5.5 * 3600_000, spokeAnswered: true })
  assert.ok(text.includes('[桌宠·醒来看看]'))
  assert.ok(text.includes('21:40'))
  assert.ok(text.includes('她已经连续干活约 1 小时 55 分钟，中间没离开过'))
  assert.ok(text.includes('干活 2 小时 10 分'))
  assert.ok(text.includes('距离她上次和你说话'))
  assert.ok(text.includes('（她回了）'))
  assert.ok(text.includes('【不说】'))
  assert.ok(!text.includes('.exe') && !text.includes('D:\\'))
  const late = P.buildWakeText({ type: 'late_work' }, { now: T })
  assert.ok(late.includes('已经过了 23:30，她还在干活'))
  const back = P.buildWakeText({ type: 'back', awayMs: 65 * MIN }, { now: T })
  assert.ok(back.includes('她离开了约 1 小时 5 分钟，刚刚回到电脑前'))
  const play = P.buildWakeText({ type: 'long_play', spanMs: 130 * MIN }, { now: T })
  assert.ok(play.includes('她连续打游戏/看视频约 2 小时 10 分钟，现在切出来了'))
  const quiet = P.buildWakeText({ type: 'quiet_long', quietMs: 4.5 * 3600_000 }, { now: T })
  assert.ok(quiet.includes('约 4 小时 30 分钟没和你说话'))
})

// ------------------------------------------------------------------ 由头（evaluateTriggers）
await t('long_work: 90 min 边界；≥5 min 的离开/小过渡重置', () => {
  const T = at(14, 0)
  const segs = (rows) => segments(rows.slice().sort((a, b) => a.t - b.t), T)
  // 89 min：不触发
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 89, 'work')]), { now: T }), [])
  // 90 min：触发
  const hit = P.evaluateTriggers(segs([R(T, 90, 'work')]), { now: T })
  assert.equal(hit.length, 1); assert.equal(hit[0].type, 'long_work')
  // 中途 10 min away：重置
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 100, 'work'), R(T, 10, 'away'), R(T, 0, 'work')]), { now: T }), [])
  // 中途 2 min 别的状态（< 5 min）：不算离开，继续算连续
  const gap = P.evaluateTriggers(segs([R(T, 100, 'work'), R(T, 4, 'browsing'), R(T, 0, 'work')]), { now: T })
  assert.equal(gap.length, 1); assert.equal(gap[0].type, 'long_work')
  // 已触发过同一段（key 相同）不再触发
  const start = T - 100 * MIN
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 100, 'work')]), { now: T, state: { keys: { long_work: start } } }), [])
})

await t('late_work: 23:30 后仍在干活才触发，每天一次', () => {
  const T = at(23, 40)
  const segs = segments([R(T, 30, 'work')], T)
  const hit = P.evaluateTriggers(segs, { now: T, dayKey: '2026-11-12' })
  assert.ok(hit.some((x) => x.type === 'late_work'))
  assert.deepEqual(P.evaluateTriggers(segs, { now: T, dayKey: '2026-11-12', state: { marks: { late_work: '2026-11-12' } } }).filter((x) => x.type === 'late_work'), [])
  assert.ok(P.evaluateTriggers(segs, { now: T, dayKey: '2026-11-13' }).some((x) => x.type === 'late_work')) // 第二天恢复
  assert.deepEqual(P.evaluateTriggers(segments([R(at(22, 0), 30, 'work')], at(22, 0)), { now: at(22, 0) }).filter((x) => x.type === 'late_work'), [])
})

await t('back: 离开 ≥60 min，回来等 2 min、15 min 内有效；一次离开只提一次', () => {
  const T = at(14, 0)
  const segs = (rows) => segments(rows.slice().sort((a, b) => a.t - b.t), T)
  // 桌面 3 min → 离开 63 min → 回来 3 min：触发
  const hit = P.evaluateTriggers(segs([R(T, 69, 'other'), R(T, 66, 'away'), R(T, 3, 'other')]), { now: T })
  assert.equal(hit.length, 1); assert.equal(hit[0].type, 'back'); assert.ok(hit[0].awayMs >= 60 * MIN)
  // 刚坐下 1 min：还不说
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 61, 'other'), R(T, 60, 'away'), R(T, 1, 'other')]), { now: T }), [])
  // 回来 20 min：过时了
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 80, 'other'), R(T, 60, 'away'), R(T, 20, 'other')]), { now: T }), [])
  // 离开只有 30 min：不算
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 40, 'other'), R(T, 30, 'away'), R(T, 10, 'other')]), { now: T }), [])
  // 已触发过（key = 那段 away 的起点）
  const key = T - 66 * MIN
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 69, 'other'), R(T, 66, 'away'), R(T, 3, 'other')]), { now: T, state: { keys: { back: key } } }), [])
})

await t('long_play: 在游戏/视频里不打扰；连续 ≥2 h 且刚切出来才触发', () => {
  const T = at(20, 0)
  const segs = (rows) => segments(rows.slice().sort((a, b) => a.t - b.t), T)
  // 还在游戏里：不触发
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 130, 'gaming')]), { now: T }), [])
  // 连续 130 min 游戏，10 min 前切出来：触发
  const hit = P.evaluateTriggers(segs([R(T, 130, 'gaming'), R(T, 10, 'other')]), { now: T })
  assert.equal(hit.length, 1); assert.equal(hit[0].type, 'long_play')
  // 只有 70 min：不够
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 70, 'video'), R(T, 10, 'other')]), { now: T }), [])
  // 切出来太久（40 min）：不算「刚切出来」
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 160, 'gaming'), R(T, 40, 'other')]), { now: T }), [])
  // 游戏中切出来 5 min 又切回去（gaming_break 也算在玩）
  assert.deepEqual(P.evaluateTriggers(segs([R(T, 130, 'gaming'), R(T, 20, 'gaming_break'), R(T, 15, 'gaming')]), { now: T }), [])
})

await t('quiet_long: ≥4 h 没说话 + 在桌面上且平稳；每天一次', () => {
  const T = at(15, 0)
  const segs = segments([R(T, 30, 'other')], T)
  const hit = P.evaluateTriggers(segs, { now: T, userLastSpokeAt: T - 4 * 3600_000, dayKey: '2026-11-12' })
  assert.equal(hit[hit.length - 1].type, 'quiet_long') // 最低优先级，排最后
  // 只隔了 3 h：不触发
  assert.deepEqual(P.evaluateTriggers(segs, { now: T, userLastSpokeAt: T - 3 * 3600_000, dayKey: '2026-11-12' }), [])
  // 当天已提过：不触发
  assert.deepEqual(P.evaluateTriggers(segs, { now: T, userLastSpokeAt: T - 4 * 3600_000, dayKey: '2026-11-12', state: { marks: { quiet_long: '2026-11-12' } } }), [])
  // 在干活：不触发
  assert.deepEqual(P.evaluateTriggers(segments([R(T, 30, 'work')], T), { now: T, userLastSpokeAt: T - 4 * 3600_000, dayKey: '2026-11-12' }), [])
})

// ------------------------------------------------------------------ 硬闸（跑真 tick，全假依赖）
await t('闸1: 开关没开全 → 一个都不叫', async () => {
  for (const patch of [
    { autonomy: { care: false } },
    { autonomy: { aware: false } },
    { autonomy: { enabled: false } },
    { aiControl: false },
    { voice: { llm: { sessionId: '' } } },
  ]) {
    const w = world()
    w.settings = { aiControl: true, autonomy: { enabled: true, aware: true, care: true, careLevel: 'medium', quietHours: { start: '', end: '' } }, voice: { llm: { sessionId: 'session-s1' } }, ...patch }
    w.rows = [R(w.T, 100, 'work')]
    await w.p.tick()
    assert.equal(w.asks.length, 0, JSON.stringify(patch))
  }
})

await t('闸2a: 余额缓存不可用 / 低于阈值 → 停；缓存过期 = 未知不阻断；绝不为闸2发请求', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  // 低于阈值（CNY 5 < 10）
  writeFileSync(join(w.dir, 'balance.json'), JSON.stringify({ at: w.T, total: 5, currency: 'CNY', isAvailable: true }))
  writeFileSync(join(w.dir, 'balance-settings.json'), JSON.stringify({ threshold: 10 }))
  await w.p.tick(); assert.equal(w.asks.length, 0)
  // is_available = false
  writeFileSync(join(w.dir, 'balance.json'), JSON.stringify({ at: w.T, total: 500, currency: 'CNY', isAvailable: false }))
  await w.p.tick(); assert.equal(w.asks.length, 0)
  // 缓存过期（> 5 min）：未知 → 不阻断，正常叫醒
  writeFileSync(join(w.dir, 'balance.json'), JSON.stringify({ at: w.T - 6 * MIN, total: 5, currency: 'CNY', isAvailable: true }))
  await w.p.tick(); assert.equal(w.asks.length, 1)
  // 没有任何余额文件：也叫（不阻断）
  const w2 = world(); w2.rows = [R(w2.T, 100, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 1)
})

await t('闸2b: 额度类错误熔断 30 min → 2 h → 当天（指数退避）；成功一次就复位', async () => {
  // 爬梯度：连续三次额度错误（错误不消费由头，同一由头可连续失败）
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 502, body: { ok: false, message: 'followup 失败：Error 429 rate limit exceeded' } } }
  await w.p.tick()
  assert.equal(w.p.state().breakerLevel, 1)
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 1) // 熔断中，不再发
  w.adv(30 * MIN); await w.p.tick(); assert.equal(w.asks.length, 2) // 30 min 后解封，再错 → 2 h
  assert.equal(w.p.state().breakerLevel, 2)
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 2)
  w.adv(2 * 3600_000); await w.p.tick(); assert.equal(w.asks.length, 3) // 2 h 后解封，再错 → 当天
  assert.equal(w.p.state().breakerLevel, 3)
  w.adv(30 * MIN); await w.p.tick(); assert.equal(w.asks.length, 3)
  w.adv(3600_000); await w.p.tick(); assert.equal(w.asks.length, 3) // 当天一直熔断
  w.setT(at(10, 0, 13)); w.rows = [R(w.T, 100, 'work')] // 第二天
  w.relay.ask = async () => { w.asks.push({}); return { code: 200, body: { ok: true, reply: '【不说】' } } }
  await w.p.tick(); assert.equal(w.asks.length, 4) // 新的一天恢复
  // 成功一次就复位：复位后新的一次额度错误从 30 min 重新爬
  w.adv(46 * MIN); w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 402, body: { ok: false, message: '余额不足' } } }
  await w.p.tick(); assert.equal(w.asks.length, 5)
  assert.equal(w.p.state().breakerLevel, 1); assert.equal(w.p.state().breakerUntil > 0, true)
  w.adv(31 * MIN); w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 200, body: { ok: true, reply: '【不说】' } } }
  await w.p.tick(); assert.equal(w.asks.length, 6)
  assert.equal(w.p.state().breakerLevel, 0); assert.equal(w.p.state().breakerUntil, 0)
})

await t('闸2c: 连续 2 次普通失败也熔断 30 min', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 404, body: { ok: false, message: '会话不在线' } } }
  await w.p.tick(); assert.equal(w.p.state().fails, 1); assert.equal(w.p.state().breakerLevel, 0)
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 2)
  assert.equal(w.p.state().breakerUntil > 0, true) // 第 2 次 → 30 min
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 2)
  // 成功一次就复位
  w.adv(30 * MIN); w.relay.ask = async () => { w.asks.push({}); return { code: 200, body: { ok: true, reply: '好呀' } } }
  await w.p.tick(); assert.equal(w.asks.length, 3)
  assert.equal(w.p.state().fails, 0); assert.equal(w.p.state().breakerUntil, 0)
})

await t('闸3: 会话忙（relay 在途 / turn 开着）→ 跳过', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  w.pending.set('s1', {})
  await w.p.tick(); assert.equal(w.asks.length, 0)
  w.pending.clear()
  await w.p.tick(); assert.equal(w.asks.length, 1)
  const w2 = world(); w2.rows = [R(w2.T, 100, 'work')]
  w2.p.onEvent({ id: 'session-s1' }, { type: 'turn/start', data: { turn: 7 } })
  await w2.p.tick(); assert.equal(w2.asks.length, 0)
  w2.p.onEvent({ id: 'session-s1' }, { type: 'turn/end', data: { turn: 7 } })
  await w2.p.tick(); assert.equal(w2.asks.length, 1)
})

await t('闸4: away / 游戏 / 会议 / 视频 → 不叫醒', async () => {
  for (const state of ['away', 'gaming', 'gaming_break', 'meeting', 'video']) {
    const w = world(); w.rows = [R(w.T, 30, state)]
    await w.p.tick(); assert.equal(w.asks.length, 0, state)
  }
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick(); assert.equal(w.asks.length, 1) // work / other / browsing 可以
})

await t('闸5: 安静时段（默认 23:30–07:00）不叫，late_work 例外；配置的窗口照配置', async () => {
  // 清晨 06:00：在默认安静窗口里、又不在 late_work 的 23:30–05:00 里 → long_work 被挡
  const w = world({ start: at(6, 0) }); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick(); assert.equal(w.asks.length, 0)
  // 深夜 23:40 但由头是 late_work → 例外
  const w2 = world({ start: at(23, 40) }); w2.rows = [R(w2.T, 30, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 1)
  assert.ok(w2.asks[0].text.includes('已经过了 23:30'))
  // 用户配置了别的窗口：08:00 在 01:00–09:00 内 → 不叫
  const w3 = world({ start: at(8, 0) })
  w3.settings = { ...w3.settings, autonomy: { ...w3.settings.autonomy, quietHours: { start: '01:00', end: '09:00' } } }
  w3.rows = [R(w3.T, 100, 'work')]
  await w3.p.tick(); assert.equal(w3.asks.length, 0)
})

await t('闸6: 没回不追——说了话用户没理就不再叫；用户说话（任何入口）即解除；自己的叫醒消息不算', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick(); assert.equal(w.asks.length, 1)
  assert.equal(w.p.state().awaitReply, true)
  const wakeId = w.asks[0].opts.messageId
  w.adv(46 * MIN); await w.p.tick(); assert.equal(w.asks.length, 1) // 没回 → 不追
  // 自己的叫醒消息 echo 回来不算用户说话
  w.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: wakeId } })
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 1)
  // 用户真的说话了 → 解除（等过闸 9 的 5 min「刚聊过」再叫）
  w.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: 'user-msg-1' } })
  assert.equal(w.p.state().awaitReply, false)
  w.adv(6 * MIN); w.rows = [R(w.T, 100, 'work')]; await w.p.tick(); assert.equal(w.asks.length, 2)
  // noteUserActivity（信箱 / 桌宠输入条入口）同样解除
  const w2 = world(); w2.rows = [R(w2.T, 100, 'work')]
  w2.p.state().awaitReply = true
  w2.p.noteUserActivity()
  w2.adv(6 * MIN); w2.rows = [R(w2.T, 100, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 1)
})

await t('闸7: 间隔（silent 也占间隔）与每日「说话」上限（silent 不占）', async () => {
  const w = world({ level: 'little' }); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick(); assert.equal(w.asks.length, 1)
  w.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: 'u1' } })
  w.adv(60 * MIN); w.rows = [R(w.T, 100, 'work')]; await w.p.tick(); assert.equal(w.asks.length, 1) // little = 90 min 间隔
  w.adv(31 * MIN); w.rows = [R(w.T, 100, 'work')]; await w.p.tick(); assert.equal(w.asks.length, 2)
  // silent 只占间隔、不占每日「说话」配额
  const w2 = world(); w2.rows = [R(w2.T, 100, 'work')]; w2.setReply('【不说】')
  await w2.p.tick(); assert.equal(w2.asks.length, 1)
  assert.equal(w2.p.state().spokeCount, 0); assert.equal(w2.p.state().wakeCount, 1)
  w2.adv(46 * MIN); w2.rows = [R(w2.T, 100, 'work')]; await w2.p.tick(); assert.equal(w2.asks.length, 2) // 间隔过了就还可以叫（AI 自己决定不说）
  assert.equal(w2.p.state().spokeCount, 0)
  // 每日上限：medium 6 次「说话」
  const w3 = world(); w3.rows = [R(w3.T, 100, 'work')]
  for (let i = 0; i < 6; i++) {
    if (i) { w3.adv(46 * MIN); w3.rows = [R(w3.T, 100, 'work')] }
    await w3.p.tick()
    w3.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: 'u' + i } })
  }
  assert.equal(w3.asks.length, 6)
  w3.adv(46 * MIN); w3.rows = [R(w3.T, 100, 'work')]; await w3.p.tick()
  assert.equal(w3.asks.length, 6) // 第 7 次说话被每日上限挡住
})

await t('闸8: 单飞 + 宿主重启后状态恢复（间隔 / 熔断 / 没回不追）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-care-restart-'))
  const w = world({ dir }); w.rows = [R(w.T, 100, 'work')]
  let release = null
  w.relay.ask = (sid, text, content, opts) => { w.asks.push({ sid, text, opts }); return new Promise((done) => { release = done }) } // 挂住：模拟一轮在跑
  const first = w.p.tick()
  await new Promise((r) => setTimeout(r, 0)) // 让第一个 tick 走到 relay.ask
  const second = w.p.tick() // 单飞：第二个 tick 直接返回
  release({ code: 200, body: { ok: true, reply: '注意休息哦' } })
  await first; await second
  assert.equal(w.asks.length, 1)
  assert.equal(w.says.length, 1)
  // 重启：新实例从 proactive-state.json 恢复
  const w2 = world({ dir, start: w.T })
  w2.rows = [R(w2.T, 100, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 0) // 间隔没到 + awaitReply（没回不追）
  w2.adv(50 * MIN); await w2.p.tick(); assert.equal(w2.asks.length, 0) // 还在「没回不追」
  w2.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: 'user-1' } })
  w2.adv(6 * MIN); w2.rows = [R(w2.T, 100, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 1) // 用户说话后恢复
  // 熔断也恢复
  const w3 = world({ dir: mkdtempSync(join(tmpdir(), 'pp-care-restart2-')) }); w3.rows = [R(w3.T, 100, 'work')]
  w3.relay.ask = async () => { w3.asks.push({}); return { code: 502, body: { ok: false, message: '429 too many requests' } } }
  await w3.p.tick()
  const w4 = world({ dir: w3.dir, start: w3.T }); w4.rows = [R(w4.T, 100, 'work')]
  await w4.p.tick(); assert.equal(w4.asks.length, 0) // 熔断随状态文件恢复
})

await t('闸9: 桌宠在说话/听写 → 跳过；刚和用户聊过 5 min 内 → 跳过；桌宠不在线 → 不叫', async () => {
  for (const v of ['speaking', 'listening', 'thinking', 'hearing']) {
    const w = world({ petVoice: v }); w.rows = [R(w.T, 100, 'work')]
    await w.p.tick(); assert.equal(w.asks.length, 0, v)
  }
  const w = world({ petVoice: 'idle' }); w.rows = [R(w.T, 100, 'work')]
  w.p.onEvent({ id: 'session-s1' }, { type: 'user/message', data: { id: 'u1' } }) // 2 min 前
  w.adv(2 * MIN)
  await w.p.tick(); assert.equal(w.asks.length, 0)
  w.adv(4 * MIN)
  await w.p.tick(); assert.equal(w.asks.length, 1) // 6 min 后可以
  const w2 = world({ statusOk: false }); w2.rows = [R(w2.T, 100, 'work')]
  await w2.p.tick(); assert.equal(w2.asks.length, 0) // 桌宠没响应：叫了也白叫
})

// ------------------------------------------------------------------ 回复处理 / 隐私
await t('回复处理:【不说】静默丢弃；正常回复 say speak:true；截断 80 字', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick()
  assert.equal(w.says.length, 1)
  assert.deepEqual(w.says[0], { cmd: 'say', text: '今天也加油哦', speak: true })
  assert.ok(!w.says[0].text.includes('桌宠·醒来看看'))
  assert.equal(w.p.state().lastSpokeAt, w.T)
  const rows = readFileSync(join(w.dir, 'proactive.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows, [{ t: new Date(w.T).toISOString(), trigger: 'long_work', decision: 'spoke', chars: 6 }])
  // 不说
  const w2 = world(); w2.rows = [R(w2.T, 100, 'work')]; w2.setReply('【不说】')
  await w2.p.tick()
  assert.equal(w2.says.length, 0)
  const rows2 = readFileSync(join(w2.dir, 'proactive.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows2, [{ t: new Date(w2.T).toISOString(), trigger: 'long_work', decision: 'silent' }])
  // 超长截断 + 引号剥离
  const w3 = world(); w3.rows = [R(w3.T, 100, 'work')]; w3.setReply('「' + '呀'.repeat(90) + '」')
  await w3.p.tick()
  assert.equal(w3.says[0].text, '呀'.repeat(80))
  assert.equal(w3.says[0].speak, true)
})

await t('隐私: 叫醒包与日志里没有程序名 / 路径 / AI 原话', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work', 'secretgame.exe'), R(w.T, 50, 'work', 'evilcode.exe')]
  await w.p.tick()
  assert.ok(!w.asks[0].text.includes('secretgame') && !w.asks[0].text.includes('evilcode'))
  const raw = readFileSync(join(w.dir, 'proactive.jsonl'), 'utf8')
  assert.ok(!raw.includes('今天也加油哦') && !raw.includes('exe'))
  assert.ok(!w.asks[0].text.includes('D:\\') && !w.asks[0].text.includes('/'))
})

await t('409（会话忙竞态）不算失败也不算叫醒', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async (sid, text, content, opts) => { w.asks.push({ sid, text, opts }); return { code: 409, body: { ok: false, message: '上一句还没回完' } } }
  await w.p.tick()
  assert.equal(w.asks.length, 1)
  const s = w.p.state()
  assert.equal(s.lastWakeAt, 0); assert.equal(s.fails, 0); assert.equal(s.breakerLevel, 0)
  assert.ok(!existsSync(join(w.dir, 'proactive.jsonl')))
})

// ------------------------------------------------------------------ 挂接面
await t('pixelpet_status 带 care 只读字段（enabled / lastWakeAt / lastSpokeAt / pausedUntil）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-care-status-'))
  const w = world({ dir }); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick()
  const sent = []
  const st = makeTools({ dataDir: '.', enabled: () => true, send: async () => ({ ok: true, running: true, data: {} }), care: () => w.p.view() }).find((x) => x.name === 'pixelpet_status')
  const r = await st.execute({})
  assert.deepEqual(r.data.care, { enabled: true, lastWakeAt: w.T, lastSpokeAt: w.T, pausedUntil: null })
  // 熔断中 → pausedUntil 有值
  w.p.state().breakerLevel = 1; w.p.state().breakerUntil = w.T + 30 * MIN
  const r2 = await st.execute({})
  assert.equal(r2.data.care.pausedUntil, w.T + 30 * MIN)
})

await t('start/stop: 定时器能停；tick 在定时器外也可手动驱动', async () => {
  const w = world(); w.rows = [R(w.T, 100, 'work')]
  const stop = w.p.start()
  assert.equal(typeof stop, 'function')
  stop(); stop() // 幂等
})

await t('小修: userAt 持久化——重启后「4 小时没说话」「5 分钟刚聊过」照常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-care-userat-'))
  const w = world({ dir }); w.rows = [R(w.T, 100, 'work')]
  w.p.noteUserActivity() // 用户说话（信箱 / 输入条 / 会话都走这个）
  const T0 = w.T
  // 重启：新实例读同一份 proactive-state.json
  const w2 = world({ dir, start: T0 + 2 * MIN })
  assert.equal(w2.p.state().userAt, T0)
  w2.rows = [R(w2.T, 30, 'other')]
  await w2.p.tick(); assert.equal(w2.asks.length, 0) // 2 分钟前刚聊过 → 闸 9 挡住（重启不再失效）
  // 4 小时没再说话：quiet_long 由恢复的 userAt 触发（不用等用户先说一句）
  w2.setT(T0 + 4 * 3600_000 + 10 * MIN)
  w2.rows = [R(w2.T, 30, 'other')]
  await w2.p.tick()
  assert.equal(w2.asks.length, 1)
  assert.ok(w2.asks[0].text.includes('没和你说话'))
})

await t('小修: 熔断第 3 档跨天复位——第二天第一次失败只停 30 分钟', async () => {
  const w = world()
  w.rows = [R(w.T, 100, 'work')]
  w.relay.ask = async () => { w.asks.push({}); return { code: 502, body: { ok: false, message: '429 quota exceeded' } } }
  await w.p.tick(); assert.equal(w.p.state().breakerLevel, 1)
  w.adv(31 * MIN); await w.p.tick(); assert.equal(w.p.state().breakerLevel, 2)
  w.adv(121 * MIN); await w.p.tick(); assert.equal(w.p.state().breakerLevel, 3)
  assert.equal(w.p.state().breakerDay, P.dayKeyOf(w.T))
  // 跨天：进入新的一天把档位归零，第一次失败只停 30 分钟
  w.setT(at(10, 0, 13)); w.rows = [R(w.T, 100, 'work')]
  await w.p.tick()
  assert.equal(w.p.state().breakerLevel, 1)
  assert.equal(w.p.state().breakerDay, P.dayKeyOf(w.T)) // 升档必写 breakerDay（新一天）
  assert.equal(w.asks.length, 4) // 新一天的第一次失败
  w.adv(MIN); await w.p.tick(); assert.equal(w.asks.length, 4) // 30 分钟内不再发
  w.adv(30 * MIN); await w.p.tick(); assert.equal(w.asks.length, 5) // 解封后再错 → 2 h 档
  assert.equal(w.p.state().breakerLevel, 2)
})

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail ? 1 : 0)
