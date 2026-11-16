import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, PLUGIN_ROOT } from '../lib/host.js'
import { createPackManager, validateCatalog } from '../lib/packmgr.js'
import { permissionIds, snapshot } from '../lib/packkit.js'
import { createPetMusic } from '../lib/music-pet.js'
import { listVoices } from '../lib/voice.js'
import { requirePythonOrSkip } from './test-python.mjs'

// 解释器：环境变量 PIXELPET_TEST_PYTHON → PATH 上的 python；都没有就整份跳过
const py = requirePythonOrSkip('claude-pack（要用 Python 构建并安装拓展包）')
const packId = 'builtin.claude-girl'
const bedId = 'claude-book-bed'
const cloneId = 'clone-ad5205a617'
const cat = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'contracts/catalog.json'), 'utf8'))
const catalogEntry = cat.entries.find((e) => e.id === packId)

// 拓展包不再随插件附带：测试里用 tools/build_claude_pack.py 从 packs-src 现场构建（可复现），
// 再由本机 HTTP 服务当「Release 附件」下载——和真实的目录条目（https URL）走同一条下载管线。
const buildDir = mkdtempSync(join(tmpdir(), 'pp-claude-build-'))
const built = JSON.parse(execFileSync(py, ['-B', '-X', 'utf8', join(PLUGIN_ROOT, 'tools', 'build_claude_pack.py'), '--out-dir', buildDir, '--version', catalogEntry.version],
  { encoding: 'utf8' }).trim().split('\n').pop())
const packFile = join(buildDir, built.file)
const server = createServer((req, res) => {
  const body = readFileSync(packFile)
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
  res.end(body)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
process.on('exit', () => { try { server.close() } catch {} })
server.unref()
const entry = { ...catalogEntry, url: 'http://127.0.0.1:' + server.address().port + '/' + built.file }
const data = () => mkdtempSync(join(tmpdir(), 'pp-claude-'))
const settings = (dir, character, extra = {}) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ character, autoStart: false, python: py, ...extra }))
const packs = (dir, send) => {
  const mgr = createPackManager({ root: PLUGIN_ROOT, dataDir: dir, python: () => py, send, permissionIds: permissionIds() })
  mgr.catalog = () => ({ v: 1, entries: [entry] })      // 本机 URL 版的目录条目（size / sha256 与真实目录一致，见下面的可复现测试）
  return mgr
}
const chars = (dir) => snapshot({ pluginRoot: PLUGIN_ROOT, dataDir: dir }).characters
const activeReply = async ({ action, generation }) => action === 'reload'
  ? { ok: true, data: { ok: true, generation, loaded: { characters: ['claude-girl'], furniture: [bedId] } } }
  : { ok: true }

async function serving (dataDir, packManager, callback) {
  let route
  const disposers = []
  const services = {
    webServer: { register (r) { route = r.handler } },
    sessions: { list: () => [] },
    sessionTitle: { get: () => ({}) },
    tools: { register: () => () => {} },
  }
  const ctx = {
    get: (name) => services[name], logger: { warn () {} }, agents: { get: () => undefined },
    on: () => () => {}, effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
  apply(ctx, { dataDir, packManager, autoInstall: false, pythonManager: { path: py, detect: async () => ({}), snapshot: () => ({}) } })
  try {
    const request = async (path, body) => {
      const req = new PassThrough()
      req.url = '/dsh-pixel-pet/api/' + path
      req.method = body ? 'POST' : 'GET'
      req.headers = { host: '127.0.0.1' }
      const payload = body ? JSON.stringify(body) : ''
      if (body) {
        req.headers['content-type'] = 'application/json'
        req.headers['content-length'] = String(Buffer.byteLength(payload))
      }
      let response
      const handle = route(req, { writeHead () {}, end (data) { response = JSON.parse(data) } })
      req.end(payload)
      await handle
      return response
    }
    await callback(request)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
}

test('catalog: url entry valid, bundled paths must stay in packs-bundled, both sources / http / hash / size mismatch rejected', async () => {
  const { url: _url, ...noSource } = catalogEntry
  assert.equal(validateCatalog({ v: 1, entries: [catalogEntry] }, []).error, undefined, 'the shipped catalog (https release URL) is valid')
  assert.match(catalogEntry.url, /^https:\/\/github\.com\/.+\/releases\/download\/v[\d.]+\/builtin\.claude-girl-[\d.]+\.petpack$/)
  for (const bundled of ['packs-bundled/../bad.petpack', '/bad.petpack', 'C:/bad.petpack', 'packs-bundled/ok\\\\bad.petpack']) {
    assert.equal(validateCatalog({ v: 1, entries: [{ ...noSource, bundled }] }, []).error, 'E_CATALOG_INVALID')
  }
  assert.equal(validateCatalog({ v: 1, entries: [{ ...noSource, bundled: 'packs-bundled/ok.petpack' }] }, []).error, undefined, 'bundled still works for local packs')
  assert.equal(validateCatalog({ v: 1, entries: [{ ...catalogEntry, bundled: 'packs-bundled/ok.petpack' }] }, []).error, 'E_CATALOG_INVALID', 'both sources')
  assert.equal(validateCatalog({ v: 1, entries: [{ ...catalogEntry, url: 'http://example.invalid/a.petpack' }] }, []).error, 'E_CATALOG_INVALID', 'plain http is refused')
  assert.equal(validateCatalog({ v: 1, entries: [{ ...catalogEntry, url: 'ftp://example.invalid/a.petpack' }] }, []).error, 'E_CATALOG_INVALID')
  for (const [patch, code] of [[{ size: entry.size - 1 }, 'E_SIZE_MISMATCH'], [{ sha256: '0'.repeat(64) }, 'E_HASH_MISMATCH']]) {
    const root = data()
    // Use the real plugin directory/CLI and override just the catalog view to isolate the checks.
    const mgr = packs(root, activeReply)
    mgr.catalog = () => ({ v: 1, entries: [{ ...entry, ...patch }] })
    assert.equal((await mgr.installFromCatalog(packId)).code, code)
    assert.equal(mgr.status().registry.generation, 0)
  }
})

test('installed role enters effective set only while enabled; disable/uninstall resets selection', async () => {
  const dir = data()
  settings(dir, 'whale-girl')
  const mgr = packs(dir, activeReply)
  await serving(dir, mgr, async (api) => {
    assert.equal(chars(dir).some((ch) => ch.id === 'claude-girl'), false)
    const installed = await api('packs/install', { packId, enable: true })
    assert.equal(installed.ok, true, JSON.stringify(installed))
    assert.deepEqual(installed.receipt.loaded.characters, ['claude-girl'])
    assert.equal(installed.registry.packs[packId].state, 'enabled')
    assert.equal(chars(dir).find((ch) => ch.id === 'claude-girl').base, 'pack')
    assert.ok((await api('state')).furniture.some((f) => f.id === bedId))
    assert.deepEqual((await api('state')).voices.find((v) => v.id === 'claude-girl'), { kind: 'preset', id: 'claude-girl', name: 'Clawd' })
    await api('settings', { character: 'claude-girl', voice: { tts: { voice: 'claude-girl' } } })
    assert.equal((await api('packs/disable', { packId })).ok, true)
    assert.equal(chars(dir).some((ch) => ch.id === 'claude-girl'), false)
    const disabled = await api('state')
    assert.equal(disabled.settings.character, 'whale-girl')
    assert.equal(disabled.settings.voice.tts.voice, 'whale-girl')
    assert.ok(!disabled.furniture.some((f) => f.id === bedId))
    assert.ok(!disabled.voices.some((v) => v.id === 'claude-girl'))
    assert.equal((await api('packs/grant', { packId })).ok, true)
    await api('settings', { character: 'claude-girl', voice: { tts: { voice: 'claude-girl' } } })
    assert.equal((await api('packs/uninstall', { packId })).ok, true)
    const uninstalled = await api('state')
    assert.equal(uninstalled.settings.character, 'whale-girl')
    assert.equal(uninstalled.settings.voice.tts.voice, 'whale-girl')
  })
})

test('missing runtime character receipt rolls back', async () => {
  const dir = data()
  const mgr = packs(dir, async ({ generation }) => ({
    ok: true, data: { ok: true, generation, loaded: { furniture: [], characters: [] } },
  }))
  const result = await mgr.installFromCatalog(packId, { enable: true })
  assert.equal(result.code, 'E_RECEIPT_FAILED')
  assert.equal(chars(dir).some((ch) => ch.id === 'claude-girl'), false)
})

test('a startup receipt confirms a pending package or reports the rolled-back character', async () => {
  for (const valid of [true, false]) {
    let running = false
    const dir = data()
    const mgr = packs(dir, async (request) => {
      if (!running) return { running: false }
      if (valid) return activeReply(request)
      return { ok: true, data: { ok: true, generation: request.generation, loaded: { characters: [] } } }
    })
    const r = await mgr.installFromCatalog(packId, { enable: true })
    assert.equal(r.receipt.petRunning, false)
    running = true
    const confirmed = await mgr.confirmPending()
    assert.equal(confirmed.ok, valid)
    if (valid) assert.equal(mgr.status().registry.packs[packId].state, 'enabled')
    else assert.equal(confirmed.failures[0].code, 'E_RECEIPT_FAILED')
  }
})

test('startup migration installs once, preserves selection, and honors later uninstall', async () => {
  const dir = data()
  settings(dir, 'claude-girl')
  const mgr = packs(dir, activeReply)
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.equal(state.settings.character, 'claude-girl')
    assert.match(state.migrationNotice, /已经帮你装上/)
    assert.equal(state.packs.registry.packs[packId].state, 'enabled')
    assert.ok(JSON.parse(readFileSync(join(dir, 'packs/migrations.json')))['claude-girl-to-pack'])
    assert.equal((await api('packs/uninstall', { packId })).ok, true)
  })
  settings(dir, 'claude-girl')
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.equal(state.settings.character, 'whale-girl')
    assert.equal(state.packs.registry.packs[packId], undefined)
  })
})

test('startup migration falls back with a reason on failed install', async () => {
  const dir = data()
  settings(dir, 'claude-girl', { furniture: { [bedId]: { enabled: true } } })
  const mgr = packs(dir, activeReply)
  mgr.catalog = () => ({ v: 1, entries: [{ ...entry, sha256: '0'.repeat(64) }] })
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.equal(state.settings.character, 'whale-girl')
    assert.match(state.migrationNotice, /SHA-256.*手动下载/)
    assert.deepEqual(Object.keys(marks(dir)), ['claude-girl-to-pack'])
  })
})

test('pet music sends transitions only and sends off on disable, service stop and stale sample', async () => {
  let enabled = true
  let sample = { connected: true, playback: 'playing' }
  const sent = []
  const bridge = createPetMusic({
    enabled: () => enabled, petId: () => 'one', live: async () => sample,
    send: async ({ state }) => { sent.push(state); return { ok: true } },
    intervalMs: 60_000, staleMs: 50,
  })
  try {
    await bridge.sync()
    await bridge.sync()
    sample = { connected: true, playback: 'paused' }
    await bridge.sync()
    enabled = false
    await bridge.sync()
    await bridge.sync()
    enabled = true
    sample = { connected: true, playback: 'playing' }
    await bridge.sync()
    sample = { connected: false }
    await bridge.sync()
    sample = { connected: true, playback: 'playing' }
    await bridge.sync()
    sample = {}
    await delay(90)
    assert.deepEqual(sent, ['playing', 'paused', 'off', 'playing', 'off', 'playing', 'off'])
  } finally {
    bridge.dispose()
  }
})

test('the Release asset is reproducible: a fresh build from packs-src matches the catalog size and sha256; audio is confined to the character voice folder', () => {
  const bytes = readFileSync(packFile)
  assert.equal(built.version, catalogEntry.version)
  assert.equal(bytes.length, catalogEntry.size, '目录里的 size 要和 tools/build_claude_pack.py 的产物一致（改了 packs-src 要重算并更新 contracts/catalog.json）')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), catalogEntry.sha256)
  const cases = [['characters/x/voice/sample.mp3', null], ['characters/x/voice/ref.wav', null],
    ['furniture/x/a.mp3', 'E_FIELD_INVALID'], ['characters/x/sprites/a.wav', 'E_FIELD_INVALID'],
    ['assets/a.mp3', 'E_FIELD_INVALID'], ['characters/x/voice/nested/a.mp3', 'E_FIELD_INVALID']]
  const result = execFileSync(py, ['-B', '-X', 'utf8', '-c', [
    'import json, sys, tempfile, zipfile',
    'sys.path.insert(0, "runtime")',
    'import pack_cli',
    'out = []',
    'with tempfile.TemporaryDirectory() as root:',
    '    for name in json.loads(sys.argv[1]):',
    '        path = root + "/sound.petpack"',
    '        with zipfile.ZipFile(path, "w") as z: z.writestr(name, b"sample")',
    '        try:',
    '            pack_cli._scan_zip(path)',
    '            out.append(None)',
    '        except pack_cli.CliError as e: out.append(e.code)',
    'print(json.dumps(out))',
  ].join('\n'), JSON.stringify(cases.map(([name]) => name))], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(result), cases.map(([, code]) => code))
})

test('preset only participates with the pack enabled and its permissions granted', async () => {
  const dir = data()
  const mgr = packs(dir, activeReply)
  const hasVoice = () => listVoices(PLUGIN_ROOT, dir).some((v) => v.id === 'claude-girl')
  assert.equal(hasVoice(), false)
  assert.equal((await mgr.installFromCatalog(packId, { enable: true })).ok, true)
  assert.equal(hasVoice(), true)
  const path = join(dir, 'packs/registry.json')
  const registry = JSON.parse(readFileSync(path, 'utf8'))
  registry.packs[packId].active.permissions.push('docs.read')
  writeFileSync(path, JSON.stringify(registry))
  assert.equal(hasVoice(), false)
  assert.equal((await mgr.grant(packId)).ok, true)
  assert.equal(hasVoice(), true)
  assert.equal((await mgr.disable(packId)).ok, true)
  assert.equal(hasVoice(), false)
})

async function seedLegacy (dir, mgr, enable, version = '1.0.0') {
  const legacy = join(dir, 'legacy.petpack')
  execFileSync(py, ['-B', '-X', 'utf8', '-c', [
    'import json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as old, zipfile.ZipFile(sys.argv[2], "w") as new:',
    '    for name in old.namelist():',
    '        if name.startswith("furniture/") or "/voice/" in name: continue',
    '        b = old.read(name)',
    '        if name == "manifest.json":',
    '            m = json.loads(b); m["version"] = sys.argv[3]; m.pop("entryFurniture", None); b = json.dumps(m)',
    '        new.writestr(name, b)',
  ].join('\n'), packFile, legacy, version], { encoding: 'utf8' })
  const result = await mgr.installFromFile(legacy, { enable })
  assert.equal(result.ok, true, JSON.stringify(result))
}

const bedSettings = { enabled: true, x: 132, y: 452 }
const marks = (dir) => JSON.parse(readFileSync(join(dir, 'packs/migrations.json'), 'utf8'))

test('existing 1.0 / 1.1.1 pack updates once to the catalog version and preserves enable intent, position, and private clone selection', async () => {
  for (const [enable, installed] of [[true, '1.0.0'], [false, '1.0.0'], [true, '1.1.1'], [false, '1.1.1']]) {
    const dir = data()
    const mgr = packs(dir, activeReply)
    await seedLegacy(dir, mgr, enable, installed)
    const role = enable ? 'claude-girl' : 'whale-girl'
    settings(dir, role, { furniture: { [bedId]: bedSettings }, voice: { tts: { engine: 'qwen', voice: cloneId } } })
    let generation
    await serving(dir, mgr, async (api) => {
      const state = await api('state')
      const pack = state.packs.registry.packs[packId]
      generation = state.packs.registry.generation
      assert.equal(pack.active.version, entry.version)                       // 目录里的版本更高就更新
      assert.equal(pack.previous.version, installed)
      assert.equal(pack.wantEnabled, enable)
      assert.deepEqual(state.settings.furniture[bedId], bedSettings)
      assert.equal(state.settings.character, role)
      assert.equal(state.settings.voice.tts.voice, cloneId)
      assert.ok(marks(dir)['claude-girl-pack-' + entry.version])
      assert.equal(marks(dir)['book-bed-to-pack'], undefined)
      assert.deepEqual(state.packs.updates, {})
    })
    await serving(dir, mgr, async (api) => assert.equal((await api('state')).packs.registry.generation, generation))
  }
})

test('legacy enabled bed installs once without switching role, and uninstall opts out', async () => {
  const dir = data()
  const mgr = packs(dir, activeReply)
  settings(dir, 'whale-girl', { furniture: { [bedId]: bedSettings } })
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.equal(state.settings.character, 'whale-girl')
    assert.deepEqual(state.settings.furniture[bedId], bedSettings)
    assert.match(state.migrationNotice, /书页床.*已经帮你装上/)
    assert.ok(marks(dir)['book-bed-to-pack'])
    assert.equal(state.packs.registry.generation, 1)
    assert.ok((await api('packs/uninstall', { packId })).ok)
  })
  settings(dir, 'whale-girl', { furniture: { [bedId]: bedSettings } })
  await serving(dir, mgr, async (api) => assert.equal((await api('state')).packs.registry.packs[packId], undefined))
})

test('ordinary startup with bed off avoids install, and character plus bed startup installs only once', async () => {
  for (const [character, bed, want] of [['whale-girl', false, 0], ['claude-girl', true, 1]]) {
    const dir = data()
    const mgr = packs(dir, activeReply)
    settings(dir, character, { furniture: { [bedId]: { enabled: bed } } })
    await serving(dir, mgr, async (api) => {
      const state = await api('state')
      assert.equal(state.packs.registry.generation, want)
      if (want) assert.deepEqual(Object.keys(marks(dir)), ['claude-girl-to-pack'])
    })
  }
})

test('failed automatic upgrade is visible and leaves the manual update entry available', async () => {
  const dir = data()
  const mgr = packs(dir, activeReply)
  await seedLegacy(dir, mgr, false)
  settings(dir, 'whale-girl')
  const realCatalog = mgr.catalog.bind(mgr)
  mgr.catalog = () => ({ v: 1, entries: [{ ...entry, sha256: '0'.repeat(64) }] })
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.match(state.migrationNotice, /更新失败.*SHA-256/)
    assert.equal(state.packs.updates[packId], entry.version)
  })
  mgr.catalog = realCatalog
  await serving(dir, mgr, async (api) => {
    const old = await api('state')
    assert.equal(old.packs.registry.packs[packId].active.version, '1.0.0')
    assert.equal(old.packs.updates[packId], entry.version)
    const result = await api('packs/install', { packId, enable: false })
    assert.equal(result.ok, true)
    assert.equal(result.registry.packs[packId].wantEnabled, false)
    assert.deepEqual(result.updates, {})
  })
})

test('failed legacy-bed install is recorded once and leaves the bed settings intact', async () => {
  const dir = data()
  const mgr = packs(dir, activeReply)
  settings(dir, 'whale-girl', { furniture: { [bedId]: bedSettings } })
  const realCatalog = mgr.catalog.bind(mgr)
  mgr.catalog = () => ({ v: 1, entries: [{ ...entry, sha256: '0'.repeat(64) }] })
  await serving(dir, mgr, async (api) => {
    const state = await api('state')
    assert.match(state.migrationNotice, /安装书页床失败.*SHA-256/)
    assert.ok(marks(dir)['book-bed-to-pack'])
    assert.deepEqual(state.settings.furniture[bedId], bedSettings)
  })
  mgr.catalog = realCatalog
  await serving(dir, mgr, async (api) => assert.equal((await api('state')).packs.registry.packs[packId], undefined))
})
