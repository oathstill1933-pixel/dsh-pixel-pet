"""Build the LOCAL-ONLY demo packs (characters/demo-cat, furniture/demo-bed) from an existing
private pet folder, for smoke tests. Both output folders are gitignored and listed in
PUBLISH-EXCLUDE.md: they must never be published.

    python tools/make_demo_packs.py --cat-src <folder with manifest.json + sprites/> \
                                    --bed-src <folder with furniture.json + sprites/>
"""
import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENAME = {"running-left": "drag-left", "running-right": "drag-right"}


def backup(path):
    if os.path.exists(path):
        bak = path + ".bak-20261110"
        if os.path.exists(bak):
            shutil.rmtree(bak) if os.path.isdir(bak) else os.remove(bak)
        shutil.move(path, bak)


def make_cat(src, dest):
    with open(os.path.join(src, "manifest.json"), encoding="utf-8") as f:
        m = json.load(f)
    backup(dest)
    os.makedirs(os.path.join(dest, "sprites"))
    states = {}
    for sid, st in m["states"].items():
        new = RENAME.get(sid, sid)
        frames = []
        for p in st["frames"]:
            shutil.copyfile(os.path.join(src, p), os.path.join(dest, "sprites", os.path.basename(p)))
            frames.append("sprites/" + os.path.basename(p))
        states[new] = {"label": new, "frames": frames, "durationsMs": st["durationsMs"], "loop": st.get("loop", True)}
    looks = []
    for item in m.get("lookDirections", []):
        shutil.copyfile(os.path.join(src, item["frame"]), os.path.join(dest, "sprites", os.path.basename(item["frame"])))
        looks.append({"degrees": item["degrees"], "frame": "sprites/" + os.path.basename(item["frame"])})
    aliases = {k: RENAME.get(v, v) for k, v in m.get("aliases", {}).items() if RENAME.get(v, v) in states}
    moods = {k: v for k, v in m.get("moods", {}).items() if v in states}
    out = {"id": "demo-cat", "name": "demo cat", "demo": True, "canvas": m["canvas"], "logicalScale": 2,
           "displayScale": m.get("displayScale", 1.35), "states": states, "aliases": aliases, "moods": moods,
           "lookDirections": looks}
    with open(os.path.join(dest, "character.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    return len(states)


def make_bed(src, dest):
    with open(os.path.join(src, "furniture.json"), encoding="utf-8") as f:
        d = json.load(f)
    backup(dest)
    os.makedirs(os.path.join(dest, "sprites"))
    for st in d["states"].values():
        for p in st["frames"]:
            shutil.copyfile(os.path.join(src, p), os.path.join(dest, "sprites", os.path.basename(p)))
    d["id"], d["name"], d["demo"] = "demo-bed", "demo bed", True
    neutral = {"sleep": ("去床上睡觉", "用户说去睡觉、困了、晚安时用"), "wake": ("起床", "用户叫它起床时用")}
    for it in d.get("interactions", []):
        for k in [k for k in it if k.endswith("_hint")]:
            it.pop(k)
        say, hint = neutral.get(it["verb"], (it.get("say", ""), ""))
        it.update(say=say, hint=hint, done="好了。")
    with open(os.path.join(dest, "furniture.json"), "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cat-src", required=True)
    ap.add_argument("--bed-src", required=True)
    a = ap.parse_args()
    n = make_cat(a.cat_src, os.path.join(ROOT, "characters", "demo-cat"))
    make_bed(a.bed_src, os.path.join(ROOT, "furniture", "demo-bed"))
    print("demo-cat: %d states; demo-bed ok (local only, gitignored)" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
