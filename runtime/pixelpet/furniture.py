"""Furniture packs: furniture/<id>/furniture.json + sprites/*.png.

Folders starting with "_" or "." (e.g. _template) are never placed on the desktop.
Pure helpers (loading, geometry, config sanitising, tool summary) are Tk-free and tested;
FurnitureWindow only runs inside the pet process.
"""
import json
import os
import time

from .packkit import enumerate_packs
from .validate import check_furniture

MARGIN = 24


def load_furniture(root, with_images=True, user_root=None, extra_roots=None):
    """-> ({id: definition}, {id: readable reason}). Bad packs are skipped, never fatal.

    user_root: the data dir, whose furniture/ holds packs made with "+ 新建家具" and edited copies of
    built-in pieces. The user layer is read first, so a folder with a built-in id overrides it without
    touching the plugin's own files. extra_roots: M1 起的拓展包版本目录（pack_cli 的 store），优先级
    在用户层之后、内置之前。枚举规则（跳过 `_` / `.` / `*.bak-` / 符号链接目录）由 packkit 统一，
    与 JS 侧 lib/packkit.js 同规则。"""
    defs, errors = {}, {}
    layers = [(user_root, True, False)]
    layers += [(p, False, True) for p in (extra_roots or [])]
    layers += [(root, False, False)]
    for base, user, is_pack in layers:
        if not base:
            continue
        for folder in enumerate_packs(base, "furniture"):
            name = os.path.basename(folder)
            if name in defs:
                continue
            rep = check_furniture(folder)
            if not rep.ok(strict=True):
                errors[name] = "; ".join(str(i) for i in rep.errors) or "骨架包（draft）"
                continue
            with open(os.path.join(folder, "furniture.json"), encoding="utf-8") as f:
                defn = json.load(f)
            if with_images:
                from PIL import Image
                defn["_frames"] = {sid: [Image.open(os.path.join(folder, fn)).convert("RGBA") for fn in st["frames"]]
                                   for sid, st in defn["states"].items()}
            defn["_dir"] = folder
            defn["_user"] = user
            if is_pack:
                defn["_pack"] = True
            defs[name] = defn
            errors.pop(name, None)
    order = sorted(defs, key=lambda k: (defs[k].get("order", 50), k))
    return {k: defs[k] for k in order}, errors


# --------------------------------------------------------------------------- occupant overlay
# An "inside" interaction may carry  occupant: {pose, fallback?, anchor?, area?, clipY?, clipPath?, drawnFor?}
# instead of (or besides) an occupied state drawn with one particular character in it:
# the furniture keeps showing its empty frames and the *current* character's pose frames are laid on top.
#   area: [x0, y0, x1, y1]  where the character lies (furniture px). The pose is scaled down uniformly
#         (never up, nearest-neighbour) until its reference opaque box fits, then its bottom-centre is put
#         at the area's bottom-centre. When area is given it decides both size and position (anchor ignored).
#   anchor: [x, y]  (no area) the pose's bottom-centre at 1:1.
#   clipPath: [[x, y], ...]  front edge polyline, x ascending; furniture pixels below it are drawn again
#         over the character (bowl rim, blanket). Between points y is interpolated linearly, outside the
#         x range the nearest end's y holds. clipY: the flat special case (used when clipPath is absent).
OCCUPANT_POSES = ("curl-sleep", "lie", "idle")
_FIT_CACHE = {}


def fill_name(text, name):
    """'{name}' in done / hint texts -> the running character's name."""
    return str(text or "").replace("{name}", name or "它")


def _nums(v, n):
    return isinstance(v, (list, tuple)) and len(v) == n and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)


def occ_area(spec):
    a = (spec or {}).get("area")
    return tuple(a) if _nums(a, 4) and a[0] < a[2] and a[1] < a[3] else None


def occ_clip_path(spec):
    p = (spec or {}).get("clipPath")
    if not (isinstance(p, list) and len(p) >= 2 and all(_nums(q, 2) for q in p)):
        return None
    if any(p[i + 1][0] <= p[i][0] for i in range(len(p) - 1)):
        return None
    return [tuple(q) for q in p]


def occupant_spec(inter):
    occ = (inter or {}).get("occupant")
    if not isinstance(occ, dict):
        return None
    if not (_nums(occ.get("anchor"), 2) or occ_area(occ)):
        return None
    return occ


def occupant_pose(states, spec):
    """First pose the character actually has: spec.pose, spec.fallback..., then curl-sleep / lie / idle."""
    want = [spec.get("pose")] + list(spec.get("fallback") or []) + list(OCCUPANT_POSES)
    return next((p for p in want if isinstance(p, str) and p in states), None)


def fit_scale(box, area):
    """Uniform scale <= 1 so box (l, t, r, b) fits inside area (x0, y0, x1, y1)."""
    l, t, r, b = box
    bw, bh = max(1, r - l), max(1, b - t)
    return min(1.0, (area[2] - area[0]) / bw, (area[3] - area[1]) / bh)


def scale_frames(frames, s):
    """Nearest-neighbour downscale of every frame by s (frames returned as-is when s >= 1)."""
    if s >= 1:
        return list(frames)
    from PIL import Image
    return [f.resize((max(1, round(f.width * s)), max(1, round(f.height * s))), Image.NEAREST) for f in frames]


def area_anchor(area):
    return ((area[0] + area[2]) / 2, area[3])


def clip_line(width, clip_path=None, clip_y=None):
    """-> per-column front y for x in 0..width-1, or None when there is no front edge."""
    if clip_path:
        pts = sorted(clip_path)
        out = []
        for x in range(width):
            if x <= pts[0][0]:
                y = pts[0][1]
            elif x >= pts[-1][0]:
                y = pts[-1][1]
            else:
                i = next(k for k in range(1, len(pts)) if x <= pts[k][0])
                (xa, ya), (xb, yb) = pts[i - 1], pts[i]
                y = ya + (yb - ya) * (x - xa) / (xb - xa)
            out.append(y)
        return out
    if clip_y is not None:
        return [clip_y] * width
    return None


def front_mask(base, line):
    """L mask: opaque furniture pixels on / below the front line (these are drawn over the character)."""
    w, h = base.size
    mask = base.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    if line is None:
        return None
    from PIL import Image
    cut = Image.new("L", (w, h), 255)
    for x in range(w):
        top = max(0, min(h, int(round(line[x]))))
        if top:
            cut.paste(0, (x, 0, x + 1, top))
    from PIL import ImageChops
    return ImageChops.multiply(mask, cut)


def compose_occupied(base, occ, anchor, box=None, clip_y=None, clip_path=None, front=None):
    """Empty furniture frame + one character frame -> RGBA image the size of `base`.

    box: the character's reference opaque box (l, t, r, b) in its own frame; default = occ's own bbox.
    front: precomputed front_mask (else built from clip_path / clip_y)."""
    from PIL import Image
    l, t, r, b = box or occ.getchannel("A").getbbox() or (0, 0) + occ.size
    ox, oy = int(round(anchor[0] - (l + r) / 2)), int(round(anchor[1] - b))
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(occ, (ox, oy))
    out = Image.alpha_composite(base, layer)
    if front is None:
        if clip_path is None and clip_y is not None and not (0 <= clip_y < base.size[1]):
            clip_y = None
        front = front_mask(base, clip_line(base.size[0], clip_path, clip_y))
    if front is not None:
        out.paste(base, (0, 0), front)
    return out


def make_occupant(char, defn, inter):
    """-> occupant dict for FurnitureWindow.set_occupant, or None (falls back to the occupied state)."""
    spec = occupant_spec(inter)
    if spec is None:
        return None
    # Characters the occupied art was drawn for keep that hand-drawn frame (better than any overlay).
    drawn = spec.get("drawnFor")
    if isinstance(drawn, list) and char.id in drawn and inter.get("state") in defn["states"]:
        return None
    pose = occupant_pose(char.states, spec)
    if pose is None:
        return None
    frames = char.frames[pose]
    box = frames[0].getchannel("A").getbbox() or (0, 0) + frames[0].size
    area = occ_area(spec)
    if area:
        ck = (char.id, pose, id(frames[0]), defn.get("id"), area)
        if ck not in _FIT_CACHE:
            if len(_FIT_CACHE) > 16:
                _FIT_CACHE.clear()
            s = fit_scale(box, area)
            scaled = scale_frames(frames, s)
            sbox = scaled[0].getchannel("A").getbbox() or (0, 0) + scaled[0].size
            _FIT_CACHE[ck] = (scaled, sbox)
        frames, box = _FIT_CACHE[ck]
        anchor = area_anchor(area)
    else:
        anchor = tuple(spec["anchor"])
    under = spec.get("under") if spec.get("under") in defn["states"] else defn["idle"]
    return {"key": "%s/%s" % (char.id, pose), "pose": pose, "frames": frames, "durations": char.durations(pose),
            "anchor": anchor, "box": box, "clipY": spec.get("clipY"), "clipPath": occ_clip_path(spec),
            "under": under, "masks": {}}


def sanitize_cfg(raw):
    """settings.furniture -> {id: {enabled?, x?, y?}} with bad values dropped."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for fid, item in raw.items():
        if not isinstance(fid, str) or not isinstance(item, dict):
            continue
        clean = {}
        if isinstance(item.get("enabled"), bool):
            clean["enabled"] = item["enabled"]
        if all(isinstance(item.get(k), int) and not isinstance(item[k], bool) and abs(item[k]) < 100000 for k in ("x", "y")):
            clean["x"], clean["y"] = item["x"], item["y"]
        out[fid] = clean
    return out


# A furniture "feature" may hang off an extension switch in settings: the piece is placed / offered to the AI
# only while that switch is on, on top of its own furniture toggle. reading (书架) -> settings.reading.enabled,
# calendar (台历) -> settings.calendar.enabled.
FEATURE_GATES = {"reading": "reading", "calendar": "calendar"}


def gate_open(defn, cfg):
    """False only when the piece's feature has a gate and that settings switch is not on. cfg None = no gating."""
    key = FEATURE_GATES.get((defn or {}).get("feature"))
    if key is None or not isinstance(cfg, dict):
        return True
    sec = cfg.get(key)
    return isinstance(sec, dict) and sec.get("enabled") is True


def sync_sig(fcfg, cfg=None):
    """Signature of everything that decides which furniture is placed (furniture cfg + gate switches)."""
    gates = {f: gate_open({"feature": f}, cfg) for f in sorted(FEATURE_GATES)}
    return json.dumps([fcfg, gates], sort_keys=True)


def is_enabled(defn, fcfg, cfg=None):
    if not gate_open(defn, cfg):
        return False
    return bool(fcfg.get(defn["id"], {}).get("enabled", defn.get("defaultEnabled", False)))


def scaled_size(defn, factor):
    return max(8, round(defn["size"][0] * factor)), max(8, round(defn["size"][1] * factor))


def default_spot(anchor, w, h, work, taken):
    """Default (left, bottom) inside a work area; `taken` = {anchor: px used}, stacked inward."""
    l, t, r, b = work
    used = taken.get(anchor, 0)
    if anchor == "bottom-left":
        spot = (l + MARGIN + used, b)
    elif anchor == "top-right":
        spot = (r - MARGIN - w - used, t + MARGIN + h)
    elif anchor == "top-left":
        spot = (l + MARGIN + used, t + MARGIN + h)
    elif anchor == "taskbar":
        spot = ((l + r) // 2 - w // 2 - used, b)
    else:
        spot = (r - MARGIN - w - used, b)
    taken[anchor] = used + w + MARGIN
    return int(spot[0]), int(spot[1])


def clamp_spot(left, bottom, w, h, work):
    l, t, r, b = work
    return int(max(l, min(left, r - w))), int(max(t + h, min(bottom, b)))


def stand_spot(defn, left, bottom, factor, pet_box, side):
    """Pet window (x, y) so the pet's feet sit on the furniture floor line at stand[side]."""
    cl, ct, cr, cb = pet_box
    stand = defn.get("stand") or {}
    w, h = defn["size"]
    f = max(factor, .01)
    sx = stand.get(side, -cr * 0.4 / f if side == "left" else w + cr * 0.4 / f)
    floor = defn.get("floorY", h - 4)
    cx = left + sx * factor
    feet = bottom - (h - floor) * factor
    return int(round(cx - (cl + cr) / 2)), int(round(feet - cb))


def pick_side(pet_center_x, left, w):
    return "left" if pet_center_x <= left + w / 2 else "right"


def summary(defs, fcfg, name=None, cfg=None):
    """What an AI may use right now (enabled pieces only; cfg = full settings for feature gates)."""
    return [{"id": fid, "name": d["name"],
             "interactions": [{"verb": i["verb"], "say": fill_name(i.get("say", ""), name),
                               "hint": fill_name(i.get("hint", ""), name)}
                              for i in d.get("interactions", [])]}
            for fid, d in defs.items() if is_enabled(d, fcfg, cfg)]


class FurnitureWindow:
    """One furniture piece on the desktop. Tk thread only."""

    def __init__(self, pet, defn):
        import tkinter as tk
        from . import window as W
        from .state import FrameClock
        self.pet = pet
        self.defn = defn
        self.id = defn["id"]
        self.base_state = defn["idle"]
        self.temp = None
        self.occupant = None
        self.occ_clock = FrameClock()
        self.clock = FrameClock()
        self.cache = {}
        self.visible = True
        self.left = self.bottom = 0
        self._key = None
        self._drag = None
        self.win, self.cv = W.overlay(tk.Toplevel(pet.root), *self.size(), topmost=pet.topmost)
        self.cv.bind("<ButtonPress-1>", self._press)
        self.cv.bind("<B1-Motion>", self._motion)
        self.cv.bind("<ButtonRelease-1>", self._release)
        self.hwnd = W.native_flags(self.win)

    def factor(self):
        return self.pet.factor()

    def size(self):
        return scaled_size(self.defn, self.factor())

    def rect(self):
        w, h = self.size()
        return self.left, self.bottom - h, self.left + w, self.bottom

    def place(self, left, bottom):
        from . import window as W
        self.left, self.bottom = int(left), int(bottom)
        W.set_pos(self.win, self.hwnd, self.left, self.bottom - self.size()[1])

    def below(self, pet_hwnd):
        from . import window as W
        W.z_below(self.hwnd, pet_hwnd)

    def show(self, on):
        if on == self.visible:
            return
        self.visible = on
        if on:
            self.win.deiconify()
            self.place(self.left, self.bottom)
        else:
            self.win.withdraw()

    def set_temp(self, state, seconds):
        if state in self.defn["states"]:
            self.temp = (state, time.monotonic() + seconds)

    def current_state(self, now):
        if self.temp and self.temp[1] > now:
            return self.temp[0]
        self.temp = None
        return self.base_state if self.base_state in self.defn["states"] else self.defn["idle"]

    def set_occupant(self, occ):
        """occ from make_occupant(), or None to show the furniture alone again."""
        self.occupant = occ
        self.occ_clock.state = None
        self._key = None

    def frame_image(self, state, idx, oidx=None):
        """Raw (unscaled) RGBA for one frame, occupant laid on top when there is one."""
        base = self.defn["_frames"][state][idx]
        occ = self.occupant
        if occ is None or oidx is None:
            return base
        masks = occ.setdefault("masks", {})
        if (state, idx) not in masks:               # front edge mask: once per furniture frame, not per tick
            masks[(state, idx)] = front_mask(base, clip_line(base.size[0], occ.get("clipPath"), occ.get("clipY")))
        return compose_occupied(base, occ["frames"][oidx % len(occ["frames"])], occ["anchor"], occ["box"],
                                front=masks[(state, idx)])

    def tick(self, now, reduced=False):
        from . import window as W
        state = self.current_state(now)
        st = self.defn["states"][state]
        # loop:false = 播一次停在最后一帧（2026-11-15 书架「抽出一本书」）；缺省照旧循环
        idx = self.clock.tick(state, st["durationsMs"], now, reduced, st.get("loop", True) is not False)
        occ = self.occupant
        oidx = self.occ_clock.tick(occ["key"], occ["durations"], now, reduced) if occ else None
        f = self.factor()
        key = (state, idx, occ and occ["key"], oidx, round(f, 3))
        if key == self._key:
            return
        if key not in self.cache:
            if len(self.cache) > 48:
                self.cache.clear()
            self.cache[key] = W.photo(self.frame_image(state, idx, oidx), f)
        img = self.cache[key]
        self.cv.delete("all")
        self.cv.create_image(0, 0, image=img, anchor="nw")
        self._img = img
        w, h = img.width(), img.height()
        if (int(self.cv.cget("width")), int(self.cv.cget("height"))) != (w, h):
            self.cv.configure(width=w, height=h)
            self.win.geometry("%dx%d" % (w, h))
            self.place(self.left, self.bottom)
        self._key = key

    def _press(self, e):
        self._drag = (e.x_root, e.y_root, self.left, self.bottom, False)

    def _motion(self, e):
        if not self._drag:
            return
        x0, y0, l0, b0, moved = self._drag
        if not moved and abs(e.x_root - x0) <= 4 and abs(e.y_root - y0) <= 4:
            return
        self._drag = (x0, y0, l0, b0, True)
        self.place(l0 + e.x_root - x0, b0 + e.y_root - y0)

    def _release(self, e):
        drag, self._drag = self._drag, None
        if not drag:
            return
        if drag[4]:
            self.pet.on_furniture_moved(self.id, self.left, self.bottom)
        else:
            self.pet.on_furniture_click(self.id)

    def destroy(self):
        try:
            self.win.destroy()
        except Exception:  # noqa: BLE001
            pass
