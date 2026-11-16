import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, parse } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { analyzeLocalAudio, checkAudioPath, pickFolderWindows, resolveAudioDir, sanitizeAudioDirs } from '../lib/audio-listen.js'
import { createMusicTools } from '../lib/music-tools.js'
import { createMusic, MusicBridge } from '../lib/music.js'
import { apply } from '../lib/host.js'

const fixture = () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pp-audio-')))
  const allowed = join(root, 'a')
  const neighbor = join(root, 'ab')
  mkdirSync(allowed)
  mkdirSync(neighbor)
  const file = join(allowed, 'sample.WAV')
  const other = join(neighbor, 'sample.WAV')
  writeFileSync(file, 'sample')
  writeFileSync(other, 'sample')
  return { root, allowed, neighbor, file, other }
}

test('audio allowlist rejects drive, Users, profile and .dsh roots; canonicalizes and caps 10', () => {
  const { root, allowed } = fixture()
  const profile = process.env.USERPROFILE || homedir()
  const entries = [parse(root).root, 'C:\\Users', 'c:\\Users\\Somebody', profile, join(profile, '.dsh'),
    '', 'relative', '\\\\host\\share', 'D:\\a\\' + 'x'.repeat(260), allowed, allowed + '/',
    ...Array.from({ length: 20 }, (_, i) => join(root, 'extra' + i))]
  assert.deepEqual(sanitizeAudioDirs(entries), [allowed, ...Array.from({ length: 9 }, (_, i) => join(root, 'extra' + i))])
})

test('authorized audio only; neighbors, traversal, network, root retarget, junction, missing and size bound', () => {
  const { root, allowed, neighbor, file, other } = fixture()
  assert.equal(checkAudioPath(file, []).code, 'no_dirs')
  assert.equal(checkAudioPath(file, [allowed]).ok, true)
  const junction = join(allowed, 'external')
  symlinkSync(neighbor, junction, process.platform === 'win32' ? 'junction' : 'dir')
  const movedRoot = join(root, 'previously-allowed')
  symlinkSync(neighbor, movedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [other, allowed + '/..' + '/ab/sample.WAV', join(junction, 'sample.WAV'),
    '\\\\server\\share\\a.wav', '\\\\?\\D:\\a.wav', join(movedRoot, 'sample.WAV')]) {
    assert.equal(checkAudioPath(path, [allowed, movedRoot]).code, 'outside')
  }
  assert.equal(resolveAudioDir(movedRoot), neighbor)
  assert.equal(checkAudioPath('file:///x.wav', [allowed]).code, 'bad_path')
  assert.equal(checkAudioPath(join(allowed, 'a.m4a'), [allowed]).code, 'unsupported')
  assert.equal(checkAudioPath(join(allowed, 'missing.mp3'), [allowed]).code, 'not_found')
  truncateSync(file, 100 * 1024 * 1024 + 1)
  assert.equal(checkAudioPath(file, [allowed]).code, 'too_big')
})

test('tool output, registration gate and lossless response omit paths and nonfinite fields', async () => {
  const { allowed, file } = fixture()
  let enabled = true
  const settings = () => ({ listen: { enabled } })
  const calls = []
  const call = async (...args) => {
    calls.push(args)
    return { ok: true, data: { ok: true, file, seconds: 3.2, kind: 'short',
      numbers: { peak_dbfs: -10, undefined_test: undefined, bad: NaN, extra: file },
      sentence: '样本 ' + file + ' 响度中等。', tags: { kind: [['说话', .9]], other: [[allowed, .3]] }, truncated: false } }
  }
  const defs = createMusicTools({ settings, music: { listenFile: (p) => analyzeLocalAudio(p, [allowed], call) } }).tools()
  const tool = defs.find((t) => t.name === 'pixelpet_audio_listen')
  assert.ok(tool.output.schema && tool.when(settings()))
  const result = await tool.execute({ path: file })
  assert.equal(calls[0][1].value.path, realpathSync.native(file))
  assert.equal(calls[0][1].action, 'analyze_file')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  assert.deepEqual(result.numbers, { peak_dbfs: -10 })
  assert.deepEqual(result.tags, { kind: [['说话', .9]] })
  assert.equal(result.file, 'sample.WAV')
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(allowed).slice(1, -1)))
  assert.match(tool.output.render({}, result)[0].text, /^《sample.WAV》3.2 秒：.*不转写说话内容/)
  enabled = false
  assert.equal(tool.when(settings()), false)
  assert.equal((await tool.execute({ path: file })).ok, false)
  assert.equal(calls.length, 1)
})

test('tool timeout leaves the background bridge request alive even beyond its idle limit', async () => {
  const { root, allowed, file } = fixture()
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => {}
  let request
  child.stdin.on('data', (s) => {
    const msg = JSON.parse(s)
    if (msg.command === 'control') request = msg
  })
  const bridge = new MusicBridge({ dataDir: root, resolve: () => ({ python: 'fake', ok: true }),
    idleMs: 15, spawnFn: () => child })
  try {
    const r = await analyzeLocalAudio(file, [allowed], bridge.call.bind(bridge), { timeoutMs: 5 })
    assert.equal(r.code, 'timeout')
    assert.match(r.message, /过一会儿再问一次/)
    await delay(30)
    assert.equal(bridge.running, true)
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, data: { ok: true } }) + '\n')
    await delay(40)
    assert.equal(bridge.running, false)
  } finally { bridge.stop() }
})

test('folder picker returns the native selection and handles cancellation', async () => {
  const { allowed } = fixture()
  for (const value of [allowed, null]) {
    const path = await pickFolderWindows({ spawnFn: (_exe, args, opts) => {
      assert.ok(args.join(' ').includes('FolderBrowserDialog'))
      assert.equal(opts.windowsHide, true)
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      queueMicrotask(() => {
        if (value) child.stdout.write(JSON.stringify(value))
        child.emit('close', 0)
      })
      return child
    } })
    assert.equal(path, value)
  }
})

test('only native picker grants directories; remove revokes, foreign origin and control are blocked', async () => {
  const { root, allowed, neighbor } = fixture()
  let accesses = 0
  const routes = []
  const disposers = []
  const dir = join(root, 'profile')
  mkdirSync(dir)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoStart: false, listen: { enabled: true } }))
  const services = {
    webServer: { register: (r) => { routes.push(r.handler) } }, sessions: { list: () => [] },
    sessionTitle: { get: () => ({}) }, tools: { register: (def) => { assert.ok(def.output?.schema); return () => {} } },
  }
  apply({
    get: (name) => services[name], logger: { warn () {} }, agents: { get () {} }, on: () => () => {},
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }, {
    dataDir: dir, autoInstall: false, pickAudioFolder: async () => { accesses += 1; return allowed },
    pythonManager: { path: 'fixture', snapshot: () => ({}), detect: async () => ({}) },
  })
  async function post (where, body, from = 'http://127.0.0.1') {
    const req = new PassThrough()
    req.method = 'POST'
    req.url = '/dsh-pixel-pet/api/' + where
    req.headers = { host: '127.0.0.1', origin: from, 'content-type': 'application/json' }
    let response
    const h = routes[0](req, { writeHead () {}, end (buffer) { response = JSON.parse(buffer) } })
    req.end(JSON.stringify(body))
    await h
    return response
  }
  try {
    assert.deepEqual((await post('settings', { listen: { audioDirs: [neighbor] } })).settings.listen.audioDirs, [])
    assert.equal((await post('music/audio-dirs/add', {}, 'http://outside.invalid')).ok, false)
    assert.equal(accesses, 0)
    assert.deepEqual((await post('music/audio-dirs/add', { dir: neighbor })).audioDirs, [allowed])
    assert.deepEqual((await post('settings', { listen: { clap: false, audioDirs: [neighbor] } })).settings.listen.audioDirs, [allowed])
    assert.equal((await post('music/control', { action: 'analyze_file', value: { path: join(allowed, 'sample.WAV') } })).ok, false)
    assert.deepEqual((await post('music/audio-dirs/remove', { dir: allowed })).audioDirs, [])
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('revoking a folder while an authorized request is running suppresses the result', async () => {
  const { root, allowed, file } = fixture()
  const cfg = { listen: { enabled: true, audioDirs: [allowed] } }
  let finish
  const bridge = { running: false, stop () {}, call () { return new Promise((r) => { finish = r }) } }
  const music = createMusic({ dataDir: root, settings: () => cfg, bridge })
  try {
    const current = music.listenFile(file)
    cfg.listen.audioDirs = []
    finish({ ok: true, data: { ok: true, seconds: 3, kind: 'short', sentence: '测到的声学特征。' } })
    assert.equal((await current).code, 'no_dirs')
    assert.equal((await music.listenFile(file)).code, 'no_dirs')
  } finally { music.dispose() }
})
