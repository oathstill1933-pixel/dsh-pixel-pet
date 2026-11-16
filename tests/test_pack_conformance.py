# -*- coding: utf-8 -*-
"""M0 跨语言一致性基线（Python 侧）。

同一批 contracts/fixtures/packkit/ 夹具：Python 的解析结果必须逐字段等于 expected-resolution.json，
manifest v1 校验等于 expected-manifests.json，版本/状态机等于 version-cases / transition-cases。
Node 侧镜像：scripts/pack-conformance.test.mjs。两边各对同一份期望值断言 —— 这就是
「同一清单在所有读取端得到相同结果；未支持契约有显式错误」的钉死方式。
"""
import json
import os
import shutil
import unittest
from pathlib import Path

from helpers import ROOT, tmpdir  # noqa: E402

import sys  # noqa: E402
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from pixelpet import packkit  # noqa: E402
from pixelpet.packkit import PackKitError  # noqa: E402

FX = os.path.join(ROOT, "contracts", "fixtures", "packkit")
PLUGIN = os.path.join(FX, "plugin-root")
USER = os.path.join(FX, "user-root")


def fixture(name):
    with open(os.path.join(FX, name), encoding="utf-8") as f:
        return json.load(f)


class ResolutionParity(unittest.TestCase):
    def test_resolution_matches_expected(self):
        expected = fixture("expected-resolution.json")
        for kind, key in (("character", "characters"), ("furniture", "furniture")):
            names = []
            for base in (PLUGIN, USER):
                for path in packkit.enumerate_packs(base, kind):
                    n = os.path.basename(path)
                    if n not in names:
                        names.append(n)
            got = []
            for n in names:
                r = packkit.resolve_one(PLUGIN, USER, kind, n)
                got.append({"id": n, "base": r["base"], "overlay": r["overlay"], "valid": r["valid"],
                            "draft": r["draft"], "has_errors": r["has_errors"],
                            "user_has_errors": r["user_has_errors"], "user_draft": r["user_draft"],
                            "user": r["user"], "builtin": r["builtin"]})
            self.assertEqual(got, expected[key], kind)


class ManifestParity(unittest.TestCase):
    def test_manifest_v1_matches_expected(self):
        expected = fixture("expected-manifests.json")
        for name, want in expected.items():
            if name.startswith("_"):
                continue
            if name == "bad-json":
                result = {"ok": False, "errors": [{"code": "E_MANIFEST_JSON_INVALID"}]}
            else:
                with open(os.path.join(FX, "ext", name, "manifest.json"), encoding="utf-8") as f:
                    manifest = json.load(f)
                result = packkit.check_pack_manifest(manifest)
            codes = sorted({e["code"] for e in result["errors"]})
            self.assertEqual(result["ok"], want["ok"], name)
            self.assertEqual(codes, want["errorCodes"], name)


class VersionParity(unittest.TestCase):
    def test_versions_match_expected(self):
        for ver, rng, want in fixture("version-cases.json"):
            try:
                got = packkit.satisfies_range(ver, rng)
            except PackKitError as exc:
                got = exc.code
            self.assertEqual(got, want, "%s vs %s" % (ver, rng))


class TransitionParity(unittest.TestCase):
    def test_transitions_match_expected(self):
        for state, event, want in fixture("transition-cases.json"):
            try:
                got = packkit.transition(state, event)
            except PackKitError as exc:
                got = exc.code
            self.assertEqual(got, want, "%s × %s" % (state, event))


class ContractShape(unittest.TestCase):
    def test_contract_self_consistent(self):
        c = packkit.load_contract()
        self.assertEqual(packkit.install_states(), c["installStates"])
        states = set(c["installStates"])
        for from_state, row in c["stateTransitions"].items():
            self.assertIn(from_state, states, "未知状态 " + from_state)
            for ev in row:
                self.assertIn(ev, c["installEvents"], "未声明事件 " + ev)
        self.assertEqual(sorted(packkit.permission_ids()), sorted(p["id"] for p in c["permissions"]))
        self.assertEqual(sorted(packkit.capability_ids()), sorted(x["id"] for x in c["capabilities"]))


class PackLayerConformance(unittest.TestCase):
    def test_pack_layer_matches_expected(self):
        from pixelpet import packkit as PK
        data = os.path.join(FX, "pack-data")
        for c in fixture("expected-pack-layer.json")["cases"]:
            reg = {"v": 1 if c.get("v1") else 2, "generation": 0, "packs": {c["id"]: json.loads(json.dumps(c["entry"]))}}
            roots = PK.pack_furniture_roots(data, reg)
            self.assertEqual(bool(roots), c["load"], c["id"])
            if c.get("dir"):
                self.assertTrue(roots[0].replace(os.sep, "/").endswith("/" + c["dir"]), c["id"])


class VoicePresetParity(unittest.TestCase):
    def test_presets_and_character_validity_match_shared_fixtures(self):
        from pixelpet.validate import check_character
        expected = fixture("voice-presets.json")
        char = Path(PLUGIN) / "characters" / "good-char"
        for row in expected["cases"]:
            with self.subTest(row["label"]):
                folder = Path(tmpdir()) / char.name
                shutil.copytree(char, folder)
                voice = folder / "voice"
                voice.mkdir()
                for name in ("ref.wav", "anchor.json"):
                    if name != row.get("missing"):
                        (voice / name).write_bytes(b"{}")
                if row.get("large"):
                    with (voice / row["large"]["file"]).open("ab") as f:
                        f.truncate(row["large"]["bytes"])
                payload = {**expected["base"], **row.get("patch", {})}
                (voice / "preset.json").write_text(row.get("json", json.dumps(payload)), encoding="utf8")
                if row["code"]:
                    with self.assertRaises(PackKitError) as cm:
                        packkit.read_voice_preset(folder)
                    self.assertEqual(cm.exception.code, row["code"])
                else:
                    self.assertIsNotNone(packkit.read_voice_preset(folder))
                self.assertEqual(check_character(folder).ok(strict=True), row["code"] is None)


if __name__ == "__main__":
    unittest.main()
