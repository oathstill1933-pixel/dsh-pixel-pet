/**
 * 中国法定节假日 + 调休（holiday-cn，MIT 数据，自动抓国务院公告）。
 *
 * - 主地址 https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json，
 *   失败回落 https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json（两者本机均可达，2026-11-15 核实）。
 * - 缓存 <dataDir>/calendar/cache/holiday-cn-{year}.json；随插件带当年/次年快照 vendor/holiday-cn/{year}.json。
 *   读的顺序：缓存 → 快照 → null（绝不编数据）。缓存文件保持 holiday-cn 原始格式。
 * - 只有用户点「更新」，或开着该源且缺下一年文件时每周自动试一次（11 月至次年 1 月）。
 * - 格式 { year, days: [{ name, date, isOffDay }] }，isOffDay:false 为调休上班。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/'
const FALLBACK = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/'
const TIMEOUT_MS = 20_000

export const HOLIDAY_FILE = (year) => 'holiday-cn-' + year + '.json'

/** 校验并解析 holiday-cn JSON -> { year, days: { 'MM-DD': { name, isOff } } } | null */
export function parseHoliday (j) {
  try {
    if (!j || typeof j !== 'object' || !Number.isInteger(j.year) || !Array.isArray(j.days)) return null
    const days = {}
    for (const d of j.days) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) || typeof d.name !== 'string') continue
      days[String(d.date).slice(5)] = { name: String(d.name).slice(0, 20), isOff: d.isOffDay !== false }
    }
    return { year: j.year, days }
  } catch { return null }
}

export function createHoliday ({ dataDir, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS, vendorRoot = join(HERE, '..', 'vendor', 'holiday-cn') }) {
  const cacheDir = dataDir ? join(dataDir, 'calendar', 'cache') : null

  const readJson = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }
  const writeJson = (file, obj) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(obj), 'utf8')
      renameSync(tmp, file)
      return true
    } catch { return false }
  }

  /** 某年数据：缓存 → 快照；解析失败当没有。-> { year, days } | null */
  const yearData = (year) => {
    if (!Number.isInteger(year) || year < 2020 || year > 2100) return null
    const name = HOLIDAY_FILE(year)
    for (const dir of [cacheDir, vendorRoot]) {
      if (!dir) continue
      const parsed = parseHoliday(readJson(join(dir, name)))
      if (parsed && parsed.year === year) return parsed
    }
    return null
  }

  /** 某天：'YYYY-MM-DD' -> { name, isOff } | null（法定节假日与调休上班都返回） */
  const lookup = (date) => {
    const y = Number(String(date).slice(0, 4))
    const data = yearData(y)
    return data ? (data.days[String(date).slice(5)] || null) : null
  }

  /** 已有快照 / 缓存的年份（界面上「已有 2026、2027」） */
  const years = () => {
    const out = new Set()
    for (const dir of [cacheDir, vendorRoot]) {
      if (!dir) continue
      try {
        for (const f of readdirSync(dir)) {
          const m = /^holiday-cn-(\d{4})\.json$/.exec(f)
          if (m) out.add(Number(m[1]))
        }
      } catch {}
    }
    return [...out].sort()
  }

  /** 抓一年 -> 写缓存（保持 holiday-cn 原始 JSON）。-> bool */
  const refresh = async (year) => {
    if (!cacheDir || typeof fetchImpl !== 'function' || !Number.isInteger(year)) return false
    for (const base of [MAIN, FALLBACK]) {
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => { try { ctl.abort() } catch {} }, timeoutMs)
        let text = ''
        try {
          const res = await fetchImpl(base + year + '.json', { signal: ctl.signal, headers: { Accept: 'application/json' } })
          if (!res.ok) continue
          text = await res.text()
        } finally { clearTimeout(timer) }
        const raw = JSON.parse(text)
        const parsed = parseHoliday(raw)
        if (!parsed || parsed.year !== year) continue
        return writeJson(join(cacheDir, HOLIDAY_FILE(year)), raw)
      } catch { /* 下一个地址 */ }
    }
    return false
  }

  return { yearData, lookup, years, refresh }
}
