# 家具包规范（FURNITURE_SPEC）

给没有其它上下文的会话 / 作者看：照这份做出来的家具包，能直接被桌宠加载，也不会和角色、运行时冲突。
权威实现：`runtime/pixelpet/validate.py`（`check_furniture`）、`runtime/pixelpet/furniture.py`、`runtime/pixelpet/app.py`（`use()` / `_interact()`）。

## 1. 目录

```
furniture/<id>/
  furniture.json
  sprites/<状态>_NN.png      每个状态 1 张起，NN 从 00 开始连续编号
```

用户在「+ 新建家具」做的家具在 `<数据目录>/create-furniture/<furn-xxxxxx>/`：

```
job.json                    卡片（页面写，别手改）
raw/<状态>_NN.png           原图：任意大小，透明或 #00FF00 绿底
build/<id>/furniture.json   转换后生成；interactions 可以手改（见第 6 节）
build/<id>/sprites/         转换后的帧
```

## 2. 规格预设

桌宠身体约 160×170 px（帧格 192×208），家具像素和桌宠像素同一比例。

| 预设 | key | 尺寸 (宽×高) | 默认互动 | floorY | 躺进去的落点 anchor | 空着帧数 | 新动画默认帧数 |
|---|---|---|---|---|---|---|---|
| 小摆件 | `small` | 160×160 | 站旁边 `use` | 156 | [80, 124] | 1 | 2 |
| 窝/床 | `nest` | 360×300 | 躺进去 `sleep` | 286 | [180, 230] | 1 | 2 |
| 桌柜 | `desk` | 300×260 | 站旁边 `use` | 256 | [150, 200] | 1 | 2 |
| 高件 | `tall` | 200×360 | 站旁边 `use` | 356 | [100, 300] | 1 | 2 |
| 自定义 | `custom` | 32–1200 自己定 | 不变 | 高 − 4 | 不变 | 不变 | 2 |

「窝/床」另带默认 `area` [90, 60, 270, 240] 和前沿 `clipPath` [[40, 226], [180, 232], [320, 226]]，在「落位」里拖框、点线改。

选不准就选最接近的预设；要躺进去的东西用「窝/床」，比桌宠矮的摆设用「小摆件」，书架、落地灯、植物用「高件」。

## 3. furniture.json 字段

| 字段 | 必填 | 允许的值 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9-]{0,39}$`，必须等于目录名 |
| `name` | 是 | 非空字符串（显示名） |
| `version` | 否 | 整数，写 1 |
| `order` | 否 | 数字，越小越先摆；默认 50 |
| `size` | 是 | `[宽, 高]`，8–1200 的整数像素；**每一帧都必须正好是这个大小** |
| `anchor` | 否 | 摆在屏幕哪：`bottom-right`（默认）/ `bottom-left` / `top-right` / `top-left` / `taskbar` |
| `defaultEnabled` | 否 | `true` / `false`；用户做的家具写 `false` |
| `floorY` | 否 | 0–高 的数字：家具图里地面线的 y，桌宠站旁边时脚踩在这；默认 高 − 4 |
| `stand` | 否 | `{left?: x, right?: x}`，站旁边时桌宠中心的 x（家具图坐标，−宽…2×宽）；不给就自动贴边 |
| `idle` | 是 | 指向 `states` 里的一个状态；用「新建家具」做的固定是 `"empty"`（再编辑已装家具时保留它原来的名字，比如邮筒的 `"idle"`） |
| `states` | 是 | `{状态id: {frames: [...], durationsMs: [...]}}`，非空 |
| `interactions` | 否 | 数组，见第 4 节 |
| `feature` | 否 | 特殊玩法标记，配合同名对象：邮筒 `"mailbox"`（`"mailbox": {flagState, openState, verb, autoWave}`）；书架 `"reading"`（`"reading": {openState}`，点击打开阅读窗，且只在设置 `reading.enabled` 开着时摆出 / 列出） |
| `draft` | 否 | `true` = 骨架包，`--strict` 校验不过、不会加载 |

`states.<id>`：

- `frames`：`"sprites/<状态>_NN.png"` 相对路径，不能含 `..`
- `durationsMs`：和 `frames` 一样长，每个是 40–5000 的整数毫秒
- 状态 id 用 `^[a-z][a-z0-9-]{0,23}$`（新建家具页的规则；校验器本身允许到 40 位）

## 4. 互动 interactions

每条：

| 字段 | 说明 |
|---|---|
| `verb` | 必填，`^[a-z][a-z0-9-]{0,23}$`，同一件家具里不重复；AI 用 `pixelpet_furniture`（action=use, id, verb）来叫 |
| `mode` | `beside`（默认）/ `inside` / `exit` |
| `say` | 给 AI 看的叫法，如「去看看窗外」 |
| `hint` | 什么时候用，如「用户说想看风景时用」 |
| `done` | 到了 / 做完后的回话；`{name}` 换成角色名 |
| `pose` | beside 用：到了以后角色摆的状态名（`^[a-z0-9][a-z0-9-]{0,39}$`）；角色没有这个状态就不摆 |
| `holdMs` | beside 用：姿势 / 家具动画持续多久，整数毫秒（校验 0–60000，建议 500–10000，默认 3000） |
| `furnitureState` | beside 用：家具同时播的自己的状态，必须是 `states` 里有的 |
| `occupant` | inside 用：`{pose, fallback?, area?, clipPath?, anchor?, clipY?, under?, drawnFor?}`，`area` 和 `anchor` 至少给一个 |
| `occupant.area` | `[x0, y0, x1, y1]`（家具图像素，x0<x1、y0<y1，可超出画布不超过一个家具尺寸）：角色躺的区域 |
| `occupant.clipPath` | `[[x, y], …]` 2–24 个点，x 严格递增（范围同上）：前沿折线 |
| `occupant.anchor` / `clipY` | 旧写法：底边中点 / 水平前沿；有 `area` / `clipPath` 时被它们取代，留着给旧版插件用 |
| `enterPose` | inside 用：进去前角色先做的状态（通常 `jumping`） |
| `state` | inside 且没有 occupant 时：进去后家具显示的状态（只适合给某个角色画好的「占用」图） |

运行时怎么做：

- **beside**：桌宠走到家具左边或右边（`stand` / `floorY`），到了以后摆 `pose`（持续 `holdMs`），家具同时播 `furnitureState`（持续 `holdMs`，之后回到 `idle`）。
- **inside**：桌宠走过去 → 做 `enterPose` → 桌宠窗口藏起来，家具显示 `occupant.under`（不给就是 `idle`）的帧，上面叠**当前角色自己的** `occupant.pose` 帧（没有就依次试 `fallback`、`curl-sleep`、`lie`、`idle`）。叠法：
  - 有 `area`：角色姿势第一帧的不透明区域比 `area` 大就**等比缩小**（只缩不放，最近邻，像素不糊）到放得下，底边中点对准 `area` 的底边中点；此时不看 `anchor`。
  - 没有 `area`：1:1，不透明区域的底边中点对准 `anchor`。
  - 有 `clipPath`：折线**以下**（含线上）的家具不透明像素再盖回角色上面（碗沿、床沿、被子）；两点之间线性插值，折线左右两端以外沿用端点的 y。没有 `clipPath` 时用 `clipY`（一条水平线）。
  - `drawnFor: [角色id…]`：这些角色进去时直接显示画好的 `state` 帧，不叠。
  缩放和前沿遮罩每个角色 × 家具只算一次。
- **exit**：从 inside 里出来，跳一下。有 inside 就要有一条 exit（常用 verb `wake`）。

角色常见状态名（`pose` / `occupant.pose` 可用）：`waving` `jumping` `review` `running` `waiting` `lie` `curl-sleep` `mood-happy` `listening` `attentive` `speaking` `failed` `idle`，以及角色包里自定义的 `mood-*` / `act-*`。

## 5. 图片规则

- 只画家具，**不要画角色**：角色由插件用它自己的帧叠上去。
- 成品帧：RGBA PNG，正好 `size` 大小，不能整张全透明；透明度会被二值化（≥128 不透明）。
- 原图（raw/）：任意大小；背景透明，或纯 `#00FF00` 绿（会被抠掉）；不要地面、不要投影、不要文字和边框；一张图一帧，不要拼图。
- 家具完整、居中、贴底边，略俯视；宽高比照 `size`。
- 同一件家具的所有帧（包括所有动画）位置、大小、配色一致，只改动画需要动的部分；转换时所有帧用同一个裁剪框，对齐不会跑。
- 像素风：清晰方像素、有限色板、深色描边、左上来光；不要渐变、模糊、抗锯齿。
- 文件名：`empty_00.png`…`empty_03.png`（空着，最多 4 帧），`<动画>_00.png`…`<动画>_05.png`（每段动画最多 6 帧，最多 6 段）。

## 6. 会话改互动

转换后 `build/<id>/furniture.json` 的 `interactions` 可以直接改：

- 新加的 verb 原样保留（页面改卡片、重新转换都不会丢）；
- 卡片里已有的 verb（`sleep` / `use` / `wake` 和页面上加的）以页面为准，你给它加的其它字段会保留；
- 引用的 `furnitureState` / `occupant.under` 必须是 `states` 里已有的状态。要新动画：把 `raw/<动画>_NN.png` 放好，点「转换」会自动收进卡片。

## 7. 自查

```
python runtime/validate.py --strict furniture/<id>
python runtime/validate.py --strict <数据目录>/create-furniture/<furn-xxxxxx>/build/<furn-xxxxxx>
```

输出 `OK` 才算过；每条错误都写了位置和期望值。

## 角色的音乐动作

动作可声明 `requires: { "feature": "listen" }`。用于自动切换的三个唯一 `role` 分别为 `music-listening`（播放时待机）、`music-idle`（暂停时待机）、`music-speaking`（播放或暂停时说话）。声明 `role` 时必须同时声明上述 `requires`。角色仍使用标准 `frames`、`durationsMs` 和 `loop` 字段，设置页允许预览。暂停满 10 分钟后恢复普通动作。
