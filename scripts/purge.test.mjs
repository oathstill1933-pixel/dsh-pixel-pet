// node scripts/purge.test.mjs — 真正的删除：lib/purge.js（安全检查）、lib/cleanup.js（分类 / 导出 / 清除全部）、host 路由。
// 全部用临时目录；refusal 用例注入一个「被调用就失败」的 rm，所以即使检查有漏洞也不会真的动家目录 / 插件目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { PassThrough } from 'node:stream'
import * as H from '../lib/host.js'
import { CONFIRM_WORD, buildExport, buildIcs, createCleanup } from '../lib/cleanup.js'
import { PLUGIN_DIR, forbiddenReason, measure, measureAsync, purge, purgeAll } from '../lib/purge.js'
import { readZipEntry, readZipNames, zipBuffer } from '../lib/zip.js'

process.env.PIXELPET_NO_AUTO_INSTALL = '1'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}
const mk = (prefix = 'pp-purge-') => mkdtempSync(join(tmpdir(), prefix))
const put = (file, text = 'x'.repeat(100)) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const never = () => { throw new Error('rm 不该被调用') }
const winOnly = process.platform === 'win32'

// ------------------------------------------------------------------ purge()：拒绝
await t('purge refuses: root itself, outside the root, .. traversal, empty and NUL targets', () => {
  const base = mk(); const root = join(base, 'data'); const outside = join(base, 'outside')
  put(join(root, 'a', 'f.txt')); put(join(outside, 'keep.txt'))
  const opts = { roots: [root], rm: never }
  assert.equal(purge(root, opts).code, 'refused')                              // 根本身
  assert.equal(purge(outside, opts).code, 'refused')                           // 根外
  assert.equal(purge(join(root, '..', 'outside'), opts).code, 'refused')       // .. 穿越
  assert.equal(purge(join(root, 'a', '..', '..', 'outside', 'keep.txt'), opts).code, 'refused')
  assert.equal(purge('', opts).code, 'refused')
  assert.equal(purge(join(root, 'a\0b'), opts).code, 'refused')
  assert.equal(purge(join(root, 'a'), { roots: [], rm: never }).code, 'refused')   // 没有允许的根
  assert.ok(existsSync(join(root, 'a', 'f.txt')) && existsSync(join(outside, 'keep.txt')))
})

await t('forbiddenReason: drive root, Users, Users\\<name>, home, .dsh, plugin dir and its parents', () => {
  const driveRoot = parse(tmpdir()).root
  assert.equal(forbiddenReason(driveRoot), '盘符根')
  assert.equal(forbiddenReason(join(driveRoot, 'Users')), '用户目录')
  assert.equal(forbiddenReason(join(driveRoot, 'Users', 'someone')), '用户目录')
  assert.equal(forbiddenReason(homedir()) !== '', true)
  assert.equal(forbiddenReason(join(tmpdir(), 'x', '.dsh', 'cache')), '.dsh')
  assert.equal(forbiddenReason(PLUGIN_DIR), '插件目录')
  assert.equal(forbiddenReason(dirname(PLUGIN_DIR)), '插件目录')          // 插件目录的上级
  assert.equal(forbiddenReason(join(tmpdir(), 'pp-fine')), '')
})

await t('purge refuses forbidden roots and forbidden targets even when the root list would allow them', () => {
  const driveRoot = parse(tmpdir()).root
  for (const bad of [driveRoot, join(driveRoot, 'Users'), homedir(), PLUGIN_DIR, dirname(PLUGIN_DIR)]) {
    const r = purge(join(bad, 'whatever'), { roots: [bad], rm: never })
    assert.equal(r.code, 'refused', bad)                                       // 根本身就不许当根
  }
  const base = mk(); const root = join(base, 'data')
  put(join(root, '.dsh', 'x.txt'))
  assert.equal(purge(join(root, '.dsh'), { roots: [root], rm: never }).code, 'refused')   // 根里面的 .dsh
  assert.ok(existsSync(join(root, '.dsh', 'x.txt')))
  assert.equal(purge(PLUGIN_DIR, { roots: [root], rm: never }).code, 'refused')
})

// ------------------------------------------------------------------ purge()：链接 / junction
await t('purge: a junction pointing outside the root is removed as a link, the outside files stay', () => {
  const base = mk(); const root = join(base, 'data'); const outside = join(base, 'outside')
  put(join(outside, 'keep.txt'), 'precious'); mkdirSync(root, { recursive: true })
  symlinkSync(outside, join(root, 'link'), winOnly ? 'junction' : 'dir')
  const r = purge(join(root, 'link'), { roots: [root] })
  assert.equal(r.ok, true)
  assert.equal(existsSync(join(root, 'link')), false)
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'precious')
})

await t('purge: a link nested inside the target is not followed', () => {
  const base = mk(); const root = join(base, 'data'); const outside = join(base, 'outside')
  put(join(outside, 'deep', 'keep.txt'), 'precious'); put(join(root, 'dir', 'own.txt'))
  symlinkSync(outside, join(root, 'dir', 'inner'), winOnly ? 'junction' : 'dir')
  const m = measure(join(root, 'dir'))
  assert.equal(m.files, 1, 'measure 不跟链接')
  const r = purge(join(root, 'dir'), { roots: [root] })
  assert.equal(r.ok, true)
  assert.equal(existsSync(join(root, 'dir')), false)
  assert.equal(readFileSync(join(outside, 'deep', 'keep.txt'), 'utf8'), 'precious')
})

await t('purge: a path that goes THROUGH a link to the outside is refused (realpath)', () => {
  const base = mk(); const root = join(base, 'data'); const outside = join(base, 'outside')
  put(join(outside, 'keep.txt'), 'precious'); mkdirSync(root, { recursive: true })
  symlinkSync(outside, join(root, 'link'), winOnly ? 'junction' : 'dir')
  assert.equal(purge(join(root, 'link', 'keep.txt'), { roots: [root] }).code, 'refused')
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'precious')
})

// ------------------------------------------------------------------ purge()：占用
await t('purge: a failing delete is reported as busy, never as success', () => {
  const base = mk(); const root = join(base, 'data')
  put(join(root, 'models', 'm.bin'))
  const r = purge(join(root, 'models'), { roots: [root], rm: () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e } })
  assert.deepEqual([r.ok, r.code], [false, 'busy'])
  assert.ok(existsSync(join(root, 'models', 'm.bin')))
  // 悄悄什么都没删（rm 成功返回但文件还在）同样不能报成功
  const r2 = purge(join(root, 'models'), { roots: [root], rm: () => {} })
  assert.deepEqual([r2.ok, r2.code], [false, 'busy'])
})

await t('purge: a directory some process is sitting in -> busy, files that are still there are still there', async () => {
  if (!winOnly) return
  const base = mk(); const root = join(base, 'data'); const held = join(root, 'held')
  put(join(held, 'a.txt')); mkdirSync(held, { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: held, stdio: 'ignore', windowsHide: true })
  try {
    await new Promise((r) => setTimeout(r, 400))
    const r = purge(held, { roots: [root] })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'busy')
    assert.ok(existsSync(held), '被占用的目录还在，没有谎报已删')
  } finally { child.kill(); await new Promise((r) => setTimeout(r, 300)) }
  assert.equal(purge(held, { roots: [root] }).ok, true, '进程退出后能删')
})

await t('measure / measureAsync agree and ignore missing paths; purgeAll stops at the first failure', async () => {
  const base = mk(); const root = join(base, 'data')
  put(join(root, 'a', '1.bin'), 'x'.repeat(10)); put(join(root, 'a', 'b', '2.bin'), 'x'.repeat(20)); put(join(root, 'c.bin'), 'x'.repeat(5))
  assert.deepEqual(measure(join(root, 'a')), { exists: true, bytes: 30, files: 2 })
  assert.deepEqual(await measureAsync(join(root, 'a')), { exists: true, bytes: 30, files: 2 })
  assert.deepEqual(measure(join(root, 'nope')), { exists: false, bytes: 0, files: 0 })
  const r = purgeAll([join(root, 'a'), join(base, 'outside'), join(root, 'c.bin')], { roots: [root] })
  assert.equal(r.ok, false); assert.equal(r.code, 'refused'); assert.equal(r.done.length, 1)
  assert.ok(existsSync(join(root, 'c.bin')))
})

// ------------------------------------------------------------------ 数据目录样板
function fixture () {
  const base = mk('pp-clean-')
  const data = join(base, 'dsh-pixel-pet'); const music = join(base, 'pye-music')
  const clap = join(music, 'models', 'clap')
  const d = (...p) => join(data, ...p)
  put(d('models', 'qwen3-tts-engine', 'engine.bin'), 'e'.repeat(1000)); put(d('models', 'qwen3-tts-model', 'model.bin'), 'm'.repeat(2000))
  put(d('models', 'speaker-model', 'cam.onnx'), 's'.repeat(500)); put(d('models', 'progress.json'), '{}')
  put(d('pylibs', 'py312', 'lib.py'), 'p'.repeat(300)); put(d('tts-cache', 'say-1.wav'), 'w'.repeat(200))
  put(d('music', 'analysis', 'a.json'), '{}'); put(d('music', 'lyrics-cache', 'l.json'), '{}'); put(d('music', 'local.json'), '{"paths":["C:/songs/a.mp3"]}')
  put(d('music', 'history.jsonl'), '{}\n'); put(d('music', 'clap.json'), '{"enabled":true}')
  put(d('music', 'pet-playlist.json'), '[{"title":"七里香"}]'); put(d('music', 'consent.json'), '{"a":true}')
  put(clap + '/hf/config.json', '{}'); put(clap + '/label_emb.npy', 'n'.repeat(400)); put(clap + '/labels_meta.json', '{}')
  put(join(music, 'models', 'other-model', 'keep.bin'), 'k'); put(join(music, 'listen-venv', 'python.exe'), 'py')
  put(d('reading', 'webview', 'EBWebView', 'Default', 'cookies'), 'c'.repeat(700)); put(d('reading', 'sessions.json'), '{"sessions":[]}')
  put(d('reading', 'prefs.json'), '{"keep":true}'); put(d('reading', 'window.json'), '{}'); put(d('reading', 'doc1.json'), '{"highlights":[{"text":"划词"}]}')
  put(d('calendar', 'events.json'), JSON.stringify({ v: 1, items: [
    { id: 'e1', title: '妈妈生日, 记得买花', kind: 'birthday', date: '2026-12-01', repeat: 'yearly', note: '蛋糕;花' },
    { id: 'e2', title: '交稿', kind: 'todo', date: '2026-11-20', time: '18:30', repeat: 'none' },
  ] }))
  put(d('calendar', 'sources.json'), '{}')
  put(d('diary', '2026-11.jsonl'), JSON.stringify({ id: 'dy-1', at: '2026-11-14T22:10:00+08:00', date: '2026-11-14', mood: '开心', text: '今天陪她听了歌' }) + '\n')
  put(d('mailbox', 'inbox.json'), JSON.stringify({ v: 1, items: [{ id: 'o-1', dir: 'out', subject: '晚安', body: '早点睡', createdAt: '2026-11-14T15:00:00Z' }], keys: [] }))
  put(d('mailbox', 'files', 'o-1', 'pic.png'), 'png')
  put(d('voices', 'clone-0123456789', 'voice.json'), '{"name":"我的声音"}'); put(d('voices', 'clone-0123456789', 'ref.wav'), 'wav')
  put(d('voiceprint', 'p.bin'), 'vp'); put(d('packs', 'store', 'x', '1.0.0', 'pack.json'), '{}'); put(d('runtime', 'python', 'python.exe'), 'py')
  put(d('settings.json'), '{}'); put(d('last-host.txt'), '127.0.0.1:3080')
  put(join(base, 'sentinel.txt'), 'outside everything')
  return { base, data, music, clap, d }
}
function hooks (log, extra = {}) {
  return {
    petRunning: () => extra.petRunning === true,
    stopPet: () => log.push('stopPet'), startPet: () => log.push('startPet'),
    stopInstaller: () => log.push('stopInstaller'), stopMusic: () => log.push('stopMusic'),
    stopReading: () => log.push('stopReading'), resetReading: () => log.push('resetReading'),
    stopWriters: () => log.push('stopWriters'), markPurged: () => log.push('markPurged'),
    autoInstall: (on) => log.push('autoInstall:' + on), patchSettings: (p) => log.push('patch:' + JSON.stringify(p)),
  }
}
const left = (dir) => { try { return readdirSync(dir).sort() } catch { return null } }

// ------------------------------------------------------------------ 分类删除
await t('category voice: engine, model, pylibs, tts-cache gone; speaker model and everything else stays; pet stopped and brought back', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log, { petRunning: true }) })
  const before = (await c.sizes())
  assert.equal(before.voice, 1000 + 2000 + 2 + 300 + 200)
  const r = await c.deleteCategory('voice')
  assert.equal(r.ok, true); assert.equal(r.freed, before.voice)
  assert.deepEqual(left(fx.d('models')), ['speaker-model'])
  assert.equal(existsSync(fx.d('pylibs')), false); assert.equal(existsSync(fx.d('tts-cache')), false)
  assert.equal((await c.sizes()).voice, 0)
  assert.deepEqual(log, ['stopPet', 'stopInstaller', 'autoInstall:false', 'startPet'])
  assert.ok(existsSync(fx.d('settings.json')) && existsSync(fx.d('voices', 'clone-0123456789', 'ref.wav')))
})

await t('category speaker: only models/speaker-model', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log) })
  assert.equal((await c.sizes()).speaker, 500)
  assert.equal((await c.deleteCategory('speaker')).ok, true)
  assert.deepEqual(left(fx.d('models')), ['progress.json', 'qwen3-tts-engine', 'qwen3-tts-model'])
  assert.deepEqual(log, ['stopInstaller', 'autoInstall:false'])
})

await t('category listen: CLAP contents + music caches go, pet playlist / consent / song folders / listen venv stay, clap switched off', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log) })
  const s = await c.sizes()
  assert.ok(s.clap > 400 && s.listen > s.clap)
  const r = await c.deleteCategory('listen')
  assert.equal(r.ok, true)
  assert.deepEqual(left(fx.d('music')), ['consent.json', 'pet-playlist.json'])
  assert.deepEqual(left(fx.clap), [])                                                // 目录里的内容清空
  assert.ok(existsSync(join(fx.music, 'models', 'other-model', 'keep.bin')) && existsSync(join(fx.music, 'listen-venv', 'python.exe')))
  assert.ok(log.includes('stopMusic') && log.includes('patch:{"listen":{"clap":false}}'))
})

await t('category reading: webview + session + prefs go; kept highlights stay and are counted', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log) })
  const s = await c.sizes()
  assert.equal(s.notes, 1); assert.ok(s.reading >= 700)
  assert.equal((await c.deleteCategory('reading')).ok, true)
  assert.deepEqual(left(fx.d('reading')), ['doc1.json'])
  assert.ok(log.includes('stopReading') && log.includes('resetReading'))
})

await t('category records: calendar and diary gone, mailbox / voices untouched; unknown category refused', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log) })
  assert.equal((await c.deleteCategory('records')).ok, true)
  assert.equal(existsSync(fx.d('calendar')), false); assert.equal(existsSync(fx.d('diary')), false)
  assert.ok(existsSync(fx.d('mailbox', 'inbox.json')) && existsSync(fx.d('voices')))
  assert.equal((await c.deleteCategory('../x')).code, 'bad_category')
  assert.equal((await c.deleteCategory('all')).code, 'bad_category')
})

await t('category delete: a process still holding the folder -> busy, nothing reported as freed', async () => {
  if (!winOnly) return
  const fx = fixture(); const log = []
  const held = fx.d('models', 'qwen3-tts-engine')
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: held, stdio: 'ignore', windowsHide: true })
  try {
    await new Promise((r) => setTimeout(r, 400))
    const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log), retries: 1, retryMs: 50 })
    const r = await c.deleteCategory('voice')
    assert.equal(r.ok, false); assert.equal(r.code, 'busy'); assert.match(r.message, /关掉桌宠/)
    assert.ok(existsSync(held))
    assert.equal(log.includes('autoInstall:false'), false, '没删成功就不改自动安装的标记')
  } finally { child.kill(); await new Promise((r) => setTimeout(r, 300)) }
})

// ------------------------------------------------------------------ 导出
await t('export records: .ics has both events with RRULE / DTSTART / escaping; diary .md is readable; zip is valid', () => {
  const fx = fixture()
  const zip = buildExport(fx.data, 'records', new Date('2026-11-16T00:00:00Z'))
  assert.deepEqual(readZipNames(zip).sort(), ['日程.ics', '日记.md'])
  const ics = readZipEntry(zip, '日程.ics').toString('utf8')
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /END:VCALENDAR\r\n$/)
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2)
  assert.match(ics, /DTSTART;VALUE=DATE:20261201/); assert.match(ics, /RRULE:FREQ=YEARLY/); assert.match(ics, /DTSTART:20261120T183000/)
  assert.ok(ics.replace(/\r\n /g, '').includes('SUMMARY:妈妈生日\\, 记得买花'))
  assert.ok(ics.replace(/\r\n /g, '').includes('蛋糕\\;花'))
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line)
  const md = readZipEntry(zip, '日记.md').toString('utf8')
  assert.match(md, /## 2026-11-14/); assert.match(md, /22:10（开心） 今天陪她听了歌/)
})

await t('export all: adds letters, clone voices and reading records (not the webview); empty data still gives a valid zip', () => {
  const fx = fixture()
  const names = readZipNames(buildExport(fx.data, 'all'))
  assert.ok(names.includes('信件.md')); assert.ok(names.includes('信件附件/o-1/pic.png'))
  assert.ok(names.includes('克隆音色/clone-0123456789/ref.wav')); assert.ok(names.includes('阅读记录/doc1.json'))
  assert.ok(!names.some((n) => n.includes('webview')))
  const mail = readZipEntry(buildExport(fx.data, 'all'), '信件.md').toString('utf8')
  assert.match(mail, /桌宠写给我/); assert.match(mail, /早点睡/)
  const empty = buildExport(mk(), 'all')
  assert.deepEqual(readZipNames(empty), ['空.txt'])
  assert.deepEqual(readZipNames(zipBuffer([{ name: 'a/b.txt', data: '你好' }])), ['a/b.txt'])
  assert.equal(buildIcs([{ id: 'x', title: 't', date: 'bad' }]).includes('VEVENT'), false)
})

// ------------------------------------------------------------------ 清除全部数据
await t('clear all: wrong / missing confirmation does nothing; right one empties <data> and the CLAP dir, nothing else', async () => {
  const fx = fixture(); const log = []
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks(log) })
  for (const bad of [undefined, '', '清', '清除 ', 'yes']) {
    const r = await c.clearAll(bad); assert.equal(r.ok, false); assert.equal(r.code, 'confirm')
  }
  assert.deepEqual(log, [], '没确认：一个进程都没停')
  assert.ok(existsSync(fx.d('settings.json')))
  const total = (await c.sizes()).total
  const r = await c.clearAll(CONFIRM_WORD)
  assert.equal(r.ok, true); assert.equal(r.python, 'untouched'); assert.equal(r.freed, total)
  assert.deepEqual(left(fx.data), [], '<data> 被清空（目录本身还在）')
  assert.deepEqual(left(fx.clap), [])
  assert.equal(readFileSync(join(fx.base, 'sentinel.txt'), 'utf8'), 'outside everything')
  assert.ok(existsSync(join(fx.music, 'models', 'other-model', 'keep.bin')) && existsSync(join(fx.music, 'listen-venv', 'python.exe')), 'pye-music 里 CLAP 以外的东西还在')
  assert.deepEqual(log.slice(0, 6), ['stopPet', 'stopInstaller', 'stopMusic', 'stopReading', 'stopWriters', 'markPurged'])
})

await t('clear all: a junction inside <data> pointing elsewhere is unlinked, the target survives', async () => {
  const fx = fixture(); const outside = join(fx.base, 'elsewhere')
  put(join(outside, 'mine.txt'), 'mine')
  symlinkSync(outside, fx.d('voices', 'sneaky'), winOnly ? 'junction' : 'dir')
  const c = createCleanup({ dataDir: fx.data, clapDir: fx.clap, hooks: hooks([]) })
  assert.equal((await c.clearAll(CONFIRM_WORD)).ok, true)
  assert.equal(readFileSync(join(outside, 'mine.txt'), 'utf8'), 'mine')
})

// ------------------------------------------------------------------ host 路由
function fakeCtx () {
  let route = null
  const services = {
    webServer: { register (r) { route = r; return () => {} } }, sessions: { list: () => [] }, sessionTitle: { get: () => ({}) },
    tools: { register: () => () => {} },
  }
  return { ctx: { logger: { warn () {}, info () {} }, get: (n) => services[n], agents: { get: () => undefined }, on: () => () => {}, effect: (fn) => { fn() } }, get route () { return route } }
}
async function call (route, method, path, { body, headers = {} } = {}) {
  const req = new PassThrough()
  req.method = method; req.url = '/dsh-pixel-pet' + path
  req.headers = { host: '127.0.0.1:3080', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }
  let status = 0; const chunks = []; const heads = {}
  const res = { writeHead (c, h) { status = c; Object.assign(heads, h) }, end (b) { if (b) chunks.push(Buffer.from(b)) } }
  const p = route.handler(req, res)
  req.end(body === undefined ? undefined : JSON.stringify(body))
  await p
  const raw = Buffer.concat(chunks)
  let json = null; try { json = JSON.parse(raw.toString('utf8')) } catch {}
  return { status, json, raw, heads }
}

await t('host routes: sizes, per-category delete (pet stopped then restarted), export, clear all, then the host writes nothing more', async () => {
  const fx = fixture(); const saved = process.env.PIXELPET_CLAP_DIR
  process.env.PIXELPET_CLAP_DIR = fx.clap
  try {
    const g = fakeCtx(); const kids = []
    const fakeSpawn = (py, args, opts) => { const k = new EventEmitter(); k.stderr = new EventEmitter(); k.exitCode = null; k.kill = () => { k.exitCode = 0; setImmediate(() => k.emit('exit', 0)) }; k.py = py; kids.push(k); return k }
    H.apply(g.ctx, { dataDir: fx.data, spawn: fakeSpawn })
    await call(g.route, 'POST', '/api/settings', { body: { python: 'py-test' } })
    const sizes = await call(g.route, 'GET', '/api/cleanup/sizes')
    assert.equal(sizes.status, 200); assert.ok(sizes.json.sizes.voice > 3000); assert.equal(sizes.json.sizes.notes, 1)

    assert.equal((await call(g.route, 'POST', '/api/pet/start', { body: {} })).json.running, true)
    assert.equal(kids.length, 1)
    const del = await call(g.route, 'POST', '/api/cleanup/delete', { body: { category: 'voice' } })
    assert.equal(del.status, 200); assert.equal(del.json.ok, true)
    assert.equal(kids.length, 2, '删完按原状态把桌宠拉起')
    assert.equal(existsSync(fx.d('pylibs')), false)
    assert.ok(existsSync(fx.d('voice-no-auto.json')), '删除后留下「别再自动装回来」的标记')
    assert.ok([200, 500].includes((await call(g.route, 'POST', '/api/voice/install', { body: {} })).status))
    assert.equal(existsSync(fx.d('voice-no-auto.json')), false, '点「下载」撤掉标记')

    assert.equal((await call(g.route, 'POST', '/api/cleanup/delete', { body: { category: '..' } })).status, 400)
    const wrong = await call(g.route, 'POST', '/api/cleanup/all', { body: { confirm: 'no' } })
    assert.equal(wrong.status, 400); assert.ok(existsSync(fx.d('settings.json')))
    assert.equal((await call(g.route, 'POST', '/api/cleanup/all', { body: { confirm: '清除' }, headers: { origin: 'http://evil.example' } })).status, 403)

    const ex = await call(g.route, 'POST', '/api/cleanup/export', { body: { scope: 'records' } })
    assert.equal(ex.status, 200); assert.equal(ex.heads['Content-Type'], 'application/zip')
    assert.deepEqual(readZipNames(ex.raw).sort(), ['日程.ics', '日记.md'])

    const all = await call(g.route, 'POST', '/api/cleanup/all', { body: { confirm: '清除' } })
    assert.equal(all.status, 200); assert.equal(all.json.ok, true)
    assert.equal(kids.length, 2, '清除全部数据不再拉起桌宠')
    assert.deepEqual(left(fx.data), [])
    // 之后任何请求都不许在数据目录里写出新文件（last-host.txt、设置……）
    assert.equal((await call(g.route, 'GET', '/api/state')).status, 410)
    assert.equal((await call(g.route, 'POST', '/api/settings', { body: { size: 1 } })).status, 410)
    assert.deepEqual(left(fx.data), [])
    assert.equal(readFileSync(join(fx.base, 'sentinel.txt'), 'utf8'), 'outside everything')
  } finally { if (saved === undefined) delete process.env.PIXELPET_CLAP_DIR; else process.env.PIXELPET_CLAP_DIR = saved }
})

await t('previous versions: sizes come from the registry pointers; the prune route and the startup sweep call the pack manager', async () => {
  const fx = fixture()
  put(fx.d('packs', 'store', 'petdev', 'demo', '1.0.0', 'f.bin'), 'x'.repeat(40))
  put(fx.d('packs', 'store', 'petdev', 'demo', '1.1.0', 'f.bin'), 'x'.repeat(10))
  writeFileSync(fx.d('packs', 'registry.json'), JSON.stringify({ v: 2, generation: 3, packs: {
    'petdev.demo': { state: 'enabled', active: { version: '1.1.0', dir: 'petdev/demo/1.1.0' }, previous: { version: '1.0.0', dir: 'petdev/demo/1.0.0' }, previousExpiresAt: 1 },
    'petdev.evil': { state: 'enabled', active: { version: '1.0.0', dir: 'a/b/1.0.0' }, previous: { version: '0.9.0', dir: '../../../sentinel' } },
  } }))
  const { previousSizes } = await import('../lib/cleanup.js')
  assert.deepEqual(await previousSizes(fx.data), { 'petdev.demo': 40 }, '路径越界的指针不统计')
  const calls = []
  const stub = {
    catalog: () => ({ v: 1, entries: [] }), status: () => ({ running: false, registry: JSON.parse(readFileSync(fx.d('packs', 'registry.json'), 'utf8')), progress: null }),
    prunePrevious: async (o) => { calls.push(o); return { ok: true, pruned: ['petdev.demo'] } },
    confirmPending: async () => ({ ok: true, failures: [] }), installFromCatalog: async () => ({ ok: false }),
  }
  const g = fakeCtx()
  H.apply(g.ctx, { dataDir: fx.data, packManager: stub, spawn: () => { throw new Error('no pet here') } })
  await call(g.route, 'GET', '/api/packs/status')                  // 等迁移走完（启动清扫挂在它后面）
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls[0], {}, '启动时只清过了保留期的（不带 force）')
  const r = await call(g.route, 'POST', '/api/packs/prune', { body: { packId: 'petdev.demo' } })
  assert.equal(r.status, 200)
  assert.deepEqual(calls[1], { packId: 'petdev.demo', force: true })
  assert.equal((await call(g.route, 'GET', '/api/cleanup/sizes')).json.sizes.previous['petdev.demo'], 40)
})

await t('host: removing a built-in pack still only hides it; a user pack goes through purge (inside the data dir only)', () => {
  const data = mk('pp-rm-')
  put(join(data, 'characters', 'my-cat', 'character.json'), JSON.stringify({ name: '我的猫' }))
  const s = H.mergeSettings({}, {})
  const del = H.removePack(data, s, 'character', 'my-cat')
  assert.equal(del.how, 'deleted'); assert.equal(existsSync(join(data, 'characters', 'my-cat')), false)
  const builtIn = H.listCharacters(data).find((c) => !c.user && !c.draft && c.id !== 'my-cat')
  const hid = H.removePack(data, s, 'character', builtIn.id)
  if (hid.ok) assert.equal(hid.how, 'hidden')
  assert.ok(existsSync(join(H.PLUGIN_ROOT, 'characters', builtIn.id)), '内置的文件还在插件目录里')
})

console.log(`\npurge: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
