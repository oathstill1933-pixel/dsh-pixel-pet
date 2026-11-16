# -*- coding: utf-8 -*-
"""把 Codex v1 的 16 向注视原图导入运行帧，并在 character.json 里声明 lookDirections。

变换与 import_codex_v1.py 完全一致（同一套缩放/对齐），保证注视帧和状态帧不会错位。
顺序：look_00..look_15，角度从正上开始顺时针每 22.5 度一格（与引擎 degrees_to_gaze 对齐）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_codex_v1 import backup_sprites  # noqa: E402  同一套带时间戳、不覆盖的备份

from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "tools", "source", "codex")
OUT = os.path.join(BASE, "sprites")
META = os.path.join(BASE, "character.json")

CANVAS = (192, 208)
SRC_FLOOR_Y = 1488
TARGET_FLOOR_Y = 204
TARGET_HEIGHT = 172
TARGET_CENTER_X = CANVAS[0] // 2

ref_bbox = Image.open(os.path.join(SRC, "idle_00.png")).getbbox()
s = TARGET_HEIGHT / (SRC_FLOOR_Y - ref_bbox[1])
x0 = TARGET_CENTER_X - ((ref_bbox[0] + ref_bbox[2]) / 2.0) * s
y0 = TARGET_FLOOR_Y - SRC_FLOOR_Y * s


def render(path):
    im = Image.open(path).convert("RGBA")
    nw, nh = max(1, round(im.width * s)), max(1, round(im.height * s))
    im = im.resize((nw, nh), Image.NEAREST)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.alpha_composite(im, (round(x0), round(y0)))
    return canvas


def main():
    print("backup ->", backup_sprites("prelooks"))
    looks = []
    for i in range(16):
        src = os.path.join(SRC, "look_%02d.png" % i)
        if not os.path.exists(src):
            raise SystemExit("缺原图：" + src)
        name = "look_%02d.png" % i
        render(src).save(os.path.join(OUT, name))
        looks.append({"frame": "sprites/" + name, "degrees": i * 22.5})

    meta = json.load(open(META, encoding="utf-8"))
    meta["lookDirections"] = looks
    json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("look frames written: 16, scale=%.5f" % s)


if __name__ == "__main__":
    main()
