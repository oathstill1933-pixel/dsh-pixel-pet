"""Manifest validator for character and furniture packs.

    python runtime/validate.py characters/<id>        # one pack
    python runtime/validate.py --all                    # every pack under characters/ and furniture/
    python runtime/validate.py --strict characters/x   # draft packs fail too

Every problem is an Issue(level, where, message): `where` is "<pack>/<file> › <json path>",
`message` says what is wrong and what is expected. Never raises on bad input.
"""
import json
import os
import re

from . import CANVAS, LOGICAL_SCALE

REQUIRED_STATES = ("idle", "walk-left", "walk-right", "waving", "jumping", "failed",
                   "waiting", "running", "review", "lie")
OPTIONAL_STATES = ("listening", "attentive", "curl-sleep", "drag-left", "drag-right", "speaking")
OPTIONAL_PREFIXES = ("mood-", "act-")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
STATE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
DURATION_RANGE = (40, 5000)

FURNITURE_ANCHORS = ("bottom-right", "bottom-left", "top-right", "top-left", "taskbar")
FURNITURE_MODES = ("inside", "exit", "beside")


class Issue:
    __slots__ = ("level", "where", "message")

    def __init__(self, level, where, message):
        self.level, self.where, self.message = level, where, message

    def __repr__(self):
        return "%s  %s: %s" % ("ERROR" if self.level == "error" else "warn ", self.where, self.message)

    __str__ = __repr__


class Report:
    def __init__(self, pack, kind):
        self.pack, self.kind = pack, kind
        self.issues = []
        self.frames_checked = 0
        self.draft = False

    def err(self, path, msg):
        self.issues.append(Issue("error", self._where(path), msg))

    def warn(self, path, msg):
        self.issues.append(Issue("warn", self._where(path), msg))

    def _where(self, path):
        f = "character.json" if self.kind == "character" else "furniture.json"
        return "%s/%s%s" % (self.pack, f, (" › " + path) if path else "")

    @property
    def errors(self):
        return [i for i in self.issues if i.level == "error"]

    def ok(self, strict=False):
        if self.errors:
            return False
        return not (strict and self.draft)


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _str(v):
    return isinstance(v, str) and v.strip() != ""


def _read_json(folder, name, rep):
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        rep.err("", "找不到 %s（每个包的根目录必须有它）" % name)
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except UnicodeDecodeError:
        rep.err("", "不是 UTF-8 编码，请另存为 UTF-8")
        return None
    except json.JSONDecodeError as exc:
        rep.err("", "JSON 语法错误：第 %d 行第 %d 列，%s" % (exc.lineno, exc.colno, exc.msg))
        return None
    if not isinstance(data, dict):
        rep.err("", "顶层必须是对象 {...}")
        return None
    return data


def _safe_rel(p):
    return isinstance(p, str) and p.startswith("sprites/") and ".." not in p.replace("\\", "/").split("/") \
        and not os.path.isabs(p) and p.lower().endswith(".png")


def _check_frame(folder, rel, path, rep, expect_size, size_label):
    if not _safe_rel(rel):
        rep.err(path, "帧路径必须是 sprites/ 下的相对 .png 路径，不能含 ..，现在是 %r" % (rel,))
        return
    full = os.path.join(folder, rel)
    if not os.path.isfile(full):
        rep.err(path, "文件不存在：%s" % rel)
        return
    try:
        if size_label == "canvas":
            with open(full, "rb") as f:
                header = f.read(33)
            if (len(header) != 33 or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
                    or header[24:26] != b"\x08\x06"):
                rep.err(path, "帧必须是 8 位 RGBA PNG")
                return
        from PIL import Image
        with Image.open(full) as im:
            size, mode = im.size, im.mode
            if im.format != "PNG":
                rep.err(path, "帧必须是 PNG")
                return
            alpha = im.getchannel("A").getbbox() if mode == "RGBA" else None
    except Exception as exc:  # noqa: BLE001
        rep.err(path, "读不了图片 %s：%s" % (rel, type(exc).__name__))
        return
    rep.frames_checked += 1
    if tuple(size) != tuple(expect_size):
        rep.err(path, "%s 尺寸是 %dx%d，%s 要求 %dx%d" % (rel, size[0], size[1], size_label, expect_size[0], expect_size[1]))
    if mode != "RGBA":
        rep.err(path, "%s 是 %s 模式，必须是带透明通道的 RGBA PNG" % (rel, mode))
    elif alpha is None:
        rep.err(path, "%s 整张全透明，看不到任何像素" % rel)


def _check_frames_block(folder, st, path, rep, expect_size, size_label, draft):
    frames, durs = st.get("frames"), st.get("durationsMs")
    if not isinstance(frames, list):
        rep.err(path + ".frames", "必须是数组")
        return
    if not isinstance(durs, list):
        rep.err(path + ".durationsMs", "必须是数组（每帧一个毫秒数）")
        return
    if not frames:
        (rep.warn if draft else rep.err)(path + ".frames", "还没有帧" + ("（骨架包，允许）" if draft else ""))
    elif len(durs) != len(frames):
        rep.err(path + ".durationsMs", "长度 %d 与 frames 长度 %d 不一致" % (len(durs), len(frames)))
    for i, d in enumerate(durs):
        if not (_int(d) and DURATION_RANGE[0] <= d <= DURATION_RANGE[1]):
            rep.err("%s.durationsMs[%d]" % (path, i), "要是 %d–%d 之间的整数毫秒，现在是 %r" % (DURATION_RANGE + (d,)))
    for i, rel in enumerate(frames):
        _check_frame(folder, rel, "%s.frames[%d]" % (path, i), rep, expect_size, size_label)


# --------------------------------------------------------------------------- character
def check_character(folder, pack_name=None):
    folder = os.path.abspath(folder)
    name = pack_name or "characters/" + os.path.basename(folder)
    rep = Report(name, "character")
    data = _read_json(folder, "character.json", rep)
    if data is None:
        return rep
    draft = data.get("draft") is True
    rep.draft = draft
    if not (_str(data.get("id")) and ID_RE.match(data["id"])):
        rep.err("id", "要是小写字母、数字、- 组成的 1–40 位字符串")
    elif data["id"] != os.path.basename(folder):
        rep.err("id", "必须和目录名一致：目录是 %r，id 是 %r" % (os.path.basename(folder), data["id"]))
    if not _str(data.get("name")):
        rep.err("name", "缺显示名")
    if not isinstance(data.get("demo", False), bool):
        rep.err("demo", "只能是 true / false")
    canvas = data.get("canvas")
    if canvas != list(CANVAS):
        rep.err("canvas", "必须是 [%d, %d]（帧格子固定），现在是 %r" % (CANVAS + (canvas,)))
        canvas = list(CANVAS)
    if data.get("logicalScale") != LOGICAL_SCALE:
        rep.err("logicalScale", "必须是 %d（1 个逻辑像素 = %dx%d 实际像素）" % (LOGICAL_SCALE, LOGICAL_SCALE, LOGICAL_SCALE))
    ds = data.get("displayScale", 1.0)
    if not (_num(ds) and 0.25 <= ds <= 4):
        rep.err("displayScale", "要是 0.25–4 之间的数字")

    states = data.get("states")
    if not isinstance(states, dict) or not states:
        rep.err("states", "必须是非空对象 {状态id: {...}}")
        states = {}
    from .packkit import PackKitError, load_contract, read_voice_preset

    rules = load_contract()["character"]
    roles = set()
    missing = [s for s in REQUIRED_STATES if s not in states]
    if missing:
        rep.err("states", "缺必需状态：%s" % ", ".join(missing))
    for sid, st in states.items():
        p = "states.%s" % sid
        if not STATE_RE.match(str(sid)):
            rep.err(p, "状态 id 只能用小写字母、数字、-")
        if sid not in REQUIRED_STATES and sid not in OPTIONAL_STATES and not sid.startswith(OPTIONAL_PREFIXES) and not (isinstance(st, dict) and "role" in st):
            rep.warn(p, "不是约定的状态名（必需 / 可选 / mood-* / act-*），引擎只会在被显式指名时用它")
        if not isinstance(st, dict):
            rep.err(p, "必须是对象 {label, frames, durationsMs, loop}")
            continue
        if not _str(st.get("label")):
            rep.err(p + ".label", "缺 label（给人看的状态名）")
        if not isinstance(st.get("loop", True), bool):
            rep.err(p + ".loop", "只能是 true / false")
        req = st.get("requires")
        valid_req = isinstance(req, dict) and set(req) == {"feature"} and req["feature"] in rules["stateFeatures"]
        if "requires" in st and not valid_req:
            rep.err(p + ".requires", '只支持 {feature: "listen"}')
        if "role" in st:
            role = st["role"]
            if role not in rules["musicRoles"] or role in roles or not valid_req:
                rep.err(p + ".role", "音乐 role 须唯一，并声明 requires.feature: listen")
            else:
                roles.add(role)
        _check_frames_block(folder, st, p, rep, canvas, "canvas", draft)

    aliases = data.get("aliases", {})
    if not isinstance(aliases, dict):
        rep.err("aliases", "必须是对象 {别名: 状态id}")
    else:
        for a, target in aliases.items():
            if target not in states:
                rep.err("aliases.%s" % a, "指向不存在的状态 %r" % (target,))
            if a in states:
                rep.err("aliases.%s" % a, "别名和已有状态重名")
    moods = data.get("moods", {})
    if not isinstance(moods, dict):
        rep.err("moods", "必须是对象 {情绪标签: 状态id}")
    else:
        for tag, target in moods.items():
            if target not in states:
                rep.err("moods.%s" % tag, "指向不存在的状态 %r" % (target,))
    looks = data.get("lookDirections", [])
    if not isinstance(looks, list):
        rep.err("lookDirections", "必须是数组")
    elif looks and len(looks) != 16:
        if not (draft and not any(isinstance(l, dict) and l.get("frame") for l in looks)):
            rep.err("lookDirections", "要么不给（不跟随鼠标），要么正好 16 个方向，现在是 %d 个" % len(looks))
    else:
        for i, item in enumerate(looks):
            p = "lookDirections[%d]" % i
            if not isinstance(item, dict):
                rep.err(p, "必须是对象 {degrees, frame}")
                continue
            want = i * 22.5
            if not (_num(item.get("degrees")) and abs(item["degrees"] - want) < 1e-6):
                rep.err(p + ".degrees", "第 %d 个方向应为 %.1f°（0=上，顺时针每格 22.5°）" % (i, want))
            _check_frame(folder, item.get("frame"), p + ".frame", rep, canvas, "canvas")
    try:
        read_voice_preset(folder)
    except PackKitError as exc:
        rep.err("voice/preset.json", str(exc))
    return rep


# --------------------------------------------------------------------------- furniture
def _in_bounds(x, y, size):
    return not size or (-size[0] <= x <= 2 * size[0] and -size[1] <= y <= 2 * size[1])


def _occ_shape_errors(occ, size):
    """occupant.area / occupant.clipPath -> [(field, message)]. Bounds: within the furniture ± its size."""
    out = []
    if "area" in occ:
        a = occ["area"]
        if not (isinstance(a, list) and len(a) == 4 and all(_num(v) for v in a)):
            out.append(("area", "要是 [x0, y0, x1, y1]：角色躺的区域（家具图像素）"))
        elif not (a[0] < a[2] and a[1] < a[3]):
            out.append(("area", "要 x0 < x1 且 y0 < y1，现在是 %r" % (a,)))
        elif not (_in_bounds(a[0], a[1], size) and _in_bounds(a[2], a[3], size)):
            out.append(("area", "离家具太远了：%r" % (a,)))
    if "clipPath" in occ:
        c = occ["clipPath"]
        if not (isinstance(c, list) and 2 <= len(c) <= 24
                and all(isinstance(q, list) and len(q) == 2 and all(_num(v) for v in q) for q in c)):
            out.append(("clipPath", "要是 2–24 个 [x, y] 点：前沿折线"))
        elif any(c[i + 1][0] <= c[i][0] for i in range(len(c) - 1)):
            out.append(("clipPath", "点的 x 要从左到右严格递增"))
        elif not all(_in_bounds(x, y, size) for x, y in c):
            out.append(("clipPath", "有点离家具太远了"))
    return out


def check_furniture(folder, pack_name=None):
    folder = os.path.abspath(folder)
    name = pack_name or "furniture/" + os.path.basename(folder)
    rep = Report(name, "furniture")
    data = _read_json(folder, "furniture.json", rep)
    if data is None:
        return rep
    draft = data.get("draft") is True
    rep.draft = draft
    fid = data.get("id")
    if not (_str(fid) and ID_RE.match(fid)):
        rep.err("id", "要是小写字母、数字、- 组成的 1–40 位字符串")
    elif fid != os.path.basename(folder) and not os.path.basename(folder).startswith("_"):
        rep.err("id", "必须和目录名一致：目录是 %r，id 是 %r" % (os.path.basename(folder), fid))
    if not _str(data.get("name")):
        rep.err("name", "缺显示名")
    size = data.get("size")
    if not (isinstance(size, list) and len(size) == 2 and all(_int(v) and 8 <= v <= 1200 for v in size)):
        rep.err("size", "要是 [宽, 高] 两个 8–1200 的整数像素，现在是 %r" % (size,))
        size = None
    if data.get("anchor", "bottom-right") not in FURNITURE_ANCHORS:
        rep.err("anchor", "只能是 %s" % " / ".join(FURNITURE_ANCHORS))
    if size:
        fy = data.get("floorY", size[1] - 4)
        if not (_num(fy) and 0 <= fy <= size[1]):
            rep.err("floorY", "要是 0–%d 之间的数字（家具图内地面线的 y）" % size[1])
        stand = data.get("stand", {})
        if not isinstance(stand, dict) or any(k not in ("left", "right") or not (_num(v) and -size[0] <= v <= 2 * size[0])
                                              for k, v in stand.items()):
            rep.err("stand", "要是 {left?: x, right?: x}，x 是家具图内的横坐标")
    states = data.get("states")
    if not isinstance(states, dict) or not states:
        rep.err("states", "必须是非空对象 {状态id: {frames, durationsMs}}")
        states = {}
    for sid, st in states.items():
        p = "states.%s" % sid
        if not isinstance(st, dict):
            rep.err(p, "必须是对象 {frames, durationsMs}")
            continue
        _check_frames_block(folder, st, p, rep, size or (0, 0), "size", draft)
    if data.get("idle") not in states:
        rep.err("idle", "要指向一个已有状态，现在是 %r" % (data.get("idle"),))
    inters = data.get("interactions", [])
    if not isinstance(inters, list):
        rep.err("interactions", "必须是数组")
        inters = []
    verbs = set()
    for i, it in enumerate(inters):
        p = "interactions[%d]" % i
        if not isinstance(it, dict) or not _str(it.get("verb")):
            rep.err(p, "每条互动要有 verb")
            continue
        if it["verb"] in verbs:
            rep.err(p + ".verb", "verb 重复：%s" % it["verb"])
        verbs.add(it["verb"])
        mode = it.get("mode", "beside")
        if mode not in FURNITURE_MODES:
            rep.err(p + ".mode", "只能是 %s" % " / ".join(FURNITURE_MODES))
        occ = it.get("occupant")
        if occ is not None:
            a = occ.get("anchor") if isinstance(occ, dict) else None
            has_area = isinstance(occ, dict) and "area" in occ
            if a is None and has_area:
                pass
            elif not (isinstance(a, list) and len(a) == 2 and all(_num(v) for v in a)):
                rep.err(p + ".occupant.anchor", "要是 [x, y]：角色躺进去时身体底边中点落在家具图里的位置（或改给 area）")
            elif size and not (-size[0] <= a[0] <= 2 * size[0] and -size[1] <= a[1] <= 2 * size[1]):
                rep.err(p + ".occupant.anchor", "离家具太远了：%r" % (a,))
            if isinstance(occ, dict):
                for e in _occ_shape_errors(occ, size):
                    rep.err(p + ".occupant." + e[0], e[1])
                if "pose" in occ and not _str(occ["pose"]):
                    rep.err(p + ".occupant.pose", "要是角色状态名，比如 curl-sleep")
                if "clipY" in occ and not (_num(occ["clipY"]) and (not size or 0 <= occ["clipY"] <= size[1])):
                    rep.err(p + ".occupant.clipY", "要是 0–家具高度 之间的数字")
                if "under" in occ and occ["under"] not in states:
                    rep.err(p + ".occupant.under", "要指向一个已有状态")
        if mode == "inside" and it.get("state") not in states and occ is None:
            rep.err(p + ".state", "inside 互动要给 occupant（角色叠加位置），或指明进去后家具显示的 state")
        if "furnitureState" in it and it["furnitureState"] not in states:
            rep.err(p + ".furnitureState", "要指向一个已有状态，现在是 %r" % (it["furnitureState"],))
        if "holdMs" in it and not (_int(it["holdMs"]) and 0 <= it["holdMs"] <= 60000):
            rep.err(p + ".holdMs", "要是 0–60000 之间的整数毫秒")
        for k in ("pose", "enterPose"):
            if k in it and not (isinstance(it[k], str) and STATE_RE.match(it[k])):
                rep.err(p + "." + k, "要是角色状态名（小写字母、数字、-），现在是 %r" % (it[k],))
        for k in ("done", "say", "hint"):
            if k in it and not isinstance(it[k], str):
                rep.err(p + "." + k, "必须是字符串")
    return rep


# --------------------------------------------------------------------------- discovery
def pack_dirs(root, kind):
    base = os.path.join(root, "characters" if kind == "character" else "furniture")
    out = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return out
    for n in names:
        full = os.path.join(base, n)
        if os.path.isdir(full) and not n.startswith("."):
            out.append(full)
    return out


def check_any(folder):
    if os.path.isfile(os.path.join(folder, "character.json")):
        return check_character(folder)
    if os.path.isfile(os.path.join(folder, "furniture.json")):
        return check_furniture(folder)
    rep = Report(os.path.basename(folder), "character")
    rep.issues.append(Issue("error", os.path.basename(folder), "既没有 character.json 也没有 furniture.json"))
    return rep


def main(argv=None):
    import argparse
    import sys
    ap = argparse.ArgumentParser(description="校验角色包 / 家具包")
    ap.add_argument("packs", nargs="*")
    ap.add_argument("--all", action="store_true", help="校验 characters/ 和 furniture/ 下全部包")
    ap.add_argument("--root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    ap.add_argument("--strict", action="store_true", help="骨架包（draft）也算失败")
    a = ap.parse_args(argv)
    folders = [os.path.abspath(p) for p in a.packs]
    if a.all:
        folders += pack_dirs(a.root, "character") + pack_dirs(a.root, "furniture")
    if not folders:
        ap.print_help()
        return 2
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    bad = 0
    for f in folders:
        rep = check_any(f)
        ok = rep.ok(a.strict)
        tag = "OK  " if ok else "FAIL"
        extra = "（骨架）" if rep.draft else ""
        print("%s %s%s — %d 帧已核对，%d 错误，%d 提示" % (tag, rep.pack, extra, rep.frames_checked,
                                                    len(rep.errors), len(rep.issues) - len(rep.errors)))
        for i in rep.issues:
            print("     ", i)
        bad += 0 if ok else 1
    return 1 if bad else 0
