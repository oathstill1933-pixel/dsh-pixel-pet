"""Raw pictures -> furniture sprites for "+ 新建家具".

    python runtime/furniture_convert.py --src <raw dir> --out <pack dir> --frames empty_00,empty_01 --size 360,300

<pack dir>/furniture.json is already written by lib/furniture-create.js. This script keys out #00FF00 (when a
picture has no alpha of its own), crops all frames by one shared box (so they stay aligned), fits that box into
the card size (nearest neighbour, bottom-centred), binarises alpha, writes sprites/<key>.png and runs the
validator CLI. Last stdout line: {ok, validated, issues, message}.

Re-editing an installed piece: when `<job>/normalize.json` sits next to `--src` (written by
lib/furniture-create.js), this script does NOT re-crop. It normalizes only the frames listed there onto the
card's own grid (frame_normalize.run_brief: green key / hard alpha / card size / the floor line of the piece's
own idle frame) and leaves the pack's existing frames alone; lib/furniture-create.js copies those and validates.
Last stdout line then: {ok, normalize: {...}}.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import frame_normalize  # noqa: E402
from create_convert import ConvertError, _key_green, run_validator  # noqa: E402


def convert(src, out, keys, size):
    from PIL import Image
    ims = []
    for k in keys:
        path = os.path.join(src, k + ".png")
        with Image.open(path) as im:
            ims.append(_key_green(im))
    box = None
    for im in ims:
        b = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0).getbbox()
        if b is None:
            raise ConvertError("抠图后什么都不剩（背景要是透明或纯 #00FF00）")
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    W, H = size
    bw, bh = box[2] - box[0], box[3] - box[1]
    scale = min(W / bw, H / bh)
    nw, nh = max(1, int(round(bw * scale))), max(1, int(round(bh * scale)))
    os.makedirs(os.path.join(out, "sprites"), exist_ok=True)
    for k, im in zip(keys, ims):
        part = im.crop(box).resize((nw, nh), Image.NEAREST)
        a = part.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
        part.putalpha(a)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.paste(part, ((W - nw) // 2, H - nh), part)
        canvas.save(os.path.join(out, "sprites", k + ".png"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--size", required=True)
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    keys = [k for k in a.frames.split(",") if k]
    try:
        size = tuple(int(v) for v in a.size.split(","))
    except ValueError:
        print(json.dumps({"ok": False, "message": "--size 要是 宽,高"}, ensure_ascii=False))
        return 1
    # re-editing an installed piece: <job>/normalize.json says which frames are new and where the piece sits
    try:
        brief = frame_normalize.brief_near(a.src)
    except ConvertError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    if brief is not None:
        try:
            wanted = brief.get("frames") or []
            stray = [k for k in keys if k not in wanted]
            if stray:
                raise ConvertError("这些帧没有归一化说明：%s" % ",".join(stray))
            info = frame_normalize.run_brief(a.src, a.out, brief, size=size)
        except ConvertError as exc:
            print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
            return 1
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "message": "归一化失败：%s" % type(exc).__name__}, ensure_ascii=False))
            return 1
        print(json.dumps({"ok": True, "validated": False, "normalize": info,
                          "message": "只归一化了 %d 张新帧" % len(info["frames"])}, ensure_ascii=False))
        return 0
    try:
        convert(a.src, a.out, keys, size)
    except ConvertError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "message": "转换失败：%s" % type(exc).__name__}, ensure_ascii=False))
        return 1
    ok, issues, summary = run_validator(a.out)
    print(json.dumps({"ok": ok, "validated": True, "issues": issues, "message": summary}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
