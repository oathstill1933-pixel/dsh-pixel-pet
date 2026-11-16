/**
 * Voice on the host side: component install (background, auto on first enable), install status for the
 * settings page, public presets from built-ins and enabled packs, private clones, and DSH STT.
 *
 * The Python side owns the actual transfer (runtime/voice_cli.py install): resumable downloads with
 * sha256 checks, progress written to <data>/models/progress.json. The host only starts it, keeps one
 * running at a time, and reads that file.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enumeratePacks, packedCharacters, readVoicePreset } from './packkit.js'

export const CATALOG_FILE = (root) => join(root, 'runtime', 'pixelpet', 'voice', 'catalog.json')
export const HOTKEYS = ['', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Pause', 'ScrollLock', 'XButton1', 'XButton2', 'RCtrl', 'RAlt']
export const DEFAULT_VOICE = {
  stt: { engine: 'dsh', endpoint: '' },
  tts: { engine: 'qwen', voice: 'whale-girl', custom: { mode: 'http', url: '', command: '', voice: '' } },
  llm: { sessionId: '' },
  hotkey: 'F8',
  interruption: { enabled: true, reply: '嗯，你说' },
  failure: { enabled: true, reply: '糟糕，服务器出现错了，快检查一下配置。' },
}

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/[^\s]*)?$/

export function readCatalog (root) {
  const c = readJson(CATALOG_FILE(root), { components: [] })
  return Array.isArray(c) ? c : (c.components || [])
}

/** Merge a voice patch onto the current voice settings; anything invalid falls back to a safe value. */
export function sanitizeVoice (cur, patch) {
  const base = cur && typeof cur === 'object' ? cur : DEFAULT_VOICE
  const v = patch && typeof patch === 'object' ? patch : {}
  const stt = { ...DEFAULT_VOICE.stt, ...(base.stt || {}), ...(v.stt || {}) }
  const tts0 = { ...DEFAULT_VOICE.tts, ...(base.tts || {}) }
  const tts = { ...tts0, ...(v.tts || {}), custom: { ...DEFAULT_VOICE.tts.custom, ...(tts0.custom || {}), ...((v.tts && v.tts.custom) || {}) } }
  const llm = { ...DEFAULT_VOICE.llm, ...(base.llm || {}), ...(v.llm || {}) }
  if (stt.engine === 'stub') stt.engine = 'dsh'                       // the old placeholder default
  if (!['dsh', 'local-http', 'off'].includes(stt.engine)) stt.engine = 'dsh'
  if (typeof stt.endpoint !== 'string' || !(stt.endpoint === '' || LOOPBACK.test(stt.endpoint))) stt.endpoint = ''
  if (!['qwen', 'custom'].includes(tts.engine)) tts.engine = 'qwen'
  if (typeof tts.voice !== 'string' || !/^(clone-[0-9a-f]{10}|[a-z0-9][a-z0-9-]{0,39})$/.test(tts.voice) || tts.voice === 'default') tts.voice = 'whale-girl'
  const c = tts.custom
  if (!['http', 'command'].includes(c.mode)) c.mode = 'http'
  if (typeof c.url !== 'string' || !(c.url === '' || LOOPBACK.test(c.url))) c.url = ''
  if (typeof c.command !== 'string' || c.command.length > 600 || /[\r\n]/.test(c.command)) c.command = ''
  if (typeof c.voice !== 'string' || c.voice.length > 60) c.voice = ''
  tts.custom = { mode: c.mode, url: c.url, command: c.command, voice: c.voice }
  if (typeof llm.sessionId !== 'string' || llm.sessionId.length > 200) llm.sessionId = ''
  let hotkey = 'hotkey' in v ? v.hotkey : (base.hotkey ?? DEFAULT_VOICE.hotkey)
  if (!HOTKEYS.includes(hotkey)) hotkey = DEFAULT_VOICE.hotkey
  const intr = { ...DEFAULT_VOICE.interruption, ...(base.interruption || {}), ...(v.interruption || {}) }
  const interruption = {
    enabled: typeof intr.enabled === 'boolean' ? intr.enabled : true,
    reply: typeof intr.reply === 'string' ? intr.reply.trim().slice(0, 120) : '嗯，你说',
  }
  const fl = { ...DEFAULT_VOICE.failure, ...(base.failure || {}), ...(v.failure || {}) }
  const failure = {
    enabled: typeof fl.enabled === 'boolean' ? fl.enabled : true,
    reply: typeof fl.reply === 'string' ? fl.reply.trim().slice(0, 120) : DEFAULT_VOICE.failure.reply,
  }
  return { stt: { engine: stt.engine, endpoint: stt.endpoint }, tts: { engine: tts.engine, voice: tts.voice, custom: tts.custom }, llm: { sessionId: llm.sessionId }, hotkey, interruption, failure }
}

// Python json.dumps(sort_keys=True) uses spaces and ASCII escapes by default.
const pythonJson = (v) => {
  if (Array.isArray(v)) return '[' + v.map(pythonJson).join(', ') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => pythonJson(k) + ': ' + pythonJson(v[k])).join(', ') + '}'
  return JSON.stringify(v).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** Byte-compatible with deps.py component_rev; stale CPU markers must not hide a DML upgrade. */
export function dependencyRevision (comp, platform = process.platform) {
  const h = createHash('sha256')
  for (const f of (comp.files || [])) h.update(`${f.path}|${f.sha256}|${f.size}\n`)
  const effective = { ...comp }
  for (const [k, v] of Object.entries(comp.platforms?.[platform] || {})) if (k !== 'platforms' && k !== 'id' && !k.startsWith('_')) effective[k] = v
  for (const p of (effective.packages || [])) h.update(p + '\n')
  if (effective.kind === 'pip') h.update(pythonJson({ installerSchema: 2, conflicts: effective.conflicts || [], want_ep: effective.want_ep || '' }))
  return h.digest('hex').slice(0, 16)
}

/** Installed state per component, including the pinned dependency-policy revision. */
export function depsStatus (root, dataDir) {
  const pylibs = join(dataDir, 'pylibs')
  let pipMarkers = []
  try { pipMarkers = readdirSync(pylibs).flatMap((d) => { try { return readdirSync(join(pylibs, d)).filter((n) => n.startsWith('.installed-')).map((n) => ({ id: n.slice(11), rev: readJson(join(pylibs, d, n), {})?.rev })) } catch { return [] } }) } catch {}
  return readCatalog(root).map((c) => {
    const files = (c.files || []).filter((f) => !f.platform || f.platform === process.platform)
    const dir = c.dest ? join(dataDir, ...String(c.dest).split('/').filter((p) => p && p !== '.')) : join(dataDir, 'models', c.id)
    return {
      id: c.id, kind: c.kind, title: c.title, auto: !!c.auto,
      size: c.kind === 'files' ? files.reduce((n, f) => n + (f.size || 0), 0) : null,
      configured: c.kind === 'pip' ? (c.packages || []).length > 0 : files.length > 0,
      installed: c.kind === 'pip'
        ? pipMarkers.some((m) => m.id === c.id && m.rev === dependencyRevision(c))
        : readJson(join(dir, '.installed'), {})?.rev === dependencyRevision(c),
    }
  })
}

/**
 * Components this installer leaves alone: the Python runtime is prepared by lib/pyruntime.js, which
 * must work before any Python exists, and it reuses a system interpreter when there is one.
 */
export const NOT_HERE = ['python-runtime']

export function readProgress (dataDir) { return readJson(join(dataDir, 'models', 'progress.json'), null) }

/** Public presets from authorized packs and built-ins, followed by local clones. */
export function listVoices (root, dataDir) {
  const out = []
  const dirs = packedCharacters(dataDir)
  const builtin = new Map(enumeratePacks(root, 'character').map((id) => [id, join(root, 'characters', id)]))
  for (const id of new Set([...builtin.keys(), ...dirs.keys()])) {
    for (const dir of [dirs.get(id)?.dir, builtin.get(id)]) {
      if (!dir) continue
      let preset
      try { preset = readVoicePreset(dir) } catch { continue }
      if (!preset) continue
      out.push({ id, name: preset.meta.name, kind: 'preset' })
      break
    }
  }
  let clones = []
  try { clones = readdirSync(join(dataDir, 'voices')).filter((n) => /^clone-[0-9a-f]{10}$/.test(n)).sort() } catch {}
  for (const n of clones) {
    const m = readJson(join(dataDir, 'voices', n, 'voice.json'), null)
    if (m) out.push({ id: n, name: String(m.name || n), kind: 'clone', hasText: !!m.text })
  }
  return out
}

/**
 * One background installer per host. start() is idempotent while a run is active; a failed run leaves the
 * partial files in place, so the next start() (the settings page "重试") resumes them.
 */
export function createInstaller ({ root, dataDir, python, logger, spawn = nodeSpawn, env = process.env }) {
  let child = null
  let last = null // { code, message, at }
  const wanted = () => depsStatus(root, dataDir).filter((d) => d.auto && !NOT_HERE.includes(d.id))
  const status = () => {
    const deps = wanted()
    const pending = deps.filter((d) => !d.installed)
    return {
      running: !!child, ready: pending.length === 0,
      total: deps.reduce((n, d) => n + (d.size || 0), 0),
      deps, progress: readProgress(dataDir), last,
    }
  }
  const start = ({ ids } = {}) => {
    if (child) return { ok: true, running: true }
    const py = python() || 'python'
    const list = ids && ids.length ? ids : wanted().map((d) => d.id)
    if (!list.length) return { ok: true, running: false }
    const args = ['-X', 'utf8', join(root, 'runtime', 'voice_cli.py'), '--data-dir', dataDir, 'install', ...list]
    let out = ''
    try {
      child = spawn(py, args, { windowsHide: true, env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (e) {
      child = null; last = { code: -1, message: '启动 Python 失败', at: Date.now() }
      return { ok: false, message: last.message }
    }
    const me = child
    me.stdout?.on('data', (b) => { out = (out + b).slice(-4000) })
    me.stderr?.on('data', () => {})
    me.on('error', () => { if (child === me) { child = null; last = { code: -1, message: '找不到 Python：' + py, at: Date.now() } } })
    me.on('close', (code) => {
      if (child !== me) return
      child = null
      let r = null; try { r = JSON.parse(out.trim().split('\n').pop()) } catch {}
      last = { code, message: r && !r.ok ? String(r.message || '') : '', at: Date.now() }
      if (code !== 0) logger?.warn?.('[dsh-pixel-pet] 语音组件安装没完成：' + (last.message || ('退出码 ' + code)).slice(0, 200))
    })
    return { ok: true, running: true }
  }
  const stop = () => { if (child) { try { child.kill() } catch {} child = null } }
  return { start, stop, status, get running () { return !!child } }
}

/** wav bytes -> text through DSH's own speech service (voice input bundle), no fallback elsewhere. */
export async function transcribeWithDsh (ctx, wav, { timeoutMs = 60_000 } = {}) {
  let svc = null
  try { svc = (ctx.get && ctx.get('speechToText')) || ctx.speechToText || null } catch { svc = null }
  if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') {
    return { code: 503, body: { ok: false, message: 'DSH 语音输入没开（需要 voice input 组件）' } }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const spec = svc.resolve({ audio: new Uint8Array(wav) })
    const r = await svc.transcribe(spec, ac.signal)
    return { code: 200, body: { ok: true, text: String((r && r.text) || '').trim(), audioSeconds: r && r.audioSeconds, inferenceSeconds: r && r.inferenceSeconds } }
  } catch (e) {
    return { code: 502, body: { ok: false, message: '识别失败：' + String((e && e.message) || e).slice(0, 160) } }
  } finally { clearTimeout(timer) }
}
