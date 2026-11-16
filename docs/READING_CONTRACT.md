# 一起看书 · 接口约定（2026-11-14）

需求与方案：维护者的笔记（不随仓库发布）。前端与逻辑复用一个私用版阅读器（只读参考，私用版保持不动、并存）。

## 进程结构

```
阅读窗 web/reading/*（PDF.js 6.4.299 本地内置）
  └─ pywebview 正常窗口：runtime/pixelpet/reading_win.py
        ▲ 由桌宠运行时 reading_dock.ReadingHost 拉起（cmd: reading, op: open|close）
        ▲ 桌宠没在跑时由宿主 lib/reading.js 自己拉起（父进程 = 宿主）
  ──HTTP──> 宿主 lib/reading.js  /api/reading/*  ──relay──> 桌宠绑定会话
AI 工具 lib/reading-tools.js ──> reading.snapshot()
```

- 设置项 `settings.reading = { enabled: false, python: '' }`。Python：`reading.python` → `listen.python` → `<dataDir>/listen.json`（与「一起听歌」同一个环境，需 pywebview + pythonnet）。源码不写死任何本机路径。
- 窗口：系统标题栏，可拖动、可调尺寸、可最大化；首次贴主屏工作区右侧（宽 520 逻辑像素、满高），之后记住位置大小（`<dataDir>/reading/window.json`，保存的位置所在显示器不在了就回到默认）。只在按需时打开；「一起看书」关闭、桌宠退出（或宿主退出，若由宿主拉起）时关闭。第二次打开只把已有窗口提到前面。
- 桌宠表情：划词时宿主节流（20 s）发 `pose attentive holdMs 8000`；桌宠在家具里或在走路时不动它。
- 出口（v2）：打字、说话的回答一律走桌宠说话出口（`say speak:true`：TTS + 字幕气泡；念不出来时退回只冒气泡），阅读卡片里同时显示文字。
- **划线上下文优先**：阅读窗有当前划选（选区在 / 卡片开着）时写进宿主的阅读上下文槽（只在内存，10 分钟无刷新过期；选区取消、卡片关闭、换文档、关掉「一起看书」、关窗时清掉）。之后用户经任何入口发给绑定会话的话——输入条打字、输入条语音（都走 `/api/ask/start`）、阅读卡片——都在会话中继的 decorate 处附上它：同一段划线完整附一次（文档名+页码+原文+前后文），之后只附一句指代；阅读卡片自己的提问本来就带着这段，不重复附。带 `[桌宠信箱]` `[一起听歌]` 等标签的别的通路不掺。
- 阅读窗麦克风：识别完直接发给桌宠（卡片里显示为用户气泡；卡片上「先确认再发」开着时才填进输入框）。录音前 `POST /api/reading/mic {on:true}` → 桌宠 `reading op:mic`：桌宠正在收音（输入条/讲话键）时回 busy，阅读窗不录、只提示直接对桌宠说（这段已在上下文槽里）；否则桌宠在录音期间暂停免提监听（最长 75 s，`on:false` 立即恢复）。

## 路由（`/dsh-pixel-pet` 前缀）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reading/` | 阅读页静态资源 |
| GET | `/api/reading/state` | `{enabled, current, recent, keep, partner:{name, avatar}, session}`（关着也可读） |
| GET | `/api/reading/fetch?url=` | 网页原文（阅读模式由前端抽正文、脚本不执行）；PDF 链接落 `docs/` 转 PDF 文档；拒绝本机/局域网地址（每一跳都查） |
| GET | `/api/reading/pdf?id=` | PDF 字节（只认「最近」里登记过的文档） |
| GET | `/api/reading/kept?id=` | 本篇留存 |
| POST | `open-url` `open-path` `pick-file` `upload?name=` `open-doc` `forget` `status` `keep-pref` | 打开/位置/偏好 |
| POST | `ask` `{pick, question, voice}` | 经 relay 发给绑定会话；回答经桌宠 `say speak:true` 出声+气泡。没有翻译按钮：想翻译就像聊天一样直接问 |
| POST | `kept/save` `kept/delete` | 留存（服务端再判一次留存开关，没开 409） |
| POST | `stt`（audio/wav） | DSH 自带语音识别（`ctx.speechToText`，同 /api/stt） |
| POST | `context` `{pick}` / `{clear:true}` | 阅读上下文槽（只在内存，TTL 10 分钟）+ 桌宠「在看」 |
| POST | `mic` `{on}` | 阅读窗录音与桌宠监听互斥，返回 `{busy}` |
| POST | `open` | 打开阅读窗。鉴权二选一：`X-PixelPet-Key`（桌宠进程，同 /api/shot）或同源 Origin。200 `{ok:true}`；409 disabled；503 not_configured；401 key 错 |

- 除 `state` 与静态页外，`reading.enabled` 关着时一律 409。所有 `/api/reading/*` 走同源校验（Origin = Host、拒 `Sec-Fetch-Site` 跨站）；JSON 路由只收 `application/json`。
- 响应不含本地路径：PDF 只给 id 与标题；网页只给网址。

## 数据（`<dataDir>/reading/`）

`sessions.json`（最近 30 篇：位置、标题；PDF 的 src 只留在服务端）、`prefs.json`（`keep` 留存偏好，记住上次）、`<docId>.json`（**只存留存的划线**，字段同需求 §四：`text/contextBefore/contextAfter/locator{page,rect,charOffset}/createdAt/keep/turns[]/asked/answer`）、`docs/`（拖入或网页 PDF 的副本，按内容哈希）、`window.json`（窗口位置）、`webview/`（WebView2 存储：麦克风授权等）。

docId 与私用版一致：`pdf-` + FNV-1a64(小写路径)，`web-` + FNV-1a64(去掉 # 的网址)。

## AI 工具

- `pixelpet_reading_now`（`when: s => s.reading?.enabled === true`）：只读，当前文档标题/类型/页码（网页只给域名）、当前划选与前后文（各 ≤300 字）、最近 5 条留存摘要。不含本地路径。

## 隐私

- 文档内容与留存只在本机；只有用户提问时，选中原文 + 前后各 200–400 字 + 文档名/页码经会话中继发出（发送键提示里写明范围）。
- 不点气泡不打扰；不留存的不落盘；日志不记正文、不记路径。

## 扩展点（第一版不做）

OCR（MinerU）、Word/EPUB、DSH 侧栏注册。不做翻译功能，界面上也不放翻译按钮：让桌宠帮忙翻译本身是对话里的互动。前端在 `web/reading/app.js` 头部注明；服务端加路由时沿用 `/api/reading/*` 与同一套开关/同源校验。
