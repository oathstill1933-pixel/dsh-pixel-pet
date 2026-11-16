# 发布清单

仓库地址占位符是 `oathstill1933-pixel/dsh-pixel-pet`。发布前一次性替换：

```
node scripts/set-repo.mjs <owner>/<repo>      # 替换 package.json、contracts/catalog.json、README 等里的占位符
node scripts/set-repo.mjs --check             # 列出还有占位符的文件
```

## 1. 构建 Release 附件

| 附件 | 怎么来 | 校验 |
|---|---|---|
| `builtin.claude-girl-<版本>.petpack` | `python tools/build_claude_pack.py --out-dir dist`（从 `packs-src/claude-girl/` 构建，归档可复现：只存不压、固定顺序、固定时间戳） | 输出的 `size` / `sha256` 必须与 `contracts/catalog.json` 里那一条一致；`scripts/claude-pack.test.mjs` 会现场重建并核对 |
| `whale-girl-source-art.zip` | 鲸鱼娘原画（`characters/whale-girl/tools/source/` 下的 png / gif，约 130 MB），解压回同一路径即可用 `tools/import_codex_v1.py` 重建帧图 | 不进目录，没有强制校验；Release 说明里写上 sha256 |

两个附件的说明里都要写上：

- Claude娘 包：非 Anthropic 官方作品；「Claude」为其权利人的商标；Clawd 音色由 Qwen3-TTS VoiceDesign（1.7B，Apache-2.0）按文字描述生成，没有克隆真人，以 CC BY-NC-SA 4.0 发布。
- 鲸鱼娘原画：CC BY-NC-SA 4.0，非官方二次创作，署名见 `characters/whale-girl/CREDITS.md`。

目录里的下载地址形如 `https://github.com/oathstill1933-pixel/dsh-pixel-pet/releases/download/<tag>/builtin.claude-girl-<版本>.petpack`，tag 与 `catalog.json` 一致（首发是 `v0.1.0`）。更新包内容要改 `packs-src/`、重建、更新 `catalog.json` 的版本 / size / sha256，并发新的 Release 附件。

## 2. 发布前检查

```
node scripts/run-tests.mjs                     # Node 测试
python -X utf8 -m unittest discover -s tests    # Python 测试（需要真实模型、声卡、WebView2、桌面的用例会被跳过）
python tools/privacy_scan.py --public-only      # 公开扫描：除第三方库的误报外应为 0
python tools/privacy_scan.py                    # 带私有词表的完整扫描：只有持有 tools/privacy_terms.local.txt 的发布者本人能跑
npm pack --dry-run                              # 清单与大小：本体 < 30 MB
```

## 3. 推送

1. 建仓库、推送代码。`.gitignore` 已排除 `.tmp/`、`dist/`、`*.bak*`、demo 包、原画图片、私有词表。
2. 在 GitHub Release 上传上面两个附件（tag 要与 `catalog.json` 里的 URL 一致）。
3. 可选：`npm publish`。
