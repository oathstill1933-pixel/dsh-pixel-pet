/**
 * 桌宠自己的日记 —— `diary/YYYY-MM.jsonl`（一行一条）+ 回收站 `diary/.trash/YYYY-MM.jsonl`（30 天后清）
 * + 计数 `diary/state.json` { turnsSince, lastAt, hintSince }。
 *
 * - 时间戳由宿主生成，不信 AI 给的；每天最多 8 条；text ≤ 300 字，mood ≤ 8 字。
 * - 只有桌宠写。用户能看、能删（进回收站），不能改。
 * - 计数按聊天轮：宿主在 relay onTurn（source ∈ hub/mail/reading/music 且 ok）时调 bumpTurns()；
 *   主动关心、提醒这类桌宠自己发起的叫醒不算。跨天、重启接着数（落盘）。
 *   到阈值后捎带一次（decorate），捎带过或写入成功都把 turnsSince 归零，不追着催。
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const PAD = (n) => String(n).padStart(2, '0')
const TEXT_MAX = 300
const MOOD_MAX = 8
const PER_DAY_MAX = 8
const TRASH_KEEP_MS = 30 * 86_400_000

const isoLocal = (t = Date.now()) => {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate()) +
    'T' + PAD(d.getHours()) + ':' + PAD(d.getMinutes()) + ':' + PAD(d.getSeconds()) +
    sign + PAD(Math.floor(Math.abs(off) / 60)) + ':' + PAD(Math.abs(off) % 60)
}

export function createDiary ({ dataDir, now = Date.now, randomId }) {
  const dir = dataDir ? join(dataDir, 'diary') : null
  const trashDir = dir ? join(dir, '.trash') : null
  const stateFile = dir ? join(dir, 'state.json') : null
  const newId = randomId || (() => 'dy-' + Math.random().toString(36).slice(2, 10))

  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\x1f\u007f]+/g, ' ').trim()
  const dayOf = (t) => { const d = new Date(t); return d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate()) }

  const readMonth = (month, trash = false) => {
    const base = trash ? trashDir : dir
    if (!base) return []
    let text = ''
    try { text = readFileSync(join(base, month + '.jsonl'), 'utf8') } catch { return [] }
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { const j = JSON.parse(line); if (j && j.id && j.text) out.push(j) } catch {}
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  const pruneTrash = () => {
    if (!trashDir) return
    let files = []
    try { files = readdirSync(trashDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)) } catch { return }
    const cutoff = now() - TRASH_KEEP_MS
    for (const f of files) {
      const full = join(trashDir, f)
      const month = f.slice(0, 7)
      const rows = readMonth(month, true).filter((r) => Date.parse(r.at) >= cutoff)
      try {
        if (rows.length) writeFileSync(full, rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
        else unlinkSync(full)
      } catch {}
    }
  }

  /** 写一条。-> { ok } | { ok:false, message } */
  const write = ({ text, mood } = {}) => {
    const t = now()
    const body = clean(text, TEXT_MAX + 1).slice(0, TEXT_MAX)
    if (!body) return { ok: false, message: '要写点什么' }
    const m = clean(mood, MOOD_MAX + 1).slice(0, MOOD_MAX)
    const month = dayOf(t).slice(0, 7)
    const entry = { id: newId(), at: isoLocal(t), date: dayOf(t), mood: m, text: body }
    try {
      mkdirSync(dir, { recursive: true })
      const dayCount = readMonth(month).filter((r) => r.date === entry.date).length
      if (dayCount >= PER_DAY_MAX) return { ok: false, message: '今天已经写了 8 条，明天再记吧' }
      appendFileSync(join(dir, month + '.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      return { ok: false, message: '日记写不进去：' + String((e && e.message) || e).slice(0, 80) }
    }
    resetTurns()
    return { ok: true, entry }
  }

  /** 按月 / 关键字读（日记本页 + AI 工具共用） */
  const list = ({ month, query, limit = 30 } = {}) => {
    if (!dir) return []
    const months = []
    if (month && MONTH_RE.test(month)) months.push(month)
    else {
      try {
        for (const f of readdirSync(dir)) if (/^\d{4}-\d{2}\.jsonl$/.test(f)) months.push(f.slice(0, 7))
      } catch {}
      months.sort().reverse()
    }
    const q = clean(query, 60).toLowerCase()
    const out = []
    for (const mo of months) {
      for (const r of readMonth(mo)) {
        if (q && !(r.text.toLowerCase().includes(q) || (r.mood || '').toLowerCase().includes(q))) continue
        out.push(r)
        if (out.length >= Math.max(1, Math.min(200, Math.round(Number(limit) || 30)))) return out
      }
      if (month) break
    }
    return out
  }

  /** 删除 = 移进回收站；30 天后清 */
  const remove = (id) => {
    const wanted = String(id || '')
    if (!wanted || !dir) return { ok: false, message: '没有这条' }
    try {
      for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))) {
        const month = f.slice(0, 7)
        const rows = readMonth(month)
        const hit = rows.find((r) => r.id === wanted)
        if (!hit) continue
        const left = rows.filter((r) => r.id !== wanted)
        writeFileSync(join(dir, f), left.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
        mkdirSync(trashDir, { recursive: true })
        appendFileSync(join(trashDir, f), JSON.stringify(hit) + '\n', 'utf8')
        pruneTrash()
        return { ok: true }
      }
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e).slice(0, 80) }
    }
    return { ok: false, message: '没有这条' }
  }

  // ---- 聊天轮计数（diary/state.json）
  const readState = () => {
    try {
      const o = JSON.parse(stateFile ? readFileSync(stateFile, 'utf8') : 'null')
      return { turnsSince: Number.isInteger(o.turnsSince) && o.turnsSince >= 0 ? o.turnsSince : 0, lastAt: typeof o.lastAt === 'string' ? o.lastAt : '', hintAt: typeof o.hintAt === 'string' ? o.hintAt : '' }
    } catch { return { turnsSince: 0, lastAt: '', hintAt: '' } }
  }
  const writeState = (o) => {
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = stateFile + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(o, null, 1), 'utf8')
      renameSync(tmp, stateFile)
    } catch {}
  }

  /** 聊天成功一轮（hub/mail/reading/music）→ +1。返回当前计数（提示用） */
  const bumpTurns = () => {
    const st = readState()
    st.turnsSince++
    writeState(st)
    return st.turnsSince
  }
  const resetTurns = () => {
    const st = readState()
    if (st.turnsSince || st.hintAt) { st.turnsSince = 0; st.hintAt = ''; writeState(st) }
  }
  /** 到阈值了吗。捎带过但没写也只把 turnsSince 归零——再聊满阈值还能再次捎带，hintAt 只是记录 */
  const needsHint = (threshold) => {
    if (!Number.isInteger(threshold) || threshold <= 0) return false
    return readState().turnsSince >= threshold
  }
  const turnsSince = () => readState().turnsSince
  const markedHint = () => {
    const st = readState()
    if (!st.turnsSince) return
    st.turnsSince = 0
    st.hintAt = isoLocal(now())
    writeState(st)
  }

  return { write, list, remove, bumpTurns, needsHint, markedHint, resetTurns, turnsSince, PER_DAY_MAX }
}
