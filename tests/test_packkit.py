# -*- coding: utf-8 -*-
"""packkit（Python 镜像）单元测试：枚举规则、严格清单、分层决策、SemVer/范围、manifest v1、状态机。

全部用合成包夹具（helpers 造的临时目录 + 程序生成的 PNG），不读任何真实素材。
跨语言对期望值的一致性另见 test_pack_conformance.py。
"""
import json
import os
import shutil
import sys
import unittest

from helpers import ROOT, make_character, make_furniture, png, tmpdir  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "runtime"))

from pixelpet import packkit  # noqa: E402
from pixelpet.packkit import PackKitError  # noqa: E402


def code_of(fn, *args, **kw):
    try:
        fn(*args, **kw)
        return None
    except PackKitError as exc:
        return exc.code


class Enumerate(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()
        os.makedirs(os.path.join(self.root, "characters"), exist_ok=True)
        for n in ("b-pack", "a-pack", "_hidden", ".dot", "x.bak-20261113"):
            os.makedirs(os.path.join(self.root, "characters", n))
        with open(os.path.join(self.root, "characters", "loose-file.json"), "w", encoding="utf-8") as f:
            f.write("{}")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_skip_rules_and_order(self):
        self.assertEqual([os.path.basename(p) for p in packkit.enumerate_packs(self.root, "character")],
                         ["a-pack", "b-pack"])
        self.assertEqual(packkit.enumerate_packs(self.root, "furniture"), [])

    def test_symlink_dir_never_enumerated(self):
        try:
            os.symlink(os.path.join(self.root, "characters", "a-pack"),
                       os.path.join(self.root, "characters", "link-pack"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("no symlink privilege")
        names = [os.path.basename(p) for p in packkit.enumerate_packs(self.root, "character")]
        self.assertNotIn("link-pack", names)


class StrictManifest(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _dir(self, name, body=None):
        d = os.path.join(self.root, "characters", name)
        os.makedirs(d, exist_ok=True)
        if body is not None:
            with open(os.path.join(d, "character.json"), "w", encoding="utf-8") as f:
                f.write(body)
        return d

    def test_missing_json_nonobject(self):
        self.assertEqual(packkit.read_manifest_strict(self._dir("p1"), "character")["errors"][0]["code"],
                         "E_MANIFEST_MISSING")
        self.assertEqual(packkit.read_manifest_strict(self._dir("p2", "{ broken"), "character")["errors"][0]["code"],
                         "E_MANIFEST_JSON_INVALID")
        self.assertEqual(packkit.read_manifest_strict(self._dir("p3", "[1,2]"), "character")["errors"][0]["code"],
                         "E_MANIFEST_JSON_INVALID")
        ok = packkit.read_manifest_strict(self._dir("p4", '{"id":"p4"}'), "character")
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["data"]["id"], "p4")


class Layering(unittest.TestCase):
    def setUp(self):
        self.plugin = tmpdir()
        self.data = tmpdir()

    def tearDown(self):
        shutil.rmtree(self.plugin, ignore_errors=True)
        shutil.rmtree(self.data, ignore_errors=True)

    def test_builtin_only(self):
        make_character(self.plugin, "solo")
        r = packkit.resolve_one(self.plugin, None, "character", "solo")
        self.assertEqual(r["base"], "builtin")
        self.assertTrue(r["valid"])
        self.assertFalse(r["user"])

    def test_valid_user_overlay_wins(self):
        make_character(self.plugin, "hero")
        make_character(self.data, "hero")
        with open(os.path.join(self.data, "characters", "hero", "character.json"), encoding="utf-8") as f:
            data = json.load(f)
        data["name"] = "用户版"
        with open(os.path.join(self.data, "characters", "hero", "character.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        r = packkit.resolve_one(self.plugin, self.data, "character", "hero")
        self.assertEqual(r["base"], "user")
        self.assertEqual(r["data"]["name"], "用户版")
        self.assertTrue(r["overlay"] and r["user"] and r["builtin"])

    def test_invalid_user_overlay_loses_to_builtin(self):
        make_character(self.plugin, "hero")
        make_character(self.data, "hero", extra=lambda d: d.update(canvas=[64, 64]))
        r = packkit.resolve_one(self.plugin, self.data, "character", "hero")
        self.assertEqual(r["base"], "builtin")
        self.assertTrue(r["valid"])
        self.assertTrue(r["user_has_errors"])

    def test_draft_loses_to_valid_builtin(self):
        make_character(self.plugin, "hero")
        make_character(self.data, "hero", frames=0, extra=lambda d: d.update(draft=True))
        r = packkit.resolve_one(self.plugin, self.data, "character", "hero")
        self.assertEqual(r["base"], "builtin")
        self.assertTrue(r["user_draft"])

    def test_user_only_draft_is_fallback_display(self):
        make_character(self.data, "skel", frames=0, extra=lambda d: d.update(draft=True))
        r = packkit.resolve_one(self.plugin, self.data, "character", "skel")
        self.assertEqual(r["base"], "user")
        self.assertFalse(r["valid"])
        self.assertTrue(r["draft"])

    def test_bad_id_and_unknown(self):
        self.assertIsNone(packkit.resolve_one(self.plugin, self.data, "character", "Bad_ID"))
        self.assertIsNone(packkit.resolve_one(self.plugin, self.data, "character", "nope"))

    def test_furniture_layering(self):
        make_furniture(self.plugin, "f1")
        make_furniture(self.data, "f1", extra=lambda d: d.update(idle="missing"))
        r = packkit.resolve_one(self.plugin, self.data, "furniture", "f1")
        self.assertEqual(r["base"], "builtin")
        self.assertTrue(r["user_has_errors"])


class SemVer(unittest.TestCase):
    def test_parse_strict(self):
        v = packkit.parse_version("1.2.3-rc.1")
        self.assertEqual((v["major"], v["minor"], v["patch"]), (1, 2, 3))
        self.assertEqual(v["pre"], ["rc", 1])
        for bad in ("v1.2.3", "1.2", "1.2.3.4", "01.2.3", "1.2.3-01", "1.2.3-", ""):
            self.assertEqual(code_of(packkit.parse_version, bad), "E_VERSION_MALFORMED", bad)

    def test_precedence(self):
        order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-rc.1", "1.0.0"]
        for a, b in zip(order, order[1:]):
            self.assertLess(packkit.compare_versions(a, b), 0, a + " < " + b)

    def test_range_minimal_grammar(self):
        self.assertEqual([c["op"] for c in packkit.parse_range("^1.2.3")], [">=", "<"])
        for bad in (">=1.0 || <2", "1.x", "*", "1.0.0 - 2.0.0", "=1.2", "1.2", ""):
            self.assertEqual(code_of(packkit.parse_range, bad), "E_RANGE_UNSUPPORTED", bad)

    def test_rc_semantics(self):
        self.assertTrue(packkit.satisfies_range("0.2.0-rc.1", "^0.2.0-rc.1"))
        self.assertTrue(packkit.satisfies_range("0.2.0-rc.2", "^0.2.0-rc.1"))
        self.assertTrue(packkit.satisfies_range("0.2.0", "^0.2.0-rc.1"))
        self.assertFalse(packkit.satisfies_range("0.3.0-rc.1", "^0.2.0-rc.1"))
        self.assertFalse(packkit.satisfies_range("0.3.0", "^0.2.0-rc.1"))
        self.assertFalse(packkit.satisfies_range("1.0.0-alpha", "^1.0.0"))


class PackManifestV1(unittest.TestCase):
    def good(self):
        return {"id": "petdev.reading-demo", "version": "1.0.0", "name": "一起看书（示例）", "manifestVersion": 1,
                "packApi": 1, "license": "CC-BY-NC-SA-4.0",
                "requires": {"core": "^0.1.0", "capabilities": ["docs.select", "session.ask"]},
                "permissions": ["docs.read", "model.ask"], "platforms": ["win32"],
                "entryFurniture": {"id": "reading-desk", "dir": "furniture/reading-desk"},
                "characterAdapters": [{"character": "whale-girl", "required": ["reading"], "optional": ["ponder"]}],
                "dependencies": []}

    def test_valid(self):
        r = packkit.check_pack_manifest(self.good())
        self.assertTrue(r["ok"], r["errors"])

    def test_unknown_top_field_tolerated(self):
        data = self.good()
        data["futureField"] = {"any": "thing"}
        self.assertTrue(packkit.check_pack_manifest(data)["ok"])

    def test_unsupported_versions_explicit(self):
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "manifestVersion": 2})["errors"][0]["code"],
                         "E_MANIFEST_VERSION_UNSUPPORTED")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "packApi": 2})["errors"][0]["code"],
                         "E_PACK_API_UNSUPPORTED")

    def test_requires_carrier_rules(self):
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "requires": {"core": "^0.1.0", "dsh": "^0.2.0"}})["errors"][0]["code"],
                         "E_FIELD_INVALID")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "requires": {"core": "^0.1.0", "extra": 1}})["errors"][0]["code"],
                         "E_FIELD_INVALID")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "requires": {"core": ">=1.0 || <2"}})["errors"][0]["code"],
                         "E_RANGE_UNSUPPORTED")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "requires": {"capabilities": ["time.travel"]}})["errors"][0]["code"],
                         "E_CAPABILITY_UNKNOWN")

    def test_ids_and_fields(self):
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "id": "nopoint"})["errors"][0]["code"], "E_ID_INVALID")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "version": "1.0"})["errors"][0]["code"], "E_VERSION_MALFORMED")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "permissions": ["magic"]})["errors"][0]["code"],
                         "E_PERMISSION_UNKNOWN")
        self.assertEqual(packkit.check_pack_manifest({**self.good(), "dependencies": [{"id": "petdev.reading-demo", "version": "^1.0.0"}]})["errors"][0]["code"],
                         "E_FIELD_INVALID")
        codes = {e["code"] for e in packkit.check_pack_manifest({"id": "petdev.incomplete"})["errors"]}
        self.assertEqual(codes, {"E_FIELD_INVALID", "E_REQUIRED_MISSING", "E_VERSION_MALFORMED"})

    def test_check_requires_plugin_domain(self):
        self.assertTrue(packkit.check_requires({"requires": {"core": "^0.1.0"}}, "0.1.0")["ok"])
        r = packkit.check_requires({"requires": {"core": "^9.0.0"}}, "0.1.0")
        self.assertFalse(r["ok"])
        self.assertEqual(r["errors"][0]["code"], "E_RANGE_NOT_SATISFIED")


class StateMachine(unittest.TestCase):
    def test_frozen_table(self):
        for state, row in packkit.load_contract()["stateTransitions"].items():
            for ev, to in row.items():
                self.assertEqual(packkit.transition(state, ev), to, state + " × " + ev)

    def test_invalid_pairs(self):
        for state, ev in (("not-downloaded", "download-done"), ("enabled", "download-start"),
                          ("not-downloaded", "enable-request")):
            self.assertEqual(code_of(packkit.transition, state, ev), "E_STATE_INVALID", state + " × " + ev)


if __name__ == "__main__":
    unittest.main()
