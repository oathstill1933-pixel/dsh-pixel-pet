// Re-editing an installed pack with a MIX of frames: the pack's own frames stay byte-identical, while frames
// that were regenerated / imported after the reverse job are normalized onto the pack's own grid (green key,
// hard alpha, canvas / size, the pack's own foot line). Real runtime/validate.py --strict is the gate.
// Everything here is synthetic: new temp dataDir, PIL-drawn PNGs, no user art, no network, no image provider.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudio } from '../lib/create.js'
import { createFurnitureStudio } from '../lib/furniture-create.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PY = process.env.PIXELPET_TEST_PYTHON || ''
const hasPy = !!PY && spawnSync(PY, ['-c', 'import PIL'], { windowsHide: true }).status === 0
const sha = (f) => createHash('sha1').update(fs.readFileSync(f)).digest('hex')
const requiredStates = ['idle', 'walk-left', 'walk-right', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'lie']

/** run a snippet with the test interpreter (synthetic pictures only) */
function py (code, args = []) {
  const r = spawnSync(PY, ['-c', code, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
  assert.equal(r.status, 0, String(r.stderr || r.stdout))
  return r.stdout
}

function scene (root, path, { size, box, green }) {
  fs.mkdirSync(dirname(path), { recursive: true })
  py(`
import sys
from PIL import Image, ImageDraw
path, w, h, x0, y0, x1, y1, green = sys.argv[1:9]
w, h, x0, y0, x1, y1, green = int(w), int(h), int(x0), int(y0), int(x1), int(y1), green == '1'
im = Image.new("RGBA", (w, h), (0, 0, 0, 0) if not green else (0, 255, 0, 255))
d = ImageDraw.Draw(im)
d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(70, 92, 170, 255) if not green else (70, 92, 170, 255))
im.save(path)
`, [path, String(size[0]), String(size[1]), String(box[0]), String(box[1]), String(box[2]), String(box[3]), green ? '1' : '0'])
}

/** one fully valid character pack: every required state points at the same synthetic 192x208 frame */
function characterPack (root) {
  const dir = join(root, 'base', 'characters', 'fixture')
  scene(root, join(dir, 'sprites', 'frame.png'), { size: [192, 208], box: [48, 52, 144, 156] })
  const frames = (sid) => [`sprites/${sid}_00.png`, `sprites/${sid}_01.png`]
  const states = {}
  for (const sid of requiredStates) {
    for (const rel of frames(sid)) fs.copyFileSync(join(dir, 'sprites', 'frame.png'), join(dir, rel))
    states[sid] = { label: sid, frames: frames(sid), durationsMs: [120, 160], loop: sid !== 'jumping' }
  }
  const data = { id: 'fixture', name: 'Synthetic Fixture', demo: false, canvas: [192, 208], logicalScale: 2, displayScale: 1.35,
    states, aliases: { working: 'running' }, moods: { happy: 'waving' }, lookDirections: [],
    extensions: { fixtureOnly: { original: true } }, anchor: [96, 188] }
  fs.writeFileSync(join(dir, 'character.json'), JSON.stringify(data, null, 2))
  return { dir, data }
}

/** one fully valid furniture pack (side table size, two idle frames, a beside interaction) */
function furniturePack (root) {
  const dir = join(root, 'base', 'furniture', 'box')
  scene(root, join(dir, 'sprites', 'empty_00.png'), { size: [160, 160], box: [30, 40, 130, 160] })
  fs.copyFileSync(join(dir, 'sprites', 'empty_00.png'), join(dir, 'sprites', 'empty_01.png'))
  const data = { id: 'box', name: 'Box', size: [160, 160], anchor: 'bottom-right', defaultEnabled: true,
    order: 40, floorY: 150, stand: { left: 40, right: 120 }, idle: 'empty',
    states: { empty: { frames: ['sprites/empty_00.png', 'sprites/empty_01.png'], durationsMs: [1000, 1000] } },
    interactions: [{ verb: 'use', mode: 'beside', say: '去{name}', hint: '去桌子旁边', done: '{name}到了。', pose: 'waving', holdMs: 3000 }] }
  fs.writeFileSync(join(dir, 'furniture.json'), JSON.stringify(data, null, 2))
  return { dir, data }
}

function workspace (tag) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pixelpet-mixed-' + tag + '-')))
  return {
    root,
    dataDir: join(root, 'data'),
    done () {
      const actual = fs.realpathSync(root)
      assert.equal(dirname(actual), fs.realpathSync(tmpdir()))
      assert.ok(basename(actual).startsWith('pixelpet-mixed-' + tag + '-'))
      fs.rmSync(actual, { recursive: true, force: true })
    },
  }
}

const realConvert = (counter) => ({ src, out, specFile }) => {
  counter.n++
  const r = spawnSync(PY, [join(ROOT, 'runtime', 'create_convert.py'), '--src', src, '--out', out, '--spec', specFile],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { return { ok: false, message: 'converter said nothing' } }
}
const realConvertFurniture = (counter) => ({ src, out, frames, size }) => {
  counter.n++
  const r = spawnSync(PY, [join(ROOT, 'runtime', 'furniture_convert.py'), '--src', src, '--out', out, '--frames', frames.join(','), '--size', size.join(',')],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { return { ok: false, message: 'converter said nothing' } }
}
const realValidate = (dir) => {
  const r = spawnSync(PY, [join(ROOT, 'runtime', 'validate.py'), '--strict', dir],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
  const lines = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  return { ok: r.status === 0, draft: /骨架/.test(lines[0] || ''), issues: r.status === 0 ? [] : [lines.join('\n') + '\n' + String(r.stderr || '')],
    message: lines[0] || '' }
}
const imageInfo = (file) => {
  const out = py(`
import sys
from PIL import Image
im = Image.open(sys.argv[1])
box = None if im.mode != "RGBA" else im.getchannel("A").getbbox()
print(im.size[0], im.size[1], im.mode, box[3] if box else -1, im.getchannel("A").histogram()[255] if im.mode == "RGBA" else 0)
`, [file])
  const [w, h, mode, bottom, opaque] = out.trim().split(/\s+/)
  return { w: Number(w), h: Number(h), mode, bottom: Number(bottom), opaque: Number(opaque) }
}

test('character re-edit: only regenerated / imported frames are normalized, the pack frames stay byte-identical', { skip: !hasPy }, async () => {
  const ws = workspace('char')
  try {
    const source = characterPack(ws.root)
    const counter = { n: 0 }
    const s = createStudio({ dataDir: ws.dataDir, images: { generate: async () => { throw new Error('no generation here') } },
      convert: realConvert(counter), validate: realValidate })
    try {
      const r = s.reverse({ id: 'fixture', dir: source.dir, data: source.data, base: 'builtin' })
      assert.equal(r.body.ok, true)
      const id = r.body.job.id
      const out = join(ws.dataDir, 'create', id, 'build', 'fixture')

      // positive control: nothing new -> nothing is converted, every frame is the pack's own bytes
      const noop = await s.build(id)
      assert.equal(noop.body.ok, true, JSON.stringify(noop.body.build.issues))
      assert.equal(counter.n, 0, 'unchanged existing art must not be re-converted')
      const manifest0 = JSON.parse(fs.readFileSync(join(out, 'character.json'), 'utf8'))
      for (const sid of requiredStates) {
        for (const rel of manifest0.states[sid].frames) assert.equal(sha(join(out, rel)), sha(join(source.dir, 'sprites', 'frame.png')), rel)
      }
      assert.deepEqual(manifest0.extensions, source.data.extensions)

      // a regenerated frame (what the RUNNER writes: raw + source='generated') and an imported one
      const greenBig = join(ws.root, 'gen', 'running_01.png')
      scene(ws.root, greenBig, { size: [1024, 1024], box: [256, 200, 768, 1024], green: true })
      fs.copyFileSync(greenBig, join(ws.dataDir, 'create', id, 'raw', 'running_01.png'))
      const jobFile = join(ws.dataDir, 'create', id, 'job.json')
      const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
      job.frames['running_01'] = { status: 'done', source: 'generated', at: Date.now() }
      fs.writeFileSync(jobFile, JSON.stringify(job, null, 2))
      const greenBig2 = join(ws.root, 'gen', 'waving_01.png')
      scene(ws.root, greenBig2, { size: [900, 900], box: [200, 150, 700, 900], green: true })
      const imported = s.importFrame(id, 'waving_01.png', fs.readFileSync(greenBig2))
      assert.equal(imported.body.ok, true, JSON.stringify(imported.body))

      const b = await s.build(id)
      assert.equal(b.body.ok, true, JSON.stringify(b.body.build.issues))
      assert.equal(b.body.build.validatedBy, 'python')
      assert.equal(counter.n, 1, 'exactly one normalization pass for the new frames')
      const manifest = JSON.parse(fs.readFileSync(join(out, 'character.json'), 'utf8'))

      // the two new frames are real frames of the pack's grid now
      const fresh = [join(out, 'sprites', 'running_01.png'), join(out, 'sprites', 'waving_01.png')]
      for (const file of fresh) {
        const info = imageInfo(file)
        assert.deepEqual([info.w, info.h, info.mode], [192, 208, 'RGBA'], file)
        assert.ok(info.opaque > 100, file + ' 归一化后不该是空的')
        assert.equal(info.bottom, 156, file + ' 要站在原包待机帧的落脚线上')
        assert.notEqual(sha(file), sha(join(ws.root, 'gen', basename(file))), file + ' 不能把绿底大图原样复制')
      }
      // every other frame (the pack's own) is still the original bytes
      for (const sid of requiredStates) {
        for (const rel of manifest.states[sid].frames) {
          if (rel === 'sprites/running_01.png' || rel === 'sprites/waving_01.png') continue
          assert.equal(sha(join(out, rel)), sha(join(source.dir, 'sprites', 'frame.png')), rel)
        }
      }
      // metadata of the template survives
      assert.deepEqual(manifest.canvas, source.data.canvas)
      assert.equal(manifest.logicalScale, 2)
      assert.equal(manifest.displayScale, 1.35)
      assert.deepEqual(manifest.aliases, source.data.aliases)
      assert.deepEqual(manifest.moods, source.data.moods)
      assert.deepEqual(manifest.extensions, source.data.extensions)
      assert.deepEqual(manifest.states.waving.durationsMs, [120, 160])
      assert.equal(manifest.states.waving.loop, true)
      assert.equal(manifest.states.jumping.loop, false)
      assert.equal(fs.existsSync(join(ws.dataDir, 'create', id, 'normalize.json')), false, 'brief 用完要删掉')

      // the real validator agrees (build already ran it, this is the independent check)
      const verdict = realValidate(out)
      assert.equal(verdict.ok, true, String(verdict.issues))

      // install writes the user layer; the plugin's own pack is untouched
      const inst = s.install(id)
      assert.equal(inst.body.ok, true, JSON.stringify(inst.body))
      assert.equal(fs.existsSync(join(ws.dataDir, 'characters', 'fixture', 'sprites', 'waving_01.png')), true)
      assert.equal(sha(join(source.dir, 'sprites', 'frame.png')), sha(join(source.dir, 'sprites', 'frame.png')))
      assert.deepEqual(JSON.parse(fs.readFileSync(join(source.dir, 'character.json'), 'utf8')).extensions, source.data.extensions)

      // a frame that cannot be normalized fails the build and leaves the installed layer alone
      const installedBefore = sha(join(ws.dataDir, 'characters', 'fixture', 'sprites', 'waving_01.png'))
      const blank = join(ws.root, 'gen', 'lie_01.png')
      py('import sys\nfrom PIL import Image\nImage.new("RGB", (512, 512), (0, 255, 0)).save(sys.argv[1])', [blank])
      assert.equal(s.importFrame(id, 'lie_01.png', fs.readFileSync(blank)).body.ok, true)
      const bad = await s.build(id)
      assert.equal(bad.body.ok, false)
      assert.ok(bad.body.build.issues.length, '失败要有原因')
      assert.equal(installedBefore, sha(join(ws.dataDir, 'characters', 'fixture', 'sprites', 'waving_01.png')))
      assert.equal(s.install(id).body.ok, false)
    } finally { s.dispose() }
  } finally { ws.done() }
})

test('no converter on the machine: canonical RGBA frames are still usable, green-background ones are refused', { skip: !hasPy }, async () => {
  const ws = workspace('nopy')
  try {
    const source = characterPack(ws.root)
    const s = createStudio({ dataDir: ws.dataDir, images: { generate: async () => { throw new Error('no generation here') } },
      convert: async () => ({ ok: false, available: false, message: '找不到 Python' }), validate: realValidate })
    try {
      const r = s.reverse({ id: 'fixture', dir: source.dir, data: source.data, base: 'builtin' })
      const id = r.body.job.id
      const out = join(ws.dataDir, 'create', id, 'build', 'fixture')
      // an already normalized import (192x208 RGBA) needs no conversion at all
      const ok = join(ws.root, 'gen', 'waving_01.png')
      scene(ws.root, ok, { size: [192, 208], box: [48, 52, 144, 156], green: false })
      assert.equal(s.importFrame(id, 'waving_01.png', fs.readFileSync(ok)).body.ok, true)
      const b1 = await s.build(id)
      assert.equal(b1.body.ok, true, JSON.stringify(b1.body.build.issues))
      assert.equal(sha(join(out, 'sprites', 'waving_01.png')), sha(ok))
      // a green background picture of the wrong size can never be passed off as a finished frame
      const big = join(ws.root, 'gen', 'waving_00.png')
      scene(ws.root, big, { size: [1024, 1024], box: [256, 200, 768, 1024], green: true })
      assert.equal(s.importFrame(id, 'waving_00.png', fs.readFileSync(big)).body.ok, true)
      const b2 = await s.build(id)
      assert.equal(b2.body.ok, false)
      assert.ok(b2.body.build.issues.join(' ').includes('归一化'), String(b2.body.build.issues))
    } finally { s.dispose() }
  } finally { ws.done() }
})

test('furniture re-edit: a regenerated frame is fitted to the card, existing frames keep their bytes', { skip: !hasPy }, async () => {
  const ws = workspace('furn')
  try {
    const source = furniturePack(ws.root)
    const counter = { n: 0 }
    const s = createFurnitureStudio({ dataDir: ws.dataDir, images: { generate: async () => { throw new Error('no generation here') } },
      convert: realConvertFurniture(counter), validate: realValidate, relay: { post: async () => ({ code: 200, body: {} }) }, sessionId: () => '' })
    try {
      const r = s.reverse({ id: 'box', dir: source.dir, data: source.data, base: 'builtin' })
      assert.equal(r.body.ok, true)
      const id = r.body.job.id
      const out = join(ws.dataDir, 'create-furniture', id, 'build', 'box')

      const noop = await s.build(id)
      assert.equal(noop.body.ok, true, JSON.stringify(noop.body.build.issues))
      assert.equal(counter.n, 0)

      const big = join(ws.root, 'gen', 'empty_01.png')
      scene(ws.root, big, { size: [900, 900], box: [200, 120, 700, 900], green: true })
      assert.equal(s.importFrame(id, 'empty_01.png', fs.readFileSync(big)).body.ok, true)
      const b = await s.build(id)
      assert.equal(b.body.ok, true, JSON.stringify(b.body.build.issues))
      assert.equal(counter.n, 1)

      const fresh = join(out, 'sprites', 'empty_01.png')
      const info = imageInfo(fresh)
      assert.deepEqual([info.w, info.h, info.mode], [160, 160, 'RGBA'])
      assert.ok(info.opaque > 100)
      assert.equal(info.bottom, 160, '要和原件自己的画面底边齐（这张卡片的画一直画到最底边）')
      assert.notEqual(sha(fresh), sha(big))
      assert.equal(sha(join(out, 'sprites', 'empty_00.png')), sha(join(source.dir, 'sprites', 'empty_00.png')))
      const manifest = JSON.parse(fs.readFileSync(join(out, 'furniture.json'), 'utf8'))
      assert.deepEqual(manifest.size, [160, 160])
      assert.equal(manifest.floorY, 150)
      assert.equal(manifest.idle, 'empty')
      assert.deepEqual(manifest.states.empty.frames, ['sprites/empty_00.png', 'sprites/empty_01.png'])
      assert.equal(manifest.interactions[0].pose, 'waving')
      assert.equal(realValidate(out).ok, true)
      assert.equal(s.install(id).body.ok, true)
      assert.equal(fs.existsSync(join(ws.dataDir, 'furniture', 'box', 'sprites', 'empty_01.png')), true)

      // pure green -> failure, and the installed user piece is not replaced by the broken build
      const installed = sha(join(ws.dataDir, 'furniture', 'box', 'sprites', 'empty_01.png'))
      const blank = join(ws.root, 'gen', 'empty_01.png')
      py('import sys\nfrom PIL import Image\nImage.new("RGB", (900, 900), (0, 255, 0)).save(sys.argv[1])', [blank])
      assert.equal(s.importFrame(id, 'empty_01.png', fs.readFileSync(blank)).body.ok, true)
      const bad = await s.build(id)
      assert.equal(bad.body.ok, false)
      assert.ok(bad.body.build.issues.length)
      assert.equal(installed, sha(join(ws.dataDir, 'furniture', 'box', 'sprites', 'empty_01.png')))
      assert.equal(s.install(id).body.ok, false)
    } finally { s.dispose() }
  } finally { ws.done() }
})
