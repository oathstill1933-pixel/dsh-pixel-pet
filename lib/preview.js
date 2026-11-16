/**
 * Settings page "动作" grid: every state of a character with its frames and timing, plus the control
 * command that makes the desktop pet act it out (pose / mood only — states without one are preview-only).
 *
 *   GET  /api/preview?id=<character>          -> { ok, id, name, states: [{ id, label, frames, durationsMs, loop, play }] }
 *   GET  /api/frame/<character>/<state>/<n>    -> png
 *   POST /api/preview/play { id, state }       -> the pet's reply to that pose / mood command
 */
import { join, resolve, sep } from 'node:path'
import { packFrame } from './packs.js'
import { resolveOne } from './packkit.js'

const STATE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/
const POSES = { idle: 'sit', lie: 'lie', waving: 'wave', jumping: 'jump' }

/** built-in pack first, then one "+ 新建角色" installed into <data>/characters */
const ZH = { idle: '待机', 'walk-left': '向左走', 'walk-right': '向右走', 'drag-left': '向左拖', 'drag-right': '向右拖', waving: '招手', jumping: '跳', failed: '出错', waiting: '等待', running: '工作中', review: '检查', lie: '躺下', listening: '在听', attentive: '注意', 'curl-sleep': '睡觉', speaking: '说话', 'mood-happy': '开心', 'mood-surprised': '惊讶', 'mood-confused': '疑惑', 'mood-thinking': '思考', 'mood-sleepy': '困', 'mood-sad': '委屈', 'mood-oops': '闯祸' }

export function loadCharacter (root, dataDir, id) {
  // M0 起走 packkit 统一分层：严格有效的用户层优先，无效用户层回退内置层；只对骨架包兜底展示。
  // 之前这里自设的"states 是对象就行"弱校验是各读各的目录的最后一处，已淘汰。
  const pk = resolveOne({ pluginRoot: root, dataDir, kind: 'character', id })
  return pk && pk.data ? { dir: pk.dir, data: pk.data } : null
}

/** state -> control command body, or null when pose / mood cannot reach it */
export function playCommand (data, state) {
  const st = data && data.states && data.states[state]
  if (!st || st.requires?.feature === 'listen') return null
  const total = (Array.isArray(st.durationsMs) ? st.durationsMs : []).reduce((a, b) => a + (Number(b) || 0), 0)
  const tag = Object.entries(data.moods || {}).find(([, v]) => v === state)
  if (tag) return { cmd: 'mood', tag: tag[0], seconds: Math.max(3, Math.min(10, Math.round(total * 2 / 1000))) }
  if (POSES[state]) return { cmd: 'pose', name: POSES[state], ...(state === 'lie' ? { holdMs: 4000 } : {}) }
  if (state.startsWith('mood-')) return { cmd: 'pose', name: state.slice(5), holdMs: Math.max(3000, Math.min(10000, total * 2)) }
  if (state.startsWith('act-')) return { cmd: 'pose', name: state, holdMs: Math.max(3000, Math.min(10000, total * 2)) }
  return null
}

export function previewOf (root, dataDir, id) {
  const c = loadCharacter(root, dataDir, id)
  if (!c) return null
  const states = []
  for (const [sid, st] of Object.entries(c.data.states)) {
    if (!STATE_RE.test(sid) || !st || !Array.isArray(st.frames) || !st.frames.length) continue
    const n = st.frames.length
    const d = Array.isArray(st.durationsMs) ? st.durationsMs : []
    states.push({
      id: sid, label: String(st.label || ZH[sid] || sid).slice(0, 24), frames: n,
      durationsMs: Array.from({ length: n }, (_, i) => Math.max(40, Math.min(5000, Number(d[i]) || 150))),
      loop: st.loop !== false, play: playCommand(c.data, sid),
      ...(st.requires?.feature === 'listen' ? { requires: { feature: 'listen' } } : {}),
    })
  }
  return { id, name: String(c.data.name || id), states }
}

export function frameFile (root, dataDir, id, state, idx) {
  if (!STATE_RE.test(String(state || '')) || !/^\d{1,3}$/.test(String(idx))) return null
  const c = loadCharacter(root, dataDir, id)
  const st = c && c.data.states[state]
  const rel = st && Array.isArray(st.frames) ? st.frames[Number(idx)] : null
  return typeof rel === 'string' && /\.png$/i.test(rel) ? packFrame(c.dir, rel) : null
}
