# -*- coding: utf-8 -*-
"""把 pixel-diary-table-v1 的正式美术（带三层抽屉的小桌，桌上一本台历 + 一本日记）导入成台历家具运行帧。

素材（只读）：一张 diary-table-drawers.png（1254×1254，命令行参数或环境变量 DESK_TABLE_ART_SRC 指定）
  ImageGen 输出是「约 8 倍放大的像素图」，边缘有半透明杂点、像素格不严格。

规则：
- 先把 alpha 二值化（≥128 算实心）找家具本体的 bbox，去掉边缘杂点。
- 按目标高度 TARGET_H 逻辑像素等比缩小：BOX 取平均（每个大色块收成一个像素），再把 alpha 二值化，边缘干净不发虚。
- 四周留 2px 透明边；脚底线 = 桌腿最低处。
- idle、open 用同一帧（素材只有一张；点台历时桌宠那边有「凑近看」的动作）。

用法：python import_art_v1.py <图片路径>      （或先设环境变量 DESK_TABLE_ART_SRC）
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # furniture/desk-calendar
SRC = os.environ.get("DESK_TABLE_ART_SRC") or ""
TARGET_H = 140   # 逻辑像素；角色站立高约 172，这张小桌到她胸口左右
PAD = 2


def binarize(im):
    r, g, b, a = im.split()
    a = a.point(lambda v: 255 if v >= 128 else 0)
    out = Image.merge("RGBA", (r, g, b, a))
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            if px[x, y][3] == 0:
                px[x, y] = (0, 0, 0, 0)
    return out


def main():
    path = SRC or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not path or not os.path.isfile(path):
        sys.exit("用法：python import_art_v1.py <图片路径>（或设环境变量 DESK_TABLE_ART_SRC）")
    src = Image.open(path).convert("RGBA")
    solid = binarize(src)
    box = solid.getbbox()
    body = solid.crop(box)
    s = TARGET_H / body.height
    w = max(1, round(body.width * s))
    small = binarize(src.crop(box).resize((w, TARGET_H), Image.BOX))
    cw0 = w + PAD * 2
    cw0 += cw0 % 2  # 宽度凑偶数（家具尺寸约定），多出的 1px 透明边留在右侧
    canvas = Image.new("RGBA", (cw0, TARGET_H + PAD * 2), (0, 0, 0, 0))
    canvas.alpha_composite(small, (PAD, PAD))
    out = os.path.join(BASE, "sprites")
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):  # 旧占位帧另有备份（.tmp/furniture-art-before-20261115）
        if name.endswith(".png"):
            os.remove(os.path.join(out, name))
    canvas.save(os.path.join(out, "idle_00.png"))
    canvas.save(os.path.join(out, "open_00.png"))
    canvas.save(os.path.join(BASE, "preview.png"))
    cw, ch = canvas.size
    meta_path = os.path.join(BASE, "furniture.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    meta["size"] = [cw, ch]
    meta["floorY"] = PAD + TARGET_H
    meta["stand"] = {"left": -36, "right": cw + 12}
    meta["states"] = {
        "idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [1000]},
        "open": {"frames": ["sprites/open_00.png"], "durationsMs": [600]},
    }
    meta["art"] = {"license": "plugin-builtin", "credits": "pixel-diary-table-v1（ImageGen，2026-11-15）"}
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("bbox", box, "scale %.4f" % s, "size", (cw, ch), "floorY", PAD + TARGET_H)


if __name__ == "__main__":
    main()
