"""Smoke: start the real pet off-screen with the local demo packs, drive it over the control endpoint,
exit. Skipped when the (gitignored) demo packs are not present."""
import json
import os
import subprocess
import sys
import unittest

from helpers import ROOT, make_character, tmpdir

RUN = os.path.join(ROOT, "runtime", "run_pet.py")
DEMO = os.path.join(ROOT, "characters", "demo-cat")
BED = os.path.join(ROOT, "furniture", "demo-bed")


class Smoke(unittest.TestCase):
    @unittest.skipUnless(os.path.isdir(DEMO) and os.path.isdir(BED), "local demo packs not present")
    def test_demo_cat_and_bed(self):
        data = tmpdir()
        report = os.path.join(data, "report.json")
        p = subprocess.run([sys.executable, RUN, "--character", "demo-cat", "--selftest", "--offscreen",
                            "--exit-after", "40", "--data-dir", data, "--report", report],
                           capture_output=True, text=True, timeout=90)
        with open(report, encoding="utf-8") as f:
            r = json.load(f)
        failed = [s for s in r.get("steps", []) if not s["ok"]]
        self.assertEqual(p.returncode, 0, "%s\n%s" % (failed, p.stderr[-800:]))
        self.assertFalse(r["timedOut"])
        self.assertIn("demo-bed", r["furniture"])
        self.assertGreater(r["framesDrawn"], 5)
        self.assertTrue({"idle", "lie", "walk-left"} <= set(r["seenStates"]), r["seenStates"])
        names = [s["name"] for s in r["steps"]]
        self.assertIn("use-sleep", names)
        self.assertIn("inside", names)
        self.assertFalse(os.path.exists(os.path.join(data, "control.json")), "control.json left behind")

    def test_generated_character_and_whale_nest(self):
        """干净克隆里没有私有 demo 包：现场生成一个角色，和内置的鲸鱼小窝一起跑完自检。"""
        from pixelpet.validate import REQUIRED_STATES
        data = tmpdir()
        make_character(data, "fixture-cat", states=tuple(REQUIRED_STATES) + ("curl-sleep",))
        with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"furniture": {"whale-nest": {"enabled": True}}}, f)
        report = os.path.join(data, "report.json")
        p = subprocess.run([sys.executable, RUN, "--character", "fixture-cat", "--selftest", "--offscreen",
                            "--exit-after", "40", "--data-dir", data, "--report", report],
                           capture_output=True, text=True, timeout=90, encoding="utf-8", errors="replace")
        with open(report, encoding="utf-8") as f:
            r = json.load(f)
        failed = [s for s in r.get("steps", []) if not s["ok"]]
        self.assertEqual(p.returncode, 0, "%s\n%s" % (failed, p.stderr[-800:]))
        self.assertFalse(r["timedOut"])
        self.assertIn("whale-nest", r["furniture"])
        self.assertGreater(r["framesDrawn"], 5)

    def test_draft_character_refuses_to_start(self):
        root = tmpdir()
        make_character(root, "drafty", extra=lambda d: d.update(draft=True))
        p = subprocess.run([sys.executable, RUN, "--character", "drafty", "--pack-root", root, "--offscreen",
                            "--exit-after", "5", "--data-dir", tmpdir()], capture_output=True, text=True, timeout=30,
                           encoding="utf-8", errors="replace")
        self.assertEqual(p.returncode, 3)
        self.assertIn("drafty", p.stderr)

    def test_whale_girl_runs(self):
        p = subprocess.run([sys.executable, RUN, "--character", "whale-girl", "--offscreen", "--exit-after", "3",
                            "--data-dir", tmpdir()], capture_output=True, text=True, timeout=30,
                           encoding="utf-8", errors="replace")
        self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == "__main__":
    unittest.main()
