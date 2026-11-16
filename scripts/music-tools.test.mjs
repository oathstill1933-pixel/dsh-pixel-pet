// 一起听歌 v2 · AI 工具 / 推荐 / 桌宠歌单（注入式假 music；示例数据全为虚构）
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMusicTools } from '../lib/music-tools.js'
import { createMusicDaily, musicLink, localDate } from '../lib/music-daily.js'

let n = 0
const ok = (name) => { n++; console.log('ok ' + n + ' - ' + name) }
const tmp = () => mkdtempSync(join(tmpdir(), 'pp-music-ai-'))

const snap = (title = '示例曲目', artist = '示例艺人') => ({
  ok: true, enabled: true, source: 'local', app: 'netease', playing: true,
  track: { title, artist, album: '', duration: 259, cover: '/api/music/cover?v=1', path: 'D:\\secret\\a.mp3' },
  position: 148.2, lyric: { available: true, index: 12, line: '示例歌词一行', next: '…' },
  spectrum: { available: true, bars: [0.1] }, heard: { available: true, sentence: '测到的特征：响度偏高', engine: 'numpy' },
  daily: null, capabilities: { seek: false },
})
const fakeMusic = ({ s = snap(), local = [], linkOk = true, playSong = 'fail' } = {}) => {
  const calls = []
  return {
    calls,
    now: async () => s,
    localList: async () => ({ ok: true, index: -1, items: local }),
    control: async (b, o) => {
      calls.push({ ...b, user: o && o.user })
      // 网易云点播（2026-11-15）：默认按「搜不到」处理，让老用例照旧走搜索页兜底
      if (b.action === 'play_song') {
        if (playSong === 'ok') return { code: 200, body: { ok: true, data: { title: '虚构之歌', artist: '虚构乐队', album: '', vip: false, confirmed: true } } }
        if (playSong === 'ambiguous') return { code: 200, body: { ok: false, code: 'ambiguous', message: '没找到歌名和歌手都对得上的那首', data: { candidates: [{ title: '虚构之歌', artist: '别的乐队', album: '' }] } } }
        return { code: 502, body: { ok: false, code: 'search_failed', message: '网易云没搜到' } }
      }
      return b.action === 'open_link' && !linkOk ? { code: 403, body: { ok: false, message: '第一次打开音乐链接需要用户在小卡片上点一下' } } : { code: 200, body: { ok: true } }
    },
  }
}
const mkSettings = (enabled) => () => ({ listen: { enabled, python: '' }, voice: { llm: { sessionId: 'sess-1' } } })
const registered = (defs, s) => defs.filter((d) => typeof d.when !== 'function' || d.when(s)).map((d) => d.name)
const setup = (opt = {}, enabled = true) => {
  const dir = tmp(); const S = mkSettings(enabled); const m = fakeMusic(opt)
  const d = createMusicDaily({ dataDir: dir, settings: S })
  const t = Object.fromEntries(createMusicTools({ music: m, daily: d, settings: S }).tools().map((x) => [x.name, x]))
  return { dir, m, d, t }
}
const NAMES = ['pixelpet_audio_listen', 'pixelpet_music_now', 'pixelpet_music_control', 'pixelpet_music_recommend', 'pixelpet_music_playlist']

// 1. when 开关
{
  const { t } = setup({}, false)
  const defs = Object.values(t)
  assert.deepEqual(defs.map((x) => x.name), NAMES)
  assert.equal(registered(defs, mkSettings(false)()).length, 0)
  assert.equal(registered(defs, {}).length, 0)
  assert.equal(registered(defs, mkSettings(true)()).length, 5)
  for (const x of defs) assert.equal((await x.execute({ action: 'list', title: '虚构之歌' })).ok, false)
  ok('when：关时无听歌工具（执行也拒绝），开时 5 个')
}

// 2. now 不含路径/封面
{
  const { t } = setup()
  const r = await t.pixelpet_music_now.execute({})
  assert.equal(r.ok, true)
  assert.ok(!/secret|\.mp3|cover/.test(JSON.stringify(r)))
  assert.match(r.message, /测到的/)
  ok('now：只读精简视图，不含路径/封面')
}

// 3. control
{
  const { t, m } = setup()
  assert.equal((await t.pixelpet_music_control.execute({ action: 'next' })).ok, true)
  assert.equal((await t.pixelpet_music_control.execute({ action: 'local_add' })).ok, false)
  assert.deepEqual(m.calls, [{ action: 'next', user: false }])
  ok('control：透传、user:false，local_add 拒绝')
}

// 4. recommend：只记录，不自动打开；daily 为最近一次
{
  const { t, d, dir, m } = setup()
  const r = await t.pixelpet_music_recommend.execute({ title: '虚构之歌', artist: '虚构乐队', note: '节奏轻' })
  assert.equal(r.ok, true); assert.equal(m.calls.length, 0)
  const j = JSON.parse(readFileSync(join(dir, 'music', 'daily.json'), 'utf8'))
  assert.equal(j.date, localDate()); assert.equal(j.linkKind, 'search')
  assert.equal(j.link, 'https://music.163.com/#/search/m/?s=' + encodeURIComponent('虚构之歌 虚构乐队') + '&type=1')
  await t.pixelpet_music_recommend.execute({ title: '另一首虚构歌' })
  assert.equal(d.today().title, '另一首虚构歌')
  ok('recommend：写 daily.json（最近一次），默认不播放')
}

// 5. recommend play:true：本地有 → local_play；没有 → open_link 搜索页；未授权如实报
{
  const a = setup({ local: [{ index: 0, title: '别的歌', artist: '' }, { index: 3, title: '虚构之歌', artist: '虚构乐队' }] })
  const r1 = await a.t.pixelpet_music_recommend.execute({ title: '虚构之歌', artist: '虚构乐队', play: true })
  assert.equal(r1.ok, true); assert.equal(r1.data.played, 'local')
  assert.deepEqual(a.m.calls, [{ action: 'local_play', value: 3, user: false }])
  const b = setup()
  const r2 = await b.t.pixelpet_music_recommend.execute({ title: '虚构之歌', play: true })
  assert.equal(r2.data.played, 'link'); assert.match(r2.message, /需要用户在客户端里点播放/)
  assert.equal(b.m.calls[0].action, 'play_song') // 先试网易云点播，搜不到再退回搜索页
  assert.equal(b.m.calls[1].action, 'open_link'); assert.match(b.m.calls[1].value, /^https:\/\/music\.163\.com\/#\/search/)
  const c = setup({ linkOk: false })
  const r3 = await c.t.pixelpet_music_recommend.execute({ title: '虚构之歌', play: true })
  assert.equal(r3.ok, false); assert.match(r3.message, /小卡片上点一下/)
  ok('recommend play：本地优先，否则搜索页，未授权如实失败')
}

// 6. 歌单 增/列/去重/删/播
{
  const { t, dir, m } = setup({ local: [{ index: 1, title: '虚构之歌二', artist: '' }] })
  const P = t.pixelpet_music_playlist
  assert.equal((await P.execute({ action: 'list' })).data.length, 0)
  assert.equal((await P.execute({ action: 'add', title: '虚构之歌一', artist: '虚构乐队', note: '收藏' })).ok, true)
  assert.equal((await P.execute({ action: 'add', title: '虚构之歌二' })).ok, true)
  assert.equal((await P.execute({ action: 'add', title: '虚构之歌一', artist: '虚构乐队' })).ok, false)
  assert.equal((await P.execute({ action: 'add' })).ok, false)
  const file = JSON.parse(readFileSync(join(dir, 'music', 'pet-playlist.json'), 'utf8'))
  assert.equal(file.length, 2); assert.equal(file[0].note, '收藏'); assert.ok(Number(file[0].addedAt) > 0)
  const l = await P.execute({ action: 'list' })
  assert.deepEqual(l.data.map((x) => x.title), ['虚构之歌一', '虚构之歌二'])
  const p1 = await P.execute({ action: 'play', index: 1 })
  assert.equal(p1.data.played, 'local'); assert.deepEqual(m.calls.at(-1), { action: 'local_play', value: 1, user: false })
  const p2 = await P.execute({ action: 'play', title: '虚构之歌一' })
  assert.equal(p2.data.played, 'link'); assert.equal(m.calls.at(-1).action, 'open_link')
  assert.equal((await P.execute({ action: 'play', index: 9 })).ok, false)
  assert.equal((await P.execute({ action: 'remove', title: '虚构之歌一' })).ok, true)
  assert.equal((await P.execute({ action: 'remove', index: 5 })).ok, false)
  assert.deepEqual((await P.execute({ action: 'list' })).data.map((x) => x.title), ['虚构之歌二'])
  ok('歌单：增、去重、列、本地/链接播放、移除')
}

// 7. 链接生成
{
  assert.equal(musicLink({ title: '虚构之歌', artist: '虚构乐队', app: 'qqmusic' }).link, 'https://y.qq.com/n/ryqq/search?w=' + encodeURIComponent('虚构之歌 虚构乐队') + '&t=song')
  assert.equal(musicLink({ title: 'a&b', app: 'other' }).link, 'https://music.163.com/#/search/m/?s=a%26b&type=1')
  assert.equal(musicLink({}).linkKind, 'none')
  ok('链接：QQ/网易云搜索页、编码')
}

// 8. observe 只记历史、不推荐；关闭不记；30 天清理
{
  const { d, dir } = setup()
  assert.equal(d.observe(snap('虚构甲', '虚构乐队')), null)
  d.observe(snap('虚构甲', '虚构乐队')); d.observe(snap('虚构乙', '虚构乐队'))
  const h = readFileSync(join(dir, 'music', 'history.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x))
  assert.deepEqual(h.map((x) => x.title), ['虚构甲', '虚构乙']); assert.ok(!h.some((x) => 'path' in x))
  assert.ok(!existsSync(join(dir, 'music', 'daily.json')))
  const off = setup({}, false); off.d.observe(snap()); assert.ok(!existsSync(join(off.dir, 'music')))
  const dir2 = tmp(); mkdirSync(join(dir2, 'music'))
  writeFileSync(join(dir2, 'music', 'history.jsonl'), JSON.stringify({ at: Date.now() - 31 * 86_400_000, title: '旧虚构歌', artist: '' }) + '\n')
  createMusicDaily({ dataDir: dir2, settings: mkSettings(true) }).record({ title: '新虚构歌', artist: 'x' })
  const h2 = readFileSync(join(dir2, 'music', 'history.jsonl'), 'utf8').trim().split('\n')
  assert.equal(h2.length, 1); assert.match(h2[0], /新虚构歌/)
  ok('observe：只记切歌、不自动推荐；关闭不写；30 天清理')
}

// 网易云点播（play_song）——工具层
{
  const a = setup({ playSong: 'ok' })
  const r1 = await a.t.pixelpet_music_control.execute({ action: 'play_song', title: '虚构之歌', artist: '虚构乐队' })
  assert.equal(r1.ok, true); assert.match(r1.message, /网易云在放了/)
  assert.deepEqual(a.m.calls[0], { action: 'play_song', value: { title: '虚构之歌', artist: '虚构乐队' }, user: false })
  const b = setup({ playSong: 'ambiguous' })
  const r2 = await b.t.pixelpet_music_control.execute({ action: 'play_song', title: '虚构之歌' })
  assert.equal(r2.ok, false); assert.equal(r2.data.candidates.length, 1)
  const c = setup({ playSong: 'ok' })
  const r3 = await c.t.pixelpet_music_recommend.execute({ title: '虚构之歌', artist: '虚构乐队', play: true })
  assert.equal(r3.ok, true); assert.equal(r3.data.played, 'netease')
  assert.equal(c.m.calls.filter((x) => x.action === 'open_link').length, 0, '点播成功就不再开搜索页')
  const d2 = setup({ playSong: 'ambiguous' })
  const r4 = await d2.t.pixelpet_music_recommend.execute({ title: '虚构之歌', play: true })
  assert.equal(r4.ok, false); assert.equal(r4.data.played, 'ambiguous'); assert.equal(r4.data.candidates.length, 1)
  const q = setup({ s: { ...snap(), app: 'qqmusic' }, playSong: 'ok' })
  await q.t.pixelpet_music_recommend.execute({ title: '虚构之歌', play: true })
  assert.equal(q.m.calls.some((x) => x.action === 'play_song'), false, 'QQ 音乐不走点播')
  ok('play_song：成功 / 版本对不上给候选 / 推荐 play:true 优先点播 / QQ 音乐不点播')
}

// DSH 要求工具结果能原样转 JSON；没标签时 tags: undefined 让 pixelpet_music_now 整个报错
{
  const { brief } = await import('../lib/music-tools.js')
  const undefKeys = (o, p = '') => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => (v === undefined ? [p + k] : undefKeys(v, p + k + '.'))) : [])
  const base = { source: 'cloud', playing: true, track: { title: 'x', artist: 'y' }, position: 3, heard: { available: true, sentence: '测到的特征：…' }, daily: { title: 'a' } }
  assert.deepEqual(undefKeys(brief(base)), [], '无标签：不许有 undefined 字段')
  assert.equal('tags' in brief(base), false)
  assert.deepEqual(undefKeys(brief({ source: 'none' })), [])
  const withTags = brief({ ...base, heard: { ...base.heard, tags: { mood: [['伤感', 0.5]] } } })
  assert.deepEqual(withTags.tags, { mood: [['伤感', 0.5]] })
  ok('brief：任何字段都不是 undefined（无标签时不带 tags）')
}

console.log('# music-tools: ' + n + ' passed')
