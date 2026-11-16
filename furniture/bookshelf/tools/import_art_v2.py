# -*- coding: utf-8 -*-
"""把 pixel-bookshelf-v1 的正式美术导入成书架运行帧（2026-11-15，替换占位美术）。

素材（只读）：一个素材目录（命令行参数或环境变量 BOOKSHELF_ART_SRC 指定），里面是
  pull-book_00..15.png（256×256，原生像素尺寸，脚底线 y=218）+ animation.json（时序，loop=false）

规则：
- 不缩放（素材本身就是运行像素尺寸），最近邻、RGBA、透明背景原样保留。
- 所有帧按同一个裁剪框裁（16 帧并集 bbox + 2px 边），书往外抽的轨迹不会被裁掉、帧之间不跳。
- idle = 第 0 帧（书都在架上）；read = 全部 16 帧（抽出一本书，播一次停在最后一帧）。
- 写出：sprites/idle_00.png、sprites/read_00..15.png、preview.png，并改 furniture.json 的 size / floorY / stand / states。

用法：python import_art_v2.py <素材目录>      （或先设环境变量 BOOKSHELF_ART_SRC）
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("BOOKSHELF_BASE") or os.path.dirname(HERE)  # furniture/bookshelf（测试可指到临时副本）
SRC = os.environ.get("BOOKSHELF_ART_SRC") or ""
PAD = 2


def main():
    src = SRC or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not src or not os.path.isdir(src):
        sys.exit("用法：python import_art_v2.py <素材目录>（或设环境变量 BOOKSHELF_ART_SRC）；目录里要有 animation.json 和 pull-book_*.png")
    anim = json.load(open(os.path.join(src, "animation.json"), encoding="utf-8"))
    st = anim["states"]["pull-book"]
    floor = int(anim["standingFloorY"])
    frames = [Image.open(os.path.join(src, f)).convert("RGBA") for f in st["frames"]]
    boxes = [im.getbbox() for im in frames]
    l = max(0, min(b[0] for b in boxes) - PAD)
    t = max(0, min(b[1] for b in boxes) - PAD)
    r = min(frames[0].width, max(b[2] for b in boxes) + PAD)
    b = min(frames[0].height, max(floor, max(bb[3] for bb in boxes)) + PAD)
    # 宽高凑成偶数（家具尺寸约定）：往右 / 往上多留 1px 透明边，脚底线位置不变
    if (r - l) % 2:
        r += 1
    if (b - t) % 2:
        t -= 1
    crop = (l, t, r, b)
    out = os.path.join(BASE, "sprites")
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):  # 旧帧另有备份（.tmp/furniture-art-before-20261115），这里只清本目录的 png
        if name.endswith(".png"):
            os.remove(os.path.join(out, name))
    cut = [im.crop(crop) for im in frames]
    cut[0].save(os.path.join(out, "idle_00.png"))
    names = []
    for i, im in enumerate(cut):
        n = "read_%02d.png" % i
        im.save(os.path.join(out, n))
        names.append("sprites/" + n)
    cut[0].save(os.path.join(BASE, "preview.png"))
    w, h = cut[0].size
    shelf = frames[0].getbbox()  # 书都在架上时的书架本体
    meta_path = os.path.join(BASE, "furniture.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    meta["size"] = [w, h]
    meta["floorY"] = floor - t
    # 桌宠站位：左边离书架 40px；右边让开抽出来的书（并集右沿 + 16px）
    meta["stand"] = {"left": -40, "right": w + 16}
    meta["states"] = {
        "idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [1000]},
        "read": {"frames": names, "durationsMs": [int(x) for x in st["durationsMs"]], "loop": False},
    }
    art = dict(meta.get("art") or {})
    art.pop("placeholder", None)
    meta["art"] = art
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("crop", crop, "size", (w, h), "floorY", floor - t, "shelf bbox", shelf, "frames", len(names))


if __name__ == "__main__":
    main()
