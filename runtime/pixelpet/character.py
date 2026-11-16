"""Character pack loading: characters/<id>/character.json + sprites/*.png."""
import json
import os

from .packkit import enumerate_packs, resolve_one
from .validate import check_character


class PackError(Exception):
    def __init__(self, report):
        self.report = report
        lines = [str(i) for i in report.errors] or ["骨架包（draft: true）还不能运行"]
        super().__init__("%s 加载失败：\n  %s" % (report.pack, "\n  ".join(lines)))


class Character:
    """Validated character with decoded RGBA frames. Construct via load_character()."""

    def __init__(self, folder, data, frames, looks):
        self.folder = folder
        self.data = data
        self.id = data["id"]
        self.name = data["name"]
        self.demo = bool(data.get("demo", False))
        self.canvas = tuple(data["canvas"])
        self.logical_scale = data["logicalScale"]
        self.display_scale = float(data.get("displayScale", 1.0))
        self.states = data["states"]
        self.base_states = {sid: state for sid, state in self.states.items()
                            if (state.get("requires") or {}).get("feature") != "listen"}
        self.aliases = dict(data.get("aliases", {}))
        self.moods = dict(data.get("moods", {}))
        self.frames = frames          # {state: [PIL.Image RGBA]}
        self.look_frames = looks      # [PIL.Image] (16 or empty)

    def resolve(self, value):
        if not isinstance(value, str):
            return None
        value = self.aliases.get(value, value)
        return value if value in self.states else None

    def durations(self, state):
        return self.states[state]["durationsMs"]

    def loops(self, state):
        return self.states[state].get("loop", True)

    def total_ms(self, state):
        return sum(self.durations(state))

    def pose_names(self):
        """Names the control API accepts for `pose`: generic ones + mood-* short names + mood tags."""
        names = {"sit": None, "idle": None, "lie": "lie", "wave": "waving", "jump": "jumping"}
        for name, sid in (("work", "running"), ("wait", "waiting"), ("done", "review"), ("failed", "failed"),
                          ("listen", "listening"), ("attentive", "attentive")):
            if sid in self.states:
                names[name] = sid
        for sid in self.states:
            if sid.startswith("mood-"):
                names[sid[5:]] = sid
            if sid.startswith("act-"):
                names[sid] = sid
        for tag, sid in self.moods.items():
            names[tag] = sid
        return names


def character_folder(pack_root, data_dir, cid):
    """Resolve user, authorized extension, then built-in character."""
    found = resolve_one(pack_root, data_dir, "character", cid)
    return found["dir"] if found else os.path.join(pack_root, "characters", cid)


def load_character(folder, with_images=True):
    folder = os.path.abspath(folder)
    rep = check_character(folder)
    if not rep.ok(strict=True):
        raise PackError(rep)
    with open(os.path.join(folder, "character.json"), encoding="utf-8") as f:
        data = json.load(f)
    frames, looks = {}, []
    if with_images:
        from PIL import Image
        for sid, st in data["states"].items():
            frames[sid] = [Image.open(os.path.join(folder, p)).convert("RGBA") for p in st["frames"]]
        looks = [Image.open(os.path.join(folder, l["frame"])).convert("RGBA") for l in data.get("lookDirections", [])]
    return Character(folder, data, frames, looks)


def list_characters(root):
    """[{id, name, demo, draft, ok}] for every folder under characters/ (bad packs included, marked).

    枚举走 packkit：与 furniture/加载、JS 侧同规则（跳过 `_` / `.` / `*.bak-` / 符号链接目录）。"""
    out = []
    for folder in enumerate_packs(root, "character"):
        rep = check_character(folder)
        meta = {"id": os.path.basename(folder), "name": os.path.basename(folder), "demo": False}
        try:
            with open(os.path.join(folder, "character.json"), encoding="utf-8") as f:
                d = json.load(f)
            meta.update(name=d.get("name") or meta["name"], demo=bool(d.get("demo")))
        except Exception:  # noqa: BLE001
            pass
        meta.update(draft=rep.draft, ok=rep.ok(strict=True), errors=len(rep.errors))
        out.append(meta)
    return out
