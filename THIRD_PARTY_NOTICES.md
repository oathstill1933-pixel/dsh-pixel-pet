# 第三方声明

本插件自己的代码按 MIT 授权（见 `LICENSE`）。下面是用到的第三方软件和模型，分四类：**随包附带**、**运行时下载**、**用户自己装**、**被调用但不分发**。

每一项的名称、版本、许可、上游链接都是 2026-11-16 去上游核实过的，「核实来源」一列写了看的是什么。素材（角色、家具、音色）的许可在各自目录里，优先于这里；见 README 的「许可分层」。

仓库地址占位符 `oathstill1933-pixel/dsh-pixel-pet` 发布前用 `node scripts/set-repo.mjs <owner>/<repo>` 统一替换。

## 一、随包附带

文件原样拷贝，没有修改，许可文本跟着文件放在各自目录里。

| 名称 | 版本 | 许可 | 位置 | 用途 | 上游 | 核实来源 |
|---|---|---|---|---|---|---|
| lunar-javascript | 1.7.8 | MIT（© 2018 6tail） | `vendor/lunar-javascript/` | 农历、节气、传统节日 | https://github.com/6tail/lunar-javascript | npm 注册表 `lunar-javascript@1.7.8` 的 `license` 字段；仓库 LICENSE 与随包文件逐字节一致 |
| ical.js | 2.2.1 | MPL-2.0 | `vendor/ical.js/` | ICS 订阅解析 | https://github.com/kewisch/ical.js | npm 注册表 `ical.js@2.2.1` 的 `license` 与 `repository` 字段；仓库 LICENSE 与随包文件逐字节一致。MPL-2.0 是文件级的：本插件只原样随附，没有改它；它的源码就在上游仓库 |
| holiday-cn（数据） | 2026、2027 年快照 | MIT（© 2019 NateScarlet） | `vendor/holiday-cn/` | 法定节假日与调休 | https://github.com/NateScarlet/holiday-cn | 上游仓库 master 的 LICENSE（此前随包缺这个文件，已从上游补到 `vendor/holiday-cn/LICENSE`）。数据来自国务院公告，见每个 json 里的 `papers` |
| PDF.js（`pdfjs-dist`） | 6.4.299 | Apache-2.0（© Mozilla Foundation） | `web/reading/vendor/pdfjs/` | 「一起看书」阅读 PDF | https://github.com/mozilla/pdf.js | npm 注册表 `pdfjs-dist@6.4.299` 的 `license` 字段；本目录 287 个文件与注册表里的 tarball 逐文件哈希一致 |

PDF.js 自带的子组件，许可文本都在对应目录里（`LICENSE*`）：

| 子组件 | 许可 | 位置 | 说明 |
|---|---|---|---|
| Foxit 标准字体（PDFium） | BSD-3-Clause | `standard_fonts/LICENSE_FOXIT` | 字体文件 `Foxit*.pfb` |
| **Liberation Sans 1.x 字体**（Red Hat） | **GPL-2.0 + 字体例外**（不是 OFL） | `standard_fonts/LICENSE_LIBERATION` | `LiberationSans-*.ttf`（4 个）。作为独立数据文件随附，不和 MIT 代码链接，属于「并存分发」；例外条款允许文档嵌入字体而不被传染。**这是本清单里唯一的 GPL 类文件，见下面「需要注意」** |
| OpenJPEG | BSD-2-Clause | `wasm/LICENSE_OPENJPEG`、`wasm/LICENSE_PDFJS_OPENJPEG` | JPEG 2000 解码 |
| JBIG2 解码（PDFium / PDF.js） | BSD-3-Clause / Apache-2.0 | `wasm/LICENSE_JBIG2`、`wasm/LICENSE_PDFJS_JBIG2` | |
| qcms | MIT | `wasm/LICENSE_QCMS`、`wasm/LICENSE_PDFJS_QCMS` | 颜色管理 |
| QuickJS | MIT（© 2017-2021 Fabrice Bellard、Charlie Gordon） | `wasm/LICENSE_QUICKJS` | `quickjs-eval.*` 是 PDF.js 编译好的 QuickJS。上游 npm 包没带这份许可文本，已从 https://github.com/bellard/quickjs 的 LICENSE 补上 |
| Adobe CMaps | BSD-3-Clause | `cmaps/LICENSE` | 字符编码映射 |
| ICC 色彩配置 | CC0-1.0 | `iccs/LICENSE` | |

`web/`、`runtime/`、`lib/` 里除上表外没有别的第三方代码（grep 过版权声明）。

### 需要注意：Liberation Sans 1.x（GPL-2.0 + 字体例外）

- 随附方式：4 个 `.ttf`，原样来自 `pdfjs-dist`，与 MIT 代码只是放在同一个包里，没有链接关系。
- GPL-2.0 第 3 条要求分发目标代码时附带源码或书面承诺；这些字体的上游是 Liberation Fonts 1.x（Red Hat）。如果你想彻底避开这一项，可以删掉 `standard_fonts/LiberationSans-*.ttf`（PDF 里引用了没内嵌的标准字体时，PDF.js 会退回别的字体，显示会有差别）。保留还是删掉由发布者决定。

## 二、运行时下载（不随包，首次使用时从上游下载）

来源清单在 `runtime/pixelpet/voice/catalog.json`（带固定修订号 / 哈希），「一起听歌 · 听得更细」的模型在 `lib/music.js`。

| 名称 | 许可 | 上游 | 我们怎么用 | 核实来源 |
|---|---|---|---|---|
| Qwen3-TTS-GGUF 推理引擎（固定到 `0eb32e2`） | MIT | https://github.com/HaujetZhao/Qwen3-TTS-GGUF | 本机语音合成的推理代码，下载到数据目录 | GitHub 页面显示仓库许可为 MIT。**注意**：固定的这个提交里还没有 LICENSE 文件（该文件在仓库里是 2026-09-19 才加入的），建议以后把固定修订换成包含 LICENSE 的提交 |
| llama.cpp（固定到 `b9333`） | MIT（© 2023-2026 The ggml authors） | https://github.com/ggml-org/llama.cpp | 引擎用的推理库 | 上游 master 的 LICENSE；`b9333` 这个标签没有单独核对 |
| Qwen3-TTS 0.6B 模型（GGUF 量化） | Apache-2.0 | 量化版：https://huggingface.co/mysanit/qwen3-tts-gguf （固定到 `6926962`）；原模型：https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base 、https://github.com/QwenLM/Qwen3-TTS | 本机语音合成的权重 | 量化仓库固定修订的 README 声明 `license: apache-2.0`；原模型卡 `license: apache-2.0`；Qwen3-TTS 仓库 LICENSE 为 Apache-2.0。`catalog.json` 里写的 `Qwen/Qwen3-TTS-12Hz-0.6B` 在 Hugging Face 上不存在，真实名字带 `-Base` / `-CustomVoice` 后缀，量化仓库没写具体是哪一个 |
| CAM++ 声纹模型（3D-Speaker，`speech_campplus_sv_zh-cn_16k-common` 的 ONNX 版） | Apache-2.0 | 模型：https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common ；代码：https://github.com/modelscope/3D-Speaker ；ONNX 转换与分发：https://github.com/k2-fsa/sherpa-onnx | 可选的声纹过滤，手动下载 | ModelScope 模型接口返回的 License 字段为 Apache License 2.0；3D-Speaker 与 sherpa-onnx 仓库 LICENSE 均为 Apache-2.0 |
| CLAP `laion/clap-htsat-unfused` | Apache-2.0 | https://huggingface.co/laion/clap-htsat-unfused | 「听得更细」：猜情绪、风格、乐器 | 模型卡 `license: apache-2.0` |
| Python 运行时（python-build-standalone 20261009，CPython 3.10.22） | PSF-2.0（CPython）；打包工具 MPL-2.0；包内另带 pip 等的许可 | https://github.com/astral-sh/python-build-standalone | 机器上没有合适的 Python 时下载，装到数据目录 | 下载了归档，大小与 sha256 和 `catalog.json` 一致；归档里有 `python/LICENSE.txt`（CPython）和 pip 依赖的 `licenses/`；工具仓库 LICENSE 为 MPL-2.0 |
| Python 依赖（pip 安装到数据目录）：numpy、onnxruntime、gguf、tokenizers、scipy、soundfile、sounddevice | numpy BSD-3-Clause；onnxruntime MIT；gguf MIT；tokenizers Apache-2.0；scipy BSD-3-Clause；soundfile BSD-3-Clause（轮子里带 libsndfile，LGPL-2.1）；sounddevice MIT（轮子里带 PortAudio） | https://pypi.org | 语音引擎的依赖，由 pip 直接从 PyPI 取，不经过本插件的包 | PyPI 各项目的 JSON 元数据（`license` / `license_expression` / 分类器）。numpy 轮子带的 `AND 0BSD AND MIT AND Zlib AND CC0-1.0` 子许可见其元数据 |

## 三、用户自己装（本插件只往用户自己的 Python 环境里 pip 装，不分发）

「一起听歌」「一起看书」用的 Python 环境是用户自己的（`settings.listen.python`），插件不删它。依赖由 pip 从 PyPI 取：

| 名称 | 许可 | 用途 |
|---|---|---|
| numpy / scipy / soundfile / sounddevice | BSD-3-Clause / BSD-3-Clause / BSD-3-Clause / MIT | 音频特征 |
| librosa | ISC | 速度、调性等特征（可选，没有就退回 numpy） |
| soundcard | BSD-3-Clause | 回环录音 |
| comtypes / pycaw | MIT / MIT | 系统音量 |
| pywebview | BSD-3-Clause | 小卡片与阅读窗（WebView2） |
| pythonnet | MIT | pywebview 的 Windows 依赖 |
| winrt-Windows.Media.Control 等（pywinrt） | MIT | 读系统媒体会话（SMTC） |
| torch（CPU）/ transformers / sentencepiece | torch：BSD-3-Clause 等多项（含 Apache-2.0、MIT、Zlib…）；transformers：Apache-2.0；sentencepiece：Apache-2.0 | 「听得更细」 |
| Pillow | MIT-CMU（HPND） | 桌宠绘图 |

核实来源：PyPI 各项目的 JSON 元数据（2026-11-16）。

## 四、被调用但不分发

| 名称 | 说明 |
|---|---|
| DSH 自带的语音识别（SenseVoice） | 通过 DSH 的 `ctx.speechToText` 服务调用。本插件不包含、不下载它；它的许可见 DeepSeek Harness |
| 网易云音乐网页搜索、LRCLIB 等在线服务 | 只在用户打开对应功能时按需请求（歌名 / 歌手 / 歌词查询），不是软件库，受各自服务条款约束 |

## 五、有没有和发布方式冲突的

- 没有发现「不允许再分发」的项。上面所有随包附带的文件都允许原样再分发，许可文本都随文件一起。
- 需要发布者知道的两处（不是冲突，但值得看一眼）：Liberation Sans 1.x 字体是 GPL-2.0 + 字体例外；Qwen3-TTS-GGUF 引擎固定的提交早于它的 LICENSE 文件。见上面各自的说明。
- 音色素材（`characters/whale-girl/voice/ref.wav` 与 Claude娘 包内的 `characters/claude-girl/voice/ref.wav`）是用 [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) 的 VoiceDesign 模型（[`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign)，Apache-2.0）按文字描述生成的声音：没有克隆真人，参考台词与音色描述由本项目维护者编写，不存在需要署名的第三方人声。核实来源：仓库 `LICENSE` 为 Apache License 2.0 全文（2026-11-16 取）；两个 1.7B / 0.6B 模型卡的 `license` 字段均为 `apache-2.0`，模型卡里没有额外的使用限制或输出归属条款。这两段音频按各自目录里的 CC BY-NC-SA 4.0 发布。
