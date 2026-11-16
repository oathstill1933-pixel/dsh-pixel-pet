/**
 * 「一起看书」宿主（docs/READING_CONTRACT.md）。前端与逻辑复用自一个私用版阅读器（只读参考，未改动）。
 *
 *   阅读窗 web/reading/*（pywebview 正常窗口，runtime/pixelpet/reading_win.py）
 *     ──HTTP──>  /api/reading/*（本文件）──relay──> 桌宠绑定会话
 *
 * - 只在 settings.reading.enabled === true 时工作；关着时除 state 外的 API 一律 409。
 * - 数据：<dataDir>/reading/（sessions.json 最近文档与位置、prefs.json 留存偏好、<docId>.json 只存「留存」的划线、
 *   docs/ 拖入或网页 PDF 的副本）。docId 用 FNV-1a 64。
 * - 隐私：正文/留存只在本机；日志不记正文、不记路径；页面与 AI 工具拿不到本地路径（PDF 只给 id）。
 *   只有用户提问时，选中原文 + 前后文 + 文档名/页码经会话中继发出。
 *
 * Routes（GET /reading/ 静态；/api/reading/* 仅同源，/open 另认桌宠 key）：
 *   GET  state | fetch?url= | pdf?id= | kept?id=
 *   POST open-url | open-path | pick-file | upload?name= | open-doc | forget | status | keep-pref
 *        ask | kept/save | kept/delete | stt | context | mic | open
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const READING_DEFAULT = { enabled: false, python: '' }
const HERE = dirname(fileURLToPath(import.meta.url))
export const READING_WEB = join(HERE, '..', 'web', 'reading')
const RUNTIME_DIR = join(HERE, '..', 'runtime')
const JSON_LIMIT = 256 * 1024
const UPLOAD_LIMIT = 200 * 1024 * 1024
const AUDIO_LIMIT = 20 * 1024 * 1024
const PAGE_LIMIT = 8 * 1024 * 1024
const PDF_LIMIT = 400 * 1024 * 1024
const RECENT_MAX = 30
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.icc': 'application/octet-stream',
}
const DOC_ID = /^[a-z]+-[0-9a-f]{8,64}$/

// --------------------------------------------------------------------------- settings
export function sanitizeReading (cur, patch) {
  const base = { ...READING_DEFAULT, ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}) }
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  if (typeof p.enabled === 'boolean') base.enabled = p.enabled
  if (typeof p.python === 'string') base.python = p.python
  return {
    enabled: base.enabled === true,
    python: typeof base.python === 'string' ? base.python.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 260) : '',
  }
}
export const readingOn = (s) => !!(s && s.reading && s.reading.enabled === true)

/** reading.python → listen.python → <dataDir>/listen.json；只认存在的文件，源码不写死路径 */
export function resolveReadingPython ({ settings, dataDir, exists = existsSync } = {}) {
  const s = settings || {}
  const a = typeof s.reading?.python === 'string' ? s.reading.python.trim() : ''
  const b = typeof s.listen?.python === 'string' ? s.listen.python.trim() : ''
  let c = ''
  try { const j = JSON.parse(readFileSync(join(dataDir, 'listen.json'), 'utf8')); if (j && typeof j.python === 'string') c = j.python.trim() } catch {}
  const python = [a, b, c].find((p) => p && exists(p)) || ''
  return { python, ok: !!python }
}

// --------------------------------------------------------------------------- small helpers
const now = () => Date.now()
const str = (v) => (typeof v === 'string' ? v : '')
const clip = (s, n) => Array.from(String(s || '')).slice(0, n).join('')
const clipTail = (s, n) => { const a = Array.from(String(s || '')); return a.slice(Math.max(0, a.length - n)).join('') }
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
function atomicWrite (file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  try { renameSync(tmp, file) } catch (e) { try { unlinkSync(tmp) } catch {} throw e }
}

/** FNV-1a 64（与私用版一致，旧 docId 不变） */
export function fnv (s) {
  let h = 0xcbf29ce484222325n
  for (const b of Buffer.from(s, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
  return h.toString(16).padStart(16, '0')
}
const webKey = (u) => { const c = new URL(u.href); c.hash = ''; return c.href }
export const webId = (u) => 'web-' + fnv(webKey(u))
export const pdfId = (path) => 'pdf-' + fnv(path.toLowerCase())

export function normalizeUrl (raw) {
  const t = String(raw || '').trim()
  if (!t) throw new Error('网址为空')
  let s = t
  if (!t.includes('://')) s = 'https://' + t
  let u
  try { u = new URL(s) } catch { throw new Error('网址无效') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 网址')
  return u
}
const looksLikePath = (s) => /^[a-zA-Z]:[\\/]/.test(String(s).trim()) || String(s).trim().startsWith('\\\\')

/** SSRF：回环 / 局域网 / 链路本地 / CGNAT 一律不抓（每一跳都查） */
export function isPrivateHost (host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true
  if (/^(fe80|fc|fd|::ffff:)/.test(h)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4) return false
  const a = Number(v4[1]); const b = Number(v4[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

// --------------------------------------------------------------------------- web fetch (系统代理感知)
let proxyCache = { at: 0, value: null }
function systemProxy () {
  if (process.platform !== 'win32') return null
  if (now() - proxyCache.at < 60_000) return proxyCache.value
  let value = null
  try {
    const out = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).stdout || ''
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] || ''
    if (enabled && server) {
      const parts = server.split(';')
      const pick = parts.find((p) => p.startsWith('https=')) || parts.find((p) => p.startsWith('http=')) || parts.find((p) => !p.includes('='))
      value = pick ? pick.replace(/^\w+=/, '').replace(/^https?:\/\//, '') : null
    }
  } catch { value = null }
  proxyCache = { at: now(), value }
  return value
}

function getOnce (u, proxy, limit, ms) {
  return new Promise((ok, bad) => {
    const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7', 'accept-encoding': 'gzip, deflate, br', host: u.host }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    let finished = false
    const done = (err, val) => { if (finished) return; finished = true; clearTimeout(timer); if (err) bad(err); else ok(val) }
    const timer = setTimeout(() => done(new Error('timeout')), ms)
    const onResponse = (res) => {
      const parts = []; let size = 0
      res.on('data', (c) => { size += c.length; if (size > limit) { res.destroy(); done(new Error('页面过大')); return } parts.push(c) })
      res.on('end', () => {
        let body = Buffer.concat(parts)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc.includes('br')) body = zlib.brotliDecompressSync(body)
          else if (enc.includes('gzip')) body = zlib.gunzipSync(body)
          else if (enc.includes('deflate')) body = zlib.inflateSync(body)
        } catch {}
        done(null, { status: res.statusCode || 0, headers: res.headers, body })
      })
      res.on('error', (e) => done(e))
    }
    const path = u.pathname + u.search
    if (!proxy) {
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.request({ host: u.hostname, port, path, method: 'GET', headers, servername: u.hostname }, onResponse)
      req.on('error', (e) => done(e)); req.end(); return
    }
    const [ph, pp] = proxy.split(':')
    if (u.protocol === 'http:') {
      const req = http.request({ host: ph, port: Number(pp) || 80, path: u.href, method: 'GET', headers }, onResponse)
      req.on('error', (e) => done(e)); req.end(); return
    }
    const tunnel = http.request({ host: ph, port: Number(pp) || 80, method: 'CONNECT', path: u.hostname + ':' + port, headers: { host: u.hostname + ':' + port } })
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); done(new Error('代理拒绝（' + res.statusCode + '）')); return }
      const secure = tls.connect({ socket, servername: u.hostname })
      const req = https.request({ host: u.hostname, port, path, method: 'GET', headers, createConnection: () => secure }, onResponse)
      req.on('error', (e) => done(e)); req.end()
    })
    tunnel.on('error', (e) => done(e)); tunnel.end()
  })
}

/** GET，跟随跳转最多 8 次；每一跳都拦私网地址 */
export async function webGet (start, limit, { allowLocal = false, getter = getOnce } = {}) {
  let u = start
  for (let hop = 0; hop < 8; hop++) {
    if (!allowLocal && isPrivateHost(u.hostname)) throw new Error('不抓本机或局域网地址')
    const proxy = allowLocal && isPrivateHost(u.hostname) ? null : systemProxy()
    let r
    try { r = await getter(u, proxy, limit, 25_000) } catch (e) {
      if (!proxy || /页面过大/.test(String(e))) throw e
      r = await getter(u, null, limit, 25_000)
    }
    if (proxy && (r.status === 403 || r.status === 451 || r.status >= 500)) {
      try { const d = await getter(u, null, limit, 25_000); if (d.status < 400) r = d } catch {}
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const next = new URL(String(r.headers.location), u)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('跳转到了不支持的地址')
      u = next; continue
    }
    return { ...r, url: u }
  }
  throw new Error('跳转次数过多')
}

function charsetOf (contentType, head) {
  const m = /charset=([\w-]+)/i.exec(contentType)
  if (m) return m[1]
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head.subarray(0, 4096).toString('latin1'))
  return meta ? meta[1] : 'utf-8'
}
function decode (buf, label) {
  try { return new TextDecoder(label.toLowerCase() === 'gb2312' ? 'gbk' : label).decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) }
}

// --------------------------------------------------------------------------- prompt
/** 中文 PDF 用「重印一遍」模拟粗体时，文本层出现「第一条第一条」：只压前后文里 ≥3 字的紧邻重复 */
export function dedupeRuns (s) {
  const c = Array.from(s); let out = ''; let i = 0
  while (i < c.length) {
    let hit = 0
    for (let len = 40; len >= 3; len--) if (i + 2 * len <= c.length && c.slice(i, i + len).join('') === c.slice(i + len, i + 2 * len).join('')) { hit = len; break }
    if (hit) { out += c.slice(i, i + hit).join(''); i += 2 * hit } else { out += c[i]; i++ }
  }
  return out
}

/** 页面送来的选区 → 白名单字段（无本地路径；web 只留网址） */
export function cleanPick (p) {
  const o = p && typeof p === 'object' ? p : {}
  const text = clip(str(o.text).replace(/\s+/g, ' ').trim(), 1500)
  if (Array.from(text).length < 2) throw new Error('没有选中文字')
  const kind = o.kind === 'pdf' ? 'pdf' : 'web'
  const docId = str(o.docId)
  return {
    docId: DOC_ID.test(docId) ? docId : '', kind, title: clip(str(o.title), 200),
    src: kind === 'web' && /^https?:\/\//i.test(str(o.src)) ? clip(str(o.src), 2000) : '',
    text, before: clipTail(str(o.before), 600), after: clip(str(o.after), 600),
    page: Number.isInteger(o.page) && o.page > 0 ? o.page : null,
    charOffset: Number.isInteger(o.charOffset) && o.charOffset >= 0 ? o.charOffset : null,
    rect: o.rect && typeof o.rect === 'object' ? { x: +o.rect.x || 0, y: +o.rect.y || 0, w: +o.rect.w || 0, h: +o.rect.h || 0 } : null,
  }
}

const CTX_MIN = 200
const CTX_MAX = 400
export const READING_TAG = '[一起看书]'
/** 《标题》第 N 页 / 网页《标题》（域名） */
export function placeOf (pick) {
  const title = str(pick.title) || '（无标题）'
  let host = ''
  try { host = pick.src ? new URL(pick.src).host : '' } catch {}
  return pick.kind === 'pdf' ? '《' + title + '》' + (pick.page ? '第 ' + pick.page + ' 页' : '') : '网页《' + title + '》' + (host ? '（' + host + '）' : '')
}
/** 前文 / 后文各 200–400 字（问题越短给越多） */
function contextLines (pick, extra = 0) {
  const ctx = (s) => (pick.kind === 'pdf' ? dedupeRuns(s) : s).replace(/\s+/g, ' ').trim()
  const room = Math.max(CTX_MIN, Math.min(CTX_MAX, 900 - Array.from(str(pick.text)).length / 2 - extra))
  const before = clipTail(ctx(str(pick.before)), room)
  const after = clip(ctx(str(pick.after)), room)
  const out = []
  if (before) out.push('前文：…' + before)
  if (after) out.push('后文：' + after + '…')
  return out
}
const SPOKEN = '回答会在桌宠气泡里显示并念出来，同时显示在阅读窗的卡片里：两三句、先结论，别用列表、表格和符号。'

/** 提问：选中原文 + 前后各 200–400 字 + 文档名/页码 + 问题 */
export function composePrompt (pick, question, { voice = false } = {}) {
  const lines = [READING_TAG + ' 用户在阅读窗里读' + placeOf(pick) + '，划了这一段：', '「' + str(pick.text) + '」']
  lines.push(...contextLines(pick, Array.from(question).length))
  lines.push('', (voice ? '用户（说话）问：' : '用户问：') + clip(question.trim(), 600), '——')
  lines.push('就着这段回答，不用复述原文。' + SPOKEN)
  return lines.join('\n')
}

/** 阅读上下文槽 → 附在用户经其它入口（输入条打字/语音）发给会话的话后面 */
export function renderContextNote (pick, { full = true } = {}) {
  if (!full) return '（一起看书：用户还停在' + placeOf(pick) + '划的那段「' + clip(str(pick.text), 40) + (Array.from(str(pick.text)).length > 40 ? '…' : '') + '」上；这句话里的「这段 / 这里」指的就是它。）'
  return ['（一起看书·当前划线：用户正在阅读窗里读' + placeOf(pick) + '，划着这一段——', '「' + str(pick.text) + '」', ...contextLines(pick), '用户这句话里说「这段 / 这里 / 这句」时，指的就是它。）'].join('\n')
}

function cleanTurns (v) {
  if (!Array.isArray(v)) return []
  return v.slice(0, 50).map((x) => ({
    asked: clip(str(x?.asked).trim(), 2000) || null,
    answer: clip(str(x?.answer).trim(), 6000) || null,
    voice: x?.voice === true,
    at: Number.isFinite(x?.at) ? x.at : now(),
  })).filter((x) => x.asked || x.answer)
}
const turnsOf = (h) => (Array.isArray(h.turns) ? h.turns : (h.asked || h.answer ? [{ asked: h.asked ?? null, answer: h.answer ?? null, at: h.createdAt }] : []))

/** Windows 文件框（用户显式选择）：只认 PDF。-> 路径或 '' */
export function pickPdfWindows ({ spawnFn = nodeSpawn, timeoutMs = 10 * 60_000 } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = '打开 PDF'",
    "$d.Filter = 'PDF (*.pdf)|*.pdf'",
    '$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}',
    'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { $b=[Text.Encoding]::UTF8.GetBytes($d.FileName); [Console]::OpenStandardOutput().Write($b,0,$b.Length) }',
  ].join('; ')
  return new Promise((done) => {
    let out = Buffer.alloc(0); let child
    try { child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { done(''); return }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs); timer.unref?.()
    child.stdout.on('data', (d) => { out = Buffer.concat([out, Buffer.from(d)]) })
    child.on('error', () => { clearTimeout(timer); done('') })
    child.on('exit', () => { clearTimeout(timer); done(out.toString('utf8').trim()) })
  })
}

// --------------------------------------------------------------------------- service
/**
 * @param {{ dataDir: string, settings: () => any, relay: { ask: Function }, logger?: any,
 *   sendCommand?: (body, ms?) => Promise<any>, partner?: () => { name: string, character: string },
 *   transcribe?: (wav: Buffer) => Promise<{ code, body }>, pickFile?: () => Promise<string>,
 *   getter?: Function, spawnFn?: Function, exists?: Function, hostPid?: number, watchMs?: number }} o
 */
export function createReading (o = {}) {
  const { dataDir, settings, relay, logger } = o
  const dir = join(dataDir || '.', 'reading')
  const sendCmd = o.sendCommand || (async () => ({ ok: false, running: false }))
  const spawnFn = o.spawnFn || nodeSpawn
  const exists = o.exists || existsSync
  const enabled = () => { try { return readingOn(settings()) } catch { return false } }

  let sessions = null
  let prefs = null
  const load = () => {
    if (sessions) return
    const s = readJson(join(dir, 'sessions.json'))?.sessions
    sessions = Array.isArray(s) ? s.filter((x) => x && typeof x === 'object' && DOC_ID.test(str(x.id))) : []
    const p = readJson(join(dir, 'prefs.json'))
    prefs = p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  }
  const warn = (what, e) => logger?.warn?.('[dsh-pixel-pet] 一起看书 ' + what + '：' + (e && e.code ? e.code : 'error'))
  const saveSessions = () => { try { atomicWrite(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }, null, 2)) } catch (e) { warn('最近列表写入失败', e) } }
  const savePrefs = () => { try { atomicWrite(join(dir, 'prefs.json'), JSON.stringify(prefs, null, 2)) } catch (e) { warn('偏好写入失败', e) } }
  const touch = (doc) => {
    load()
    const old = sessions.find((s) => s.id === doc.id) || {}
    const merged = { ...old, ...doc, openedAt: now() }
    sessions = [merged, ...sessions.filter((s) => s.id !== doc.id)].slice(0, RECENT_MAX)
    saveSessions()
    return merged
  }
  const publicDoc = (d) => d ? {
    id: d.id, kind: d.kind, title: d.title || '', page: d.page ?? null, total: d.total ?? null, scroll: d.scroll ?? 0, openedAt: d.openedAt ?? null,
    ...(d.kind === 'web' ? { src: d.src } : {}),
  } : null
  const docFile = (id) => { if (!DOC_ID.test(String(id || ''))) throw new Error('文档 id 无效'); return join(dir, id + '.json') }

  // 阅读上下文槽（只在内存，不落盘）：阅读窗有当前划选时写入，选区取消/卡片关闭/换文档/超时清掉。
  // 用户经任何入口发给绑定会话的话都会附上它（decorate）；同一段完整附一次，之后只附一句指代。
  const CONTEXT_TTL = o.contextTtlMs || 10 * 60_000
  const clock = o.clock || now
  const slot = { pick: null, at: 0, ver: 0, sentVer: 0 }
  const slotLive = () => {
    if (slot.pick && clock() - slot.at > CONTEXT_TTL) clearContext()
    return slot.pick && enabled() ? slot.pick : null
  }
  function setContext (pick) {
    const same = slot.pick && slot.pick.docId === pick.docId && slot.pick.text === pick.text
    slot.pick = pick; slot.at = clock()
    if (!same) slot.ver++
  }
  function clearContext () { slot.pick = null; slot.at = 0 }
  const pointedKey = () => { const s = settings(); return String((s && s.voice && s.voice.llm && s.voice.llm.sessionId) || '').replace(/^session-/, '') }
  /** relay hook: d = { content, commit } from the prompt channel -> same shape with the reading note appended */
  function decorate (sessionId, d) {
    const pick = slotLive()
    if (!pick || !d || !Array.isArray(d.content)) return d
    if (String(sessionId || '').replace(/^session-/, '') !== pointedKey()) return d
    const first = d.content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
    const head = first ? first.text.trimStart() : ''
    const ver = slot.ver
    // 阅读卡片自己的提问已经带着这段：不再重复附，只记作「这段已经送到」
    if (head.startsWith(READING_TAG)) return { content: d.content, commit () { d.commit(); slot.sentVer = Math.max(slot.sentVer, ver) } }
    if (/^\[[^\]\n]{1,16}\]/.test(head)) return d          // 信箱 / 一起听歌等别的通路：不掺阅读上下文
    const full = slot.sentVer !== ver
    return {
      content: [...d.content, { type: 'text', text: renderContextNote(pick, { full }) }],
      commit () { d.commit(); slot.sentVer = Math.max(slot.sentVer, ver) },
    }
  }

  function openPdfPath (raw, title) {
    const path = resolve(String(raw).trim().replace(/^"(.*)"$/, '$1'))
    if (extname(path).toLowerCase() !== '.pdf') throw new Error('第一版只认 PDF 与网页')
    let size = 0
    try { size = statSync(path).size } catch { throw new Error('文件不存在') }
    if (size > PDF_LIMIT) throw new Error('文件过大（>400MB）')
    const id = pdfId(path)
    load()
    const known = sessions.find((s) => s.id === id)
    const doc = { id, kind: 'pdf', src: path }
    if (!known) { doc.title = title || basename(path); doc.page = 1; doc.scroll = 0 } else if (title) doc.title = title
    return touch(doc)
  }
  function openWeb (u) {
    const id = webId(u)
    load()
    const known = sessions.find((s) => s.id === id)
    const doc = { id, kind: 'web', src: webKey(u) }
    if (!known) { doc.title = u.host; doc.scroll = 0 }
    return touch(doc)
  }
  const safeName = (s) => { const b = basename(s || 'document.pdf').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120); return b.toLowerCase().endsWith('.pdf') ? b : b + '.pdf' }
  function storePdf (bytes, name) {
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('不是 PDF 文件')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const file = join(dir, 'docs', hash + '-' + safeName(name))
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) writeFileSync(file, bytes)
    return file
  }
  async function fetchPage (raw) {
    const u = normalizeUrl(raw)
    const r = await webGet(u, PDF_LIMIT, { getter: o.getter })
    const ct = String(r.headers['content-type'] || '')
    if (r.status < 200 || r.status >= 300) throw new Error('网页打不开（' + r.status + '）')
    if (/application\/pdf/i.test(ct) || /\.pdf$/i.test(r.url.pathname)) {
      let name = 'web.pdf'
      try { name = decodeURIComponent(basename(r.url.pathname)) || name } catch {}
      const file = storePdf(r.body, name)
      return { kind: 'pdf', doc: publicDoc(openPdfPath(file, name)) }
    }
    if (ct && !/html|xml|text\/plain/i.test(ct)) throw new Error('这个链接不是网页或 PDF')
    if (r.body.length > PAGE_LIMIT) throw new Error('页面过大')
    const html = decode(r.body, charsetOf(ct, r.body))
    return { kind: 'web', url: r.url.href, html, plain: /text\/plain/i.test(ct), doc: publicDoc(openWeb(r.url)) }
  }

  function saveKept (pick, turns, id) {
    const file = docFile(pick.docId)
    const doc = readJson(file) || { version: 1, highlights: [] }
    load()
    const sess = sessions.find((s) => s.id === pick.docId)
    doc.docId = pick.docId; doc.kind = pick.kind; doc.title = pick.title || (sess && sess.title) || ''
    if (pick.kind === 'web' && pick.src) doc.src = pick.src
    if (!Array.isArray(doc.highlights)) doc.highlights = []
    let rec = id ? doc.highlights.find((h) => h.id === id) : null
    if (!rec) {
      rec = { id: 'hl-' + now() + '-' + crypto.randomBytes(3).toString('hex'), text: pick.text, contextBefore: pick.before, contextAfter: pick.after,
        locator: { page: pick.page, rect: pick.rect, charOffset: pick.charOffset }, createdAt: now(), keep: true }
      doc.highlights.push(rec)
    }
    rec.turns = turns
    rec.asked = turns[0]?.asked ?? null
    rec.answer = turns[0]?.answer ?? null
    rec.updatedAt = now()
    atomicWrite(file, JSON.stringify(doc, null, 2))
    return rec.id
  }
  function deleteKept (docId, id) {
    const file = docFile(docId)
    const doc = readJson(file)
    if (!doc || !Array.isArray(doc.highlights)) return false
    const n = doc.highlights.length
    doc.highlights = doc.highlights.filter((h) => h.id !== id)
    if (doc.highlights.length === n) return false
    atomicWrite(file, JSON.stringify(doc, null, 2))
    return true
  }
  function keptOf (docId) {
    let list = []
    try { list = readJson(docFile(docId))?.highlights || [] } catch { list = [] }
    return list.filter((h) => h && typeof h.text === 'string').map((h) => ({ id: h.id, text: h.text, page: h.locator?.page ?? null, createdAt: h.createdAt ?? null, turns: turnsOf(h) }))
  }

  // ---- 提问（串行；同一时刻只等一个回复）
  let askQueue = Promise.resolve()
  const sid = () => { const s = settings(); return (s && s.voice && s.voice.llm && s.voice.llm.sessionId) || '' }
  async function ask (pick, question, { voice = false } = {}) {
    const id = sid()
    if (!id) return { ok: false, message: '还没有绑定会话：去设置页「对话」里选一个会话。' }
    const prompt = composePrompt(pick, question, { voice })
    const run = askQueue.then(async () => {
      let r
      try { r = await relay.ask(id, prompt, undefined, { source: 'reading' }) } catch { r = { code: 500, body: { ok: false } } }
      return r
    })
    askQueue = run.then(() => undefined, () => undefined)
    const r = await run
    const reply = r && r.code === 200 && r.body && r.body.ok ? String(r.body.reply || '').trim() : ''
    if (!reply) {
      const msg = r && r.code === 404 ? '会话不在线。' : r && r.code === 504 ? '等回复超时了。' : r && r.code === 409 ? '会话正忙，稍后再问。' : '没收到回复。'
      return { ok: false, message: msg }
    }
    // 打字、说话都一样：回答走桌宠的说话出口（TTS + 字幕气泡）；念不出来时至少冒气泡
    let spoke = false
    try {
      const text = clip(reply, 600)
      const s = await sendCmd({ cmd: 'say', text, speak: true }, 5000)
      spoke = !!(s && s.ok)
      if (!spoke && s && s.running !== false) await sendCmd({ cmd: 'say', text, seconds: 12 }, 5000)
    } catch {}
    return { ok: true, answer: reply, spoke }
  }

  // ---- 阅读窗录音与桌宠输入条语音互斥：录音时请桌宠暂停免提监听；桌宠正在收音时阅读窗不录
  async function mic (on) {
    const r = await sendCmd({ cmd: 'reading', op: 'mic', on: on === true }, 3000).catch(() => null)
    if (!r || r.running === false || !r.ok) return { ok: true, busy: false, pet: !!(r && r.running !== false) }
    return { ok: true, busy: !!(r.data && r.data.busy), pet: true }
  }

  // ---- 桌宠「在看」（复用现有姿势，节流；桌宠在家具里/在走路时不打扰）
  let glanceAt = 0
  async function glance () {
    if (now() - glanceAt < 20_000) return false
    glanceAt = now()
    try {
      const st = await sendCmd({ cmd: 'status' }, 2000)
      const d = st && st.ok && st.data
      if (!d || d.inside || d.moving) return false
      const r = await sendCmd({ cmd: 'pose', name: 'attentive', holdMs: 8000 }, 2000)
      return !!(r && r.ok)
    } catch { return false }
  }

  // ---- 阅读窗进程（桌宠运行时优先；桌宠没在跑时宿主自己拉起，父进程 = 宿主）
  let win = null
  const resolvePy = () => resolveReadingPython({ settings: settings(), dataDir, exists })
  function spawnWindow (base) {
    if (win && win.exitCode === null && !win.killed) return { ok: true, how: 'host' }
    const p = resolvePy()
    if (!p.ok) return { ok: false, code: 'not_configured', message: '没有找到阅读窗用的 Python（「一起听歌」的音乐服务 Python，或 reading.python）。' }
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(base)) return { ok: false, code: 'bad_host', message: '宿主地址不对' }
    try {
      win = spawnFn(p.python, ['-X', 'utf8', '-m', 'pixelpet.reading_win', '--url', base + 'reading/', '--state', join(dir, 'window.json'), '--parent', String(o.hostPid || process.pid)], {
        cwd: RUNTIME_DIR, stdio: 'ignore', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      win.on?.('error', () => { win = null })
      win.on?.('exit', () => { win = null })
    } catch { win = null; return { ok: false, code: 'spawn', message: '阅读窗没能打开' } }
    return { ok: true, how: 'host' }
  }
  function stopWindow () { const w = win; win = null; if (w) { try { w.kill() } catch {} } }
  async function openWindow (base) {
    if (!enabled()) return { code: 409, body: { ok: false, code: 'disabled', message: '「一起看书」没有打开' } }
    const r = await sendCmd({ cmd: 'reading', op: 'open' }, 5000).catch(() => null)
    if (r && r.running !== false && r.ok) return { code: 200, body: { ok: true, how: 'pet' } }
    if (r && r.running !== false && !r.ok && !/不认识的命令/.test(String(r.message || ''))) {
      return { code: /Python/.test(String(r.message)) ? 503 : 502, body: { ok: false, code: /Python/.test(String(r.message)) ? 'not_configured' : 'pet', message: r.message || '阅读窗没能打开' } }
    }
    const w = spawnWindow(base)
    return { code: w.ok ? 200 : (w.code === 'not_configured' ? 503 : 502), body: w }
  }
  const watch = setInterval(() => { if (win && !enabled()) stopWindow() }, o.watchMs || 1500)
  watch.unref?.()

  function state () {
    load()
    const p = (o.partner && o.partner()) || { name: '', character: '' }
    return {
      ok: true, enabled: enabled(), current: publicDoc(sessions[0]), recent: sessions.map(publicDoc), keep: prefs.keep === true, voiceConfirm: prefs.voiceConfirm === true,
      partner: { name: p.name || '', avatar: p.character ? '../api/thumb/character/' + p.character : '' },
      session: !!sid(),
    }
  }

  /** for the AI tool: current doc + selection + latest kept, never a local path */
  function snapshot () {
    load()
    const cur = sessions[0]
    if (!cur) return { open: false }
    let site = ''
    if (cur.kind === 'web') { try { site = new URL(cur.src).host } catch {} }
    const live = slotLive()
    const pick = live && live.docId === cur.id ? live : null
    let kept = []
    try { kept = keptOf(cur.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5) } catch {}
    return {
      open: true, windowOpen: !!(win && win.exitCode === null) || undefined,
      doc: { kind: cur.kind, title: cur.title || '', site: site || undefined, page: cur.page ?? null, total: cur.total ?? null },
      selection: pick ? { text: clip(pick.text, 600), before: clipTail(pick.before, 300), after: clip(pick.after, 300), page: pick.page } : null,
      kept: kept.map((k) => ({ text: clip(k.text, 120), page: k.page, asked: clip((k.turns[0] && k.turns[0].asked) || '', 120) || undefined })),
    }
  }

  // ---- HTTP
  function serveStatic (res, rel) {
    const clean = normalize(rel || 'index.html').replace(/^([/\\])+/, '')
    const root = resolve(READING_WEB)
    const file = resolve(root, clean)
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return }
    let buf
    try { buf = readFileSync(file) } catch { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length,
      'Cache-Control': clean.startsWith('vendor') ? 'max-age=86400' : 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(buf)
  }

  /** -> true when handled. petKeyOk(req) → 桌宠进程带的 X-PixelPet-Key 是否有效 */
  async function handle (req, res, { path, url, host, send, readBody, petKeyOk = () => false, base = '' }) {
    if (path === '/reading') { res.writeHead(302, { Location: 'reading/' }); res.end(); return true }
    if (path.startsWith('/reading/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true }
      let rel = ''
      try { rel = decodeURIComponent(path.slice('/reading/'.length)) } catch { res.writeHead(400); res.end(); return true }
      serveStatic(res, rel || 'index.html'); return true
    }
    if (!path.startsWith('/api/reading/')) return false
    const op = path.slice('/api/reading/'.length)
    const pet = op === 'open' && req.method === 'POST' && petKeyOk(req)
    if (!pet) {
      const origin = req.headers.origin
      if (origin && origin !== 'http://' + host) { send(res, 403, { ok: false }); return true }
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) { send(res, 403, { ok: false }); return true }
      if (op === 'open' && req.headers['x-pixelpet-key']) { send(res, 401, { ok: false, message: 'unauthorized' }); return true }
    }
    if (req.method === 'GET' && op === 'state') { send(res, 200, state()); return true }
    if (!enabled()) { stopWindow(); send(res, 409, { ok: false, code: 'disabled', message: '「一起看书」没有打开' }); return true }
    const fail = (code, e) => send(res, code, { ok: false, error: String(e && e.message || e).slice(0, 200) })
    load()
    if (req.method === 'GET') {
      if (op === 'fetch') {
        try { send(res, 200, await fetchPage(url.searchParams.get('url') || '')) } catch (e) { fail(400, /abort|timeout/i.test(String(e)) ? '等待超时' : /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(String(e && e.code || e)) ? '网络不通或网址打不开' : e) }
        return true
      }
      if (op === 'pdf') {
        const doc = sessions.find((s) => s.id === url.searchParams.get('id') && s.kind === 'pdf')
        if (!doc) { fail(404, '文档不在最近列表里'); return true }
        let size = 0
        try { size = statSync(doc.src).size } catch { fail(404, '文件不存在了'); return true }
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        createReadStream(doc.src).on('error', () => res.destroy()).pipe(res)
        return true
      }
      if (op === 'kept') { send(res, 200, keptOf(url.searchParams.get('id') || '')); return true }
      send(res, 404, { ok: false }); return true
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false }); return true }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (op === 'upload') {
      if (ct !== 'application/octet-stream') { send(res, 415, { ok: false }); return true }
      try {
        const bytes = await readBody(req, UPLOAD_LIMIT)
        const name = safeName(url.searchParams.get('name') || 'document.pdf')
        send(res, 200, { doc: publicDoc(openPdfPath(storePdf(bytes, name), name)) })
      } catch (e) { fail(400, e) }
      return true
    }
    if (op === 'stt') {
      if (!['audio/wav', 'audio/x-wav'].includes(ct)) { send(res, 415, { ok: false }); return true }
      let wav
      try { wav = await readBody(req, AUDIO_LIMIT) } catch { send(res, 413, { ok: false }); return true }
      if (wav.length < 46 || wav.toString('latin1', 0, 4) !== 'RIFF') { send(res, 400, { ok: false, message: '不是 wav' }); return true }
      if (!o.transcribe) { send(res, 503, { ok: false, message: '语音识别不可用' }); return true }
      const r = await o.transcribe(wav)
      send(res, r.code, r.body); return true
    }
    if (ct !== 'application/json') { send(res, 415, { ok: false }); return true }
    let body = {}
    try { body = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8') || '{}') || {} } catch { send(res, 400, { ok: false }); return true }
    try {
      switch (op) {
        case 'open': { const r = await openWindow(base); send(res, r.code, r.body); return true }
        case 'open-url': {
          const raw = str(body.url)
          if (looksLikePath(raw)) { send(res, 200, { doc: publicDoc(openPdfPath(raw)) }); return true }
          send(res, 200, { doc: publicDoc(openWeb(normalizeUrl(raw))) }); return true
        }
        case 'open-path': send(res, 200, { doc: publicDoc(openPdfPath(str(body.path))) }); return true
        case 'pick-file': {
          const picked = await (o.pickFile || (() => pickPdfWindows({ spawnFn })))()
          send(res, 200, { doc: picked ? publicDoc(openPdfPath(picked)) : null }); return true
        }
        case 'open-doc': {
          const doc = sessions.find((s) => s.id === str(body.id))
          if (!doc) { fail(404, '不在最近列表里'); return true }
          send(res, 200, { doc: publicDoc(touch({ id: doc.id })) }); return true
        }
        case 'forget': sessions = sessions.filter((s) => s.id !== str(body.id)); saveSessions(); send(res, 200, { ok: true }); return true
        case 'status': {
          const cur = sessions.find((s) => s.id === str(body.id))
          if (!cur) { send(res, 200, { ok: false }); return true }
          if (Number.isInteger(body.page) && body.page > 0) cur.page = body.page
          if (Number.isInteger(body.total) && body.total > 0) cur.total = body.total
          if (typeof body.title === 'string' && body.title.trim()) cur.title = clip(body.title.trim(), 200)
          if (typeof body.scroll === 'number' && Number.isFinite(body.scroll)) cur.scroll = Math.min(Math.max(body.scroll, 0), 1)
          if (slot.pick && slot.pick.docId !== cur.id) clearContext()      // 换文档：旧划线不再算数
          saveSessions(); send(res, 200, { ok: true }); return true
        }
        case 'keep-pref': {
          if (typeof body.keep === 'boolean') prefs.keep = body.keep
          if (typeof body.voiceConfirm === 'boolean') prefs.voiceConfirm = body.voiceConfirm
          savePrefs(); send(res, 200, { ok: true, keep: prefs.keep === true, voiceConfirm: prefs.voiceConfirm === true }); return true
        }
        case 'context': {
          // 当前划选 → 上下文槽（只在内存）；clear:true 清掉。顺带让桌宠切「在看」
          if (body.clear === true || !body.pick) { clearContext(); send(res, 200, { ok: true, cleared: true }); return true }
          setContext(cleanPick(body.pick))
          send(res, 200, { ok: true, ttlMs: CONTEXT_TTL, pose: await glance() }); return true
        }
        case 'mic': send(res, 200, await mic(body.on === true)); return true
        case 'ask': {
          const pick = cleanPick(body.pick)
          const question = clip(str(body.question).trim(), 2000)
          if (!question) { fail(400, '写点什么'); return true }
          setContext(pick)
          const r = await ask(pick, question, { voice: body.voice === true })
          send(res, 200, r); return true
        }
        case 'kept/save': {
          // 留存红线：只有留存开关开着才落盘（服务端再判一次，页面状态不算数）
          if (prefs.keep !== true) { send(res, 409, { ok: false, code: 'keep_off', message: '留存没开' }); return true }
          const pick = cleanPick(body.pick)
          if (!pick.docId) { fail(400, '文档 id 无效'); return true }
          send(res, 200, { ok: true, id: saveKept(pick, cleanTurns(body.turns), str(body.id)) }); return true
        }
        case 'kept/delete': send(res, 200, { ok: deleteKept(str(body.docId), str(body.id)) }); return true
        default: send(res, 404, { ok: false }); return true
      }
    } catch (e) { fail(400, e); return true }
  }

  return {
    handle, state, snapshot, enabled, openWindow, glance, decorate, setContext, clearContext, context: () => slotLive(), dir,
    get window () { return win },
    dispose: () => { clearInterval(watch); stopWindow() },
    /** 清理前关阅读窗（释放 webview 目录） */
    stopWindow,
    /** 磁盘上的会话 / 偏好被清掉后丢掉内存缓存，下次用到时重新读 */
    reset: () => { sessions = null; prefs = null },
  }
}
