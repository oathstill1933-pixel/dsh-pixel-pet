# -*- coding: utf-8 -*-
"""把 Codex v1 原图（1536×1536）导入成运行帧（192×208）。

规则（照 DELIVERY_CODEX_V1.md）：
- 坐标系：参考画布 1254×1254 置于 (141,250)，站立脚底线 src y=1488。
- 统一缩放 s：让待机站立高度（bbox 顶到脚底线）在运行帧里与旧帧同高（172px）。
- 水平：角色 bbox 中心对齐画布中心 x=96。
- 垂直：src 脚底线 y=1488 映射到 target y=204。
- 每帧按同一变换整幅缩放后贴入，因此跳跃/趴卧/拖拽各自的离地关系自然保留。
运行帧：RGBA、空背景透明、最近邻取样（像素风不糊）。

用法：python import_codex_v1.py [--dry]
"""
import json
import os
import shutil
import sys
import time

from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # characters/whale-girl
SRC = os.path.join(BASE, "tools", "source", "codex")
OUT = os.path.join(BASE, "sprites")
META = os.path.join(BASE, "character.json")
ANIM = os.path.join(SRC, "animation-codex-v1.json")

CANVAS = (192, 208)
SRC_FLOOR_Y = 1488
TARGET_FLOOR_Y = 204
TARGET_HEIGHT = 172          # 站立角色在运行帧里的高度
TARGET_CENTER_X = CANVAS[0] // 2

# character.json 里已有、但 Codex 批次没有的状态（旧占位帧），导入时不动
KEEP_AS_IS = {"lie"}  # 若批次里有 lie 则覆盖，见下方逻辑


def compute_transform():
    ref = Image.open(os.path.join(SRC, "idle_00.png"))
    bbox = ref.getbbox()
    height = SRC_FLOOR_Y - bbox[1]          # 头顶到脚底线
    s = TARGET_HEIGHT / height
    center_src_x = (bbox[0] + bbox[2]) / 2.0
    x0 = TARGET_CENTER_X - center_src_x * s
    y0 = TARGET_FLOOR_Y - SRC_FLOOR_Y * s
    return s, x0, y0, bbox


def render(s, x0, y0, path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    im = im.resize((nw, nh), Image.NEAREST)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.alpha_composite(im, (round(x0), round(y0)))
    return canvas


def backup_sprites(tag):
    """每次导入前另建一份带时间戳的备份；绝不删除或覆盖已有备份。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = os.path.join(BASE, "sprites_bak-%s-%s" % (stamp, tag))
    n = 1
    while os.path.exists(bak):
        n += 1
        bak = os.path.join(BASE, "sprites_bak-%s-%s-%d" % (stamp, tag, n))
    shutil.copytree(OUT, bak)
    shutil.copy2(META, os.path.join(bak, "character.json.bak"))
    return bak


def main():
    dry = "--dry" in sys.argv
    anim = json.load(open(ANIM, encoding="utf-8"))
    meta = json.load(open(META, encoding="utf-8"))
    s, x0, y0, bbox = compute_transform()
    print("scale=%.5f x0=%.1f y0=%.1f idle_bbox=%s" % (s, x0, y0, bbox))

    if not dry:
        print("backup ->", backup_sprites("preimport"))

    made = 0
    for state, spec in anim["states"].items():
        frames = spec["frames"]
        out_frames = []
        for i, fn in enumerate(frames):
            src = os.path.join(SRC, fn)
            if not os.path.exists(src):
                print("MISSING", state, fn)
                continue
            img = render(s, x0, y0, src)
            name = "%s_%02d.png" % (state, i)
            if not dry:
                img.save(os.path.join(OUT, name))
            out_frames.append("sprites/" + name)
            made += 1
        entry = {"label": spec.get("label", state), "frames": out_frames,
                 "durationsMs": spec["durationsMs"], "loop": spec.get("loop", True)}
        meta["states"][state] = entry

    if not dry:
        json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("frames written:", made, "states:", len(anim["states"]))
    else:
        print("dry run: would write", made, "frames")


if __name__ == "__main__":
    main()
