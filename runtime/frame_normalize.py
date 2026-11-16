"""把「新生成 / 新导入」的帧归一化到目标包自己的帧格子（再编辑时用）。

    python runtime/frame_normalize.py --src <job>/raw --out <job>/build/<id> --brief <job>/normalize.json

为什么单独出来：

* 再编辑一个已经装好的包时，包里原有的帧**已经是** 192x208 / size 大小的成品，
  它们必须逐字节直通、绝不重新裁剪或缩放（重新采样会让比例和落脚点漂移）。
* 只有「重新生成某帧」「新导入某帧」拿到的原图（多半是 1024 见方的绿底大图）需要归一化：
  抠掉 #00FF00 底色 -> 硬 alpha -> 按原包的格子缩放 -> 对准原包的落脚点/水平中心 -> 贴进帧格子。
* 目标几何不写死：调用方（lib/create.js / lib/furniture-create.js）把「从原包读回来的参考帧」
  放进 brief，落脚线和水平中心从那一帧的 alpha 包围盒量出来。

brief（由 JS 写在 job 根目录，和 raw/ 同级）：

    {
      "kind": "character" | "furniture",
      "frames": ["waving_01", "mood-happy_02"],   # 只列「非原有」的帧
      "canvas": [192, 208],                        # character；furniture 用 "size": [w, h]
      "grid": 2,                                   # 贴图偏移对齐到几个像素（character = logicalScale）
      "ref": "raw/idle_00.png"                     # 原包里的参考帧，相对 job 目录；可省略
    }

`run_brief()` 返回的 frames 里，每个键是 "copied"（本来就规范，原样复制）或 "converted"（归一化过）。
本模块不做包级校验：校验由 lib/create.js / lib/furniture-create.js 在写完整清单后跑 runtime/validate.py。
"""
import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CANVAS = (192, 208)
FOOT_PAD = 4                 # 没有参考帧时，脚底离格子底边的距离（和 native_grid.FOOT_Y 一致）
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}_\d{2}$")


class ConvertError(Exception):
    pass


def _numpy():
    try:
        import numpy
        return numpy
    except ImportError:          # 没有 numpy 也要能跑，慢一点而已
        return None


# --------------------------------------------------------------------------- 底色 / alpha
def key_green(im):
    """#00FF00-ish background -> transparent (only when the picture has no alpha of its own)."""
    im = im.convert("RGBA")
    if im.getchannel("A").getextrema()[0] < 255:
        return im
    np = _numpy()
    if np is not None:
        from PIL import Image
        a = np.array(im)
        r, g, b = (a[..., i].astype(np.int16) for i in range(3))
        a[(g > 160) & (r < 120) & (b < 120) & (g - np.maximum(r, b) > 80)] = 0
        return Image.fromarray(a, "RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if g > 160 and r < 120 and b < 120 and g - max(r, b) > 80:
                px[x, y] = (0, 0, 0, 0)
    return im


def _green_count(im):
    im = im.convert("RGBA")
    if im.getchannel("A").getextrema()[0] < 255:
        return 0
    np = _numpy()
    if np is not None:
        a = np.array(im)
        r, g, b = (a[..., i].astype(np.int16) for i in range(3))
        return int(((g > 160) & (r < 120) & (b < 120) & (g - np.maximum(r, b) > 80)).sum())
    px = im.load()
    n = 0
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if g > 160 and r < 120 and b < 120 and g - max(r, b) > 80:
                n += 1
    return n


def hard_alpha(im):
    """alpha 二值化（像素画不该有半透明边）：>=128 不透明，其余全透明。"""
    return im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)


def alpha_bbox(im):
    """二值化之后的可见范围 (x0, y0, x1, y1)；整张全透明返回 None。"""
    return hard_alpha(im).getbbox()


def is_canonical(path, canvas):
    """已经是目标尺寸的 RGBA、不是整张空、也没有留下绿底 -> 可以直接用，不重新编码。"""
    from PIL import Image
    try:
        with Image.open(path) as im:
            if im.mode != "RGBA" or tuple(im.size) != tuple(canvas):
                return False
            if im.getchannel("A").getbbox() is None:
                return False
            return _green_count(im) == 0
    except Exception:      # noqa: BLE001  坏图交给归一化去报明确的错
        return False


# --------------------------------------------------------------------------- 几何
def geometry_from_ref(path, canvas):
    """参考帧（原包里的 idle 第 0 帧）-> (落脚线 y, 水平中心 x)。

    落脚线取 alpha 包围盒的底边、中心取包围盒的水平中点：新帧贴图时按这两个数对齐，
    所以新画的帧和包里原有的帧站在同一条线上、同一个水平位置。参考帧读不出来时退回格子默认值。
    """
    canvas = (int(canvas[0]), int(canvas[1]))
    fallback = (max(1, canvas[1] - FOOT_PAD), canvas[0] // 2)
    if not path:
        return fallback
    try:
        from PIL import Image
        with Image.open(path) as im:
            box = alpha_bbox(im)
    except Exception:      # noqa: BLE001
        return fallback
    if box is None:
        return fallback
    foot = int(min(max(box[3], 1), canvas[1]))
    center = int(round((box[0] + box[2]) / 2.0))
    return foot, int(min(max(center, 0), canvas[0]))


def normalize_frame(path, dst, canvas, foot_y, center_x, grid=1):
    """一张原图 -> 目标格子上的 RGBA PNG。

    整张原图等比缩到 (格子宽, 落脚线高) 以内（NEAREST：一格对一格，不糊），
    底边贴落脚线、中心贴 center_x，横向偏移再对齐到 grid 像素的逻辑网格上，越界部分裁掉。
    纵向不吸附：脚底必须准确落在参考帧的落脚线上，差一格就会让新帧和原有帧错位。
    """
    from PIL import Image
    cw, ch = int(canvas[0]), int(canvas[1])
    with Image.open(path) as src:
        im = key_green(src)
    w, h = im.size
    if w <= 0 or h <= 0:
        raise ConvertError("%s 是空图" % os.path.basename(path))
    foot = int(min(max(foot_y, 1), ch))
    scale = min(cw / float(w), foot / float(h))
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    small = im.resize((nw, nh), Image.NEAREST)
    small.putalpha(hard_alpha(small))
    if alpha_bbox(small) is None:
        raise ConvertError("%s 抠掉绿底后什么都不剩（背景要是纯 #00FF00 或透明）" % os.path.basename(path))
    g = max(1, int(grid))
    x = int(round(center_x - nw / 2.0))
    x -= x % g          # Python 的 % 对负数也返回非负余数：等于向下对齐
    y = int(foot - nh)
    # 显式裁剪后再贴，不依赖 paste 的越界行为
    sx, sy = max(0, -x), max(0, -y)
    dx, dy = max(0, x), max(0, y)
    pw = min(nw - sx, cw - dx)
    ph = min(nh - sy, ch - dy)
    if pw <= 0 or ph <= 0:
        raise ConvertError("%s 缩放后完全落在格子外面" % os.path.basename(path))
    part = small.crop((sx, sy, sx + pw, sy + ph))
    out = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    out.paste(part, (dx, dy))
    if out.getchannel("A").getbbox() is None:
        raise ConvertError("%s 归一化后什么都不剩" % os.path.basename(path))
    out.save(dst, "PNG")
    return out


# --------------------------------------------------------------------------- brief
def ref_path(job, ref):
    """brief.ref 是相对 job 目录的帧路径（例如 raw/idle_00.png）；只接受包内相对路径。"""
    if not ref:
        return None
    rel = str(ref).replace("\\", "/")
    parts = rel.split("/")
    if rel.startswith("/") or ":" in rel or ".." in parts:
        return None
    return os.path.join(job, *parts)


def brief_near(src):
    """<job>/raw 旁边的 normalize.json（有才算「这次要归一化新帧」）。"""
    file = os.path.join(os.path.dirname(os.path.abspath(src)), "normalize.json")
    if not os.path.isfile(file):
        return None
    try:
        with open(file, encoding="utf-8") as f:
            brief = json.load(f)
    except Exception as exc:      # noqa: BLE001
        raise ConvertError("normalize.json 读不出来：%s" % type(exc).__name__)
    if not isinstance(brief, dict):
        raise ConvertError("normalize.json 顶层要是对象")
    return brief


def run_brief(src, out, brief, size=None):
    """按 brief 只归一化列出来的帧，写进 <out>/sprites/。返回 {frames, footY, centerX, ...}。"""
    frames = [str(k) for k in (brief.get("frames") or []) if k]
    if not frames:
        raise ConvertError("normalize.json 没有列帧")
    kind = brief.get("kind") or "character"
    if kind == "furniture":
        wh = size if size is not None else brief.get("size")
        if not isinstance(wh, (list, tuple)) or len(wh) != 2:
            raise ConvertError("furniture 归一化需要 size [宽, 高]")
        canvas = (int(wh[0]), int(wh[1]))
    else:
        wh = brief.get("canvas") or list(CANVAS)
        if not isinstance(wh, (list, tuple)) or len(wh) != 2:
            raise ConvertError("character 归一化需要 canvas [宽, 高]")
        canvas = (int(wh[0]), int(wh[1]))
    if canvas[0] < 8 or canvas[1] < 8:
        raise ConvertError("帧格子尺寸不对：%r" % (list(canvas),))
    job = os.path.dirname(os.path.abspath(src))
    ref = ref_path(job, brief.get("ref"))
    if ref and not os.path.isfile(ref):
        ref = None
    foot, center = geometry_from_ref(ref, canvas)
    if isinstance(brief.get("footY"), (int, float)):
        foot = int(min(max(int(brief["footY"]), 1), canvas[1]))
    if isinstance(brief.get("centerX"), (int, float)):
        center = int(min(max(int(brief["centerX"]), 0), canvas[0]))
    grid = brief.get("grid", 1)
    grid = 1 if not isinstance(grid, (int, float)) or grid < 1 else int(min(grid, 8))
    sprites = os.path.join(out, "sprites")
    os.makedirs(sprites, exist_ok=True)
    status = {}
    for k in frames:
        if not KEY_RE.match(k):
            raise ConvertError("帧名不合法：%r" % (k,))
        path = os.path.join(src, k + ".png")
        if not os.path.isfile(path):
            raise ConvertError("找不到新帧 %s.png" % k)
        dst = os.path.join(sprites, k + ".png")
        if is_canonical(path, canvas):
            shutil.copyfile(path, dst)
            status[k] = "copied"
        else:
            normalize_frame(path, dst, canvas, foot, center, grid)
            status[k] = "converted"
    return {"kind": kind, "canvas": [canvas[0], canvas[1]], "footY": foot, "centerX": center, "grid": grid,
            "frames": status, "converted": sum(1 for v in status.values() if v == "converted"),
            "copied": sum(1 for v in status.values() if v == "copied"), "warnings": []}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--brief", required=False)
    ap.add_argument("--size", required=False)
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:      # noqa: BLE001
        pass
    try:
        if a.brief:
            with open(a.brief, encoding="utf-8") as f:
                brief = json.load(f)
        else:
            brief = brief_near(a.src)
        if not brief:
            raise ConvertError("没有 normalize.json")
        size = tuple(int(v) for v in a.size.split(",")) if a.size else None
        info = run_brief(a.src, a.out, brief, size=size)
    except ConvertError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "normalize": info}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
