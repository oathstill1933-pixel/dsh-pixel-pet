/**
 * 「一起听歌」v2 宿主桥（docs/MUSIC_CONTRACT.md）。
 *
 *   web/card.*  ──HTTP──>  /api/music/*  ──JSON 行 stdio──>  python -m pixelmusic（runtime/music/）
 *
 * - 只在 settings.listen.enabled === true 时工作；关掉立即停服务（释放录音/播放设备），API 409。
 * - 服务按需拉起（卡片轮询或工具调用），空闲 60 s 退出。
 * - Python：settings.listen.python → <dataDir>/listen.json 的 python → 未配置。源码不写死任何本机路径。
 * - 不外泄本地路径：快照里只有歌名/歌手；封面经 /api/music/cover 转发。
 *
 * Routes（/api/* 仅同源）：
 *   GET  /api/music/now       统一快照
 *   GET  /api/music/live      position / playing / lyric.index / spectrum.bars
 *   GET  /api/music/cover?v=  当前云端封面
 *   GET  /api/music/chat?after=seq
 *   GET  /api/music/local     已登记的本地歌曲（只有序号/歌名/歌手）
 *   POST /api/music/control   { action, value? }（volume 0-100；mode list|one|shuffle）
 *   POST /api/music/chat      { text } -> { ok, reply }（等会话回复；对话记录 role: user | pet）
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs' // 「听得更细」安装/开关用 fs.xxx
import { createRequire as _createRequire } from 'node:module'

const REQUIRE = _createRequire(import.meta.url)
const https = REQUIRE('node:https')
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clapDirOf, purge } from './purge.js'
import { AUDIO_DIR_LIMIT, analyzeLocalAudio, checkAudioPath, pickFolderWindows, resolveAudioDir, sanitizeAudioDirs } from './audio-listen.js'

export const LISTEN_DEFAULT = { enabled: false, python: '', clap: false, clapMirror: '', uv: '', audioDirs: [] } // uv 留空 = 自动找 venv/PATH/uv → pip（review 10）
const PY_MAX = 260
const IDLE_MS = 60_000
const CALL_MS = 8_000
const CHAT_MAX = 120
const BARS = 48
const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'music')
export const MUSIC_ACTIONS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'volume', 'seek', 'source', 'open_link', 'local_add', 'local_play', 'mode', 'play_song'])
export const MUSIC_MODES = ['list', 'one', 'shuffle']
const LINK_RE = /^(orpheus:\/\/|qqmusic:\/\/|https:\/\/music\.163\.com\/|https:\/\/y\.qq\.com\/)/

export function sanitizeListen (cur, patch) {
  const base = { ...LISTEN_DEFAULT, ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}) }
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  if (typeof p.enabled === 'boolean') base.enabled = p.enabled
  if (typeof p.python === 'string') base.python = p.python
  if (typeof p.clap === 'boolean') base.clap = p.clap
  if (typeof p.clapMirror === 'string') base.clapMirror = p.clapMirror.replace(/[\u0000-\u001f\s]/g, '').slice(0, 200)
  if (typeof p.uv === 'string') base.uv = p.uv.replace(/[\u0000-\u001f]/g, '').trim().slice(0, PY_MAX)
  return {
    enabled: base.enabled === true,
    python: typeof base.python === 'string' ? base.python.replace(/[\u0000-\u001f]/g, '').trim().slice(0, PY_MAX) : '',
    clap: base.clap === true,
    clapMirror: typeof base.clapMirror === 'string' ? base.clapMirror : '',
    uv: typeof base.uv === 'string' ? base.uv : '',
    audioDirs: sanitizeAudioDirs('audioDirs' in p ? p.audioDirs : base.audioDirs),
  }
}

export const listenOn = (s) => !!(s && s.listen && s.listen.enabled === true)

export function resolvePython ({ settings, dataDir, exists = existsSync } = {}) {
  const fromSettings = settings && settings.listen && typeof settings.listen.python === 'string' ? settings.listen.python.trim() : ''
  let fromFile = ''
  try { const j = JSON.parse(readFileSync(join(dataDir, 'listen.json'), 'utf8')); if (j && typeof j.python === 'string') fromFile = j.python.trim() } catch {}
  const python = [fromSettings, fromFile].find((p) => p && exists(p)) || ''
  return { python, ok: !!python }
}

/** One long-lived `python -m pixelmusic` child, JSON lines both ways. */
// ---- 「听得更细」（CLAP，可选组件，默认关）----
// 模型 laion/clap-htsat-unfused（Apache-2.0，614.5 MB；larger_clap_music 的 HF 转换版实测不可用，已换）：依赖装进 pye-music venv（uv），
// 权重 ~782 MB 从 Hugging Face 下载（可配镜像）。构建时文本端只跑一次（标签向量落盘）；
// 运行时用 torch CPU 加载音频端（onnx 导出留给后续，见 clap.py）。只存模型与标签，绝不落盘音频。
const CLAP_MODEL_ID = 'laion/clap-htsat-unfused'
// 2026-11-15 核实（HF API tree/main）：仓库只有 pytorch_model.bin（没有 model.safetensors），
// LFS = sha256 5c289311f4a030d7…4fd1 / 776444665 字节；resolve 直连可达（307→api/resolve-cache，302→CDN），
// CDN 支持 Range（实测 206）。文件清单按实际仓库写。
const CLAP_LARGE = { file: 'pytorch_model.bin', size: 614525833, sha256: '1cd3c601bc4afe0fa87be3de4c13dd2cfadd249fac1e29acf74a9b296c3219bb' }
const CLAP_SMALL = ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'special_tokens_map.json', 'vocab.json', 'merges.txt']
const CLAP_FILES = [...CLAP_SMALL, CLAP_LARGE.file]
const clapState = { step: '', message: '', done: 0, total: 0, running: false, startedAt: 0, error: '', finishedAt: 0, files: {} }

/** pye-music/models/clap（PIXELPET_CLAP_DIR 可改到别处，测试用；每次现取，改环境变量立刻生效） */
function clapDir () { return clapDirOf() }
function clapFlagFile (dataDir) { return join(dataDir, 'music', 'clap.json') }
function readClapFlag (dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(clapFlagFile(dataDir), 'utf8'))
    return { enabled: j.enabled === true, mirror: typeof j.mirror === 'string' ? j.mirror : '' }
  } catch { return { enabled: false, mirror: '' } }
}
function writeClapFlag (dataDir, obj) {
  mkdirSync(dirname(clapFlagFile(dataDir)), { recursive: true })
  fs.writeFileSync(clapFlagFile(dataDir), JSON.stringify(obj), 'utf8')
}
function clapReady (dir = clapDir()) {
  try {
    return fs.existsSync(join(dir, 'label_emb.npy')) && fs.existsSync(join(dir, 'labels_meta.json')) &&
      fs.existsSync(join(dir, 'hf', 'config.json'))
  } catch { return false }
}
function hfUrl (mirror, file) {
  const base = mirror ? String(mirror).replace(/\/+$/, '') : 'https://huggingface.co'
  return base + '/' + CLAP_MODEL_ID + '/resolve/main/' + file
}
/**
 * https GET（手工跟重定向，最多 5 跳、只跟 https）。
 * review 修复 11：连接/响应 30 秒、无数据 30 秒都算失败，避免大文件卡死。
 * headers 可带 Range 断点续传。-> res（200 或 206）
 */
function hfOpen (url, { headers = {}, connectMs = 30_000, idleMs = 30_000, hops = 5 } = {}) {
  return new Promise((ok, bad) => {
    let u = url
    let n = 0
    const go = () => {
      if (++n > hops) return bad(new Error('重定向次数太多'))
      let req
      try { req = https.get(u, { headers }, (res) => { handle(res) }) } catch (e) { return bad(e) }
      req.setTimeout(connectMs, () => req.destroy(new Error('连接超时')))
      req.on('error', bad)
    }
    const handle = (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, u)
        if (next.protocol !== 'https:') return bad(new Error('重定向到了非 https'))
        u = next.href
        return go()
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume()
        return bad(new Error('HTTP ' + res.statusCode))
      }
      // 下载期间只要 30 秒没有新数据就判失败（不是整体超时：大文件允许慢慢下）
      res.setTimeout(idleMs, () => res.destroy(new Error('30 秒没收到数据')))
      ok(res)
    }
    go()
  })
}

/** 只允许删/写在 ...pye-music\models\clap\hf\ 之下的文件（review 约束） */
function assertUnderClapHf (file) {
  const root = join(clapDir(), 'hf') + sep
  const full = resolve(file)
  if (!full.startsWith(resolve(root))) throw new Error('拒绝操作模型目录之外的文件')
  return full
}

export class MusicBridge {
  constructor ({ resolve, dataDir, spawnFn = nodeSpawn, idleMs = IDLE_MS, cwd = RUNTIME_DIR, preStart = null } = {}) {
    this.resolve = resolve
    this.dataDir = dataDir
    this.preStart = preStart
    this.spawnFn = spawnFn
    this.idleMs = idleMs
    this.cwd = cwd
    this.child = null
    this.seq = 0
    this.pending = new Map()
    this.analysis = new Set()
    this.buf = ''
    this.idle = null
    this.starts = 0
  }

  get running () { return !!this.child }

  _start () {
    const p = this.resolve()
    if (!p.ok) return false
    try { if (typeof this.preStart === 'function') this.preStart() } catch {}  // 起服务前把开关状态落盘（review 修复 9）
    const child = this.spawnFn(p.python, ['-X', 'utf8', '-m', 'pixelmusic', '--data-dir', this.dataDir], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    this.starts++
    this.child = child
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', (d) => this._data(String(d)))
    const gone = () => {
      if (this.child !== child) return
      this.child = null
      for (const [, w] of this.pending) w({ ok: false, error: { code: 'service_exit', message: '音乐服务退出' } })
      this.pending.clear()
    }
    child.on('exit', gone)
    child.on('error', gone)
    child.stdin.on?.('error', () => {})
    return true
  }

  _data (s) {
    this.buf += s
    if (this.buf.length > 8 * 1024 * 1024) this.buf = ''
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const w = this.pending.get(msg.id)
      if (w) { this.pending.delete(msg.id); w(msg) }
    }
  }

  _touch () {
    clearTimeout(this.idle)
    if (!this.child || this.analysis.size) return
    this.idle = setTimeout(() => this.stop(), this.idleMs)
    this.idle.unref?.()
  }

  call (command, args = {}, timeoutMs = CALL_MS) {
    if (!this.child && !this._start()) return Promise.resolve({ ok: false, error: { code: 'not_configured', message: '没有配置音乐服务的 Python（设置 listen.python）' } })
    const id = ++this.seq
    if (command === 'control' && args.action === 'analyze_file') this.analysis.add(id)
    this._touch()
    return new Promise((done) => {
      const finish = (reply) => {
        this.pending.delete(id)
        clearTimeout(timer)
        if (this.analysis.delete(id)) this._touch()
        done(reply)
      }
      const timer = setTimeout(() => finish({ ok: false, error: { code: 'timeout', message: '音乐服务响应超时' } }), timeoutMs)
      this.pending.set(id, finish)
      try { this.child.stdin.write(JSON.stringify({ id, command, args }) + '\n') } catch {
        finish({ ok: false, error: { code: 'write', message: '写入音乐服务失败' } })
      }
    })
  }

  stop () {
    clearTimeout(this.idle)
    const c = this.child
    this.child = null
    for (const [, w] of this.pending) w({ ok: false, error: { code: 'stopped', message: '音乐服务已停止' } })
    this.pending.clear()
    if (c) {
      try { c.stdin.write(JSON.stringify({ id: 0, command: 'shutdown' }) + '\n'); c.stdin.end() } catch {}
      const t = setTimeout(() => { try { c.kill() } catch {} }, 1500); t.unref?.()
    }
  }
}

const clock = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }

export function chatPrompt (text, snap) {
  const lines = ['[一起听歌] 用户在桌宠的听歌小卡片里对你说：', text, '']
  const t = snap && snap.track
  if (t && t.title) {
    lines.push('正在听：《' + t.title + '》' + (t.artist ? ' — ' + t.artist : '') + '（' + clock(snap.position) + (t.duration ? ' / ' + clock(t.duration) : '') + (snap.playing ? '，播放中' : '，暂停') + '）')
    if (snap.lyric && snap.lyric.available && snap.lyric.line) lines.push('当前歌词：' + snap.lyric.line)
    if (snap.heard && snap.heard.available && snap.heard.sentence) lines.push(snap.heard.sentence)
  } else lines.push('（现在没有在放歌。）')
  lines.push('——', '直接用文字回复，回复会显示在听歌小卡片的气泡里。')
  return lines.join('\n')
}

const EMPTY_WINDOW = { before: [], current: '', after: [] }
const EMPTY_LYRIC = { available: false, index: -1, line: '', next: '', window: EMPTY_WINDOW }
const strs = (a) => (Array.isArray(a) ? a.slice(0, 2).map((x) => String(x || '').slice(0, 300)) : [])
export function shapeWindow (w) {
  if (!w || typeof w !== 'object') return { ...EMPTY_WINDOW }
  return { before: strs(w.before), current: String(w.current || '').slice(0, 300), after: strs(w.after) }
}
const vol = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))))

/** service `now` data -> contract snapshot (no paths, no internals) */
export function shapeSnapshot (d, { enabled = true, daily = null, configured = true, reason = '' } = {}) {
  const src = d && ['cloud', 'local', 'none'].includes(d.source) ? d.source : 'none'
  const t = d && d.track
  const cap = (d && d.capabilities) || {}
  const lyric = d && d.lyric && d.lyric.available
    ? { available: true, index: Number(d.lyric.index) | 0, line: String(d.lyric.line || ''), next: String(d.lyric.next || ''), window: shapeWindow(d.lyric.window) }
    : EMPTY_LYRIC
  const bars = d && d.spectrum && Array.isArray(d.spectrum.bars) ? d.spectrum.bars.slice(0, BARS).map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : new Array(BARS).fill(0)
  const heard = d && d.heard && d.heard.available && d.heard.sentence
    ? { available: true, sentence: String(d.heard.sentence), engine: d.heard.engine === 'librosa' ? 'librosa' : 'numpy' }
    : { available: false, sentence: '', engine: d && d.heard && d.heard.engine === 'librosa' ? 'librosa' : 'numpy' }
  const out = {
    ok: true,
    enabled,
    configured,
    source: src,
    app: src === 'cloud' && ['netease', 'qqmusic', 'other'].includes(d.app) ? d.app : null,
    playing: !!(d && d.playing),
    track: t ? {
      title: String(t.title || ''), artist: String(t.artist || ''), album: String(t.album || ''),
      duration: Number.isFinite(Number(t.duration)) && t.duration != null ? Number(t.duration) : null,
      cover: typeof t.cover === 'string' && /^[0-9a-f]{6,40}$/.test(t.cover) ? '/api/music/cover?v=' + t.cover : null,
    } : null,
    position: Math.max(0, Number(d && d.position) || 0),
    lyric,
    spectrum: { available: !!(d && d.spectrum && d.spectrum.available), bars },
    heard,
    daily: daily || null,
    volume: d ? vol(d.volume) : null,
    mode: d && MUSIC_MODES.includes(d.mode) ? d.mode : null,
    capabilities: { seek: !!cap.seek, playSpecific: !!cap.playSpecific, loopback: !!cap.loopback, volume: !!cap.volume, mode: !!cap.mode },
    prefer: d && ['auto', 'cloud', 'local'].includes(d.prefer) ? d.prefer : 'auto',
    local: { count: Number(d && d.local && d.local.count) || 0, index: d && d.local && Number.isInteger(d.local.index) ? d.local.index : -1 },
  }
  // 网易云能点播（play_song：搜歌 + orpheus:// 链接，2026-11-15），能力表照实写 true，别让 AI 以为放不了指定的歌
  if (out.app === 'netease') out.capabilities.playSpecific = true
  if (d && Array.isArray(d.energy) && d.energy.length) out.energy = d.energy.slice(0, 256).map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
  if (d && ['smtc', 'estimated', 'player'].includes(d.position_source)) out.position_source = d.position_source
  if (d && typeof d.loopback_error === 'string' && /^[A-Za-z_]{1,40}$/.test(d.loopback_error)) out.loopback_error = d.loopback_error
  if (reason) out.reason = reason
  return out
}

/** Windows 文件选择框（用户显式选择）。返回绝对路径数组；取消 → []。 */
export function pickFilesWindows ({ spawnFn = nodeSpawn, timeoutMs = 10 * 60_000 } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Multiselect = $true',
    "$d.Title = '添加本地歌曲'",
    "$d.Filter = '音频 (*.mp3;*.flac;*.wav;*.ogg)|*.mp3;*.flac;*.wav;*.ogg'",
    '$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}',
    'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress @($d.FileNames) }',
  ].join('; ')
  return new Promise((resolve) => {
    let out = ''
    let child
    try { child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { resolve([]); return }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs); timer.unref?.()
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); resolve([]) })
    child.on('exit', () => {
      clearTimeout(timer)
      try { const v = JSON.parse(out.trim() || '[]'); resolve((Array.isArray(v) ? v : [v]).filter((p) => typeof p === 'string')) } catch { resolve([]) }
    })
  })
}

// ---- 网易云点播（用网易云网页版搜索接口 + 客户端 orpheus:// 链接，非公开接口，改版可能失效）
//   1. 搜歌：GET music.163.com/api/search/get/web，只发「歌名 歌手」，不带任何用户信息
//   2. 播放：orpheus://<base64 {"type":"song","id":"…","cmd":"play"}>，客户端注册的协议，打开即播
//   挑歌按「歌名 + 歌手」都对上才算准；对不上就把候选交给 AI，让它先问用户，绝不瞎放。
const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web'
const normSong = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
export async function neteaseSearch (query, { fetchImpl = globalThis.fetch, timeoutMs = 8000, limit = 10 } = {}) {
  const q = String(query ?? '').trim().slice(0, 120)
  if (!q || typeof fetchImpl !== 'function') return []
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, timeoutMs)
  try {
    const url = NETEASE_SEARCH + '?' + new URLSearchParams({ s: q, type: '1', offset: '0', limit: String(limit) })
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Accept: 'application/json' } })
    if (!res || !res.ok) return []
    const j = await res.json()
    const songs = (j && j.result && Array.isArray(j.result.songs)) ? j.result.songs : []
    return songs.slice(0, limit).map((s) => ({
      id: String(s.id ?? ''),
      title: String(s.name ?? '').slice(0, 120),
      artists: (Array.isArray(s.artists) ? s.artists : []).map((a) => String((a && a.name) ?? '').slice(0, 60)).filter(Boolean),
      album: String((s.album && s.album.name) ?? '').slice(0, 120),
      vip: s.fee === 1 || s.fee === 4,
    })).filter((s) => /^\d{1,20}$/.test(s.id) && s.title)
  } catch { return [] } finally { clearTimeout(timer) }
}
/** 歌名规范化后相等；给了歌手就必须有一位歌手对上（包含即可，兼容「YOASOBI / Ayase」这种） */
export function pickNeteaseSong (list, { title, artist } = {}) {
  const t = normSong(title)
  const a = normSong(artist)
  if (!t) return { pick: null, candidates: [] }
  const sameTitle = (list || []).filter((s) => normSong(s.title) === t)
  // 给了歌手：歌名对上、且有一位歌手对上，取第一个（搜索结果原曲通常排前面）。
  // 没给歌手：同名只有一首才放；同名好几首（原曲 + 翻唱）就不猜，交给 AI 去问用户。
  const withArtist = a ? sameTitle.filter((s) => s.artists.some((x) => { const n = normSong(x); return n && (n === a || n.includes(a) || a.includes(n)) })) : []
  const pick = a ? (withArtist[0] || null) : (sameTitle.length === 1 ? sameTitle[0] : null)
  return { pick, candidates: (list || []).slice(0, 5).map((s) => ({ title: s.title, artist: s.artists.join(' / '), album: s.album })) }
}
export const neteasePlayUrl = (id) => 'orpheus://' + Buffer.from(JSON.stringify({ type: 'song', id: String(id), cmd: 'play' }), 'utf8').toString('base64')

/** orpheus:// 点播链接要用系统的协议处理器打开：2026-11-15 实测 explorer.exe 收到这个链接什么都不做，
 *  rundll32 url.dll,FileProtocolHandler 才会交给网易云（PowerShell 的 Start-Process 也走这条）。 */
function openProtocol (url, spawnFn = nodeSpawn) {
  try { const c = spawnFn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }); c.on?.('error', () => {}); c.unref?.(); return true } catch { return false }
}

function openExternal (url, spawnFn = nodeSpawn) {
  try { const c = spawnFn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }); c.on?.('error', () => {}); c.unref?.(); return true } catch { return false }
}

export function createMusic ({
  dataDir, settings, relay, logger, daily = null, bridge = null,
  pickFiles = null, pickAudioFolder = null, changeAudioDirs = null, openLink = null, watchMs = 1500, spawnFn = nodeSpawn, exists = existsSync,
  fetchImpl = globalThis.fetch, playWaitMs = 4000,
} = {}) {
  const br = bridge || new MusicBridge({ resolve: () => resolvePython({ settings: settings(), dataDir, exists }), dataDir, spawnFn, preStart: () => syncClapFlag() })
  const enabled = () => listenOn(settings())
  const chat = []
  let seq = 0
  let busy = false
  let cover = null // { v, mime, buf }
  const consentFile = join(dataDir || '.', 'music', 'consent.json')
  const consent = () => { try { return JSON.parse(readFileSync(consentFile, 'utf8')) || {} } catch { return {} } }
  const grant = (k) => { try { mkdirSync(dirname(consentFile), { recursive: true }); writeFileSync(consentFile, JSON.stringify({ ...consent(), [k]: true })) } catch {} }

  // 开关关闭 → 立即停服务（释放录音/播放设备）
  const watch = setInterval(() => { if (br.running && !enabled()) br.stop() }, watchMs)
  watch.unref?.()

  const call = async (command, args, ms) => (await br.call(command, args, ms)) || { ok: false, error: { code: 'empty' } }
  const dailyToday = () => { try { return (daily && daily.today && daily.today()) || null } catch { return null } }

  async function now () {
    if (!enabled()) { br.stop(); return shapeSnapshot(null, { enabled: false, daily: null }) }
    const r = await call('now', { bars: BARS }, 6000)
    if (!r.ok) {
      const code = r.error && r.error.code
      return shapeSnapshot(null, { enabled: true, configured: code !== 'not_configured', daily: dailyToday(), reason: (r.error && r.error.message) || '' })
    }
    const snap = shapeSnapshot(r.data, { enabled: true, daily: null })
    try { daily && daily.observe && Promise.resolve(daily.observe(snap)).catch(() => {}) } catch {}
    snap.daily = dailyToday()
    return snap
  }

  async function live () {
    if (!enabled()) return { ok: false, enabled: false }
    const r = await call('live', { bars: BARS }, 2500)
    if (!r.ok) return { ok: true, connected: false, playing: false, position: 0, lyric: { index: -1, window: shapeWindow(null) }, spectrum: { available: false, bars: new Array(BARS).fill(0) } }
    const d = r.data || {}
    const bars = Array.isArray(d.spectrum && d.spectrum.bars) ? d.spectrum.bars.slice(0, BARS).map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : new Array(BARS).fill(0)
    return { ok: true, connected: true, source: d.source || 'none', playing: !!d.playing, playback: d.playback || (d.playing ? 'playing' : d.source && d.source !== 'none' ? 'paused' : 'off'), position: Math.max(0, Number(d.position) || 0), lyric: { index: Number(d.lyric && d.lyric.index) | 0, window: shapeWindow(d.lyric && d.lyric.window) }, spectrum: { available: !!(d.spectrum && d.spectrum.available), bars } }
  }

  const listenFile = async (path, options) => {
    const disabled = { ok: false, code: 'disabled', message: '「一起听歌」没有打开。' }
    if (!enabled()) return disabled
    const r = await analyzeLocalAudio(path, settings().listen?.audioDirs, call, options)
    if (!r.ok) return r
    if (!enabled()) return disabled
    const allowed = checkAudioPath(path, settings().listen?.audioDirs)
    return allowed.ok ? r : allowed
  }
  let choosingFolder = false
  async function editAudioDirs (op, body) {
    if (!changeAudioDirs) return { ok: false, message: '当前设置页无法保存文件夹。' }
    if (op === 'audio-dirs/remove') {
      const dirs = changeAudioDirs((current) => current.filter((p) => p !== body?.dir))
      return dirs ? { ok: true, audioDirs: dirs } : { ok: false, message: '「一起听歌」没有打开。' }
    }
    if (choosingFolder) return { ok: false, message: '文件夹选择窗口已经打开。' }
    choosingFolder = true
    try {
      const chosen = await (pickAudioFolder || (() => pickFolderWindows({ spawnFn })))()
      if (!chosen) return { ok: true, cancelled: true }
      const dir = resolveAudioDir(chosen)
      if (!dir) return { ok: false, message: '请选择一个可用的本机文件夹。' }
      const dirs = changeAudioDirs((current) => sanitizeAudioDirs([...current, dir]))
      if (!dirs) return { ok: false, message: '「一起听歌」没有打开。' }
      if (!dirs.some((p) => sanitizeAudioDirs([p, dir]).length === 1)) {
        return { ok: false, message: '最多允许 ' + AUDIO_DIR_LIMIT + ' 个文件夹。' }
      }
      return { ok: true, audioDirs: dirs }
    } finally { choosingFolder = false }
  }

  const bad = (message) => ({ code: 400, body: { ok: false, message } })

  /** -> { code, body }；user=true 表示来自卡片上的用户点击（可做首次授权、可弹文件框） */
  async function control (body, { user = false } = {}) {
    if (!enabled()) return { code: 409, body: { ok: false, code: 'disabled', message: '「一起听歌」没有打开' } }
    const action = String(body && body.action || '')
    if (!MUSIC_ACTIONS.has(action)) return bad('不支持的操作')
    let value = body ? body.value : undefined
    if (action === 'volume') { const v = Math.round(Number(value)); if (!Number.isFinite(v)) return bad('音量要 0-100'); value = Math.max(0, Math.min(100, v)) }
    if (action === 'seek') { const v = Number(value); if (!Number.isFinite(v) || v < 0) return bad('进度不对'); value = v }
    if (action === 'source' && !['auto', 'cloud', 'local'].includes(value)) return bad('来源只能是 auto/cloud/local')
    if (action === 'mode' && !MUSIC_MODES.includes(value)) return bad('模式只能是 list/one/shuffle')
    if (action === 'local_play') { if (value != null && !(Number.isInteger(value) && value >= 0)) return bad('序号不对') }
    if (action === 'open_link') {
      let url = typeof value === 'string' && value !== 'daily' ? value.trim() : ''
      if (!url) { const d = dailyToday(); url = (d && d.link) || '' }
      if (!url && value && typeof value === 'object' && daily && daily.link) url = daily.link({ title: String(value.title || ''), artist: String(value.artist || ''), app: value.app }) || ''
      if (!LINK_RE.test(url) || url.length > 600) return bad('只能打开网易云/QQ 音乐的链接')
      if (!user && consent().openLink !== true) return { code: 403, body: { ok: false, code: 'consent', message: '第一次打开音乐链接需要用户在小卡片上点一下' } }
      if (user) grant('openLink')
      const ok = (openLink || ((u) => openExternal(u, spawnFn)))(url)
      return { code: ok ? 200 : 502, body: ok ? { ok: true } : { ok: false, message: '打不开链接' } }
    }
    if (action === 'play_song') {
      // 网易云点播：value = { title, artist? }。只有网易云能点播；正在用 QQ 音乐时明说不行
      const v = value && typeof value === 'object' ? value : { title: typeof value === 'string' ? value : '' }
      const title = String(v.title || '').trim().slice(0, 120)
      const artist = String(v.artist || '').trim().slice(0, 60)
      if (!title) return bad('要给歌名')
      const before = await now().catch(() => null)
      if (before && before.app === 'qqmusic') return { code: 409, body: { ok: false, code: 'unsupported', message: '现在用的是 QQ 音乐，只有网易云能直接点播' } }
      const list = await neteaseSearch([title, artist].filter(Boolean).join(' '), { fetchImpl })
      if (!list.length) return { code: 502, body: { ok: false, code: 'search_failed', message: '网易云没搜到，或者搜索接口连不上' } }
      const { pick, candidates } = pickNeteaseSong(list, { title, artist })
      if (!pick) return { code: 200, body: { ok: false, code: 'ambiguous', message: '没找到歌名和歌手都对得上的那首，先问问用户要哪个版本', data: { candidates } } }
      const ok = (openLink || ((u) => openProtocol(u, spawnFn)))(neteasePlayUrl(pick.id))
      if (!ok) return { code: 502, body: { ok: false, message: '打不开网易云（客户端没装或没注册 orpheus:// 链接）' } }
      const song = { title: pick.title, artist: pick.artists.join(' / '), album: pick.album, vip: pick.vip }
      // 等客户端切过去再看一眼：对上了才说「在放了」，没对上照实说
      if (playWaitMs > 0) await new Promise((r) => setTimeout(r, playWaitMs))
      const after = playWaitMs > 0 ? await now().catch(() => null) : null
      const playing = !!(after && after.track && normSong(after.track.title) === normSong(pick.title))
      return { code: 200, body: { ok: true, data: { ...song, confirmed: playing } } }
    }
    if (action === 'local_add') {
      if (!user) return { code: 403, body: { ok: false, message: '添加本地歌曲只能由用户在小卡片上选择' } }
      const files = await (pickFiles || (() => pickFilesWindows({ spawnFn })))()
      if (!files.length) return { code: 200, body: { ok: true, data: { added: 0, cancelled: true } } }
      const r = await call('control', { action: 'local_add', value: files.slice(0, 200) }, 15000)
      return r.ok ? { code: 200, body: { ok: true, data: { added: r.data.added | 0, unsupported: r.data.unsupported | 0, rejected: r.data.rejected | 0, total: r.data.total | 0 } } } : { code: 502, body: { ok: false, message: (r.error && r.error.message) || '失败' } }
    }
    const args = value === undefined ? { action } : { action, value }
    const r = await call('control', args, 9000)
    if (!r.ok) return { code: r.error && r.error.code === 'not_configured' ? 503 : 502, body: { ok: false, message: (r.error && r.error.message) || '失败' } }
    return { code: 200, body: { ok: true, data: r.data || {} } }
  }

  async function localList () {
    const r = await call('control', { action: 'local_list' }, 4000)
    if (!r.ok) return { ok: false, items: [] }
    const items = (r.data.items || []).map((x) => ({ index: x.index | 0, title: String(x.title || ''), artist: String(x.artist || '') }))
    return { ok: true, index: Number.isInteger(r.data.index) ? r.data.index : -1, items }
  }

  async function coverImage () {
    const r = await call('cover', {}, 4000)
    if (!r.ok || !r.data || !r.data.available) return null
    const buf = Buffer.from(String(r.data.b64 || ''), 'base64')
    if (!buf.length) return null
    cover = { mime: r.data.mime === 'image/png' ? 'image/png' : 'image/jpeg', buf }
    return cover
  }

  const push = (role, text, extra = {}) => {
    const m = { seq: ++seq, role, text: String(text).slice(0, 8000), at: Date.now(), ...extra }
    chat.push(m); if (chat.length > CHAT_MAX) chat.splice(0, chat.length - CHAT_MAX)
    return m
  }
  const sid = () => { const s = settings(); return (s && s.voice && s.voice.llm && s.voice.llm.sessionId) || '' }

  async function sendChat (text) {
    if (busy) return { code: 409, body: { ok: false, message: '上一句还在等回复' } }
    const mine = push('user', text)
    const id = sid()
    if (!id) { const m = push('pet', '还没有绑定会话：去设置页「对话」里选一个会话。', { error: true }); return { code: 200, body: { ok: false, item: mine, reply: m.text } } }
    busy = true
    try {
      const snap = await now().catch(() => null)
      let r
      try { r = await relay.ask(id, chatPrompt(text, snap), undefined, { source: 'music' }) } catch (e) { r = { code: 500, body: { ok: false } } }
      const reply = r && r.code === 200 && r.body && r.body.ok ? String(r.body.reply || '').trim() : ''
      if (reply) { push('pet', reply); return { code: 200, body: { ok: true, item: mine, reply } } }
      const msg = r && r.code === 404 ? '会话不在线。' : r && r.code === 504 ? '等回复超时了。' : r && r.code === 409 ? '会话正忙，稍后再说。' : '没收到回复。'
      push('pet', msg, { error: true })
      return { code: 200, body: { ok: false, item: mine, reply: msg, error: true } }
    } finally { busy = false }
  }

  /** -> true when handled */
  async function handle (req, res, { path, url, host, send, readBody }) {
    if (!path.startsWith('/api/music/')) return false
    const origin = req.headers.origin
    if (origin && origin !== 'http://' + host) { send(res, 403, { ok: false }); return true }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) { send(res, 403, { ok: false }); return true }
    const op = path.slice('/api/music/'.length)
    if (req.method === 'GET' && op === 'now') { send(res, 200, await now()); return true }
    if (op.startsWith('clap')) {
      if (!enabled()) { send(res, 409, { ok: false, code: 'disabled', message: '「一起听歌」没有打开' }); return true }
      if (req.method === 'GET') {
        // （review 修复 4）模型加载失败原因在音乐服务里，服务在跑就要过来；不在跑不主动拉起。
        let live = null
        try {
          if (br.running) { const r = await br.call('clap_status', {}, 1500); if (r && r.ok) live = r.data }
        } catch {}
        send(res, 200, { ...clapStatus(), live }); return true
      }
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
      if (op === 'clap/enable') {
        // 开关的唯一真源是 settings.listen.clap（review 修复 9）：这里只同步文件 + 必要时开始装
        syncClapFlag({ enabled: true, mirror: body.mirror })
        if (!clapReady()) clapInstall(body.mirror || '')
        send(res, 200, { ok: true, ...clapStatus() }); return true
      }
      if (op === 'clap/disable') {
        syncClapFlag({ enabled: false, mirror: body.mirror })
        send(res, 200, { ok: true, ...clapStatus() }); return true
      }
      if (op === 'clap/delete') {
        // 先放掉内存里的模型（也释放文件占用），再删；删除经 lib/purge.js（根白名单 + 占用返回 busy）
        try { br.stop() } catch {}
        const dir = clapDir()
        let busy = false
        try {
          for (const name of fs.readdirSync(dir)) {
            const r = purge(join(dir, name), { roots: [dir], log: (m) => logger?.info?.(m) })
            if (!r.ok) { busy = r.code === 'busy'; break }
          }
        } catch {}
        syncClapFlag({ enabled: false })
        if (busy) { send(res, 409, { ok: false, code: 'busy', message: '有程序还在用，关掉桌宠再试', ...clapStatus() }); return true }
        send(res, 200, { ok: true, ...clapStatus() }); return true
      }
      send(res, 404, { ok: false }); return true
    }
    if (!enabled()) { br.stop(); send(res, 409, { ok: false, code: 'disabled', message: '「一起听歌」没有打开' }); return true }
    if (req.method === 'GET') {
      if (op === 'live') { const { playback, ...view } = await live(); send(res, 200, view); return true }
      if (op === 'local') { send(res, 200, await localList()); return true }
      if (op === 'chat') {
        const after = Number(url.searchParams.get('after')) || 0
        send(res, 200, { ok: true, items: chat.filter((m) => m.seq > after), busy, session: !!sid() }); return true
      }
      if (op === 'cover') {
        const c = await coverImage()
        if (!c) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true }
        res.writeHead(200, { 'Content-Type': c.mime, 'Content-Length': c.buf.length, 'Cache-Control': 'private, max-age=3600' })
        res.end(c.buf); return true
      }
      send(res, 404, { ok: false }); return true
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false }); return true }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { send(res, 415, { ok: false }); return true }
    let body = {}
    try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') } catch { send(res, 400, { ok: false }); return true }
    if (op === 'audio-dirs/add' || op === 'audio-dirs/remove') {
      const r = await editAudioDirs(op, body)
      send(res, r.ok ? 200 : 400, r); return true
    }
    if (op === 'control') { const r = await control(body, { user: true }); send(res, r.code, r.body); return true }
    if (op === 'chat') {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
      if (!text) { send(res, 400, { ok: false, message: 'empty' }); return true }
      const r = await sendChat(text); send(res, r.code, r.body); return true
    }
    send(res, 404, { ok: false }); return true
  }

  // ---- 「听得更细」：状态 / 安装 / 开关；宿主通知说话窗口也在这里 ----
  const clapCfg = () => (typeof settings === 'function' ? (settings().listen || {}) : {})
  /** 设置是唯一真源：写进 <dataDir>/music/clap.json（服务只读这个文件）。 */
  const syncClapFlag = (override = null) => {
    const cfg = clapCfg()
    const enabled = override && typeof override.enabled === 'boolean' ? override.enabled : cfg.clap === true
    const mirror = override && typeof override.mirror === 'string' ? override.mirror : (cfg.clapMirror || '')
    try { writeClapFlag(dataDir, { enabled, mirror: mirror || '' }) } catch {}
    return { enabled, mirror: mirror || '' }
  }
  const clapStatus = () => {
    const flag = readClapFlag(dataDir)
    const installed = clapReady()
    return {
      enabled: flag.enabled === true,
      mirror: flag.mirror || '',
      installed,
      ready: installed && flag.enabled === true,
      state: clapState.running ? 'installing' : installed ? 'ready' : 'not_installed',
      progress: clapState.running ? { step: clapState.step, message: clapState.message, done: clapState.done, total: clapState.total } : null,
      error: clapState.error || '',
      model_id: CLAP_MODEL_ID,
      dir: clapDir(),
    }
  }
  const duckSpeaking = (seconds) => {
    if (!br.running) return
    const secs = Math.max(3, Math.min(30, Number(seconds) || 3))
    br.call('notify', { speaking_seconds: secs }, 800).catch(() => {})
  }
  const runStep = (argv) => new Promise((ok, bad) => {
    let child
    try { child = nodeSpawn(argv[0], argv.slice(1), { cwd: RUNTIME_DIR, windowsHide: true }) } catch (e) { return bad(e) }
    let tail = ''
    child.stdout?.on?.('data', (d) => { tail = (tail + String(d)).slice(-400) })
    child.stderr?.on?.('data', (d) => { tail = (tail + String(d)).slice(-400) })
    child.on('exit', (code) => (code === 0 ? ok(tail) : bad(new Error('exit ' + code + ' ' + tail.slice(-160)))))
    child.on('error', bad)
  })
  /** PATH 上找可执行文件（uv 回退链用） */
  const onPath = (name) => {
    const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
    for (const d of dirs) {
      for (const n of [name, name + '.exe', name + '.cmd', name + '.bat']) {
        try { if (existsSync(join(d, n))) return join(d, n) } catch {}
      }
    }
    return ''
  }
  /**
   * 装依赖用哪个 pip（不写死任何本机路径的 uv.exe）：
   * 设置里的 uv → venv 里的 uv.exe → PATH 上的 uv → python -m pip。
   */
  const pipRunner = (venvPy) => {
    const cfgUv = String(clapCfg().uv || '').trim()
    if (cfgUv && existsSync(cfgUv)) return { argv: (args) => [cfgUv, 'pip', 'install', '--python', venvPy, '--link-mode=copy', ...args], how: 'uv(设置)' }
    const localUv = join(dirname(venvPy), 'uv.exe')
    if (existsSync(localUv)) return { argv: (args) => [localUv, 'pip', 'install', '--python', venvPy, '--link-mode=copy', ...args], how: 'uv(venv)' }
    const pathUv = onPath('uv')
    if (pathUv) return { argv: (args) => [pathUv, 'pip', 'install', '--python', venvPy, '--link-mode=copy', ...args], how: 'uv(PATH)' }
    return { argv: (args) => [venvPy, '-m', 'pip', 'install', ...args], how: 'pip' }
  }
  /** 下载一个文件：Range 断点续传、大小与 sha256 校验、失败清理本轮 .part（review 修复 11）。 */
  const downloadOne = async (file, mirror, dir) => {
    const target = assertUnderClapHf(join(dir, 'hf', file))
    const part = assertUnderClapHf(join(dir, 'hf', file + '.part'))
    mkdirSync(dirname(target), { recursive: true })
    const expectSize = file === CLAP_LARGE.file ? CLAP_LARGE.size : null
    let have = 0
    try { have = fs.statSync(part).size } catch { have = 0 }
    if (expectSize && have > expectSize) { fs.rmSync(part, { force: true }); have = 0 }
    const headers = have > 0 ? { Range: 'bytes=' + have + '-' } : {}
    let createdPart = have === 0
    const res = await hfOpen(hfUrl(mirror, file), { headers })
    const ranged = res.statusCode === 206
    if (have > 0 && !ranged) { // 服务器不支持续传：从头来
      fs.rmSync(part, { force: true })
      have = 0
      createdPart = true
    }
    const declared = Number(res.headers['x-linked-size'] || res.headers['content-length'] || 0)
    const total = expectSize || (ranged ? have + declared : declared) || 0
    if (total) clapState.files[file] = { done: have, total }
    const hash = file === CLAP_LARGE.file ? createHash('sha256') : null
    const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
    let written = have
    const waitDone = new Promise((ok, bad) => {
      res.on('data', (chunk) => {
        if (hash) hash.update(chunk)
        written += chunk.length
        clapState.files[file] = { done: written, total: total || written }
        clapState.done += chunk.length
        if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()) }
      })
      res.on('end', () => out.end(() => ok()))
      res.on('error', bad)
      out.on('error', bad)
    })
    try {
      await waitDone
    } catch (e) {
      try { fs.rmSync(createdPart ? part : part, { force: true }) } catch {}
      throw e
    }
    const size = fs.statSync(part).size
    if (expectSize && size !== expectSize) {
      try { fs.rmSync(part, { force: true }) } catch {}
      throw new Error(file + ' 大小不对（' + size + ' / ' + expectSize + '）')
    }
    if (hash && CLAP_LARGE.sha256 && hash.digest('hex') !== CLAP_LARGE.sha256) {
      try { fs.rmSync(part, { force: true }) } catch {}
      throw new Error(file + ' 校验和不符，已删除重下')
    }
    fs.renameSync(part, target)
    return { file, size }
  }
  const downloadClapFiles = async (mirror, dir) => {
    mkdirSync(join(dir, 'hf'), { recursive: true })
    clapState.total = CLAP_LARGE.size
    clapState.done = 0
    clapState.files = {}
    // 大文件单独下（进度线性好读）；小文件 4 路并行
    await downloadOne(CLAP_LARGE.file, mirror, dir)
    const queue = [...CLAP_SMALL]
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const f = queue.shift()
        await downloadOne(f, mirror, dir)
      }
    })
    await Promise.all(workers)
  }
  const clapInstall = (mirror) => {
    if (clapState.running) return { ok: false, message: '已经在装了' }
    const venvPy = resolvePython({ settings: settings(), dataDir, exists })
    if (!venvPy.ok) return { ok: false, message: '音乐服务 Python 没配置' }
    clapState.running = true; clapState.startedAt = Date.now(); clapState.error = ''
    const dir = clapDir()
    ;(async () => {
      try {
        const pip = pipRunner(venvPy.python)
        clapState.step = 'deps-torch'; clapState.message = '装 torch CPU（一次性，最大的一步）· ' + pip.how
        clapState.done = 0; clapState.total = 0
        await runStep(pip.argv(['torch', '--index-url', 'https://download.pytorch.org/whl/cpu']))
        clapState.step = 'deps-transformers'; clapState.message = '装 transformers'
        await runStep(pip.argv(['transformers', 'sentencepiece']))
        clapState.step = 'model'; clapState.message = '下载模型（约 615 MB）'
        await downloadClapFiles(mirror, dir)
        clapState.step = 'labels'; clapState.message = '构建标签向量（文本端只跑这一次）'
        await runStep([venvPy.python, '-X', 'utf8', '-c', 'import json;from pixelmusic import clap;print(json.dumps(clap.build_label_emb()))'])
        clapState.step = 'done'; clapState.message = '装好了'
        syncClapFlag({ enabled: true, mirror })
        clapState.running = false; clapState.finishedAt = Date.now()
      } catch (e) {
        clapState.running = false
        clapState.error = String((e && e.message) || e).slice(0, 200)
        clapState.step = 'error'
      }
    })()
    return { ok: true }
  }
  try { syncClapFlag() } catch {}   // 建服务时先按设置落一份（review 修复 9）
  return {
    handle, now, live, control, listenFile, localList, sendChat, chat, enabled, bridge: br,
    duckSpeaking, clapStatus, clapInstall, syncClap: () => syncClapFlag(),
    /** 释放音乐服务（模型、缓存文件句柄），清理前用；下次用到时自动重新拉起 */
    stopService: () => { try { br.stop() } catch {} },
    dispose: () => { clearInterval(watch); br.stop() },
  }
}
