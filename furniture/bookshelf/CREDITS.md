# 书架 · 署名与授权

**正式美术（2026-11-15 替换占位）**：素材是一组 ImageGen 关键帧（`pixel-bookshelf-v1`，不随仓库发布） + 本地逐帧动画），由 `tools/import_art_v2.py` 导入（不缩放、16 帧同一裁剪框）。旧的代码绘制版由 `tools/build_sprites.py` 生成，已不再使用。

本目录的像素美术（`sprites/`、`preview.png`）以及设置页头像 `web/packs/reading.png` 以 [CC BY-NC-SA 4.0](LICENSE) 发布。

| 项 | 说明 |
|---|---|
| 作者 | dsh-pixel-pet contributors |
| 来源 | 原创，全部帧由 `tools/build_sprites.py` 用代码逐像素绘制（92×136 逻辑像素 ×2 最近邻），不依赖外部图片；重复运行结果逐字节一致 |

- 状态：`idle`（书都在）、`read`（从书架上抽出一本书，16 帧，播一次停在最后一帧）。
- 本目录之外的代码按仓库根目录 MIT 协议授权；`tools/build_sprites.py` 作为代码同样适用 MIT。
