/**
 * 「活动与额度」页签 · 额度侧（2026-11-15 需求 04）。
 *
 * 每 5 分钟用 lib/balance.js 的查询（get(false)，恰好等于缓存 TTL）查一次余额，写
 * <dataDir>/quota-log.jsonl：{"t":"2026-11-15T14:05:00+08:00","provider":"deepseek","balance":12.34}
 *
 *   - 只写成功的：没配 key / 网络失败 / 返回异常一律跳过，绝不写 0 或估出来的值（图上不能有假点）
 *   - key 永不落日志，日志只有 t / provider / balance
 *   - 同一分钟重复采样时后写覆盖（按本地分钟去重）
 *   - 30 天滚动删除（写时顺带整枝，每小时至多一次）
 *   - 采样用一个单一定时器（5 分钟，另有一个起来后 8 s 的首采），随插件起停；页面不触发采样
 *
 * 设置项 settings.insight = { on: true }（默认开；关掉 = 只停采样，不动已存的记录）。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOfficialBase } from './balance.js'
import { dayBounds } from './activity-day.js'

export const INSIGHT_DEFAULT = Object.freeze({ on: true })
export const QUOTA_FILE = 'quota-log.jsonl'
export const SAMPLE_EVERY_MS = 5 * 60_000
export const FIRST_SAMPLE_MS = 8_000
export const KEEP_DAYS = 30
const PROVIDER = 'deepseek'

const pad = (n) => String(n).padStart(2, '0')
/** 本地时区 ISO（同 activity.py 的写法，Date.parse 可读） */
export const isoLocal = (t = Date.now()) => {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
}

const round2 = (v) => Math.round(v * 100) / 100

export function sanitizeInsight (cur, patch) {
  const c = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const on = typeof p.on === 'boolean' ? p.on : (typeof c.on === 'boolean' ? c.on : true)
  return { on }
}

/** 采样能不能出数：配了 key 且是官方 baseUrl（同 balance.js 的口径） */
export function quotaConfigured (dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'balance-settings.json'), 'utf8'))
    return !!(s && typeof s.key === 'string' && s.key && isOfficialBase(s.baseUrl))
  } catch { return false }
}

/**
 * 采样器。getBalance = () => balance.get(false)（异步，失败/没配 -> null）。
 * start() 随插件起停；sample() 单独暴露给测试手动驱动。
 */
export function createQuotaSampler ({ dataDir, getBalance, now = Date.now, logger = null }) {
  const file = join(dataDir, QUOTA_FILE)
  let timer = null
  let first = null
  let prunedAt = 0

  const prune = (t) => {
    if (t - prunedAt < 3600_000) return
    prunedAt = t
    try {
      const cutoff = t - KEEP_DAYS * 86_400_000
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const keep = lines.filter((l) => {
        try { return Date.parse(JSON.parse(l).t) >= cutoff } catch { return true }
      })
      if (keep.length !== lines.length) {
        const tmp = file + '.' + process.pid + '.tmp'
        writeFileSync(tmp, keep.map((l) => l + '\n').join(''), 'utf8')
        renameSync(tmp, file)
      }
    } catch {}
  }

  const write = (rec, t) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      let lines = null
      try { lines = readFileSync(file, 'utf8').split('\n') } catch {}
      if (lines && lines.length > 1) {
        // 同一分钟重复采样：后写覆盖（覆盖最后一行）
        const idx = lines.length - 2 // split 末尾留了 ''
        let last = null
        try { last = JSON.parse(lines[idx]) } catch {}
        if (last && typeof last.t === 'string' && last.t.slice(0, 16) === rec.t.slice(0, 16)) {
          lines[idx] = JSON.stringify(rec)
          const tmp = file + '.' + process.pid + '.tmp'
          writeFileSync(tmp, lines.filter((l) => l).map((l) => l + '\n').join(''), 'utf8')
          renameSync(tmp, file)
          prune(t)
          return
        }
      }
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
      prune(t)
    } catch (e) { logger?.warn?.('[dsh-pixel-pet] 额度采样写入失败：' + String((e && e.message) || e).slice(0, 160)) }
  }

  const sample = async () => {
    let b = null
    try { b = await Promise.resolve(getBalance()).catch(() => null) } catch { b = null }
    const total = b && typeof b.total === 'number' && Number.isFinite(b.total) ? b.total : null
    if (total == null) return false // 只写成功的：绝不写假点
    write({ t: isoLocal(now()), provider: PROVIDER, balance: total }, now())
    return true
  }

  const stop = () => {
    if (first) { clearTimeout(first); first = null }
    if (timer) { clearInterval(timer); timer = null }
  }
  const start = () => {
    if (timer) return stop
    first = setTimeout(() => { sample().catch(() => {}) }, FIRST_SAMPLE_MS)
    if (typeof first.unref === 'function') first.unref()
    timer = setInterval(() => { sample().catch(() => {}) }, SAMPLE_EVERY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return stop
  }

  return { start, stop, sample }
}

/**
 * 按本地日读额度记录：同一分钟去重（后写覆盖）、按时间升序。
 * -> { date, points: [{t, balance}], first, last, spent }
 * spent 只有 ≥2 个点才算（第一次 − 最后一次；花了就是正数），否则 null。
 */
export function quotaDay (dataDir, date) {
  const b = dayBounds(date)
  const empty = { points: [], first: null, last: null, spent: null }
  if (!b) return empty
  let text = ''
  try { text = readFileSync(join(dataDir, QUOTA_FILE), 'utf8') } catch { return { ...empty } }
  const byMinute = new Map() // 本地分钟 -> { ms, t, balance }（同一分钟的后写覆盖）
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const ms = Date.parse(j.t)
      if (!Number.isFinite(ms) || typeof j.balance !== 'number' || !Number.isFinite(j.balance)) continue
      if (ms < b.from || ms >= b.to) continue
      byMinute.set(String(j.t).slice(0, 16), { ms, t: String(j.t), balance: j.balance })
    } catch {}
  }
  const points = [...byMinute.values()].sort((x, y) => x.ms - y.ms).map((x) => ({ t: x.t, balance: x.balance }))
  const first = points.length ? points[0].balance : null
  const last = points.length ? points[points.length - 1].balance : null
  const spent = points.length >= 2 ? round2(first - last) : null
  return { points, first, last, spent }
}
