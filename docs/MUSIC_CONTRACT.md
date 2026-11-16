# 一起听歌 v2 · 接口约定（2026-11-14 冻结，改动需同步三方）

方案依据：维护者的离线拓展包方案（不随仓库发布）第十五节。
旧版 `web/listen.*`、`lib/listen.js`、`pixelpet_listen_*` 与 dsh_music 播放器全部退役（由 music-ai 清理）。

## 进程结构

```
桌宠小卡片 web/card.*  ──HTTP──>  宿主 lib/music.js  /api/music/*  ──JSON 行 stdio──>  runtime/music/ (python -m pixelmusic)
                                       │                                         ├─ smtc.py     云端客户端（网易云/QQ 音乐）状态与控制
AI 工具 lib/music-tools.js ────────────┤                                         ├─ local.py    本地文件播放（用户选的文件/文件夹）
每日推荐 lib/music-daily.js ───────────┘                                         ├─ lyrics.py   .lrc / LRCLIB 公开歌词库
                                                                                 ├─ loopback.py 回环录音 → 实时频谱/特征（仅内存）
                                                                                 └─ songmap.py  整曲分析（从归档 dsh_music 迁入）
```

- 音乐服务 Python：`settings.listen.python`；为空时用 `<dataDir>/listen.json` 的 `python`；都没有则报「未配置」。
- 该解释器需要同时具备：原 `dsh-music` 的全部依赖 + `pywebview` 6.2.1 + `pythonnet` 3.2.1。
- 注意：`pythonnet` 在部分 Windows 环境下（venv 放在非系统盘时）加载 .NET 的 `Python.Runtime.dll` 会失败；遇到这种情况把 venv 建在系统盘的用户目录下即可。插件源码里**不得**硬编码任何具体路径。
- 小卡片窗口：桌宠运行时（`runtime/pixelpet/card_dock.py` CardHost）用同一个 Python 启动 `python -m pixelmusic.cardwin --url <宿主>/card --dock <dataDir>/card-dock.json --parent <桌宠 pid>`。pywebview 无边框窗口 + 窗口区域（展开：圆角卡；收起：圆形黑胶）。「一起听歌」开启时自动开（收起态）；关闭/桌宠退出时关；页面的 × 或右键黑胶关闭后退出码 3，本次会话不再自动弹。设置页「打开小卡片」→ `POST /api/open {page:'card'}` 或 `POST /api/card/open` → 桌宠 `card` 命令；桌宠没运行时返回提示。页面经 `window.pywebview.api.set_mode('mini'|'full') / close()` 与窗口进程通信。
- 服务按需拉起（「一起听歌」开启且卡片打开或工具调用时），空闲 60 s 退出；`listen.enabled` 关闭立即停止并释放录音设备。

## 统一快照 `GET /api/music/now`

```json
{
  "ok": true,
  "enabled": true,
  "source": "cloud" | "local" | "none",
  "app": "netease" | "qqmusic" | "other" | null,
  "playing": true,
  "track": { "title": "示例曲目", "artist": "示例艺人", "album": "", "duration": 259.0, "cover": "/api/music/cover?v=abc" },
  "position": 148.2,
  "lyric": { "available": true, "index": 12, "line": "示例歌词一行", "next": "…" },
  "spectrum": { "available": true, "bars": [0.1, 0.4, "… 48 个 0-1"] },
  "heard": { "available": true, "sentence": "测到的特征：……（模型开着时句尾附「模型听着像：…」）", "engine": "librosa" | "numpy", "tags": { "mood": [["伤感", 0.52]], "genre": [["民谣", 0.47]], "inst": [["吉他", 0.61]] } } | 同左无 tags,
  "daily": { "date": "2026-11-14", "title": "", "artist": "", "note": "", "link": "" } | null,
  "capabilities": { "seek": false, "playSpecific": false, "loopback": true }
}
```

- 卡片 ~15 fps 轮询 `GET /api/music/live`（只含 position / playing / lyric.index / spectrum.bars，体积小）；`/now` 1 s 一次或事件触发。
- `cover` 只给宿主内路径，**不外泄本地文件路径**；本地封面由服务读出后经宿主转发。

## 控制 `POST /api/music/control`

`{ action: "toggle"|"play"|"pause"|"next"|"prev"|"volume"|"seek"|"source"|"open_link"|"local_add"|"local_play", value? }`

- 云端：toggle/play/pause/next/prev 经 SMTC；seek 仅当 `capabilities.seek`；open_link 打开 `orpheus://` / `qqmusic://` 或网页搜索（需用户首次授权）。
- 本地：`local_add` 由宿主弹系统文件选择（用户显式选择），服务只登记路径；不扫盘、不写源文件。

## 对话 `GET/POST /api/music/chat`

卡片气泡：用户输入 → 经现有 relay（同信箱）发给桌宠绑定会话，自动附「正在听：歌名 — 歌手；当前歌词；测到的特征」。回复显示为卡片气泡，同时可落桌宠气泡。

## AI 工具（lib/music-tools.js，全部 `when: s => s.listen?.enabled === true`）

- `pixelpet_music_now`：只读快照（歌名、歌手、进度、当前歌词行±1、测到的特征），不含文件路径。描述里注明：`heard.tags` 是模型猜的，说的时候用「听着像」，别当成事实（工具描述静态，不拼动态内容）。
- `pixelpet_music_control`：action 同上（除 local_add）。
- `pixelpet_music_recommend`：写入今日推荐 `{title, artist, note}`，宿主尝试生成客户端链接/搜索链接，卡片展示。

## 边界（2026-11-15 更新）

- librosa 部分（整曲解析与回环滚动图）只报**测到的声学特征**（能量 / 明暗 / BPM / 调性 / 段落 A-B-A′ / 最响最静 / 突变 / 打击占比），不识别乐器、情绪、副歌、曲风。
- 可选组件「听得更细」（LAION CLAP，默认关、需下载）：开着时另报「模型听着像」的情绪 / 风格 / 乐器标签（`heard.tags`，句子尾注「模型听着像：…」）。那是模型猜的，不当成事实，也不推断歌词内容。没装 / 没开时不出现，不报错、不催装。
- 桌宠自己出声（say speak=true）期间，回环与 CLAP 都暂停采样（宿主经 stdio `notify` 通道通知音乐服务），别把自己的声音当成用户在听的歌。
- 采样由音乐服务的后台线程每秒驱动（不依赖卡片/请求），`GET /api/music/now` 只读已有结果；`heard.rolling` 的时间轴用歌曲位置（`position_start` / `position_end`，网易云自走表估算时带 `pos_source:"estimated"`），单曲循环或拖动（位置回退 >10 秒 / 前拖 >30 秒）会清空重算，整曲图只描述这一遍。

## 「听得更细」组件（可选）

- 模型 `laion/clap-htsat-unfused`（Apache-2.0，614.5 MB；HF API 核实 2026-11-15）。首选 `laion/larger_clap_music` 的 HF 转换版在本机实测不可用（不同文本余弦 ~0.999、文本-音频 ~0.004、logit_scale 0.027），已换掉。依赖装进 pye-music venv（uv：torch CPU + transformers，不装 onnxruntime）；模型放 `pye-music/models/clap/`。
- 标签文本端只在构建时跑一次 → `label_emb.npy`（附模型 id 与标签表哈希，标签表改了重算）；运行时加载音频端。每 10 秒取最近 10 秒音频，与标签向量余弦相似度 + 每组 softmax；按歌指数平均，每组累计 ≥ 3 次且第一名 ≥ 0.35 才报，每组只报前 2 名。
- 设置页「一起听歌」展开行：开关「听得更细」（首次打开下载模型，显示进度）、删除模型按钮、HF 镜像输入框。关掉不删模型。
- 服务按 `<dataDir>/music/clap.json` 的 `enabled` 热切换；本地文件的整曲标签进 `analysis/*.json` 缓存（只存标签与分数）。

## 隐私与权限

- 回环录音：仅「一起听歌」开启且检测到播放时采集，内存处理，不落盘、不上传；关闭即释放设备。每秒特征向量与 CLAP 标签都只存数字与标签名。
- LRCLIB 查询只发歌名/歌手/时长，不发音频。
- 日志不记歌词全文、音频、本地路径、订阅链接、API key。

## 网易云点播（破例使用非公开接口）

- 动作：`pixelpet_music_control` 的 `play_song`（参数 `title`，建议带 `artist`）；`pixelpet_music_recommend` 的 `play: true` 也优先走它。
- 做法：用网易云网页版搜索接口 `music.163.com/api/search/get/web` 搜「歌名 歌手」拿到歌曲编号，再打开客户端注册的 `orpheus://<base64 {"type":"song","id":"…","cmd":"play"}>`，客户端收到即播。
- 两步都是**网易云未公开的接口**，网易云改版可能失效；失效时退回原来的「打开网页搜索页、用户自己点播放」。
- 只发歌名和歌手，不带任何用户信息。
- 挑歌要准：歌名规范化后相等，且给了歌手时至少一位歌手对上；没给歌手时只有同名唯一一首才放。对不上就返回候选（`code: 'ambiguous'`），由 AI 先问用户，绝不瞎放。
- 放完约 4 秒回读一次正在播放的歌名，对上了 `confirmed: true`；会员歌曲带 `vip: true`（非会员账号可能只有试听）。
- QQ 音乐没有对应的路，正在用 QQ 音乐时 `play_song` 明说不支持。`capabilities.playSpecific`：本地播放、以及正在用网易云时为 `true`（能点播）；QQ 音乐和其他客户端为 `false`。

## 按路径听本地音频

「一起听歌」开启后可用 `pixelpet_audio_listen({path})`。用户通过设置里的系统选文件夹窗口维护 `listen.audioDirs`，默认空列表，最多十个。宿主只把授权目录中的普通 WAV、FLAC、OGG、MP3 文件送给服务分析，路径以真实文件位置校验，单文件上限 100 MB。工具返回文件名与声学结果，对话内容不转写。

服务通过后台 `control/analyze_file` 分析。短段使用响度、明暗、响静差和可测音高，八秒及以上共用 `songmap`，最多分析文件前十五分钟。可用且开启时 CLAP 提供「听着像」标签，其中 `kind` 仅用于文件分析。工具前台等待六十秒，后台完成后按文件版本缓存结果，便于重试。
