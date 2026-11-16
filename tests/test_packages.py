import os
import unittest

from helpers import ROOT, make_character, make_furniture, tmpdir

from pixelpet.character import PackError, list_characters, load_character
from pixelpet.furniture import (clamp_spot, default_spot, is_enabled, load_furniture, pick_side, sanitize_cfg,
                                stand_spot, summary)


class CharacterLoading(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()

    def test_load_frames_and_api(self):
        c = load_character(make_character(self.root, looks=16, frames=3))
        self.assertEqual(c.id, "tester")
        self.assertEqual(len(c.frames["idle"]), 3)
        self.assertEqual(c.frames["idle"][0].mode, "RGBA")
        self.assertEqual(len(c.look_frames), 16)
        self.assertEqual(c.resolve("working"), "running")
        self.assertIsNone(c.resolve("nope"))
        self.assertEqual(c.total_ms("idle"), 360)
        names = c.pose_names()
        self.assertEqual(names["lie"], "lie")
        self.assertEqual(names["happy"], "waving")       # mood tag from the pack's own map

    def test_bad_pack_raises_readable(self):
        f = make_character(self.root, states=("idle",))
        with self.assertRaises(PackError) as cm:
            load_character(f)
        self.assertIn("缺必需状态", str(cm.exception))

    def test_draft_never_runs(self):
        make_character(self.root, "drafty", extra=lambda d: d.update(draft=True))
        with self.assertRaises(PackError):
            load_character(os.path.join(self.root, "characters", "drafty"))

    def test_listing(self):
        make_character(self.root, "a")
        make_character(self.root, "b", states=("idle",))
        got = {c["id"]: c for c in list_characters(self.root)}
        self.assertTrue(got["a"]["ok"])
        self.assertFalse(got["b"]["ok"])


class FurnitureLoading(unittest.TestCase):
    def setUp(self):
        self.root = tmpdir()

    def test_load_skips_template_and_bad(self):
        make_furniture(self.root, "box")
        make_furniture(self.root, "_template")
        make_furniture(self.root, "broken", extra=lambda d: d.update(idle="nope"))
        defs, errors = load_furniture(self.root)
        self.assertEqual(list(defs), ["box"])
        self.assertIn("broken", errors)
        self.assertIn("idle", errors["broken"])
        self.assertEqual(len(defs["box"]["_frames"]["empty"]), 1)

    def test_summary_uses_neutral_hint(self):
        make_furniture(self.root, "box")
        defs, _ = load_furniture(self.root, with_images=False)
        s = summary(defs, {})
        self.assertEqual(s[0]["interactions"][0], {"verb": "sleep", "say": "s", "hint": "h"})
        self.assertEqual(summary(defs, {"box": {"enabled": False}}), [])

    def test_geometry_helpers(self):
        taken = {}
        a = default_spot("bottom-right", 100, 50, (0, 0, 1920, 1040), taken)
        b = default_spot("bottom-right", 60, 50, (0, 0, 1920, 1040), taken)
        self.assertEqual(a, (1920 - 24 - 100, 1040))
        self.assertLessEqual(b[0] + 60, a[0])
        self.assertEqual(clamp_spot(5000, 9000, 100, 50, (0, 0, 1920, 1040)), (1820, 1040))
        d = {"size": [120, 80], "floorY": 74, "stand": {"left": 10, "right": 110}}
        x, y = stand_spot(d, 100, 500, 1.0, (40, 20, 150, 200), "left")
        self.assertEqual((x, y), (100 + 10 - 95, 500 - 6 - 200))
        self.assertEqual(pick_side(90, 100, 120), "left")
        self.assertEqual(pick_side(200, 100, 120), "right")

    def test_cfg_sanitize_and_enabled(self):
        self.assertEqual(sanitize_cfg({"a": {"enabled": "yes", "x": 1.5, "y": 2}, 3: {}}), {"a": {}})
        self.assertTrue(is_enabled({"id": "a", "defaultEnabled": True}, {}))
        self.assertFalse(is_enabled({"id": "a", "defaultEnabled": True}, {"a": {"enabled": False}}))


if __name__ == "__main__":
    unittest.main()
