import json
import os
import unittest

from helpers import ROOT, make_character, make_furniture, png, tmpdir

from pixelpet.validate import check_character, check_furniture, main


def msgs(rep):
    return "\n".join(str(i) for i in rep.errors)


class CharacterValidation(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()

    def test_minimal_pack_passes(self):
        rep = check_character(make_character(self.root))
        self.assertTrue(rep.ok(strict=True), msgs(rep))
        self.assertEqual(rep.frames_checked, 20)

    def test_missing_required_state(self):
        rep = check_character(make_character(self.root, states=("idle", "waving")))
        self.assertFalse(rep.ok())
        self.assertIn("缺必需状态", msgs(rep))
        self.assertIn("walk-left", msgs(rep))

    def test_missing_frame_file(self):
        f = make_character(self.root)
        os.remove(os.path.join(f, "sprites", "idle_01.png"))
        rep = check_character(f)
        self.assertIn("states.idle.frames[1]: 文件不存在：sprites/idle_01.png", msgs(rep))

    def test_wrong_size(self):
        f = make_character(self.root)
        png(os.path.join(f, "sprites", "lie_00.png"), size=(190, 208))
        self.assertIn("lie_00.png 尺寸是 190x208", msgs(check_character(f)))

    def test_not_rgba_and_empty(self):
        f = make_character(self.root)
        png(os.path.join(f, "sprites", "idle_00.png"), mode="RGB")
        png(os.path.join(f, "sprites", "idle_01.png"), empty=True)
        m = msgs(check_character(f))
        self.assertIn("RGBA", m)
        self.assertIn("全透明", m)

    def test_duration_mismatch_and_range(self):
        def bad(d):
            d["states"]["idle"]["durationsMs"] = [120]
            d["states"]["waving"]["durationsMs"] = [10, 120]
        m = msgs(check_character(make_character(self.root, extra=bad)))
        self.assertIn("states.idle.durationsMs: 长度 1 与 frames 长度 2 不一致", m)
        self.assertIn("states.waving.durationsMs[0]", m)

    def test_bad_json_points_at_line(self):
        f = make_character(self.root)
        with open(os.path.join(f, "character.json"), "w", encoding="utf-8") as fh:
            fh.write('{\n  "id": "tester",\n  oops\n}')
        self.assertIn("第 3 行", msgs(check_character(f)))

    def test_missing_manifest(self):
        f = os.path.join(self.root, "characters", "empty")
        os.makedirs(f)
        self.assertIn("找不到 character.json", msgs(check_character(f)))

    def test_id_must_match_folder_and_fixed_grid(self):
        def bad(d):
            d["id"] = "other"
            d["canvas"] = [128, 128]
            d["logicalScale"] = 1
        m = msgs(check_character(make_character(self.root, extra=bad)))
        self.assertIn("必须和目录名一致", m)
        self.assertIn("canvas", m)
        self.assertIn("logicalScale", m)

    def test_alias_mood_targets(self):
        def bad(d):
            d["aliases"]["x"] = "nope"
            d["moods"]["sad"] = "mood-sad"
        m = msgs(check_character(make_character(self.root, extra=bad)))
        self.assertIn("aliases.x", m)
        self.assertIn("moods.sad", m)

    def test_path_traversal_rejected(self):
        def bad(d):
            d["states"]["idle"]["frames"][0] = "../../secret.png"
        self.assertIn("不能含 ..", msgs(check_character(make_character(self.root, extra=bad))))

    def test_look_directions(self):
        self.assertTrue(check_character(make_character(self.root, "a", looks=16)).ok())
        self.assertIn("正好 16 个方向", msgs(check_character(make_character(self.root, "b", looks=8))))

    def test_draft_allowed_but_not_strict(self):
        def draft(d):
            d["draft"] = True
            for st in d["states"].values():
                st["frames"], st["durationsMs"] = [], []
        rep = check_character(make_character(self.root, extra=draft, write_png=False))
        self.assertTrue(rep.ok())
        self.assertFalse(rep.ok(strict=True))

    def test_whale_girl_pack(self):
        rep = check_character(os.path.join(ROOT, "characters", "whale-girl"))
        self.assertFalse(rep.draft)
        self.assertTrue(rep.ok(strict=True), msgs(rep))
        with open(os.path.join(ROOT, "characters", "whale-girl", "character.json"), encoding="utf-8") as f:
            d = json.load(f)
        self.assertEqual(set(d["moods"]), {"开心", "惊讶", "疑惑", "思考", "困", "委屈", "闯祸"})
        self.assertEqual(d["moods"]["闯祸"], "mood-oops")


class FurnitureValidation(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()

    def test_valid(self):
        rep = check_furniture(make_furniture(self.root))
        self.assertTrue(rep.ok(strict=True), msgs(rep))

    def test_size_mismatch(self):
        f = make_furniture(self.root)
        png(os.path.join(f, "sprites", "full_00.png"), size=(100, 80))
        self.assertIn("要求 120x80", msgs(check_furniture(f)))

    def test_inside_needs_state_and_bad_mode(self):
        def bad(d):
            d["interactions"][0]["state"] = "nope"
            d["interactions"][1]["mode"] = "teleport"
            d["idle"] = "gone"
        m = msgs(check_furniture(make_furniture(self.root, extra=bad)))
        self.assertIn("interactions[0].state", m)
        self.assertIn("interactions[1].mode", m)
        self.assertIn("idle", m)

    def test_beside_with_furniture_state(self):
        def ok(d):
            d["interactions"].append({"verb": "peek", "mode": "beside", "pose": "mood-happy", "holdMs": 3000,
                                      "furnitureState": "full", "say": "s", "hint": "h", "done": "d"})
        rep = check_furniture(make_furniture(self.root, extra=ok))
        self.assertTrue(rep.ok(strict=True), msgs(rep))

    def test_bad_furniture_state_hold_and_pose(self):
        def bad(d):
            d["interactions"].append({"verb": "peek", "mode": "beside", "pose": "../x", "holdMs": "3s",
                                      "furnitureState": "gone"})
        m = msgs(check_furniture(make_furniture(self.root, extra=bad)))
        self.assertIn("interactions[2].furnitureState", m)
        self.assertIn("interactions[2].holdMs", m)
        self.assertIn("interactions[2].pose", m)

    def test_shipped_packs_still_pass(self):
        for n in ("mailbox", "whale-nest", "demo-bed"):
            folder = os.path.join(ROOT, "furniture", n)
            if os.path.isdir(folder):
                rep = check_furniture(folder)
                self.assertTrue(rep.ok(), msgs(rep))

    def test_template_is_draft(self):
        rep = check_furniture(os.path.join(ROOT, "furniture", "_template"))
        self.assertTrue(rep.ok(), msgs(rep))
        self.assertTrue(rep.draft)


class Cli(unittest.TestCase):
    def test_exit_codes(self):
        root = tmpdir()
        good = make_character(root, "good")
        bad = make_character(root, "bad", states=("idle",))
        self.assertEqual(main([good]), 0)
        self.assertEqual(main([good, bad]), 1)


if __name__ == "__main__":
    unittest.main()
