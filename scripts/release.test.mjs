// 17 号：开源发布准备。
//   - npm pack 清单：该有的有（vendor/、书架、台历），不该有的没有（原画图片、packs-bundled、demo-*、备份、fixtures）
//   - <OWNER>/<REPO> 占位符只出现在登记的文件里
//   - Claude娘 拓展包是 Release 附件：断网 / 慢网 / sha 不符 / 302 跳转时，启动迁移退回鲸鱼娘并提示，不卡住桌宠启动
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { apply, PLUGIN_ROOT } from '../lib/host.js'
import { createPackManager } from '../lib/packmgr.js'
import { permissionIds } from '../lib/packkit.js'
import { PLACEHOLDER, PLACEHOLDER_FILES } from './set-repo.mjs'
import { findPython } from './test-python.mjs'

const py = findPython()
const packId = 'builtin.claude-girl'
const catalogEntry = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'contracts/catalog.json'), 'utf8')).entries.find((e) => e.id === packId)

// ------------------------------------------------------------------ npm pack
function npmPackList () {
  // npm 的位置：PIXELPET_NPM_CLI（npm-cli.js 的路径）→ npm_execpath（经 npm 运行时自带）→ PATH 上的 npm
  const cli = process.env.PIXELPET_NPM_CLI || process.env.npm_execpath
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
  const r = cli && /npm-cli\.js$/.test(cli)
    ? spawnSync(process.execPath, [cli, ...args], { cwd: PLUGIN_ROOT, encoding: 'utf8', windowsHide: true })
    : spawnSync('npm', args, { cwd: PLUGIN_ROOT, encoding: 'utf8', shell: true, windowsHide: true })
  if (r.status !== 0) return null
  try { return JSON.parse(r.stdout)[0] } catch { return null }
}

test('npm pack --dry-run: vendor/ and the two new furniture are in; source art, bundled pack, demo packs, backups and fixtures are out', (t) => {
  const pack = npmPackList()
  if (!pack) return t.skip('没有可用的 npm（设 PIXELPET_NPM_CLI 指向 npm-cli.js）')
  const files = pack.files.map((f) => f.path)
  const has = (re) => files.some((f) => re.test(f))
  assert.ok(has(/^vendor\/lunar-javascript\//) && has(/^vendor\/ical\.js\//) && has(/^vendor\/holiday-cn\//), 'vendor/（日历用）')
  assert.ok(files.includes('furniture/bookshelf/furniture.json'), '书架')
  assert.ok(files.includes('furniture/desk-calendar/furniture.json'), '台历')
  assert.ok(files.includes('characters/whale-girl/character.json') && has(/^characters\/whale-girl\/sprites\/.+\.png$/), '默认角色鲸鱼娘')
  assert.ok(files.includes('characters/whale-girl/tools/source/codex/README.md'), '新建角色的动作规格说明（lib/create.js 引用）留在包里')
  assert.ok(files.includes('contracts/catalog.json') && files.includes('THIRD_PARTY_NOTICES.md') && files.includes('LICENSE'))
  const banned = [
    [/^characters\/whale-girl\/tools\/source\/.+\.(png|gif)$/i, '原画图片（Release 附件）'],
    [/^packs-bundled\//, 'packs-bundled'], [/^packs-src\//, 'packs-src'], [/(^|\/)demo-[^/]+\//, 'demo-*'],
    [/\.bak($|[-.])/, '*.bak*'], [/(^|\/)bak-/, 'bak-*'], [/_bak-/, '*_bak-*'], [/__pycache__|\.pyc$/, '__pycache__'],
    [/^contracts\/fixtures\//, 'contracts/fixtures'], [/^\.implementation\//, '.implementation'], [/privacy_terms\.local/, '私有词表'],
    [/^\.tmp\//, '.tmp'], [/(^|\/)(voices|recordings|voiceprints?)\//, '声纹 / 录音 / 克隆目录'],
  ]
  for (const [re, what] of banned) assert.deepEqual(files.filter((f) => re.test(f)), [], '不该进包：' + what)
  assert.ok(pack.unpackedSize < 30 * 1048576, '本体 < 30 MB，实际 ' + (pack.unpackedSize / 1048576).toFixed(1) + ' MB')
})

// ------------------------------------------------------------------ 占位符
test('<OWNER>/<REPO> placeholders only appear in the registered files (so set-repo.mjs can fill them in one go)', () => {
  const skip = new Set(['.tmp', '.git', 'node_modules', '__pycache__', 'dist'])
  const found = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || /\.bak|_bak-/.test(e.name) || e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(md|json|js|mjs|py|yml|yaml|txt|html|css)$/i.test(e.name) || statSync(p).size > 2_000_000) continue
      const rel = relative(PLUGIN_ROOT, p).replace(/\\/g, '/')
      if (rel === 'scripts/release.test.mjs') continue          // 本测试自己提到占位符
      if (readFileSync(p, 'utf8').includes(PLACEHOLDER)) found.push(rel)
    }
  }
  walk(PLUGIN_ROOT)
  assert.deepEqual(found.filter((f) => !PLACEHOLDER_FILES.includes(f)), [], '占位符出现在没有登记的文件里（加进 scripts/set-repo.mjs 的清单，或改掉）')
  // 发布前：两处都还是占位符；跑过 set-repo.mjs 以后：两处都换成同一个真仓库地址，不许一半换了一半没换
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  const repoUrl = String((pkg.repository && pkg.repository.url) || pkg.repository || '')
  if (repoUrl.includes(PLACEHOLDER)) {
    for (const must of ['package.json', 'contracts/catalog.json']) assert.ok(found.includes(must), must + ' 里应有占位符，发布前由 set-repo.mjs 替换')
  } else {
    const m = /github\.com\/([^/]+\/[^/.]+)/.exec(repoUrl)
    assert.ok(m, 'package.json 的 repository 应是真实的 GitHub 地址')
    const cat = readFileSync(join(PLUGIN_ROOT, 'contracts', 'catalog.json'), 'utf8')
    assert.ok(cat.includes('github.com/' + m[1] + '/releases/download/'), 'catalog 的下载地址应指向同一个仓库')
  }
})

// ------------------------------------------------------------------ 迁移：Release 附件
if (!py) {
  test('release migration tests', (t) => t.skip('需要 Python 3（设 PIXELPET_TEST_PYTHON 或把 python 放进 PATH）'))
} else {
  const buildDir = mkdtempSync(join(tmpdir(), 'pp-rel-build-'))
  const built = JSON.parse(execFileSync(py, ['-B', '-X', 'utf8', join(PLUGIN_ROOT, 'tools', 'build_claude_pack.py'), '--out-dir', buildDir, '--version', catalogEntry.version], { encoding: 'utf8' }).trim().split('\n').pop())
  const packBytes = readFileSync(join(buildDir, built.file))
  const wrongBytes = Buffer.alloc(packBytes.length, 0x58)

  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Length': body.length, ...headers }); res.end(body) }
    if (req.url === '/releases/download/v0.1.0/pack.petpack') return send(302, Buffer.alloc(0), { Location: '/cdn/signed/pack.petpack' })
    if (req.url === '/cdn/signed/pack.petpack') return send(200, packBytes)
    if (req.url === '/wrong.petpack') return send(200, wrongBytes)
    if (req.url === '/to-http') return send(302, Buffer.alloc(0), { Location: 'http://example.invalid/pack.petpack' })
    if (req.url === '/slow.petpack') { res.writeHead(200, { 'Content-Length': packBytes.length }); res.write(packBytes.subarray(0, 100)); return }   // 之后一直不发
    send(404, Buffer.alloc(0))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  server.unref()
  const base = 'http://127.0.0.1:' + server.address().port
  const entry = (path, patch = {}) => ({ ...catalogEntry, url: base + path, ...patch })

  const data = () => mkdtempSync(join(tmpdir(), 'pp-rel-'))
  const activeReply = async ({ action, generation }) => action === 'reload'
    ? { ok: true, data: { ok: true, generation, loaded: { characters: ['claude-girl'], furniture: ['claude-book-bed'] } } }
    : { ok: true }

  async function boot (dir, source, { migrationTimeoutMs = 1500 } = {}) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ character: 'claude-girl', autoStart: false, python: py }))
    const mgr = createPackManager({ root: PLUGIN_ROOT, dataDir: dir, python: () => py, send: activeReply, permissionIds: permissionIds() })
    mgr.catalog = () => ({ v: 1, entries: [source] })
    let route
    const services = { webServer: { register (r) { route = r.handler } }, sessions: { list: () => [] }, sessionTitle: { get: () => ({}) }, tools: { register: () => () => {} } }
    const ctx = { get: (n) => services[n], logger: { warn () {} }, agents: { get: () => undefined }, on: () => () => {}, effect: (fn) => { fn() } }
    apply(ctx, { dataDir: dir, packManager: mgr, autoInstall: false, migrationTimeoutMs, pythonManager: { path: py, detect: async () => ({}), snapshot: () => ({}) } })
    const request = async (path) => {
      const req = new PassThrough()
      req.url = '/dsh-pixel-pet/api/' + path; req.method = 'GET'; req.headers = { host: '127.0.0.1' }
      let response
      const handle = route(req, { writeHead () {}, end (d) { response = JSON.parse(d) } })
      req.end()
      await handle
      return response
    }
    return request
  }
  const fellBack = (state) => assert.equal(state.settings.character, 'whale-girl')

  test('offline: migration gives up within the timeout, falls back to the default character with a notice, and does not hang startup', async () => {
    const dir = data()
    const request = await boot(dir, { ...catalogEntry, url: 'http://127.0.0.1:9/x.petpack' }, { migrationTimeoutMs: 1500 })   // 端口 9：连接被拒
    const t0 = Date.now()
    const state = await request('state')
    assert.ok(Date.now() - t0 < 8000, 'state answered in ' + (Date.now() - t0) + ' ms')
    fellBack(state)
    assert.match(state.migrationNotice, /Claude娘 自动安装失败.*手动下载/)
    assert.equal(state.packs.registry.packs[packId], undefined)
  })

  test('slow network: a download that stalls is cut at the timeout and treated as a failure', async () => {
    const dir = data()
    const request = await boot(dir, entry('/slow.petpack'), { migrationTimeoutMs: 1500 })
    const t0 = Date.now()
    const state = await request('state')
    assert.ok(Date.now() - t0 < 8000, 'state answered in ' + (Date.now() - t0) + ' ms')
    fellBack(state)
    assert.match(state.migrationNotice, /自动安装失败.*超时/)
  })

  test('sha256 mismatch: the downloaded bytes are rejected, nothing is installed, fallback with the reason', async () => {
    const dir = data()
    const request = await boot(dir, entry('/wrong.petpack'), { migrationTimeoutMs: 8000 })
    const state = await request('state')
    fellBack(state)
    assert.match(state.migrationNotice, /SHA-256.*手动下载/)
    assert.equal(state.packs.registry.packs[packId], undefined)
    assert.ok(!existsSync(join(dir, 'packs', 'store')) || readdirSync(join(dir, 'packs', 'store')).length === 0)
  })

  test('a redirect to plain http is refused (the sha check is not the only guard)', async () => {
    const dir = data()
    const request = await boot(dir, entry('/to-http'), { migrationTimeoutMs: 8000 })
    const state = await request('state')
    fellBack(state)
    assert.match(state.migrationNotice, /自动安装失败/)
  })

  test('GitHub-style 302 to a CDN URL: followed, verified against the catalog size and sha256, installed and enabled', async () => {
    const dir = data()
    const request = await boot(dir, entry('/releases/download/v0.1.0/pack.petpack'), { migrationTimeoutMs: 20000 })
    const state = await request('state')
    assert.equal(state.settings.character, 'claude-girl')
    assert.match(state.migrationNotice, /已经帮你装上/)
    assert.equal(state.packs.registry.packs[packId].state, 'enabled')
    assert.equal(state.packs.registry.packs[packId].active.version, catalogEntry.version)
  })
}
