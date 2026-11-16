/**
 * ICS 订阅（只读）：Outlook / Google / iCloud 等都能给出一个 https 订阅链接。
 *
 * 安全与边界：
 *   - 只收 https（webcal:// 转 https）；redirect: 'manual' 自己跟，绝不跟到非 https；最多 3 跳。
 *   - 单个 ≤ 5 MB、超时 20 s（覆盖到读完正文为止）、不带 cookie / 任何凭据；
 *     有 content-length 且超限直接拒，没有就按流读、累计超限立即中止。
 *   - 解析用 vendor/ical.js（Mozilla，MPL-2.0，es5 CJS 构建）；处理 RRULE / EXDATE / TZID / 全天。
 *     重复事件迭代上限 5000，窗口开始之前只跳过、不收集（2020 年开始的每日事件 2026 年仍能看到）。
 *   - 缓存 <dataDir>/calendar/cache/sub-<id>.json：{ fetchedAt, events: [{ title, date, time, endDate?, allDay }] }。
 *     date / time 是**本地墙钟**（TZID 换算成本地；UTC 也换算本地；全天用 ICS 里的日期本身，不过 Date），
 *     只存标题和起止，描述、地点、参会人、订阅链接一律不存。旧格式（start/end 字段）读到就丢弃，等下次刷新。
 *   - 失败保留旧缓存。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIMIT_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 20_000
const WINDOW_DAYS = 92
const MAX_HOPS = 3
const ITER_MAX = 5000

let ICAL = null
try { ICAL = createRequire(import.meta.url)(join(HERE, '..', 'vendor', 'ical.js', 'ical.es5.cjs')) } catch { /* vendor 缺失：订阅不可用 */ }

const pad = (n) => String(n).padStart(2, '0')
const clampText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)

/** webcal:// -> https://；其余非 https 一律 null */
export function normalizeUrl (raw) {
  const s = String(raw || '').trim()
  const withHttps = s.startsWith('webcal://') ? 'https://' + s.slice(9) : s
  try {
    const u = new URL(withHttps)
    if (u.protocol !== 'https:') return null
    return u.href
  } catch { return null }
}

const localDate = (ms) => {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const localTime = (ms) => {
  const d = new Date(ms)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 某时区的墙钟 -> UTC 毫秒（用 Intl 两遍收敛；vendor 的 ical.js v2 不带时区库，TZID 当 floating） */
const zonedWallToUtcMs = (y, mo, d, h, mi, tz) => {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const wall = Date.UTC(y, mo - 1, d, h, mi)
    const offAt = (ms) => {
      const p = {}
      for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = Number(x.value)
      return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ms
    }
    let ms = wall - offAt(wall)
    ms = wall - offAt(ms)
    return ms
  } catch { return Date.UTC(y, mo - 1, d, h, mi) }
}

/** 某时区的墙钟字段 -> UTC 毫秒（Intl 两遍收敛） */
const timeToUtcMs = (y, mo, d, h, mi, tz) => zonedWallToUtcMs(y, mo, d, h, mi, tz)

/**
 * 解析一段 ICS 文本 -> [{ title, date:'YYYY-MM-DD', time:'HH:MM'|'', endDate?, allDay }]
 * date/time 为**本地墙钟**：TZID 换算到该时区的墙钟再落字段（时区无关）；全天用 ICS 里的日期本身。
 * 窗口 [fromMs, toMs) 内的展开结果。
 */
export function parseIcs (text, fromMs = Date.now(), toMs = fromMs + WINDOW_DAYS * 86_400_000) {
  if (!ICAL || typeof text !== 'string' || !text) return null
  try {
    const comp = new ICAL.Component(ICAL.parse(text))
    const out = []
    for (const vevent of comp.getAllSubcomponents('vevent')) {
      let ev
      try { ev = new ICAL.Event(vevent) } catch { continue }
      const title = clampText(ev.summary)
      if (!title) continue
      const start = ev.startDate
      if (!start) continue
      const allDay = !!start.isDate // DTSTART 是 DATE（非 DATE-TIME）= 全天
      const duration = ev.duration
      const startTzid = (vevent.getFirstProperty('dtstart')?.getParameter('tzid')) || null
      const endProp = vevent.getFirstProperty('dtend')
      const endTzid = (endProp?.getParameter('tzid')) || startTzid
      const utcOf = (t, tzid) => {
        if (allDay) return null
        const zoneId = (t.zone && t.zone.tzid) || '' // ical.js v2 没有 is_utc 属性，看 zone.tzid
        if (zoneId === 'UTC') return t.toUnixTime() * 1000
        if (tzid && tzid !== 'UTC') return timeToUtcMs(t.year, t.month, t.day, t.hour, t.minute, tzid)
        return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second || 0).getTime() // floating：本机墙钟
      }
      const pushOccurrence = (t, endT) => {
        // 全天：不经过 Date，用 ICAL.Time 的墙钟字段本身
        const date = allDay ? t.year + '-' + pad(t.month) + '-' + pad(t.day) : localDate(utcOf(t, startTzid))
        const time = allDay ? '' : localTime(utcOf(t, startTzid))
        const startMs = allDay ? new Date(t.year, t.month - 1, t.day).getTime() : utcOf(t, startTzid)
        const durMs = Math.min(duration ? duration.toSeconds() * 1000 : 0, 30 * 86_400_000)
        const endMs = startMs + Math.max(0, durMs)
        if (startMs >= toMs || endMs < fromMs) return
        const entry = {
          title,
          date,
          time,
          endDate: durMs > 0 ? (endT && allDay ? endT.year + '-' + pad(endT.month) + '-' + pad(endT.day) : localDate(endMs)) : undefined,
          allDay,
        }
        if (!entry.endDate) delete entry.endDate
        out.push(entry)
      }
      const endT = ev.endDate || null
      if (ev.isRecurring()) {
        const it = ev.iterator()
        let guard = 0
        while (guard++ < ITER_MAX) {
          let t
          try { t = it.next() } catch { break }
          if (!t) break
          const ms = allDay ? new Date(t.year, t.month - 1, t.day).getTime() : utcOf(t, startTzid)
          if (ms > toMs) break
          if (ms + 86_400_000 < fromMs) continue // 窗口开始之前：只跳过、不收集
          pushOccurrence(t, allDay ? endT : t)
        }
      } else {
        pushOccurrence(start, allDay ? endT : start)
      }
    }
    out.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')))
    return out.slice(0, 400)
  } catch { return null }
}

/** 缓存条目是不是新格式（date/time 字段）；旧格式（start 字段）返回 false */
const isNewFormat = (cache) => {
  try {
    if (!cache || !Array.isArray(cache.events)) return false
    if (cache.events.length === 0) return true
    return cache.events.every((e) => typeof e.date === 'string' && typeof e.time === 'string')
  } catch { return false }
}

export function createIcs ({ dataDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const cacheDir = dataDir ? join(dataDir, 'calendar', 'cache') : null
  const cacheFile = (id) => (cacheDir ? join(cacheDir, 'sub-' + String(id).replace(/^sub-/, '').replace(/[^a-z0-9-]/gi, '') + '.json') : null)

  const readCache = (id) => {
    const f = cacheFile(id)
    if (!f) return null
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (!j || !Array.isArray(j.events)) return null
      if (!isNewFormat(j)) return null // 旧格式（UTC ISO start 字段）丢弃，等下次刷新
      return j
    } catch { return null }
  }
  const writeCache = (id, data) => {
    const f = cacheFile(id)
    if (!f) return false
    try {
      mkdirSync(dirname(f), { recursive: true })
      const tmp = f + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(data), 'utf8')
      renameSync(tmp, f)
      return true
    } catch { return false }
  }

  /** 限时读正文：content-length 超限直接拒；没有就按流读、累计超限立即中止 */
  const readBodyLimited = async (res, ctl, limit) => {
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > limit) throw new Error('订阅内容超过 5 MB')
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
    if (!reader) {
      const buf = await res.arrayBuffer()
      if (buf.byteLength > limit) throw new Error('订阅内容超过 5 MB')
      return new TextDecoder('utf-8').decode(buf)
    }
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) { try { await reader.cancel() } catch {} throw new Error('订阅内容超过 5 MB') }
      chunks.push(value)
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
  }

  /** 抓一个订阅源：手工跟 https 重定向；成功写缓存并返回 events；失败 -> { ok:false, message } */
  const fetchSub = async (id, url) => {
    const u0 = normalizeUrl(url)
    if (!u0 || !cacheDir || typeof fetchImpl !== 'function') return { ok: false, message: '订阅链接只收 https' }
    let u = u0
    try {
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const ctl = new AbortController()
        const timer = setTimeout(() => { try { ctl.abort() } catch {} }, timeoutMs) // 超时覆盖到读完正文（finally 才清）
        let text
        try {
          const res = await fetchImpl(u, { redirect: 'manual', signal: ctl.signal, headers: { Accept: 'text/calendar' } })
          const loc = res.headers.get('location')
          if (res.status >= 301 && res.status <= 308 && loc) {
            const next = new URL(loc, u)
            if (next.protocol !== 'https:') return { ok: false, message: '订阅跳转到了非 https，已拒绝' }
            u = next.href
            continue
          }
          if (!res.ok) return { ok: false, message: '订阅地址回 ' + res.status }
          text = await readBodyLimited(res, ctl, LIMIT_BYTES)
        } finally { clearTimeout(timer) }
        const events = parseIcs(text, now(), now() + WINDOW_DAYS * 86_400_000)
        if (!events) return { ok: false, message: '订阅内容不是能解析的日历' }
        const data = { fetchedAt: new Date(now()).toISOString(), events } // 缓存不存 url（链接可能带私密 token）
        writeCache(id, data)
        return { ok: true, events }
      }
      return { ok: false, message: '订阅重定向次数太多' }
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e).slice(0, 100) }
    }
  }

  return { fetchSub, readCache, parseIcs }
}
