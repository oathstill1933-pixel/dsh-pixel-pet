# 做一件新家具

也可以直接在设置页「家具」末尾点 ＋ 走向导。手工做时把下面这份说明连同家具卡一起交给你的 AI，让它在 `furniture/<id>/` 下产出一个家具包。

## 目录

```
furniture/<id>/
  furniture.json
  sprites/*.png
```

`id`：小写字母、数字、`-`，和目录名一致。`_` 开头的目录不会被加载，可以当草稿区。

## furniture.json

| 字段 | 说明 |
|---|---|
| `id` / `name` | 标识 / 显示名 |
| `size` | `[宽, 高]`，所有帧都必须是这个尺寸 |
| `anchor` | 默认停放：`bottom-right` / `bottom-left` / `top-right` / `top-left` / `taskbar` |
| `defaultEnabled` | 新家具建议 `false`，用户在设置页打开 |
| `floorY` | 角色站在家具旁边时脚底的 y |
| `stand` | `{left, right}`：站左 / 站右时角色中心的 x（可为负或超过宽度） |
| `idle` | 平时显示的状态 |
| `states` | `{状态: {frames: ["sprites/x_00.png"], durationsMs: [毫秒]}}` |
| `interactions` | 见下 |

`interactions[]`：

- `verb`：英文短词；`say`：一句说明；`hint`：AI 什么时候该用它
- `mode`
  - `beside`：走到旁边，摆 `pose`（角色已有状态），可选 `holdMs`、`furnitureState`
  - `inside`：钻进去；角色窗口隐藏，家具上叠当前角色自己的 `occupant.pose`（默认 `curl-sleep`，没有就 `lie`）：`occupant.anchor` = 角色身体底边中点落在家具图里的 [x, y]，可选 `clipY`（这条线以下的家具像素盖回角色上，比如床沿）。**只画空置帧，不要画角色。**旧包的 `state`（画了角色的占用帧）仍兼容；`enterPose` 一般用 `jumping`
  - `exit`：出来
- `done`：完成后回给 AI 的一句话；`{name}` 会换成当前角色名

## 画面规格

- RGBA PNG，透明底；半透明像素按 alpha ≥ 128 二值化，别依赖柔边。
- 不要用品红 `#FF00FF`（透明键色）。
- 和角色同一像素密度：角色帧格子 192×208，1 个逻辑像素 = 2×2 实际像素。
- 尺寸按角色比例：床要能躺进去。

## 验收

```
python runtime/validate.py furniture/<id>
```

0 错误才算完成。
