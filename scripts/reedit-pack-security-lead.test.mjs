// Lead-only path tests. All links target newly created fixtures, never user/plugin data.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { packFrame } from '../lib/packs.js'
import { resolveOne } from '../lib/packkit.js'
// M0 起 resolvePack 的分层决策归 packkit：这里保留旧的定位参数壳
const resolvePack = (pluginRoot, dataDir, kind, id) => resolveOne({ pluginRoot, dataDir, kind, id })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
function fixture (fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pixelpet-reedit-pack-lead-')))
  try { return fn(root) } finally {
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-reedit-pack-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
}
function linkDirectory (target, link, t) {
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('OS did not permit fixture symlink creation'); return false }
    throw e
  }
}

test('reverse editing accepts a safe nested frame path, not only flat ASCII sprites names', () => fixture((root) => {
  const pack = join(root, 'pack')
  const relative = 'assets/nested/帧.png'
  mkdirSync(join(pack, 'assets', 'nested'), { recursive: true })
  writeFileSync(join(pack, relative), png)
  assert.equal(packFrame(pack, relative), join(pack, relative))
}))

test('frame resolver rejects a linked intermediate directory escaping the pack', (t) => fixture((root) => {
  const pack = join(root, 'pack'); const outside = join(root, 'outside-fixture')
  mkdirSync(pack); mkdirSync(outside)
  writeFileSync(join(outside, 'frame.png'), png)
  if (!linkDirectory(outside, join(pack, 'sprites'), t)) return
  assert.equal(packFrame(pack, 'sprites/frame.png'), null)
}))

test('frame resolver rejects a pack folder that is itself a link', (t) => fixture((root) => {
  const outside = join(root, 'outside-fixture'); const link = join(root, 'linked-pack')
  mkdirSync(join(outside, 'sprites'), { recursive: true })
  writeFileSync(join(outside, 'sprites', 'frame.png'), png)
  if (!linkDirectory(outside, link, t)) return
  assert.equal(packFrame(link, 'sprites/frame.png'), null)
}))

test('pack resolution does not read a manifest through a linked user pack folder', (t) => fixture((root) => {
  const base = join(root, 'base'); const data = join(root, 'data'); const target = join(root, 'outside-fixture')
  mkdirSync(join(base, 'characters'), { recursive: true })
  mkdirSync(join(data, 'characters'), { recursive: true }); mkdirSync(target)
  writeFileSync(join(target, 'character.json'), JSON.stringify({ id: 'fixture', name: 'forbidden-linked-fixture' }))
  if (!linkDirectory(target, join(data, 'characters', 'fixture'), t)) return
  const result = resolvePack(base, data, 'character', 'fixture')
  assert.notEqual(result?.data?.name, 'forbidden-linked-fixture')
}))
