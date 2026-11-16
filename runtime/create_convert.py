"""Raw images -> character pack for "+ 新建角色".

    python runtime/create_convert.py --src <raw dir> --out <pack dir> --spec <spec.json> [--converter nearest|native]

<raw dir> holds one image per frame named <state>_<NN>.png (look_00..look_15 for gaze).
<spec.json> is written by lib/create.js: {id, name, states: [{id, label, loop, durationsMs, single, required, frames: [keys]}]}.

Steps: convert every frame to a 192x208 RGBA canvas -> write sprites/ + character.json (draft when a required
state has no frames) -> run the existing validator CLI (runtime/validate.py) on the result.
The last stdout line is one JSON object: {ok, draft, validated, states, warnings, issues, message}.

Converter seam: `convert_groups(groups, converter)` below. "nearest" is the placeholder (green key + nearest-neighbour
fit into the canvas). "native" calls characters/whale-girl/tools/native_grid.py (run_batch), the native grid
sampler: one source cell -> one pixel, no scaling, no palette reduction.

Re-editing an installed pack: when `<job>/normalize.json` sits next to `--src` (written by lib/create.js), this
script does NOT build a pack. It only normalizes the frames listed there into `<out>/sprites/` via
frame_normalize.run_brief (green key / hard alpha / target canvas / foot line of the pack's own idle frame) and
prints {ok, normalize: {...}}. The pack's existing frames never come through here.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import frame_normalize  # noqa: E402  (same folder; owns the green-key / alpha / placement primitives)
from frame_normalize import ConvertError, key_green as _key_green  # noqa: E402,F401

CANVAS = (192, 208)
FOOT_Y = 204
NATIVE_TOOLS = os.path.join(ROOT, "characters", "whale-girl", "tools")
MOOD_TAGS = {"mood-happy": "开心", "mood-surprised": "惊讶", "mood-confused": "疑惑", "mood-thinking": "思考",
             "mood-sleepy": "困", "mood-sad": "委屈", "mood-oops": "闯祸"}
ALIASES = {"working": "running", "done": "review", "alert": "failed", "poke": "jumping"}


# --------------------------------------------------------------------------- converters
# _key_green / ConvertError come from frame_normalize (one implementation for both flows)


def nearest_frame(path):
    """Placeholder: key out the green, fit the whole picture into the canvas with nearest-neighbour, feet at FOOT_Y.
    Same source size -> same placement, so frames of one action stay aligned."""
    from PIL import Image
    with Image.open(path) as src:
        im = _key_green(src)
    w, h = im.size
    scale = min(CANVAS[0] / w, FOOT_Y / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    small = im.resize((nw, nh), Image.NEAREST)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.paste(small, ((CANVAS[0] - nw) // 2, FOOT_Y - nh), small)
    if canvas.getchannel("A").getbbox() is None:
        raise ConvertError("%s 抠图后什么都不剩（背景要是纯 #00FF00 或透明）" % os.path.basename(path))
    return canvas


def _native_groups(groups):
    sys.path.insert(0, NATIVE_TOOLS)
    import native_grid  # noqa: E402  (another task owns this file; we only call it)
    from PIL import Image
    paths = [p for items in groups.values() for p in items]
    results, warnings = native_grid.run_batch(paths, align="source", log=lambda *a: None)
    out = {}
    for state, items in groups.items():
        r = results.get(state)
        if not r:
            raise ConvertError("native_grid 没有返回 %s" % state)
        out[state] = [Image.fromarray(f["canvas"], "RGBA") for f in r["frames"]]
    return out, list(warnings)


def convert_groups(groups, converter="nearest"):
    """{state: [raw paths in frame order]} -> ({state: [192x208 RGBA PIL images]}, [warnings]).

    >>> REPLACEMENT POINT for the native grid converter <<<
    Anything that keeps this signature can be plugged in; --converter native already routes to native_grid.run_batch.
    """
    if converter == "native":
        return _native_groups(groups)
    return {s: [nearest_frame(p) for p in items] for s, items in groups.items()}, []


# --------------------------------------------------------------------------- pack
def _logical_scale():
    """1 (one source cell = one pixel). Until the validator accepts 1, fall back to whatever it requires."""
    try:
        from pixelpet import LOGICAL_SCALE
        from pixelpet.validate import check_character
    except Exception:  # noqa: BLE001
        return 1
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        probe = os.path.join(d, "probe")
        os.makedirs(probe)
        with open(os.path.join(probe, "character.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "probe", "name": "p", "canvas": list(CANVAS), "logicalScale": 1, "states": {}}, f)
        rep = check_character(probe)
        if any(i.where.endswith("logicalScale") for i in rep.issues):
            return LOGICAL_SCALE
    return 1


def build_pack(src, out, spec, converter="nearest"):
    groups, single = {}, {}
    for st in spec["states"]:
        files = [os.path.join(src, k + ".png") for k in st["frames"] if os.path.isfile(os.path.join(src, k + ".png"))]
        if files:
            (single if st.get("single") else groups)[st["id"]] = files
    frames, warnings = convert_groups({**groups, **single}, converter)
    sprites = os.path.join(out, "sprites")
    os.makedirs(sprites, exist_ok=True)
    states, counts, draft = {}, {}, False
    looks = []
    for st in spec["states"]:
        sid = st["id"]
        imgs = frames.get(sid, [])
        keys = [k for k in st["frames"] if os.path.isfile(os.path.join(src, k + ".png"))]
        rels = []
        for k, im in zip(keys, imgs):
            rel = "sprites/%s.png" % k
            im.save(os.path.join(out, rel))
            rels.append(rel)
        counts[sid] = len(rels)
        if st.get("single"):
            if len(rels) == st["expected"]:
                looks = [{"degrees": i * 22.5, "frame": r} for i, r in enumerate(rels)]
            elif rels:
                warnings.append("视线只有 %d/16 张，先不启用鼠标跟随" % len(rels))
            continue
        if not rels and not st.get("required"):
            continue
        if len(rels) < st["expected"]:
            if st.get("required") and not rels:
                draft = True
            elif rels:
                warnings.append("%s 只有 %d/%d 帧" % (sid, len(rels), st["expected"]))
        durs = [int(d) for d in st["durationsMs"][:len(rels)]] if rels else []
        while len(durs) < len(rels):
            durs.append(160)
        states[sid] = {"label": st.get("label") or sid, "frames": rels, "durationsMs": durs, "loop": bool(st.get("loop", True))}
    manifest = {
        "id": spec["id"], "name": spec.get("name") or spec["id"], "demo": False, "draft": draft,
        "canvas": list(CANVAS), "logicalScale": _logical_scale(), "displayScale": 1.2,
        "states": states,
        "aliases": {a: t for a, t in ALIASES.items() if states.get(t, {}).get("frames")},
        "moods": {tag: sid for sid, tag in MOOD_TAGS.items() if states.get(sid, {}).get("frames")},
        "lookDirections": looks,
    }
    if not draft:
        manifest.pop("draft")
    with open(os.path.join(out, "character.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return {"draft": draft, "states": counts, "warnings": warnings}


def run_validator(pack):
    """the existing validator CLI, unchanged; returns (ok, issue lines)"""
    p = subprocess.run([sys.executable, os.path.join(HERE, "validate.py"), pack], capture_output=True,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    text = p.stdout.decode("utf-8", "replace")
    lines = [ln.strip() for ln in text.splitlines()[1:] if ln.strip()]
    return p.returncode == 0, lines, (text.splitlines() or [""])[0].strip()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--converter", choices=("nearest", "native"), default=os.environ.get("PIXELPET_CONVERTER", "nearest"))
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    # re-editing an installed pack: <job>/normalize.json lists the frames that were regenerated / imported
    # after the reverse job was made. Only those are converted; the pack's own frames are copied by create.js
    # untouched and the manifest is written there, so this mode writes frames only and does not validate.
    try:
        brief = frame_normalize.brief_near(a.src)
    except ConvertError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    if brief is not None:
        try:
            info = frame_normalize.run_brief(a.src, a.out, brief)
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
        r = build_pack(a.src, a.out, spec, a.converter)
    except ConvertError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "message": "转换失败：%s" % type(exc).__name__}, ensure_ascii=False))
        return 1
    ok, issues, summary = run_validator(a.out)
    print(json.dumps({"ok": ok, "validated": True, "draft": r["draft"], "states": r["states"], "converter": a.converter,
                      "warnings": r["warnings"], "issues": issues, "message": summary}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
