// Independent round-trip and failure tests. New synthetic packs only; no images/services outside fixture.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createStudio } from '../lib/create.js'

const frame = fs.readFileSync(fileURLToPath(new URL('../tests/fixtures/reedit-lead-frame.png', import.meta.url)))
const required = ['idle', 'walk-left', 'walk-right', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'lie', 'mood-shy']
async function fixture (fn) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pixelpet-reedit-roundtrip-lead-')))
  try { return await fn(root) } finally {
    const actual = fs.realpathSync(root)
    assert.equal(dirname(actual), fs.realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-reedit-roundtrip-lead-'))
    fs.rmSync(actual, { recursive: true, force: true })
  }
}
function makePack (root) {
  const dir = join(root, 'base', 'characters', 'fixture')
  fs.mkdirSync(join(dir, 'sprites'), { recursive: true })
  fs.writeFileSync(join(dir, 'sprites', 'original.png'), frame)
  const data = { id: 'fixture', name: 'Synthetic Fixture', demo: false, canvas: [192, 208], logicalScale: 2,
    displayScale: 1.35, states: Object.fromEntries(required.map((id) => [id, { label: id, frames: ['sprites/original.png', 'sprites/original.png'], durationsMs: [137, 239], loop: id !== 'jumping' }])),
    aliases: { working: 'running', greeting: 'waving' }, moods: { happy: 'waving', '害羞': 'mood-shy' },
    lookDirections: Array.from({ length: 16 }, (_, i) => ({ degrees: i * 22.5, frame: 'sprites/original.png' })),
    extensions: { fixtureOnly: { original: true } }, anchor: [96, 188] }
  fs.writeFileSync(join(dir, 'character.json'), JSON.stringify(data))
  return { dir, data }
}
function studio (dataDir, validate, convert) {
  return createStudio({ dataDir,
    images: { generate: async () => { throw new Error('no generation in lead fixture') } },
    convert: convert || (async () => { throw new Error('unchanged existing art must not be re-converted') }),
    validate: validate || (async () => ({ ok: true, draft: false, validated: true, issues: [] })) })
}

test('renaming an installed character preserves timings, geometry, mappings and existing frame bytes', async () => fixture(async (root) => {
  const source = makePack(root); const dataDir = join(root, 'data'); const s = studio(dataDir)
  try {
    const r = s.reverse({ id: 'fixture', ...source })
    assert.equal(r.body.ok, true)
    const id = r.body.job.id
    s.update(id, { name: 'Edited Fixture Name' })
    const b = await s.build(id); assert.equal(b.body.ok, true)
    const out = join(dataDir, 'create', id, 'build', 'fixture')
    const manifest = JSON.parse(fs.readFileSync(join(out, 'character.json'), 'utf8'))
    assert.equal(manifest.name, 'Edited Fixture Name')
    for (const key of ['canvas', 'logicalScale', 'displayScale', 'aliases', 'moods', 'extensions', 'anchor']) assert.deepEqual(manifest[key], source.data[key], key)
    for (const key of required) {
      assert.deepEqual(manifest.states[key].durationsMs, source.data.states[key].durationsMs, key)
      assert.equal(manifest.states[key].loop, source.data.states[key].loop, key)
      assert.equal(manifest.states[key].frames.length, 2, key)
      for (const path of manifest.states[key].frames) assert.deepEqual(fs.readFileSync(join(out, path)), frame)
    }
    assert.deepEqual(manifest.lookDirections.map((x) => x.degrees), source.data.lookDirections.map((x) => x.degrees))
    for (const look of manifest.lookDirections) assert.deepEqual(fs.readFileSync(join(out, look.frame)), frame)
    assert.equal(JSON.parse(fs.readFileSync(join(source.dir, 'character.json'), 'utf8')).name, 'Synthetic Fixture')
  } finally { s.dispose() }
}))

test('reversed unchanged synthetic art passes the actual Python strict validator', { skip: !process.env.PIXELPET_TEST_PYTHON }, async () => fixture(async (root) => {
  const source = makePack(root); const dataDir = join(root, 'data')
  let called = 0; let proof
  const s = studio(dataDir, async (folder) => {
    called++
    const result = spawnSync(process.env.PIXELPET_TEST_PYTHON, ['runtime/validate.py', '--strict', folder], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
    })
    proof = result
    return { ok: !result.error && result.status === 0, draft: false,
      issues: result.status === 0 ? [] : [String(result.stdout || '') + '\n' + String(result.stderr || result.error || '')] }
  })
  try {
    const r = s.reverse({ id: 'fixture', ...source }); assert.equal(r.body.ok, true)
    const b = await s.build(r.body.job.id)
    assert.equal(called, 1)
    assert.equal(proof?.error, undefined)
    assert.equal(proof?.status, 0, String(proof?.stdout || '') + '\n' + String(proof?.stderr || ''))
    assert.equal(b.body.ok, true)
    assert.equal(b.body.build.validatedBy, 'python')
  } finally { s.dispose() }
}))

test('a real converter rejection cannot fall back to copying a same-size raw RGBA frame', async () => fixture(async (root) => {
  const source = makePack(root); const dataDir = join(root, 'data')
  const s = studio(dataDir, null, async () => ({ ok: false, available: true, message: 'synthetic-native-rejection' }))
  try {
    const r = s.reverse({ id: 'fixture', ...source }); assert.equal(r.body.ok, true)
    assert.equal(s.importFrame(r.body.job.id, 'waving_00.png', frame).body.ok, true)
    const result = await s.build(r.body.job.id)
    assert.equal(result.body.ok, false)
    assert.match(JSON.stringify(result.body.build.issues), /synthetic-native-rejection/)
  } finally { s.dispose() }
}))

test('unsafe manifest state keys cannot overwrite a file outside the newly created job', async () => fixture(async (root) => {
  const source = makePack(root); const dataDir = join(root, 'data'); const s = studio(dataDir)
  const outsideJob = join(dataDir, 'create', 'escape_00.png')
  fs.mkdirSync(dirname(outsideJob), { recursive: true }); fs.writeFileSync(outsideJob, 'synthetic-canary-keep')
  source.data.states['../../escape'] = { label: 'bad', frames: ['sprites/original.png'], durationsMs: [200], loop: true }
  let result
  try { result = s.reverse({ id: 'fixture', ...source }) } catch (e) { result = { body: { ok: false } } }
  try {
    assert.equal(result?.body?.ok, false)
    assert.equal(fs.readFileSync(outsideJob, 'utf8'), 'synthetic-canary-keep')
  } finally { s.dispose() }
}))

test('a failed final rename preserves the previous user overlay instead of deleting it', async () => fixture(async (root) => {
  const source = makePack(root); const dataDir = join(root, 'data'); const s = studio(dataDir)
  const originalRename = fs.renameSync
  try {
    const r = s.reverse({ id: 'fixture', ...source }); assert.equal(r.body.ok, true)
    const id = r.body.job.id
    const b = await s.build(id); assert.equal(b.body.ok, true)
    const target = join(dataDir, 'characters', 'fixture')
    fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(join(target, 'keep.txt'), 'previous-user-layer')
    let injected = false
    fs.renameSync = (from, to) => {
      if (!injected && resolve(String(to)) === resolve(target)) {
        injected = true
        const e = new Error('synthetic final-rename failure'); e.code = 'EACCES'; throw e
      }
      return originalRename(from, to)
    }
    syncBuiltinESMExports()
    let result
    try { result = s.install(id) } catch { result = { body: { ok: false } } }
    assert.equal(injected, true)
    assert.notEqual(result?.body?.ok, true)
    assert.equal(fs.readFileSync(join(target, 'keep.txt'), 'utf8'), 'previous-user-layer')
  } finally {
    fs.renameSync = originalRename; syncBuiltinESMExports(); s.dispose()
  }
}))
