# -*- coding: utf-8 -*-
"""把 whale-extension-covers-v1 的拓展包封面导入成设置页头像（2026-11-15）。

素材（只读）：一个素材目录（命令行参数或环境变量 PACK_COVERS_SRC 指定），里面是 {music,reading,calendar}.png（1254×1254，满版带底色）
输出：web/packs/{listen,reading,calendar}.png，168×168（设置页头像框 56px，3 倍图，高分屏也不糊）。

封面是插画式的像素风（约 8 倍放大），缩小用 LANCZOS 保留细节，不做最近邻。

用法：python tools/import_pack_avatars.py <素材目录>      （或先设环境变量 PACK_COVERS_SRC）
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("PACK_COVERS_SRC") or (sys.argv[1] if len(sys.argv) > 1 else "")
OUT = os.environ.get("PACK_AVATARS_OUT") or os.path.join(ROOT, "web", "packs")
SIZE = 168
# 素材文件名 -> 设置页里的包名（「一起听歌」在页面上叫 listen）
MAP = {"music.png": "listen.png", "reading.png": "reading.png", "calendar.png": "calendar.png"}


def main():
    if not SRC or not os.path.isdir(SRC):
        sys.exit("用法：python tools/import_pack_avatars.py <素材目录>（或设环境变量 PACK_COVERS_SRC）")
    os.makedirs(OUT, exist_ok=True)
    for src_name, out_name in MAP.items():
        im = Image.open(os.path.join(SRC, src_name)).convert("RGBA")
        side = min(im.size)
        left, top = (im.width - side) // 2, (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS)
        im.save(os.path.join(OUT, out_name), optimize=True)
        print(out_name, im.size)


if __name__ == "__main__":
    main()
