"""定稿图 → 逻辑像素基准帧 base.png（77x86，固定调色板）。

    python tools/extract_base.py [定稿图路径]

定稿图不随包发布；base.png 已提交在 tools/ 里，build_frames.py 只依赖 base.png，
所以没有定稿图也能复现全部帧。重新跑本脚本会覆盖 base.png（结果确定，无随机）。
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from palette import PALETTE, LINE  # noqa: E402

DEFAULT_REF = os.path.join(HERE, "source", "reference.png")   # 定稿图（AI 辅助生成），随包按 CC BY-NC-SA 发布
TARGET_H = 86          # 角色在逻辑画布里的高度（逻辑像素）

# 定稿图里的颜色 → 收敛后的调色板名。键是在定稿图上 kmeans 得到的主色。
SOURCE_TO_PAL = [
    ("#626EA4", "HAIR"), ("#484973", "HAIR_D"), ("#FCF5F6", "WHITE"), ("#1E1B30", "LINE"),
    ("#83A8D5", "TIP"), ("#525684", "HAIR_D"), ("#FAEAE9", "SKIN"), ("#7185B9", "HAIR_L"),
    ("#25243D", "LINE"), ("#D7C8D7", "WHITE_D"), ("#35395E", "NAVY"), ("#121024", "LINE"),
    ("#F8CEBC", "BLUSH"), ("#BBB2C7", "FIN_IN"), ("#A697A0", "FIN_IN"), ("#81707D", "HAIR_D"),
]


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def extract(ref):
    a = np.array(Image.open(ref).convert("RGBA")).astype(float)
    op = a[..., 3] > 128
    ys, xs = np.where(op)
    a, op = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1], op[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    src = np.array([hexrgb(h) for h, _ in SOURCE_TO_PAL], float)
    names = [n for _, n in SOURCE_TO_PAL]
    h, w = op.shape
    lab = np.full((h, w), len(src), int)
    flat = a[..., :3][op]
    out_lab = np.empty(len(flat), int)
    for i in range(0, len(flat), 200000):
        out_lab[i:i + 200000] = np.argmin(((flat[i:i + 200000, None, :] - src[None]) ** 2).sum(-1), 1)
    lab[op] = out_lab
    H = TARGET_H
    W = round(H * w / h)
    gy = np.linspace(0, h, H + 1).astype(int)
    gx = np.linspace(0, w, W + 1).astype(int)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = out.load()
    for j in range(H):
        for i in range(W):
            y0, y1, x0, x1 = gy[j], gy[j + 1], gx[i], gx[i + 1]
            m, n = max(1, (y1 - y0) // 5), max(1, (x1 - x0) // 5)     # 只取格子中心，避开相邻格的渗色
            cell = lab[y0 + m:y1 - m, x0 + n:x1 - n].ravel()
            k = np.argmax(np.bincount(cell, minlength=len(src) + 1))
            if k < len(src):
                px[i, j] = PALETTE[names[k]]
    return out


def cleanup(im):
    W, H = im.size
    px = im.load()
    # 1) 孤立杂点：四邻都和自己不同、且四邻里有 3 个以上同色 → 归入那个颜色（脸部不动，保住眼睛高光）
    for _ in range(2):
        snap = im.copy().load()
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                if 20 <= x <= 50 and 30 <= y <= 50:
                    continue
                c = snap[x, y]
                nb = [snap[x - 1, y], snap[x + 1, y], snap[x, y - 1], snap[x, y + 1]]
                if c in nb:
                    continue
                best = max(set(nb), key=nb.count)
                if nb.count(best) >= 3:
                    px[x, y] = best
    # 2) 外轮廓统一用描边色
    snap = im.copy().load()
    for y in range(H):
        for x in range(W):
            if snap[x, y][3] == 0:
                continue
            edge = any(not (0 <= x + dx < W and 0 <= y + dy < H) or snap[x + dx, y + dy][3] == 0
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            if edge:
                px[x, y] = LINE
    return im


if __name__ == "__main__":
    ref = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REF
    base = cleanup(extract(ref))
    base.save(os.path.join(HERE, "base.png"))
    print("base.png", base.size)
