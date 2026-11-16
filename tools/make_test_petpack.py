#!/usr/bin/env python
"""生成 M1 测试拓展包（petdev.m1-demo，版本 1.0.0，.petpack 容器；全部合成素材，无真实美术/私人数据）。

    <可用 Python（law_env）> tools/make_test_petpack.py [--out <路径>]

默认写到 ../dist/petdev.m1-demo-1.0.0.petpack。打印一行 JSON：{out, size, sha256}——
把 size/sha256 填进 contracts/catalog.json 的条目就能走下载安装；直接用设置页「导入 .petpack」也行。
"""
import argparse
import hashlib
import io
import json
import os
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PACK_ID = "petdev.m1-demo"
VERSION = "1.0.0"

MANIFEST = {
    "id": PACK_ID,
    "version": VERSION,
    "name": "M1 演示包",
    "manifestVersion": 1,
    "packApi": 1,
    "license": "MIT",
    "publisher": "petdev",
    "summary": "M1 闭环用的小桌子和坐垫（合成素材）",
    "requires": {"core": "^0.1.0"},
    "permissions": [],
    "platforms": ["win32"],
    "entryFurniture": {"id": "m1-demo-desk", "dir": "furniture/m1-demo-desk"},
    "characterAdapters": [],
    "resources": {"icon": "assets/icon.png"},
}

FURNITURE = {
    "id": "m1-demo-desk",
    "name": "演示小桌",
    "version": 1,
    "size": [48, 32],
    "anchor": "bottom-right",
    "defaultEnabled": True,
    "order": 90,
    "idle": "idle",
    "states": {
        "idle": {"label": "待机", "frames": ["sprites/idle_00.png"], "durationsMs": [1200]},
        "sit": {"label": "坐着", "frames": ["sprites/sit_00.png"], "durationsMs": [1200]},
    },
    "interactions": [
        {"verb": "坐", "mode": "inside", "state": "sit", "enterPose": "curl-sleep", "say": "坐下歇会儿", "holdMs": 4000},
        {"verb": "起身", "mode": "exit", "done": "好嘞"},
    ],
}


def png_bytes(size, color):
    im = Image.new("RGBA", size, color)
    w, h = size
    im.paste((255, 255, 255, 200), (w // 4, h // 4, w * 3 // 4, h * 3 // 4))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def build():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(MANIFEST, ensure_ascii=False, indent=2))
        zf.writestr("furniture/m1-demo-desk/furniture.json", json.dumps(FURNITURE, ensure_ascii=False, indent=2))
        zf.writestr("furniture/m1-demo-desk/sprites/idle_00.png", png_bytes((48, 32), (120, 170, 220, 255)))
        zf.writestr("furniture/m1-demo-desk/sprites/sit_00.png", png_bytes((48, 32), (150, 200, 150, 255)))
        zf.writestr("assets/icon.png", png_bytes((64, 64), (90, 130, 200, 255)))
        zf.writestr("README.md", "# %s\n\nM1 事务安装闭环的测试包：一件小桌子（内含进出互动）。\n" % PACK_ID)
        zf.writestr("LICENSE", "MIT\n")
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "..", "dist", "%s-%s.petpack" % (PACK_ID, VERSION)))
    a = ap.parse_args()
    out_path = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    data = build()
    with open(out_path, "wb") as f:
        f.write(data)
    print(json.dumps({"out": out_path, "size": len(data),
                      "sha256": hashlib.sha256(data).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
