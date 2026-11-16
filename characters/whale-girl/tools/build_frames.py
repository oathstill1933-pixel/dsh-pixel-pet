"""由 tools/base.png 派生鲸鱼娘全部状态帧，写 sprites/*.png、character.json、preview_sheet.png。

    python tools/build_frames.py

结果完全确定（无随机），重复运行逐字节一致。坐标约定：
  - 基准帧 base.png 是 77x86 逻辑像素；放进 96x104 逻辑画布的 (OX, OY)，脚底落在第 101 行（同 demo-cat）。
  - 下文所有“b 坐标”都是 base.png 里的坐标，函数内部统一加 (OX, OY)。
  - 最后 K=2 最近邻放大到 192x208。
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PACK))
sys.path.insert(0, HERE)
from palette import (BLUSH, GOLD, HAIR, HAIR_D, HAIR_L, LINE, MOUTH, NAVY,  # noqa: E402
                     RICE, SKIN, T, TIP, WHITE, WHITE_D, FIN_IN)

K = 2
W, H = 96, 104
OX, OY = 13, 16
DISPLAY_SCALE = 1.2

# ------------------------------------------------------------------ 基础操作
def blank():
    return Image.new("RGBA", (W, H), T)


def bxy(pts):
    """b 坐标序列 → 画布坐标。"""
    out = []
    for i, v in enumerate(pts):
        out.append(v + (OX if i % 2 == 0 else OY))
    return out


def mask(fn):
    m = Image.new("L", (W, H), 0)
    fn(ImageDraw.Draw(m))
    return m


def paint(im, m, c):
    im.paste(Image.new("RGBA", (W, H), c), (0, 0), m)


def grow(m):
    return m.filter(ImageFilter.MaxFilter(3))


def part(im, m, fill, shade=None):
    """带描边的色块；shade 画在右下边缘。"""
    paint(im, grow(m), LINE)
    paint(im, m, fill)
    if shade:
        o = Image.new("L", (W, H), 0)
        o.paste(m, (-1, -1))
        paint(im, ImageChops.subtract(m, o), shade)


def put(im, x, y, c):
    X, Y = x + OX, y + OY
    if 0 <= X < W and 0 <= Y < H:
        im.putpixel((X, Y), c)


def fill(im, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(im, x, y, c)


def move(im, dx, dy):
    out = blank()
    out.paste(im, (dx, dy))
    return out


def seal(im, box=None):
    """补描边：画布坐标框 box 里，挨着透明像素（或画布边）的非描边色一律改成描边色。
    位移、裁切后露出来的“没描边的切口”都靠它收口。"""
    x0, y0, x1, y1 = box or (0, 0, im.width, im.height)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(im.width, x1), min(im.height, y1)
    src = im.copy().load()
    px = im.load()
    for y in range(y0, y1):
        for x in range(x0, x1):
            c = src[x, y]
            if c[3] == 0 or c == LINE:
                continue
            for ddx, ddy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                X, Y = x + ddx, y + ddy
                if not (0 <= X < im.width and 0 <= Y < im.height) or src[X, Y][3] == 0:
                    px[x, y] = LINE
                    break
    return im


def shift(im, box, dx, dy, vacate="keep"):
    """把 b 坐标框 box=(x0,y0,x1,y1)（右下不含）里的内容平移。
    keep：空出来的行/列保留原像素（相当于拉伸 1 像素，用于呼吸）；clear：空出来的地方透明。
    移出框外的那一条叠在原图上（透明处不挖掉框外的东西），最后给切口补描边。"""
    x0, y0, x1, y1 = box[0] + OX, box[1] + OY, box[2] + OX, box[3] + OY
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    piece = im.crop((x0, y0, x1, y1))
    out = im.copy()
    if vacate == "clear":
        out.paste(Image.new("RGBA", (x1 - x0, y1 - y0), T), (x0, y0))
    moved = blank()
    moved.paste(piece, (x0 + dx, y0 + dy))
    inside = Image.new("L", (W, H), 0)
    inside.paste(255, (x0, y0, x1, y1))
    over = blank()
    over.paste(moved, (0, 0), ImageChops.subtract(Image.new("L", (W, H), 255), inside))
    out.paste(moved, (0, 0), ImageChops.multiply(inside, mask(lambda d: d.rectangle(
        (x0 + dx, y0 + dy, x1 + dx - 1, y1 + dy - 1), fill=255))))
    out.alpha_composite(over)
    return seal(out, (min(x0, x0 + dx) - 1, min(y0, y0 + dy) - 1, max(x1, x1 + dx) + 1, max(y1, y1 + dy) + 1))


def recolor(im, box, src, dst):
    x0, y0, x1, y1 = box
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            X, Y = x + OX, y + OY
            if im.getpixel((X, Y)) in src:
                im.putpixel((X, Y), dst)


def glyph(im, rows, x, y, c, outline=True, s=2):
    """画布坐标的小符号（Zzz、！、？、音符……），每格放大 s 倍，默认带深色描边。"""
    m = Image.new("L", (W, H), 0)
    for j, r in enumerate(rows):
        for i, ch in enumerate(r):
            for v in range(s * s):
                X, Y = x + i * s + v % s, y + j * s + v // s
                if ch == "#" and 0 <= X < W and 0 <= Y < H:
                    m.putpixel((X, Y), 255)
    if outline:
        paint(im, grow(m), LINE)
    paint(im, m, c)


Z5 = ["#####", "...#.", "..#..", ".#...", "#####"]
Z4 = ["####", "..#.", ".#..", "####"]
EXCL = ["##", "##", "##", "##", "..", "##"]
QMARK = [".###.", "#...#", "...#.", "..#..", ".....", "..#.."]
NOTE = ["..###", "..#.#", "..#..", "###..", "###.."]
SPARK = [".#.", "###", ".#."]
STAR = ["..#..", ".###.", "#####", ".###.", "..#.."]
DROP = [".#.", "###", "###"]
DOTS = ["##.##.##", "##.##.##"]
BUBBLE_S = [".#.", "#.#", ".#."]
BUBBLE_L = [".##.", "#..#", "#..#", ".##."]

# ------------------------------------------------------------------ 部件坐标（b 坐标）
EYE_L, EYE_R, EYE_Y = 23, 40, 37      # 眼睛 7x8 的左上角
MOUTH_X, MOUTH_Y = 33, 47
HEAD_ROWS = (0, 51)                    # 头部横带（呆毛到下巴）
UPPER_ROWS = (0, 60)                   # 呼吸时上抬的部分（到腰）
LEG_L = (25, 80, 33, 86)
LEG_R = (35, 80, 44, 86)
FLUKE = (61, 58, 78, 74)               # 尾鳍外框；实际只动 FLUKE_PARTS 里的像素
# 尾鳍 = 鳍面 + 往下接到裙下尾柄的“颈”。外框左上角压着一绺发梢（b62-66, 55-62），不能跟着动；
# 第 73 行是颈和尾柄的接口，位移时在这里拉伸/压缩，保证不断开。
FLUKE_PARTS = ((61, 63, 78, 74), (67, 58, 78, 63))
FLUKE_JOINT = 73
FIN_TIP_L = (1, 33, 11, 45)
FIN_TIP_R = (59, 33, 70, 45)
AHOGE = (14, 0, 33, 7)


# ------------------------------------------------------------------ 脸
EYE_OPEN = [
    "LLLLLLL",
    "LWWNNNL",
    "LWWNNNL",
    "LNNNNHL",
    "LHHHHHL",
    "LTTTRTL",
    "LTTTTTL",
    ".LLLLL.",
]
EYE_WIDE = [
    ".LLLLL.",
    "LRRRRRL",
    "LRRTTRL",
    "LRTNNTL",
    "LRTNNTL",
    "LRRTTRL",
    "LRRRRRL",
    ".LLLLL.",
]
EYE_STAR = [
    "LLLLLLL",
    "LNNGNNL",
    "LNGGGNL",
    "LGGRGGL",
    "LHGGGHL",
    "LTGTGTL",
    "LTTTTTL",
    ".LLLLL.",
]
EYE_TEARY = [
    "LLLLLLL",
    "LWWNNNL",
    "LWWNNNL",
    "LNNNNHL",
    "LHHHHHL",
    "LTRTRTL",
    "TTTTTTT",
    ".LLLLL.",
]
EYE_CLOSED = [".......", ".......", ".......", "L.....L", ".LLLLL.", ".......", ".......", "......."]
EYE_HAPPY = [".......", ".......", "..LLL..", ".L...L.", "L.....L", ".......", ".......", "......."]
EYE_BLINK = [".......", ".......", ".......", ".......", "LLLLLLL", ".......", ".......", "......."]
EYE_SQUINT = [".......", ".......", "LL.....", "..LL...", "....LLL", ".......", ".......", "......."]  # >
EYE_HALF = [".......", ".......", ".......", "LLLLLLL", "LNNNNHL", "LTTTRTL", "LTTTTTL", ".LLLLL."]
COL = {"L": LINE, "W": RICE, "N": NAVY, "H": HAIR, "T": TIP, "R": RICE, "G": GOLD, ".": None}

MOUTHS = {
    "smile": ["L..L", ".LL."],
    "open": ["LLLL", "LMML"],
    "o": [".LL.", ".LL."],
    "flat": ["....", ".LL."],
    "frown": [".LL.", "L..L"],
    "pout": [".LL.", "LBBL"],
    "yawn": [".LL.", "LMML"],
}


def face(im, eyes="open", mouth="smile", blush=True, right=None):
    """在当前图上重画脸（b 坐标；做在任何位移之前）。right 给右眼单独指定样式。"""
    eyes_map = {"open": EYE_OPEN, "wide": EYE_WIDE, "star": EYE_STAR, "teary": EYE_TEARY, "closed": EYE_CLOSED,
                "happy": EYE_HAPPY, "blink": EYE_BLINK, "half": EYE_HALF, "squint": EYE_SQUINT}
    # 皮肤底
    fill(im, 22, 37, 47, 47, SKIN)
    fill(im, 23, 48, 46, 48, SKIN)
    # 刘海下沿：只在上方是头发的地方画描边。额角（b24-27、b40-43）上方本来就是皮肤，
    # 原先整行一刀拉直会在额头上横出一条贯穿全脸的线。
    for x in range(22, 48):
        above = im.getpixel((x + OX, 35 + OY))
        put(im, x, 36, SKIN if above in (SKIN, WHITE, BLUSH) else LINE)
    # 中间一缕
    for x, y in ((33, 37), (36, 37), (34, 38), (35, 38)):
        put(im, x, y, LINE)
    put(im, 34, 37, HAIR)
    put(im, 35, 37, HAIR)
    for ex, style, outer in ((EYE_L, eyes, -1), (EYE_R, right or eyes, 7)):
        pat = eyes_map[style]
        if style == "squint" and ex == EYE_R:
            pat = [r[::-1] for r in pat]        # 右眼是 <
        for j, row in enumerate(pat):
            for i, ch in enumerate(row):
                if COL.get(ch):
                    put(im, ex + i, EYE_Y + j, COL[ch])
        if pat[0][0] == "L":
            put(im, ex + outer, EYE_Y + 1, LINE)    # 外眼角睫毛
    if blush:
        for bx0 in (23, 43):
            fill(im, bx0, 46, bx0 + 3, 46, BLUSH)
    if eyes == "teary":
        put(im, EYE_L - 1, 45, TIP)
        put(im, EYE_R + 7, 45, TIP)
    mpat = MOUTHS[mouth]
    for j, row in enumerate(mpat):
        for i, ch in enumerate(row):
            c = {"L": LINE, "M": MOUTH, "B": BLUSH}.get(ch)
            if c:
                put(im, MOUTH_X + i, MOUTH_Y + j, c)
    if mouth == "pout":                        # 鼓腮：腮红加厚
        for bx0 in (22, 44):
            fill(im, bx0, 45, bx0 + 3, 47, BLUSH)


# ------------------------------------------------------------------ 手、手臂、道具
def hand(im, cx, cy):
    """b 坐标中心的小手（4x4 皮肤 + 描边）。"""
    part(im, mask(lambda d: d.ellipse(bxy((cx - 2, cy - 2, cx + 2, cy + 2)), fill=255)), SKIN)


def erase_hand(im, side):
    if side == "L":
        fill(im, 25, 60, 30, 66, WHITE)
    else:
        fill(im, 40, 60, 45, 66, WHITE)
        fill(im, 46, 60, 46, 66, LINE)


def arm(im, x0, y0, x1, y1):
    """袖子从 (x0,y0) 到手 (x1,y1)，末端白袖口 + 手。"""
    part(im, mask(lambda d: d.line(bxy((x0, y0, x1, y1)), fill=255, width=3)), NAVY)
    hand(im, x1, y1)


def bowl(im, cx, cy, rice=False):
    """b 坐标：碗口中心 (cx, cy)，宽 13。"""
    body = mask(lambda d: d.chord(bxy((cx - 6, cy - 6, cx + 6, cy + 6)), 0, 180, fill=255))
    part(im, body, WHITE, WHITE_D)
    fill(im, cx - 5, cy + 2, cx + 5, cy + 2, TIP)       # 碗上的蓝条
    if rice:
        heap = mask(lambda d: d.chord(bxy((cx - 5, cy - 5, cx + 5, cy + 3)), 180, 360, fill=255))
        part(im, heap, RICE)
        put(im, cx - 2, cy - 3, WHITE_D)
        put(im, cx + 2, cy - 2, WHITE_D)
    else:
        fill(im, cx - 5, cy, cx + 5, cy, NAVY)          # 空碗：碗口里面是暗的
    fill(im, cx - 6, cy - 1, cx + 6, cy - 1, LINE)
    hand(im, cx - 7, cy + 2)
    hand(im, cx + 7, cy + 2)


# ------------------------------------------------------------------ 基准
def load_base():
    b = Image.open(os.path.join(HERE, "base.png")).convert("RGBA")
    im = blank()
    im.paste(b, (OX, OY))
    # 领口宝石
    recolor(im, (32, 49, 38, 53), (BLUSH,), LINE)
    put(im, 34, 51, GOLD)
    put(im, 35, 51, GOLD)
    # 额前刘海缝里量化出来的腮红色杂点 → 皮肤
    recolor(im, (18, 26, 50, 36), (BLUSH,), SKIN)
    # 手：重画成干净的小圆手
    erase_hand(im, "L")
    erase_hand(im, "R")
    hand(im, 28, 63)
    hand(im, 43, 63)
    return im


BASE = None


def b0(**fk):
    im = BASE.copy()
    face(im, **fk)
    return im


def breathe(im, d=1):
    return shift(im, (-OX, UPPER_ROWS[0] - OY, W, UPPER_ROWS[1]), 0, -d)


def fluke_mask():
    return mask(lambda dr: [dr.rectangle(bxy((x0, y0, x1 - 1, y1 - 1)), fill=255) for x0, y0, x1, y1 in FLUKE_PARTS])


def tail(im, d):
    """尾鳍上下摆 d 个逻辑像素。只搬鳍面和尾颈（不带发梢）；
    上摆时颈部最下 |d| 行保留原像素（拉长），下摆时丢掉落到接口以下的行（压短），尾柄始终连着。"""
    if d == 0:
        return im
    m = fluke_mask()
    piece = blank()
    piece.paste(im, (0, 0), m)
    if d > 0:                                   # 落到接口行以下的不要
        piece.paste(T, (0, FLUKE_JOINT + 1 - d + OY, W, H))
    moved = blank()
    moved.paste(piece, (0, d))
    out = im.copy()
    vac = m.copy()
    if d < 0:                                   # 接口处留原像素
        vac.paste(0, (0, FLUKE_JOINT + 1 + d + OY, W, FLUKE_JOINT + 1 + OY))
    out.paste(T, (0, 0), vac)
    out.alpha_composite(moved)
    x0, y0, x1, y1 = FLUKE
    return seal(out, (x0 + OX - 1, y0 + OY - 3 + min(d, 0), x1 + OX + 1, y1 + OY + 2 + max(d, 0)))


def fins(im, d):
    im = shift(im, FIN_TIP_L, 0, d)
    return shift(im, FIN_TIP_R, 0, d)


def ahoge(im, dx):
    return shift(im, AHOGE, dx, 0, "clear")


def head_dx(im, dx):
    return shift(im, (-OX, HEAD_ROWS[0] - OY, W, HEAD_ROWS[1]), dx, 0, "clear")


def lift_leg(im, leg, d=1):
    return shift(im, leg, 0, -d, "clear")


# ------------------------------------------------------------------ 各状态
def st_idle():
    a = b0()
    return [
        (a, 420),
        (breathe(a), 300),
        (tail(breathe(a), -1), 300),
        (tail(a, -1), 380),
        (b0(eyes="blink"), 110),
        (tail(a, 1), 380),
    ]


MIRROR_BAND = (47, 58)                 # 镜像接缝允许落在的 b 行（下巴以下、尾鳍以上）


def mirror_lower(im):
    """头部不动（蝴蝶结留在原侧），下巴以下沿身体中线左右镜像，尾巴换到另一侧。
    原图和镜像图之间不再按一条水平线硬切（两侧长发的纹理在那一行对不上，会出一道横缝），
    而是在 MIRROR_BAND 里逐列找一条“两张图最像”的最小误差接缝（相邻列上下最多错 1 行），
    缝以上用原图、以下用镜像图，最后给切口补描边。"""
    axis = 34.5 + OX
    flip = blank()
    flip.paste(im.transpose(Image.FLIP_LEFT_RIGHT), (int(2 * axis + 1 - W), 0))
    A, B = im.load(), flip.load()
    y0, y1 = MIRROR_BAND[0] + OY, MIRROR_BAND[1] + OY
    rows = range(y0, y1 + 1)

    def err(x, y):
        p, q = A[x, y], B[x, y]
        if p[3] == 0 and q[3] == 0:
            return 0
        if p[3] == 0 or q[3] == 0:
            return 3 * 255 ** 2
        return sum((p[i] - q[i]) ** 2 for i in range(3))

    def cost(x, y):                              # 缝落在 y：y-1 行取原图、y 行取镜像，比较上下两侧各自的接口
        return err(x, y) + err(x, y - 1)

    best = {y: (cost(0, y), [y]) for y in rows}
    for x in range(1, W):
        nxt = {}
        for y in rows:
            c, path = min((best[py] for py in (y - 1, y, y + 1) if py in best), key=lambda t: (t[0], abs(t[1][-1] - y)))
            nxt[y] = (c + cost(x, y), path + [y])
        best = nxt
    seam = min(best.values(), key=lambda t: t[0])[1]
    out = im.copy()
    for x, sy in enumerate(seam):
        for y in range(sy, H):
            out.putpixel((x, y), B[x, y])
    return seal(out, (0, y0 - 2, W, y1 + 2))


def st_walk(direction):
    a = b0()
    lean = 1 if direction == "right" else -1
    frames = []
    for i in range(4):
        f = a
        if i == 0:
            f = lift_leg(f, LEG_R)
        elif i == 2:
            f = lift_leg(f, LEG_L)
        f = tail(f, (-1, 0, 1, 0)[i])
        if i in (1, 3):
            f = shift(f, (-OX, -OY, W, 80), 0, -1)       # 两脚着地时身体上颠
        f = head_dx(f, lean)
        if direction == "right":
            f = mirror_lower(f)                          # 尾巴拖在身后（左侧）
        frames.append((f, 160))
    return frames


def st_waving():
    out = []
    for i, (hx, hy) in enumerate(((55, 45), (58, 49), (55, 45), (52, 47))):
        f = b0(eyes="happy", mouth="open")
        erase_hand(f, "R")
        arm(f, 46, 58, hx, hy)
        f = fins(f, -1 if i % 2 == 0 else 0)
        f = tail(f, -2 if i % 2 == 0 else -1)
        out.append((f, 150 if i < 3 else 260))
    return out


def squash(im, d=2):
    return shift(im, (-OX, -OY, W, 62), 0, d, "clear")


def st_jumping():
    wide = b0(eyes="wide", mouth="o")
    f0 = squash(b0(eyes="squint", mouth="flat"))
    f1 = move(wide, 0, -6)
    apex = ahoge(fins(b0(eyes="wide", mouth="o"), -2), 1)
    f2 = move(apex, 0, -11)
    glyph(f2, EXCL, 80, 10, GOLD)
    f3 = move(tail(wide, -2), 0, -5)
    f4 = squash(b0(eyes="squint", mouth="pout"), 1)
    f5 = b0(eyes="open", mouth="pout")
    return [(f0, 120), (f1, 110), (f2, 200), (f3, 110), (f4, 160), (f5, 500)]


# 趴姿：头放低，下巴搁在交叠的小臂上，尾鳍从头后翘起
def prone(eyes="closed", mouth="flat", tail_dy=0, breath=0, fluke_front=False):
    src = b0(eyes=eyes, mouth=mouth)
    head = src.crop((0, OY, W, HEAD_ROWS[1] + OY))
    only = blank()
    only.paste(src, (0, 0), fluke_mask())
    fluke = seal(only.crop((FLUKE[0] + OX, FLUKE[1] + OY, FLUKE[2] + OX, FLUKE[3] + OY)))
    im = blank()
    # 摊在地上的长发；发梢颜色限制在头发轮廓内，不盖掉描边
    puddle = mask(lambda d: d.ellipse((6, 88, 90, 103), fill=255))
    part(im, puddle, HAIR_D)
    paint(im, ImageChops.multiply(puddle, mask(lambda d: (d.ellipse((7, 93, 20, 102), fill=255),
                                                          d.ellipse((76, 93, 89, 102), fill=255)))), TIP)
    if not fluke_front:
        im.alpha_composite(fluke, (71, 45 + tail_dy))
    # 小臂
    for x0, x1 in ((22, 46), (50, 74)):
        part(im, mask(lambda d, x0=x0, x1=x1: d.rounded_rectangle((x0, 93, x1, 100), radius=3, fill=255)), NAVY)
    for hx in (44, 51):
        part(im, mask(lambda d, hx=hx: d.ellipse((hx - 2, 94, hx + 2, 98), fill=255)), SKIN)
    hy = 95 - (49 + OY) - breath + OY
    im.alpha_composite(head, (0, hy))
    if fluke_front:
        im.alpha_composite(fluke.transpose(Image.FLIP_LEFT_RIGHT), (3, 87))
    return seal(im)                             # 头部裁切的下沿、尾鳍裁切边露出来的地方收口


def st_failed():
    out = []
    for i in range(4):
        f = prone(breath=i % 2)
        if i >= 1:
            glyph(f, Z4, 22, 36, TIP, s=1)
        if i >= 2:
            glyph(f, Z4, 12, 24, TIP)
        if i >= 3:
            glyph(f, Z5, 2, 9, TIP)
        out.append((f, 330))
    return out


def st_lie():
    out = []
    for i, td in enumerate((0, 4, 0, 1)):
        f = prone(eyes="half", mouth="flat", tail_dy=td, breath=1 if i == 2 else 0)
        glyph(f, BUBBLE_S, 76, 36 - i * 3, TIP, outline=False)
        if i >= 2:
            glyph(f, BUBBLE_L, 84, 22 - (i - 2) * 4, TIP, outline=False)
        out.append((f, 500))
    return out


def st_curl_sleep():
    out = []
    for i in range(2):
        f = prone(breath=i, fluke_front=True)
        glyph(f, Z4, 76, 36 - i * 6, TIP, s=1 + i)
        out.append((f, 700 if i == 0 else 600))
    return out


def st_waiting():
    out = []
    for i in range(4):
        f = b0(eyes="open", mouth="smile")
        erase_hand(f, "L")
        erase_hand(f, "R")
        bowl(f, 35 + (0, 1, 0, -1)[i], 59)
        if i == 3:
            glyph(f, SPARK, 57, 66, GOLD, s=1)               # 勺子敲碗边“叮”
        f = tail(f, (0, -1, 0, 1)[i])
        if i in (1, 3):
            f = breathe(f)
        out.append((f, 250))
    return out


def thought(im, content):
    d = ImageDraw.Draw(im)
    d.ellipse((60, 1, 93, 19), fill=RICE, outline=LINE)
    d.ellipse((57, 20, 61, 24), fill=RICE, outline=LINE)
    d.ellipse((54, 26, 56, 28), fill=RICE, outline=LINE)
    if content == "rice":
        d.chord((69, 3, 83, 17), 0, 180, fill=WHITE, outline=LINE)
        d.chord((70, 4, 82, 14), 180, 360, fill=RICE, outline=LINE)
        d.line((70, 12, 82, 12), fill=TIP)
    else:
        n = int(content)
        for k in range(n):
            d.rectangle((67 + k * 8, 9, 68 + k * 8, 10), fill=LINE)


def think_pose(eyes="half", mouth="flat"):
    f = b0(eyes=eyes, mouth=mouth)
    erase_hand(f, "R")
    arm(f, 45, 62, 40, 52)
    return f


def st_running():
    out = []
    for i, c in enumerate(("1", "2", "3", "rice", "3", "1")):
        f = think_pose()
        if i == 4:
            f = head_dx(f, -1)
        if i == 5:
            f = head_dx(f, 1)
        f = ahoge(f, (0, 0, 1, 1, -1, 1)[i])
        thought(f, c)
        out.append((f, 170 if i < 5 else 260))
    return out


def st_review():
    out = []
    plan = [(None, "open"), (62, "open"), (57, "star"), (56, "star"),
            (57, "star"), (56, "star"), (57, "star"), (57, "happy")]
    for i, (by, eyes) in enumerate(plan):
        f = b0(eyes=eyes, mouth="open" if by else "smile")
        if by:
            erase_hand(f, "L")
            erase_hand(f, "R")
            bowl(f, 35, by, rice=True)
        if i >= 2:
            f = tail(f, -2 if i % 2 else 1)
        if i in (3, 5, 7):
            glyph(f, STAR, 6, 30, GOLD)
            glyph(f, SPARK, 84, 28, GOLD)
        if i in (4, 6):
            glyph(f, SPARK, 9, 33, GOLD)
            glyph(f, STAR, 82, 26, GOLD)
        out.append((f, 170 if i < 7 else 600))
    return out


def st_listening():
    out = []
    for i in range(4):
        f = head_dx(b0(eyes="closed", mouth="smile"), (-1, 0, 1, 0)[i])
        f = tail(f, (0, -1, 0, -1)[i])
        glyph(f, NOTE, 78 + (i % 2) * 3, 24 - i * 2, TIP)
        out.append((f, 220))
    return out


def st_attentive():
    a = fins(b0(eyes="wide", mouth="smile"), -1)
    return [(a, 800), (fins(b0(eyes="wide", mouth="smile"), -2), 500)]


def st_mood_happy():
    out = []
    for i in range(4):
        f = ahoge(fins(b0(eyes="happy", mouth="open"), -1 if i % 2 == 0 else 0), (1, 0, -1, 0)[i])
        if i % 2 == 0:
            f = move(f, 0, -1)
        glyph(f, NOTE, 80, 22 - (i % 2) * 2, TIP)
        out.append((f, 170 if i < 3 else 260))
    return out


def st_mood_surprised():
    f0 = b0(eyes="wide", mouth="o")
    f1 = ahoge(fins(f0, -2), 1)
    out = []
    for i, f in enumerate((f0, f1, f1, f0)):
        f = f.copy()
        if i in (1, 2):
            glyph(f, EXCL, 80, 18 - (i - 1) * 2, GOLD)
        out.append((f, (120, 160, 160, 400)[i]))
    return out


def st_mood_confused():
    out = []
    for i in range(4):
        f = b0(eyes="open", right="half", mouth="flat")
        f = fins(f, 0)
        f = shift(f, FIN_TIP_L, 0, -1)
        f = shift(f, FIN_TIP_R, 0, 1)
        f = head_dx(f, -1 if i in (1, 2) else 0)
        glyph(f, QMARK, 80, 20 - (1 if i in (1, 2) else 0), TIP)
        out.append((f, (260, 200, 200, 260)[i]))
    return out


def st_mood_thinking():
    out = []
    for i in range(4):
        f = ahoge(think_pose(), (0, 1, 0, -1)[i])
        dots = "#." * (i % 3 + 1)
        glyph(f, [dots, dots], 72, 30, LINE, outline=False)
        out.append((f, (360, 360, 360, 600)[i]))
    return out


def st_mood_sleepy():
    out = []
    for i, (eyes, mouth) in enumerate((("half", "flat"), ("half", "yawn"), ("closed", "yawn"), ("closed", "flat"))):
        f = b0(eyes=eyes, mouth=mouth)
        f = fins(f, 1)
        f = ahoge(f, -1 if i >= 2 else 0)
        if i >= 2:
            glyph(f, Z4, 76, 30, TIP, s=1)
        if i == 3:
            glyph(f, Z4, 82, 22, TIP)
        out.append((f, (420, 300, 520, 420)[i]))
    return out


def st_mood_sad():
    out = []
    for i in range(4):
        f = fins(b0(eyes="teary", mouth="frown"), 1)
        x, y = EYE_R + 7 + OX, 46 + OY + i * 2
        glyph(f, [".#.", "###"], x - 1, y, TIP, outline=False, s=1)
        out.append((f, (300, 240, 240, 420)[i]))
    return out


STATES = [
    # id, label, builder, loop
    ("idle", "待机", st_idle, True),
    ("walk-left", "向左走", lambda: st_walk("left"), True),
    ("walk-right", "向右走", lambda: st_walk("right"), True),
    ("waving", "招手", st_waving, True),
    ("jumping", "戳一戳", st_jumping, False),
    ("failed", "服务器繁忙", st_failed, True),
    ("waiting", "等输入", st_waiting, True),
    ("running", "深度思考", st_running, True),
    ("review", "收工", st_review, False),
    ("lie", "趴下", st_lie, True),
    ("listening", "听歌", st_listening, True),
    ("attentive", "竖耳倾听", st_attentive, True),
    ("curl-sleep", "卷尾巴睡", st_curl_sleep, True),
    ("mood-happy", "开心", st_mood_happy, True),
    ("mood-surprised", "惊讶", st_mood_surprised, True),
    ("mood-confused", "疑惑", st_mood_confused, True),
    ("mood-thinking", "思考", st_mood_thinking, True),
    ("mood-sleepy", "困", st_mood_sleepy, True),
    ("mood-sad", "委屈", st_mood_sad, True),
]


def up(im):
    return im.resize((W * K, H * K), Image.NEAREST)


def main():
    global BASE
    BASE = load_base()
    sprites = os.path.join(PACK, "sprites")
    os.makedirs(sprites, exist_ok=True)
    for fn in os.listdir(sprites):
        if fn.endswith(".png"):
            os.remove(os.path.join(sprites, fn))
    states, firsts = {}, []
    for sid, label, fn, loop in STATES:
        frames = fn()
        rels = []
        for i, (im, _) in enumerate(frames):
            rel = "sprites/%s_%02d.png" % (sid, i)
            up(im).save(os.path.join(PACK, rel), optimize=True)
            rels.append(rel)
        states[sid] = {"label": label, "frames": rels, "durationsMs": [d for _, d in frames], "loop": loop}
        firsts.append((sid, frames[min(len(frames) - 1, {"jumping": 2, "review": 3, "running": 3,
                                                           "failed": 3, "waving": 0}.get(sid, 0))][0]))
        print("%-15s %d" % (sid, len(frames)))

    with open(os.path.join(PACK, "character.json"), encoding="utf-8") as f:
        old = json.load(f)
    data = {
        "id": "whale-girl",
        "name": old.get("name", "鲸鱼娘"),
        "demo": False,
        "canvas": [W * K, H * K],
        "logicalScale": K,
        "displayScale": DISPLAY_SCALE,
        "states": states,
        "aliases": {"working": "running", "done": "review", "alert": "failed", "poke": "jumping"},
        "moods": {"开心": "mood-happy", "惊讶": "mood-surprised", "疑惑": "mood-confused",
                  "思考": "mood-thinking", "困": "mood-sleepy", "委屈": "mood-sad"},
        "lookDirections": [],
        "art": old.get("art", {"license": "CC-BY-NC-SA-4.0", "credits": "CREDITS.md"}),
    }
    with open(os.path.join(PACK, "character.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    preview(firsts)


def preview(firsts):
    """每个状态取一帧横排；右端并排 demo-cat idle（都按各自 displayScale 显示，看桌面上的实际大小）。"""
    cat_dir = os.path.join(ROOT, "characters", "demo-cat")
    with open(os.path.join(cat_dir, "character.json"), encoding="utf-8") as f:
        cat_scale = json.load(f)["displayScale"]
    cat = Image.open(os.path.join(cat_dir, "sprites", "idle_00.png")).convert("RGBA")
    cw, ch = round(W * K * DISPLAY_SCALE), round(H * K * DISPLAY_SCALE)
    kw, kh = round(cat.width * cat_scale), round(cat.height * cat_scale)
    gap, lab = 8, 14
    cell_h = max(ch, kh)
    sheet = Image.new("RGBA", (gap + (cw + gap) * len(firsts) + 16 + kw + gap, cell_h + lab + gap * 2), (232, 230, 238, 255))
    d = ImageDraw.Draw(sheet)
    x = gap
    for sid, im in firsts:
        sheet.alpha_composite(up(im).resize((cw, ch), Image.NEAREST), (x, gap + cell_h - ch))
        d.text((x + 2, gap + cell_h + 2), sid, fill=(32, 31, 51, 255))
        x += cw + gap
    x += 16
    d.line((x - 12, gap, x - 12, gap + cell_h), fill=(160, 158, 176, 255))
    sheet.alpha_composite(cat.resize((kw, kh), Image.NEAREST), (x, gap + cell_h - kh))
    d.text((x + 2, gap + cell_h + 2), "demo-cat idle", fill=(32, 31, 51, 255))
    sheet.convert("RGB").save(os.path.join(PACK, "preview_sheet.png"), optimize=True)


if __name__ == "__main__":
    main()
