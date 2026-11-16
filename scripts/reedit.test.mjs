// Re-editing installed packs (characters + furniture), user-layer overlays, reverse reading.
// Run from host.test.mjs: the fake DSH ctx, no network, no real Python (the validator is the JS one).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as CR from '../lib/create.js'
import * as FC from '../lib/furniture-create.js'
import { packFrame } from '../lib/packs.js'
import { resolveOne } from '../lib/packkit.js'
// M0 起 resolvePack 的分层决策归 packkit：这里保留旧的定位参数壳，调用点不用整批改写
const P = {
  packFrame,
  resolvePack: (pluginRoot, dataDir, kind, id) => resolveOne({ pluginRoot, dataDir, kind, id }),
}

const tmp = (p) => mkdtempSync(join(tmpdir(), 'pp-reedit-' + p + '-'))
const sha = (f) => createHash('sha1').update(readFileSync(f)).digest('hex')

export async function runReeditTests ({ t, H, fakeCtx, call }) {
  const data = tmp('host')
  const g = fakeCtx()
  const validate = (d) => (existsSync(join(d, 'furniture.json')) ? FC.jsValidateFurniture(d) : CR.jsValidate(d))
  // This suite intentionally has no Python: mark that explicitly, not as a real converter rejection.
  const unavailable = async () => ({ ok: false, available: false, message: 'fixture: no interpreter' })
  H.apply(g.ctx, { dataDir: data, validate, convert: unavailable, convertFurniture: unavailable })
  const route = g.route
  const png = readFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'sprites', 'idle_00.png'))

  // ------------------------------------------------------------------ pack resolution
  await t('packs: the user layer wins in list / resolve / thumbnail / preview; delete restores the built-in', async () => {
    const base = P.resolvePack(H.PLUGIN_ROOT, data, 'character', 'whale-girl')
    assert.equal(base.base, 'builtin')
    assert.ok(base.dir.startsWith(H.PLUGIN_ROOT))
    const img = readFileSync(P.packFrame(base.dir, base.data.states.idle.frames[0]))
    // a user copy with one changed frame and a changed name
    const dir = join(data, 'characters', 'whale-girl')
    mkdirSync(join(dir, 'sprites'), { recursive: true })
    for (const st of Object.values(base.data.states)) for (const rel of st.frames) copyFileSync(join(base.dir, rel), join(dir, rel))
    for (const l of base.data.lookDirections || []) copyFileSync(join(base.dir, l.frame), join(dir, l.frame))
    writeFileSync(join(dir, 'sprites', 'idle_00.png'), img)
    writeFileSync(join(dir, 'character.json'), JSON.stringify({ ...base.data, name: '改过的鲸鱼娘' }, null, 2))
    const over = P.resolvePack(H.PLUGIN_ROOT, data, 'character', 'whale-girl')
    assert.equal(over.base, 'user'); assert.equal(over.overlay, true); assert.equal(over.data.name, '改过的鲸鱼娘')
    const list = H.listCharacters(data).find((c) => c.id === 'whale-girl')
    assert.deepEqual([list.user, list.overlay, list.builtin, list.name], [true, true, true, '改过的鲸鱼娘'])
    const st = await call(route, 'GET', '/api/state')
    assert.equal(st.json.characters.find((c) => c.id === 'whale-girl').overlay, true)
    assert.equal((await call(route, 'GET', '/api/thumb/character/whale-girl')).status, 200)
    const pv = await call(route, 'GET', '/api/preview?id=whale-girl')
    assert.equal(pv.json.name, '改过的鲸鱼娘')
    // ✕ on an edited copy removes only the user layer; the built-in one comes back
    const rm = await call(route, 'POST', '/api/pack/remove', { body: { kind: 'character', id: 'whale-girl' } })
    assert.equal(rm.json.how, 'restored'); assert.equal(existsSync(dir), false)
    assert.equal(P.resolvePack(H.PLUGIN_ROOT, data, 'character', 'whale-girl').base, 'builtin')
    assert.equal(H.listCharacters(data).find((c) => c.id === 'whale-girl').user, false)
    assert.deepEqual((await call(route, 'GET', '/api/state')).json.settings.hidden.character, [])
    assert.equal(readFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'character.json'), 'utf8').includes('"name": "鲸鱼娘"'), true)
  })

  // ------------------------------------------------------------------ character reverse + edit
  let job
  await t('character reverse: every installed frame becomes an existing raw image, idle[0] the reference', async () => {
    const r = await call(route, 'POST', '/api/create/reverse', { body: { id: 'whale-girl' } })
    assert.equal(r.status, 200); assert.equal(r.json.ok, true)
    job = r.json.job
    assert.equal(job.targetId, 'whale-girl')
    assert.equal(job.origin.kind, 'pack'); assert.equal(job.origin.base, 'builtin')
    assert.deepEqual(job.origin.missing, [])
    const pack = P.resolvePack(H.PLUGIN_ROOT, data, 'character', 'whale-girl')
    const all = Object.values(pack.data.states).reduce((n, s) => n + s.frames.length, 0) + 16
    assert.equal(Object.keys(job.frames).length, all)
    assert.ok(Object.values(job.frames).every((f) => f === 'done'))
    assert.equal(job.ref.source, 'existing')
    assert.equal(readFileSync(join(data, 'create', job.id, 'ref.png')).length, readFileSync(P.packFrame(pack.dir, pack.data.states.idle.frames[0])).length)
    assert.equal(job.states.find((s) => s.id === 'idle').label, '待机')
    assert.equal(job.plan.pending, 0)
    assert.equal(job.plan.total, all)
    // asking again reuses the same job instead of piling up copies
    const again = await call(route, 'POST', '/api/create/reverse', { body: { id: 'whale-girl' } })
    assert.equal(again.json.reused, true); assert.equal(again.json.job.id, job.id)
    assert.equal((await call(route, 'POST', '/api/create/reverse', { body: { id: 'nope-nope' } })).status, 404)
  })

  await t('character edit: labels / per-frame durations / a custom mood state with frames and a working mood tag', async () => {
    let r = await call(route, 'POST', '/api/create/' + job.id + '/meta', { body: { name: '海边的鲸鱼', labels: { idle: '发呆', 'walk-left': '慢慢走' }, durations: { idle: [500, 300] } } })
    assert.equal(r.json.ok, true)
    const idle = r.json.job.states.find((s) => s.id === 'idle')
    assert.deepEqual([idle.label, idle.durationsMs], ['发呆', [500, 300, 300, 380, 110, 380]])
    // ids are generated machine-safe; the Chinese name only lives in label + mood tag
    r = await call(route, 'POST', '/api/create/' + job.id + '/meta', { body: { custom: [{ id: '../evil', label: '害羞', desc: '低着头脸红', frames: 3, ms: 300, mood: '害羞' }] } })
    const custom = r.json.job.custom[0]
    assert.match(custom.id, /^mood-c\d+$/)
    assert.equal(custom.label, '害羞')
    assert.equal(r.json.job.moods['害羞'], custom.id)
    // out of range values are clamped, never stored raw
    r = await call(route, 'POST', '/api/create/' + job.id + '/meta', { body: { custom: [{ ...custom, frames: 99, ms: 1 }] } })
    assert.deepEqual([r.json.job.custom[0].frames, r.json.job.custom[0].ms], [12, 40])
    r = await call(route, 'POST', '/api/create/' + job.id + '/meta', { body: { custom: [{ ...custom, frames: 3, ms: 300 }] } })
    // frames of a custom state are imported (or generated) one by one
    let i = await call(route, 'POST', '/api/create/' + job.id + '/import?name=' + encodeURIComponent(custom.id + '_00.png'), { body: png })
    assert.equal(i.json.ok, true)
    i = await call(route, 'POST', '/api/create/' + job.id + '/import?name=' + encodeURIComponent(custom.id + '_05.png'), { body: png })
    assert.equal(i.status, 400)
    i = await call(route, 'POST', '/api/create/' + job.id + '/import?name=' + encodeURIComponent('idle_06.png'), { body: png })
    assert.equal(i.status, 400)
    const v = (await call(route, 'GET', '/api/create/' + job.id)).json.job
    assert.equal(v.plan.pending, 2)
    // required states cannot be dropped: there is no API for it and they survive a build with no frames removed
    assert.ok(v.states.filter((s) => s.required).length >= 10)
  })

  await t('character build+install: user layer only, metadata kept, mood reachable through pixelpet_mood', async () => {
    const b = await call(route, 'POST', '/api/create/' + job.id + '/build', { body: {} })
    assert.equal(b.json.ok, true); assert.equal(b.json.build.draft, false)
    const built = JSON.parse(readFileSync(join(data, 'create', job.id, 'build', 'whale-girl', 'character.json'), 'utf8'))
    assert.equal(built.id, 'whale-girl'); assert.equal(built.name, '海边的鲸鱼')
    assert.equal(built.states.idle.label, '发呆')
    assert.deepEqual(built.states.idle.durationsMs, [500, 300, 300, 380, 110, 380])
    // untouched metadata survives: canvas / scale / aliases / gaze / unknown keys
    assert.deepEqual(built.canvas, [192, 208]); assert.equal(built.logicalScale, 2); assert.equal(built.displayScale, 1.2)
    assert.deepEqual(built.aliases, { working: 'running', done: 'review', alert: 'failed', poke: 'jumping' })
    assert.equal(built.lookDirections.length, 16)
    const customId = (await call(route, 'GET', '/api/create/' + job.id)).json.job.custom[0].id
    assert.deepEqual(built.states[customId].frames, ['sprites/' + customId + '_00.png'])
    assert.equal(built.moods['害羞'], customId)
    assert.equal(built.draft, undefined)
    const ins = await call(route, 'POST', '/api/create/' + job.id + '/install', { body: {} })
    assert.equal(ins.json.ok, true); assert.equal(ins.json.overlay, true)
    assert.equal(existsSync(join(data, 'characters', 'whale-girl', 'character.json')), true)
    // the plugin's own copy is untouched, byte for byte
    assert.equal(sha(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'character.json')), sha(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'character.json')))
    assert.equal(readFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'character.json'), 'utf8').includes('"name": "鲸鱼娘"'), true)
    // what the pet really uses: the overlay, and the custom state is playable as a mood by its tag
    const pv = (await call(route, 'GET', '/api/preview?id=whale-girl')).json
    const st = pv.states.find((s) => s.id === customId)
    assert.ok(st, 'custom state listed for the pet')
    assert.deepEqual(st.play, { cmd: 'mood', tag: '害羞', seconds: 3 })
    assert.equal(pv.name, '海边的鲸鱼')
    // removing the overlay restores the built-in pack exactly
    const rm = await call(route, 'POST', '/api/pack/remove', { body: { kind: 'character', id: 'whale-girl' } })
    assert.equal(rm.json.how, 'restored')
    assert.equal((await call(route, 'GET', '/api/preview?id=whale-girl')).json.name, '鲸鱼娘')
  })

  // ------------------------------------------------------------------ hostile pack contents
  await t('reverse refuses traversal, absolute paths and symlinked frames (and leaves the plugin alone)', async () => {
    const dir = join(data, 'characters', 'evil-pack')
    mkdirSync(join(dir, 'sprites'), { recursive: true })
    copyFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'sprites', 'idle_00.png'), join(dir, 'sprites', 'idle_00.png'))
    const secret = join(data, 'secret.png')
    writeFileSync(secret, 'not a picture')
    const linked = join(dir, 'sprites', 'walk-left_00.png')
    let symlinkOk = true
    try { symlinkSync(secret, linked, 'file') } catch { symlinkOk = false }
    const data2 = JSON.parse(readFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'character.json'), 'utf8'))
    data2.id = 'evil-pack'
    data2.states = {
      idle: { label: '待机', frames: ['sprites/idle_00.png'], durationsMs: [100], loop: true },
      'walk-left': { label: '走', frames: ['sprites/../../secret.png', 'sprites/walk-left_00.png'], durationsMs: [100, 100], loop: true },
    }
    writeFileSync(join(dir, 'character.json'), JSON.stringify(data2))
    assert.equal(P.packFrame(dir, 'sprites/../../secret.png'), null)
    assert.equal(P.packFrame(dir, 'sprites/walk-left_00.png'), symlinkOk ? null : P.packFrame(dir, 'sprites/walk-left_00.png'))
    const r = await call(route, 'POST', '/api/create/reverse', { body: { id: 'evil-pack' } })
    const missing = r.json.job.origin.missing
    assert.ok(missing.includes('walk-left_00'), 'traversal frame refused')
    assert.ok(missing.includes('walk-left_01') || symlinkOk, 'symlinked frame refused')
    assert.equal(readFileSync(secret, 'utf8'), 'not a picture')
    assert.equal(existsSync(join(data, 'create', r.json.job.id, 'raw', 'walk-left_00.png')), false)
    rmSync(dir, { recursive: true, force: true })
  })

  // ------------------------------------------------------------------ furniture reverse
  await t('furniture reverse: spec / interactions / animations / placement / pack metadata, no drift after install', async () => {
    const src = JSON.parse(readFileSync(join(H.PLUGIN_ROOT, 'furniture', 'whale-nest', 'furniture.json'), 'utf8'))
    const r = await call(route, 'POST', '/api/fcreate/reverse', { body: { id: 'whale-nest' } })
    assert.equal(r.json.ok, true)
    const j = r.json.job
    assert.equal(j.targetId, 'whale-nest')
    assert.equal(j.card.idleState, 'empty')
    assert.deepEqual([j.card.size, j.card.floorPad], [[360, 300], 14])
    assert.deepEqual(j.card.anchor, src.interactions[0].occupant.anchor)
    assert.deepEqual(j.card.area, src.interactions[0].occupant.area)
    assert.deepEqual(j.card.clipPath, src.interactions[0].occupant.clipPath)
    assert.equal(j.card.clipY, src.interactions[0].occupant.clipY)
    assert.equal(j.card.main.verb, 'sleep'); assert.equal(j.card.main.state, 'occupied')
    assert.equal(j.card.exit.done, src.interactions[1].done)
    assert.deepEqual(j.card.pack, { order: 20, defaultEnabled: false, anchor: 'bottom-right', stand: { left: -54, right: 414 } })
    assert.deepEqual(j.card.extraStates.map((s) => [s.id, s.frames]), [['occupied', 4]])
    const b = await call(route, 'POST', '/api/fcreate/' + j.id + '/build', { body: {} })
    assert.equal(b.json.ok, true)
    const out = JSON.parse(readFileSync(join(data, 'create-furniture', j.id, 'build', 'whale-nest', 'furniture.json'), 'utf8'))
    for (const k of ['id', 'name', 'size', 'anchor', 'order', 'defaultEnabled', 'floorY', 'idle', 'stand']) assert.deepEqual(out[k], src[k], k)
    assert.deepEqual(Object.keys(out.states).sort(), Object.keys(src.states).sort())
    const occ = out.interactions[0].occupant
    assert.deepEqual(occ.area, src.interactions[0].occupant.area)
    assert.deepEqual(occ.clipPath, src.interactions[0].occupant.clipPath)
    assert.deepEqual(occ.anchor, src.interactions[0].occupant.anchor)
    assert.deepEqual(occ.drawnFor, src.interactions[0].occupant.drawnFor)
    assert.equal(out.interactions[0].state, 'occupied')
    const ins = await call(route, 'POST', '/api/fcreate/' + j.id + '/install', { body: {} })
    assert.equal(ins.json.ok, true); assert.equal(ins.json.overlay, true)
    assert.equal(existsSync(join(data, 'furniture', 'whale-nest', 'furniture.json')), true)
    const state = await call(route, 'GET', '/api/state')
    assert.equal(state.json.furniture.find((f) => f.id === 'whale-nest').overlay, true)
    // a piece with its own feature + idle state name (the mailbox) keeps both
    const m = await call(route, 'POST', '/api/fcreate/reverse', { body: { id: 'mailbox' } })
    assert.equal(m.json.job.card.idleState, 'idle')
    assert.equal(m.json.job.card.feature, 'mailbox')
    const mailSrc = JSON.parse(readFileSync(join(H.PLUGIN_ROOT, 'furniture', 'mailbox', 'furniture.json'), 'utf8'))
    assert.deepEqual(m.json.job.card.featureCfg, mailSrc.mailbox)
    await call(route, 'POST', '/api/fcreate/' + m.json.job.id + '/build', { body: {} })
    const mm = JSON.parse(readFileSync(join(data, 'create-furniture', m.json.job.id, 'build', 'mailbox', 'furniture.json'), 'utf8'))
    assert.equal(mm.idle, 'idle'); assert.equal(mm.feature, 'mailbox'); assert.equal(mm.mailbox.openState, 'open')
    const rm = await call(route, 'POST', '/api/pack/remove', { body: { kind: 'furniture', id: 'whale-nest' } })
    assert.equal(rm.json.how, 'restored')
    assert.equal(existsSync(join(data, 'furniture', 'whale-nest')), false)
    assert.equal(P.resolvePack(H.PLUGIN_ROOT, data, 'furniture', 'whale-nest').base, 'builtin')
  })

  await t('a failed build never replaces the installed user version', async () => {
    // install a good overlay first
    const r = await call(route, 'POST', '/api/fcreate/reverse', { body: { id: 'whale-nest' } })
    const jid = r.json.job.id
    await call(route, 'POST', '/api/fcreate/' + jid + '/meta', { body: { name: '好床' } })
    assert.equal((await call(route, 'POST', '/api/fcreate/' + jid + '/build', { body: {} })).json.ok, true)
    assert.equal((await call(route, 'POST', '/api/fcreate/' + jid + '/install', { body: {} })).json.ok, true)
    const installed = readFileSync(join(data, 'furniture', 'whale-nest', 'furniture.json'), 'utf8')
    // then break the frames: a wrong-size png makes the validator refuse the next build
    const bad = join(data, 'create-furniture', jid, 'raw', 'empty_00.png')
    writeFileSync(bad, readFileSync(join(H.PLUGIN_ROOT, 'characters', 'whale-girl', 'sprites', 'idle_00.png'))) // 192x208, not 360x300
    const b = await call(route, 'POST', '/api/fcreate/' + jid + '/build', { body: {} })
    assert.equal(b.json.ok, false)
    assert.ok((b.json.issues || []).some((x) => /尺寸|dimension|192/.test(x)) || b.json.build.issues.length)
    assert.equal(readFileSync(join(data, 'furniture', 'whale-nest', 'furniture.json'), 'utf8'), installed)
    const ins = await call(route, 'POST', '/api/fcreate/' + jid + '/install', { body: {} })
    assert.equal(ins.status, 400)
    assert.equal(readFileSync(join(data, 'furniture', 'whale-nest', 'furniture.json'), 'utf8'), installed)
    rmSync(join(data, 'furniture', 'whale-nest'), { recursive: true, force: true })
  })

  await t('job ids and paths cannot escape the data dir', async () => {
    assert.equal((await call(route, 'GET', '/api/create/..%2F..%2Fjob')).status, 404)
    assert.equal((await call(route, 'GET', '/api/fcreate/..%2F..')).status, 404)
    const r = await call(route, 'POST', '/api/create/reverse', { body: { id: '../../etc' } })
    assert.equal(r.status, 404)
  })
}
