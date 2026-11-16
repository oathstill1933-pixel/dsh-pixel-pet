/**
 * 常见国际节日 / 纪念日：内置规则表（固定日 + 「5 月第二个周日」这类浮动规则）。
 * 二三十条常用项。纯计算，不联网。
 */

/** 固定日：MM-DD → 名称 */
const FIXED = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '10-01': '国庆节',
  '10-24': '程序员节',
  '10-31': '万圣节',
  '11-01': '万圣节次日',
  '12-24': '平安夜',
  '12-25': '圣诞节',
}

/** 浮动规则：{ m, n, wd, name } → 每年 m 月第 n 个周 wd（0=周日，1=周一…；n<0 = 倒数第 n 个） */
const FLOATING = [
  { m: 5, n: 2, wd: 0, name: '母亲节' },
  { m: 6, n: 3, wd: 0, name: '父亲节' },
  { m: 11, n: 4, wd: 4, name: '感恩节' },
]

/** 某年 m 月第 n 个周 wd 的日期；n<0 = 倒数第 n 个 */
function nthWeekday (year, m, n, wd) {
  const firstWd = new Date(year, m - 1, 1).getDay()
  let day = 1 + ((wd - firstWd) + 7) % 7
  if (n < 0) {
    const last = new Date(year, m, 0).getDate()
    const lastWd = new Date(year, m - 1, last).getDay()
    day = last - ((lastWd - wd) + 7) % 7
  } else {
    day += (Math.abs(n) - 1) * 7
  }
  return { m, d: day }
}

const pad = (n) => String(n).padStart(2, '0')
const key = (y, m, d) => y + '-' + pad(m) + '-' + pad(d)

/** 某天的国际节日名数组 */
export function intlFestivals (y, m, d) {
  const out = []
  const k = pad(m) + '-' + pad(d)
  if (FIXED[k]) out.push(FIXED[k])
  for (const r of FLOATING) {
    if (r.m !== m) continue
    const hit = nthWeekday(y, m, r.n, r.wd)
    if (hit.d === d) out.push(r.name)
  }
  return out
}

/** 某年母亲节 / 父亲节等的日期（nearLine / 测试用）；按名称查 */
export function intlDate (year, name) {
  for (const r of FLOATING) {
    if (r.name === name) { const h = nthWeekday(year, r.m, r.n, r.wd); return key(year, h.m, h.d) }
  }
  for (const [k, n] of Object.entries(FIXED)) {
    if (n === name) return year + '-' + k
  }
  return null
}

export const INTL_NAMES = [...new Set([...Object.values(FIXED), ...FLOATING.map((r) => r.name)])]
