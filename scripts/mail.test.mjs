// Mailbox tests, run from scripts/host.test.mjs (shares its fake DSH ctx). No network: Agently is a fake CLI script.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InboxStore } from '../lib/inbox.js'
import { AgentlyBackend, LocalFileBackend, MAILBOX_OPS, MailError, isAuthFailure, mapAgentlyMessage, parseRetryAfter, splitMailBody } from '../lib/mail-backend.js'
import { MailService, relayPrompt, sanitizeMail } from '../lib/mail.js'
import { buildAgentlyGuide, OFFICIAL_SETUP_URL } from '../lib/agently-guide.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = join(HERE, 'fixtures', 'fake-agently-cli.mjs')
const E = (u) => u + String.fromCharCode(64) + 'example.com'   // no literal addresses in the repo
const tmp = (p) => mkdtempSync(join(tmpdir(), 'pp-mail-' + p + '-'))
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(15) } throw new Error('timed out waiting') }

function fakeAgently (scenario) {
  const dir = tmp('cli')
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  const calls = () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const make = (o = {}) => {
    process.env.FAKE_AGENTLY_DIR = dir
    return new AgentlyBackend({ workDir: join(dir, 'work'), command: process.execPath, prefixArgs: [FAKE_CLI], consent: () => true, backoffMs: [20, 20, 40], retryDelayMs: 5, ...o })
  }
  return { dir, calls, make, set: (s) => writeFileSync(join(dir, 'scenario.json'), JSON.stringify(s)) }
}

const FOOTER = '<div data-xmail_bot_mail_report="1">此邮件由 bot 通过 Agent Mail 自动发送。<a href="https://example.invalid/report?token=SECRETVALUE1234">举报</a></div>'
const msg = (id, at, body = '<div>你好呀</div>') => ({ message: { message_id: id, created_at: at, from: { email: E('someone'), name: 'S' }, subject: 's-' + id, body, body_format: 'HTML', attachments: [] } })

export async function runMailTests ({ t, H, fakeCtx, call }) {
  // ------------------------------------------------------------------ InboxStore
  await t('inbox: add / idempotent key / stats / read / state.json', () => {
    const d = tmp('store'); const s = new InboxStore(d)
    const a = s.addOut({ subject: '早', body: '**hi**', key: 'k1', createdAt: '2026-11-10T01:00:00.000Z' })
    assert.equal(a.created, true)
    assert.equal(s.addOut({ subject: 'x', body: 'y', key: 'k1' }).created, false)
    s.addOut({ body: 'second', createdAt: '2026-11-10T02:00:00.000Z' })
    const i = s.addIn({ body: '在吗', via: 'window', key: 'w1' })
    assert.equal(i.item.status, 'queued'); assert.equal(s.addIn({ body: 'dup', key: 'w1' }).created, false)
    assert.throws(() => s.addOut({ body: '  ' }), /body/)
    let st = s.stats()
    assert.deepEqual([st.unread, st.total, st.latestUnreadAt, st.pendingIn, st.newForPet], [2, 3, '2026-11-10T02:00:00.000Z', 1, 1])
    assert.deepEqual(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).unread, 2)
    assert.equal(s.markRead([a.item.id]), 1); assert.equal(s.markRead([a.item.id]), 0)
    assert.equal(s.markRead('all'), 1); st = s.stats(); assert.equal(st.unread, 0); assert.equal(st.latestUnreadAt, null)
    assert.equal(s.list()[0].dir, 'in'); assert.equal(s.list({ dir: 'out' }).length, 2)
    assert.throws(() => s.update(i.item.id, { status: 'weird' }))
    s.update(i.item.id, { status: 'replied' })
    const again = new InboxStore(d); assert.equal(again.get(i.item.id).status, 'replied')   // persisted
    assert.equal(again.addOut({ body: 'z', key: 'k1' }).created, false)
  })
  await t('inbox: corrupt file set aside, not overwritten', () => {
    const d = tmp('corrupt'); writeFileSync(join(d, 'inbox.json'), '{not json')
    const s = new InboxStore(d); s.addOut({ body: 'x' })
    assert.ok(readdirSync(d).some((f) => f.startsWith('inbox.json.corrupt-')))
    assert.equal(s.stats().total, 1)
  })
  await t('inbox: star / filter / delete / clear keeps starred; deleted keys stay out', () => {
    const d = tmp('manage'); const s = new InboxStore(d)
    const a = s.addOut({ subject: 'a', body: 'A', createdAt: '2026-11-10T01:00:00.000Z' }).item
    const b = s.addOut({ body: 'B', createdAt: '2026-11-10T02:00:00.000Z' }).item
    const c = s.addIn({ body: 'C', key: 'agently:m1', createdAt: '2026-11-10T03:00:00.000Z' }).item
    assert.equal(s.star(a.id).starred, true)                           // toggle on
    assert.equal(s.star(c.id, true).starred, true); assert.equal(s.star(c.id, true).starred, true)
    assert.equal(s.star(c.id).starred, undefined)                       // toggle off
    assert.equal(s.star('nope'), null)
    s.star(c.id, true)
    assert.equal(s.stats().starred, 2)
    assert.deepEqual(s.list({ starred: true }).map((x) => x.id), [c.id, a.id])
    assert.equal(new InboxStore(d).get(a.id).starred, true)            // persisted
    assert.equal(s.remove([c.id, 'nope']), 1); assert.equal(s.remove([c.id]), 0)
    assert.equal(s.addIn({ body: 'C again', key: 'agently:m1' }).created, false)   // re-delivery cannot resurrect it
    assert.equal(s.stats().starred, 1)
    assert.equal(s.clear(), 1)                                          // b goes, starred a stays
    assert.deepEqual(s.list().map((x) => x.id), [a.id])
    assert.equal(s.clear(), 0)
    assert.equal(s.clear({ keepStarred: false }), 1); assert.equal(s.stats().total, 0)
    assert.equal(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).total, 0)
    assert.equal(b.id.startsWith('o-'), true)
  })
  await t('inbox: archive never pushes out a starred item', () => {
    const d = tmp('arch-star'); const s = new InboxStore(d, { maxItems: 2 })
    const old = s.addOut({ body: 'old', createdAt: '2026-01-01T00:00:00.000Z' }).item
    s.markRead('all'); s.star(old.id, true)
    s.addOut({ body: 'b', createdAt: '2026-11-01T00:00:00.000Z' }); s.markRead('all')
    s.addOut({ body: 'c', createdAt: '2026-11-02T00:00:00.000Z' })
    assert.ok(s.get(old.id)); assert.equal(s.stats().total, 2)
  })
  await t('inbox: over the cap archives settled items first', () => {
    const d = tmp('arch'); const s = new InboxStore(d, { maxItems: 5 })
    const keep = s.addOut({ body: 'unread-old', createdAt: '2026-01-01T00:00:00.000Z' }).item
    for (let n = 0; n < 7; n++) { const it = s.addOut({ body: 'r' + n, createdAt: '2026-02-0' + (n + 1) + 'T00:00:00.000Z' }).item; s.markRead([it.id]) }
    assert.equal(s.stats().total, 5)
    assert.ok(s.get(keep.id), 'unread letter kept over read ones')
    const arch = readFileSync(join(d, 'archive-202602.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(arch.length, 3); assert.ok(arch.every((x) => x.read))
  })

  // ------------------------------------------------------------------ LocalFileBackend
  await t('local backend: drop folder -> messages, files moved, attachments, outbox', async () => {
    // 文件 mtime 常常比 Date.now() 还新（本机 400 次里 277 次），settleMs 0 + 单趟 scan 会被判「还没落定」
    // 而漏掉文件；生产侧是轮询、下一趟会补上，这里把时钟拨快 1 分钟让单趟就稳
    const d = tmp('local'); const b = new LocalFileBackend(d, { settleMs: 0, now: () => Date.now() + 60_000 })
    mkdirSync(b.dropDir, { recursive: true })
    writeFileSync(join(b.dropDir, 'a.md'), '# 标题\n\n正文一行')
    writeFileSync(join(b.dropDir, 'pic.png'), 'PNGDATA')
    writeFileSync(join(b.dropDir, 'n.json'), JSON.stringify({ subject: 'J', body: 'with file', attachments: ['att.txt', '../escape.txt'] }))
    writeFileSync(join(b.dropDir, 'att.txt'), 'hello')
    writeFileSync(join(b.dropDir, 'half.tmp'), 'x')
    const got = []
    assert.equal(await b.scan(async (m) => got.push(m)), 3)
    const by = Object.fromEntries(got.map((m) => [m.subject || m.attachments[0].filename, m]))
    assert.equal(by['标题'].body, '正文一行')
    assert.deepEqual(by.J.attachments.map((x) => x.filename), ['att.txt'])
    assert.equal(by['pic.png'].body, '')
    assert.deepEqual(readdirSync(b.dropDir).filter((f) => !f.startsWith('.')).sort(), ['half.tmp'])
    assert.equal(readFileSync(await b.fetchAttachment(by.J.id, 'att.txt'), 'utf8'), 'hello')
    assert.equal(readFileSync(await b.fetchAttachment(by['pic.png'].id, 'pic.png'), 'utf8'), 'PNGDATA')
    await assert.rejects(b.fetchAttachment(by.J.id, '../../inbox.json'), (e) => e.code === 'not-found')
    // handler failure keeps the file for the next pass
    writeFileSync(join(b.dropDir, 'b.txt'), 'again')
    await b.scan(async () => { throw new Error('nope') }).catch(() => {})
    assert.ok(existsSync(join(b.dropDir, 'b.txt')))
    const r = await b.send('', '主题', '正文')
    assert.match(r.ref, /^local:/)
    assert.match(readFileSync(join(b.outDir, readdirSync(b.outDir)[0]), 'utf8'), /# 主题\n\n正文/)
    assert.deepEqual(await b.capabilities(), { canSend: true, canReceive: true, maxAttachments: 10, maxTotalBytes: 20 * 1024 * 1024, remoteOps: { star: false, delete: false, clear: false, read: false } })
    assert.equal(await b.health(), 'ok')
  })
  await t('local backend: watch() picks up a dropped file', async () => {
    const d = tmp('lw'); const b = new LocalFileBackend(d, { settleMs: 0, pollMs: 30 })
    const got = []; const stop = await b.watch(async (m) => got.push(m))
    writeFileSync(join(b.dropDir, 'x.txt'), 'ping')
    utimesSync(join(b.dropDir, 'x.txt'), new Date(Date.now() - 5000), new Date(Date.now() - 5000))
    await until(() => got.length === 1); stop()
    assert.equal(got[0].body, 'ping')
  })

  // ------------------------------------------------------------------ mail body parsing
  await t('mail body: new part / footer kept once / quoted chain / tokens redacted', () => {
    const html = '<div>新的话<br>第二行</div>' + FOOTER + '<div id="divRplyFwdMsg">From: pet</div><div>旧信' + FOOTER + '</div>'
    const p = splitMailBody(html, 'HTML')
    assert.equal(p.text, '新的话\n第二行')
    assert.match(p.footer, /自动发送/)
    assert.match(p.quoted, /旧信/)
    assert.ok(p.html.includes('data-xmail_bot_mail_report'), 'footer stays in stored html')
    assert.equal((p.html.match(/data-xmail_bot_mail_report/g) || []).length, 2)
    assert.ok(!p.html.includes('SECRETVALUE1234'))
    assert.deepEqual(splitMailBody('plain text', 'plain'), { text: 'plain text', footer: '', quoted: '', html: '' })
    const m = mapAgentlyMessage(msg('msg_1', '2026-11-10T06:51:02Z'))
    assert.equal(m.id, 'msg_1'); assert.equal(m.body, '你好呀'); assert.equal(m.from.email, E('someone'))
    assert.equal(parseRetryAfter('HTTP 429 Retry-After: 30'), 30000); assert.equal(parseRetryAfter('x'), null)
  })

  // ------------------------------------------------------------------ AgentlyBackend (fake CLI)
  await t('agently: send -> relative body file, --confirmed, plain, cleaned up; consent + daily gate', async () => {
    const f = fakeAgently({})
    const off = f.make({ consent: () => false })
    await assert.rejects(off.send(E('u'), 's', 'b'), (e) => e instanceof MailError && e.code === 'consent')
    assert.equal(f.calls().length, 0)
    const b = f.make({ dailyLimit: 2 })
    const r = await b.send(E('u'), '主题\n换行', '正文 **md**')
    assert.equal(r.ref, 'msg_sent_0')
    const c = f.calls()[0]
    assert.deepEqual(c.args.slice(0, 6), ['message', '+send', '--to', E('u'), '--subject', '主题 换行'])
    assert.ok(c.args.includes('--confirmed')); assert.equal(c.args[c.args.indexOf('--body-format') + 1], 'plain')
    assert.equal(c.relative, true); assert.equal(c.body, '正文 **md**')
    assert.deepEqual(readdirSync(join(f.dir, 'work')).filter((x) => x.startsWith('body-')), [])
    await b.send(E('u'), 's', 'b')
    assert.deepEqual(b.quota(), { used: 2, limit: 2, left: 0 })
    await assert.rejects(b.send(E('u'), 's', 'b'), (e) => e.code === 'daily-limit')
    assert.equal(f.calls().length, 2)
    assert.equal(f.make({ dailyLimit: 2 }).quota().used, 2, 'counter persisted')
    assert.equal(new AgentlyBackend({ workDir: tmp('d') }).dailyLimit, 45)
  })
  await t('agently: exit codes -> retry 1/4, fail 6, auth 3, rate 7', async () => {
    let f = fakeAgently({ send: [1, 4, 0] })
    assert.equal((await f.make().send(E('u'), 's', 'b')).ref, 'msg_sent_2'); assert.equal(f.calls().length, 3)
    f = fakeAgently({ send: [1, 1, 1] })
    await assert.rejects(f.make().send(E('u'), 's', 'b'), (e) => e.code === 'failed'); assert.equal(f.calls().length, 3)
    f = fakeAgently({ send: [6] })
    await assert.rejects(f.make().send(E('u'), 's', 'b'), (e) => e.code === 'invalid'); assert.equal(f.calls().length, 1)
    f = fakeAgently({ send: [3] })
    const b3 = f.make()
    await assert.rejects(b3.send(E('u'), 's', 'b'), (e) => e.code === 'auth-required')
    assert.equal(b3.state, 'auth-required')
    await assert.rejects(b3.send(E('u'), 's', 'b'), (e) => e.code === 'auth-required'); assert.equal(f.calls().length, 1)
    f = fakeAgently({ send: [7], sendStderr: 'rate limited, Retry-After: 30' })
    const b7 = f.make()
    await assert.rejects(b7.send(E('u'), 's', 'b'), (e) => e.code === 'rate-limited' && e.retryAfterMs === 30000)
    await assert.rejects(b7.send(E('u'), 's', 'b'), (e) => e.code === 'rate-limited'); assert.equal(f.calls().length, 1)
    const missing = new AgentlyBackend({ workDir: tmp('m'), command: join(tmp('nocli'), 'agently-cli.exe'), consent: () => true })
    await assert.rejects(missing.send(E('u'), 's', 'b'), (e) => e.code === 'not-installed')
  })
  await t('agently: watch NDJSON, watchdog restart, backfill after gap, dedupe', async () => {
    const f = fakeAgently({
      watch: [
        { lines: [msg('m1', '2026-11-10T06:00:00Z'), 'not json'], exit: 1 },
        { lines: [msg('m1', '2026-11-10T06:00:00Z'), msg('m2', '2026-11-10T06:02:00Z')], hang: true },
      ],
      list: { data: { messages: [{ message_id: 'm3', created_at: '2026-11-10T06:01:00Z' }, { message_id: 'm2', created_at: '2026-11-10T06:02:00Z' }] } },
      read: { m3: { message_id: 'm3', created_at: '2026-11-10T06:01:00Z', from: { email: E('a') }, subject: 'gap', body: 'missed one', body_format: 'plain' } },
    })
    const b = f.make(); const got = []; const states = []
    b.onState = (s) => states.push(s)
    const stop = await b.watch((m) => got.push(m))
    await until(() => got.length >= 3)
    await sleep(80)
    assert.deepEqual(got.map((m) => m.id).sort(), ['m1', 'm2', 'm3'])
    assert.equal(got.find((m) => m.id === 'm3').body, 'missed one')
    assert.equal(b.restarts, 1)
    assert.ok(states.includes('degraded') && b.state === 'active')
    const list = f.calls().find((c) => c.args[1] === '+list')
    // 补收的起点是基线（2026-11-16 起首次启动就写，见下面「首次启动写基线」），不再依赖「收到过第一封信」
    assert.deepEqual(list.args.slice(0, 5), ['message', '+list', '--dir', 'inbox', '--after'])
    assert.match(list.args[5], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    assert.equal(f.calls().filter((c) => c.args[1] === '+watch')[0].args.join(' '), 'message +watch --msg-format full')
    stop()
    assert.equal(b.state, 'disabled'); assert.equal(b.child, null)
  })
  // 2026-11-16：授权掉线不再静默（lead 复核：只认 EXIT.AUTH / type=auth；探测退避 5→15→60）
  await t('agently: 只有授权失败才算掉线（网络 / 通用 / CLI 不存在都不是）', async () => {
    assert.equal(isAuthFailure(3, ''), true)                                                      // 退出码 3
    assert.equal(isAuthFailure(1, '{"error":{"type":"auth","message":"authorization required"}}'), true)   // type=auth
    assert.equal(isAuthFailure(4, 'connect ETIMEDOUT'), false)
    assert.equal(isAuthFailure(1, 'boom'), false)
    assert.equal(isAuthFailure(-1, '{"error":{"type":"auth"}}'), false)                           // CLI 都没有，别叫人去授权
    let f = fakeAgently({ watch: [{ lines: [], exit: 4 }, { lines: [], exit: 1 }, { lines: [], hang: true }] })
    let b = f.make(); const states = []
    b.onState = (s) => states.push(s)
    let stop = await b.watch(() => {})
    await sleep(240)
    assert.ok(!states.includes('auth-required'), '网络/普通错误不该进攻权态：' + states.join('>'))
    assert.equal(b.probeTimer, null, '不进退避探测')
    stop()
    b = new AgentlyBackend({ workDir: tmp('nocli'), command: join(tmp('nobin'), 'agently-cli.exe'), consent: () => true, backoffMs: [10] })
    const st2 = []; b.onState = (s) => st2.push(s)
    await b.watch(() => {})
    await sleep(120)
    assert.ok(!st2.includes('auth-required'), 'CLI 不存在也不该进攻权态：' + st2.join('>'))
    assert.ok(st2.includes('unconfigured'))
    b.stop()
  })
  await t('agently: 首次启动写基线；掉线后探测按 30→300 退避，恢复即重启 watcher', async () => {
    const f = fakeAgently({ watch: [{ lines: [], hang: true }] })
    const b = f.make()
    assert.equal(b.disk.lastSeenAt, '')
    const stop = await b.watch(() => {})
    await until(() => !!b.disk.lastSeenAt)
    assert.match(b.disk.lastSeenAt, /^\d{4}-\d\d-\d\dT/)                 // 基线 = 启动时刻
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'work', 'state.json'), 'utf8')).lastSeenAt, b.disk.lastSeenAt)
    assert.equal(f.calls().filter((c) => c.args[1] === '+list').length, 0, '第一次启动没有更早的信可补')
    stop()

    const g = fakeAgently({ watch: [{ lines: [], exit: 3 }], authStatus: 3 })
    const bad = g.make({ probeBackoffMs: [30, 300] })
    const nProbes = () => g.calls().filter((c) => c.args[0] === 'auth' && c.args[1] === 'status').length
    const bstop = await bad.watch(() => {})
    await until(() => bad.state === 'auth-required')
    await until(() => bad.probeAttempt === 1, 3000)           // 探测是起子进程，等它真的回来再数
    assert.equal(nProbes(), 1)
    assert.equal(bad.droppedAt.length > 0, true)
    await sleep(150)                                          // 第二次要等 300ms（已退避），此时还没到
    assert.equal(nProbes(), 1, '退了才开始下一次')
    await until(() => bad.probeAttempt === 2, 3000)           // 每次探测是起一个子进程，等它回来再数
    assert.equal(nProbes(), 2)
    assert.equal(g.calls().filter((c) => c.args[1] === '+watch').length, 1, 'auth-required 期间不起 watcher')
    bstop()
  })
  await t('agently: health 成功但 watcher 没跑 -> 必须拉起，active 一定有子进程', async () => {
    const f = fakeAgently({ watch: [{ lines: [], hang: true }], authStatus: 0 })
    const b = f.make()
    assert.equal(await b.health(), 'ok')
    assert.equal(b.child, null, '没 watch 过就不该有进程')
    b.stopped = false                                   // 插件在跑，但 watcher 掉了（掉线后恢复的现场）
    assert.equal(await b.health(), 'ok')
    assert.ok(b.child, 'health 成功必须真的把 watcher 拉起来')
    assert.equal(b.state, 'active', '进程在跑才能说已连接')
    await until(() => f.calls().filter((c) => c.args[1] === '+watch').length === 1)
    b.stop()
    assert.equal(b.state, 'disabled')
  })
  await t('agently: 掉线期间的信恢复后全进箱；已删除的不回来；分页翻完 + 200 封上限提示', async () => {
    // 一页 2 封、翻三页；其中 m2 用户删过，不该再出现
    const page = (ids, more, next) => ({ data: { messages: ids.map((id) => ({ message_id: id, created_at: '2026-11-16T0' + id.slice(1) + ':00:00Z', body: 'b-' + id, body_format: 'plain' })), pagination: { has_more: more, next_cursor: next } } })
    const f = fakeAgently({ watch: [{ lines: [], hang: true }], lists: [page(['m1', 'm2'], true, 'c2'), page(['m3', 'm4'], true, 'c3'), page(['m5'], false, '')] })
    mkdirSync(join(f.dir, 'work'), { recursive: true })
    writeFileSync(join(f.dir, 'work', 'state.json'), JSON.stringify({ lastSeenAt: '2026-11-15T00:00:00Z' }))
    const store = new InboxStore(tmp('bf'))
    const deliver = (msg) => store.addIn({ body: msg.body, subject: msg.subject, from: msg.from, via: 'agently', key: 'agently:' + msg.id, createdAt: msg.createdAt })
    const b = f.make()
    b.onMessage = deliver
    await b._backfill()
    assert.deepEqual(store.list({ dir: 'in' }).map((x) => x.body).sort(), ['b-m1', 'b-m2', 'b-m3', 'b-m4', 'b-m5'])
    const lists = f.calls().filter((c) => c.args[1] === '+list')
    assert.equal(lists.length, 3)
    assert.ok(lists[1].args.includes('--cursor') && lists[1].args.includes('c2'))
    assert.deepEqual(b.backfillInfo.truncated, false)
    assert.equal(b.backfillInfo.added, 5)
    // 删除后换一个「新进程」再补一次：key 还在 InboxStore 里，不能再冒出来
    store.removeItems([store.list({ dir: 'in' }).find((x) => x.body === 'b-m2').id])
    const fresh = f.make()
    fresh.onMessage = (msg) => store.addIn({ body: msg.body, subject: msg.subject, from: msg.from, via: 'agently', key: 'agently:' + msg.id, createdAt: msg.createdAt })
    await fresh._backfill()
    assert.equal(store.list({ dir: 'in' }).some((x) => x.body === 'b-m2'), false, '删掉的信不会被补回来')
    // 200 封上限：超出的算「还有更早的信没补收」，不是假装补齐
    const rows = Array.from({ length: 60 }, (_, i) => ({ message_id: 'x' + i, created_at: '2026-11-16T00:' + String(i).padStart(2, '0') + ':00Z', body: 'b', body_format: 'plain' }))
    const g = fakeAgently({ watch: [{ lines: [], hang: true }], list: { data: { messages: rows, pagination: { has_more: true, next_cursor: 'c2' } } } })
    mkdirSync(join(g.dir, 'work'), { recursive: true })
    writeFileSync(join(g.dir, 'work', 'state.json'), JSON.stringify({ lastSeenAt: '2026-11-15T00:00:00Z' }))
    const cap = g.make({ backfillMax: 30, backfillPage: 30, backfillPages: 2 })
    const got = []
    cap.onMessage = (m) => got.push(m.id)
    await cap._backfill()
    assert.equal(got.length, 30)
    assert.equal(cap.backfillInfo.truncated, true)
    assert.equal(cap.backfillInfo.fetched, 60)
    // 提示要跨插件重载留着：写进 state.json，重载后没有 backfillInfo 也照样说有更早的信没补
    assert.equal(JSON.parse(readFileSync(join(g.dir, 'work', 'state.json'), 'utf8')).backfillTruncated, true)
    const reloaded = g.make()
    assert.deepEqual(reloaded.backfillState, { at: '', fetched: 0, added: 0, truncated: true })
    reloaded.backfillMax = 999
    reloaded.onMessage = () => {}
    await reloaded._backfill()                                        // 补齐一次就消掉提示
    assert.equal(reloaded.backfillState.truncated, false)
    assert.equal(JSON.parse(readFileSync(join(g.dir, 'work', 'state.json'), 'utf8')).backfillTruncated, false)
  })
  await t('agently: 重新授权 -> 链接交给浏览器（不回显、不落盘），第二次点击不重复起进程', async () => {
    const urls = []
    const f = fakeAgently({ login: { lines: ['用微信扫码授权：https://agent.qq.com/auth?code=SECRET123&state=x  （15 分钟内有效）'], hang: true }, authStatus: 0 })
    const b = f.make({ openUrl: (u) => { urls.push(u); return true } })
    const r = await b.reauth({ urlWaitMs: 3000 })
    assert.equal(r.ok, true); assert.equal(r.opened, true)
    assert.deepEqual(urls, ['https://agent.qq.com/auth?code=SECRET123&state=x'])
    assert.equal(JSON.stringify(r).includes('SECRET123'), false, '链接不回给页面')
    assert.equal((await b.reauth({ urlWaitMs: 50 })).running, true)
    assert.equal(f.calls().filter((c) => c.args[0] === 'auth' && c.args[1] === 'login').length, 1)
    // 链接 15 分钟就过期：再点时如果那个进程已经太老，重开一个，别把按钮变成死胡同
    const again2 = await b.reauth({ urlWaitMs: 3000, reloginAfterMs: 0 })
    assert.equal(again2.started, true)
    assert.equal(f.calls().filter((c) => c.args[0] === 'auth' && c.args[1] === 'login').length, 2)
    b.stop()
    assert.equal(b.login, null, 'stop() 收掉登录进程')
  })
  await t('agently: watch exit 3 pauses (no restart spin)', async () => {
    const f = fakeAgently({ watch: [{ lines: [], exit: 3 }] })
    const b = f.make(); const stop = await b.watch(() => {})
    await until(() => b.state === 'auth-required'); await sleep(120)
    assert.equal(f.calls().filter((c) => c.args[1] === '+watch').length, 1)
    stop()
  })
  await t('agently: health / me / fetchAttachment', async () => {
    let f = fakeAgently({ authStatus: 0, me: { aliases: [{ email: E('pet'), is_primary: true }] } })
    let b = f.make()
    assert.equal(await b.health(), 'ok')
    assert.deepEqual(await b.me(), { ok: true, aliases: [{ email: E('pet'), primary: true }] })
    const p = await b.fetchAttachment('msg_1', 'att_9')
    assert.equal(readFileSync(p, 'utf8'), 'png'); assert.ok(p.startsWith(join(f.dir, 'work')))
    f = fakeAgently({ authStatus: 3 }); b = f.make()
    assert.equal(await b.health(), 'auth-required'); assert.equal(b.state, 'auth-required')
    assert.deepEqual(await b.capabilities(), { canSend: true, canReceive: true, maxAttachments: 50, maxTotalBytes: 20 * 1024 * 1024, dailySendLimit: 45, remoteOps: { star: false, delete: false, clear: false, read: false } })
  })

  // ------------------------------------------------------------------ MailService
  const svc = (settings, relay, extra = {}) => new MailService({ dataDir: tmp('svc'), relay, settings: () => settings, localOpts: { settleMs: 0, pollMs: 50 }, ...extra })
  await t('service: write -> relay -> reply letter; no session / offline -> failed; retry', async () => {
    const asked = []
    const settings = { voice: { llm: { sessionId: '' } }, mail: { agently: { enabled: false } } }
    const m = svc(settings, { ask: async (sid, text) => { asked.push([sid, text]); return sid === 'gone' ? { code: 404, body: { ok: false } } : { code: 200, body: { ok: true, reply: '收到啦 **好**' } } } })
    const a = m.write('今天好累', 'k1')
    await m._queue
    assert.equal(m.store.get(a.id).status, 'failed'); assert.equal(m.store.get(a.id).error, 'no-session')
    settings.voice.llm.sessionId = 'session-s1'
    m.retry(a.id); await m._queue
    const it = m.store.get(a.id)
    assert.equal(it.status, 'replied'); assert.equal(it.aiSeen, true)
    const letter = m.store.get(it.replyId)
    assert.equal(letter.body, '收到啦 **好**'); assert.equal(letter.replyTo, a.id); assert.equal(letter.read, false)
    assert.match(asked[0][1], /今天好累/); assert.match(asked[0][1], /不用再调用 pixelpet_mail_send/)
    assert.equal(m.write('dup', 'k1').id, a.id)
    settings.voice.llm.sessionId = 'gone'
    const b = m.write('喂'); await m._queue
    assert.equal(m.store.get(b.id).error, 'offline')
    assert.equal(m.retry(letter.id), null)
    assert.match(relayPrompt({ via: 'agently', subject: 'S', body: 'B', attachments: [{ filename: 'p.png' }] }), /邮箱.*\n主题：S\n附件：p\.png/)
  })
  await t('service: sendOut mirrors through Agently when on; idempotent agently receive', async () => {
    const f = fakeAgently({ watch: [{ lines: [], hang: true }] })
    const settings = { voice: { llm: { sessionId: 's1' } }, mail: { agently: { enabled: true, consentAt: 'x', to: '' } } }
    const relay = { ask: async () => ({ code: 200, body: { ok: true, reply: 'r' } }) }
    const m = svc(settings, relay, { agentlyFactory: (o) => f.make({ ...o, command: process.execPath }) })
    await m.start()
    assert.equal(m.agentlyStatus().enabled, true)
    let r = await m.sendOut({ subject: 'hi', body: 'b1' })
    assert.deepEqual(r.ext, { ok: false, code: 'no-address' })
    settings.mail.agently.to = E('me')
    r = await m.sendOut({ subject: 'hi', body: 'b2' })
    assert.equal(r.ext.ok, true); assert.equal(m.store.get(r.item.id).ext.ok, true)
    assert.ok(f.calls().some((c) => c.args[1] === '+send' && c.args.includes(E('me'))))
    const mm = mapAgentlyMessage(msg('mx', '2026-11-10T07:00:00Z'))
    await m.receive(mm, 'agently'); await m.receive(mm, 'agently'); await m._queue
    const ins = m.store.list({ dir: 'in' })
    assert.equal(ins.length, 1); assert.equal(ins[0].via, 'agently'); assert.equal(ins[0].from.email, E('someone'))
    assert.equal(ins[0].status, 'replied')
    // reply to a mail that came by mail goes back out by mail too
    await until(() => f.calls().filter((c) => c.args[1] === '+send').length === 2)
    settings.mail.agently.enabled = false
    await m.syncAgently(); assert.equal(m.agently, null)
    r = await m.sendOut({ body: 'b3' }); assert.equal(r.ext, undefined)
    m.stop()
  })
  await t('service: manage star / delete / clear / read stays local; adapters mirror nothing upstream', async () => {
    const svc = new MailService({ dataDir: tmp('svc-manage'), relay: { ask: async () => ({ code: 404 }) }, settings: () => ({}) })
    const x = svc.store.addOut({ body: 'x' }).item; const y = svc.store.addOut({ body: 'y' }).item
    let r = svc.manage('star', { id: x.id }); assert.equal(r.ok, true); assert.equal(r.scope, 'local'); assert.equal(r.item.starred, true); assert.equal(r.stats.starred, 1)
    assert.equal(svc.manage('star', { id: 'nope' }).code, 'not-found')
    assert.equal(svc.manage('nuke').code, 'bad-op')
    r = svc.manage('read', { all: true }); assert.equal(r.changed, 2); assert.equal(r.stats.unread, 0)
    r = svc.manage('delete', { ids: [y.id, 7] }); assert.equal(r.changed, 1)
    r = svc.manage('clear', {}); assert.equal(r.changed, 0); assert.equal(r.stats.total, 1)
    r = svc.manage('clear', { keepStarred: false }); assert.equal(r.changed, 1); assert.equal(r.stats.total, 0)
    assert.deepEqual([...MAILBOX_OPS], ['star', 'delete', 'clear', 'read'])
    const fa = fakeAgently({})
    for (const caps of [await new LocalFileBackend(tmp('caps')).capabilities(), await fa.make().capabilities()]) {
      for (const op of MAILBOX_OPS) assert.equal(caps.remoteOps[op], false, op)
    }
    assert.equal(fa.calls().length, 0)                                  // asking capabilities never runs the CLI
  })
  // 2026-11-16：掉线不再静默 —— 一次掉线一次气泡；恢复后掉线期间的信全部进箱并回信
  await t('service: 掉线气泡一次一发；恢复后掉线期间的信进箱、回信未读（state.json）', async () => {
    const S = { voice: { llm: { sessionId: 's1' } }, mail: { agently: { enabled: true, consentAt: 'x', to: '', address: '' } } }
    const lost = []
    const f = fakeAgently({ watch: [{ lines: [], exit: 3 }, { lines: [], exit: 3 }, { lines: [], hang: true }], authStatus: 0 })
    const m = new MailService({
      dataDir: tmp('svc-drop'), relay: { ask: async () => ({ code: 200, body: { ok: true, reply: '收到了' } }) },
      settings: () => S, localOpts: { settleMs: 0, pollMs: 50 },
      agentlyFactory: (o) => f.make({ ...o, command: process.execPath, prefixArgs: [FAKE_CLI], probeBackoffMs: [40, 40, 40] }),
      onAuthLost: () => lost.push(Date.now()),
    })
    await m.start()
    await until(() => m.agentlyStatus().state === 'auth-required')
    assert.equal(lost.length, 1, '第一次掉线冒一次气泡')
    // 掉线期间到达的三封信只存在于服务端，恢复后才被补收
    f.set({ watch: [{ lines: [], exit: 3 }, { lines: [], exit: 3 }, { lines: [], hang: true }], authStatus: 0, lists: [{ data: { messages: ['m1', 'm2', 'm3'].map((id, i) => ({ message_id: id, created_at: '2026-11-16T0' + (i + 1) + ':00:00Z', body: '信' + id, body_format: 'plain' })), pagination: { has_more: false } } }] })
    await until(() => m.agentlyStatus().state === 'active')
    await until(() => m.store.list({ dir: 'in' }).length === 3)
    await m._queue
    const ins = m.store.list({ dir: 'in' })
    assert.deepEqual(ins.map((x) => x.body).sort(), ['信m1', '信m2', '信m3'])
    assert.ok(ins.every((x) => x.via === 'agently' && x.status === 'replied'))
    const st = JSON.parse(readFileSync(join(m.dir, 'state.json'), 'utf8'))
    assert.ok(st.unread > 0, '回信未读 -> 邮筒会升旗'); assert.ok(st.latestUnreadAt)
    // 恢复后又掉一次：再发一次；但一次掉线仍然只有一次
    await until(() => lost.length === 2, 4000)
    await sleep(150)
    assert.equal(lost.length, 2)
    m.stop()
  })
  await t('service: address 空时第一次连通用 +me 回填；用户填过就不动', async () => {
    const me = { aliases: [{ email: E('pet'), is_primary: true }] }
    const wrote = []
    const S = { voice: { llm: { sessionId: '' } }, mail: { agently: { enabled: true, consentAt: 'x', address: '' } } }
    const f = fakeAgently({ watch: [{ lines: [], hang: true }], me })
    const m = new MailService({
      dataDir: tmp('svc-addr'), relay: { ask: async () => ({ code: 404 }) }, settings: () => S,
      agentlyFactory: (o) => f.make({ ...o, command: process.execPath, prefixArgs: [FAKE_CLI] }), onAddress: (e) => wrote.push(e),
    })
    await m.start()
    await until(() => wrote.length === 1)
    assert.deepEqual(wrote, [E('pet')])
    m.stop()

    const wrote2 = []
    const S2 = { voice: { llm: { sessionId: '' } }, mail: { agently: { enabled: true, consentAt: 'x', address: E('mine') } } }
    const f2 = fakeAgently({ watch: [{ lines: [], hang: true }], me })
    const m2 = new MailService({
      dataDir: tmp('svc-addr2'), relay: { ask: async () => ({ code: 404 }) }, settings: () => S2,
      agentlyFactory: (o) => f2.make({ ...o, command: process.execPath, prefixArgs: [FAKE_CLI] }), onAddress: (e) => wrote2.push(e),
    })
    await m2.start(); await sleep(150)
    assert.deepEqual(wrote2, [], '用户填过就不覆盖')
    m2.stop()
  })
  await t('settings: mail sanitising needs consent, rejects bad address / command', () => {
    let s = sanitizeMail(undefined, { agently: { enabled: true, to: 'bad', command: 'x"y' } })
    assert.equal(s.agently.enabled, false); assert.equal(s.agently.to, ''); assert.equal(s.agently.command, '')
    s = sanitizeMail(s, { agently: { enabled: true, consent: true, to: E('me') } })
    assert.equal(s.agently.enabled, true); assert.ok(s.agently.consentAt); assert.equal(s.agently.to, E('me'))
    s = sanitizeMail(s, { agently: { consent: false } }); assert.equal(s.agently.enabled, false)
    assert.equal(H.mergeSettings({}, { mail: { agently: { enabled: true } } }).mail.agently.enabled, false)
  })
  await t('guide: official URL + commands, no account, no copied skill text', () => {
    const g = buildAgentlyGuide({ settingsUrl: 'http://127.0.0.1:3080/dsh-pixel-pet/' })
    assert.ok(g.includes(OFFICIAL_SETUP_URL))
    assert.ok(g.includes('npm install -g @tencent-qqmail/agently-cli'))
    assert.ok(g.includes('--skill agently-mail -a'))
    assert.ok(!/[A-Za-z0-9._%+-]+@agent\.qq\.com/.test(g), 'no address')
    assert.match(g, /不会替我注册/)
  })

  // ------------------------------------------------------------------ routes + tools through the host
  const data = tmp('host')
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: data })
  await call(g.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-s1' } } } })
  await t('routes: mailbox page + assets', async () => {
    const r = await call(g.route, 'GET', '/mailbox'); assert.equal(r.status, 200); assert.ok(r.raw.toString().includes('mailbox.js'))
    assert.equal((await call(g.route, 'GET', '/mailbox.css')).status, 200)
    assert.equal((await call(g.route, 'GET', '/mailbox.js')).status, 200)
    assert.equal((await call(g.route, 'GET', '/api/thumb/furniture/mailbox')).status, 200)
    // the letter time is laid out in flow (floated), not pinned over the first line of the body
    const css = (await call(g.route, 'GET', '/mailbox.css')).raw.toString()
    assert.doesNotMatch(css, /\.letter time\s*\{[^}]*position:\s*absolute/)
    assert.match(css, /\.letter \.side\s*\{[^}]*float:\s*right/)
    const html = (await call(g.route, 'GET', '/mailbox')).raw.toString()
    for (const id of ['readAll', 'starOnly', 'clear', 'confirm', 'cfKeepBox']) assert.ok(html.includes('id="' + id + '"'), id)
    assert.match(html, /id="cfKeepBox" type="checkbox" checked/)
  })
  await t('routes: write -> pointed session -> reply letter; read; retry; cross-origin refused', async () => {
    const w = await call(g.route, 'POST', '/api/mail/write', { body: { body: '  晚上好  ', key: 'abc' } })
    assert.equal(w.status, 200); assert.equal(w.json.item.body, '晚上好'); assert.equal(w.json.item.key, undefined)
    assert.equal((await call(g.route, 'POST', '/api/mail/write', { body: { body: ' ' } })).status, 400)
    const list = await until(async () => { const r = await call(g.route, 'GET', '/api/mail'); return r.json.items.some((x) => x.dir === 'out') && r })
    const letter = list.json.items.find((x) => x.dir === 'out')
    assert.equal(letter.body, '在的'); assert.equal(list.json.stats.unread, 1); assert.equal(list.json.session, true)
    assert.equal(list.json.items.find((x) => x.dir === 'in').status, 'replied')
    assert.match(g.agent.calls.at(-1).content[0].text, /晚上好/)
    assert.equal(JSON.parse(readFileSync(join(data, 'mailbox', 'state.json'), 'utf8')).unread, 1)
    assert.equal((await call(g.route, 'GET', '/api/state')).json.mail.unread, 1)
    const rd = await call(g.route, 'POST', '/api/mail/read', { body: { all: true } }); assert.equal(rd.json.unread, 0); assert.equal(rd.json.changed, 1)
    assert.equal((await call(g.route, 'GET', '/api/mail/unread')).json.unread, 0)
    assert.equal((await call(g.route, 'POST', '/api/mail/retry', { body: { id: 'nope' } })).status, 404)
    assert.equal((await call(g.route, 'POST', '/api/mail/write', { body: { body: 'x' }, headers: { origin: 'http://evil.test' } })).status, 403)
  })
  await t('routes: Agently guide view / send into the pointed session', async () => {
    const r = await call(g.route, 'GET', '/api/mail/agently/guide'); assert.ok(r.json.text.includes(OFFICIAL_SETUP_URL))
    const n = g.agent.calls.length
    const s = await call(g.route, 'POST', '/api/mail/agently/guide/send', { body: {} })
    assert.equal(s.status, 200); assert.equal(g.agent.calls.length, n + 1); assert.match(g.agent.calls[n].content[0].text, /Agently Mail/)
    await call(g.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: '' } } } })
    assert.equal((await call(g.route, 'POST', '/api/mail/agently/guide/send', { body: {} })).status, 400)
    await call(g.route, 'POST', '/api/settings', { body: { voice: { llm: { sessionId: 'session-s1' } } } })
  })
  await t('routes: Agently 重新授权把链接交给系统浏览器，页面拿不到链接；address 由 +me 回填进设置', async () => {
    const d2 = tmp('reauth')
    const urls = []
    const f2 = fakeAgently({
      watch: [{ lines: [], hang: true }], authStatus: 0,
      me: { aliases: [{ email: E('pet'), is_primary: true }] },
      login: { lines: ['请用微信扫码：https://agent.qq.com/auth?code=SECRET999&state=y  （15 分钟内有效）'], hang: true },
    })
    const g2 = fakeCtx()
    H.apply(g2.ctx, {
      dataDir: d2, openUrl: (u) => { urls.push(u); return true },
      agentlyFactory: (o) => f2.make({ ...o, command: process.execPath, prefixArgs: [FAKE_CLI], probeBackoffMs: [40, 40, 40] }),
    })
    const on = await call(g2.route, 'POST', '/api/settings', { body: { mail: { agently: { enabled: true, consent: true } } } })
    assert.equal(on.json.settings.mail.agently.enabled, true)
    await until(async () => (await call(g2.route, 'GET', '/api/state')).json.mail.agently.state === 'active', 4000)
    // 第一次连通后 address 由 +me 回填（用户没填过）
    const st1 = await until(async () => {
      const r = await call(g2.route, 'GET', '/api/state')
      return String(r.json.settings.mail.agently.address || '').includes(String.fromCharCode(64)) ? r : null
    }, 4000)
    assert.equal(st1.json.settings.mail.agently.address, E('pet'))
    const r = await call(g2.route, 'POST', '/api/mail/agently/reauth', { body: {} })
    assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.opened, true)
    assert.deepEqual(urls, ['https://agent.qq.com/auth?code=SECRET999&state=y'])
    assert.equal(JSON.stringify(r.json).includes('SECRET999'), false, '链接不回给页面')
    assert.equal((await call(g2.route, 'POST', '/api/mail/agently/reauth', { body: {}, headers: { origin: 'http://evil.test' } })).status, 403)
    for (const e of g2.effects) if (typeof e === 'function') e()
  })
  const runTool = (name, args = {}) => g.tools.reg.get(name).execute(args, {})

  await t('tools: pixelpet_mail_send raises the flag; pixelpet_mail_list reads + marks seen', async () => {
    const r = await runTool('pixelpet_mail_send', { subject: '提醒', body: '- 喝水\n- 起来走走' })
    assert.equal(r.ok, true); assert.equal(r.data.unread, 1); assert.equal(r.data.external, undefined)
    assert.equal(JSON.parse(readFileSync(join(data, 'mailbox', 'state.json'), 'utf8')).unread, 1)
    assert.equal((await runTool('pixelpet_mail_send', { body: '  ' })).ok, false)
    const l1 = await runTool('pixelpet_mail_list', { unseenOnly: true })
    assert.equal(l1.ok, true); assert.equal(l1.data.unreadByUser, 1)
    const l2 = await runTool('pixelpet_mail_list', {})
    assert.ok(l2.data.messages.length >= 1); assert.equal(l2.data.messages[0].body, '晚上好')
    assert.equal(l2.data.messages[0].status, 'replied')
    assert.equal((await runTool('pixelpet_mail_list', { unseenOnly: true })).data.messages.length, 0)
    const keep = g.tools.reg.get('pixelpet_mail_send')
    await call(g.route, 'POST', '/api/settings', { body: { aiControl: false } })
    assert.match((await keep.execute({ body: 'x' }, {})).message, /关闭/)
    await call(g.route, 'POST', '/api/settings', { body: { aiControl: true } })
  })
  await t('routes: star -> starred filter -> delete -> clear keeps starred; cross-origin refused', async () => {
    const list = await call(g.route, 'GET', '/api/mail')
    const letter = list.json.items.find((x) => x.dir === 'out')
    const st = await call(g.route, 'POST', '/api/mail/star', { body: { id: letter.id, on: true } })
    assert.equal(st.status, 200); assert.equal(st.json.item.starred, true); assert.equal(st.json.item.key, undefined); assert.equal(st.json.scope, 'local')
    assert.equal((await call(g.route, 'POST', '/api/mail/star', { body: { id: 'nope' } })).status, 404)
    const only = await call(g.route, 'GET', '/api/mail?starred=1')
    assert.deepEqual(only.json.items.map((x) => x.id), [letter.id]); assert.equal(only.json.stats.starred, 1)
    const note = list.json.items.find((x) => x.dir === 'in')
    const del = await call(g.route, 'POST', '/api/mail/delete', { body: { ids: [note.id] } }); assert.equal(del.json.changed, 1)
    assert.equal((await call(g.route, 'GET', '/api/mail')).json.items.some((x) => x.id === note.id), false)
    await call(g.route, 'POST', '/api/mail/write', { body: { body: '再来一封', key: 'abd' } })
    await until(async () => (await call(g.route, 'GET', '/api/mail')).json.items.some((x) => x.body === '再来一封' && x.status === 'replied'))
    const cl = await call(g.route, 'POST', '/api/mail/clear', { body: {} }); assert.ok(cl.json.changed >= 2)
    assert.deepEqual((await call(g.route, 'GET', '/api/mail')).json.items.map((x) => x.id), [letter.id])
    assert.equal((await call(g.route, 'POST', '/api/mail/clear', { body: {}, headers: { origin: 'http://evil.test' } })).status, 403)
    await call(g.route, 'POST', '/api/mail/star', { body: { id: letter.id, on: false } })
  })
  for (const e of g.effects) if (typeof e === 'function') e()
}
