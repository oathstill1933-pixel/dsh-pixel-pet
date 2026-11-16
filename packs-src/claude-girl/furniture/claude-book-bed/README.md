# Clawd 书页床

书脊床座、奶油色床垫、铜橙色小毯和一枚床头 Clawd 徽章。空床和抱书蜷睡都能看到徽章。

`furniture.json` 定义 360×300 的床卡。家具默认关闭，启用后可用 `sleep` 进床、`wake` 起床。角色 ID 为 `orange-book-girl` 时采用配套的两张蜷睡帧，其他角色可以用自己的蜷睡或躺下姿势叠加。

空床图由内置 ImageGen 绘制，入睡姿势来自本项目的 Claude 娘动作包。原图和提示词在 `tools/source/`。重建时给 `tools/build_sprites.py` 的 `--runtime` 参数传入插件的 runtime 目录。Clawd 外形参考 [原作者 Sam McAllister](https://smca.io/)。

[空床与入睡预览](preview.png) · [入睡动图](sleep.gif)

非官方：Clawd 形象是社区同人二次创作，不是 Anthropic 官方作品，不代表、不暗示官方背书；「Claude」为其权利人的商标；不含官方 logo 原图；商业使用需另行取得许可。
