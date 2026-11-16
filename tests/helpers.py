import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from pixelpet.validate import REQUIRED_STATES  # noqa: E402


def png(path, size=(192, 208), mode="RGBA", empty=False, color=(40, 60, 120, 255)):
    from PIL import Image
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im = Image.new(mode, size, (0, 0, 0, 0) if mode == "RGBA" else (0, 0, 0))
    if not empty:
        w, h = size
        im.paste(color if mode == "RGBA" else color[:3], (w // 4, h // 4, w * 3 // 4, h * 3 // 4))
    im.save(path)


def make_character(root, cid="tester", states=REQUIRED_STATES, frames=2, looks=0, extra=None, write_png=True):
    folder = os.path.join(root, "characters", cid)
    st = {}
    for sid in states:
        names = ["sprites/%s_%02d.png" % (sid, i) for i in range(frames)]
        if write_png:
            for n in names:
                png(os.path.join(folder, n))
        st[sid] = {"label": sid, "frames": names, "durationsMs": [120] * frames, "loop": True}
    data = {"id": cid, "name": "Tester", "demo": False, "canvas": [192, 208], "logicalScale": 2, "displayScale": 1.0,
            "states": st, "aliases": {"working": "running"}, "moods": {"happy": "waving"}, "lookDirections": []}
    if looks:
        data["lookDirections"] = [{"degrees": i * 22.5, "frame": "sprites/look_%02d.png" % i} for i in range(looks)]
        for i in range(looks):
            png(os.path.join(folder, "sprites/look_%02d.png" % i))
    if extra:
        extra(data)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "character.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return folder


def make_furniture(root, fid="box", size=(120, 80), extra=None):
    folder = os.path.join(root, "furniture", fid)
    for n in ("sprites/empty_00.png", "sprites/full_00.png"):
        png(os.path.join(folder, n), size=size)
    data = {"id": fid, "name": "Box", "size": list(size), "anchor": "bottom-left", "defaultEnabled": True,
            "floorY": size[1] - 6, "stand": {"left": 10, "right": size[0] - 10}, "idle": "empty",
            "states": {"empty": {"frames": ["sprites/empty_00.png"], "durationsMs": [1000]},
                       "full": {"frames": ["sprites/full_00.png"], "durationsMs": [1000]}},
            "interactions": [{"verb": "sleep", "mode": "inside", "state": "full", "enterPose": "jumping",
                              "done": "ok", "say": "s", "hint": "h"},
                             {"verb": "wake", "mode": "exit", "done": "ok"}]}
    if extra:
        extra(data)
    with open(os.path.join(folder, "furniture.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return folder


_MADE = []


def _cleanup():
    import shutil
    base = os.path.realpath(tempfile.gettempdir())
    for d in _MADE:
        real = os.path.realpath(d)
        # only folders this helper created, directly under the temp dir
        if os.path.dirname(real) == base and os.path.basename(real).startswith("pixelpet-test-"):
            shutil.rmtree(real, ignore_errors=True)


def tmpdir():
    """Scratch folder for one test; removed when the test process exits (they used to pile up in %TEMP%)."""
    d = tempfile.mkdtemp(prefix="pixelpet-test-")
    if not _MADE:
        import atexit
        atexit.register(_cleanup)
    _MADE.append(d)
    return d
