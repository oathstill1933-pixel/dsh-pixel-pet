// node scripts/music.test.mjs — lib/music.js：路由 / 开关 / 拉起与停止 / 不泄露路径（假子进程，不真跑 python）
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createMusic, MusicBridge, resolvePython, sanitizeListen, shapeSnapshot, chatPrompt, LISTEN_DEFAULT } from '../lib/music.js'

let n = 0
const test = async (name, fn) => { await fn(); n++; console.log('ok', name) }
const SECRET = 'D:\\私密\\歌手 - 秘密.flac'

/** fake `python -m pixelmusic`: answers JSON lines with canned data */
function fakeSpawn (log, answer) {
  return (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough()
    child.exitCode = null
    child.kill = () => { child.killed = true; child.emit('exit', 0) }
    log.push({ cmd, args, opts, child })
    let buf = ''
    child.stdin.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        child.calls = (child.calls || []).concat(msg)
        if (msg.command === 'shutdown') { child.shut = true; continue }
        const r = answer(msg)
        if (r !== undefined) child.stdout.write(JSON.stringify({ id: msg.id, ...r }) + '\n')
      }
    })
    return child
  }
}

const NOW = {
  source: 'cloud', prefer: 'auto', app: 'netease', playing: true, position: 12.5,
  track: { title: '示例曲目', artist: '示例艺人', album: '', duration: 259, cover: 'abc123def456', path: SECRET },
  lyric: { available: true, index: 3, line: '示例歌词一行', next: '下一句', origin: 'lrclib', window: { before: ['一', '二', '多余'], current: '示例歌词一行', after: ['下一句'] } },
  volume: 63.4, mode: 'one',
  heard: { available: true, sentence: '测到的特征：近 30 秒能量中等', engine: 'librosa', kind: 'live' },
  spectrum: { available: true, bars: new Array(48).fill(0.5) },
  capabilities: { seek: false, playSpecific: false, loopback: true, volume: true, mode: true },
  local: { count: 2, index: 1 },
  energy: [0, 0.5, 9],
  loopback_error: SECRET,
}

function rig ({ enabled = true, python = true, answer, pickFiles, openLink, daily } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-music-'))
  const py = join(dir, 'python.exe')
  if (python) writeFileSync(py, '')
  const st = { listen: { enabled, python: python ? py : '' }, voice: { llm: { sessionId: 'sess-1' } } }
  const log = []
  const asks = []
  const relay = { ask: async (id, text) => { asks.push({ id, text }); return { code: 200, body: { ok: true, reply: '好听' } } } }
  const m = createMusic({
    dataDir: dir, settings: () => st, relay, daily, pickFiles, openLink, watchMs: 20,
    spawnFn: fakeSpawn(log, answer || ((msg) => msg.command === 'now' ? { ok: true, data: NOW } : msg.command === 'live' ? { ok: true, data: { source: 'cloud', playing: true, position: 13, lyric: { index: 3, window: { before: [], current: 'a', after: ['b', 'c'] } }, spectrum: { available: true, bars: new Array(48).fill(2) } } } : msg.command === 'cover' ? { ok: true, data: { available: true, mime: 'image/png', b64: Buffer.from('PNGDATA').toString('base64') } } : msg.command === 'control' && msg.args.action === 'local_list' ? { ok: true, data: { index: 0, items: [{ index: 0, title: '秘密', artist: '歌手', path: SECRET }] } } : msg.command === 'control' && msg.args.action === 'local_add' ? { ok: true, data: { added: msg.args.value.length, unsupported: 0, rejected: 0, total: 3 } } : { ok: true, data: {} })),
  })
  return { m, st, log, dir, asks, py }
}

/** minimal req/res for handle() */
async function hit (m, method, path, { body, headers = {} } = {}) {
  const url = new URL(path, 'http://local')
  const req = { method, headers: { host: '127.0.0.1:3080', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }
  const out = { code: 0, body: null, raw: null, headers: null }
  const res = { writeHead: (c, h) => { out.code = c; out.headers = h }, end: (b) => { out.raw = b } }
  const send = (_r, c, o) => { out.code = c; out.body = o }
  const readBody = async () => Buffer.from(JSON.stringify(body || {}))
  const handled = await m.handle(req, res, { path: url.pathname, url, host: '127.0.0.1:3080', send, readBody })
  return { handled, ...out }
}

const UV_DEFAULT_TXT = ''
await test('sanitizeListen: enabled bool, python trimmed ≤260, garbage ignored', () => {
  assert.deepEqual(LISTEN_DEFAULT, { enabled: false, python: '', clap: false, clapMirror: '', uv: UV_DEFAULT_TXT, audioDirs: [] })
  const bare = { enabled: false, python: '', clap: false, clapMirror: '', uv: UV_DEFAULT_TXT, audioDirs: [] }
  assert.deepEqual(sanitizeListen(undefined, {}), bare)
  assert.deepEqual(sanitizeListen({ enabled: true }, { enabled: 'yes', python: '  C:\\py\\python.exe \n' }), { enabled: true, python: 'C:\\py\\python.exe', clap: false, clapMirror: '', uv: UV_DEFAULT_TXT, audioDirs: [] })
  assert.equal(sanitizeListen({}, { python: 'x'.repeat(400) }).python.length, 260)
  assert.deepEqual(sanitizeListen({ enabled: true, python: 'a' }, { python: 5, extra: 1 }), { enabled: true, python: 'a', clap: false, clapMirror: '', uv: UV_DEFAULT_TXT, audioDirs: [] })
  assert.deepEqual(sanitizeListen([], null), bare)
  // 「听得更细」开关与镜像
  const c = sanitizeListen({}, { clap: true, clapMirror: '  https://hf-mirror.com/\n' })
  assert.equal(c.clap, true)
  assert.equal(c.clapMirror, 'https://hf-mirror.com/')
})

await test('resolvePython: settings → <dataDir>/listen.json → 未配置; nonexistent ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-mres-'))
  const a = join(dir, 'a.exe'); const b = join(dir, 'b.exe')
  writeFileSync(a, ''); writeFileSync(b, '')
  assert.equal(resolvePython({ settings: { listen: { python: a } }, dataDir: dir }).python, a)
  writeFileSync(join(dir, 'listen.json'), JSON.stringify({ python: b }))
  assert.equal(resolvePython({ settings: { listen: { python: '' } }, dataDir: dir }).python, b)
  assert.equal(resolvePython({ settings: { listen: { python: join(dir, 'nope.exe') } }, dataDir: dir }).python, b)
  writeFileSync(join(dir, 'listen.json'), '{}')
  assert.equal(resolvePython({ settings: {}, dataDir: dir }).ok, false)
})

await test('source has no hardcoded machine paths', () => {
  const src = readFileSync(new URL('../lib/music.js', import.meta.url), 'utf8')
  assert.ok(!/(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}[A-Za-z]|venvs|dsh-music\\/.test(src), '不许有盘符路径 / 私有 venv 目录名')
})

await test('disabled: /now says enabled:false without spawning; other routes 409', async () => {
  const { m, log } = rig({ enabled: false })
  const r = await hit(m, 'GET', '/api/music/now')
  assert.equal(r.code, 200); assert.equal(r.body.enabled, false); assert.equal(r.body.source, 'none')
  for (const p of ['/api/music/live', '/api/music/cover', '/api/music/chat', '/api/music/local']) assert.equal((await hit(m, 'GET', p)).code, 409)
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'toggle' } })).code, 409)
  assert.equal(log.length, 0)
  assert.equal((await m.control({ action: 'next' })).code, 409)
  m.dispose()
})

await test('not configured: /now ok with configured:false, no spawn', async () => {
  const { m, log } = rig({ python: false })
  const r = await hit(m, 'GET', '/api/music/now')
  assert.equal(r.body.configured, false); assert.equal(r.body.source, 'none'); assert.equal(log.length, 0)
  m.dispose()
})

await test('now: contract shape, spawn args, daily hook, no paths leak', async () => {
  const observed = []
  const daily = { observe: (s) => { observed.push(s) }, today: () => ({ date: '2026-11-14', title: 'x', artist: 'y', note: 'z', link: '' }) }
  const { m, log, dir, py } = rig({ daily })
  const r = await hit(m, 'GET', '/api/music/now')
  assert.equal(r.code, 200)
  const s = r.body
  assert.equal(log.length, 1)
  assert.equal(log[0].cmd, py)
  assert.deepEqual(log[0].args, ['-X', 'utf8', '-m', 'pixelmusic', '--data-dir', dir])
  assert.ok(String(log[0].opts.cwd).replace(/\\/g, '/').endsWith('runtime/music'))
  assert.equal(s.source, 'cloud'); assert.equal(s.app, 'netease'); assert.equal(s.playing, true)
  assert.deepEqual(s.track, { title: '示例曲目', artist: '示例艺人', album: '', duration: 259, cover: '/api/music/cover?v=abc123def456' })
  assert.deepEqual(s.lyric, { available: true, index: 3, line: '示例歌词一行', next: '下一句', window: { before: ['一', '二'], current: '示例歌词一行', after: ['下一句'] } })
  assert.equal(s.volume, 63); assert.equal(s.mode, 'one')
  assert.equal(s.spectrum.bars.length, 48)
  assert.equal(s.heard.engine, 'librosa')
  // 网易云能点播（play_song，2026-11-15）：playSpecific 照实为 true
  assert.deepEqual(s.capabilities, { seek: false, playSpecific: true, loopback: true, volume: true, mode: true })
  assert.equal(s.daily.date, '2026-11-14')
  assert.deepEqual(s.energy, [0, 0.5, 1])
  assert.equal(observed.length, 1)
  const dump = JSON.stringify(s)
  assert.ok(!dump.includes('秘密.flac') && !dump.includes('D:\\\\') && !dump.includes(dir.replace(/\\/g, '\\\\')))
  m.dispose()
})

await test('live: small payload, bars clamped 0-1', async () => {
  const { m } = rig()
  const r = await hit(m, 'GET', '/api/music/live')
  assert.deepEqual(Object.keys(r.body).sort(), ['connected', 'lyric', 'ok', 'playing', 'position', 'source', 'spectrum'])
  assert.deepEqual(r.body.lyric, { index: 3, window: { before: [], current: 'a', after: ['b', 'c'] } })
  assert.ok(r.body.spectrum.bars.every((v) => v === 1))
  m.dispose()
})

await test('cover: bytes forwarded with mime', async () => {
  const { m } = rig()
  const r = await hit(m, 'GET', '/api/music/cover?v=abc')
  assert.equal(r.code, 200); assert.equal(r.headers['Content-Type'], 'image/png'); assert.equal(String(r.raw), 'PNGDATA')
  m.dispose()
})

await test('local list: only index/title/artist', async () => {
  const { m } = rig()
  const r = await hit(m, 'GET', '/api/music/local')
  assert.deepEqual(r.body, { ok: true, index: 0, items: [{ index: 0, title: '秘密', artist: '歌手' }] })
  m.dispose()
})

await test('control: validation, forwarding, local_add only via user dialog', async () => {
  let picked = 0
  const { m, log } = rig({ pickFiles: async () => { picked++; return [SECRET, 'E:\\b.mp3'] } })
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'rm -rf' } })).code, 400)
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'seek', value: -3 } })).code, 400)
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'source', value: 'x' } })).code, 400)
  const ok = await hit(m, 'POST', '/api/music/control', { body: { action: 'volume', value: 150 } })
  assert.equal(ok.code, 200)
  const sent = log[0].child.calls.find((c) => c.command === 'control')
  assert.deepEqual(sent.args, { action: 'volume', value: 100 })
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'mode', value: 'loop' } })).code, 400)
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'mode', value: 'shuffle' } })).code, 200)
  assert.deepEqual(log[0].child.calls.filter((c) => c.command === 'control').at(-1).args, { action: 'mode', value: 'shuffle' })
  assert.equal((await m.control({ action: 'local_add' })).code, 403) // AI/tool path never opens a dialog
  assert.equal(picked, 0)
  const add = await hit(m, 'POST', '/api/music/control', { body: { action: 'local_add' } })
  assert.equal(add.code, 200); assert.equal(add.body.data.added, 2); assert.equal(picked, 1)
  assert.ok(!JSON.stringify(add.body).includes('秘密'))
  assert.equal((await hit(m, 'POST', '/api/music/control', { body: { action: 'toggle' }, headers: { 'content-type': 'text/plain' } })).code, 415)
  m.dispose()
})

await test('open_link: whitelist + first use must be a user click', async () => {
  const opened = []
  const { m, dir } = rig({ openLink: (u) => { opened.push(u); return true } })
  assert.equal((await m.control({ action: 'open_link', value: 'https://evil.example/' })).code, 400)
  assert.equal((await m.control({ action: 'open_link', value: 'orpheus://song/1' })).code, 403)
  assert.equal(opened.length, 0)
  const u = await hit(m, 'POST', '/api/music/control', { body: { action: 'open_link', value: 'https://music.163.com/#/search/m/?s=a' } })
  assert.equal(u.code, 200)
  assert.ok(existsSync(join(dir, 'music', 'consent.json')))
  assert.equal((await m.control({ action: 'open_link', value: 'qqmusic://x' })).code, 200)
  assert.equal(opened.length, 2)
  const d = rig({ openLink: (u) => { opened.push(u); return true }, daily: { today: () => ({ link: 'https://y.qq.com/n/ryqq/search?w=a', linkKind: 'search' }) } })
  assert.equal((await hit(d.m, 'POST', '/api/music/control', { body: { action: 'open_link', value: 'daily' } })).code, 200)
  assert.equal(opened.at(-1), 'https://y.qq.com/n/ryqq/search?w=a')
  d.m.dispose()
  m.dispose()
})

await test('cross-origin rejected', async () => {
  const { m } = rig()
  assert.equal((await hit(m, 'GET', '/api/music/now', { headers: { origin: 'http://evil.example' } })).code, 403)
  assert.equal((await hit(m, 'GET', '/api/music/now', { headers: { 'sec-fetch-site': 'cross-site' } })).code, 403)
  assert.equal((await hit(m, 'GET', '/api/other')).handled, false)
  m.dispose()
})

await test('switch off → service stopped promptly (device released)', async () => {
  const { m, st, log } = rig()
  await hit(m, 'GET', '/api/music/now')
  assert.equal(m.bridge.running, true)
  st.listen.enabled = false
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(m.bridge.running, false)
  assert.equal(log[0].child.shut, true)
  m.dispose()
})

await test('idle exit after idleMs; next call respawns', async () => {
  const log = []
  const br = new MusicBridge({ resolve: () => ({ ok: true, python: 'py' }), dataDir: 'd', idleMs: 40, spawnFn: fakeSpawn(log, () => ({ ok: true, data: {} })) })
  await br.call('ping')
  assert.equal(br.running, true)
  await new Promise((r) => setTimeout(r, 90))
  assert.equal(br.running, false)
  await br.call('ping')
  assert.equal(log.length, 2)
  br.stop()
})

await test('timeout and child exit resolve pending calls', async () => {
  const log = []
  const br = new MusicBridge({ resolve: () => ({ ok: true, python: 'py' }), dataDir: 'd', spawnFn: fakeSpawn(log, () => undefined) })
  const t = await br.call('now', {}, 30)
  assert.equal(t.error.code, 'timeout')
  const p = br.call('now', {}, 5000)
  log[0].child.emit('exit', 1)
  assert.equal((await p).error.code, 'service_exit')
  br.stop()
})

await test('chat: prompt carries track, lyric line, heard sentence; reply shows up', async () => {
  const { m, asks } = rig()
  const r = await hit(m, 'POST', '/api/music/chat', { body: { text: '这段好听吗' } })
  assert.equal(r.code, 200); assert.equal(r.body.reply, '好听')
  assert.equal(asks.length, 1)
  assert.match(asks[0].text, /正在听：《示例曲目》 — 示例艺人/)
  assert.match(asks[0].text, /当前歌词：示例歌词一行/)
  assert.match(asks[0].text, /测到的特征/)
  assert.ok(!asks[0].text.includes('秘密'))
  const g = await hit(m, 'GET', '/api/music/chat?after=0')
  assert.deepEqual(g.body.items.map((x) => [x.role, x.text]), [['user', '这段好听吗'], ['pet', '好听']])
  assert.equal(chatPrompt('hi', null).includes('没有在放歌'), true)
  m.dispose()
})

await test('shapeSnapshot drops unknown app / bad cover / extra fields', () => {
  const s = shapeSnapshot({ ...NOW, app: 'evil', track: { ...NOW.track, cover: '../../x' } })
  assert.equal(s.app, null); assert.equal(s.track.cover, null); assert.equal('path' in s.track, false); assert.equal('loopback_error' in s, false)
  assert.equal(shapeSnapshot({ ...NOW, loopback_error: 'RuntimeError', position_source: 'estimated' }).loopback_error, 'RuntimeError')
  assert.equal(shapeSnapshot({ ...NOW, position_source: 'estimated' }).position_source, 'estimated')
  // 网易云能点播（play_song），能力表照实写 true；QQ 音乐照旧 false
  const cap0 = { ...NOW.capabilities, playSpecific: false }
  assert.equal(shapeSnapshot({ ...NOW, source: 'cloud', app: 'netease', capabilities: cap0 }).capabilities.playSpecific, true)
  assert.equal(shapeSnapshot({ ...NOW, source: 'cloud', app: 'qqmusic', capabilities: cap0 }).capabilities.playSpecific, false)
})

// lib/music.js 用 fs.xxx 却没导入 fs → 「听得更细」开关一开就 ReferenceError
await test('clap/disable writes the flag (fs is imported); GET clap reports it', async () => {
  const { m, dir } = rig()
  const r = await hit(m, 'POST', '/api/music/clap/disable', { body: {} })
  assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.equal(r.body.enabled, false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'music', 'clap.json'), 'utf8')).enabled, false)
  const g = await hit(m, 'GET', '/api/music/clap')
  assert.equal(g.code, 200); assert.equal(g.body.enabled, false)
  const src = readFileSync(new URL('../lib/music.js', import.meta.url), 'utf8')
  if (/\bfs\.[a-zA-Z]+\(/.test(src)) assert.match(src, /import \* as fs from 'node:fs'/)
})


// 2026-11-15 review 9：「听得更细」开关的唯一真源是 settings.listen.clap；服务启动前落盘到 music/clap.json
await test('clap flag: settings is the single source, written before the service starts', async () => {
  const { m, st, dir, log } = rig({ enabled: true })
  const flagFile = join(dir, 'music', 'clap.json')
  // 开关打开：设置改 → host 会调 syncClap()；这里直接验证落盘内容
  st.listen.clap = true
  st.listen.clapMirror = 'https://hf-mirror.com'
  m.syncClap()
  assert.deepEqual(JSON.parse(readFileSync(flagFile, 'utf8')), { enabled: true, mirror: 'https://hf-mirror.com' })
  // 起服务（now() 触发拉起）前会再写一次：之后把设置关掉但不动文件，服务仍按文件走
  await hit(m, 'GET', '/api/music/now')
  assert.ok(log.length >= 1)
  st.listen.clap = false
  m.syncClap()
  assert.equal(JSON.parse(readFileSync(flagFile, 'utf8')).enabled, false)
  // clap/disable 不再自己造第二个真源：它同步设置里的值（这里 clap=false）
  const r = await hit(m, 'POST', '/api/music/clap/disable', { body: {} })
  assert.equal(r.code, 200)
  assert.equal(JSON.parse(readFileSync(flagFile, 'utf8')).enabled, false)
  // GET 带上服务实时状态字段位（服务没在跑时 live 为 null）
  const g = await hit(m, 'GET', '/api/music/clap')
  assert.equal(g.code, 200)
  assert.ok('live' in g.body)
})

// 网易云点播——搜索解析、挑歌、播放链接（全程假 fetch，不联网）
await test('netease play_song: search parse, strict pick, orpheus url, verify', async () => {
  const { neteaseSearch, pickNeteaseSong, neteasePlayUrl } = await import('../lib/music.js')
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, json: async () => ({ result: { songs: [
      { id: 111, name: '夜に駆ける', artists: [{ name: 'YOASOBI' }], album: { name: 'THE BOOK' }, fee: 1 },
      { id: 222, name: '夜に駆ける', artists: [{ name: '翻唱的人' }], album: { name: 'x' }, fee: 0 },
      { id: 'bad id', name: '坏条目', artists: [] },
    ] } }) }
  }
  const list = await neteaseSearch('夜に駆ける YOASOBI', { fetchImpl: fakeFetch })
  assert.equal(list.length, 2)
  assert.match(seen[0].url, /^https:\/\/music\.163\.com\/api\/search\/get\/web\?/)
  assert.equal(new URL(seen[0].url).searchParams.get('s'), '夜に駆ける YOASOBI')
  assert.equal(seen[0].init.redirect, 'error')
  assert.equal(pickNeteaseSong(list, { title: '夜に駆ける', artist: 'yoasobi' }).pick.id, '111')
  assert.equal(pickNeteaseSong(list, { title: '夜に駆ける', artist: '翻唱的人' }).pick.id, '222')
  assert.equal(pickNeteaseSong(list, { title: '夜に駆ける' }).pick, null, '同名两首、没给歌手：不猜')
  assert.equal(pickNeteaseSong(list, { title: '夜に駆ける', artist: '没这个人' }).pick, null)
  assert.equal(pickNeteaseSong(list, { title: '别的歌' }).candidates.length, 2)
  const u = neteasePlayUrl('111')
  assert.match(u, /^orpheus:\/\//)
  assert.deepEqual(JSON.parse(Buffer.from(u.slice(10), 'base64').toString('utf8')), { type: 'song', id: '111', cmd: 'play' })
  assert.deepEqual(await neteaseSearch('x', { fetchImpl: async () => { throw new Error('net') } }), [])
  // 走一遍 control：开的就是这首的 orpheus 链接，播完回读对上了 → confirmed
  const opened = []
  let title = '原来的歌'
  const { m } = rig({ answer: (msg) => msg.command === 'now' ? { ok: true, data: { ...NOW, track: { ...NOW.track, title } } } : { ok: true, data: {} } })
  const m2 = createMusic({ dataDir: mkdtempSync(join(tmpdir(), 'pp-ne-')), settings: () => ({ listen: { enabled: true, python: '' } }), bridge: m.bridge, fetchImpl: fakeFetch, playWaitMs: 1, openLink: (url) => { opened.push(url); title = '夜に駆ける'; return true } })
  const r = await m2.control({ action: 'play_song', value: { title: '夜に駆ける', artist: 'YOASOBI' } })
  assert.equal(r.body.ok, true); assert.equal(r.body.data.confirmed, true); assert.equal(r.body.data.vip, true)
  assert.equal(opened[0], neteasePlayUrl('111'))
  const amb = await m2.control({ action: 'play_song', value: { title: '夜に駆ける' } })
  assert.equal(amb.body.code, 'ambiguous'); assert.equal(opened.length, 1, '对不上就不放')
  // 默认打开方式必须是 rundll32 url.dll,FileProtocolHandler（2026-11-15 实测 explorer.exe 收到 orpheus 链接什么都不做）
  const spawned = []
  const m3 = createMusic({ dataDir: mkdtempSync(join(tmpdir(), 'pp-ne3-')), settings: () => ({ listen: { enabled: true, python: '' } }), bridge: m.bridge, fetchImpl: fakeFetch, playWaitMs: 0, spawnFn: (cmd, args) => { spawned.push([cmd, ...args]); return { on () {}, unref () {} } } })
  await m3.control({ action: 'play_song', value: { title: '夜に駆ける', artist: 'YOASOBI' } })
  assert.deepEqual(spawned[0], ['rundll32.exe', 'url.dll,FileProtocolHandler', neteasePlayUrl('111')])
  m3.dispose(); m2.dispose(); m.dispose()
})

console.log(`music.test: ${n} passed`)
