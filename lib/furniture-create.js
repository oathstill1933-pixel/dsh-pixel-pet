/**
 * "+ 新建家具": jobs under <data>/create-furniture/<id>/
 *
 *   job.json      the furniture card (spec, name, size, kind, anchor, extra animations, custom interactions) + per-frame status + last build
 *   raw/<state>_NN.png   one raw picture per frame: empty_NN (idle, always) + <extra state>_NN (furniture-owned animations)
 *   build/<id>/   furniture.json (written here, from the card) + sprites/ (runtime/furniture_convert.py), validated
 *
 * The character is never drawn into the furniture. When the pet uses the piece, the runtime lays the current character's
 * own pose on top in the card's area (or at its anchor) — see runtime/pixelpet/furniture.py (occupant). Contract: docs/FURNITURE_SPEC.md.
 * Installed to <data>/furniture/<id>/; the pet loads it on its next start.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageType } from './imagegen.js'
import { frameIsCanonical } from './create.js'
import { packFrame } from './packs.js'

export const FJOB_RE = /^furn-[a-f0-9]{6}$/
/** a state / verb id: lowercase letter first, then a-z 0-9 -, at most 24 */
export const SID_RE = /^[a-z][a-z0-9-]{0,23}$/
/** one frame key, e.g. empty_00, open_03 */
export const FKEY_RE = /^[a-z][a-z0-9-]{0,23}_\d{2}$/
/** an imported file name (matched lower-cased) */
export const FNAME_RE = /^([a-z][a-z0-9-]{0,23})_(\d{2})\.(?:png|jpe?g|webp)$/
/** a character state name (runtime/pixelpet/validate.py STATE_RE) */
export const POSE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const MAX_FRAMES = 4          // idle (empty) frames
export const MAX_STATE_FRAMES = 6    // frames per extra animation
export const MAX_STATES = 6          // extra animations per piece
export const MAX_INTERACTIONS = 8    // custom interactions per piece
export const HOLD_MS = [500, 10000]
export const RESERVED_VERBS = ['sleep', 'use', 'wake']
export const SPEC_DOC = 'docs/FURNITURE_SPEC.md'
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/** what the pet can do with a piece (runtime/pixelpet/furniture.py + app.use) */
export const KINDS = {
  sleep: { mode: 'inside', verb: 'sleep', pose: 'curl-sleep', say: '去{furniture}睡觉', hint: '用户说困了、晚安、去{furniture}睡觉时用', done: '{name}在{furniture}里睡下了。', wake: '{name}从{furniture}里出来了。' },
  use: { mode: 'beside', verb: 'use', pose: 'waving', say: '去{furniture}那儿', hint: '用户让它去{furniture}旁边时用', done: '{name}到{furniture}旁边了。' },
}
export const POSES = ['waving', 'mood-happy', 'review', 'running', 'lie', 'jumping']
/** character states any pack has (validate.py REQUIRED/OPTIONAL) — the picker offers these, free text is allowed too */
export const CHAR_POSES = ['waving', 'jumping', 'review', 'running', 'waiting', 'lie', 'curl-sleep', 'mood-happy', 'listening', 'attentive', 'speaking', 'failed', 'idle']

/**
 * Size presets, relative to the pet (~160×170 px body in a 192×208 frame, same scale as furniture px).
 * floorPad: furniture.json floorY = h - floorPad (the line the pet's feet stand on).
 */
export const SPECS = {
  small: { label: '小摆件', icon: '▫', size: [160, 160], kind: 'use', floorPad: 4, anchor: [80, 124], clipY: null, area: null, clipPath: null, frames: 1, stateFrames: 2 },
  nest: { label: '窝/床', icon: '▭', size: [360, 300], kind: 'sleep', floorPad: 14, anchor: [180, 230], clipY: null,
    area: [90, 60, 270, 240], clipPath: [[40, 226], [180, 232], [320, 226]], frames: 1, stateFrames: 2 },
  desk: { label: '桌柜', icon: '▬', size: [300, 260], kind: 'use', floorPad: 4, anchor: [150, 200], clipY: null, area: null, clipPath: null, frames: 1, stateFrames: 2 },
  tall: { label: '高件', icon: '▯', size: [200, 360], kind: 'use', floorPad: 4, anchor: [100, 300], clipY: null, area: null, clipPath: null, frames: 1, stateFrames: 2 },
  custom: { label: '自定义', icon: '✎', size: null, kind: null, floorPad: 4, anchor: null, clipY: null, area: null, clipPath: null, frames: null, stateFrames: 2 },
}
export const specOfSize = (size) => Object.keys(SPECS).find((k) => SPECS[k].size && SPECS[k].size[0] === size[0] && SPECS[k].size[1] === size[1]) || 'custom'

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const cleanLine = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)
const cleanText = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n)
/** [x0, y0, x1, y1] inside 0..size with x0 < x1, y0 < y1 (at least 4 px each way), else null */
export function cleanArea (a, size) {
  if (!Array.isArray(a) || a.length !== 4) return null
  const n = a.map(Number)
  if (!n.every(Number.isFinite)) return null
  const x0 = clampInt(Math.min(n[0], n[2]), 0, size[0], 0); const x1 = clampInt(Math.max(n[0], n[2]), 0, size[0], 0)
  const y0 = clampInt(Math.min(n[1], n[3]), 0, size[1], 0); const y1 = clampInt(Math.max(n[1], n[3]), 0, size[1], 0)
  return x1 - x0 >= 4 && y1 - y0 >= 4 ? [x0, y0, x1, y1] : null
}
/** front polyline: 2–24 [x, y] points inside 0..size, sorted, x strictly ascending (same x: later point wins), else null */
export function cleanClipPath (p, size) {
  if (!Array.isArray(p)) return null
  const byX = new Map()
  for (const q of p.slice(0, 64)) {
    if (!Array.isArray(q) || q.length !== 2) continue
    const x = Number(q[0]); const y = Number(q[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    byX.set(clampInt(x, 0, size[0], 0), clampInt(y, 0, size[1], 0))
  }
  const pts = [...byX].sort((a, b) => a[0] - b[0]).slice(0, MAX_CLIP_POINTS)
  return pts.length >= 2 ? pts : null
}
export const MAX_CLIP_POINTS = 24
const pad2 = (i) => String(i).padStart(2, '0')
const frameKey = (i, sid = 'empty') => sid + '_' + pad2(i)
/** any text -> an id that passes SID_RE, or '' */
const slug = (s) => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24)
const uniq = (id, taken, fallback) => {
  const base = id || fallback; let v = base; let n = 2
  while (taken.has(v)) { v = (base.slice(0, 21) + '-' + n++) }
  taken.add(v)
  return v
}

/** defaults for a fresh card */
export function blankCard () {
  return { spec: 'nest', name: '新家具', desc: '', kind: 'sleep', size: [360, 300], anchor: [180, 230], clipY: null, area: [...SPECS.nest.area], clipPath: SPECS.nest.clipPath.map((q) => [...q]), pose: 'waving', done: '', frames: 1,
    mainState: null, extraStates: [], interactions: [],
    // read back from an installed pack (re-editing): never guess these
    idleState: 'empty', floorPad: SPECS.nest.floorPad, feature: null, featureCfg: null, main: null, exit: null,
    pack: { order: 40, defaultEnabled: false, anchor: 'bottom-right', stand: null } }
}

/** occupant geometry / pose / under, bounded and inside the furniture box */
function cleanOccupant (o, size, fallbackPose) {
  const src = o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  const out = {}
  const pose = String(src.pose ?? '').trim().toLowerCase()
  if (POSE_RE.test(pose)) out.pose = pose
  else if (fallbackPose) out.pose = fallbackPose
  if (Array.isArray(src.fallback)) out.fallback = src.fallback.map((x) => String(x)).filter((x) => POSE_RE.test(x)).slice(0, 4)
  const area = cleanArea(src.area, size)
  if (area) out.area = area
  const anchor = Array.isArray(src.anchor) && src.anchor.length === 2 ? src.anchor.map(Number) : null
  if (anchor && anchor.every(Number.isFinite)) out.anchor = [clampInt(anchor[0], 0, size[0], 0), clampInt(anchor[1], 0, size[1], 0)]
  else if (!area) out.anchor = [Math.round(size[0] / 2), Math.round(size[1] * 0.8)]
  if (src.clipY !== null && src.clipY !== undefined && src.clipY !== '') out.clipY = clampInt(src.clipY, 0, size[1], 0)
  const clip = cleanClipPath(src.clipPath, size)
  if (clip) out.clipPath = clip
  if (typeof src.under === 'string' && SID_RE.test(src.under)) out.under = src.under
  if (Array.isArray(src.drawnFor)) out.drawnFor = src.drawnFor.map((x) => POSE_RE.test(String(x)) ? String(x) : '').filter(Boolean).slice(0, 8)
  return out
}

/** the main interaction of a card, read back verbatim when it came from a pack */
function cleanMain (m, card) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const mode = m.mode === 'inside' ? 'inside' : m.mode === 'exit' ? 'exit' : 'beside'
  const out = {
    verb: SID_RE.test(String(m.verb || '')) ? String(m.verb) : (KINDS[card.kind] || KINDS.sleep).verb,
    mode,
    say: cleanLine(m.say, 24), hint: cleanLine(m.hint, 80), done: cleanLine(m.done, 80),
    state: typeof m.state === 'string' && SID_RE.test(m.state) ? m.state : null,
    enterPose: typeof m.enterPose === 'string' && POSE_RE.test(m.enterPose) ? m.enterPose : null,
  }
  if (mode === 'beside') {
    const p = String(m.pose ?? '').trim().toLowerCase()
    if (POSE_RE.test(p)) out.pose = p
    out.holdMs = clampInt(m.holdMs, HOLD_MS[0], HOLD_MS[1], 3000)
    if (typeof m.furnitureState === 'string' && SID_RE.test(m.furnitureState)) out.furnitureState = m.furnitureState
  }
  if (mode === 'inside' && m.occupant) out.occupant = cleanOccupant(m.occupant, card.size, 'curl-sleep')
  return out
}

function cleanStates (list) {
  const taken = new Set(['empty'])
  const out = []
  for (const [i, s] of list.entries()) {
    if (out.length >= MAX_STATES) break
    if (!s || typeof s !== 'object') continue
    const id = uniq(slug(s.id), taken, 'anim' + (i + 1))
    out.push({ id, label: cleanLine(s.label, 12) || id, frames: clampInt(s.frames, 1, MAX_STATE_FRAMES, 2), ms: clampInt(s.ms, 80, 2000, 400), desc: cleanText(s.desc, 300) })
  }
  return out
}

function cleanInteractions (list, size) {
  const taken = new Set(RESERVED_VERBS)
  const out = []
  for (const [i, it] of list.entries()) {
    if (out.length >= MAX_INTERACTIONS) break
    if (!it || typeof it !== 'object') continue
    const p = String(it.pose ?? '').trim().toLowerCase()
    const pose = POSE_RE.test(p) ? p : null
    const mode = it.mode === 'inside' ? 'inside' : 'beside'
    out.push({
      verb: uniq(slug(it.verb), taken, 'act-' + (i + 1)),
      mode,
      say: cleanLine(it.say, 24),
      hint: cleanLine(it.hint, 80),
      done: cleanLine(it.done, 80),
      pose,
      furnitureState: typeof it.furnitureState === 'string' && SID_RE.test(it.furnitureState) ? it.furnitureState : null,
      holdMs: clampInt(it.holdMs, HOLD_MS[0], HOLD_MS[1], 3000),
      brief: cleanText(it.brief, 600),
      // an inside interaction read back from a pack keeps its own placement, so re-installing cannot drift it
      ...(mode === 'inside' && it.occupant ? { occupant: cleanOccupant(it.occupant, size, pose || 'curl-sleep') } : {}),
      ...(mode === 'inside' && typeof it.state === 'string' && SID_RE.test(it.state) ? { state: it.state } : {}),
    })
  }
  return out
}

/** the wake / exit interaction as it was in the pack we came from (texts only) */
function cleanExit (m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const out = { say: cleanLine(m.say, 24) || '起床', hint: cleanLine(m.hint, 80), done: cleanLine(m.done, 80) }
  return out
}

/** patch -> card (every field bounded). Old cards (no spec / extraStates / interactions) come through unchanged otherwise. */
export function cleanCard (card, patch = {}) {
  const c = { ...blankCard(), ...(card || {}) }
  if (card && !(card.spec in SPECS)) c.spec = specOfSize(c.size)
  if (card && !('area' in card)) c.area = null              // cards from before area / clipPath keep anchor + clipY
  if (card && !('clipPath' in card)) c.clipPath = null
  if (patch.spec in SPECS && patch.spec !== c.spec) {
    const s = SPECS[patch.spec]
    c.spec = patch.spec
    if (s.size) {
      c.size = [...s.size]; c.kind = s.kind; c.anchor = [...s.anchor]; c.clipY = s.clipY; c.frames = s.frames
      c.area = s.area ? [...s.area] : null; c.clipPath = s.clipPath ? s.clipPath.map((q) => [...q]) : null
      c.floorPad = s.floorPad
    }
  }
  if (typeof patch.name === 'string') c.name = cleanLine(patch.name, 24) || c.name
  if (typeof patch.desc === 'string') c.desc = cleanText(patch.desc, 1200)
  if (patch.kind in KINDS) c.kind = patch.kind
  if (Array.isArray(patch.size) && patch.size.length === 2) {
    c.size = [clampInt(patch.size[0], 32, 1200, c.size[0]), clampInt(patch.size[1], 32, 1200, c.size[1])]
    const s = SPECS[c.spec]
    if (s.size && (s.size[0] !== c.size[0] || s.size[1] !== c.size[1])) c.spec = 'custom'
  }
  if (Array.isArray(patch.anchor) && patch.anchor.length === 2) c.anchor = [clampInt(patch.anchor[0], 0, 1200, c.anchor[0]), clampInt(patch.anchor[1], 0, 1200, c.anchor[1])]
  if ('clipY' in patch) c.clipY = patch.clipY === null || patch.clipY === '' ? null : clampInt(patch.clipY, 0, 1200, null)
  if ('area' in patch) c.area = patch.area
  if ('clipPath' in patch) c.clipPath = patch.clipPath
  if (POSES.includes(patch.pose)) c.pose = patch.pose
  if (typeof patch.done === 'string') c.done = cleanLine(patch.done, 80)
  if ('frames' in patch) c.frames = clampInt(patch.frames, 1, MAX_FRAMES, c.frames)
  if ('mainState' in patch) c.mainState = typeof patch.mainState === 'string' && SID_RE.test(patch.mainState) ? patch.mainState : null
  if ('idleState' in patch) c.idleState = typeof patch.idleState === 'string' && SID_RE.test(patch.idleState) ? patch.idleState : c.idleState
  if ('floorPad' in patch) c.floorPad = clampInt(patch.floorPad, 0, Math.max(c.size[1] - 4, 0), c.floorPad)
  if ('feature' in patch) c.feature = typeof patch.feature === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(patch.feature) ? patch.feature : null
  if ('featureCfg' in patch) c.featureCfg = patch.featureCfg && typeof patch.featureCfg === 'object' && !Array.isArray(patch.featureCfg) ? patch.featureCfg : null
  if ('pack' in patch && patch.pack && typeof patch.pack === 'object' && !Array.isArray(patch.pack)) c.pack = cleanPackMeta(patch.pack, c.pack)
  if ('main' in patch) c.main = cleanMain(patch.main, c)
  if ('exit' in patch) c.exit = cleanExit(patch.exit)
  c.extraStates = cleanStates(Array.isArray(patch.extraStates) ? patch.extraStates : Array.isArray(c.extraStates) ? c.extraStates : [])
  c.interactions = cleanInteractions(Array.isArray(patch.interactions) ? patch.interactions : Array.isArray(c.interactions) ? c.interactions : [], c.size)
  // references must point at an animation that exists
  const ids = new Set(c.extraStates.map((s) => s.id))
  if (!ids.has(c.mainState)) c.mainState = null
  for (const it of c.interactions) if (!ids.has(it.furnitureState)) it.furnitureState = null
  c.anchor = [Math.min(c.anchor[0], c.size[0]), Math.min(c.anchor[1], c.size[1])]
  if (c.clipY !== null) c.clipY = Math.min(c.clipY, c.size[1])
  c.area = cleanArea(c.area, c.size)          // old cards: undefined -> null (anchor + clipY as before)
  c.clipPath = cleanClipPath(c.clipPath, c.size)
  c.floorPad = clampInt(c.floorPad, 0, Math.max(c.size[1] - 4, 0), 4)
  c.main = c.main ? cleanMain(c.main, c) : null
  return c
}

/** order / defaultEnabled / window anchor / stand line: pack metadata a UI edit must not invent */
function cleanPackMeta (m, cur) {
  const base = { ...(blankCard().pack), ...(cur || {}) }
  const out = { ...base }
  if ('order' in m) out.order = clampInt(m.order, 0, 999, base.order)
  if (typeof m.defaultEnabled === 'boolean') out.defaultEnabled = m.defaultEnabled
  if (typeof m.anchor === 'string' && /^(bottom|top|taskbar)-(right|left)$|^taskbar$/.test(m.anchor)) out.anchor = m.anchor
  if ('stand' in m) {
    const s = m.stand
    out.stand = s && typeof s === 'object' && Number.isFinite(Number(s.left)) && Number.isFinite(Number(s.right))
      ? { left: clampInt(s.left, -2000, 4000, 0), right: clampInt(s.right, -2000, 4000, 0) } : null
  }
  return out
}

/** every frame key the card asks for, idle first */
export function cardKeys (card) {
  const idle = card.idleState || 'empty'
  const out = Array.from({ length: card.frames }, (_, i) => frameKey(i, idle))
  for (const s of card.extraStates || []) for (let i = 0; i < s.frames; i++) out.push(frameKey(i, s.id))
  return out
}

const fill = (s, card) => String(s).replaceAll('{furniture}', card.name)
const DEFAULT_DONE = { beside: '{name}到{furniture}旁边了。', inside: '{name}进{furniture}里了。' }

/** card -> furniture.json (each state's frames list filled from the keys that exist) */
export function buildManifest (id, card, frameKeys) {
  card = cleanCard(card)
  const k = KINDS[card.kind] || KINDS.sleep
  const [w, h] = card.size
  const idle = card.idleState || 'empty'
  const block = (sid, ms) => {
    const fs = frameKeys.filter((f) => f.startsWith(sid + '_')).sort()
    return { frames: fs.map((f) => 'sprites/' + f + '.png'), durationsMs: fs.map(() => fs.length > 1 ? ms : 1000) }
  }
  const states = { [idle]: block(idle, 500) }
  for (const s of card.extraStates) { const b = block(s.id, s.ms); if (b.frames.length) states[s.id] = b }
  const has = (sid) => !!sid && sid in states && sid !== idle
  const occupant = (pose, under, own) => {
    // a placement read back from a pack keeps its own numbers; the card's frame/line only fills what it lacks
    const base = own && typeof own === 'object' ? { ...own } : {}
    delete base.under
    return { ...base, pose, fallback: Array.isArray(base.fallback) && base.fallback.length ? base.fallback : ['lie'],
      anchor: [...card.anchor], ...(card.clipY !== null ? { clipY: card.clipY } : {}),
      ...(card.area ? { area: [...card.area] } : {}), ...(card.clipPath ? { clipPath: card.clipPath.map((q) => [...q]) } : {}),
      ...(has(under) ? { under } : {}) }
  }

  const main = { verb: k.verb, mode: k.mode, say: fill(k.say, card), hint: fill(k.hint, card), done: card.done || fill(k.done, card) }
  if (card.main) {
    if (card.main.verb) main.verb = card.main.verb
    main.mode = card.main.mode
    if (card.main.say) main.say = fill(card.main.say, card)
    if (card.main.hint) main.hint = fill(card.main.hint, card)
    if (card.main.done) main.done = fill(card.main.done, card)
    if (card.main.state && states[card.main.state]) main.state = card.main.state
    if (card.main.enterPose) main.enterPose = card.main.enterPose
  }
  const inters = [main]
  const exitInter = (when) => {
    const e = card.exit || {}
    return { verb: 'wake', mode: 'exit', say: e.say || when, hint: e.hint || '用户叫{name}起来时用', done: fill(e.done || k.wake, card) }
  }
  if (main.mode === 'inside') {
    main.occupant = occupant((card.main && card.main.occupant && card.main.occupant.pose) || k.pose, card.mainState,
      card.main && card.main.occupant)
    if (!card.main || !card.main.enterPose) main.enterPose = 'jumping'
    if (!inters.some((i) => i.mode === 'exit')) inters.push(exitInter('起床'))
  } else {
    main.pose = (card.main && card.main.pose) || card.pose
    main.holdMs = (card.main && card.main.holdMs) || 3000
    const fs = (card.main && card.main.furnitureState) || card.mainState
    if (has(fs)) main.furnitureState = fs
  }
  for (const it of card.interactions) {
    const o = { verb: it.verb, mode: it.mode, say: fill(it.say || it.verb, card), hint: fill(it.hint, card), done: fill(it.done || DEFAULT_DONE[it.mode], card) }
    if (it.state && states[it.state]) o.state = it.state
    if (it.mode === 'inside') {
      o.occupant = occupant(it.pose || 'curl-sleep', it.furnitureState, it.occupant)
      o.enterPose = 'jumping'
    } else {
      if (it.pose) o.pose = it.pose
      o.holdMs = it.holdMs
      if (has(it.furnitureState)) o.furnitureState = it.furnitureState
    }
    inters.push(o)
  }
  if (inters.some((i) => i.mode === 'inside') && !inters.some((i) => i.mode === 'exit')) {
    inters.push(exitInter('出来'))
  }
  const meta = card.pack || {}
  return {
    id, name: card.name, version: 1, order: meta.order ?? 40, size: [w, h], anchor: meta.anchor || 'bottom-right',
    defaultEnabled: meta.defaultEnabled === true, floorY: h - card.floorPad, idle,
    ...(meta.stand ? { stand: { ...meta.stand } } : {}),
    ...(card.feature ? { feature: card.feature } : {}),
    ...(card.feature && card.featureCfg ? { [card.feature]: card.featureCfg } : {}),
    states,
    interactions: inters,
  }
}

/**
 * Interactions a session wrote into build/<id>/furniture.json survive card edits / rebuilds:
 * verbs the card owns follow the card (extra keys the session added are kept), new verbs are kept as written.
 */
const OCC_CARD_KEYS = ['anchor', 'clipY', 'area', 'clipPath']
export function mergeInteractions (gen, edited) {
  if (!Array.isArray(edited)) return gen
  const byVerb = new Map(edited.filter((i) => i && typeof i === 'object' && typeof i.verb === 'string').map((i) => [i.verb, i]))
  const out = gen.map((g) => {
    const e = byVerb.get(g.verb)
    if (!e) return g
    const m = { ...e, ...g }
    // placement keys follow the card: one the card dropped (e.g. clipPath cleared) must not come back from the old file
    if (e.occupant && g.occupant) m.occupant = { ...Object.fromEntries(Object.entries(e.occupant).filter(([key]) => !OCC_CARD_KEYS.includes(key))), ...g.occupant }
    return m
  })
  for (const [v, e] of byVerb) if (!gen.some((g) => g.verb === v)) out.push(e)
  return out
}

const STYLE = 'Pixel art: crisp square pixels on a consistent pixel grid, limited palette, clean dark outline, light from the top left. No gradients, no blur, no anti-aliasing haze.'

/** one image request / the brief handed to a session; sid = 'empty' or an extra state's id */
export function buildFurniturePrompt (card, index = 0, sid = 'empty') {
  card = cleanCard(card)
  const k = KINDS[card.kind] || KINDS.sleep
  const what = card.desc || card.name
  const [w, h] = card.size
  const inside = k.mode === 'inside' || card.interactions.some((i) => i.mode === 'inside')
  const use = inside
    ? 'A small desktop-pet character will later be drawn lying inside it by software, so leave the sleeping area visibly EMPTY: no character, no animal, no person in it.'
    : 'A small desktop-pet character will stand next to it; draw only the object, no character.'
  const st = sid === 'empty' ? null : card.extraStates.find((s) => s.id === sid)
  const n = st ? st.frames : card.frames
  const anim = st
    ? 'Animation "' + st.label + '": ' + (st.desc || st.label) + '. Frame ' + (index + 1) + ' of ' + n + '. The SAME object as the reference picture: same size, same position, same palette and outline; change only what this animation needs.'
    : (card.frames > 1 ? 'Animation: frame ' + (index + 1) + ' of ' + card.frames + ' of a subtle idle loop; everything else stays pixel-identical.' : '')
  return ['Purpose: one sprite of a furniture piece for a pixel desktop pet (the pet is about 160x170 px).',
    'Subject: ' + what + '.',
    'Use: ' + use,
    anim,
    'Style: ' + STYLE,
    'Composition: the whole object, centered, standing on the bottom edge, seen slightly from above; aspect ratio about ' + w + ':' + h + '.',
    'Constraints: background flat solid #00FF00 green (or transparent), nothing else: no floor, no shadow outside the object, no text, no border. Exactly one picture, not a sprite sheet.',
  ].filter(Boolean).join('\n')
}

/** the furniture.json contract in a few lines (full version: docs/FURNITURE_SPEC.md) */
export function contractSummary () {
  return [
    '- states：{状态id: {frames: ["sprites/<状态>_NN.png"…], durationsMs: [40–5000 整数…]}}，idle 必须是 "empty"；所有帧同为 size 大小的 RGBA PNG',
    '- interactions[]：verb（小写字母开头，a-z0-9-，不重复）、mode = beside | inside | exit、say / hint / done（字符串，{name}=角色名）',
    '  - beside：走到旁边；pose = 角色状态名（角色没有就忽略），holdMs 500–10000；furnitureState = 家具自己的某个状态，播 holdMs 毫秒',
    '  - inside：进去；必须有 occupant {pose, fallback?, area?:[x0,y0,x1,y1], clipPath?:[[x,y]…], anchor?:[x,y], clipY?, under?}；enterPose 可选',
    '    area = 角色躺的区域（太大就等比缩小，贴区域底边居中；有 area 时不看 anchor）；clipPath = 前沿折线（2–24 点，x 递增），线以下的家具像素盖在角色上；没有 area 才用 anchor（身体底边中点），没有 clipPath 才用 clipY（水平前沿）；under = 进去后家具显示的状态',
    '  - exit：出来（有 inside 就要有一条 exit）',
    '- 不要画角色：角色进出由插件用角色自己的帧叠上去',
  ].join('\n')
}

/** the "交给会话画" brief: spec + contract + prompts + where to put the files */
export function buildHandoff (job, rawDir, { pluginDir = PLUGIN_DIR } = {}) {
  const c = cleanCard(job.card)
  const s = SPECS[c.spec] || SPECS.custom
  const k = KINDS[c.kind] || KINDS.sleep
  const groups = [{ id: 'empty', label: '空着（常驻）', frames: c.frames, desc: '' }, ...c.extraStates]
  const names = (g) => Array.from({ length: g.frames }, (_, i) => frameKey(i, g.id) + '.png')
  const all = groups.flatMap(names)
  const buildDir = join(rawDir, '..', 'build', job.id)
  const inters = [
    '- ' + k.verb + '（' + k.mode + '，默认）' + (c.mainState ? ' · 家具播 ' + c.mainState : ''),
    ...c.interactions.map((i) => '- ' + i.verb + '（' + i.mode + '）' + (i.say ? ' “' + i.say + '”' : '') + (i.pose ? ' · 角色 ' + i.pose : '') +
      (i.furnitureState ? ' · 家具播 ' + i.furnitureState : '') + (i.mode === 'beside' ? ' · ' + i.holdMs + 'ms' : '') + (i.brief ? '\n  想要的效果：' + i.brief.replace(/\n+/g, ' ') : '')),
  ]
  return [
    '# 画一件桌宠家具：' + c.name,
    '',
    '规格：' + s.label + ' · ' + c.size[0] + '×' + c.size[1] + ' px · 默认互动 ' + k.verb + '（' + k.mode + '）· 桌宠约 160×170 px',
    '',
    '只画家具本身（' + all.length + ' 张）。角色躺进去 / 站旁边的画面由插件用角色自己的帧叠上去，不要画角色。',
    '',
    '## 交付',
    '- 文件名：' + all.join('、'),
    '- 背景：透明 PNG，或纯 #00FF00 绿底（插件会抠掉）',
    '- 画布：任意大小，家具完整、居中、贴底；所有帧位置一致；最终会缩放到 ' + c.size[0] + '×' + c.size[1] + ' 像素，宽高比照这个来',
    '- 画好后存到：' + rawDir + '（或交给用户拖进「新建家具」页导入）；多出来的 <新动画>_NN.png 点「转换」时也会收进来',
    '',
    '## 互动',
    ...inters,
    '',
    '转换后可以直接改 ' + join(buildDir, 'furniture.json') + ' 的 interactions（遵守下面的契约）：新加的 verb 会保留；卡片里已有的 verb 以页面为准，你加的其它字段会保留。',
    '',
    '## 契约（摘要）',
    contractSummary(),
    '',
    '完整规范：插件目录下 ' + SPEC_DOC + '（' + join(pluginDir, SPEC_DOC) + '）',
    '自查：python runtime/validate.py --strict ' + buildDir,
    '',
    '## 每张的提示词',
    '',
    ...groups.flatMap((g) => names(g).map((n, i) => '### ' + n + '\n\n' + buildFurniturePrompt(c, i, g.id))),
  ].join('\n')
}

// --------------------------------------------------------------------------- store
export function createFurnitureStudio ({ dataDir, images, convert, validate, relay, sessionId, onInstalled }) {
  const root = join(dataDir, 'create-furniture')
  const dirOf = (id) => join(root, id)
  const runs = new Map()
  const atomicWrite = (file, data) => { const tmp = file + '.' + process.pid + '.tmp'; writeFileSync(tmp, data); renameSync(tmp, file) }
  const read = (id) => {
    if (!FJOB_RE.test(String(id || ''))) return null
    let job
    try { job = JSON.parse(readFileSync(join(dirOf(id), 'job.json'), 'utf8')) } catch { return null }
    if (!job || typeof job !== 'object') return null
    job.card = cleanCard(job.card)   // old job.json files get spec / extraStates / interactions here
    job.frames = job.frames && typeof job.frames === 'object' ? job.frames : {}
    return job
  }
  const save = (job) => { job.updatedAt = Date.now(); mkdirSync(dirOf(job.id), { recursive: true }); atomicWrite(join(dirOf(job.id), 'job.json'), JSON.stringify(job, null, 2)) }
  const rawDir = (id) => join(dirOf(id), 'raw')
  const rawFile = (id, k) => {
    if (!/^[a-z][a-z0-9-]{0,23}_\d{2}$/.test(String(k || ''))) throw new TypeError('bad frame key')
    return join(rawDir(id), k + '.png')
  }
  const hasRaw = (id, k) => { try { return existsSync(rawFile(id, k)) } catch { return false } }
  const keys = (job) => cardKeys(job.card)
  const targetOf = (job) => (job && job.targetId) || (job && job.id)
  const outDir = (id) => join(dirOf(id), 'build', (read(id) && read(id).targetId) || id)
  const sig = (text) => createHash('sha1').update(text).digest('hex')

  const create = (patch = {}) => {
    let id
    do { id = 'furn-' + randomBytes(3).toString('hex') } while (existsSync(dirOf(id)) || existsSync(join(dataDir, 'furniture', id)))
    const job = { id, kind: 'furniture', card: cleanCard(null, patch), frames: {}, build: null, installed: false, createdAt: Date.now(), targetId: id, origin: null }
    save(job)
    return job
  }
  const list = () => {
    let names = []
    try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
    return names.map(read).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((j) => ({ id: j.id, name: j.card.name, installed: !!j.installed, updatedAt: j.updatedAt, targetId: j.targetId || j.id, origin: j.origin || null }))
  }
  /** interactions in the built furniture.json when someone other than the studio changed that file, else null */
  const editedInteractions = (job) => {
    let text
    try { text = readFileSync(join(outDir(job.id), 'furniture.json'), 'utf8') } catch { return null }
    if (!job.manifestSig || sig(text) === job.manifestSig) return null
    try { const d = JSON.parse(text); return Array.isArray(d.interactions) ? d.interactions : null } catch { return null }
  }
  /**
   * furniture.json text for the build dir, a session's edits merged in. Edits found on disk are remembered in
   * job.session (verbs it added + the card verbs it touched), so they survive later rewrites and rebuilds.
   */
  const manifestText = (job, have) => {
    const m = buildManifest(targetOf(job), job.card, have)
    const e = editedInteractions(job)
    if (e) {
      const own = new Set(m.interactions.map((i) => i.verb))
      const ok = e.filter((i) => i && typeof i === 'object' && typeof i.verb === 'string')
      job.session = { added: ok.filter((i) => !own.has(i.verb)), patched: ok.filter((i) => own.has(i.verb)) }
    }
    if (job.session) m.interactions = mergeInteractions(m.interactions, [...(job.session.patched || []), ...(job.session.added || [])])
    return JSON.stringify(m, null, 2) + '\n'
  }
  const view = (id) => {
    const job = read(id); if (!job) return null
    const r = runs.get(id)
    const frames = {}
    for (const k of keys(job)) frames[k] = hasRaw(id, k) ? 'done' : r && r.current === k ? 'running' : job.frames[k] && job.frames[k].status === 'failed' ? 'failed' : 'pending'
    const pending = Object.values(frames).filter((s) => s !== 'done').length
    return { ...job, frames, rawDir: rawDir(id), handEdited: !!(job.session || editedInteractions(job)), plan: { total: keys(job).length, pending },
      run: r ? { running: !r.finished, done: r.done, failed: r.failed, total: r.total, error: r.error || null } : (job.lastRun || null) }
  }
  /** card edits; a built pack gets its furniture.json rewritten so anchor / interaction tweaks need no re-convert */
  const update = (id, patch) => {
    const job = read(id); if (!job) return null
    const before = JSON.stringify([job.card.size, cardKeys(job.card)])
    job.card = cleanCard(job.card, patch || {})
    if (job.build && job.build.ok && JSON.stringify([job.card.size, cardKeys(job.card)]) !== before) job.build = { ...job.build, ok: false, stale: true, message: '尺寸或帧变了，要重新转换' }
    writeManifest(job)
    save(job)
    return job
  }
  const writeManifest = (job) => {
    const out = outDir(job.id)
    if (!existsSync(join(out, 'sprites'))) return
    const have = keys(job).filter((k) => existsSync(join(out, 'sprites', k + '.png')))
    const text = manifestText(job, have)
    atomicWrite(join(out, 'furniture.json'), text)
    job.manifestSig = sig(text)
  }

  const idleOf = (job) => (job && job.card && job.card.idleState) || 'empty'

  const importFrame = (id, fileName, buf) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const idle = idleOf(job)
    const m = String(fileName || '').toLowerCase().match(FNAME_RE)
    const sid = m ? m[1] : idle
    const idx = m ? Number(m[2]) : (Object.keys(job.frames).length ? -1 : 0)
    const bad = { code: 400, body: { ok: false, message: '文件名要是 ' + idle + '_00.png … ' + idle + '_0' + (MAX_FRAMES - 1) + '.png，或 <动画>_00.png' } }
    if (idx < 0) return bad
    if (sid === idle ? idx >= MAX_FRAMES : idx >= MAX_STATE_FRAMES) return bad
    if (!imageType(buf)) return { code: 415, body: { ok: false, message: '只收 PNG / JPEG / WebP 图片' } }
    if (sid !== idle && !job.card.extraStates.some((s) => s.id === sid)) {
      if (job.card.extraStates.length >= MAX_STATES) return { code: 400, body: { ok: false, message: '动画最多 ' + MAX_STATES + ' 个' } }
      job.card = cleanCard(job.card, { extraStates: [...job.card.extraStates, { id: sid, label: sid, frames: idx + 1 }] })
    }
    mkdirSync(rawDir(id), { recursive: true })
    const k = frameKey(idx, sid)
    atomicWrite(rawFile(id, k), buf)
    job.frames[k] = { status: 'done', source: 'import', at: Date.now() }
    if (sid === idle) { if (idx + 1 > job.card.frames) job.card.frames = idx + 1 }
    else { const st = job.card.extraStates.find((s) => s.id === sid); if (idx + 1 > st.frames) st.frames = idx + 1 }
    save(job)
    return { code: 200, body: { ok: true, key: k } }
  }
  /** raw/<state>_NN.png a session saved for an animation the card does not list yet -> added to the card */
  const adoptRaw = (job) => {
    let names = []
    try { names = readdirSync(rawDir(job.id)) } catch { return false }
    const idle = idleOf(job)
    const want = new Map()
    for (const n of names) {
      const m = n.match(/^([a-z][a-z0-9-]{0,23})_(\d{2})\.png$/)
      if (!m || m[1] === idle || Number(m[2]) >= MAX_STATE_FRAMES) continue
      want.set(m[1], Math.max(want.get(m[1]) || 0, Number(m[2]) + 1))
    }
    const add = [...want].filter(([sid]) => !job.card.extraStates.some((s) => s.id === sid)).map(([sid, n]) => ({ id: sid, label: sid, frames: n }))
    if (!add.length) return false
    job.card = cleanCard(job.card, { extraStates: [...job.card.extraStates, ...add] })
    return true
  }

  /** generate every missing frame; confirm must equal the number of images (the page asks first) */
  const run = (id, { confirm, redo } = {}) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    if (runs.has(id) && !runs.get(id).finished) return { code: 409, body: { ok: false, message: '正在生成' } }
    const todo = keys(job).filter((k) => redo === true || !hasRaw(id, k))
    if (!todo.length) return { code: 200, body: { ok: true, total: 0 } }
    if (confirm !== todo.length) return { code: 409, body: { ok: false, code: 'confirm', total: todo.length } }
    if (redo === true) for (const k of todo) rmSync(rawFile(id, k), { force: true })
    const r = { stop: false, total: todo.length, done: 0, failed: 0, error: null, current: null, finished: false }
    runs.set(id, r)
    r.promise = loop(id, todo, r).catch((e) => { r.error = String(e && e.message || e) }).finally(() => {
      r.finished = true; r.current = null
      const j = read(id); if (j) { j.lastRun = { running: false, done: r.done, failed: r.failed, total: r.total, error: r.error }; save(j) }
    })
    return { code: 200, body: { ok: true, total: todo.length } }
  }
  const FATAL = new Set(['auth', 'quota', 'nokey', 'config', 'forbidden', 'notfound', 'rate'])
  const loop = async (id, todo, r) => {
    mkdirSync(rawDir(id), { recursive: true })
    for (const k of todo) {
      if (r.stop) break
      const job = read(id); if (!job) break
      const sid = k.slice(0, -3); const idx = Number(k.slice(-2))
      const refs = (idx > 0 || sid !== 'empty') && hasRaw(id, frameKey(0)) ? [{ name: 'empty_00.png', data: readFileSync(rawFile(id, frameKey(0))) }] : []
      r.current = k
      try {
        const [buf] = await images.generate({ prompt: buildFurniturePrompt(job.card, idx, sid), n: 1, references: refs })
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

  /** text of the brief; with send=true also posted into the pointed session */
  const handoff = async (id, { send } = {}) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    mkdirSync(rawDir(id), { recursive: true })
    const text = buildHandoff(job, rawDir(id))
    if (!send) return { code: 200, body: { ok: true, text } }
    const sid = typeof sessionId === 'function' ? sessionId() : ''
    if (!sid) return { code: 400, body: { ok: false, code: 'nosession', message: '还没指向会话', text } }
    const r = await relay.post(sid, text)
    return { code: r.code, body: { ...r.body, text } }
  }

  /** a frame of the piece we came from: new frames land on its floor line / centre */
  const refFrameOf = (job, frameKeys) => {
    const skip = new Set(frameKeys)
    for (const k of [frameKey(0, idleOf(job)), ...keys(job)]) {
      if (skip.has(k)) continue
      const rec = job.frames && job.frames[k]
      if (!rec || rec.source !== 'existing') continue
      if (hasRaw(job.id, k)) return 'raw/' + k + '.png'
    }
    return null
  }

  /**
   * Only the frames that were regenerated / imported after the reverse job was made. <job>/normalize.json tells
   * runtime/furniture_convert.py (frame_normalize.py) the card size, the pixel grid and the reference frame of
   * the piece; it keys the green, hardens alpha and fits the picture onto the card, bottom-aligned on the
   * piece's own floor line. A frame that already is a canonical RGBA picture of the card size is copied as is.
   */
  const normalizeNewFrames = async (id, out, job, frameKeys) => {
    const problems = []
    if (typeof convert !== 'function') return rescueCanonical(id, out, job.card.size, frameKeys, '这台机器上没有图像转换器，新帧没法归一化')
    const brief = { kind: 'furniture', frames: frameKeys, size: [...job.card.size], grid: 1, ref: refFrameOf(job, frameKeys) }
    const file = join(dirOf(id), 'normalize.json')
    writeFileSync(file, JSON.stringify(brief, null, 2))
    let r = null
    try {
      r = await convert({ src: rawDir(id), out, frames: frameKeys, size: job.card.size, normalize: brief })
    } catch (e) {
      r = { ok: false, message: '新帧转换失败：' + String((e && e.message) || e).slice(0, 140) }
    } finally {
      try { rmSync(file, { force: true }) } catch {}
    }
    if (r && r.ok === false) {
      if (r.available === false) return rescueCanonical(id, out, job.card.size, frameKeys, r.message || '没有可用转换器')
      return [r.message || '新帧转换失败', ...(r.issues || []).slice(0, 20)]
    }
    if (!r && !problems.length) problems.push('新帧转换没有结果')
    return problems
  }

  /** Converter unavailable only: header-compatible frames use the limited fallback, never after a rejection. */
  const rescueCanonical = (jobId, out, size, frameKeys, why, issues = []) => {
    const left = []
    for (const k of frameKeys) {
      if (!frameIsCanonical(rawFile(jobId, k), size)) { left.push(k); continue }
      try { copyFileSync(rawFile(jobId, k), join(out, 'sprites', k + '.png')) } catch { left.push(k) }
    }
    if (!left.length) return []
    const problems = [why]
    for (const line of issues) problems.push(String(line))
    for (const k of left) problems.push(k + '.png 还没来得及归一化（尺寸/底色不对）')
    return problems
  }

  const build = async (id) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const adopted = adoptRaw(job)
    if (adopted) save(job)
    const idle = idleOf(job)
    const have = keys(job).filter((k) => hasRaw(id, k))
    if (!have.length || !hasRaw(id, frameKey(0, idle))) return { code: 400, body: { ok: false, message: '还没有 ' + idle + '_00' } }
    const out = outDir(id)
    const text = manifestText(job, have)   // read a session's edits before the old build goes
    rmSync(join(dirOf(id), 'build'), { recursive: true, force: true }); mkdirSync(join(out, 'sprites'), { recursive: true })
    writeFileSync(join(out, 'furniture.json'), text)
    let r
    const problems = []
    if (job.origin && job.origin.kind === 'pack') {
      // re-editing an installed piece: the frames it already had are final sprites of card.size, copied byte for
      // byte (re-cropping or re-scaling would make the piece drift). Only new art is normalized to the card.
      const fresh = []
      for (const k of have) {
        const rec = job.frames && job.frames[k]
        if (!rec || rec.source !== 'existing') { fresh.push(k); continue }
        try { copyFileSync(rawFile(id, k), join(out, 'sprites', k + '.png')) } catch { problems.push('复制 ' + k + '.png 失败') }
      }
      if (fresh.length) problems.push(...await normalizeNewFrames(id, out, job, fresh))
      r = await judge(out, problems)
    } else {
      r = await convert({ src: rawDir(id), out, frames: have, size: job.card.size })
      if (r && r.ok && typeof validate === 'function') {
        let v = null
        try { v = await validate(out) } catch { v = null }
        if (v && typeof v.ok === 'boolean') r = { ...r, ok: !!v.ok, validated: true, issues: (v.issues || r.issues || []).slice(0, 60), message: v.message || r.message }
      }
    }
    const fresh = read(id)
    if (adopted) fresh.card = job.card
    fresh.session = job.session
    fresh.manifestSig = sig(text)
    fresh.build = { at: Date.now(), ok: !!r.ok, validated: !!r.validated, message: r.message || '', issues: (r.issues || []).slice(0, 60), frames: have.length, validatedBy: r.by || 'python' }
    save(fresh)
    return { code: 200, body: { ok: !!r.ok, build: fresh.build, issues: fresh.build.issues } }
  }

  /** passthrough verdict: the Python validator when we have one, else a structural check */
  const judge = async (out, problems) => {
    if (typeof validate === 'function') {
      let v = null
      try { v = await validate(out) } catch { v = null }
      if (v && typeof v.ok === 'boolean') return { ok: v.ok && !problems.length, validated: true, by: 'python', message: v.message || '', issues: [...(v.issues || []), ...problems].slice(0, 60) }
    }
    return jsValidateFurniture(out, problems)
  }

  /**
   * Read an installed piece back into an editing job: spec, interactions, animations, placement box,
   * front line and the pack metadata (order / window anchor / stand / feature) all come from its manifest.
   */
  const reverse = ({ id, dir, data, base = 'builtin', installed = false }) => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(id || '')) || !data || typeof data !== 'object') return { code: 400, body: { ok: false, message: '这个包读不出来' } }
    const badState = Object.keys(data.states || {}).find((sid) => !/^[a-z][a-z0-9-]{0,23}$/.test(sid))
    if (badState || !data.states || typeof data.states !== 'object') return { code: 400, body: { ok: false, message: '这个包的状态名不合法' + (badState ? '：' + badState : '') } }
    const prev = list().find((j) => (j.targetId === id) && j.origin && j.origin.kind === 'pack')
    if (prev) { const j = read(prev.id); if (j) return { code: 200, body: { ok: true, job: view(j.id), reused: true } } }
    let jid
    do { jid = 'furn-' + randomBytes(3).toString('hex') } while (existsSync(dirOf(jid)))
    const size = Array.isArray(data.size) && data.size.length === 2 ? [Number(data.size[0]) || 360, Number(data.size[1]) || 300] : [360, 300]
    const idle = typeof data.idle === 'string' && SID_RE.test(data.idle) ? data.idle : (data.states && data.states.empty ? 'empty' : Object.keys(data.states || {})[0] || 'empty')
    const inter = Array.isArray(data.interactions) ? data.interactions : []
    const primary = inter.find((i) => i && i.mode === 'inside') || inter.find((i) => i && i.mode === 'beside') || null
    const occ = primary && primary.occupant && typeof primary.occupant === 'object' ? primary.occupant : {}
    const kind = primary && primary.mode === 'inside' ? 'sleep' : 'use'
    const area = cleanArea(occ.area, size)
    const clipPath = cleanClipPath(occ.clipPath, size)
    const anchor = Array.isArray(occ.anchor) && occ.anchor.length === 2
      ? [clampInt(occ.anchor[0], 0, size[0], Math.round(size[0] / 2)), clampInt(occ.anchor[1], 0, size[1], Math.round(size[1] * 0.8))]
      : [Math.round(size[0] / 2), Math.round(size[1] * 0.8)]
    const idleState = data.states && data.states[idle] && Array.isArray(data.states[idle].frames) ? idle : 'empty'
    const extra = Object.keys(data.states || {}).filter((sid) => sid !== idleState).slice(0, MAX_STATES).map((sid) => {
      const st = data.states[sid] || {}
      const frames = Array.isArray(st.frames) ? st.frames.length : 0
      const ms = Array.isArray(st.durationsMs) && st.durationsMs.length ? st.durationsMs[0] : 400
      return { id: sid, label: sid, frames: clampInt(frames, 1, MAX_STATE_FRAMES, 1), ms: clampInt(ms, 80, 2000, 400), desc: '' }
    })
    const patch = {
      name: data.name || id, size, kind, idleState, floorPad: clampInt(size[1] - (Number(data.floorY) || size[1] - 4), 0, Math.max(size[1] - 4, 0), 4),
      anchor, area, clipPath, clipY: occ.clipY !== null && occ.clipY !== undefined ? clampInt(occ.clipY, 0, size[1], null) : null,
      frames: clampInt(data.states && data.states[idleState] ? data.states[idleState].frames.length : 1, 1, MAX_FRAMES, 1),
      feature: typeof data.feature === 'string' ? data.feature : null,
      featureCfg: data.feature && typeof data[data.feature] === 'object' ? data[data.feature] : null,
      pack: { order: Number(data.order) || 40, defaultEnabled: data.defaultEnabled === true, anchor: typeof data.anchor === 'string' ? data.anchor : 'bottom-right', stand: data.stand || null },
      main: primary ? { ...primary } : null,
      exit: inter.find((i) => i && i.mode === 'exit') || null,
      extraStates: extra,
      interactions: inter.filter((i) => i && i !== primary && i.mode !== 'exit').slice(0, MAX_INTERACTIONS),
    }
    // main.pose / holdMs / furnitureState / occupant come through cleanMain; state is preserved there too
    const card = cleanCard(null, patch)
    const job = { id: jid, kind: 'furniture', card, frames: {}, build: null, installed: !!installed, createdAt: Date.now(), targetId: id,
      origin: { kind: 'pack', id, base, installed: !!installed, at: Date.now(), missing: [] } }
    mkdirSync(rawDir(jid), { recursive: true })
    for (const [sid, st] of Object.entries(data.states || {})) {
      if (!st || !Array.isArray(st.frames)) continue
      st.frames.forEach((rel, i) => {
        const src = packFrame(dir, rel)
        if (!src) { job.origin.missing.push(sid + '_' + String(i).padStart(2, '0')); return }
        const k = frameKey(i, sid)
        try { copyFileSync(src, rawFile(jid, k)); job.frames[k] = { status: 'done', source: 'existing', at: Date.now() } } catch { job.origin.missing.push(k) }
      })
    }
    save(job)
    return { code: 200, body: { ok: true, job: view(jid), reused: false } }
  }

  const install = (id) => {
    const job = read(id); if (!job) return { code: 404, body: { ok: false } }
    const target = targetOf(job)
    const src = outDir(id)
    if (!job.build || !job.build.ok || !existsSync(join(src, 'furniture.json'))) return { code: 400, body: { ok: false, message: '先转换并通过校验' } }
    writeManifest(job)
    const base = join(dataDir, 'furniture'); mkdirSync(base, { recursive: true })
    const dest = join(base, target)
    const tmp = join(base, '.' + target + '.tmp')
    const old = join(base, '.' + target + '.old-' + process.pid)
    rmSync(tmp, { recursive: true, force: true }); rmSync(old, { recursive: true, force: true })
    cpSync(src, tmp, { recursive: true })
    // move the previous user version aside first: a failed final rename must leave it usable
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
    return { code: 200, body: { ok: true, id: target, overlay: !!job.origin && job.origin.base === 'builtin' } }
  }
  const remove = (id) => {
    if (!read(id)) return { code: 404, body: { ok: false } }
    stop(id)
    rmSync(dirOf(id), { recursive: true, force: true })
    return { code: 200, body: { ok: true } }
  }
  const file = (id, slot, name) => {
    const job = read(id); if (!job) return null
    if (!FKEY_RE.test(String(name)) || !keys(job).includes(name)) return null
    if (slot === 'raw') return rawFile(id, name)
    if (slot === 'frame') return join(outDir(id), 'sprites', name + '.png')
    return null
  }
  const dispose = () => { for (const r of runs.values()) r.stop = true }
  return { create, list, read, view, update, importFrame, run, stop, wait, handoff, build, install, reverse, remove, file, dispose, runs }
}

/** structural furniture check used when no Python interpreter is available (never replaces validate.py) */
export function jsValidateFurniture (dir, extra = []) {
  const issues = [...extra]
  let data = null
  try { data = JSON.parse(readFileSync(join(dir, 'furniture.json'), 'utf8')) } catch { issues.push('furniture.json 读不出来') }
  if (data) {
    const size = Array.isArray(data.size) ? data.size : [0, 0]
    const states = data.states && typeof data.states === 'object' ? data.states : {}
    if (!data.id) issues.push('缺 id')
    if (!states[data.idle]) issues.push('idle 指向不存在的状态 ' + data.idle)
    for (const [sid, st] of Object.entries(states)) {
      if (!st || !Array.isArray(st.frames) || !st.frames.length) { issues.push(sid + ' 没有帧'); continue }
      if (!Array.isArray(st.durationsMs) || st.durationsMs.length !== st.frames.length) issues.push(sid + ' 的帧时长和帧数不一致')
      for (const rel of st.frames) {
        if (!/^sprites\/[A-Za-z0-9_.-]+\.png$/.test(String(rel))) { issues.push(sid + ' 帧路径不合法'); continue }
        let head = null
        try { head = readFileSync(join(dir, rel)).subarray(0, 33) } catch { issues.push('缺文件 ' + rel); continue }
        if (!head || head.length < 33 || head.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') { issues.push(rel + ' 不是 PNG'); continue }
        const w = head.readUInt32BE(16); const h = head.readUInt32BE(20)
        if (w !== size[0] || h !== size[1]) issues.push(rel + ' 尺寸 ' + w + 'x' + h + '，要 ' + size.join('x'))
      }
    }
  }
  return { ok: !issues.length, validated: false, by: 'js', message: issues.length ? '校验没过' : '结构检查通过', issues: issues.slice(0, 60) }
}

/** a character's sleeping pose for the anchor preview: curl-sleep, else lie, else idle (first frame).
 * M0 起走 packkit 统一分层（resolveCharacter 由 host 注入）：有效用户层优先，帧文件经 packFrame 安全解析。 */
export function poseFrame (resolveCharacter, charId) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(charId || ''))) return null
  const pk = typeof resolveCharacter === 'function' ? resolveCharacter(charId) : null
  if (!pk || !pk.dir) return null
  for (const s of ['curl-sleep', 'lie', 'idle']) {
    const rel = pk.data && pk.data.states && pk.data.states[s] && Array.isArray(pk.data.states[s].frames) && pk.data.states[s].frames[0]
    if (typeof rel === 'string' && /^sprites\/[A-Za-z0-9_.-]+\.png$/.test(rel)) {
      const file = packFrame(pk.dir, rel)
      if (file) return file
    }
  }
  return null
}

/**
 * HTTP glue, mounted by lib/host.js. Returns true when it answered.
 *   GET  /api/fcreate/jobs | /api/fcreate/meta | /api/fcreate/:id | /api/fcreate/:id/img/(raw|frame)/<state>_NN
 *        /api/fcreate/pose/:characterId          (sleeping frame for the anchor preview)
 *   POST /api/fcreate/new | reverse {id} | :id/meta | :id/import?name= (image body) | :id/run | :id/stop
 *        :id/handoff | :id/build | :id/install | :id/delete
 */
export async function furnitureRoutes (req, res, path, url, h) {
  if (!path.startsWith('/api/fcreate/')) return false
  const { studio, send, sendFile, readBody, imageLimit, resolveCharacter, imagegenReady } = h
  const sub = path.slice('/api/fcreate/'.length)
  if (req.method === 'GET') {
    if (sub === 'jobs') { send(res, 200, { ok: true, jobs: studio.list() }); return true }
    if (sub === 'meta') {
      send(res, 200, { ok: true, kinds: Object.keys(KINDS), poses: POSES, charPoses: CHAR_POSES, specs: SPECS, maxFrames: MAX_FRAMES,
        maxStateFrames: MAX_STATE_FRAMES, maxStates: MAX_STATES, maxInteractions: MAX_INTERACTIONS, holdMs: HOLD_MS, reservedVerbs: RESERVED_VERBS,
        specDoc: SPEC_DOC, imagegen: await imagegenReady() })
      return true
    }
    const pm = sub.match(/^pose\/([a-z0-9][a-z0-9-]{0,39})$/)
    if (pm) { const f = poseFrame(resolveCharacter, pm[1]); if (f) sendFile(res, f, 'image/png'); else { res.writeHead(404); res.end() } return true }
    const m = sub.match(/^(furn-[a-f0-9]{6})(?:\/img\/(raw|frame)\/([a-z][a-z0-9-]{0,23}_\d{2}))?$/)
    if (!m) { res.writeHead(404); res.end(); return true }
    if (!m[2]) { const v = studio.view(m[1]); send(res, v ? 200 : 404, v ? { ok: true, job: v } : { ok: false }); return true }
    const f = studio.file(m[1], m[2], m[3])
    if (f && existsSync(f)) sendFile(res, f, 'image/png'); else { res.writeHead(404); res.end() }
    return true
  }
  if (req.method !== 'POST') return false
  const im = sub.match(/^(furn-[a-f0-9]{6})\/import$/)
  if (im) {
    if (Number(req.headers['content-length']) > imageLimit) { send(res, 413, { ok: false, message: '图片太大' }); return true }
    let buf
    try { buf = await readBody(req, imageLimit) } catch { send(res, 413, { ok: false, message: '图片太大' }); return true }
    const r = studio.importFrame(im[1], url.searchParams.get('name'), buf)
    const v = studio.view(im[1])
    send(res, r.code, v ? { ...r.body, job: v } : r.body); return true
  }
  let body = {}
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') } catch { send(res, 400, { ok: false }); return true }
  if (sub === 'new') { const j = studio.create(body); send(res, 200, { ok: true, job: studio.view(j.id) }); return true }
  if (sub === 'reverse') {
    const pk = typeof h.resolve === 'function' ? h.resolve(body.id) : null
    if (!pk) { send(res, 404, { ok: false, message: '没找到这件家具' }); return true }
    const r = studio.reverse({ id: pk.id, dir: pk.dir, data: pk.data, base: pk.base, installed: pk.base === 'user' })
    send(res, r.code, r.body); return true
  }
  const op = sub.match(/^(furn-[a-f0-9]{6})\/(meta|run|stop|handoff|build|install|delete)$/)
  if (!op) { res.writeHead(404); res.end(); return true }
  const [, id, what] = op
  let r
  if (what === 'meta') { const j = studio.update(id, body); r = j ? { code: 200, body: { ok: true } } : { code: 404, body: { ok: false } } }
  else if (what === 'run') r = studio.run(id, { confirm: body.confirm, redo: body.redo === true })
  else if (what === 'stop') r = studio.stop(id)
  else if (what === 'handoff') r = await studio.handoff(id, { send: body.send === true })
  else if (what === 'build') r = await studio.build(id)
  else if (what === 'install') r = studio.install(id)
  else r = studio.remove(id)
  const v = what === 'delete' ? null : studio.view(id)
  send(res, r.code, v ? { ...r.body, job: v } : r.body)
  return true
}
