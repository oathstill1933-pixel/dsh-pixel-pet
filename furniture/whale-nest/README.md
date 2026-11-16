# 鲸鱼小窝

奶白软椅、海蓝外壳、鲸鳍扶手、尾鳍抱枕与波浪毯子。与鲸鱼娘配套。

家具包默认关闭，在插件的家具设置中启用“鲸鱼小窝”。`sleep` 走 `inside` 模式：角色窗口隐藏，家具显示睡进去的鲸鱼娘；`wake` 退出家具。当前空窝和睡觉各一张静态帧。

## 文件

- `furniture.json`：360×300 家具定义与睡觉、起床交互。
- `sprites/empty_00.png`、`sprites/occupied_00.png`：运行帧，RGBA、二值透明、2×2 逻辑像素。
- `tools/source/codex/`：保留 1254×1254 的 ImageGen 原图和完整生成提示词。
- `tools/build_sprites.py`：共用裁切框，以最近邻取样到逻辑画布，再整数放大；不另做调色板减色。
- `preview.html`、`preview.png`：空窝和睡觉状态预览。

校验：在项目根目录运行 `python runtime/validate.py --strict furniture/whale-nest`。
