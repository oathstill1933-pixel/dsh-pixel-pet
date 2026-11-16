/**
 * 农历 / 节气 / 黄历 —— vendor/lunar-javascript（MIT，6tail）的薄包装。
 * 插件零依赖：用 createRequire 引入 vendor/lunar-javascript/lunar.js（vendor/package.json 声明 commonjs）。
 * 只给日历用：公历 ↔ 农历、节气、传统节日、宜忌、冲煞、农历生日换算。不联网。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let L = null
try { L = createRequire(import.meta.url)(join(HERE, '..', 'vendor', 'lunar-javascript', 'lunar.js')) } catch { /* vendor 缺失：农历相关全部降级为空 */ }

const LEAP_NAME = '闰'
/** 公历 y-m-d → 农历描述；vendor 缺失或异常 → null */
export function lunarOf (y, m, d) {
  if (!L) return null
  try {
    const lunar = L.Solar.fromYmd(y, m, d).getLunar()
    return {
      yearGanZhi: lunar.getYearInGanZhi(),
      text: lunar.getMonthInChinese() + '月' + lunar.getDayInChinese(),
      leap: lunar.getMonth() < 0,
      month: Math.abs(lunar.getMonth()),
      day: lunar.getDay(),
      term: lunar.getJieQi() || '',   // 当天恰逢节气 / 节日名，否则空
      festivals: (lunar.getFestivals() || []).map((f) => String(f)),
    }
  } catch { return null }
}

/** 农历某年某月（1..12，leap=true 为闰月）存在吗；不存在返回 null */
function lunarMonth (y, month, leap) {
  const ly = L.LunarYear.fromYear(y)
  let lm = ly.getMonth(leap ? -month : month)
  // 闰月生日在非闰年按正月份
  if (!lm && leap) lm = ly.getMonth(month)
  return lm || null
}

/**
 * 农历 y-月-日（闰月 leap）在「年 year」对应的公历日期 'YYYY-MM-DD'。
 * 当年该月没有三十 → 廿九（钳到当月最后一天）；闰月不在则按正月份。
 * -> 'YYYY-MM-DD' | null（vendor 缺失 / 参数非法）
 */
export function lunarToSolar (year, month, day, leap = false) {
  if (!L) return null
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 30) return null
  try {
    const candidates = leap ? [-month, month] : [month] // 闰月生日在非闰年按正月份
    for (const m of candidates) {
      const lm = L.LunarYear.fromYear(year).getMonth(m)
      if (!lm) continue
      const dd = Math.min(day, lm.getDayCount()) // 小月没有三十 → 廿九
      return L.Lunar.fromYmd(lm.getYear(), m, dd).getSolar().toYmd()
    }
    return null
  } catch { return null }
}

/** 农历日的中文名（显示用）：初一显示月名（闰月带「闰」），其余 「初七 / 廿九 …」 */
const MONTH_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
/** 农历月号 -> 中文月名（10 → 十，11 → 冬，12 → 腊） */
export const lunarMonthName = (month) => MONTH_CN[(Number(month) || 1) - 1] || String(month)

export function lunarDayLabel (y, m, d) {
  const info = lunarOf(y, m, d)
  if (!info) return ''
  const leapName = info.leap ? LEAP_NAME : ''
  if (info.day === 1) return leapName + lunarMonthName(info.month) + '月' // 初一显示中文月名（不是数字）
  return leapName + info.text.replace(/^.*?月/, '') // 「十月廿六」→「廿六」
}

/** 某天的黄历：{ yi: [], ji: [], chong: '', sha: '' } | null */
export function almanacOf (y, m, d) {
  if (!L) return null
  try {
    const lunar = L.Solar.fromYmd(y, m, d).getLunar()
    return {
      yi: (lunar.getDayYi() || []).slice(0, 8),
      ji: (lunar.getDayJi() || []).slice(0, 8),
      chong: lunar.getDayChongDesc() || '',
      sha: lunar.getDaySha() || '',
    }
  } catch { return null }
}

/** 当天是传统节日（春节 / 元宵 / 端午 / 中秋 / 七夕 / 重阳 …），-> 名称数组 */
export function lunarFestivals (y, m, d) {
  const info = lunarOf(y, m, d)
  return info ? info.festivals : []
}

/** 当天的节气名（当天恰逢节气才非空） */
export function solarTerm (y, m, d) {
  const info = lunarOf(y, m, d)
  return info ? info.term : ''
}

/** 农历描述一行（当日栏用）：「十月廿六 · 乙巳年」| null */
export function lunarLine (y, m, d) {
  const info = lunarOf(y, m, d)
  if (!info) return null
  const leapName = info.leap ? LEAP_NAME : ''
  const dayText = info.day === 1 ? leapName + info.month + '月' : info.text
  return dayText + ' · ' + info.yearGanZhi + '年'
}

/** 农历月的实有天数（小月 29 / 大月 30；换算生日钳位用），vendor 缺失 → null */
export function lunarMonthDays (year, month, leap = false) {
  if (!L) return null
  try {
    const lm = lunarMonth(year, month, leap)
    return lm ? lm.getDayCount() : null
  } catch { return null }
}
