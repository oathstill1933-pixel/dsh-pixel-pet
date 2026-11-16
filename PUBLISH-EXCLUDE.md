# 不随包发布的内容

下列路径用于本地开发、验收或运行，不进 git（`.gitignore`）也不进 npm 包（`package.json` 的 `files` 里的否定项；根目录的 `.npmignore` 在有 `files` 时不生效，只作兜底）。发布前可用 `tools/privacy_scan.py` 检查隐私素材。`npm pack --dry-run` 的清单由 `scripts/release.test.mjs` 核对。

| 路径 | 是什么 | 为什么不发 |
|---|---|---|
| `characters/demo-*/` | 本地 demo 角色包（由 `tools/make_demo_packs.py` 从维护者私有素材生成） | 私有美术，不发布；代码、测试、文档里没有依赖它存在的地方 |
| `furniture/demo-*/` | 本地 demo 家具包（同上） | 私有手绘素材，不发布 |
| `characters/whale-girl/tools/source/**/*.png`、`*.gif` | 鲸鱼娘原画（约 130 MB） | 太大：作为 GitHub Release 附件 `whale-girl-source-art.zip`。同目录的 README 与 JSON 规格留在仓库（`lib/create.js` 引用其中的动作规格），重建脚本 `tools/*.py` 也留着 |
| `packs-bundled/` | 原来随本体附带的 Claude娘 拓展包 | 不再附带：`contracts/catalog.json` 里是 GitHub Release 的 https 地址，附件由 `tools/build_claude_pack.py` 从 `packs-src/claude-girl/` 构建 |
| `dist/` | `tools/build_claude_pack.py` 的默认输出目录 | 构建产物，做成 Release 附件上传 |
| `tools/privacy_terms.local.txt` | 隐私扫描用的私有词表 | 词表本身就是私有字样；完整扫描由发布者自己跑 |
| `*.bak`、`*.bak-*`、`*.bak.*`、`bak-*/`、`*_bak-*/` | 施工备份（文件和目录两种形式） | 非发布物 |
| `.tmp/` | 本地实测输出、`release-assets/`（Release 附件的原件与哈希清单） | 非发布物 |
| `.implementation/` | 本次接手/集成说明 | 施工资料，不发布 |
| `contracts/fixtures/` | 跨语言一致性夹具 | 测试资产：进 git，不进 npm 包 |
| 用户数据目录（默认 `%LOCALAPPDATA%/dsh-pixel-pet/`） | 设置、控制端口与 token、克隆音色、`models/`（TTS 与声纹模型）、`pylibs/`、`tts-cache/`、`runtime/`（下载的 Python 运行时）、`logs/`、`characters/` 与 `furniture/`（新建 / 已改的用户版）、`create*/`（制作记录）、`mailbox/`（信件、`files/<信id>/` 附件副本、Agently 工作目录）、`music/`（听歌缓存、本地队列路径）、`reading/`（阅读窗 webview、最近文档、留存的划词）、`calendar/`、`diary/`、`packs/`（已装拓展包与注册表）、`voice-no-auto.json`（删除语音引擎后不再自动安装的标记） | 属于每个用户自己，从不在插件目录里；模型按 `catalog.json` 从公开上游下载 |
| `%LOCALAPPDATA%/pye-music/models/clap/` | 「听得更细」的 CLAP 模型（数据目录之外，约 590 MB） | 运行时从上游下载，不在插件目录里；与数据目录一样由设置页「清除全部数据」清掉 |
| `voiceprint/`（任意层级） | 生物特征模板、正交盐与 entropy | 敏感用户数据，扫描只看路径元数据并拒绝，绝不打开内容 |
| `voices/`、`recordings/`（任意层级） | 克隆锚点与录音 | 敏感用户数据，不读取、不复制、不发布 |
| `templates.bin`、`ortho.bin`、`entropy.bin`、`secret.txt`、`up-16k.pcm` | 敏感文件名 | 即使误复制到其它位置也按路径拒绝 |

`packs-src/` 进 git（Claude娘 拓展包的源文件，用来复现 Release 附件；约 11 MB），不进 npm 包。

数据目录与上面 CLAP 目录是插件唯一会写文件的地方（「一起听歌」配的 Python 环境是用户自己的，只往里 pip 装包，插件不删它）。所有删除都经 `lib/purge.js`：只许落在这两个根里面，不能等于根本身，拒绝盘符根、用户目录、`.dsh`、插件目录，遇到符号链接 / junction 只删链接，文件被占用返回 `busy`。

用户的克隆记录保存在数据目录的 `voices/` 下。经授权随 Claude娘 拓展包提供的 Clawd 作为角色预设发布，来源与许可记在包内。

声纹默认关闭，speaker-model 必须显式下载；仅本次运行不读磁盘旧模板/盐。Windows 落盘先 DPAPI 加密、临时文件仅当前 SID 的 DACL 收紧后才发布；其它平台未加密并明确显示。DPAPI 和内存模式都不能抵御同用户进程。

受限验收用 `python tools/privacy_scan.py --public-only`：不读私有词表、不对私有目录做内容哈希；被禁路径只检查元数据。正常发布可在授权后另做私有美术比对，但扫描器仍禁止读取声纹/录音/克隆目录。
