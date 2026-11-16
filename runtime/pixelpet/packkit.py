"""packkit — 统一包解析与冻结契约（M0），lib/packkit.js 的 Python 镜像。

单一事实源：contracts/pack-contract-v1.json。两边错误码、版本语法、枚举规则、分层决策必须一致，
由 scripts/pack-conformance.test.mjs + tests/test_pack_conformance.py 钉死。改契约任何值 = 契约变更，
必须升 contractVersion 并同步两份实现与 docs/ 五份规范。

与 JS 侧唯一的有意差异：Python 的包有效性判定走 validate.py 的权威校验（PIL 级终审，含
"整张全透明"检测）；JS 侧只查到 PNG 头级别。两边在合法包上结论一致（一致性测试保证），
运行时对最终能否加载保留否决权 —— 见 docs/PACK_SPEC.md。
"""
import json
import os
import re

from .validate import check_character, check_furniture

_HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_FILE = os.path.abspath(os.path.join(_HERE, "..", "..", "contracts", "pack-contract-v1.json"))

KIND_DIR = {"character": "characters", "furniture": "furniture"}
KIND_FILE = {"character": "character.json", "furniture": "furniture.json"}
PACK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ENGINE_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_DIR_SEG_RE = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]+$")

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")
_PRE_ID_RE = re.compile(r"^(0|[1-9]\d*|[0-9A-Za-z-]+)$")
_PARTIAL_RE = re.compile(r"^((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:\.(?:0|[1-9]\d*))?)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")


class PackKitError(Exception):
    """带稳定错误码的解析错误；code 必须是契约 errorCodes 里的一个。"""

    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _err(code, path, message):
    return {"code": code, "path": path, "message": message}


# --------------------------------------------------------------------------- 契约

_contract_cache = None


def load_contract():
    """冻结契约。缺失 / 损坏 / 未知 contractVersion 都是显式错误，绝不静默降级。"""
    global _contract_cache
    if _contract_cache is not None:
        return _contract_cache
    try:
        with open(CONTRACT_FILE, encoding="utf-8") as f:
            c = json.load(f)
    except (OSError, ValueError) as exc:
        raise PackKitError("E_CONTRACT_MISSING", "读不了冻结契约 %s：%s" % (CONTRACT_FILE, exc)) from exc
    if not isinstance(c, dict):
        raise PackKitError("E_CONTRACT_INVALID", "契约内容不是对象")
    if c.get("contractVersion") != 1:
        raise PackKitError("E_CONTRACT_INVALID", "契约版本不支持：%r" % c.get("contractVersion"))
    for key in ("installStates", "stateTransitions", "errorCodes", "permissions", "capabilities", "character", "furniture", "packManifest"):
        if key not in c:
            raise PackKitError("E_CONTRACT_INVALID", "契约缺少必需段落：%s" % key)
    _contract_cache = c
    return c


def permission_ids():
    return [p["id"] for p in load_contract()["permissions"]]


def capability_ids():
    return [c["id"] for c in load_contract()["capabilities"]]


def describe_permission(pid):
    for p in load_contract()["permissions"]:
        if p["id"] == pid:
            return dict(p)
    raise PackKitError("E_PERMISSION_UNKNOWN", "未知权限：%s" % pid)


def describe_capability(cid):
    for c in load_contract()["capabilities"]:
        if c["id"] == cid:
            return dict(c)
    raise PackKitError("E_CAPABILITY_UNKNOWN", "未知能力：%s" % cid)


# --------------------------------------------------------------------------- 版本三域与最小范围语法


def parse_version(value):
    """严格 SemVer：major.minor.patch[-pre]。不合法 → E_VERSION_MALFORMED。"""
    s = value if isinstance(value, str) else str(value)
    m = VERSION_RE.match(s)
    if not m:
        raise PackKitError("E_VERSION_MALFORMED", "不是合法的 SemVer：%r" % s[:60])
    pre = []
    if m.group(4):
        for part in m.group(4).split("."):
            if not _PRE_ID_RE.match(part):
                raise PackKitError("E_VERSION_MALFORMED", "预发布段不合法：%s" % s)
            if part.isdigit():
                if re.match(r"^0\d", part):
                    raise PackKitError("E_VERSION_MALFORMED", "预发布段数字不能有前导零：%s" % s)
                pre.append(int(part))
            else:
                pre.append(part)
    return {"major": int(m.group(1)), "minor": int(m.group(2)), "patch": int(m.group(3)), "pre": pre, "raw": s}


def _cmp(a, b):
    return (a > b) - (a < b)


def _is_parsed(v):
    return isinstance(v, dict) and isinstance(v.get("major"), int)


def compare_versions(a, b):
    """SemVer 优先级：数字段逐比；预发布 < 正式；预发布段逐比（数字 < 字母数字；缺段更小）。"""
    x = a if _is_parsed(a) else parse_version(a)
    y = b if _is_parsed(b) else parse_version(b)
    c = _cmp(x["major"], y["major"]) or _cmp(x["minor"], y["minor"]) or _cmp(x["patch"], y["patch"])
    if c:
        return c
    if not x["pre"] and not y["pre"]:
        return 0
    if not x["pre"]:
        return 1
    if not y["pre"]:
        return -1
    for i in range(max(len(x["pre"]), len(y["pre"]))):
        xi = x["pre"][i] if i < len(x["pre"]) else None
        yi = y["pre"][i] if i < len(y["pre"]) else None
        if xi is None:
            return -1
        if yi is None:
            return 1
        xn, yn = isinstance(xi, int), isinstance(yi, int)
        if xn and yn:
            c = _cmp(xi, yi)
        elif xn:
            c = -1
        elif yn:
            c = 1
        else:
            c = _cmp(xi, yi)
        if c:
            return c
    return 0


def _parse_partial(s, token):
    m = _PARTIAL_RE.match(s)
    if not m:
        raise PackKitError("E_RANGE_UNSUPPORTED", "范围里的版本不合法：%r" % token[:60])
    parts = [int(x) for x in m.group(1).split(".")]
    while len(parts) < 3:
        parts.append(0)
    pre = []
    if m.group(2):
        for part in m.group(2).split("."):
            if part.isdigit():
                if re.match(r"^0\d", part):
                    raise PackKitError("E_RANGE_UNSUPPORTED", "范围里的预发布段数字不能有前导零：%r" % token[:60])
                pre.append(int(part))
            else:
                pre.append(part)
    return {"major": parts[0], "minor": parts[1], "patch": parts[2], "pre": pre, "partial": len(m.group(1).split(".")) < 3}


def parse_range(value):
    """范围 → 比较器列表。最小语法集，之外一律 E_RANGE_UNSUPPORTED。"""
    s = (value if isinstance(value, str) else str(value)).strip()
    if not s:
        raise PackKitError("E_RANGE_UNSUPPORTED", "空的版本范围")
    if re.search(r"(\|\||\*|\bx\b|[0-9]\s+-\s+[0-9])", s):
        raise PackKitError("E_RANGE_UNSUPPORTED", "范围语法不支持：%r" % s[:60])
    comps = []
    for token in s.split():
        if token.startswith(("^", "~")):
            v = _parse_partial(token[1:], token)
            lower = {"op": ">=", "major": v["major"], "minor": v["minor"], "patch": v["patch"], "pre": v["pre"]}
            if token.startswith("^"):
                if v["major"] > 0:
                    upper = [v["major"] + 1, 0, 0]
                elif v["minor"] > 0:
                    upper = [0, v["minor"] + 1, 0]
                else:
                    upper = [0, 0, v["patch"] + 1]
            else:
                upper = [v["major"], v["minor"] + 1, 0]
            comps.append(lower)
            comps.append({"op": "<", "major": upper[0], "minor": upper[1], "patch": upper[2], "pre": []})
        else:
            m = re.match(r"^(>=|<=|>|<|=)?(.*)$", token)
            v = _parse_partial(m.group(2), token)
            # 裸写或 '=' 加部分版本（1.2 / =1.2）不在最小语法集里：裸版本必须写全三段，避免"1.2 排除 1.2.3"的歧义
            if (not m.group(1) or m.group(1) == "=") and v["partial"]:
                raise PackKitError("E_RANGE_UNSUPPORTED", "裸版本必须写全三段（部分版本只跟 ^ ~ 和比较器）：%s" % token)
            comps.append({"op": m.group(1) or "=", "major": v["major"], "minor": v["minor"], "patch": v["patch"], "pre": v["pre"]})
    return comps


def satisfies_range(version, rng):
    """version 是否满足 range。带预发布号的候选版本只在范围里存在同三元组、显式写预发布号的比较器时才可满足。"""
    v = version if _is_parsed(version) else parse_version(version)
    comps = rng if isinstance(rng, list) and rng and isinstance(rng[0], dict) and "op" in rng[0] else parse_range(rng)
    if v["pre"]:
        gate = any(c["pre"] and (c["major"], c["minor"], c["patch"]) == (v["major"], v["minor"], v["patch"]) for c in comps)
        if not gate:
            return False
    for c in comps:
        d = compare_versions(v, {"major": c["major"], "minor": c["minor"], "patch": c["patch"], "pre": c["pre"], "raw": ""})
        op = c["op"]
        if op == ">=":
            ok = d >= 0
        elif op == "<=":
            ok = d <= 0
        elif op == ">":
            ok = d > 0
        elif op == "<":
            ok = d < 0
        else:
            ok = d == 0
        if not ok:
            return False
    return True


# --------------------------------------------------------------------------- 枚举（规则两侧统一）


def enumerate_packs(root, kind):
    """某个 root 下某类包的目录路径（名字序）。跳过：`.` 前缀、`_` 前缀、名字含 `.bak-`、符号链接目录。

    与 lib/packkit.js enumeratePacks 同规则；validate.py --all 的枚举刻意包含 `_template`，不在此列。"""
    base = os.path.join(root, KIND_DIR[kind])
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return []
    out = []
    for n in names:
        if n.startswith(".") or n.startswith("_") or ".bak-" in n:
            continue
        full = os.path.join(base, n)
        # 链接的包目录可能指向任何地方：绝不透过它读清单
        if not os.path.isdir(full) or os.path.islink(full):
            continue
        out.append(full)
    return out


def read_manifest_strict(folder, kind):
    """严格 JSON 清单读取。语法错 / 顶层非对象 = 无效，绝不按"能解析就行"放行。"""
    path = os.path.join(folder, KIND_FILE[kind])
    if not os.path.isfile(path):
        return {"ok": False, "errors": [_err("E_MANIFEST_MISSING", "", "找不到 %s" % KIND_FILE[kind])]}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except UnicodeDecodeError:
        return {"ok": False, "errors": [_err("E_MANIFEST_JSON_INVALID", "", "不是 UTF-8 编码")]}
    except ValueError as exc:
        return {"ok": False, "errors": [_err("E_MANIFEST_JSON_INVALID", "", "JSON 语法错误：%s" % exc)]}
    if not isinstance(data, dict):
        return {"ok": False, "errors": [_err("E_MANIFEST_JSON_INVALID", "", "顶层必须是对象 {...}")]}
    return {"ok": True, "data": data}


# --------------------------------------------------------------------------- 分层解析（冻结决策）


def read_voice_preset(folder):
    """Read a public preset and return checked absolute paths for the worker."""
    file = os.path.join(folder, "voice", "preset.json")
    if not os.path.lexists(file):
        return None
    rules = load_contract()["voicePreset"]

    def invalid(hint):
        return PackKitError("E_FIELD_INVALID", "音色预设：" + hint)

    def inside(root, path):
        try:
            return path != root and os.path.commonpath([root, path]) == root
        except ValueError:
            return False

    def reject_constant(value):
        raise ValueError(value)

    try:
        root = os.path.realpath(folder)
        voice = os.path.realpath(os.path.join(root, "voice"))
        if not inside(root, voice):
            raise invalid("voice 目录越界")

        def checked(name, max_bytes):
            path = os.path.realpath(os.path.join(voice, name))
            if not inside(voice, path) or not os.path.isfile(path) or os.path.getsize(path) > max_bytes:
                raise invalid(name + " 路径或大小不合法")
            return path

        with open(checked("preset.json", float("inf")), encoding="utf-8") as fh:
            meta = json.load(fh, parse_constant=reject_constant)
        if not isinstance(meta, dict):
            raise invalid("需要 JSON 对象")
        name, text = meta.get("name"), meta.get("text", "")
        if (not isinstance(name, str) or not name.strip() or len(name) > rules["nameMax"]
                or meta.get("mode") not in rules["modes"] or not isinstance(meta.get("language"), str)
                or not isinstance(text, str) or len(text) > rules["textMax"]
                or (meta["mode"] == "icl" and not text.strip())):
            raise invalid("名称、模式、语言或文本不合法")
        ref, anchor = meta.get("ref"), meta.get("anchor")
        if (not isinstance(ref, str) or not re.fullmatch(rules["refRe"], ref)
                or not isinstance(anchor, str) or not re.fullmatch(rules["anchorRe"], anchor)):
            raise invalid("ref 或 anchor 文件名不合法")
        return {"meta": meta, "ref": checked(ref, rules["refMaxBytes"]),
                "anchor": checked(anchor, rules["anchorMaxBytes"])}
    except (OSError, ValueError) as exc:
        raise invalid("preset.json 或音色文件无效") from exc


def _read_layer(folder, kind):
    if not folder or not os.path.isdir(folder) or os.path.islink(folder):
        return None
    m = read_manifest_strict(folder, kind)
    if not m["ok"]:
        return {"dir": folder, "data": None, "draft": False, "valid": False, "has_errors": True}
    # 有效性走 validate.py 权威校验（PIL 级终审）；strict 语义：draft 骨架包不能运行，不参与分层胜出
    rep = check_character(folder) if kind == "character" else check_furniture(folder)
    return {"dir": folder, "data": m["data"], "draft": rep.draft, "valid": rep.ok(strict=True), "has_errors": bool(rep.errors)}


def valid_character_dir(pack_id, rel):
    return (isinstance(rel, str)
            and re.fullmatch(r"characters/(?:[a-z0-9][a-z0-9-]*/)*[a-z0-9][a-z0-9-]*", rel)
            and rel.rsplit("/", 1)[-1] == pack_id)


def packed_characters(data_dir, reg=None):
    """Map authorized character ids to their pack id and installed folder."""
    if not data_dir:
        return {}
    if reg is None:
        reg, _ = read_registry_lenient(data_dir)
    found = {}
    for pack, entry in reg["packs"].items():
        ptr = load_pointer(entry)
        store = _store_dir(data_dir, ptr)
        if not store or not isinstance(ptr.get("characterIds"), list):
            continue
        dirs = ptr.get("characterDirs")
        for cid in ptr["characterIds"]:
            if not isinstance(cid, str) or not PACK_ID_RE.fullmatch(cid):
                continue
            rel = dirs.get(cid, "characters/" + cid) if isinstance(dirs, dict) else "characters/" + cid
            if valid_character_dir(cid, rel):
                directory = os.path.join(store, rel)
                actual = os.path.realpath(directory)
                try:
                    if actual != store and os.path.commonpath([store, actual]) == store:
                        found.setdefault(cid, (pack, directory))
                except ValueError:
                    continue
    return found


def resolve_one(plugin_root, data_dir, kind, pack_id, character_dirs=None):
    """单包解析（冻结决策，与 lib/packkit.js resolveOne 同语义）：

    用户层严格有效 -> 用户层胜出（overlay = 内置层同 id 存在）；
    用户层无效/骨架 -> 内置层胜出，user_has_errors 记录用户层问题；
    两层都无效 -> 内置层胜出（valid False）；
    只有用户层且无效 -> 用户层兜底展示（valid False），运行时有效集排除；
    两层都没有 -> None。"""
    if kind not in KIND_DIR or not isinstance(pack_id, str) or not PACK_ID_RE.match(pack_id):
        return None
    user_dir = os.path.join(data_dir, KIND_DIR[kind], pack_id) if data_dir else None
    builtin_dir = os.path.join(plugin_root, KIND_DIR[kind], pack_id)
    u = _read_layer(user_dir, kind)
    b = _read_layer(builtin_dir, kind)
    installed = ((packed_characters(data_dir) if character_dirs is None else character_dirs).get(pack_id)
                 if kind == "character" else None)
    if u and u["valid"]:
        return {"id": pack_id, "kind": kind, "base": "user", "dir": user_dir, "data": u["data"],
                "overlay": bool(b or installed), "valid": True, "draft": False, "has_errors": False,
                "user_has_errors": False, "user_draft": False, "user_dir": user_dir,
                "builtin_dir": builtin_dir if b else None, "user": True, "builtin": bool(b)}
    p = _read_layer(installed[1], kind) if installed else None
    if p and (p["valid"] or not b):
        return {"id": pack_id, "kind": kind, "base": "pack", "pack": installed[0], "dir": p["dir"],
                "data": p["data"], "overlay": False, "valid": p["valid"], "draft": p["draft"],
                "has_errors": p["has_errors"], "user_has_errors": bool(u and u["has_errors"]),
                "user_draft": bool(u and u["draft"]), "user_dir": user_dir if u else None,
                "builtin_dir": builtin_dir if b else None, "user": False, "builtin": bool(b)}
    if b:
        return {"id": pack_id, "kind": kind, "base": "builtin", "dir": builtin_dir, "data": b["data"],
                "overlay": False, "valid": b["valid"], "draft": b["draft"], "has_errors": b["has_errors"],
                "user_has_errors": bool(u and not u["valid"]), "user_draft": bool(u and u["draft"]),
                "user_dir": user_dir if u else None, "builtin_dir": builtin_dir, "user": False, "builtin": True}
    if u:
        return {"id": pack_id, "kind": kind, "base": "user", "dir": user_dir, "data": u["data"],
                "overlay": False, "valid": False, "draft": u["draft"], "has_errors": u["has_errors"],
                "user_has_errors": False, "user_draft": u["draft"], "user_dir": user_dir,
                "builtin_dir": None, "user": True, "builtin": False}
    return None


# --------------------------------------------------------------------------- 拓展包 manifest v1


def check_pack_manifest(manifest):
    """拓展包 manifest v1 校验。未支持的 manifestVersion / packApi 显式报错，绝不按旧格式猜。

    顶层未知键容忍并保留；requires 这类协议载体里的未知键一律 E_FIELD_INVALID。"""
    c = load_contract()
    pm = c["packManifest"]
    errors = []

    def push(code, path, message):
        errors.append(_err(code, path, message))

    if not isinstance(manifest, dict):
        return {"ok": False, "errors": [_err("E_MANIFEST_JSON_INVALID", "", "顶层必须是对象 {...}")]}

    mv = manifest.get("manifestVersion")
    if not isinstance(mv, int) or isinstance(mv, bool):
        push("E_FIELD_INVALID", "manifestVersion", "manifestVersion 必须是整数")
    elif mv != c["manifestVersion"]:
        return {"ok": False, "errors": [_err("E_MANIFEST_VERSION_UNSUPPORTED", "manifestVersion",
                                             "清单格式版本不支持：%s（本插件支持 %s）" % (mv, c["manifestVersion"]))]}
    pa = manifest.get("packApi")
    if not isinstance(pa, int) or isinstance(pa, bool):
        push("E_FIELD_INVALID", "packApi", "packApi 必须是整数")
    elif pa != c["packApi"]:
        return {"ok": False, "errors": [_err("E_PACK_API_UNSUPPORTED", "packApi",
                                             "包协议版本不支持：%s（本插件支持 %s）" % (pa, c["packApi"]))]}

    pid = manifest.get("id")
    if not (isinstance(pid, str) and pid.strip() and re.match(pm["id"]["re"], pid)):
        push("E_ID_INVALID", "id", "id 要是 命名空间.包名（各自 1–32 / 1–40 位小写字母、数字、-）")
    try:
        parse_version(manifest.get("version"))
    except PackKitError as exc:
        push("E_VERSION_MALFORMED", "version", exc.message or exc.code)
    name = manifest.get("name")
    if not (isinstance(name, str) and name.strip()):
        push("E_REQUIRED_MISSING", "name", "缺展示名")
    lic = manifest.get("license")
    if not (isinstance(lic, str) and lic.strip()):
        push("E_REQUIRED_MISSING", "license", "缺 license")

    if "requires" in manifest:
        rq = manifest["requires"]
        if not isinstance(rq, dict):
            push("E_FIELD_INVALID", "requires", "必须是对象")
        else:
            for key, val in rq.items():
                if key not in pm["requiresAllowedKeys"]:
                    push("E_FIELD_INVALID", "requires." + key,
                         "requires 不支持这个键（禁止声明 %s）" % "/".join(pm["requiresForbiddenKeys"]))
                    continue
                if key == "core":
                    try:
                        parse_range(val)
                    except PackKitError as exc:
                        push(exc.code, "requires.core", exc.message or exc.code)
                elif key == "engines":
                    if not isinstance(val, dict):
                        push("E_FIELD_INVALID", "requires.engines", "必须是 {引擎id: 版本范围}")
                    else:
                        for eid, rng in val.items():
                            if not ENGINE_ID_RE.match(eid):
                                push("E_FIELD_INVALID", "requires.engines." + eid, "引擎 id 不合法")
                            else:
                                try:
                                    parse_range(rng)
                                except PackKitError as exc:
                                    push(exc.code, "requires.engines." + eid, exc.message or exc.code)
                elif key == "capabilities":
                    if not isinstance(val, list):
                        push("E_FIELD_INVALID", "requires.capabilities", "必须是数组")
                    else:
                        for i, cap in enumerate(val):
                            try:
                                describe_capability(cap)
                            except PackKitError:
                                push("E_CAPABILITY_UNKNOWN", "requires.capabilities[%d]" % i, "未知能力：%s" % str(cap)[:40])

    if "platforms" in manifest:
        pls = manifest["platforms"]
        if not (isinstance(pls, list) and all(isinstance(p, str) and p.strip() for p in pls)):
            push("E_FIELD_INVALID", "platforms", "platforms 必须是非空字符串数组")
    if "permissions" in manifest:
        perms = manifest["permissions"]
        if not isinstance(perms, list):
            push("E_FIELD_INVALID", "permissions", "必须是数组")
        else:
            for i, p in enumerate(perms):
                try:
                    describe_permission(p)
                except PackKitError:
                    push("E_PERMISSION_UNKNOWN", "permissions[%d]" % i, "未知权限：%s" % str(p)[:40])

    if "entryFurniture" in manifest and manifest["entryFurniture"] is not None:
        ef = manifest["entryFurniture"]
        if not (isinstance(ef, dict) and isinstance(ef.get("id"), str) and ef["id"].strip()
                and re.match(c["packId"]["re"], ef["id"])):
            push("E_FIELD_INVALID", "entryFurniture", "entryFurniture 要是 {id, dir?}")
        elif "dir" in ef:
            d = ef["dir"]
            if not (isinstance(d, str) and d.strip() and ".." not in d.split("/")
                    and not os.path.isabs(d) and all(_DIR_SEG_RE.match(s) for s in d.split("/"))):
                push("E_FIELD_INVALID", "entryFurniture.dir", "dir 要是安全的相对目录")

    if "resources" in manifest and manifest["resources"] is not None:
        rs = manifest["resources"]
        if not isinstance(rs, dict):
            push("E_FIELD_INVALID", "resources", "resources 要是 {名称: 相对路径}")
        else:
            for key, val in rs.items():
                ok = isinstance(key, str) and bool(key) and isinstance(val, str) and bool(val.strip())
                if ok:
                    ok = ".." not in val.split("/") and not os.path.isabs(val) and all(_DIR_SEG_RE.match(s) for s in val.split("/"))
                if not ok:
                    push("E_FIELD_INVALID", "resources." + str(key)[:40], "资源路径要是不越界的相对路径")

    if "characters" in manifest:
        chars = manifest["characters"]
        ids = set()
        if not isinstance(chars, list):
            push("E_FIELD_INVALID", "characters", "必须是数组")
        else:
            for i, ch in enumerate(chars):
                cid = ch.get("id") if isinstance(ch, dict) else None
                if (not isinstance(cid, str) or not PACK_ID_RE.fullmatch(cid) or cid in ids
                        or set(ch) - set(pm["charactersAllowedKeys"])
                        or ("dir" in ch and not valid_character_dir(cid, ch["dir"]))):
                    push("E_FIELD_INVALID", "characters[%d]" % i, "角色须有唯一 id 与安全目录，且只支持 id / dir")
                if isinstance(cid, str):
                    ids.add(cid)

    if "characterAdapters" in manifest and manifest["characterAdapters"] is not None:
        cas = manifest["characterAdapters"]
        if not isinstance(cas, list):
            push("E_FIELD_INVALID", "characterAdapters", "必须是数组")
        else:
            state_re = re.compile(c["character"]["stateIdRe"])
            for i, ca in enumerate(cas):
                path = "characterAdapters[%d]" % i
                if not (isinstance(ca, dict) and isinstance(ca.get("character"), str) and ca["character"].strip()
                        and re.match(c["packId"]["re"], ca["character"])):
                    push("E_FIELD_INVALID", path, "要指明适配的角色 id")
                    continue
                for key in ("required", "optional"):
                    if key not in ca:
                        continue
                    acts = ca[key]
                    if not isinstance(acts, list):
                        push("E_FIELD_INVALID", path + "." + key, "必须是动作 id 数组")
                    else:
                        for j, act in enumerate(acts):
                            if not (isinstance(act, str) and state_re.match(act)):
                                push("E_FIELD_INVALID", "%s.%s[%d]" % (path, key, j), "动作 id 不合法")

    if "dependencies" in manifest and manifest["dependencies"] is not None:
        deps = manifest["dependencies"]
        if not isinstance(deps, list):
            push("E_FIELD_INVALID", "dependencies", "必须是数组")
        else:
            for i, d in enumerate(deps):
                path = "dependencies[%d]" % i
                if not isinstance(d, dict):
                    push("E_FIELD_INVALID", path, "必须是对象 {id, version}")
                    continue
                did = d.get("id")
                if not (isinstance(did, str) and did.strip() and re.match(pm["id"]["re"], did)):
                    push("E_FIELD_INVALID", path + ".id", "依赖 id 要是命名空间 id")
                elif isinstance(manifest.get("id"), str) and did == manifest.get("id"):
                    push("E_FIELD_INVALID", path + ".id", "不能依赖自己")
                try:
                    parse_range(d.get("version"))
                except PackKitError as exc:
                    push(exc.code, path + ".version", exc.message or exc.code)

    for key in ("credits", "publisher"):
        if key in manifest and not isinstance(manifest[key], str):
            push("E_FIELD_INVALID", key, key + " 必须是字符串")

    return {"ok": not errors, "errors": errors}


def check_requires(manifest, plugin_version=None):
    """requires.core 对主插件版号（plugin 域）的满足性。dsh 域在这里不存在 —— 拓展包不声明 DSH 版本。"""
    errors = []
    rq = manifest.get("requires") if isinstance(manifest, dict) else None
    if isinstance(rq, dict) and "core" in rq:
        try:
            ok = bool(plugin_version) and satisfies_range(plugin_version, rq["core"])
        except PackKitError as exc:
            return {"ok": False, "errors": [_err(exc.code, "requires.core", exc.message or exc.code)]}
        if not ok:
            errors.append(_err("E_RANGE_NOT_SATISFIED", "requires.core",
                               "需要主插件 %s，当前 %s" % (rq["core"], plugin_version or "未知")))
    return {"ok": not errors, "errors": errors}


# --------------------------------------------------------------------------- 安装状态机


def transition(state, event):
    """安装状态机迁移。不接受 (状态, 事件) 组合 → E_STATE_INVALID。"""
    table = load_contract()["stateTransitions"].get(state)
    to = table.get(event) if isinstance(table, dict) else None
    if not to:
        raise PackKitError("E_STATE_INVALID", "状态机不接受：%s × %s" % (state, event))
    return to


def install_states():
    return list(load_contract()["installStates"])


# --------------------------------------------------------------------------- 拓展包注册表（M1，读者侧）

REGISTRY_VERSION = 2          # v2：entry.state 存契约 installStates；active/previous/failed 只是版本指针
REGISTRY_VERSIONS_READ = (1, 2)
DIR_SEG_RE = _DIR_SEG_RE
LOADABLE_STATES = ("installed-disabled", "enabled")


def registry_path(data_dir):
    return os.path.join(data_dir, "packs", "registry.json")


def _empty_registry():
    return {"v": REGISTRY_VERSION, "generation": 0, "packs": {}}


def confirm_permission_ids():
    return {p["id"] for p in load_contract()["permissions"] if p.get("needsConfirm")}


def migrate_registry(reg):
    """v1 → v2 兼容迁移（就地，返回同一对象）。v1 的 active.status 是 active/failed，
    迁移规则：active+无待确认权限 → enabled（旧版本来就在加载）；active+有待确认权限 → waiting-authorization；
    failed → load-failed。授权只自动记录不需确认的权限，绝不替用户补确认。"""
    if not isinstance(reg, dict) or reg.get("v") != 1:
        return reg
    confirm = confirm_permission_ids()
    for pid, entry in list((reg.get("packs") or {}).items()):
        if not isinstance(entry, dict):
            continue
        a = entry.get("active") if isinstance(entry.get("active"), dict) else None
        st = (a or {}).get("status")
        perms = [p for p in ((a or {}).get("permissions") or []) if isinstance(p, str)]
        granted = [p for p in perms if p not in confirm]
        pending = [p for p in perms if p in confirm]
        if a is None:
            state = "not-downloaded"
        elif st == "failed":
            state = "load-failed"
        elif pending:
            state = "waiting-authorization"
        else:
            state = "enabled"
        for key in ("active", "previous", "failed"):
            if isinstance(entry.get(key), dict):
                entry[key].pop("status", None)
        entry.setdefault("failed", None)
        entry["state"] = state
        entry["wantEnabled"] = state in ("enabled", "waiting-authorization")
        entry["grantedPermissions"] = granted
        entry["pendingPermissions"] = pending
        entry["receipt"] = (a or {}).pop("receipt", None) if a else None
    reg["v"] = REGISTRY_VERSION
    return reg


def registry_shape_ok(reg):
    return isinstance(reg, dict) and reg.get("v") in REGISTRY_VERSIONS_READ and isinstance(reg.get("packs"), dict)         and isinstance(reg.get("generation"), int) and not isinstance(reg.get("generation"), bool) and reg["generation"] >= 0


def read_registry_lenient(data_dir):
    """读者用的宽容读取（宠物进程 / 快照）：缺失 → 空注册表；损坏 → 空注册表 + 错误码。v1 就地迁移成 v2 视图。

    写者（pack_cli.py）另有严格版：损坏一律拒写，绝不盲目重建。"""
    path = registry_path(data_dir) if data_dir else None
    if not path or not os.path.isfile(path):
        return _empty_registry(), None
    try:
        with open(path, encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError) as exc:
        return _empty_registry(), "E_REGISTRY_INVALID: %s" % str(exc)[:120]
    if not registry_shape_ok(reg):
        return _empty_registry(), "E_REGISTRY_INVALID"
    return migrate_registry(reg), None


def safe_store_rel(rel):
    """注册表里的 dir 只认 store 下的安全相对路径（与 lib/packkit.js 的 safeStoreRel 同规则）。"""
    if not (isinstance(rel, str) and rel):
        return False
    if rel.startswith(("/", "\\")) or os.path.isabs(rel) or (len(rel) > 1 and rel[1] == ":"):
        return False
    segs = rel.replace("\\", "/").split("/")
    return all(s and s not in (".", "..") and _DIR_SEG_RE.match(s) for s in segs)


def load_pointer(entry):
    """这个包现在该被运行时加载的版本指针（dict）或 None。权限门在这里：

    - 用户没表达启用意图（wantEnabled 假）→ 不加载，家具 defaultEnabled 一律不生效；
    - installed-disabled / enabled 且 active 的权限全部已授权 → 加载 active；
    - waiting-authorization（更新新增了需确认权限）→ 新增能力暂停，若 previous 的权限全部已授权则继续加载 previous；
    - 其余状态（load-failed / incompatible / 等待中）→ 不加载。"""
    if not isinstance(entry, dict) or entry.get("wantEnabled") is not True:
        return None
    granted = set(p for p in (entry.get("grantedPermissions") or []) if isinstance(p, str))
    state = entry.get("state")

    def ok(ptr):
        return isinstance(ptr, dict) and set(ptr.get("permissions") or []) <= granted

    if state in LOADABLE_STATES and ok(entry.get("active")):
        return entry["active"]
    if state == "waiting-authorization" and ok(entry.get("previous")):
        return entry["previous"]
    return None


def pack_furniture_roots(data_dir, reg=None):
    """该加载的拓展包版本目录（每目录下的 furniture/ 是标准布局，load_furniture 可直接吃）。

    未授权 / 未启用 / 失败的包整包排除（见 load_pointer），dir 必须是 store 下真实存在的安全相对路径。"""
    if reg is None:
        reg, _err = read_registry_lenient(data_dir)
    else:
        reg = migrate_registry(reg)
    return [full for entry in (reg.get("packs") or {}).values()
            if (full := _store_dir(data_dir, load_pointer(entry)))]


def _store_dir(data_dir, ptr):
    rel = ptr.get("dir") if ptr else None
    if not safe_store_rel(rel):
        return None
    root = os.path.abspath(os.path.join(data_dir, "packs", "store"))
    full = os.path.abspath(os.path.join(root, rel))
    if not os.path.isdir(full):
        return None
    root, full = os.path.realpath(root), os.path.realpath(full)
    try:
        return full if full != root and os.path.commonpath([root, full]) == root else None
    except ValueError:
        return None
