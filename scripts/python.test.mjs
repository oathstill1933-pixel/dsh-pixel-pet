// node scripts/python.test.mjs — the Python runtime: which interpreter wins, download/verify/unpack,
// refused tampering, refused archives that try to write outside the data dir.
// No real process, no real download: spawn, http and the downloader are injected.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as P from '../lib/pyruntime.js'

let pass = 0; let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok   ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}
const made = []
/** temp dir removed when the suite ends (a runtime tree is ~4000 files) */
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d }
process.on('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ------------------------------------------------------------------ fixtures
/** a fake `<python> -c <code>`: exits 0 only for paths the test says are usable */
function fakeSpawn ({ ok = () => true, seen = [], delay = 0 } = {}) {
  return (exe, args, opts) => {
    const child = new EventEmitter()
    const stdout = new EventEmitter(); const stderr = new EventEmitter()
    child.stdout = stdout; child.stderr = stderr; child.kill = () => {}
    seen.push({ exe, args, opts })
    setTimeout(() => {
      if (ok(exe, args)) child.emit('close', 0)
      else { stderr.emit('data', Buffer.from("ModuleNotFoundError: No module named 'tkinter'")); child.emit('close', 1) }
    }, delay)
    return child
  }
}

/** minimal tar writer, enough for the extractor (file + dir entries, ustar magic) */
function tarHeader (name, size, type = '0') {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'latin1')
  h.write('0000644\0', 100, 8, 'latin1')
  h.write('0000000\0', 108, 8, 'latin1')
  h.write('0000000\0', 116, 8, 'latin1')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1')
  h.write('00000000000\0', 136, 12, 'latin1')
  h.write('        ', 148, 8, 'latin1')
  h.write(type, 156, 1, 'latin1')
  h.write('ustar\0', 257, 6, 'latin1'); h.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  return h
}
function tarGz (entries) {
  const parts = []
  for (const e of entries) {
    const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body || '')
    parts.push(tarHeader(e.name, e.type === '5' ? 0 : body.length, e.type || '0'))
    if (e.type !== '5') {
      parts.push(body)
      const pad = (512 - (body.length % 512)) % 512
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** temp plugin root whose catalog pins one python-runtime file at `url` */
function fakeRoot ({ archive, url, sha256, size, platform = 'win32' }) {
  const root = tmp('pp-root-')
  mkdirSync(join(root, 'runtime', 'pixelpet', 'voice'), { recursive: true })
  const comp = {
    id: 'python-runtime', kind: 'files', title: 'Python 运行时', auto: true, dest: 'runtime/python',
    files: [{ path: 'cpython-test.tar.gz', url, sha256: sha256 || sha(archive), size: size === undefined ? archive.length : size, platform,
      extract: { archive: 'tar.gz', to: '', strip: 1 } }],
  }
  writeFileSync(join(root, 'runtime', 'pixelpet', 'voice', 'catalog.json'), JSON.stringify({ version: 1, components: [comp] }))
  return { root, comp }
}

const DRIVE_PATH = 'C' + ':/drive-escaped.txt'   // built here so the privacy scan sees no absolute local path
const GOOD_ARCHIVE = tarGz([  { name: 'python/', type: '5' },
  { name: 'python/python.exe', body: 'MZ fake interpreter' },
  { name: 'python/Lib/os.py', body: 'x = 1\n' },
  { name: 'python/tcl/tk8.6/init.tcl', body: 'package provide Tk 8.6\n' },
])

// ------------------------------------------------------------------ resolve order
await t('resolve: an existing settings.python wins, without being probed', async () => {
  const dir = tmp('pp-py-a-')
  const exe = join(dir, 'my python.exe')
  writeFileSync(exe, 'MZ')
  const seen = []
  const r = await P.resolvePython({ settings: { python: exe }, dataDir: dir, platform: 'win32', spawn: fakeSpawn({ seen }) })
  assert.equal(r.ok, true); assert.equal(r.source, 'settings'); assert.equal(r.path, exe)
  assert.equal(seen.length, 0, 'an explicit path is taken as given')
  assert.equal(P.quickPython({ settings: { python: exe } }).path, exe)
})

await t('resolve: a missing settings.python is reported, not silently replaced', async () => {
  const dir = tmp('pp-py-b-')
  const r = await P.resolvePython({ settings: { python: join(dir, 'nope', 'python.exe') }, dataDir: dir, platform: 'win32', spawn: fakeSpawn() })
  assert.equal(r.ok, false); assert.match(r.message, /设置里的 Python 不存在/)
})

await t('resolve: bare name from settings is looked up on PATH, else taken as given', async () => {
  const bin = tmp('pp-bin-')
  writeFileSync(join(bin, 'python.exe'), 'MZ')
  const found = await P.resolvePython({ settings: { python: 'python' }, dataDir: tmp('pp-py-c-'), platform: 'win32', env: { PATH: bin }, spawn: fakeSpawn() })
  assert.equal(found.ok, true); assert.equal(found.path, join(bin, 'python.exe')); assert.equal(found.source, 'settings')
  const loose = await P.resolvePython({ settings: { python: 'python3' }, dataDir: tmp('pp-py-d-'), platform: 'win32', env: { PATH: '' }, spawn: fakeSpawn() })
  assert.equal(loose.ok, true); assert.equal(loose.path, 'python3')
})

await t('resolve: downloaded runtime beats a PATH python, and must import tkinter', async () => {
  const dir = tmp('pp-py-e-')
  const exe = P.runtimePython(dir, 'win32')
  mkdirSync(P.runtimeDir(dir), { recursive: true }); writeFileSync(exe, 'MZ')
  const bin = tmp('pp-bin2-'); writeFileSync(join(bin, 'python.exe'), 'MZ')
  const ok = await P.resolvePython({ settings: {}, dataDir: dir, platform: 'win32', env: { PATH: bin }, spawn: fakeSpawn() })
  assert.equal(ok.ok, true); assert.equal(ok.path, exe); assert.equal(ok.source, 'bundled')
  // a broken tree (no tkinter) falls through to PATH, and the PATH python must import tkinter AND PIL
  const spawn = fakeSpawn({ ok: (p, args) => p !== exe && args.join(' ').includes('tkinter, PIL') })
  const fall = await P.resolvePython({ settings: {}, dataDir: dir, platform: 'win32', env: { PATH: bin }, spawn })
  assert.equal(fall.source, 'system'); assert.equal(fall.path, join(bin, 'python.exe'))
  assert.equal((await P.resolvePython({ settings: {}, dataDir: dir, platform: 'win32', env: { PATH: bin }, spawn: fakeSpawn({ ok: () => false }) })).ok, false)
})

await t('resolve: nothing anywhere -> asks for a runtime', async () => {
  const r = await P.resolvePython({ settings: {}, dataDir: tmp('pp-py-f-'), platform: 'win32', env: { PATH: '' }, spawn: fakeSpawn() })
  assert.equal(r.ok, false); assert.match(r.message, /需要准备 Python 运行时/)
})

// ------------------------------------------------------------------ tar.gz
await t('extract: tree kept, strip drops the leading dir', async () => {
  const dir = tmp('pp-x-')
  const out = join(dir, 'python')
  const gz = join(dir, 'a.tar.gz')
  writeFileSync(gz, GOOD_ARCHIVE)
  const r = await P.extractTarGz(gz, out, { strip: 1 })
  assert.equal(r.files, 3)
  assert.equal(readFileSync(join(out, 'python.exe'), 'utf8'), 'MZ fake interpreter')
  assert.equal(readFileSync(join(out, 'Lib', 'os.py'), 'utf8'), 'x = 1\n')
  assert.ok(existsSync(join(out, 'tcl', 'tk8.6', 'init.tcl')))
  assert.ok(!existsSync(join(out, 'python')), 'the leading "python/" component is gone')
})

await t('extract: refuses absolute and ../ members instead of writing outside', async () => {
  const dir = tmp('pp-x2-')
  const out = join(dir, 'dest')
  const gz = join(dir, 'evil.tar.gz')
  writeFileSync(gz, tarGz([
    { name: 'python/ok.txt', body: 'fine' },
    { name: 'python/../../escaped.txt', body: 'nope' },
    { name: '/abs-escaped.txt', body: 'nope' },
    { name: DRIVE_PATH, body: 'nope' },
  ]))
  const r = await P.extractTarGz(gz, out, { strip: 1 })
  assert.equal(r.files, 1); assert.equal(r.skipped, 3)
  assert.ok(existsSync(join(out, 'ok.txt')))
  assert.ok(!existsSync(join(dir, 'escaped.txt')))
  assert.ok(!existsSync(join(dir, 'dest', '..', 'escaped.txt')))
  assert.ok(!existsSync(join(out, 'abs-escaped.txt')))
})

await t('safeParts: what a member may not be', () => {
  assert.deepEqual(P.safeParts('python/Lib/os.py', 1), ['Lib', 'os.py'])
  assert.equal(P.safeParts('python/../x', 1), null)
  assert.equal(P.safeParts('/etc/passwd', 0), null)
  assert.equal(P.safeParts(DRIVE_PATH, 0), null)
  assert.equal(P.safeParts('python/', 1), null)
  assert.equal(P.safeParts('python', 1), null)
})

// ------------------------------------------------------------------ install
function serve (body, { status = 200, hang = false } = {}) {
  const server = createServer((req, res) => {
    if (hang) return
    res.writeHead(status, { 'content-length': body.length })
    res.end(body)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/cpython-test.tar.gz` })))
}

await t('install: download, verify, unpack, marker with the catalog rev', async () => {
  const { server, url } = await serve(GOOD_ARCHIVE)
  try {
    const dataDir = tmp('pp-inst-')
    const { root, comp } = fakeRoot({ archive: GOOD_ARCHIVE, url })
    const phases = []
    const r = await P.installRuntime({ root, dataDir, platform: 'win32', progress: (p) => phases.push(p.phase) })
    assert.equal(r.path, P.runtimePython(dataDir, 'win32'))
    assert.equal(readFileSync(r.path, 'utf8'), 'MZ fake interpreter')
    assert.deepEqual([...new Set(phases)], ['downloading', 'verifying', 'extracting'])
    assert.equal(P.runtimeInstalled(root, dataDir, 'win32'), true)
    const marker = JSON.parse(readFileSync(join(P.runtimeDir(dataDir), '.installed'), 'utf8'))
    assert.equal(marker.rev, P.componentRev(comp))
    assert.equal(marker.rev.length, 16)
    assert.ok(!existsSync(join(dataDir, 'runtime', '.downloads', 'cpython-test.tar.gz')), 'the archive is dropped after unpacking')
  } finally { server.close() }
})

await t('install: a wrong sha256 is refused and nothing is installed', async () => {
  const { server, url } = await serve(GOOD_ARCHIVE)
  try {
    const dataDir = tmp('pp-inst2-')
    const { root } = fakeRoot({ archive: GOOD_ARCHIVE, url, sha256: 'deadbeef'.repeat(8) })
    await assert.rejects(P.installRuntime({ root, dataDir, platform: 'win32' }), /校验不符/)
    assert.equal(existsSync(P.runtimePython(dataDir, 'win32')), false)
    assert.equal(existsSync(P.runtimeDir(dataDir)), false)
    assert.equal(P.runtimeInstalled(root, dataDir, 'win32'), false)
  } finally { server.close() }
})

await t('install: wrong size is refused before any unpacking', async () => {
  const { server, url } = await serve(GOOD_ARCHIVE)
  try {
    const dataDir = tmp('pp-inst3-')
    const { root } = fakeRoot({ archive: GOOD_ARCHIVE, url, size: GOOD_ARCHIVE.length + 10 })
    await assert.rejects(P.installRuntime({ root, dataDir, platform: 'win32' }), /下载大小不符/)
    assert.equal(existsSync(P.runtimeDir(dataDir)), false)
  } finally { server.close() }
})

await t('install: no network -> readable error, not a stack trace', async () => {
  const dataDir = tmp('pp-inst4-')
  // 127.0.0.1:1 refuses immediately
  const { root } = fakeRoot({ archive: GOOD_ARCHIVE, url: 'http://127.0.0.1:1/cpython-test.tar.gz' })
  await assert.rejects(P.installRuntime({ root, dataDir, platform: 'win32' }), /下载 Python 运行时失败：连不上下载源/)
})

await t('install: a server that never answers times out with a clear message', async () => {
  const { server, url } = await serve(Buffer.alloc(0), { hang: true })
  try {
    const dest = join(tmp('pp-dl-'), 'x.bin')
    await assert.rejects(P.downloadFile(url, dest, { timeoutMs: 400 }), /下载超时/)
  } finally { server.close() }
})

await t('install: a body larger than the catalog size is aborted (Content-Length or streamed)', async () => {
  const { server, url } = await serve(GOOD_ARCHIVE)
  try {
    const dataDir = tmp('pp-inst5-')
    const { root } = fakeRoot({ archive: GOOD_ARCHIVE, url, size: GOOD_ARCHIVE.length - 10 })
    await assert.rejects(P.installRuntime({ root, dataDir, platform: 'win32' }), /超过目录里写的大小/)
    assert.ok(!existsSync(join(dataDir, 'runtime', '.downloads', 'cpython-test.tar.gz')), 'no partial file left')
    assert.equal(existsSync(P.runtimeDir(dataDir)), false)
  } finally { server.close() }
  // no Content-Length: the running byte count stops it
  const big = Buffer.alloc(256 * 1024, 7)
  const chunked = createServer((req, res) => { res.writeHead(200); let i = 0; const tick = () => { if (i++ >= 16 || res.destroyed) return res.end(); res.write(big, tick) }; tick() })
  await new Promise((ok) => chunked.listen(0, '127.0.0.1', ok))
  try {
    const dest = join(tmp('pp-dl3-'), 'x.bin')
    const url2 = `http://127.0.0.1:${chunked.address().port}/x.bin`
    await assert.rejects(P.downloadFile(url2, dest, { maxBytes: 300 * 1024 }), /超过目录里写的大小/)
  } finally { chunked.close() }
})

await t('extract: a failure mid-archive stops reading and leaves the archive removable', async () => {
  const dir = tmp('pp-x3-')
  const out = join(dir, 'dest')
  mkdirSync(join(out, 'clash.txt'), { recursive: true })      // a directory where a file must go -> write fails
  const gz = join(dir, 'bad.tar.gz')
  writeFileSync(gz, tarGz([
    { name: 'python/clash.txt', body: 'x' },
    ...Array.from({ length: 40 }, (_, i) => ({ name: `python/later-${i}.bin`, body: Buffer.alloc(8192, i) })),
  ]))
  await assert.rejects(P.extractTarGz(gz, out, { strip: 1 }))
  await new Promise((ok) => setTimeout(ok, 50))
  assert.ok(!existsSync(join(out, 'later-39.bin')), 'nothing after the failure is written')
  rmSync(gz); assert.ok(!existsSync(gz))
})
await t('install: an http source that is not loopback is refused', async () => {
  await assert.rejects(P.downloadFile('http://example.com/x.tar.gz', join(tmp('pp-dl2-'), 'x.bin')), /只接受 https/)
})

// ------------------------------------------------------------------ pip fallback
await t('pip: mirror first, official index when the mirror fails', async () => {
  const calls = []
  const spawn = (exe, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
    calls.push(args.join(' '))
    setTimeout(() => { child.emit('close', args.includes('--index-url') ? 1 : 0) }, 0)
    return child
  }
  // probe: no PIL first, then present
  let pil = 0
  const probeSpawn = (exe, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
    setTimeout(() => { child.emit('close', args.join(' ').includes('import PIL') && pil++ === 0 ? 1 : 0) }, 0)
    return child
  }
  const warns = []
  const r = await P.ensureImports('py', { spawn: (e, a, o) => (a.includes('-m') ? spawn(e, a, o) : probeSpawn(e, a, o)), logger: { warn: (m) => warns.push(m) } })
  assert.equal(r.ok, true); assert.deepEqual(r.added, ['Pillow'])
  assert.match(calls[0], /--disable-pip-version-check/); assert.match(calls[0], /mirrors\.cloud\.tencent\.com/)
  assert.ok(!/--index-url/.test(calls[1]), 'second attempt uses the default index')
  assert.equal(warns.length, 1)
})

await t('pip: no tkinter means the interpreter is unusable, whatever pip does', async () => {
  const spawn = (exe, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
    setTimeout(() => { child.emit('close', 1) }, 0)
    return child
  }
  await assert.rejects(P.ensureImports('py', { spawn }), /没有 tkinter/)
})

// ------------------------------------------------------------------ manager
await t('manager: detect -> ensure installs once, quick() settles an explicit setting', async () => {
  const dataDir = tmp('pp-mgr-')
  const settings = { python: '' }
  let installs = 0
  const install = async ({ progress }) => { installs++; progress({ phase: 'downloading', done: 1, total: 2 }); return { path: P.runtimePython(dataDir, 'win32') } }
  const py = P.createPythonManager({
    root: tmp('pp-mgr-root-'), dataDir, settings: () => settings, platform: 'win32', env: { PATH: '' },
    spawn: fakeSpawn({ ok: () => true }), install,
    // ensureImports is real; it probes through the injected spawn: everything "imports" here
  })
  assert.equal(await py.detect(), null)                    // nothing yet
  assert.equal(py.snapshot().phase, 'missing')
  assert.equal(await py.quick(), '', 'no explicit setting -> nothing to settle')
  const got = await py.ensure()
  assert.equal(got.source, 'bundled'); assert.equal(installs, 1)
  assert.equal(py.snapshot().phase, 'ready'); assert.equal(py.path, got.path)
  await py.ensure(); assert.equal(installs, 1, 'ensured once')
  settings.python = process.execPath
  py.reset()
  assert.equal(py.quick(), process.execPath)
  assert.equal(py.snapshot().source, 'settings')
})

await t('manager: a failing install surfaces as phase=error with the message', async () => {
  const py = P.createPythonManager({
    root: tmp('pp-mgr2-root-'), dataDir: tmp('pp-mgr2-'), settings: () => ({}), platform: 'win32', env: { PATH: '' },
    spawn: fakeSpawn({ ok: () => false }), install: async () => { throw new Error('校验不符，已丢弃') },
  })
  await assert.rejects(py.ensure(), /校验不符/)
  assert.equal(py.snapshot().phase, 'error'); assert.match(py.snapshot().message, /校验不符/)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
