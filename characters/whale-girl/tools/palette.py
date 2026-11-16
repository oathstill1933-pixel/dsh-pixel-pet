"""鲸鱼娘调色板（14 色，取自定稿图主色；描边统一 #201F33）。"""


def _c(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


PALETTE = {
    "LINE": _c("#201F33"),     # 描边、领结、瞳孔暗部
    "NAVY": _c("#35395E"),     # 裙子、鳍耳、鲸尾
    "HAIR_D": _c("#484973"),   # 头发暗部
    "HAIR": _c("#626EA4"),     # 头发主色
    "HAIR_L": _c("#7185B9"),   # 头发亮部
    "TIP": _c("#83A8D5"),      # 发梢、蝴蝶结、瞳色
    "FIN_IN": _c("#BBB2C7"),   # 鳍耳内侧、鲸尾腹
    "WHITE_D": _c("#D7C8D7"),  # 白色阴影
    "WHITE": _c("#FCF5F6"),    # 围裙、头饰
    "SKIN": _c("#FAEAE9"),     # 皮肤
    "BLUSH": _c("#F8CEBC"),    # 腮红
    "MOUTH": _c("#C45464"),    # 嘴
    "GOLD": _c("#D9B46A"),     # 领口宝石 / 星星眼
    "RICE": _c("#FFFFFF"),     # 米饭、气泡高光
}
globals().update(PALETTE)
T = (0, 0, 0, 0)
