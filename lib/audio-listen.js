/** Local file and folder handling for the opt-in audio tool. */
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, normalize, parse, relative, sep, win32 } from 'node:path'

export const AUDIO_DIR_LIMIT = 10
const MAX_PATH = 260
const MAX_BYTES = 100 * 1024 * 1024
const EXTENSIONS = new Set(['.wav', '.flac', '.ogg', '.mp3'])
const windows = process.platform === 'win32'
const comparable = (p) => windows ? p.toLowerCase() : p
const key = (p) => comparable(normalize(p).replace(/[\\/]+$/, ''))
const remote = (p) => /^[\\/]{2}/.test(p)
const traversal = (p) => p.split(/[\\/]/).includes('..')
const hasAbsoluteSyntax = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH
  && !/[\x00-\x1f\x7f]/.test(p) && !remote(p) && isAbsolute(p)
  && (!windows || (/^[a-z]:[\\/]/i.test(p) && !/[:*?"<>|]/.test(p.slice(2))))

function safeDir (path) {
  if (!hasAbsoluteSyntax(path) || traversal(path)) return ''
  const p = normalize(path).replace(/[\\/]+$/, '')
  if (!p || key(path) === key(parse(path).root)) return ''
  if (windows) {
    const flat = win32.normalize(p)
    if (/^[a-z]:\\users(?:\\[^\\]+)?$/i.test(flat)
      || /^[a-z]:\\users\\[^\\]+\\\.dsh$/i.test(flat)) return ''
  }
  const profile = process.env.USERPROFILE || homedir()
  if (key(p) === key(profile) || key(p) === key(normalize(profile + sep + '.dsh'))) return ''
  return p
}

export function sanitizeAudioDirs (list) {
  const entries = new Map()
  for (const path of Array.isArray(list) ? list : []) {
    const dir = safeDir(path)
    if (dir && !entries.has(key(dir))) entries.set(key(dir), dir)
    if (entries.size >= AUDIO_DIR_LIMIT) break
  }
  return [...entries.values()]
}

/** Persist the selected directory's canonical path so a later junction replacement cannot grant access. */
export function resolveAudioDir (value) {
  const p = safeDir(value)
  if (!p) return ''
  try {
    const dir = safeDir(realpathSync.native(p))
    return dir && statSync(dir).isDirectory() ? dir : ''
  } catch { return '' }
}

const inside = (root, target) => {
  const rel = relative(root, target)
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

export const AUDIO_ERRORS = Object.freeze({
  no_dirs: '先请用户在设置 → 一起听歌里添加允许读取的文件夹。',
  outside: '这个文件夹没被允许，请用户在设置 → 一起听歌里添加。',
  unsupported: '这个格式还听不了，目前支持 WAV、FLAC、OGG 和 MP3。',
  not_found: '找不到这个音频文件，请核对文件名和路径。',
  too_big: '这个音频文件超过 100 MB。',
  bad_path: '请给我一个本机音频文件的绝对路径。',
})

export function checkAudioPath (value, dirs) {
  const error = (code) => ({ ok: false, code, message: AUDIO_ERRORS[code] })
  const allowed = sanitizeAudioDirs(dirs)
  if (!allowed.length) return error('no_dirs')
  if (typeof value === 'string' && (remote(value) || traversal(value))) return error('outside')
  if (!hasAbsoluteSyntax(value)) return error('bad_path')
  if (!EXTENSIONS.has(extname(value).toLowerCase())) return error('unsupported')
  const input = normalize(value)
  const roots = allowed.filter((root) => key(root) === key(resolveAudioDir(root)))
  if (!roots.length) return error('outside')
  try {
    const path = realpathSync.native(input)
    if (!roots.some((root) => inside(root, path))) return error('outside')
    if (!EXTENSIONS.has(extname(path).toLowerCase())) return error('unsupported')
    const info = statSync(path)
    if (!info.isFile()) return error('not_found')
    if (info.size > MAX_BYTES) return error('too_big')
    return { ok: true, path, file: basename(input) }
  } catch (err) {
    const missing = err?.code === 'ENOENT' || err?.code === 'ENOTDIR'
    return error(missing && roots.some((root) => inside(root, input)) ? 'not_found' : 'outside')
  }
}

export function pickFolderWindows ({ spawnFn = spawn, timeoutMs = 10 * 60_000 } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.ShowNewFolderButton = $false',
    '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}',
    'try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress -InputObject $dialog.SelectedPath } } finally { $dialog.Dispose(); $owner.Dispose() }',
  ].join('; ')
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { resolve(null); return }
    let out = ''
    const finish = (result) => { clearTimeout(timer); resolve(result) }
    const timer = setTimeout(() => { try { child.kill() } catch {} finally { finish(null) } }, timeoutMs)
    timer.unref?.()
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', (part) => { if (out.length < 8192) out += part })
    child.on('error', () => finish(null))
    child.on('close', () => {
      try { const path = JSON.parse(out.trim()); finish(typeof path === 'string' ? path : null) } catch { finish(null) }
    })
  })
}

const NUMBER_TEXT = /^[A-G][#♭-]?\d{1,2}$/
const GROUPS = ['mood', 'genre', 'inst', 'kind']
const TAG_NAME = /^[\p{L}\p{N} &-]{1,30}$/u
const SCOPE = '只描述声学特征，不转写说话内容。'
const withScope = (s) => s.includes('不转写说话内容') ? s : s + SCOPE

function cleanSentence (text, ...paths) {
  let safe = typeof text === 'string' ? text.slice(0, 1200) : ''
  for (const path of paths) {
    for (const form of [path, path.replace(/\\/g, '/'), path.replace(/\//g, '\\')]) {
      if (form) safe = safe.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), windows ? 'gi' : 'g'), '')
    }
  }
  return withScope(safe || '已分析声学特征。')
}

export async function analyzeLocalAudio (value, dirs, call, { timeoutMs = 60_000 } = {}) {
  const checked = checkAudioPath(value, dirs)
  if (!checked.ok) return checked
  let timer
  try {
    // The service reply can arrive after the tool's deadline; keep it running to populate its cache.
    const reply = await Promise.race([
      call('control', { action: 'analyze_file', value: { path: checked.path } }, 20 * 60_000),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) }),
    ])
    if (!reply || reply.error?.code === 'timeout') {
      return { ok: false, code: 'timeout', file: checked.file, message: '还在分析，过一会儿再问一次。' }
    }
    const d = reply.data
    if (reply.ok !== true || d?.ok !== true || !Number.isFinite(d.seconds) || !['short', 'full'].includes(d.kind)) {
      const code = ['too_short', 'too_big', 'busy', 'unsupported', 'not_found', 'outside', 'unavailable'].includes(d?.code)
        ? d.code : 'analysis_failed'
      const messages = { too_short: '这段音频太短了，听不出东西。', busy: '正在分析另一段音频，请稍后再试。',
        unavailable: '当前音乐服务缺少音频分析组件。', analysis_failed: '没能分析这段音频，请确认音乐服务可用且文件能正常解码。' }
      return { ok: false, code, file: checked.file, message: messages[code] || AUDIO_ERRORS[code] }
    }
    const numbers = {}
    for (const [k, v] of Object.entries(d.numbers || {})) {
      if (/^[a-z][a-z0-9_]{0,35}$/.test(k) && (Number.isFinite(v) || (/^pitch_(low_|high_)?note$/.test(k) && typeof v === 'string' && NUMBER_TEXT.test(v)))) numbers[k] = v
    }
    const tags = {}
    for (const g of GROUPS) {
      if (!Array.isArray(d.tags?.[g])) continue
      const rows = d.tags[g].slice(0, 2).filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && TAG_NAME.test(p[0]) && Number.isFinite(p[1]) && p[1] >= 0 && p[1] <= 1)
      if (rows.length) tags[g] = rows
    }
    return { ok: true, file: checked.file, seconds: d.seconds, kind: d.kind,
      sentence: cleanSentence(d.sentence, checked.path, value, dirname(checked.path), dirname(value)),
      numbers, tags: Object.keys(tags).length ? tags : null, truncated: d.truncated === true }
  } catch {
    return { ok: false, code: 'analysis_failed', file: checked.file, message: '没能分析这段音频，请检查音乐服务。' }
  } finally { clearTimeout(timer) }
}
