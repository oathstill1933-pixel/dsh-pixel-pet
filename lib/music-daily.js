/**
 * 一起听歌 v2 · 收听记录 / 推荐 / 桌宠自己的歌单（MUSIC_CONTRACT.md；不再自动推荐）。
 *
 * - 不定时、不自动问会话：推荐只在用户叫醒桌宠说「推荐一首」时，由 AI 调 pixelpet_music_recommend 写入。
 * - <dataDir>/music/history.jsonl：now 快照切歌时记一行 { at, title, artist, app }，只留 30 天；不记路径/歌词/音频。
 * - <dataDir>/music/daily.json：最近一次推荐 { date, title, artist, note, app, link, linkKind, at }（now 里只读带出，卡片不用）。
 * - <dataDir>/music/pet-playlist.json：桌宠自己的歌单 [{ title, artist, note?, addedAt }]。
 * - 链接：拿不到歌曲 ID（不调私有接口），只给官方网页搜索页，linkKind:'search'。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_MS = 30 * 86_400_000
const HISTORY_MAX_PROMPT = 40
const PLAYLIST_MAX = 200
const STR_MAX = 120
const NOTE_MAX = 200

const clean = (v, n = STR_MAX) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)

export function localDate (t = Date.now()) {
  const d = new Date(t)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 官方网页搜索页；app = qqmusic → QQ 音乐，其余 → 网易云 */
export function musicLink ({ title, artist, app } = {}) {
  const q = encodeURIComponent([clean(title), clean(artist)].filter(Boolean).join(' '))
  if (!q) return { link: '', linkKind: 'none' }
  if (app === 'qqmusic') return { link: 'https://y.qq.com/n/ryqq/search?w=' + q + '&t=song', linkKind: 'search' }
  return { link: 'https://music.163.com/#/search/m/?s=' + q + '&type=1', linkKind: 'search' }
}

export function createMusicDaily ({ dataDir, settings, now = () => Date.now(), logger } = {}) {
  const dir = join(dataDir, 'music')
  const histFile = join(dir, 'history.jsonl')
  const dailyFile = join(dir, 'daily.json')
  const listFile = join(dir, 'pet-playlist.json')
  const on = () => { try { const s = settings(); return !!(s && s.listen && s.listen.enabled === true) } catch { return false } }
  const ensureDir = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }
  const writeJson = (f, v) => { ensureDir(); const tmp = f + '.tmp'; writeFileSync(tmp, JSON.stringify(v, null, 2)); renameSync(tmp, f) }
  let lastKey = null

  /** 最近一次推荐（只读；now 快照带出） */
  function today () { try { const d = JSON.parse(readFileSync(dailyFile, 'utf8')); return d && d.title ? d : null } catch { return null } }

  function readHistory () {
    try { return readFileSync(histFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
  }

  function record (track, app) {
    const title = clean(track && track.title)
    if (!title) return false
    const artist = clean(track.artist)
    const key = title + '\u0000' + artist
    if (key === lastKey) return false
    lastKey = key
    const rows = readHistory()
    const last = rows[rows.length - 1]
    if (last && last.title === title && last.artist === artist) return false
    ensureDir()
    const t = now()
    const fresh = rows.filter((r) => t - Number(r.at || 0) < KEEP_MS)
    const line = JSON.stringify({ at: t, title, artist, app: app || null }) + '\n'
    if (fresh.length !== rows.length) {
      const tmp = histFile + '.tmp'
      writeFileSync(tmp, fresh.map((r) => JSON.stringify(r) + '\n').join('') + line)
      renameSync(tmp, histFile)
    } else appendFileSync(histFile, line)
    return true
  }

  /** 最近听过（去重，新的在前），给推荐工具当参考 */
  function summary (max = HISTORY_MAX_PROMPT) {
    const t = now()
    const rows = readHistory().filter((r) => t - Number(r.at || 0) < KEEP_MS)
    const seen = new Set(); const out = []
    for (let i = rows.length - 1; i >= 0 && out.length < max; i--) {
      const r = rows[i]; const k = r.title + ' — ' + (r.artist || '')
      if (seen.has(k)) continue
      seen.add(k); out.push(r.artist ? k : r.title)
    }
    return out
  }

  function recommend ({ title, artist, note, app } = {}) {
    const t = clean(title)
    if (!t) return { ok: false, message: '缺少歌名' }
    const a = clean(artist)
    const d = { date: localDate(now()), title: t, artist: a, note: clean(note, NOTE_MAX), app: app || null, ...musicLink({ title: t, artist: a, app }), at: now() }
    writeJson(dailyFile, d)
    return { ok: true, daily: d }
  }

  /** now 快照后调用：只记切歌，不触发任何推荐 */
  function observe (snap) {
    if (!on()) return null
    try { if (snap && snap.track) record(snap.track, snap.app) } catch { logger?.warn?.('[dsh-pixel-pet] 收听记录写入失败') }
    return today()
  }

  // ---- 桌宠自己的歌单
  function playlist () {
    try { const a = JSON.parse(readFileSync(listFile, 'utf8')); return Array.isArray(a) ? a.filter((x) => x && x.title) : [] } catch { return [] }
  }
  function playlistAdd ({ title, artist, note } = {}) {
    const t = clean(title)
    if (!t) return { ok: false, message: '缺少歌名' }
    const a = clean(artist)
    const list = playlist()
    if (list.some((x) => x.title === t && (x.artist || '') === a)) return { ok: false, message: '歌单里已经有这首了' }
    if (list.length >= PLAYLIST_MAX) return { ok: false, message: '歌单满了（' + PLAYLIST_MAX + ' 首）' }
    const item = { title: t, artist: a, ...(clean(note, NOTE_MAX) ? { note: clean(note, NOTE_MAX) } : {}), addedAt: now() }
    list.push(item); writeJson(listFile, list)
    return { ok: true, item, index: list.length - 1 }
  }
  /** index 优先；否则按歌名（+歌手）找 */
  function playlistFind ({ index, title, artist } = {}) {
    const list = playlist()
    if (Number.isInteger(index)) return index >= 0 && index < list.length ? { list, i: index } : { list, i: -1 }
    const t = clean(title); const a = clean(artist)
    return { list, i: t ? list.findIndex((x) => x.title === t && (!a || x.artist === a)) : -1 }
  }
  function playlistRemove (q) {
    const { list, i } = playlistFind(q)
    if (i < 0) return { ok: false, message: '歌单里没找到这首' }
    const [item] = list.splice(i, 1); writeJson(listFile, list)
    return { ok: true, item }
  }

  const link = (o) => musicLink(o).link
  return { observe, today, recommend, record, summary, link, playlist, playlistAdd, playlistRemove, playlistFind, files: { histFile, dailyFile, listFile } }
}
