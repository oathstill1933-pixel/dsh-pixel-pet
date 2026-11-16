/**
 * 一起听歌 v2 · L7 AI 工具（MUSIC_CONTRACT.md）。全部 when: s => s.listen?.enabled === true —— 关着时 AI 看不到。
 * 取数经宿主内部 music 与 daily；路径工具由宿主检查允许目录。
 */
const CONTROL = ['toggle', 'play', 'pause', 'next', 'prev', 'volume', 'seek', 'source', 'open_link', 'local_play', 'play_song']
const when = (s) => s?.listen?.enabled === true

const clock = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }

/** 快照 → 给 AI 的精简只读视图（白名单字段，不带封面/路径） */
export function brief (snap) {
  if (!snap || typeof snap !== 'object') return { source: 'none' }
  const t = snap.track || null
  const ly = snap.lyric || {}
  // 任何字段都不能是 undefined——DSH 要求工具结果能原样转 JSON，
  // 原先没标签时 tags: undefined，整个 pixelpet_music_now 报「value is not lossless JSON」
  const out = {
    source: snap.source || 'none',
    app: snap.app || null,
    playing: !!snap.playing,
    track: t ? { title: t.title || '', artist: t.artist || '', album: t.album || '', duration: Number(t.duration) || 0 } : null,
    position: Number(snap.position) || 0,
    lyric: ly.available ? { prev: ly.prev || '', line: ly.line || '', next: ly.next || '' } : null,
    heard: snap.heard && snap.heard.available ? snap.heard.sentence || '' : '',
    daily: snap.daily ? { title: snap.daily.title || '', artist: snap.daily.artist || '', note: snap.daily.note || '' } : null,
    capabilities: snap.capabilities || {},
  }
  if (snap.heard && snap.heard.available && snap.heard.tags) out.tags = snap.heard.tags
  return out
}

export function sentence (b) {
  if (!b.track) return '现在没有在放歌（或没连上音乐客户端）。'
  const t = b.track
  let s = '《' + (t.title || '未命名') + '》' + (t.artist ? ' — ' + t.artist : '') + '（' + clock(b.position) + (t.duration ? ' / ' + clock(t.duration) : '') + (b.playing ? '，播放中' : '，暂停') + '）'
  if (b.lyric && b.lyric.line) s += '\n当前歌词：' + b.lyric.line
  // 有「模型听着像」标签时，句子里已经写明是模型猜的，不再追一句「不代表听懂了情绪、乐器或曲风」自相矛盾
  if (b.heard) s += '\n' + b.heard + (b.tags ? '' : '（测到的声学特征，不代表听懂了情绪、乐器或曲风）')
  return s
}

export function createMusicTools ({ music, daily, settings } = {}) {
  const on = () => { try { return when(settings()) } catch { return false } }
  const off = { ok: false, message: '「一起听歌」没有打开。' }
  const output = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: !v || typeof v !== 'object' ? String(v) : v.data === undefined ? String(v.message) : String(v.message) + '\n' + JSON.stringify(v.data, null, 2) }],
  }
  const fileOutput = {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: v?.ok ? '《' + v.file + '》' + v.seconds + ' 秒：' + v.sentence : String(v?.message || '无法分析这段音频。') }],
  }
  const curApp = async () => { try { return (await music.now())?.app || null } catch { return null } }
  const ctl = async (action, value) => { try { return (await music.control({ action, value }, { user: false })) || {} } catch (e) { return { body: { ok: false, message: String(e && e.message || e) } } } }
  /** 本地队列里有同名曲目 → 本地播；否则打开客户端搜索页（需用户在客户端里点播放） */
  async function playSong (song, app) {
    let local = null
    try { local = typeof music.localList === 'function' ? await music.localList() : null } catch {}
    const hit = local && local.ok && (local.items || []).find((x) => x.title === song.title && (!song.artist || !x.artist || x.artist === song.artist))
    if (hit) {
      const r = await ctl('local_play', hit.index)
      if (r.body && r.body.ok) return { ok: true, how: 'local', message: '已在本地播放。' }
    }
    // 网易云：直接点播（搜歌拿编号 → orpheus:// 打开即播）；QQ 音乐没有这条路
    if (app !== 'qqmusic') {
      const r = await ctl('play_song', { title: song.title, artist: song.artist })
      const b = (r && r.body) || {}
      if (b.ok) return { ok: true, how: 'netease', message: b.data && b.data.confirmed ? '网易云已经在放了。' : '已让网易云播放这首（还没确认切过去，可以过几秒用 pixelpet_music_now 看看）。' }
      if (b.code === 'ambiguous') return { ok: false, how: 'ambiguous', message: b.message, candidates: (b.data && b.data.candidates) || [] }
    }
    const url = daily.link({ title: song.title, artist: song.artist, app })
    if (!url) return { ok: false, how: 'none', message: '生成不了链接。' }
    const r = await ctl('open_link', url)
    if (r.body && r.body.ok) return { ok: true, how: 'link', message: '本地没有这首，已打开' + (app === 'qqmusic' ? ' QQ 音乐' : '网易云') + '搜索页，需要用户在客户端里点播放。' }
    return { ok: false, how: 'link', message: (r.body && r.body.message) || '打不开链接', link: url }
  }
  const tools = () => [
    {
      name: 'pixelpet_audio_listen',
      when,
      description: '一起听歌：听一段本地音频文件（不播放），返回测到的声学特征，开了 CLAP 时附「听着像」的标签。只能读用户在设置里允许的文件夹。不转写说话内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: fileOutput,
      timeoutMs: 62_000,
      async execute (args) {
        if (!on()) return off
        const result = await music.listenFile(args?.path)
        return JSON.parse(JSON.stringify(result))
      },
    },
    {
      name: 'pixelpet_music_now',
      when,
      description: '一起听歌：读用户此刻在听的歌（歌名、歌手、进度、当前歌词行前后一句、测到的声学特征、今日推荐）。只读。特征是测出来的数值描述，不等于听懂情绪；tags 是模型猜的，说的时候用「听着像」，别当成事实。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      timeoutMs: 15_000,
      async execute () {
        if (!on()) return off
        let snap = null
        try { snap = await music.now() } catch {}
        const b = brief(snap)
        return { ok: !!(snap && snap.ok !== false), message: sentence(b), data: b }
      },
    },
    {
      name: 'pixelpet_music_control',
      when,
      description: '一起听歌：控制用户的播放器。action：toggle/play/pause/next/prev、volume(value 0-100)、seek(value 秒，仅支持时)、source(value cloud|local)、open_link(打开今日推荐的搜索页)、local_play、play_song（在网易云里直接放指定的歌：给 title，最好也给 artist；歌名歌手对不上时会返回候选，先问用户要哪个版本）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: CONTROL },
          value: { type: ['number', 'string'] },
          title: { type: 'string', description: 'play_song：歌名' },
          artist: { type: 'string', description: 'play_song：歌手（建议给，用来挑对版本）' },
        },
        required: ['action'], additionalProperties: false,
      },
      output,
      timeoutMs: 15_000,
      async execute (args) {
        if (!on()) return off
        const action = String(args && args.action || '')
        if (!CONTROL.includes(action)) return { ok: false, message: '不支持的操作' }
        let r
        const value = action === 'play_song' ? { title: String(args.title || args.value || ''), artist: String(args.artist || '') } : args.value
        try { r = await music.control(value === undefined ? { action } : { action, value }, { user: false }) } catch (e) { r = { code: 500, body: { ok: false, message: String(e && e.message || e) } } }
        const body = (r && r.body) || {}
        if (action === 'play_song') {
          const d = body.data || {}
          if (body.ok) return { ok: true, message: (d.confirmed ? '网易云在放了：' : '已让网易云播放（还没确认切过去）：') + '《' + d.title + '》' + (d.artist ? ' — ' + d.artist : '') + (d.vip ? '（会员歌曲，非会员可能只有试听）' : ''), data: { title: d.title || '', artist: d.artist || '', album: d.album || '', confirmed: !!d.confirmed } }
          return { ok: false, message: body.message || '失败', ...(d.candidates ? { data: { candidates: d.candidates } } : {}) }
        }
        return body.ok ? { ok: true, message: '已执行 ' + action + '。' } : { ok: false, message: body.message || '失败' }
      },
    },
    {
      name: 'pixelpet_music_recommend',
      when,
      description: '一起听歌：用户让你推荐一首时用。记下推荐（歌名、歌手、一句理由）；play:true 同时打开播放。理由说你为什么选，别冒称听懂了情绪。',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, artist: { type: 'string' }, note: { type: 'string' }, play: { type: 'boolean' } },
        required: ['title'], additionalProperties: false,
      },
      output,
      timeoutMs: 20_000,
      async execute (args) {
        if (!on()) return off
        const a = args || {}
        const app = await curApp()
        const r = daily.recommend({ title: a.title, artist: a.artist, note: a.note, app })
        if (!r.ok) return { ok: false, message: r.message }
        const d = r.daily
        const name = '《' + d.title + '》' + (d.artist ? ' — ' + d.artist : '')
        const data = { title: d.title, artist: d.artist, note: d.note, recent: daily.summary(10) }
        if (a.play !== true) return { ok: true, message: '已记下推荐：' + name, data }
        const p = await playSong(d, app)
        return { ok: p.ok, message: '已记下推荐：' + name + '。' + p.message, data: { ...data, played: p.how, ...(p.candidates ? { candidates: p.candidates } : {}) } }
      },
    },
    {
      name: 'pixelpet_music_playlist',
      when,
      description: '一起听歌：你自己的歌单。用户让你放你的歌单、或你想收藏一首时用。action：list / add(title, artist?, note?) / remove(index 或 title) / play(index 或 title)。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'play'] },
          title: { type: 'string' }, artist: { type: 'string' }, note: { type: 'string' }, index: { type: 'integer', minimum: 0 },
        },
        required: ['action'], additionalProperties: false,
      },
      output,
      timeoutMs: 20_000,
      async execute (args) {
        if (!on()) return off
        const a = args || {}
        const show = (l) => l.map((x, i) => ({ index: i, title: x.title, artist: x.artist || '', note: x.note || '' }))
        if (a.action === 'list') { const l = daily.playlist(); return { ok: true, message: l.length ? '歌单共 ' + l.length + ' 首。' : '歌单还是空的。', data: show(l) } }
        if (a.action === 'add') { const r = daily.playlistAdd(a); return r.ok ? { ok: true, message: '已加入歌单：《' + r.item.title + '》', data: { index: r.index } } : r }
        if (a.action === 'remove') { const r = daily.playlistRemove(a); return r.ok ? { ok: true, message: '已从歌单移除：《' + r.item.title + '》' } : r }
        if (a.action === 'play') {
          const { list, i } = daily.playlistFind(a)
          if (i < 0) return { ok: false, message: '歌单里没找到这首' }
          const p = await playSong(list[i], await curApp())
          return { ok: p.ok, message: '《' + list[i].title + '》：' + p.message, data: { played: p.how } }
        }
        return { ok: false, message: '不支持的操作' }
      },
    },
  ]
  return { tools }
}
