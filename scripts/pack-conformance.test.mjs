// node scripts/pack-conformance.test.mjs — M0 跨语言一致性基线（Node 侧）。
// 同一批 contracts/fixtures/packkit/ 夹具：Node 的解析结果必须逐字段等于 expected-resolution.json，
// manifest v1 校验等于 expected-manifests.json，版本/状态机等于 version-cases / transition-cases。
// Python 侧镜像：tests/test_pack_conformance.py。两边各对同一份期望值断言 —— 这就是
// 「同一清单在所有读取端得到相同结果；未支持契约有显式错误」的钉死方式。
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPointer, migrateRegistry, packStoreDir, readVoicePreset, validateCharacterPack } from '../lib/packkit.js'
import { checkPackManifest, loadContract, permissionIds, capabilityIds, snapshot, satisfiesRange, transition, installStates } from '../lib/packkit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FX = join(HERE, '..', 'contracts', 'fixtures', 'packkit')
const read = (p) => JSON.parse(readFileSync(join(FX, p), 'utf8'))

let pass = 0; let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) } catch (e) { fail++; console.log('FAIL', name, '\n ', e && e.stack || e) }
}

const pick = (e) => ({
  id: e.id, base: e.base, overlay: e.overlay, valid: e.valid, draft: e.draft,
  has_errors: e.errors.length > 0, user_has_errors: e.userErrors.length > 0, user_draft: e.userDraft,
  user: e.user, builtin: e.builtin,
})

t('resolution: Node snapshot == expected-resolution.json (characters + furniture)', () => {
  const expected = read('expected-resolution.json')
  const snap = snapshot({ pluginRoot: join(FX, 'plugin-root'), dataDir: join(FX, 'user-root'), settings: {} })
  assert.deepEqual(snap.characters.map(pick), expected.characters)
  assert.deepEqual(snap.furniture.map(pick), expected.furniture)
})

t('manifest v1: Node checkPackManifest == expected-manifests.json（未支持契约显式报错）', () => {
  const expected = read('expected-manifests.json')
  for (const [name, want] of Object.entries(expected)) {
    if (name.startsWith('_')) continue
    let r
    if (name === 'bad-json') {
      // 语法级损坏在 readManifestStrict 拦下，checkPackManifest 对非对象输入报同一码
      r = checkPackManifest(null)
    } else {
      r = checkPackManifest(JSON.parse(readFileSync(join(FX, 'ext', name, 'manifest.json'), 'utf8')))
    }
    const codes = [...new Set(r.errors.map((e) => e.code))].sort()
    assert.equal(r.ok, want.ok, name)
    assert.deepEqual(codes, want.errorCodes, name)
  }
})

t('versions: Node satisfiesRange == version-cases.json（含 RC 范围语义）', () => {
  for (const [ver, range, want] of read('version-cases.json')) {
    let got; try { got = satisfiesRange(ver, range) } catch (e) { got = e.code }
    assert.equal(got, want, ver + ' vs ' + range)
  }
})

t('transitions: Node transition == transition-cases.json', () => {
  for (const [state, event, want] of read('transition-cases.json')) {
    let got; try { got = transition(state, event) } catch (e) { got = e.code }
    assert.equal(got, want, state + ' × ' + event)
  }
})

t('contract: installStates / transitions / permissions / capabilities self-consistent', () => {
  const c = loadContract()
  assert.deepEqual(installStates(), c.installStates)
  const states = new Set(installStates())
  for (const [from, row] of Object.entries(c.stateTransitions)) {
    assert.ok(states.has(from), '未知状态 ' + from)
    for (const ev of Object.keys(row)) assert.ok(c.installEvents.includes(ev), '未声明事件 ' + ev)
  }
  assert.deepEqual(permissionIds().sort(), c.permissions.map((p) => p.id).sort())
  assert.deepEqual(capabilityIds().sort(), c.capabilities.map((x) => x.id).sort())
  // 权限/能力 id 不得互相重复（playback.status 同时出现在两侧是设计好的，但同表内必须唯一）
  assert.equal(new Set(permissionIds()).size, permissionIds().length)
  assert.equal(new Set(capabilityIds()).size, capabilityIds().length)
})

t('pack layer: Node loadPointer + packStoreDir == expected-pack-layer.json（权限门 + dir 校验与 Python 一致）', () => {
  const data = join(FX, 'pack-data')
  for (const c of read('expected-pack-layer.json').cases) {
    const reg = migrateRegistry({ v: c.v1 ? 1 : 2, generation: 0, packs: { [c.id]: JSON.parse(JSON.stringify(c.entry)) } })
    const dir = packStoreDir(data, loadPointer(reg.packs[c.id]))
    assert.equal(dir !== null, c.load, c.id)
    if (c.dir) assert.ok(dir.replace(/\\/g, '/').endsWith('/' + c.dir), c.id)
  }
})

t('voice preset: Node structure and character validity match shared fixtures', () => {
  const { base, cases } = read('voice-presets.json')
  const char = join(FX, 'plugin-root', 'characters', 'good-char')
  const original = JSON.parse(readFileSync(join(char, 'character.json'), 'utf8'))
  for (const row of cases) {
    const root = mkdtempSync(join(tmpdir(), 'pp-preset-'))
    cpSync(char, root, { recursive: true })
    const voice = join(root, 'voice')
    mkdirSync(voice)
    for (const name of ['ref.wav', 'anchor.json']) {
      if (name !== row.missing) writeFileSync(join(voice, name), '{}')
    }
    if (row.large) truncateSync(join(voice, row.large.file), row.large.bytes)
    writeFileSync(join(voice, 'preset.json'), row.json ?? JSON.stringify({ ...base, ...row.patch }))
    let code = null
    try { assert.ok(readVoicePreset(root)) } catch (e) { code = e.code }
    assert.equal(code, row.code, row.label)
    const res = validateCharacterPack(root, original, original.id)
    assert.equal(res.errors[0]?.code || null, row.code, row.label)
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
