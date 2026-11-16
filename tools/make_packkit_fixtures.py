#!/usr/bin/env python
"""生成 contracts/fixtures/packkit/ 下的合成包夹具（一次性生成、随仓库保存、测试只读）。

    <可用 Python（law_env）> tools/make_packkit_fixtures.py

夹具全部是程序造的合成素材（纯色 RGBA PNG + 手写清单），不含任何真实素材或私人数据。
expected-*.json / version-cases.json / transition-cases.json 是人工核对的期望值，
跨语言一致性测试（scripts/pack-conformance.test.mjs + tests/test_pack_conformance.py）各自
把同一批夹具跑一遍，再逐字段对这份期望值。
"""
import json
import os
import shutil

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "contracts", "fixtures", "packkit"))

REQUIRED_STATES = ["idle", "walk-left", "walk-right", "waving", "jumping", "failed",
                   "waiting", "running", "review", "lie"]


def png(path, size, color):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGBA", size, color).save(path)


def character_manifest(cid, name, canvas=(192, 208), states=None, extra=None):
    if states is None:
        states = {sid: {"label": sid, "frames": ["sprites/%s_00.png" % sid], "durationsMs": [250], "loop": True}
                  for sid in REQUIRED_STATES}
    data = {"id": cid, "name": name, "demo": False, "canvas": list(canvas), "logicalScale": 2,
            "displayScale": 1.0, "states": states}
    if extra:
        data.update(extra)
    return data


def write_character(root, cid, data, color):
    base = os.path.join(root, "characters", cid)
    os.makedirs(base, exist_ok=True)
    with open(os.path.join(base, "character.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    for st in (data.get("states") or {}).values():
        for rel in st.get("frames", []):
            png(os.path.join(base, rel), tuple(data["canvas"]), color)


def furniture_manifest(fid, name, size, states, interactions, extra=None):
    data = {"id": fid, "name": name, "version": 1, "size": list(size), "anchor": "bottom-right",
            "defaultEnabled": False, "states": states, "interactions": interactions}
    if extra:
        data.update(extra)
    return data


def write_furniture(root, fid, data, color):
    base = os.path.join(root, "furniture", fid)
    os.makedirs(base, exist_ok=True)
    with open(os.path.join(base, "furniture.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    for st in data["states"].values():
        for rel in st["frames"]:
            png(os.path.join(base, rel), tuple(data["size"]), color)


def manifest_states(state_ids, size):
    return {sid: {"label": sid, "frames": ["sprites/%s_00.png" % sid], "durationsMs": [250]}
            for sid in state_ids}


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    plugin = os.path.join(OUT, "plugin-root")
    user = os.path.join(OUT, "user-root")
    os.makedirs(plugin, exist_ok=True)
    os.makedirs(user, exist_ok=True)

    # ---- 内置层：好角色 + 好家具；还有一份会被坏用户覆盖的 overlay-broken(-furn)
    write_character(plugin, "good-char", character_manifest("good-char", "好角色（内置）"), (90, 160, 255, 255))
    write_character(plugin, "overlay-broken", character_manifest("overlay-broken", "会被坏用户覆盖的角色"), (90, 160, 255, 255))
    write_furniture(plugin, "builtin-furn", furniture_manifest(
        "builtin-furn", "内置家具", (48, 32), manifest_states(["idle", "sit"], (48, 32)),
        [{"verb": "休息", "mode": "beside", "say": "休息一下"}], {"idle": "idle"}), (180, 140, 90, 255))
    write_furniture(plugin, "overlay-broken-furn", furniture_manifest(
        "overlay-broken-furn", "会被坏用户覆盖的家具", (48, 32), manifest_states(["idle", "sit"], (48, 32)),
        [{"verb": "休息", "mode": "beside"}], {"idle": "idle"}), (180, 140, 90, 255))

    # ---- 用户层：有效覆盖 / 坏 JSON / 缺必需状态 / 坏覆盖 / 骨架包 / 有效用户家具 / 坏覆盖家具
    write_character(user, "good-char", character_manifest("good-char", "好角色（用户版）"), (255, 120, 120, 255))
    write_character(user, "overlay-broken", character_manifest(
        "overlay-broken", "坏覆盖", canvas=(64, 64)), (255, 120, 120, 255))
    broken = character_manifest("broken-char", "缺必需状态",
                                states={"idle": {"label": "待机", "frames": ["sprites/idle_00.png"], "durationsMs": [250]}})
    write_character(user, "broken-char", broken, (255, 120, 120, 255))
    os.makedirs(os.path.join(user, "characters", "broken-json"), exist_ok=True)
    with open(os.path.join(user, "characters", "broken-json", "character.json"), "w", encoding="utf-8") as f:
        f.write('{ "id": "broken-json", 这不是合法 JSON')
    draft = character_manifest("draft-char", "骨架包", extra={"draft": True})
    for st in draft["states"].values():
        st["frames"] = []
        st["durationsMs"] = []
    write_character(user, "draft-char", draft, (255, 120, 120, 255))
    write_furniture(user, "user-furn", furniture_manifest(
        "user-furn", "用户新家具", (40, 24), manifest_states(["idle", "sit"], (40, 24)),
        [{"verb": "坐", "mode": "beside"}], {"idle": "idle"}), (120, 200, 120, 255))
    write_furniture(user, "overlay-broken-furn", furniture_manifest(
        "overlay-broken-furn", "坏覆盖家具", (48, 32), manifest_states(["idle"], (48, 32)),
        [{"verb": "休息", "mode": "beside"}], {"idle": "sleep"}), (255, 120, 120, 255))

    # ---- 拓展包 manifest v1 夹具
    ext = os.path.join(OUT, "ext")

    def write_ext(name, body):
        base = os.path.join(ext, name)
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "manifest.json"), "w", encoding="utf-8") as f:
            if isinstance(body, str):
                f.write(body)
            else:
                json.dump(body, f, ensure_ascii=False, indent=2)

    write_ext("valid-pack", {
        "id": "petdev.reading-demo", "version": "1.0.0", "name": "一起看书（示例）", "manifestVersion": 1,
        "packApi": 1, "license": "CC-BY-NC-SA-4.0", "publisher": "petdev", "credits": "合成夹具",
        "requires": {"core": "^0.1.0", "capabilities": ["docs.select", "session.ask"]},
        "permissions": ["docs.read", "model.ask"], "platforms": ["win32"],
        "entryFurniture": {"id": "reading-desk", "dir": "furniture/reading-desk"},
        "characterAdapters": [{"character": "whale-girl", "required": ["reading", "page-turn"], "optional": ["ponder"]}],
        "dependencies": [],
    })
    write_ext("unsupported-manifest", {"id": "petdev.future", "version": "1.0.0", "name": "未来格式",
                                       "manifestVersion": 2, "packApi": 1, "license": "MIT"})
    write_ext("unsupported-api", {"id": "petdev.newapi", "version": "1.0.0", "name": "新协议",
                                  "manifestVersion": 1, "packApi": 2, "license": "MIT"})
    write_ext("bad-range", {"id": "petdev.badrange", "version": "1.0.0", "name": "坏范围",
                            "manifestVersion": 1, "packApi": 1, "license": "MIT",
                            "requires": {"core": ">=1.0 || <2.0"}})
    write_ext("unknown-permission", {"id": "petdev.magic", "version": "1.0.0", "name": "未知权限",
                                     "manifestVersion": 1, "packApi": 1, "license": "MIT",
                                     "permissions": ["docs.read", "magic.tab"]})
    write_ext("unknown-capability", {"id": "petdev.time", "version": "1.0.0", "name": "未知能力",
                                     "manifestVersion": 1, "packApi": 1, "license": "MIT",
                                     "requires": {"capabilities": ["docs.select", "time.travel"]}})
    write_ext("dsh-forbidden", {"id": "petdev.dshbound", "version": "1.0.0", "name": "越权声明",
                                "manifestVersion": 1, "packApi": 1, "license": "MIT",
                                "requires": {"dsh": "^0.2.0"}})
    write_ext("missing-fields", {"id": "petdev.incomplete"})
    write_ext("bad-json", '{ "id": "petdev.broken", 这不是合法 JSON')

    # ---- 人工核对的期望值
    expected = {
        "_说明": "跨语言一致性期望值：两边对同一批夹具的解析结果必须逐字段等于这里。字段与 runtime/pixelpet/packkit.py resolve_one 的返回键一致。",
        "characters": [
            {"id": "good-char", "base": "user", "overlay": True, "valid": True, "draft": False,
             "has_errors": False, "user_has_errors": False, "user_draft": False, "user": True, "builtin": True},
            {"id": "overlay-broken", "base": "builtin", "overlay": False, "valid": True, "draft": False,
             "has_errors": False, "user_has_errors": True, "user_draft": False, "user": False, "builtin": True},
            {"id": "broken-char", "base": "user", "overlay": False, "valid": False, "draft": False,
             "has_errors": True, "user_has_errors": False, "user_draft": False, "user": True, "builtin": False},
            {"id": "broken-json", "base": "user", "overlay": False, "valid": False, "draft": False,
             "has_errors": True, "user_has_errors": False, "user_draft": False, "user": True, "builtin": False},
            {"id": "draft-char", "base": "user", "overlay": False, "valid": False, "draft": True,
             "has_errors": False, "user_has_errors": False, "user_draft": True, "user": True, "builtin": False},
        ],
        "furniture": [
            {"id": "builtin-furn", "base": "builtin", "overlay": False, "valid": True, "draft": False,
             "has_errors": False, "user_has_errors": False, "user_draft": False, "user": False, "builtin": True},
            {"id": "overlay-broken-furn", "base": "builtin", "overlay": False, "valid": True, "draft": False,
             "has_errors": False, "user_has_errors": True, "user_draft": False, "user": False, "builtin": True},
            {"id": "user-furn", "base": "user", "overlay": False, "valid": True, "draft": False,
             "has_errors": False, "user_has_errors": False, "user_draft": False, "user": True, "builtin": False},
        ],
    }
    with open(os.path.join(OUT, "expected-resolution.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, ensure_ascii=False, indent=2)

    expected_manifests = {
        "_说明": "拓展包 manifest v1 校验期望值：errorCodes 是去重排序后的错误码列表。",
        "valid-pack": {"ok": True, "errorCodes": []},
        "unsupported-manifest": {"ok": False, "errorCodes": ["E_MANIFEST_VERSION_UNSUPPORTED"]},
        "unsupported-api": {"ok": False, "errorCodes": ["E_PACK_API_UNSUPPORTED"]},
        "bad-range": {"ok": False, "errorCodes": ["E_RANGE_UNSUPPORTED"]},
        "unknown-permission": {"ok": False, "errorCodes": ["E_PERMISSION_UNKNOWN"]},
        "unknown-capability": {"ok": False, "errorCodes": ["E_CAPABILITY_UNKNOWN"]},
        "dsh-forbidden": {"ok": False, "errorCodes": ["E_FIELD_INVALID"]},
        "missing-fields": {"ok": False, "errorCodes": ["E_FIELD_INVALID", "E_REQUIRED_MISSING", "E_VERSION_MALFORMED"]},
        "bad-json": {"ok": False, "errorCodes": ["E_MANIFEST_JSON_INVALID"]},
    }
    with open(os.path.join(OUT, "expected-manifests.json"), "w", encoding="utf-8") as f:
        json.dump(expected_manifests, f, ensure_ascii=False, indent=2)

    version_cases = [
        ["1.2.3", "1.2.3", True], ["1.2.4", "1.2.3", False],
        ["1.2.3", "^1.2.3", True], ["1.9.9", "^1.2.3", True], ["2.0.0", "^1.2.3", False],
        ["0.2.5", "^0.2.3", True], ["0.3.0", "^0.2.3", False],
        ["0.0.3", "^0.0.3", True], ["0.0.4", "^0.0.3", False],
        ["1.2.9", "~1.2.3", True], ["1.3.0", "~1.2.3", False],
        ["1.2.3", ">=1.2.3 <2.0.0", True], ["2.0.0", ">=1.2.3 <2.0.0", False], ["1.2.2", ">=1.2.3 <2.0.0", False],
        ["1.2.3", "=1.2.3", True], ["1.2.3", "=1.2", "E_RANGE_UNSUPPORTED"], ["1.2.3", "1.2", "E_RANGE_UNSUPPORTED"],
        ["1.2.3", ">=1.2", True], ["1.2.3", "^1.2", True], ["1.2.3", "~1.2", True],
        ["1.2.3", "1.x", "E_RANGE_UNSUPPORTED"], ["1.2.3", "*", "E_RANGE_UNSUPPORTED"],
        ["1.2.3", ">=1.0.0 <2.0.0 || 3.0.0", "E_RANGE_UNSUPPORTED"], ["1.2.3", "1.0.0 - 2.0.0", "E_RANGE_UNSUPPORTED"],
        ["0.2.0-rc.1", "^0.2.0-rc.1", True], ["0.2.0-rc.2", "^0.2.0-rc.1", True],
        ["0.2.0", "^0.2.0-rc.1", True], ["0.2.1", "^0.2.0-rc.1", True],
        ["0.3.0-rc.1", "^0.2.0-rc.1", False], ["0.1.9", "^0.2.0-rc.1", False],
        ["1.0.0-alpha", "^1.0.0", False], ["1.0.0-alpha", ">=1.0.0-alpha", True],
        ["1.0.0-alpha.1", ">=1.0.0-alpha.1", True], ["1.0.0-alpha.beta", ">=1.0.0-alpha.1", True],
        ["1.0.0-rc.1", ">=1.0.0-alpha <1.0.0-rc.1", False],
        ["abc", "1.0.0", "E_VERSION_MALFORMED"], ["1.2", "1.2.3", "E_VERSION_MALFORMED"],
        ["1.2.3-01", "^1.0.0", "E_VERSION_MALFORMED"],
    ]
    with open(os.path.join(OUT, "version-cases.json"), "w", encoding="utf-8") as f:
        json.dump(version_cases, f, ensure_ascii=False, indent=1)

    transition_cases = [
        ["not-downloaded", "download-start", "downloading"],
        ["downloading", "download-done", "waiting-dependency"],
        ["downloading", "download-failed", "not-downloaded"],
        ["downloading", "cancel", "not-downloaded"],
        ["waiting-dependency", "dependency-resolved", "waiting-authorization"],
        ["waiting-dependency", "engine-missing", "incompatible"],
        ["waiting-dependency", "core-incompatible", "incompatible"],
        ["waiting-authorization", "authorization-granted", "waiting-adaptation"],
        ["waiting-authorization", "authorization-denied", "installed-disabled"],
        ["waiting-adaptation", "adaptation-resolved", "installed-disabled"],
        ["installed-disabled", "enable-request", "installed-disabled"],
        ["installed-disabled", "load-receipt-ok", "enabled"],
        ["installed-disabled", "load-receipt-fail", "load-failed"],
        ["enabled", "disable-request", "installed-disabled"],
        ["enabled", "load-receipt-ok", "enabled"],
        ["enabled", "load-receipt-fail", "load-failed"],
        ["load-failed", "rollback-ok", "installed-disabled"],
        ["load-failed", "load-receipt-ok", "enabled"],
        ["incompatible", "core-resolved", "waiting-dependency"],
        ["enabled", "uninstall", "not-downloaded"],
        ["enabled", "update-install", "downloading"],
        ["not-downloaded", "download-done", "E_STATE_INVALID"],
        ["not-downloaded", "enable-request", "E_STATE_INVALID"],
        ["enabled", "download-start", "E_STATE_INVALID"],
        ["enabled", "enable-request", "E_STATE_INVALID"],
    ]
    with open(os.path.join(OUT, "transition-cases.json"), "w", encoding="utf-8") as f:
        json.dump(transition_cases, f, ensure_ascii=False, indent=1)

    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
