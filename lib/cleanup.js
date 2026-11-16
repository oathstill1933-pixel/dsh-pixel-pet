/**
 * 设置页「真的删」：每类资源一个删除入口 + 「清除全部数据」。
 * 删除一律经 lib/purge.js（根白名单、realpath、链接不进、占用返回 busy）。
 *
 *   GET  /api/cleanup/sizes             各类资源的大小（设置页打开时异步取）
 *   POST /api/cleanup/delete  { category: 'voice'|'speaker'|'listen'|'reading'|'records' }
 *   POST /api/cleanup/export  { scope: 'records'|'all' }   -> application/zip（日程 .ics + 日记 .md + …）
 *   POST /api/cleanup/all     { confirm: '清除' }           -> 停进程 -> 逐个子目录 purge -> 数据目录清空
 *
 * 类别 -> 删什么（<数据> = dataDir）：
 *   voice    models/qwen3-tts-*、pylibs、tts-cache、models/progress.json
 *   speaker  models/speaker-model
 *   listen   CLAP 模型目录里的内容 + music/ 下的缓存（歌词 / 分析 / 本地队列路径 / 听歌记录 / 今日推荐 / clap.json）；
 *            桌宠自己的歌单 pet-playlist.json 与 consent.json 保留；歌曲文件本身从来不在这里
 *   reading  reading/webview、sessions.json、prefs.json、window.json；划词留存 <docId>.json 保留并在确认框里单列
 *   records  calendar/、diary/（用户自己的记录，确认框里有「先导出」）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { measureAsync, purge } from './purge.js'
import { zipBuffer } from './zip.js'

export const CONFIRM_WORD = '清除'
const READING_KEEP_OUT = new Set(['webview', 'sessions.json', 'prefs.json', 'window.json'])
const MUSIC_KEEP = new Set(['pet-playlist.json', 'consent.json'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const safeDir = (dir) => { try { return readdirSync(dir) } catch { return [] } }

/** 各类别要删的绝对路径（动态：目录里现有什么就列什么） */
export function categoryTargets (category, { dataDir, clapDir }) {
  const d = (...p) => join(dataDir, ...p)
  switch (category) {
    case 'voice':
      return [...safeDir(d('models')).filter((n) => /^qwen3-tts-/.test(n)).map((n) => d('models', n)), d('pylibs'), d('tts-cache'), d('models', 'progress.json')]
    case 'speaker':
      return [d('models', 'speaker-model')]
    case 'listen':
      return [...safeDir(d('music')).filter((n) => !MUSIC_KEEP.has(n)).map((n) => d('music', n)),
        ...safeDir(clapDir).map((n) => join(clapDir, n))]
    case 'reading':
      return ['webview', 'sessions.json', 'prefs.json', 'window.json'].map((n) => d('reading', n))
    case 'records':
      return [d('calendar'), d('diary')]
    default:
      return []
  }
}

/** 划词留存：reading/<docId>.json（除会话与偏好）。只数，不读内容 */
export function readingNotes (dataDir) {
  return safeDir(join(dataDir, 'reading')).filter((n) => n.endsWith('.json') && !READING_KEEP_OUT.has(n)).length
}

const sum = (list) => list.reduce((a, b) => a + (b ? b.bytes : 0), 0)
const SAFE_REL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

/** 每个包的旧版本（registry 里的 previous 指针）占多少：{ <packId>: bytes }，没有旧版本的不列 */
export async function previousSizes (dataDir) {
  const out = {}
  let reg = null
  try { reg = JSON.parse(readFileSync(join(dataDir, 'packs', 'registry.json'), 'utf8')) } catch { return out }
  for (const [id, e] of Object.entries((reg && reg.packs) || {})) {
    const rel = e && e.previous && typeof e.previous.dir === 'string' ? e.previous.dir.replace(/\\/g, '/') : ''
    if (!rel || !SAFE_REL.test(rel) || rel.split('/').includes('..')) continue
    out[id] = (await measureAsync(join(dataDir, 'packs', 'store', ...rel.split('/')))).bytes
  }
  return out
}

/** 设置页要的全部大小。异步，不卡事件循环 */
export async function collectSizes ({ dataDir, clapDir }) {
  const m = (p) => measureAsync(p)
  const group = async (category) => sum(await Promise.all(categoryTargets(category, { dataDir, clapDir }).map(m)))
  const voice = await group('voice')
  const speaker = await group('speaker')
  const listen = await group('listen')
  const reading = await group('reading')
  const calendar = (await m(join(dataDir, 'calendar'))).bytes
  const diary = (await m(join(dataDir, 'diary'))).bytes
  const mailbox = (await m(join(dataDir, 'mailbox'))).bytes
  const clones = sum(await Promise.all(safeDir(join(dataDir, 'voices')).filter((n) => /^clone-/.test(n)).map((n) => m(join(dataDir, 'voices', n)))))
  const voiceprint = (await m(join(dataDir, 'voiceprint'))).bytes
  const readingDir = (await m(join(dataDir, 'reading'))).bytes
  const readingRecords = Math.max(0, readingDir - reading)
  const packs = (await m(join(dataDir, 'packs'))).bytes
  const python = (await m(join(dataDir, 'runtime'))).bytes
  const total = (await m(dataDir)).bytes + sum(await Promise.all(safeDir(clapDir).map((n) => m(join(clapDir, n)))))
  const clap = sum(await Promise.all(safeDir(clapDir).map((n) => m(join(clapDir, n)))))
  const listed = voice + speaker + listen + reading + calendar + diary + mailbox + clones + voiceprint + readingRecords + packs + python
  return {
    voice, speaker, listen, clap, reading, notes: readingNotes(dataDir), records: calendar + diary, calendar, diary, mailbox, clones, voiceprint, readingRecords, packs, python,
    other: Math.max(0, total - listed), total,
    previous: await previousSizes(dataDir),
  }
}

// ---------------------------------------------------------------- 导出（先导出再删）

const pad = (n) => String(n).padStart(2, '0')
const icsEscape = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
/** RFC 5545 折行：每行 ≤ 75 字节，续行以空格开头（按 UTF-8 字节切，不截断字符） */
function fold (line) {
  const out = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch; bytes += n
  }
  out.push(cur)
  return out.map((l, i) => (i ? ' ' + l : l)).join('\r\n')
}
const compact = (date) => String(date).replace(/-/g, '')

export function buildIcs (items, now = new Date()) {
  const stamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dsh-pixel-pet//calendar export//ZH', 'CALSCALE:GREGORIAN']
  for (const ev of Array.isArray(items) ? items : []) {
    if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || ''))) continue
    lines.push('BEGIN:VEVENT')
    lines.push('UID:' + icsEscape(ev.id || Math.random().toString(36).slice(2)) + '@dsh-pixel-pet')
    lines.push('DTSTAMP:' + stamp)
    if (/^\d{2}:\d{2}$/.test(String(ev.time || ''))) lines.push('DTSTART:' + compact(ev.date) + 'T' + ev.time.replace(':', '') + '00')
    else lines.push('DTSTART;VALUE=DATE:' + compact(ev.date))
    lines.push('SUMMARY:' + icsEscape(ev.title || '（无标题）'))
    const desc = []
    if (ev.note) desc.push(ev.note)
    if (ev.lunar && ev.lunar.month) desc.push('农历 ' + (ev.lunar.leap ? '闰' : '') + ev.lunar.month + ' 月 ' + ev.lunar.day + ' 日')
    if (ev.kind) desc.push('类型：' + ev.kind)
    if (ev.done === true) desc.push('已完成')
    if (desc.length) lines.push('DESCRIPTION:' + icsEscape(desc.join('\n')))
    const rule = { yearly: 'YEARLY', monthly: 'MONTHLY', weekly: 'WEEKLY' }[ev.repeat]
    if (rule && !ev.lunar) lines.push('RRULE:FREQ=' + rule)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return fb } }
const readLines = (f) => {
  try { return readFileSync(f, 'utf8').split('\n').map((l) => { try { return l.trim() ? JSON.parse(l) : null } catch { return null } }).filter(Boolean) } catch { return [] }
}

export function buildDiaryMd (dataDir) {
  const dir = join(dataDir, 'diary')
  const months = safeDir(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()
  if (!months.length) return ''
  const out = ['# 桌宠日记', '']
  for (const f of months) {
    const rows = readLines(join(dir, f)).filter((r) => r && r.text).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    let day = ''
    for (const r of rows) {
      const date = String(r.date || String(r.at).slice(0, 10))
      if (date !== day) { day = date; out.push('## ' + date, '') }
      out.push('- ' + String(r.at).slice(11, 16) + (r.mood ? '（' + r.mood + '）' : '') + ' ' + String(r.text).replace(/\r?\n/g, ' '))
    }
    out.push('')
  }
  return out.join('\n')
}

export function buildMailMd (dataDir) {
  const dir = join(dataDir, 'mailbox')
  const items = [...(readJson(join(dir, 'inbox.json'), { items: [] }).items || [])]
  for (const f of safeDir(dir).filter((n) => /^archive-\d{6}\.jsonl$/.test(n)).sort()) items.push(...readLines(join(dir, f)))
  if (!items.length) return ''
  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const out = ['# 信件', '']
  for (const it of items) {
    out.push('## ' + (it.dir === 'in' ? '我写给桌宠' : '桌宠写给我') + ' · ' + String(it.createdAt || '').slice(0, 16).replace('T', ' ') + (it.subject ? ' · ' + it.subject : ''), '', String(it.body || ''), '')
  }
  return out.join('\n')
}

const FILE_CAP = 64 * 1024 * 1024
const TOTAL_CAP = 256 * 1024 * 1024

/** 把目录里的文件（不跟链接）按相对路径放进 zip 条目；超过上限的记进 skipped */
function addTree (entries, dir, prefix, state, only = () => true) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.isSymbolicLink() || !only(e.name, dir)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { addTree(entries, p, prefix + '/' + e.name, state); continue }
    let size = 0
    try { size = statSync(p).size } catch { continue }
    if (size > FILE_CAP || state.total + size > TOTAL_CAP) { state.skipped.push(prefix + '/' + e.name); continue }
    try { entries.push({ name: prefix + '/' + e.name, data: readFileSync(p) }); state.total += size } catch { state.skipped.push(prefix + '/' + e.name) }
  }
}

/**
 * 导出自己的记录。scope 'records'：日程 .ics + 日记 .md；'all'：再加信件、克隆音色、阅读记录。
 * -> Buffer(zip)
 */
export function buildExport (dataDir, scope = 'records', now = new Date()) {
  const entries = []
  const state = { total: 0, skipped: [] }
  const events = readJson(join(dataDir, 'calendar', 'events.json'), { items: [] }).items
  if (Array.isArray(events) && events.length) entries.push({ name: '日程.ics', data: buildIcs(events, now) })
  const diary = buildDiaryMd(dataDir)
  if (diary) entries.push({ name: '日记.md', data: diary })
  if (scope === 'all') {
    const mail = buildMailMd(dataDir)
    if (mail) entries.push({ name: '信件.md', data: mail })
    addTree(entries, join(dataDir, 'mailbox', 'files'), '信件附件', state)
    for (const n of safeDir(join(dataDir, 'voices')).filter((x) => /^clone-[0-9a-f]{10}$/.test(x))) addTree(entries, join(dataDir, 'voices', n), '克隆音色/' + n, state)
    addTree(entries, join(dataDir, 'reading'), '阅读记录', state, (name) => name !== 'webview')
  }
  if (state.skipped.length) entries.push({ name: '没能导出的文件.txt', data: state.skipped.join('\n') + '\n' })
  if (!entries.length) entries.push({ name: '空.txt', data: '没有可导出的记录。\n' })
  return zipBuffer(entries, now)
}

// ---------------------------------------------------------------- 删除编排

/**
 * @param {object} o
 *   dataDir, clapDir, roots
 *   hooks: { settings, patchSettings, petRunning, stopPet, startPet, stopInstaller, stopMusic, resetReading,
 *            stopWriters, markPurged, autoInstall(on) }
 */
export function createCleanup ({ dataDir, clapDir, roots, hooks = {}, logger, retries = 6, retryMs = 500 } = {}) {
  const h = hooks
  const log = (m) => { try { logger?.info?.(m) } catch {} }
  const allRoots = roots || [dataDir, clapDir].filter(Boolean)
  const call = async (name, ...a) => { try { return typeof h[name] === 'function' ? await h[name](...a) : undefined } catch (e) { log('[cleanup] ' + name + ' 失败：' + String((e && e.message) || e).slice(0, 120)); return undefined } }
  let busy = false

  /** 删一批目标；占用时等一会儿重试（刚停掉的进程要一两秒才放手），仍占用就如实返回 busy */
  async function purgeList (targets) {
    let freed = 0
    for (const t of targets) {
      let r
      for (let i = 0; i <= retries; i++) {
        r = purge(t, { roots: allRoots, log })
        if (r.ok || r.code !== 'busy') break
        await sleep(retryMs)
      }
      if (!r.ok) return { ok: false, code: r.code, message: r.code === 'busy' ? '有程序还在用，关掉桌宠再试' : r.message, freed }
      freed += r.bytes
    }
    return { ok: true, freed }
  }

  /** 哪些进程要先停 */
  const NEEDS = {
    voice: ['pet', 'installer'],
    speaker: ['pet', 'installer'],
    listen: ['music'],
    reading: ['reading', 'pet'],
    records: [],
  }

  async function deleteCategory (category) {
    if (!(category in NEEDS)) return { ok: false, code: 'bad_category', message: '不认识的类别' }
    if (busy) return { ok: false, code: 'busy', message: '另一项清理正在进行' }
    busy = true
    let petWas = false
    try {
      const need = NEEDS[category]
      if (need.includes('pet')) { petWas = !!(await call('petRunning')); if (petWas) await call('stopPet') }
      if (need.includes('installer')) await call('stopInstaller')
      if (need.includes('music')) await call('stopMusic')
      if (need.includes('reading')) await call('stopReading')
      const r = await purgeList(categoryTargets(category, { dataDir, clapDir }))
      if (r.ok) {
        if (category === 'voice' || category === 'speaker') await call('autoInstall', false)
        if (category === 'listen') await call('patchSettings', { listen: { clap: false } })
        if (category === 'reading') await call('resetReading')
        if (category === 'records') await call('resetCalendar')
      }
      return r.ok ? { ok: true, freed: r.freed } : r
    } finally {
      if (petWas) await call('startPet')
      busy = false
    }
  }

  /** 清除全部数据：先停一切，再逐个子目录 purge，最后数据目录本身只剩空壳 */
  async function clearAll (confirm) {
    if (confirm !== CONFIRM_WORD) return { ok: false, code: 'confirm', message: '需要输入「' + CONFIRM_WORD + '」' }
    if (busy) return { ok: false, code: 'busy', message: '另一项清理正在进行' }
    busy = true
    try {
      await call('stopPet')
      await call('stopInstaller')
      await call('stopMusic')
      await call('stopReading')
      await call('stopWriters')
      await call('markPurged')
      const targets = []
      if (existsSync(dataDir)) for (const n of safeDir(dataDir)) targets.push(join(dataDir, n))
      for (const n of safeDir(clapDir)) targets.push(join(clapDir, n))
      const r = await purgeList(targets)
      if (!r.ok) return { ok: false, code: r.code, message: r.message, freed: r.freed }
      return { ok: true, freed: r.freed, python: 'untouched' }
    } finally { busy = false }
  }

  /** 路由。-> true when handled */
  async function handle (req, res, { path, send, readBody, host }) {
    if (!path.startsWith('/api/cleanup/')) return false
    const origin = req.headers.origin
    if (origin && origin !== 'http://' + host) { send(res, 403, { ok: false }); return true }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) { send(res, 403, { ok: false }); return true }
    const op = path.slice('/api/cleanup/'.length)
    if (req.method === 'GET' && op === 'sizes') {
      send(res, 200, { ok: true, sizes: await collectSizes({ dataDir, clapDir }) }); return true
    }
    if (req.method !== 'POST') { send(res, 405, { ok: false }); return true }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { send(res, 415, { ok: false }); return true }
    let body = {}
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') } catch { send(res, 400, { ok: false }); return true }
    if (op === 'delete') { const r = await deleteCategory(String(body.category || '')); send(res, r.ok ? 200 : (r.code === 'busy' ? 409 : 400), r); return true }
    if (op === 'all') { const r = await clearAll(body.confirm); send(res, r.ok ? 200 : (r.code === 'busy' ? 409 : 400), r); return true }
    if (op === 'export') {
      const buf = buildExport(dataDir, body.scope === 'all' ? 'all' : 'records')
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('桌宠记录导出.zip'),
      })
      res.end(buf); return true
    }
    send(res, 404, { ok: false }); return true
  }

  return { handle, deleteCategory, clearAll, sizes: () => collectSizes({ dataDir, clapDir }) }
}
