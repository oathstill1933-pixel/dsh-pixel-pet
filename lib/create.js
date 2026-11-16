/**
 * "+ 新建角色": jobs under <data>/create/<id>/
 *
 *   job.json        name, description, chosen optional states, per-frame status, last build
 *   upload.png      user's reference picture (optional, input to candidate generation)
 *   cand/*.png      candidate looks; one is copied to ref.png ("定稿参考图")
 *   raw/<k>.png     one raw image per frame, k = <state>_<NN> (look_00..look_15 for gaze)
 *   build/<id>/     converted pack (character.json + sprites/), validated, then installed to
 *                   <data>/characters/<id>/
 *
 * The action list and per-image spec follow characters/whale-girl/tools/source/codex/README.md.
 * Every frame request carries ref.png. The runner lives in the host, so closing the page does not stop it;
 * a frame is done once its raw file is on disk, so any re-run (after a failure, a stop or a host restart)
 * only generates what is missing.
 *
 * Re-editing an installed pack (either a built-in or someone else's): reversePack() reads the pack's own
 * character.json, copies every existing frame into raw/ as "already there", and remembers the manifest as
 * `template`. Such a job has no dependency on the author's draft; build() then works in passthrough mode
 * (raw -> sprites, manifest rewritten from the template) instead of re-converting the art, so nothing is
 * flattened: canvas / logicalScale / displayScale / aliases / lookDirections / unknown fields survive, and
 * `targetId` makes install() write the user layer <data>/characters/<targetId> without touching the plugin.
 *
 * Extra states: a job may carry `custom` = [{id, label, desc, frames, ms, loop, mood}]. Their ids are
 * machine-safe (a-z0-9-), the labels are the Chinese names shown in the UI, and a mood tag lands in
 * character.json "moods" so pixelpet_mood really accepts it.
 */
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { imageType } from './imagegen.js'
import { PACK_ID_RE, packFrame } from './packs.js'

export const NAME_RE = /^([a-z][a-z0-9-]{0,39})_(\d{2})\.(png|jpe?g|webp)$/i
export const JOB_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

const F = (n, ms) => Array.from({ length: n }, () => ms)
// id, frames, required, label, loop, durations, what to draw
export const SPEC = [
  { id: 'idle', n: 6, req: true, label: '待机', loop: true, ms: [420, 300, 300, 380, 110, 380], hint: 'idle loop: breathing, blinking, tail or hair swaying gently' },
  { id: 'walk-left', n: 4, req: true, label: '向左走', loop: true, ms: F(4, 160), hint: 'walking to the LEFT, walk cycle. Draw this direction directly, do not mirror the right-facing frames: asymmetric accessories stay on their original side' },
  { id: 'walk-right', n: 4, req: true, label: '向右走', loop: true, ms: F(4, 160), hint: 'walking to the RIGHT, walk cycle. Do not mirror the left-facing frames: asymmetric accessories stay on their original side' },
  { id: 'waving', n: 4, req: true, label: '招手', loop: true, ms: [150, 150, 150, 260], hint: 'waving one hand' },
  { id: 'jumping', n: 6, req: true, label: '跳', loop: false, ms: [120, 110, 200, 110, 160, 500], hint: 'a jump: crouch, take off, in the air, falling, landing, recover', frames: ['crouching', 'taking off', 'highest point in the air', 'falling', 'landing', 'recovered standing'] },
  { id: 'failed', n: 4, req: true, label: '出错', loop: true, ms: F(4, 330), hint: 'error / server busy: lying face down asleep, a small "Zzz" above the head' },
  { id: 'waiting', n: 4, req: true, label: '等待', loop: true, ms: F(4, 250), hint: 'waiting patiently, small idle fidget' },
  { id: 'running', n: 6, req: true, label: '工作中', loop: true, ms: [170, 170, 170, 170, 170, 260], hint: 'busy working / thinking hard' },
  { id: 'review', n: 8, req: true, label: '检查', loop: false, ms: [170, 170, 170, 170, 170, 170, 170, 600], hint: 'checking or reviewing something, ending in a satisfied pose' },
  { id: 'lie', n: 4, req: true, label: '躺下', loop: true, ms: F(4, 500), hint: 'lying down, relaxed' },
  { id: 'listening', n: 4, req: false, label: '在听', loop: true, ms: F(4, 220), hint: 'listening to the user speaking' },
  { id: 'attentive', n: 2, req: false, label: '注意', loop: true, ms: [800, 500], hint: 'attentive, alert' },
  { id: 'curl-sleep', n: 2, req: false, label: '蜷着睡', loop: true, ms: [700, 600], hint: 'curled up asleep (used when sleeping in a bed; do NOT draw the bed)' },
  { id: 'speaking', n: 4, req: false, label: '说话', loop: true, ms: F(4, 120), base: 'idle_00', hint: 'speaking. Body exactly identical to the idle frame; only the mouth changes', frames: ['mouth closed', 'mouth half open', 'mouth fully open', 'mouth half open'] },
  { id: 'drag-left', n: 4, req: false, label: '向左拖', loop: true, ms: F(4, 140), hint: 'being picked up by the mouse and dragged to the LEFT: feet off the ground, body and tail swing to the right (opposite of the drag), panicked face. Do not mirror the right version' },
  { id: 'drag-right', n: 4, req: false, label: '向右拖', loop: true, ms: F(4, 140), hint: 'being picked up by the mouse and dragged to the RIGHT: feet off the ground, body and tail swing to the left, panicked face. Do not mirror the left version' },
  ...[['happy', '开心'], ['surprised', '惊讶'], ['confused', '疑惑'], ['thinking', '思考'], ['sleepy', '困'], ['sad', '委屈'], ['oops', '闯祸']].map(([m, l]) => ({
    id: 'mood-' + m, n: 4, req: false, label: l, loop: true, ms: F(4, 250),
    hint: m === 'oops' ? 'expression: oops, just made a mistake (tongue out, covering mouth or a sweat drop)' : 'expression: ' + m,
  })),
  { id: 'look', n: 16, req: false, label: '视线', loop: false, ms: F(16, 100), base: 'idle_00', single: true, hint: 'gaze direction for mouse following. Body exactly identical to the idle frame; only the head and eyes turn' },
]
const LOOK_DIR = ['straight up', 'up, slightly right', 'up-right', 'right, slightly up', 'to the right side of the picture', 'right, slightly down', 'down-right', 'down, slightly right', 'straight down', 'down, slightly left', 'down-left', 'left, slightly down', 'to the left side of the picture', 'left, slightly up', 'up-left', 'up, slightly left']
export const SPEC_BY_ID = Object.fromEntries(SPEC.map((s) => [s.id, s]))
export const frameKey = (state, i) => state + '_' + String(i).padStart(2, '0')

export function planKeys (optional = []) {
  const want = SPEC.filter((s) => s.req || optional.includes(s.id))
  return want.flatMap((s) => Array.from({ length: s.n }, (_, i) => frameKey(s.id, i)))
}

// --------------------------------------------------------------------------- job model (pure)
export const CUSTOM_MAX = 16            // extra states on one job
export const CUSTOM_FRAMES_MAX = 12     // frames per extra state
export const DUR_RANGE = [40, 5000]     // validate.py DURATION_RANGE
export const CUSTOM_ID_RE = /^[a-z][a-z0-9-]{0,23}$/
export const LABEL_MAX = 12
export const MOOD_TAG_MAX = 12
export const LOOK_STATE = 'look'

const F_ = (n, ms) => Array.from({ length: n }, () => ms)
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const cleanLine = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)
const cleanText = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n)

/** every state id already owned by a job (template / spec / custom), in order */
export function stateOrder (job) {
  const ids = []
  const push = (s) => { if (typeof s === 'string' && s && !ids.includes(s)) ids.push(s) }
  const tpl = job && job.template && job.template.states
  if (tpl && typeof tpl === 'object' && !Array.isArray(tpl)) for (const sid of Object.keys(tpl)) push(sid)
  else for (const s of SPEC) if (s.req || (Array.isArray(job && job.optional) && job.optional.includes(s.id))) push(s.id)
  for (const c of (job && job.custom) || []) push(c.id)
  // gaze frames live in lookDirections (not in states); they are edited like a 16-frame group
  if (job && job.template && Array.isArray(job.template.lookDirections) && job.template.lookDirections.length === 16) push(LOOK_STATE)
  return ids
}

/** how many frame slots a state has in this job */
export function stateFramesOf (job, sid) {
  const c = ((job && job.custom) || []).find((x) => x.id === sid)
  if (c) return c.frames
  const tpl = job && job.template && job.template.states && job.template.states[sid]
  if (tpl && Array.isArray(tpl.frames) && tpl.frames.length) return tpl.frames.length
  const s = SPEC_BY_ID[sid]
  return s ? s.n : 0
}

export function slotKeys (job, sid) {
  return Array.from({ length: stateFramesOf(job, sid) }, (_, i) => frameKey(sid, i))
}

/** every frame slot of the job (the plan the page and the runner agree on) */
export function jobKeys (job) {
  return stateOrder(job).flatMap((sid) => slotKeys(job, sid))
}

export function labelOf (job, sid) {
  const own = job && job.labels && typeof job.labels[sid] === 'string' ? cleanLine(job.labels[sid], LABEL_MAX) : ''
  if (own) return own
  const tpl = job && job.template && job.template.states && job.template.states[sid]
  const tplLabel = tpl && typeof tpl.label === 'string' ? cleanLine(tpl.label, LABEL_MAX) : ''
  if (tplLabel) return tplLabel
  const c = ((job && job.custom) || []).find((x) => x.id === sid)
  if (c) return c.label
  const s = SPEC_BY_ID[sid]
  return s ? s.label : sid.slice(0, LABEL_MAX)
}

export function durationsOf (job, sid) {
  const n = stateFramesOf(job, sid)
  const custom = ((job && job.custom) || []).find((x) => x.id === sid)
  const tpl = job && job.template && job.template.states && job.template.states[sid]
  const mine = job && job.durations && Array.isArray(job.durations[sid]) ? job.durations[sid] : null
  let base
  if (mine && mine.length) base = mine.map((x) => clampInt(x, DUR_RANGE[0], DUR_RANGE[1], 160))
  else if (tpl && Array.isArray(tpl.durationsMs) && tpl.durationsMs.length) base = tpl.durationsMs.map((x) => clampInt(x, DUR_RANGE[0], DUR_RANGE[1], 160))
  else if (custom) base = F_(n, custom.ms)
  else if (SPEC_BY_ID[sid]) base = SPEC_BY_ID[sid].ms.slice()
  else base = F_(n, 160)
  while (base.length < n) base.push(base.length ? base[base.length - 1] : 160)
  return base.slice(0, n)
}

export function loopOf (job, sid) {
  const tpl = job && job.template && job.template.states && job.template.states[sid]
  if (tpl && typeof tpl.loop === 'boolean') return tpl.loop
  const c = ((job && job.custom) || []).find((x) => x.id === sid)
  if (c) return c.loop !== false
  const s = SPEC_BY_ID[sid]
  return s ? !!s.loop : true
}

/** {tag: stateId}: the template's own map, edited per job, plus the mood tag of every custom state */
export function moodsOf (job) {
  const have = new Set(stateOrder(job))
  const src = (job && job.moods && typeof job.moods === 'object' && !Array.isArray(job.moods))
    ? job.moods
    : ((job && job.template && job.template.moods) || {})
  const out = {}
  for (const [tag, sid] of Object.entries(src)) {
    const t = cleanLine(tag, MOOD_TAG_MAX)
    if (!t || typeof sid !== 'string' || !have.has(sid)) continue
    out[t] = sid
  }
  for (const c of (job && job.custom) || []) if (c.mood && have.has(c.id) && !out[c.mood]) out[c.mood] = c.id
  return out
}

/** what the page renders in the action grid */
export function stateInfo (job) {
  const custom = new Map(((job && job.custom) || []).map((c) => [c.id, c]))
  const moods = moodsOf(job)
  return stateOrder(job).map((sid) => {
    const s = SPEC_BY_ID[sid]
    const c = custom.get(sid)
    return {
      id: sid, label: labelOf(job, sid), frames: stateFramesOf(job, sid),
      durationsMs: durationsOf(job, sid), loop: loopOf(job, sid),
      required: !!(s && s.req), custom: !!c, single: !!(s && s.single),
      mood: Object.keys(moods).find((tag) => moods[tag] === sid) || '',
      hint: c ? c.desc : (s ? s.hint : ''),
    }
  })
}

/** patch.custom -> safe list; ids that are taken (template / spec / other custom) get a fresh one */
export function cleanCustom (list, taken = []) {
  const used = new Set(taken)
  const out = []
  for (const [i, c] of (Array.isArray(list) ? list : []).entries()) {
    if (out.length >= CUSTOM_MAX || !c || typeof c !== 'object') continue
    let id = String(c.id ?? '').trim().toLowerCase()
    if (!CUSTOM_ID_RE.test(id) || used.has(id)) {
      const base = c.mood || c.kind === 'mood' ? 'mood-c' : 'act-c'
      let n = i + 1
      while (used.has((base + n).slice(0, 24))) n++
      id = (base + n).slice(0, 24)
    }
    used.add(id)
    out.push({
      id, label: cleanLine(c.label, LABEL_MAX) || id, desc: cleanText(c.desc, 300),
      frames: clampInt(c.frames, 1, CUSTOM_FRAMES_MAX, 4), ms: clampInt(c.ms, DUR_RANGE[0], DUR_RANGE[1], 250),
      loop: c.loop !== false, mood: cleanLine(c.mood, MOOD_TAG_MAX),
    })
  }
  return out
}

const STYLE = 'Pixel art: crisp square pixels on a consistent pixel grid, limited palette, clean dark outline. No gradients, no blur, no anti-aliasing haze.'
const LAYOUT = 'Square canvas. One full-body character, centered. Same size and position as in every other frame: the feet always rest on the same horizontal line near the bottom, with free space above the head for jumps and hair.'
const LIMITS = 'Background: flat solid #00FF00 green, nothing else (no floor, no shadow). Exactly one frame, not a sprite sheet. No text, no watermark, no border.'

export function buildPrompt ({ desc, state, index, custom }) {
  const s = SPEC_BY_ID[state]
  const who = (desc || '').trim() || 'the character'
  if (!state) {
    return ['Purpose: character design reference for a desktop pet; later frames are generated from this picture.',
      'Subject: ' + who + '.', 'Pose: standing, relaxed idle pose, facing the viewer (slight 3/4 view).',
      'Style: ' + STYLE, 'Composition: ' + LAYOUT, 'Constraints: ' + LIMITS].join('\n')
  }
  if (!s) {
    // a state the author added themselves: only the description + frame number are known
    const c = custom && typeof custom === 'object' ? custom : null
    const n = c && c.frames ? c.frames : 1
    const what = c ? (c.desc || c.label || state) : ('animation "' + state + '"')
    return ['Purpose: one animation frame of a pixel desktop pet; it will be cut out and converted cell by cell.',
      'Subject: ' + who + '. Exactly the same character as the reference image: same design, colors and proportions.',
      'Action: ' + what + '. Frame ' + (index + 1) + ' of ' + n + '.',
      'Consistency: apart from the parts that move, keep every pixel the same as the other frames of this action.',
      'Style: ' + STYLE, 'Composition: ' + LAYOUT, 'Constraints: ' + LIMITS].join('\n')
  }
  const frame = s.single
    ? 'Looking ' + LOOK_DIR[index] + ' (direction ' + index + ' of 16, clockwise from straight up).'
    : 'Frame ' + (index + 1) + ' of ' + s.n + (s.frames && s.frames[index] ? ': ' + s.frames[index] : '') + '.'
  return ['Purpose: one animation frame of a pixel desktop pet; it will be cut out and converted cell by cell.',
    'Subject: ' + who + '. Exactly the same character as the reference image: same design, colors and proportions.',
    'Action: ' + s.hint + '. ' + frame,
    'Consistency: apart from the parts that move, keep every pixel the same as the other frames of this action.',
    'Style: ' + STYLE, 'Composition: ' + LAYOUT, 'Constraints: ' + LIMITS].join('\n')
}

// --------------------------------------------------------------------------- store
export function createStudio ({ dataDir, images, convert, validate, onInstalled, logger }) {
  const root = join(dataDir, 'create')
  const dirOf = (id) => join(root, id)
  const runs = new Map() // id -> { stop: bool, keys, done, failed, total, error, current }

  const atomicWrite = (file, data) => {
    const tmp = file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, data); renameSync(tmp, file)
  }
  const read = (id) => {
    if (!JOB_RE.test(String(id || ''))) return null
    try { return JSON.parse(readFileSync(join(dirOf(id), 'job.json'), 'utf8')) } catch { return null }
  }
  const save = (job) => { job.updatedAt = Date.now(); mkdirSync(dirOf(job.id), { recursive: true }); atomicWrite(join(dirOf(job.id), 'job.json'), JSON.stringify(job, null, 2)) }
  const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}_\d{2}$/
  const rawFile = (id, key) => {
    if (!KEY_RE.test(String(key || ''))) throw new TypeError('bad frame key')
    return join(dirOf(id), 'raw', key + '.png')
  }
  const hasRaw = (id, key) => { try { return existsSync(rawFile(id, key)) } catch { return false } }

  const blank = (id, { name, desc } = {}) => ({
    id, name: cleanName(name) || '新角色', desc: cleanDesc(desc), optional: [], frames: {}, ref: null, upload: false,
    candidates: [], build: null, installed: false, createdAt: Date.now(),
    custom: [], labels: {}, durations: {}, moods: {}, template: null, origin: null, targetId: id,
  })

  const create = ({ name, desc } = {}) => {
    let id
    do { id = 'my-' + randomBytes(3).toString('hex') } while (existsSync(dirOf(id)) || existsSync(join(dataDir, 'characters', id)))
    const job = blank(id, { name, desc })
    save(job)
    return job
  }

  const list = () => {
    let names = []
    try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
    return names.map(read).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((j) => ({ id: j.id, name: j.name, ref: !!j.ref, installed: !!j.installed, updatedAt: j.updatedAt, targetId: j.targetId || j.id, origin: j.origin || null }))
  }

  /** drop raw frames that fell outside a state's slot range */
  const trimRaw = (id, job) => {
    const keep = new Set(jobKeys(job))
    let names = []
    try { names = readdirSync(join(dirOf(id), 'raw')) } catch { return }
    for (const n of names) {
      const k = n.replace(/\.png$/i, '')
      if (!keep.has(k)) { try { rmSync(rawFile(id, k), { force: true }) } catch {}; delete job.frames[k] }
    }
  }

  const update = (id, patch = {}) => {
    const job = read(id); if (!job) return null
    if (!Array.isArray(job.custom)) job.custom = []
    if (!job.labels || typeof job.labels !== 'object') job.labels = {}
    if (!job.durations || typeof job.durations !== 'object') job.durations = {}
    if (!job.moods || typeof job.moods !== 'object') job.moods = {}
    if (typeof patch.name === 'string') job.name = cleanName(patch.name) || job.name
    if (typeof patch.desc === 'string') job.desc = cleanDesc(patch.desc)
    if (Array.isArray(patch.optional)) job.optional = patch.optional.filter((x) => SPEC_BY_ID[x] && !SPEC_BY_ID[x].req)
    if (Array.isArray(patch.custom)) {
      const taken = stateOrder({ ...job, custom: [] }).filter((sid) => !job.custom.some((c) => c.id === sid))
      job.custom = cleanCustom(patch.custom, taken)
    }
    if (patch.labels && typeof patch.labels === 'object' && !Array.isArray(patch.labels)) {
      const have = new Set(stateOrder(job))
      for (const [sid, v] of Object.entries(patch.labels)) {
        if (!have.has(sid) || typeof v !== 'string') continue
        const label = cleanLine(v, LABEL_MAX)
        if (label) job.labels[sid] = label; else delete job.labels[sid]
      }
    }
    if (patch.durations && typeof patch.durations === 'object' && !Array.isArray(patch.durations)) {
      const have = new Set(stateOrder(job))
      for (const [sid, v] of Object.entries(patch.durations)) {
        if (!have.has(sid)) continue
        if (v === null) { delete job.durations[sid]; continue }
        if (!Array.isArray(v)) continue
        const n = stateFramesOf(job, sid)
        // a partial list edits only those frames: everything else keeps the pack's own timing
        const list = durationsOf(job, sid).slice(0, n)
        v.slice(0, n).forEach((x, i) => { list[i] = clampInt(x, DUR_RANGE[0], DUR_RANGE[1], list[i]) })
        job.durations[sid] = list
      }
    }
    if (patch.moods && typeof patch.moods === 'object' && !Array.isArray(patch.moods)) {
      const have = new Set(stateOrder(job))
      for (const [tag, sid] of Object.entries(patch.moods)) {
        const t = cleanLine(tag, MOOD_TAG_MAX)
        if (!t) continue
        if (sid === null || sid === '') { delete job.moods[t]; continue }
        if (typeof sid === 'string' && have.has(sid)) job.moods[t] = sid
      }
    }
    if (Array.isArray(patch.custom) || Array.isArray(patch.durations)) trimRaw(id, job)
    save(job)
    return job
  }

  /** status of every frame in the full action list (not only the chosen ones) */
  const view = (id) => {
    const job = read(id); if (!job) return null
    const run = runs.get(id)
    const frames = {}
    const mark = (k) => {
      const f = job.frames[k]
      frames[k] = hasRaw(id, k) ? 'done' : run && run.current === k ? 'running' : f && f.status === 'failed' ? 'failed' : 'pending'
    }
    for (const s of SPEC) for (let i = 0; i < s.n; i++) mark(frameKey(s.id, i))
    for (const sid of stateOrder(job)) if (!SPEC_BY_ID[sid]) for (const k of slotKeys(job, sid)) mark(k)
    const want = jobKeys(job)
    const pending = want.filter((k) => frames[k] !== 'done')
    const errors = Object.fromEntries(Object.entries(job.frames).filter(([, v]) => v && v.status === 'failed' && v.error).map(([k, v]) => [k, v.error]))
    const stamps = Object.fromEntries(Object.entries(job.frames).map(([k, v]) => [k, (v && v.at) || 0]))
    return {
      ...job, targetId: job.targetId || job.id, frames, errors, stamps,
      states: stateInfo(job), moods: moodsOf(job),
      plan: { total: want.length, pending: pending.length },
      run: run ? { running: !run.finished, done: run.done, failed: run.failed, total: run.total, error: run.error || null, current: run.current || null } : (job.lastRun || null),
    }
  }

  const putImage = (id, slot, buf) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    if (!imageType(buf)) return { code: 415, body: { ok: false, message: '只收 PNG / JPEG / WebP 图片' } }
    const d = dirOf(id)
    if (slot === 'upload') { atomicWrite(join(d, 'upload.png'), buf); job.upload = true }
    else if (slot === 'ref') { atomicWrite(join(d, 'ref.png'), buf); job.ref = { source: 'import', at: Date.now() } }
    else return { code: 400, body: { ok: false } }
    save(job)
    return { code: 200, body: { ok: true } }
  }

  const importFrame = (id, fileName, buf) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const m = String(fileName || '').match(NAME_RE)
    if (!m) return { code: 400, body: { ok: false, message: '文件名要是 <状态>_<两位帧号>.png' } }
    const state = m[1].toLowerCase(); const idx = Number(m[2])
    const s = SPEC_BY_ID[state]
    const known = stateOrder(job).includes(state)
    const slots = known ? stateFramesOf(job, state) : (s && !s.req ? s.n : 0)
    if (!known && !slots) {
      return { code: 400, body: { ok: false, message: '清单里没有 ' + state + '_' + m[2] } }
    }
    if (idx >= slots) {
      return { code: 400, body: { ok: false, message: '这里没有 ' + state + '_' + m[2] + '（' + state + ' 只有 ' + slots + ' 帧位）' } }
    }
    if (!imageType(buf)) return { code: 415, body: { ok: false, message: '不是图片' } }
    const k = frameKey(state, idx)
    mkdirSync(join(dirOf(id), 'raw'), { recursive: true })
    atomicWrite(rawFile(id, k), buf)
    job.frames[k] = { status: 'done', source: 'import', at: Date.now() }
    if (s && !s.req && !job.optional.includes(state)) job.optional.push(state)
    save(job)
    return { code: 200, body: { ok: true, key: k } }
  }

  const candidating = new Set()   // job ids with a candidate request in flight: one at a time per job
  const candidates = async (id, opts = {}) => {
    if (candidating.has(id)) return { code: 409, body: { ok: false, code: 'busy', message: '候选图还在生成，等这一批出来' } }
    candidating.add(id)
    try { return await candidatesOnce(id, opts) } finally { candidating.delete(id) }
  }
  const candidatesOnce = async (id, { n, useUpload } = {}) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const refs = []
    if (useUpload) {
      const up = join(dirOf(id), 'upload.png')
      if (!existsSync(up)) return { code: 400, body: { ok: false, message: '还没上传参考图' } }
      refs.push({ name: 'upload.png', data: readFileSync(up) })
    } else if (!job.desc) return { code: 400, body: { ok: false, message: '先写一段形象描述' } }
    const count = Math.max(1, Math.min(4, Number(n) || 1))
    let bufs
    try { bufs = await images.generate({ prompt: buildPrompt({ desc: job.desc }), n: count, references: refs }) } catch (e) {
      return { code: 502, body: { ok: false, code: e.code || 'error', message: e.message || '出图失败' } }
    }
    const cdir = join(dirOf(id), 'cand'); mkdirSync(cdir, { recursive: true })
    const fresh = read(id)
    const stamp = Date.now().toString(36)
    const names = bufs.map((b, i) => { const f = 'c-' + stamp + '-' + i + '.png'; atomicWrite(join(cdir, f), b); return f })
    fresh.candidates = [...names, ...(fresh.candidates || [])].slice(0, 24)
    save(fresh)
    return { code: 200, body: { ok: true, candidates: names } }
  }

  const pick = (id, cand) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    if (!/^c-[a-z0-9]+-\d\.png$/.test(String(cand)) || !job.candidates.includes(cand)) return { code: 400, body: { ok: false } }
    copyFileSync(join(dirOf(id), 'cand', cand), join(dirOf(id), 'ref.png'))
    job.ref = { source: 'candidate', candidate: cand, at: Date.now() }
    save(job)
    return { code: 200, body: { ok: true } }
  }

  /** forget frames so the next run regenerates them */
  const reset = (id, keys) => {
    const job = read(id); if (!job) return []
    const out = []
    for (const k of keys) {
      if (!keyOf(job, k)) continue
      rmSync(rawFile(id, k), { force: true })
      delete job.frames[k]
      out.push(k)
    }
    save(job)
    return out
  }

  /**
   * start generating. body.keys: explicit frames (redo) else every missing frame of the plan.
   * body.confirm must equal the number of images that will be requested (the page shows it first).
   */
  const run = (id, { keys, confirm } = {}) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    if (runs.has(id) && !runs.get(id).finished) return { code: 409, body: { ok: false, message: '正在生成' } }
    if (!existsSync(join(dirOf(id), 'ref.png'))) return { code: 400, body: { ok: false, message: '先定稿参考图' } }
    const redo = Array.isArray(keys) && keys.length
    let todo = redo ? [...new Set(keys.filter((k) => keyOf(job, k)))].slice(0, 200) : jobKeys(job).filter((k) => !hasRaw(id, k))
    if (!todo.length) return { code: 200, body: { ok: true, total: 0 } }
    if (confirm !== todo.length) return { code: 409, body: { ok: false, code: 'confirm', total: todo.length } }
    if (redo) todo = reset(id, todo)
    const r = { stop: false, total: todo.length, done: 0, failed: 0, error: null, current: null, finished: false }
    runs.set(id, r)
    r.promise = loop(id, todo, r).catch((e) => { r.error = String(e && e.message || e) }).finally(() => {
      r.finished = true; r.current = null
      const j = read(id)
      if (j) { j.lastRun = { running: false, done: r.done, failed: r.failed, total: r.total, error: r.error, stopped: r.stop }; save(j) }
    })
    return { code: 200, body: { ok: true, total: todo.length } }
  }

  const FATAL = new Set(['auth', 'quota', 'nokey', 'config', 'forbidden', 'notfound', 'rate'])
  const loop = async (id, todo, r) => {
    mkdirSync(join(dirOf(id), 'raw'), { recursive: true })
    for (const k of todo) {
      if (r.stop) break
      if (hasRaw(id, k)) { r.done++; continue }
      const job = read(id); if (!job) break
      const state = k.slice(0, k.lastIndexOf('_')); const idx = Number(k.slice(k.lastIndexOf('_') + 1))
      const s = SPEC_BY_ID[state]
      const custom = (job.custom || []).find((c) => c.id === state) || null
      const refs = [{ name: 'reference.png', data: readFileSync(join(dirOf(id), 'ref.png')) }]
      const first = frameKey(state, 0)
      if (idx > 0 && !(s && s.single) && hasRaw(id, first)) refs.push({ name: first + '.png', data: readFileSync(rawFile(id, first)) })
      if (s && s.base && hasRaw(id, s.base)) refs.push({ name: s.base + '.png', data: readFileSync(rawFile(id, s.base)) })
      r.current = k
      try {
        const [buf] = await images.generate({ prompt: buildPrompt({ desc: job.desc, state, index: idx, custom }), n: 1, references: refs })
        atomicWrite(rawFile(id, k), buf)
        const j = read(id); j.frames[k] = { status: 'done', source: 'generated', at: Date.now() }; save(j)
        r.done++
      } catch (e) {
        r.failed++
        const j = read(id); j.frames[k] = { status: 'failed', error: String(e && e.message || e).slice(0, 160), at: Date.now() }; save(j)
        if (FATAL.has(e && e.code)) { r.error = e.message; break }
      }
    }
  }

  const stop = (id) => { const r = runs.get(id); if (r && !r.finished) r.stop = true; return { code: 200, body: { ok: true } } }
  const wait = async (id) => { const r = runs.get(id); if (r && r.promise) await r.promise }

  /**
   * raw -> frames -> manifest -> validate.
   *  - a fresh job converts the raw art (create_convert.py) and then applies labels / durations / custom states
   *  - a job reversed from an installed pack copies the raw frames straight to sprites/ and rewrites the
   *    template manifest, so the author's metadata (aliases, looks, canvas, anchors, unknown keys) survives
   *  - Python validate.py is the judge when an interpreter is available; the JS check is the fallback
   */
  const build = async (id) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const d = dirOf(id)
    const target = job.targetId || id
    const have = new Set(readdirSafe(join(d, 'raw')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
    if (!have.size) return { code: 400, body: { ok: false, message: '还没有任何动作图' } }
    const out = join(d, 'build', target) // the validator wants folder name == id
    rmSync(join(d, 'build'), { recursive: true, force: true }); mkdirSync(out, { recursive: true })
    let problems = []
    let convertInfo = null
    if (job.template) {
      const r = await passthrough(d, out, job, have)
      problems = r.problems
    } else {
      const spec = jobKeys(job).length && stateOrder(job).length
        ? stateOrder(job).map((sid) => {
            const s = SPEC_BY_ID[sid]
            const c = (job.custom || []).find((x) => x.id === sid)
            return { id: sid, label: labelOf(job, sid), loop: loopOf(job, sid), durationsMs: durationsOf(job, sid),
              single: !!(s && s.single), required: !!(s && s.req), frames: slotKeys(job, sid).filter((k) => have.has(k)),
              expected: stateFramesOf(job, sid), ...(c ? { hint: c.desc } : {}) }
          })
        : []
      const specFile = join(d, 'spec.json')
      writeFileSync(specFile, JSON.stringify({ id: target, name: job.name, states: spec }, null, 2))
      const r = await convert({ src: join(d, 'raw'), out, specFile, id: target, name: job.name })
      convertInfo = r
      if (!r.ok) problems = (r.issues || []).slice(0, 60)
    }
    let verdict
    if (job.template) {
      // reversed packs already wrote their manifest in passthrough(); judge that, do not re-derive it
      const after = await validatePack(out, problems)
      // a frame that could not be normalized leaves a hole in the pack even if the rest validates
      verdict = { ...after, ok: !!after.ok && !problems.length }
    } else {
      applyEdits(out, job, target, problems)
      // the converter ran the real validator on the art; a Python re-check after the edit pass only
      // downgrades the verdict when it actually finds something
      const after = await validatePack(out, problems, { optional: true })
      verdict = { ok: !!(convertInfo && convertInfo.ok) && after.ok && !problems.length, draft: !!(convertInfo && convertInfo.draft),
        validated: !!(convertInfo && convertInfo.validated), by: after.by,
        message: after.message || (convertInfo && convertInfo.message) || '',
        issues: (after.issues.length ? after.issues : (convertInfo && convertInfo.issues) || []).slice(0, 60) }
    }
    const fresh = read(id)
    fresh.build = {
      at: Date.now(), ok: verdict.ok, draft: !!verdict.draft, validated: !!verdict.validated, validatedBy: verdict.by,
      message: verdict.message || '', issues: (verdict.issues || []).slice(0, 60),
      states: (convertInfo && convertInfo.states && typeof convertInfo.states === 'object')
        ? convertInfo.states
        : Object.fromEntries(stateOrder(job).map((sid) => [sid, slotKeys(job, sid).filter((k) => existsSync(join(out, 'sprites', k + '.png'))).length])),
    }
    fresh.targetId = target
    save(fresh)
    return { code: 200, body: { ok: fresh.build.ok, build: fresh.build, issues: fresh.build.issues } }
  }

  const validatePack = async (dir, problems, { optional = false } = {}) => {
    if (typeof validate === 'function') {
      let r = null
      try { r = await validate(dir) } catch { r = null }
      if (r && typeof r.ok === 'boolean') {
        return { ok: !!r.ok, draft: !!r.draft, validated: true, by: 'python', message: r.message || '', issues: [...(r.issues || []), ...problems].slice(0, 60) }
      }
    }
    if (optional) return { ok: true, draft: false, validated: false, by: 'none', message: '', issues: problems.slice(0, 60) }
    return jsValidate(dir, problems)
  }

  /** raw frames -> sprites/ + character.json derived from the pack we came from.
   *  Frames the pack already had are copied byte for byte (never re-cropped, never re-scaled: their canvas
   *  placement and foot line are the pack's own). Frames that were regenerated or imported into the job are raw
   *  art (usually a big #00FF00 picture), so only those go through the normalizer once. */
  const passthrough = async (d, out, job, have) => {
    const problems = []
    const sprites = join(out, 'sprites'); mkdirSync(sprites, { recursive: true })
    const fresh = []
    for (const k of have) {
      if (!jobKeys(job).includes(k)) continue
      const rec = job.frames && job.frames[k]
      if (!rec || rec.source !== 'existing') { fresh.push(k); continue }
      try { copyFileSync(rawFile(job.id, k), join(sprites, k + '.png')) } catch { problems.push('复制 ' + k + '.png 失败') }
    }
    if (fresh.length) problems.push(...await normalizeNewFrames(d, out, job, fresh))
    writeManifest(out, job, job.targetId || job.id, problems)
    return { problems }
  }

  /** a frame of the pack we came from: its alpha box is where new frames have to land (foot line / centre) */
  const refFrameOf = (job, keys) => {
    const skip = new Set(keys)
    for (const k of ['idle_00', ...jobKeys(job)]) {
      if (skip.has(k)) continue
      const rec = job.frames && job.frames[k]
      if (!rec || rec.source !== 'existing') continue
      if (hasRaw(job.id, k)) return 'raw/' + k + '.png'
    }
    return null
  }

  /**
   * Only the new frames: <job>/normalize.json tells runtime/create_convert.py (frame_normalize.py) the target
   * canvas, the pixel grid and the reference frame of the pack; it keys the green, hardens alpha, fits the
   * picture onto the canvas and lands it on the pack's own foot line. A frame that already is a canonical
   * RGBA picture of the right size is copied as it is.
   *
   * If the converter cannot run at all (no Python on this machine), frames that are already canonical RGBA
   * pictures of the pack's size are still usable as they are; anything else is a hard failure, so a green
   * background picture can never slip through as a finished frame.
   */
  const normalizeNewFrames = async (d, out, job, keys) => {
    const problems = []
    const tpl = job.template && typeof job.template === 'object' ? job.template : {}
    const canvas = Array.isArray(tpl.canvas) && tpl.canvas.length === 2 && tpl.canvas.every((v) => Number(v) >= 8)
      ? tpl.canvas.map((v) => Math.round(Number(v))) : [192, 208]
    if (typeof convert !== 'function') return rescueCanonical(job.id, out, canvas, keys, '这台机器上没有图像转换器，新画的帧没法归一化')
    const ls = Math.round(Number(tpl.logicalScale))
    const grid = Number.isFinite(ls) && ls >= 1 && ls <= 8 ? ls : 2
    const brief = { kind: 'character', frames: keys, canvas, grid, ref: refFrameOf(job, keys) }
    const target = job.targetId || job.id
    const briefFile = join(d, 'normalize.json')
    const specFile = join(d, 'spec.json')
    writeFileSync(briefFile, JSON.stringify(brief, null, 2))
    writeFileSync(specFile, JSON.stringify({ id: target, name: job.name, states: [] }, null, 2))
    let r = null
    try {
      r = await convert({ src: join(d, 'raw'), out, specFile, id: target, name: job.name, normalize: brief })
    } catch (e) {
      r = { ok: false, message: '新帧转换失败：' + String((e && e.message) || e).slice(0, 140) }
    } finally {
      try { rmSync(briefFile, { force: true }) } catch {}
    }
    if (r && r.ok === false) {
      if (r.available === false) return rescueCanonical(job.id, out, canvas, keys, r.message || '没有可用转换器')
      // A real converter's rejection is not permission to pass the raw picture through.
      return [r.message || '新帧转换失败', ...(r.issues || []).slice(0, 20)]
    }
    if (!r && !problems.length) problems.push('新帧转换没有结果')
    return problems
  }

  /** Converter unavailable only: header-compatible frames may be used by the explicitly limited fallback. */
  const rescueCanonical = (jobId, out, canvas, keys, why, issues = []) => {
    const left = []
    for (const k of keys) {
      if (!frameIsCanonical(rawFile(jobId, k), canvas)) { left.push(k); continue }
      try { copyFileSync(rawFile(jobId, k), join(out, 'sprites', k + '.png')) } catch { left.push(k) }
    }
    if (!left.length) return []
    const problems = [why]
    for (const line of issues) problems.push(String(line))
    for (const k of left) problems.push(k + '.png 还没来得及归一化（尺寸/底色不对）')
    return problems
  }

  const install = (id) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const target = job.targetId || id
    const src = join(dirOf(id), 'build', target)
    if (!job.build || !job.build.ok || !existsSync(join(src, 'character.json'))) return { code: 400, body: { ok: false, message: '先转换并通过校验' } }
    const base = join(dataDir, 'characters'); mkdirSync(base, { recursive: true })
    const dest = join(base, target)
    const tmp = join(base, '.' + target + '.tmp')
    const old = join(base, '.' + target + '.old-' + process.pid)
    rmSync(tmp, { recursive: true, force: true }); rmSync(old, { recursive: true, force: true })
    cpSync(src, tmp, { recursive: true })
    // the previous user layer is moved aside, never deleted first: a failed rename must not lose it
    if (existsSync(dest)) renameSync(dest, old)
    try {
      renameSync(tmp, dest)
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      if (existsSync(old) && !existsSync(dest)) { try { renameSync(old, dest) } catch {} }
      return { code: 500, body: { ok: false, message: '安装失败，原来的版本还在' } }
    }
    rmSync(old, { recursive: true, force: true })
    job.installed = true; save(job)
    try { onInstalled && onInstalled(target) } catch {}
    return { code: 200, body: { ok: true, id: target, draft: !!job.build.draft, overlay: !!job.origin && job.origin.base === 'builtin' } }
  }

  /**
   * Read an installed pack (built-in or someone else's user pack) into a new editing job.
   * Every existing frame becomes an "already there" raw image, idle frame 0 becomes the reference,
   * and the whole manifest is kept as `template` so build() can put it back without flattening.
   */
  const reverse = ({ id, dir, data, base = 'builtin', installed = false }) => {
    if (!PACK_ID_RE.test(String(id || '')) || !data || typeof data !== 'object') return { code: 400, body: { ok: false, message: '这个包读不出来' } }
    // state ids become file names under raw/: one that is not a plain id could write outside the job
    const badState = Object.keys(data.states || {}).find((sid) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(sid))
    if (badState || !data.states || typeof data.states !== 'object') {
      return { code: 400, body: { ok: false, message: '这个包的状态名不合法' + (badState ? '：' + badState : '') } }
    }
    const prev = list().find((j) => j.targetId === id && j.origin && j.origin.kind === 'pack')
    if (prev) { const j = read(prev.id); if (j) return { code: 200, body: { ok: true, job: view(j.id), reused: true } } }
    let jid
    do { jid = 'my-' + randomBytes(3).toString('hex') } while (existsSync(dirOf(jid)))
    const job = blank(jid, { name: data.name || id, desc: '' })
    job.template = data
    job.targetId = id
    job.origin = { kind: 'pack', id, base, installed: !!installed, at: Date.now(), missing: [] }
    job.custom = []
    job.labels = {}
    job.durations = {}
    job.moods = typeof data.moods === 'object' && data.moods ? { ...data.moods } : {}
    job.installed = !!installed
    job.ref = null
    mkdirSync(join(dirOf(jid), 'raw'), { recursive: true })
    let first = null
    for (const [sid, st] of Object.entries(data.states || {})) {
      if (!st || !Array.isArray(st.frames)) continue
      st.frames.forEach((rel, i) => {
        const src = packFrame(dir, rel)
        if (!src) { job.origin.missing.push(sid + '_' + String(i).padStart(2, '0')); return }
        const k = frameKey(sid, i)
        try {
          copyFileSync(src, rawFile(jid, k))
          job.frames[k] = { status: 'done', source: 'existing', at: Date.now() }
          if (!first && sid === 'idle' && i === 0) first = src
        } catch { job.origin.missing.push(k) }
      })
    }
    if (Array.isArray(data.lookDirections) && data.lookDirections.length === 16) {
      data.lookDirections.forEach((l, i) => {
        const src = l && packFrame(dir, l.frame)
        const k = frameKey(LOOK_STATE, i)
        if (!src) { job.origin.missing.push(k); return }
        try { copyFileSync(src, rawFile(jid, k)); job.frames[k] = { status: 'done', source: 'existing', at: Date.now() } } catch { job.origin.missing.push(k) }
      })
    }
    if (!first) {
      const idle = data.states && data.states.idle && Array.isArray(data.states.idle.frames) ? data.states.idle.frames[0] : null
      const alt = idle ? packFrame(dir, idle) : null
      if (alt) first = alt
    }
    if (first) { try { copyFileSync(first, join(dirOf(jid), 'ref.png')); job.ref = { source: 'existing', at: Date.now() } } catch {} }
    // custom = every state the fixed action list does not know (act-*, extra moods, the author's own names)
    job.custom = cleanCustom(Object.keys(data.states || {}).filter((sid) => !SPEC_BY_ID[sid] && data.states[sid]?.requires?.feature !== 'listen').map((sid) => {
      const st = data.states[sid] || {}
      const tag = Object.keys(job.moods).find((t) => job.moods[t] === sid) || ''
      return { id: sid, label: st.label || sid, desc: '', frames: Math.min(CUSTOM_FRAMES_MAX, Math.max(1, (st.frames || []).length)),
        ms: Array.isArray(st.durationsMs) && st.durationsMs[0] ? st.durationsMs[0] : 250, loop: st.loop !== false, mood: tag }
    }))
    save(job)
    return { code: 200, body: { ok: true, job: view(jid), reused: false } }
  }

  const remove = (id) => {
    if (!read(id)) return { code: 404, body: { ok: false } }
    stop(id)
    rmSync(dirOf(id), { recursive: true, force: true })
    return { code: 200, body: { ok: true } }
  }

  /** file under a job, by slot */
  const file = (id, slot, name) => {
    const job = read(id); if (!job) return null
    const d = dirOf(id)
    if (slot === 'ref') return join(d, 'ref.png')
    if (slot === 'upload') return join(d, 'upload.png')
    if (slot === 'cand' && /^c-[a-z0-9]+-\d\.png$/.test(name)) return join(d, 'cand', name)
    if (slot === 'raw' && /^[a-z][a-z0-9-]{0,39}_\d{2}$/.test(name)) return rawFile(id, name)
    if (slot === 'frame' && /^[a-z][a-z0-9-]{0,39}_\d{2}\.png$/.test(name)) return join(d, 'build', job.targetId || id, 'sprites', name)
    return null
  }

  const dispose = () => { for (const r of runs.values()) r.stop = true }
  return { create, list, read, view, update, putImage, importFrame, candidates, pick, run, stop, wait, build, install, reverse, remove, file, dispose, runs }
}

/** write character.json for a reversed job: template as the base, job edits on top */
export function writeManifest (out, job, target, problems = []) {
  const base = job.template && typeof job.template === 'object' ? job.template : {}
  const manifest = { ...base }
  manifest.id = target
  manifest.name = cleanName(job.name) || target
  const sprites = join(out, 'sprites')
  const have = new Set(readdirSafe(sprites).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
  const states = {}
  for (const sid of stateOrder(job)) {
    if (sid === LOOK_STATE) continue
    const keys = slotKeys(job, sid).filter((k) => have.has(k))
    if (!keys.length) { problems.push(sid + ' 一帧都没有'); continue }
    states[sid] = {
      label: labelOf(job, sid), frames: keys.map((k) => 'sprites/' + k + '.png'),
      durationsMs: durationsOf(job, sid).slice(0, keys.length), loop: loopOf(job, sid),
      ...(base.states?.[sid]?.requires?.feature === 'listen' ? { requires: { feature: 'listen' } } : {}),
      ...(base.states?.[sid]?.role ? { role: base.states[sid].role } : {}),
    }
  }
  manifest.states = states
  manifest.moods = moodsOf(job)
  manifest.aliases = Object.fromEntries(Object.entries(base.aliases || {}).filter(([a, t]) => typeof a === 'string' && states[t]))
  manifest.lookDirections = gazeOf(job, have, base.lookDirections, problems)
  const required = SPEC.filter((s) => s.req).map((s) => s.id)
  const missing = required.filter((sid) => !states[sid] || !states[sid].frames.length)
  if (missing.length) manifest.draft = true; else delete manifest.draft
  mkdirSync(out, { recursive: true })
  const tmp = join(out, 'character.json.' + process.pid + '.tmp')
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  renameSync(tmp, join(out, 'character.json'))
  return manifest
}

/** fresh jobs: keep the converter's manifest, then apply labels / durations / custom states / moods */
export function applyEdits (out, job, target, problems = []) {
  let base = {}
  try { base = JSON.parse(readFileSync(join(out, 'character.json'), 'utf8')) } catch { base = {} }
  if (!base || typeof base !== 'object') base = {}
  const prev = base.states && typeof base.states === 'object' ? base.states : {}
  const sprites = join(out, 'sprites')
  const have = new Set(readdirSafe(sprites).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
  const states = {}
  // keep the converter's order, then the custom states in job order
  const order = [...Object.keys(prev), ...stateOrder(job).filter((sid) => !(sid in prev))]
  for (const sid of order) {
    if (sid === LOOK_STATE) continue
    if (!stateOrder(job).includes(sid) && !(sid in prev)) continue
    const keys = slotKeys(job, sid).filter((k) => have.has(k))
    if (!keys.length) { if (sid in prev && prev[sid].frames && prev[sid].frames.length) states[sid] = prev[sid]; continue }
    states[sid] = {
      label: labelOf(job, sid), frames: keys.map((k) => 'sprites/' + k + '.png'),
      durationsMs: durationsOf(job, sid).slice(0, keys.length), loop: loopOf(job, sid),
    }
  }
  base.id = target
  base.name = cleanName(job.name) || target
  base.states = states
  base.moods = moodsOf(job)
  base.aliases = Object.fromEntries(Object.entries(base.aliases || {}).filter(([a, t]) => typeof a === 'string' && states[t]))
  base.lookDirections = gazeOf(job, have, base.lookDirections, problems)
  const required = SPEC.filter((s) => s.req).map((s) => s.id)
  if (required.some((sid) => !states[sid] || !states[sid].frames.length)) base.draft = true; else delete base.draft
  const tmp = join(out, 'character.json.' + process.pid + '.tmp')
  writeFileSync(tmp, JSON.stringify(base, null, 2) + '\n', 'utf8')
  renameSync(tmp, join(out, 'character.json'))
  return base
}

/** lookDirections from the look_NN sprites that exist: 16 or nothing (the validator refuses anything between) */
export function gazeOf (job, have, baseLooks, problems = []) {
  if (!stateOrder(job).includes(LOOK_STATE)) return []
  const keys = slotKeys(job, LOOK_STATE).filter((k) => have.has(k))
  if (keys.length !== 16) {
    if (keys.length) problems.push('视线只有 ' + keys.length + '/16 张，已关闭鼠标跟随')
    return []
  }
  const base = Array.isArray(baseLooks) ? baseLooks : []
  return keys.map((k, i) => {
    const old = base[i]
    return { degrees: old && Number.isFinite(old.degrees) && Math.abs(old.degrees - i * 22.5) < 1e-6 ? old.degrees : i * 22.5, frame: 'sprites/' + k + '.png' }
  })
}

/** structural check used when no Python interpreter is available (never replaces the real validator) */
export function jsValidate (dir, extra = []) {
  const issues = [...extra]
  let data = null
  try { data = JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) } catch { issues.push('character.json 读不出来') }
  const draft = !!(data && data.draft === true)
  if (data) {
    const required = SPEC.filter((s) => s.req).map((s) => s.id)
    const states = data.states && typeof data.states === 'object' ? data.states : {}
    const missing = required.filter((sid) => !states[sid])
    if (missing.length) issues.push('缺必需状态：' + missing.join(', '))
    for (const [sid, st] of Object.entries(states)) {
      if (!st || typeof st !== 'object') { issues.push('states.' + sid + ' 不是对象'); continue }
      if (!Array.isArray(st.frames) || !st.frames.length) { issues.push('states.' + sid + ' 没有帧'); continue }
      if (!Array.isArray(st.durationsMs) || st.durationsMs.length !== st.frames.length) issues.push('states.' + sid + '.durationsMs 和帧数不一致')
      for (const d of st.durationsMs || []) if (!(Number.isInteger(d) && d >= DUR_RANGE[0] && d <= DUR_RANGE[1])) issues.push('states.' + sid + ' 的帧时长超出 40–5000ms')
      for (const rel of st.frames) {
        if (!/^sprites\/[A-Za-z0-9_.-]+\.png$/.test(String(rel)) || String(rel).includes('..')) { issues.push('states.' + sid + ' 帧路径不合法：' + rel); continue }
        const full = join(dir, rel)
        let head = null
        try { head = readFileSync(full).subarray(0, 33) } catch { issues.push('缺文件 ' + rel); continue }
        if (!head || head.length < 33 || head.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') { issues.push(rel + ' 不是 PNG'); continue }
        const w = head.readUInt32BE(16); const h = head.readUInt32BE(20); const depth = head[24]; const color = head[25]
        if (w !== 192 || h !== 208) issues.push(rel + ' 尺寸 ' + w + 'x' + h + '，要 192x208')
        if (depth !== 8 || color !== 6) issues.push(rel + ' 不是 8 位 RGBA PNG')
      }
    }
    for (const [tag, sid] of Object.entries(data.moods || {})) if (!states[sid]) issues.push('moods.' + tag + ' 指向不存在的状态 ' + sid)
    for (const [a, sid] of Object.entries(data.aliases || {})) if (!states[sid]) issues.push('aliases.' + a + ' 指向不存在的状态 ' + sid)
  }
  return { ok: !issues.length, draft, validated: false, by: 'js', message: issues.length ? '校验没过' : '结构检查通过', issues: issues.slice(0, 60) }
}

/** an already-normalized frame: an 8-bit RGBA PNG exactly of the pack's frame size (header check only).
 *  Used as the fallback when no converter can run; a picture that still has to be keyed / fitted fails here. */
export function frameIsCanonical (file, canvas) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(33)
    if (readSync(fd, head, 0, 33, 0) < 33) return false
    if (head.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return false
    if (head.toString('latin1', 12, 16) !== 'IHDR') return false
    return head.readUInt32BE(16) === Number(canvas[0]) && head.readUInt32BE(20) === Number(canvas[1]) &&
      head[24] === 8 && head[25] === 6
  } catch { return false } finally { if (fd !== null) { try { closeSync(fd) } catch {} } }
}

export function validKey (k) {
  if (typeof k !== 'string') return false
  const i = k.lastIndexOf('_'); const s = SPEC_BY_ID[k.slice(0, i)]; const nn = k.slice(i + 1)
  return !!s && /^\d{2}$/.test(nn) && Number(nn) < s.n
}
/** a key that belongs to this job (its own state list, template included) */
export function keyOf (job, k) {
  if (typeof k !== 'string') return false
  const i = k.lastIndexOf('_'); if (i < 0) return false
  const sid = k.slice(0, i); const nn = k.slice(i + 1)
  if (!/^\d{2}$/.test(nn)) return false
  if (!stateOrder(job).includes(sid)) return false
  return Number(nn) < stateFramesOf(job, sid)
}
const cleanName = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 24)
const cleanDesc = (s) => String(s || '').replace(/\r/g, '').trim().slice(0, 1200)
const readdirSafe = (p) => { try { return readdirSync(p) } catch { return [] } }
