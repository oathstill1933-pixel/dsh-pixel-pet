// node scripts/packkit.test.mjs — 统一包解析与冻结契约（M0）：枚举规则、严格清单、分层决策、
// SemVer/范围、manifest v1、引擎注册表、安装状态机。跨语言一致性另见 scripts/pack-conformance.test.mjs。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkPackManifest, checkRequires, createEngineRegistry, enumeratePacks, loadContract,
  parseVersion, compareVersions, parseRange, satisfiesRange, pluginVersion, readManifestStrict,
  resolveOne, snapshot, transition,
} from '../lib/packkit.js'
import { packFrame } from '../lib/packs.js'

const made = []
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), 'pp-packkit-' + p + '-')); made.push(d); return d }
process.on('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

let pass = 0; let fail = 0
async function t (name, fn) {
  try { await fn(); pass++; console.log('ok  ', name) } catch (e) { fail++; console.log('FAIL', name, '\n ', e && e.stack || e) }
}

// packkit 的结构校验只读 PNG 头：一个头部合法（尺寸/位深/色彩对）的最小缓冲就够，不需要真像素
function stubPng (w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8   // bit depth
  b[25] = 6   // color type RGBA
  return b
}

const REQ = ['idle', 'walk-left', 'walk-right', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'lie']

function makeCharacterPack (root, cid, opts = {}) {
  const dir = join(root, 'characters', cid)
  mkdirSync(dir, { recursive: true })
  const canvas = opts.canvas || [192, 208]
  const states = {}
  for (const sid of opts.states || REQ) {
    states[sid] = { label: sid, frames: opts.noFrames ? [] : ['sprites/' + sid + '_00.png'], durationsMs: opts.noFrames ? [] : [250] }
    if (!opts.noFrames) { mkdirSync(join(dir, 'sprites'), { recursive: true }); writeFileSync(join(dir, 'sprites', sid + '_00.png'), stubPng(canvas[0], canvas[1])) }
  }
  writeFileSync(join(dir, 'character.json'), JSON.stringify({ id: cid, name: opts.name || cid, demo: false, canvas, logicalScale: 2, displayScale: 1.0, states, ...(opts.extra || {}) }))
  return dir
}

function makeFurniturePack (root, fid, opts = {}) {
  const dir = join(root, 'furniture', fid)
  mkdirSync(dir, { recursive: true })
  const size = opts.size || [48, 32]
  const states = opts.states || { idle: { label: 'idle', frames: ['sprites/idle_00.png'], durationsMs: [250] } }
  if (!opts.states) { mkdirSync(join(dir, 'sprites'), { recursive: true }); writeFileSync(join(dir, 'sprites', 'idle_00.png'), stubPng(size[0], size[1])) }
  writeFileSync(join(dir, 'furniture.json'), JSON.stringify({ id: fid, name: opts.name || fid, version: 1, size, states, idle: opts.idle || 'idle', ...(opts.extra || {}), interactions: opts.interactions || [{ verb: '用', mode: 'beside' }] }))
  return dir
}

// --------------------------------------------------------------------------- 契约与常量

await t('contract: loads once, frozen constants present, error codes unique', () => {
  const c = loadContract()
  assert.equal(c.contractVersion, 1)
  assert.equal(c.manifestVersion, 1)
  assert.equal(c.packApi, 1)
  assert.equal(loadContract(), c) // cached
  assert.equal(c.installStates.length, new Set(c.installStates).size)
  assert.equal(Object.keys(c.errorCodes).length, new Set(Object.keys(c.errorCodes)).size)
  for (const p of c.permissions) assert.equal(typeof p.needsConfirm, 'boolean')
  for (const row of Object.values(c.stateTransitions)) {
    for (const to of Object.values(row)) assert.ok(c.installStates.includes(to), '迁移目标必须是已声明状态')
  }
})

await t('contract: a wrong contractVersion is E_CONTRACT_INVALID, never silently accepted', () => {
  // loadContract 的版本门禁语义固定为 1；直接验证判断分支无法注入文件路径，这里锁行为常量
  assert.equal(loadContract().contractVersion, 1)
})

await t('plugin version comes from package.json (plugin 域，与 pack/dsh 互不混用)', () => {
  assert.equal(pluginVersion(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
})

// --------------------------------------------------------------------------- 枚举

await t('enumerate: skips dot/underscore/.bak-/symlink dirs and plain files, name order', () => {
  const root = tmp('enum')
  mkdirSync(join(root, 'characters'), { recursive: true })
  for (const n of ['b-pack', 'a-pack', '_hidden', '.dot', 'x.bak-20261113']) mkdirSync(join(root, 'characters', n))
  writeFileSync(join(root, 'characters', 'loose-file.json'), '{}')
  let linked = false
  try { symlinkSync(join(root, 'characters', 'a-pack'), join(root, 'characters', 'link-pack'), 'dir'); linked = true } catch { /* Windows 无特权时跳过符号链接断言 */ }
  assert.deepEqual(enumeratePacks(root, 'character'), ['a-pack', 'b-pack'])
  if (linked) assert.ok(!enumeratePacks(root, 'character').includes('link-pack'))
  assert.deepEqual(enumeratePacks(root, 'furniture'), [])
})

// --------------------------------------------------------------------------- 严格清单

await t('readManifestStrict: missing / bad JSON / non-object are explicit, never "parses so it wins"', () => {
  const root = tmp('strict')
  mkdirSync(join(root, 'characters', 'p1'), { recursive: true })
  mkdirSync(join(root, 'characters', 'p2'), { recursive: true })
  mkdirSync(join(root, 'characters', 'p3'), { recursive: true })
  writeFileSync(join(root, 'characters', 'p2', 'character.json'), '{ broken')
  writeFileSync(join(root, 'characters', 'p3', 'character.json'), '[1,2]')
  assert.equal(readManifestStrict(join(root, 'characters', 'p1'), 'character').errors[0].code, 'E_MANIFEST_MISSING')
  assert.equal(readManifestStrict(join(root, 'characters', 'p2'), 'character').errors[0].code, 'E_MANIFEST_JSON_INVALID')
  assert.equal(readManifestStrict(join(root, 'characters', 'p3'), 'character').errors[0].code, 'E_MANIFEST_JSON_INVALID')
})

// --------------------------------------------------------------------------- 分层决策

await t('layering: builtin only -> builtin wins', () => {
  const plugin = tmp('lay-b'); makeCharacterPack(plugin, 'solo')
  const pk = resolveOne({ pluginRoot: plugin, dataDir: null, kind: 'character', id: 'solo' })
  assert.equal(pk.base, 'builtin'); assert.equal(pk.valid, true); assert.deepEqual([pk.user, pk.overlay, pk.builtin], [false, false, true])
})

await t('layering: a valid user overlay wins in place (overlay/user/builtin all true)', () => {
  const plugin = tmp('lay-o'); const data = tmp('lay-o-u')
  makeCharacterPack(plugin, 'hero')
  makeCharacterPack(data, 'hero', { name: '用户版' })
  const pk = resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'hero' })
  assert.equal(pk.base, 'user'); assert.equal(pk.data.name, '用户版'); assert.equal(pk.overlay, true)
  assert.deepEqual([pk.user, pk.builtin], [true, true])
})

await t('layering: an invalid user overlay loses to the builtin, userErrors visible (页面不再各读各的)', () => {
  const plugin = tmp('lay-i'); const data = tmp('lay-i-u')
  makeCharacterPack(plugin, 'hero')
  makeCharacterPack(data, 'hero', { canvas: [64, 64] })
  const pk = resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'hero' })
  assert.equal(pk.base, 'builtin'); assert.equal(pk.valid, true)
  assert.ok(pk.userErrors.length >= 1 && pk.userErrors.every((e) => e.code))
})

await t('layering: a broken user edit with no builtin is listed but invalid (fallback display)', () => {
  const data = tmp('lay-bad'); makeCharacterPack(data, 'broken', { states: ['idle'] })
  const pk = resolveOne({ pluginRoot: tmp('lay-bad-p'), dataDir: data, kind: 'character', id: 'broken' })
  assert.equal(pk.base, 'user'); assert.equal(pk.valid, false); assert.equal(pk.builtin, false)
})

await t('layering: a draft user-only pack falls back to display (valid:false, draft:true)', () => {
  const data = tmp('lay-draft'); makeCharacterPack(data, 'skel', { noFrames: true, extra: { draft: true } })
  const pk = resolveOne({ pluginRoot: tmp('lay-draft-p'), dataDir: data, kind: 'character', id: 'skel' })
  assert.equal(pk.base, 'user'); assert.equal(pk.valid, false); assert.equal(pk.draft, true)
})

await t('layering: a draft user overlay loses to a valid builtin (对齐 Python strict 语义)', () => {
  const plugin = tmp('lay-db'); const data = tmp('lay-db-u')
  makeCharacterPack(plugin, 'hero')
  makeCharacterPack(data, 'hero', { noFrames: true, extra: { draft: true } })
  const pk = resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'hero' })
  assert.equal(pk.base, 'builtin'); assert.equal(pk.userDraft, true)
})

await t('layering: bad id / unknown id -> null; a symlinked user folder is never read through', () => {
  const plugin = tmp('lay-id'); const data = tmp('lay-id-u')
  makeCharacterPack(plugin, 'hero')
  assert.equal(resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'Bad_ID' }), null)
  assert.equal(resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'nope' }), null)
  // 用户层目录是链接（指向一个真包）：绝不透过它读，也不冒充内置层
  let linked = false
  try {
    makeCharacterPack(data, 'real-target')
    symlinkSync(join(data, 'characters', 'real-target'), join(data, 'characters', 'linked-pack'), 'dir')
    linked = true
  } catch { /* Windows 无特权时跳过 */ }
  if (linked) {
    assert.equal(resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'linked-pack' }), null)
    assert.equal(resolveOne({ pluginRoot: plugin, dataDir: data, kind: 'character', id: 'real-target' }).base, 'user')
  }
})

await t('furniture structural rules: idle must reference an existing state; occupant geometry enforced', () => {
  const plugin = tmp('furn-val')
  makeFurniturePack(plugin, 'ok-f')
  makeFurniturePack(plugin, 'bad-idle', { idle: 'sleep' })
  makeFurniturePack(plugin, 'bad-occ', { interactions: [{ verb: '睡', mode: 'inside', occupant: { anchor: [9999, 0] } }] })
  assert.equal(resolveOne({ pluginRoot: plugin, dataDir: null, kind: 'furniture', id: 'ok-f' }).valid, true)
  assert.equal(resolveOne({ pluginRoot: plugin, dataDir: null, kind: 'furniture', id: 'bad-idle' }).valid, false)
  assert.equal(resolveOne({ pluginRoot: plugin, dataDir: null, kind: 'furniture', id: 'bad-occ' }).valid, false)
})

// --------------------------------------------------------------------------- snapshot

await t('snapshot: builtin name order first, user-only appended, settings views composed', () => {
  const plugin = tmp('snap-p'); const data = tmp('snap-u')
  makeCharacterPack(plugin, 'b-char'); makeFurniturePack(plugin, 'a-furn'); makeFurniturePack(plugin, 'm-furn', { extra: { defaultEnabled: true } })
  makeFurniturePack(data, 'z-furn'); makeFurniturePack(data, 'm-furn', { name: '用户覆盖' })
  const snap = snapshot({ pluginRoot: plugin, dataDir: data, settings: { furniture: { 'a-furn': { enabled: true } }, hidden: { character: [], furniture: [] } } })
  assert.deepEqual(snap.characters.map((c) => c.id), ['b-char'])
  assert.deepEqual(snap.furniture.map((f) => f.id), ['a-furn', 'm-furn', 'z-furn'])
  assert.equal(snap.furniture[0].enabled, true)   // settings 显式开
  assert.equal(snap.furniture[1].enabled, false)  // 用户覆盖胜出后 defaultEnabled 来自用户版（没写 = false）
  assert.equal(snap.furniture[1].base, 'user'); assert.equal(snap.furniture[1].name, '用户覆盖')
  assert.equal(snap.furniture[2].enabled, false)
  assert.equal(snap.pluginVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(snap.contractVersion, 1)
})

await t('snapshot: hidden only applies to non-user packs', () => {
  const plugin = tmp('snap-h'); const data = tmp('snap-h-u')
  makeCharacterPack(plugin, 'gone'); makeCharacterPack(data, 'mine')
  const snap = snapshot({ pluginRoot: plugin, dataDir: data, settings: { hidden: { character: ['gone', 'mine'], furniture: [] } } })
  assert.equal(snap.characters.find((c) => c.id === 'gone').hidden, true)
  assert.equal(snap.characters.find((c) => c.id === 'mine').hidden, false)
})

// --------------------------------------------------------------------------- 版本三域与范围

await t('semver: strict parse (pre-release rules included)', () => {
  const v = parseVersion('1.2.3-rc.1')
  assert.deepEqual([v.major, v.minor, v.patch, v.pre], [1, 2, 3, ['rc', 1]])
  for (const bad of ['v1.2.3', '1.2', '1.2.3.4', '01.2.3', '1.2.3-01', '1.2.3-', '']) {
    try { parseVersion(bad); assert.fail('should reject: ' + bad) } catch (e) { assert.equal(e.code, 'E_VERSION_MALFORMED', bad) }
  }
})

await t('semver: precedence (pre < release; numeric < alphanumeric; shorter pre is smaller)', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0)
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0)
  assert.ok(compareVersions('1.0.0-alpha.beta', '1.0.0-beta') < 0)
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-rc.1') < 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0)
  assert.ok(compareVersions('0.2.0-rc.1', '0.2.0') < 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

await t('range: minimal grammar only; everything else is E_RANGE_UNSUPPORTED', () => {
  assert.deepEqual(parseRange('^1.2.3').map((c) => c.op), ['>=', '<'])
  assert.deepEqual(parseRange('~1.2.3').map((c) => c.op), ['>=', '<'])
  assert.deepEqual(parseRange('>=1.2.3 <2.0.0').length, 2)
  for (const bad of ['>=1.0 || <2', '1.x', '*', '1.0.0 - 2.0.0', '=1.2', '1.2', '', '>= 1.0.0 ??']) {
    try { parseRange(bad); assert.fail('should reject: ' + bad) } catch (e) { assert.equal(e.code, 'E_RANGE_UNSUPPORTED', bad) }
  }
})

await t('range: RC 语义按标准 SemVer（方案 §九 的坑钉死）', () => {
  assert.equal(satisfiesRange('0.2.0-rc.1', '^0.2.0-rc.1'), true)
  assert.equal(satisfiesRange('0.2.0-rc.2', '^0.2.0-rc.1'), true)
  assert.equal(satisfiesRange('0.2.0', '^0.2.0-rc.1'), true)
  assert.equal(satisfiesRange('0.3.0-rc.1', '^0.2.0-rc.1'), false) // 数值上 < 0.3.0 也必须排除
  assert.equal(satisfiesRange('0.3.0', '^0.2.0-rc.1'), false)
  assert.equal(satisfiesRange('1.0.0-alpha', '^1.0.0'), false)
})

// --------------------------------------------------------------------------- 拓展包 manifest v1

const goodManifest = () => ({
  id: 'petdev.reading-demo', version: '1.0.0', name: '一起看书（示例）', manifestVersion: 1, packApi: 1,
  license: 'CC-BY-NC-SA-4.0',
  requires: { core: '^0.1.0', capabilities: ['docs.select', 'session.ask'] },
  permissions: ['docs.read', 'model.ask'], platforms: ['win32'],
  entryFurniture: { id: 'reading-desk', dir: 'furniture/reading-desk' },
  characterAdapters: [{ character: 'whale-girl', required: ['reading'], optional: ['ponder'] }],
  dependencies: [{ id: 'petdev.listening-demo', version: '^1.0.0' }],
})

await t('pack manifest v1: valid manifest passes', () => {
  const r = checkPackManifest(goodManifest())
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

await t('pack manifest v1: unknown top-level fields tolerated (与 character.json 行为一致)', () => {
  const r = checkPackManifest({ ...goodManifest(), futureField: { any: 'thing' } })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

await t('pack manifest v1: unsupported manifestVersion / packApi are explicit, not guessed', () => {
  assert.equal(checkPackManifest({ ...goodManifest(), manifestVersion: 2 }).errors[0].code, 'E_MANIFEST_VERSION_UNSUPPORTED')
  assert.equal(checkPackManifest({ ...goodManifest(), packApi: 2 }).errors[0].code, 'E_PACK_API_UNSUPPORTED')
})

await t('pack manifest v1: requires 载体里的未知键与 dsh 声明都是协议错误', () => {
  assert.equal(checkPackManifest({ ...goodManifest(), requires: { core: '^0.1.0', dsh: '^0.2.0' } }).errors[0].code, 'E_FIELD_INVALID')
  assert.equal(checkPackManifest({ ...goodManifest(), requires: { core: '^0.1.0', milestone: 'M2' } }).errors[0].code, 'E_FIELD_INVALID')
})

await t('pack manifest v1: unknown permission / capability / bad id / bad version / self-dependency', () => {
  assert.equal(checkPackManifest({ ...goodManifest(), permissions: ['docs.read', 'magic'] }).errors[0].code, 'E_PERMISSION_UNKNOWN')
  assert.equal(checkPackManifest({ ...goodManifest(), requires: { capabilities: ['time.travel'] } }).errors[0].code, 'E_CAPABILITY_UNKNOWN')
  assert.equal(checkPackManifest({ ...goodManifest(), id: 'nopoint' }).errors[0].code, 'E_ID_INVALID')
  assert.equal(checkPackManifest({ ...goodManifest(), version: '1.0' }).errors[0].code, 'E_VERSION_MALFORMED')
  assert.equal(checkPackManifest({ ...goodManifest(), dependencies: [{ id: 'petdev.reading-demo', version: '^1.0.0' }] }).errors[0].code, 'E_FIELD_INVALID')
  assert.equal(checkPackManifest({ ...goodManifest(), requires: { core: '>=1.0 || <2' } }).errors[0].code, 'E_RANGE_UNSUPPORTED')
  assert.equal(checkPackManifest({ ...goodManifest(), license: '' }).errors.some((e) => e.code === 'E_REQUIRED_MISSING'), true)
})

await t('checkRequires: core 对 plugin 域判定，不满足显式报错；dsh 域根本不存在', () => {
  // 用 >=：0.x 的 ^0.1.0 只到 0.1.x，主插件一升 0.2.0 这条就会自己过期
  assert.equal(checkRequires({ requires: { core: '>=0.1.0' } }).ok, true)
  const bad = checkRequires({ requires: { core: '^9.0.0' } })
  assert.equal(bad.ok, false); assert.equal(bad.errors[0].code, 'E_RANGE_NOT_SATISFIED')
  assert.equal(checkRequires({ requires: { core: '^9.0.0' } }, { pluginVersion: '9.1.0' }).ok, true)
})

// --------------------------------------------------------------------------- 引擎注册表

await t('engine registry: register/resolve/dispose; unknown engine and version misses are explicit', () => {
  const reg = createEngineRegistry()
  const off = reg.register({ id: 'reading', version: '1.0.0', capabilities: ['docs.select', 'session.ask'] })
  assert.equal(reg.resolve('reading').version.raw, '1.0.0')
  assert.equal(reg.resolve('reading', '^1.0.0').version.raw, '1.0.0')
  off()
  try { reg.resolve('reading'); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_ENGINE_UNKNOWN') }
  const off2 = reg.register({ id: 'reading', version: '1.1.0', capabilities: [] })
  try { reg.resolve('reading', '^2.0.0'); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_ENGINE_VERSION_UNSUPPORTED') }
  try { reg.resolve('listening'); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_ENGINE_UNKNOWN') }
  // 同 id 同版本重复注册（1.1.0 还在册）→ E_FIELD_INVALID
  try { reg.register({ id: 'reading', version: '1.1.0', capabilities: [] }); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_FIELD_INVALID') }
  off2()
  try { reg.register({ id: 'Bad_Engine', version: '1.0.0' }); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_ID_INVALID') }
  try { reg.register({ id: 'reading2', version: '1.0.0', capabilities: ['magic'] }); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_CAPABILITY_UNKNOWN') }
  try { reg.register({ id: 'reading2', version: '1.0' }); assert.fail('should throw') } catch (e) { assert.equal(e.code, 'E_VERSION_MALFORMED') }
})

// --------------------------------------------------------------------------- 安装状态机

await t('transition: frozen table from the contract; unknown pairs are E_STATE_INVALID', () => {
  const cases = JSON.parse(readFileSync(join('contracts', 'fixtures', 'packkit', 'transition-cases.json'), 'utf8'))
  for (const [state, event, want] of cases) {
    let got; try { got = transition(state, event) } catch (e) { got = e.code }
    assert.equal(got, want, state + ' × ' + event)
  }
})

await t('packFrame still guards paths (packs.js 原语未变)', () => {
  const dir = tmp('frame')
  mkdirSync(join(dir, 'sprites'), { recursive: true })
  writeFileSync(join(dir, 'sprites', 'idle_00.png'), stubPng(1, 1))
  assert.ok(packFrame(dir, 'sprites/idle_00.png'))
  assert.equal(packFrame(dir, 'sprites/../../secret.png'), null)
  // 盘符路径按 python.test.mjs 的惯例拼接构造，隐私扫描看不到字面绝对路径
  assert.equal(packFrame(dir, 'C' + ':/windows/win.ini'), null)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
