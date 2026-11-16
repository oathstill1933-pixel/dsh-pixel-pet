"""Furniture with only empty frames: the running character's own pose is laid on top at the card's anchor.

Also: "+ 新建家具" packs in <data>/furniture load next to the built-in ones, {name} in done texts, the
furniture converter, and a live off-screen pet sleeping in whale-nest / demo-bed (screenshots -> .tmp/next-c/).
"""
import json
import os
import shutil
import subprocess
import sys
import unittest

from helpers import ROOT, make_character, make_furniture, png, tmpdir

from pixelpet.furniture import (compose_occupied, fill_name, load_furniture, make_occupant, occupant_pose, summary)
from pixelpet.validate import check_furniture

SHOTS = os.path.join(ROOT, ".tmp", "next-c")


def occ_inter(**over):
    it = {"verb": "sleep", "mode": "inside", "occupant": {"pose": "curl-sleep", "anchor": [60, 70]},
          "enterPose": "jumping", "done": "{name}睡下了。", "say": "s", "hint": "叫{name}睡觉时用"}
    it.update(over)
    return it


class Compose(unittest.TestCase):
    def test_bottom_centre_lands_on_anchor_and_clip_redraws_front(self):
        from PIL import Image
        base = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
        base.paste((200, 200, 200, 255), (0, 60, 120, 80))          # bed rim along the bottom
        occ = Image.new("RGBA", (192, 208), (0, 0, 0, 0))
        occ.paste((255, 0, 0, 255), (80, 150, 112, 208))             # 32x58 body, bottom-centre (96, 208)
        out = compose_occupied(base, occ, (60, 70))
        self.assertEqual(out.size, (120, 80))
        self.assertEqual(out.getpixel((60, 65))[:3], (255, 0, 0))    # body covers the rim (no clip)
        self.assertEqual(out.getpixel((44, 40))[:3], (255, 0, 0))    # left edge = 60 - 16
        self.assertEqual(out.getpixel((43, 40))[3], 0)
        clipped = compose_occupied(base, occ, (60, 70), clip_y=60)
        self.assertEqual(clipped.getpixel((60, 65))[:3], (200, 200, 200))   # rim drawn back over the body
        self.assertEqual(clipped.getpixel((60, 50))[:3], (255, 0, 0))
        self.assertEqual(base.getpixel((60, 50))[3], 0, "base frame untouched")

    def test_pose_fallback(self):
        self.assertEqual(occupant_pose({"lie": 1, "idle": 1}, {"pose": "curl-sleep"}), "lie")
        self.assertEqual(occupant_pose({"idle": 1}, {"pose": "curl-sleep", "fallback": ["nope"]}), "idle")
        self.assertEqual(occupant_pose({"curl-sleep": 1}, {"pose": "curl-sleep"}), "curl-sleep")

    def test_name_placeholder(self):
        self.assertEqual(fill_name("{name}钻进小窝睡下了。", "demo cat"), "demo cat钻进小窝睡下了。")
        self.assertEqual(fill_name("{name}起床了。", ""), "它起床了。")


class AreaAndClipPath(unittest.TestCase):
    def body(self):
        from PIL import Image
        occ = Image.new("RGBA", (192, 208), (0, 0, 0, 0))
        occ.paste((255, 0, 0, 255), (40, 108, 160, 208))             # 120x100 body
        return occ

    def test_fit_scale_never_up(self):
        from pixelpet.furniture import fit_scale
        self.assertEqual(fit_scale((0, 0, 100, 50), (0, 0, 400, 400)), 1.0)
        self.assertAlmostEqual(fit_scale((0, 0, 100, 50), (0, 0, 50, 400)), 0.5)
        self.assertAlmostEqual(fit_scale((0, 0, 100, 50), (0, 0, 400, 10)), 0.2)

    def test_clip_line_interpolates_and_clamps(self):
        from pixelpet.furniture import clip_line
        line = clip_line(10, [(2, 10), (6, 2)])
        self.assertEqual(line[0], 10)                                 # left of range: first point's y
        self.assertEqual(line[4], 6)                                  # halfway
        self.assertEqual(line[9], 2)                                  # right of range: last point's y
        self.assertEqual(clip_line(3, None, 5), [5, 5, 5])
        self.assertIsNone(clip_line(3))

    def test_make_occupant_scales_into_area(self):
        from pixelpet.furniture import compose_occupied, make_occupant

        class C:
            id = "wide"
            states = {"curl-sleep": 1}
            frames = {"curl-sleep": [self.body(), self.body()]}

            def durations(self, pose):
                return [100, 100]
        d = {"id": "nest", "idle": "empty", "states": {"empty": {}}}
        inter = occ_inter(occupant={"pose": "curl-sleep", "anchor": [0, 0], "area": [20, 10, 80, 90],
                                    "clipPath": [[0, 70], [100, 50]]})
        occ = make_occupant(C(), d, inter)
        self.assertEqual(occ["anchor"], (50, 90))                     # area wins: bottom-centre of the area
        l, t, r, b = occ["box"]
        self.assertEqual(r - l, 60)                                   # 120 wide scaled 0.5 to the area width
        self.assertEqual(b - t, 50)
        self.assertEqual(len(occ["frames"]), 2)
        self.assertIs(make_occupant(C(), d, inter)["frames"], occ["frames"])   # cached, not rescaled
        from PIL import Image
        base = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        base.paste((200, 200, 200, 255), (0, 40, 100, 100))
        out = compose_occupied(base, occ["frames"][0], occ["anchor"], occ["box"], clip_path=occ["clipPath"])
        self.assertEqual(out.getpixel((21, 45))[:3], (255, 0, 0))     # body inside area, above the front
        self.assertEqual(out.getpixel((19, 80))[:3], (200, 200, 200))  # left of area: furniture only
        self.assertEqual(out.getpixel((25, 75))[:3], (200, 200, 200))  # below front (y ~ 65 at x=25): rim on top
        self.assertEqual(out.getpixel((75, 60))[:3], (200, 200, 200))  # front y ~ 55 at x=75
        self.assertEqual(out.getpixel((75, 50))[:3], (255, 0, 0))

    def test_anchor_still_used_without_area(self):
        occ = make_occupant(type("C", (), {"id": "x", "states": {"lie": 1}, "frames": {"lie": [self.body()]},
                                           "durations": lambda s, p: [1]})(),
                            {"idle": "empty", "states": {"empty": {}}}, occ_inter())
        self.assertEqual(occ["anchor"], (60, 70))
        self.assertEqual(occ["box"], (40, 108, 160, 208))

    def test_validator_area_and_clip_path(self):
        root = tmpdir()

        def with_occ(name, **o):
            base = {"pose": "curl-sleep"}
            base.update(o)
            return make_furniture(root, name, extra=lambda d: (d["states"].pop("full"),
                                                               d.update(interactions=[occ_inter(occupant=base)])))
        ok = with_occ("ok", area=[10, 10, 60, 60], clipPath=[[0, 50], [40, 45], [80, 50]])
        self.assertTrue(check_furniture(ok).ok(strict=True), check_furniture(ok).issues)
        cases = {"a1": dict(area=[10, 10, 60]), "a2": dict(area=[60, 10, 10, 60]), "a3": dict(area=[0, 0, 9999, 10]),
                 "c1": dict(anchor=[1, 1], clipPath=[[0, 1]]), "c2": dict(anchor=[1, 1], clipPath=[[5, 1], [5, 2]]),
                 "c3": dict(anchor=[1, 1], clipPath=[[0, 1], ["x", 2]]),
                 "c4": dict(anchor=[1, 1], clipPath=[[i, 1] for i in range(25)]),
                 "c5": dict(anchor=[1, 1], clipPath=[[0, 1], [99999, 2]])}
        for name, o in cases.items():
            errs = check_furniture(with_occ(name, **o)).errors
            field = "area" if name[0] == "a" else "clipPath"
            self.assertTrue(any("occupant." + field in str(i) for i in errs), (name, errs))


class Packs(unittest.TestCase):
    def test_validator_accepts_occupant_without_occupied_state(self):
        root = tmpdir()
        f = make_furniture(root, "nest", extra=lambda d: (d["states"].pop("full"), d.update(interactions=[occ_inter()])))
        rep = check_furniture(f)
        self.assertTrue(rep.ok(strict=True), rep.issues)
        bad = make_furniture(root, "bad", extra=lambda d: d.update(interactions=[occ_inter(occupant={"anchor": "x"})]))
        self.assertTrue(any("occupant.anchor" in str(i) for i in check_furniture(bad).errors))
        none = make_furniture(root, "none", extra=lambda d: (d["states"].pop("full"),
                                                             d.update(interactions=[{"verb": "sleep", "mode": "inside"}])))
        self.assertTrue(any("occupant" in str(i) for i in check_furniture(none).errors))

    def test_shipped_packs_valid_and_keep_their_occupied_frames(self):
        for fid in ("whale-nest", "demo-bed"):
            folder = os.path.join(ROOT, "furniture", fid)
            if not os.path.isdir(folder):
                continue
            rep = check_furniture(folder)
            self.assertTrue(rep.ok(strict=True), rep.issues)
            with open(os.path.join(folder, "furniture.json"), encoding="utf-8") as fh:
                d = json.load(fh)
            sleep = next(i for i in d["interactions"] if i["verb"] == "sleep")
            self.assertIn("occupant", sleep)
            self.assertIn("occupied", d["states"])                       # old frames kept for older runtimes
            self.assertTrue(os.path.isfile(os.path.join(folder, d["states"]["occupied"]["frames"][0])))
            self.assertNotIn("鲸鱼娘", json.dumps(d["interactions"], ensure_ascii=False))

    def test_user_layer_overrides_a_builtin_piece(self):
        """Since "再编辑", a same-id copy in the data dir is an edited version of the built-in piece."""
        root, data = tmpdir(), tmpdir()
        make_furniture(root, "box")
        make_furniture(data, "box", extra=lambda d: d.update(name="shadow"))
        make_furniture(data, "mine", extra=lambda d: d.update(name="Mine"))
        defs, errors = load_furniture(root, with_images=False, user_root=data)
        self.assertEqual(defs["box"]["name"], "shadow")
        self.assertTrue(defs["box"]["_user"])
        self.assertTrue(defs["mine"]["_user"])
        self.assertEqual(errors, {})

    def test_summary_fills_character_name(self):
        root = tmpdir()
        make_furniture(root, "nest", extra=lambda d: d.update(interactions=[occ_inter()]))
        defs, _ = load_furniture(root, with_images=False)
        self.assertEqual(summary(defs, {}, "Tester")[0]["interactions"][0]["hint"], "叫Tester睡觉时用")

    def test_make_occupant_uses_current_character(self):
        from pixelpet.character import load_character
        root = tmpdir()
        c = load_character(make_character(root, "tester"))
        d = {"idle": "empty", "states": {"empty": {}}}
        occ = make_occupant(c, d, occ_inter())
        self.assertEqual(occ["pose"], "lie")                              # tester has no curl-sleep
        self.assertEqual(occ["key"], "tester/lie")
        self.assertEqual(occ["under"], "empty")
        self.assertIsNone(make_occupant(c, d, {"verb": "sleep", "mode": "inside", "state": "full"}))


class Convert(unittest.TestCase):
    def test_green_background_to_pack(self):
        from PIL import Image
        src, out = tmpdir(), os.path.join(tmpdir(), "furn-abc123")
        for i in range(2):
            im = Image.new("RGB", (400, 300), (0, 255, 0))
            im.paste((120, 80, 40), (150, 120 + i, 250, 280))           # narrower than the card: sides stay clear
            im.save(os.path.join(src, "empty_%02d.png" % i))
        os.makedirs(os.path.join(out, "sprites"))
        manifest = {"id": "furn-abc123", "name": "x", "version": 1, "size": [200, 160], "anchor": "bottom-right",
                    "floorY": 156, "idle": "empty",
                    "states": {"empty": {"frames": ["sprites/empty_00.png", "sprites/empty_01.png"], "durationsMs": [500, 500]}},
                    "interactions": [occ_inter(occupant={"pose": "curl-sleep", "anchor": [100, 120]})]}
        with open(os.path.join(out, "furniture.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "runtime", "furniture_convert.py"), "--src", src,
                            "--out", out, "--frames", "empty_00,empty_01", "--size", "200,160"],
                           capture_output=True, text=True, encoding="utf-8", timeout=60)
        r = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertTrue(r["ok"], r)
        with Image.open(os.path.join(out, "sprites", "empty_00.png")) as im:
            self.assertEqual(im.size, (200, 160))
            self.assertEqual(im.getpixel((0, 0))[3], 0)                   # green keyed out
            self.assertEqual(im.getchannel("A").getbbox()[3], 160)        # sits on the bottom edge


class LiveSleep(unittest.TestCase):
    """Real PetApp off-screen: the furniture window shows empty frame + the current character's curl-sleep."""

    def sleep_in(self, cid, fid, synthetic=False):
        import tkinter as tk
        from pixelpet.app import PetApp
        from pixelpet.validate import REQUIRED_STATES
        data = tmpdir()
        if synthetic:
            # 干净克隆里没有本机私有的 demo 包：角色现场生成，放在数据目录的用户层
            make_character(data, cid, states=tuple(REQUIRED_STATES) + ("curl-sleep",))
        elif not os.path.isdir(os.path.join(ROOT, "characters", cid)):
            self.skipTest("pack not present: %s" % cid)
        if not os.path.isdir(os.path.join(ROOT, "furniture", fid)):
            self.skipTest("pack not present: %s" % fid)
        with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"furniture": {fid: {"enabled": True}}}, f)
        root = tk.Tk()
        app = PetApp(root, ROOT, data_dir=data, character=cid, offscreen=True, speed=4000.0)
        try:
            self.assertIn(fid, app.furniture)
            w = app.furniture[fid]
            inter = next(i for i in w.defn["interactions"] if i["verb"] == "sleep")
            ok, msg, motion = app.command({"cmd": "use", "id": fid, "verb": "sleep"})[:3]
            self.assertTrue(ok, msg)
            self.assertIn(app.char.name, motion["done"])
            self.assertNotIn("{name}", motion["done"])
            app.enter_inside(fid, inter.get("state"), "left", inter)
            self.assertEqual(app.inside[0], fid)
            self.assertIsNotNone(w.occupant)
            self.assertEqual(w.occupant["key"], "%s/curl-sleep" % cid)
            self.assertEqual(w.base_state, w.defn["idle"])                  # empty frame underneath, not "occupied"
            import time
            w.tick(time.monotonic())
            shot = w.frame_image(w.base_state, 0, 0)
            empty = w.defn["_frames"][w.defn["idle"]][0]
            self.assertEqual(shot.size, empty.size)
            self.assertNotEqual(shot.tobytes(), empty.tobytes())
            if "occupied" in w.defn["states"]:
                self.assertNotEqual(shot.tobytes(), w.defn["_frames"]["occupied"][0].tobytes())
            os.makedirs(SHOTS, exist_ok=True)
            from PIL import Image
            big = shot.resize((shot.width * 2, shot.height * 2), Image.NEAREST)
            bg = Image.new("RGBA", big.size, (236, 238, 245, 255))
            bg.alpha_composite(big)
            bg.convert("RGB").save(os.path.join(SHOTS, "%s-in-%s.png" % (cid, fid)))
            ok, msg = app.command({"cmd": "use", "id": fid, "verb": "wake"})[:2]
            self.assertTrue(ok, msg)
            self.assertIn(app.char.name, msg)
            self.assertIsNone(w.occupant)
            self.assertIsNone(app.inside)
        finally:
            app.quit()

    def test_whale_girl_sleeps_in_whale_nest(self):
        # the nest's occupied art was drawn for her (occupant.drawnFor): no overlay, the drawn frame shows
        import tkinter as tk
        from pixelpet.app import PetApp
        data = tmpdir()
        with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"furniture": {"whale-nest": {"enabled": True}}}, f)
        app = PetApp(tk.Tk(), ROOT, data_dir=data, character="whale-girl", offscreen=True, speed=4000.0)
        try:
            w = app.furniture["whale-nest"]
            inter = next(i for i in w.defn["interactions"] if i["verb"] == "sleep")
            app.enter_inside("whale-nest", inter.get("state"), "left", inter)
            self.assertIsNone(w.occupant)
            self.assertEqual(w.base_state, "occupied")
        finally:
            app.quit()

    def test_demo_cat_sleeps_in_demo_bed(self):
        self.sleep_in("demo-cat", "demo-bed")             # 只在有本机私有 demo 包时跑

    def test_other_character_sleeps_in_whale_nest(self):
        # the old problem: the nest's occupied frame has the whale girl drawn in it
        self.sleep_in("fixture-cat", "whale-nest", synthetic=True)


if __name__ == "__main__":
    unittest.main()
