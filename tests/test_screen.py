"""pixelpet_screen, Python side: switch, coordinate mapping, window filter, grid, shot flow.
Only synthetic screens: no real grab, nothing written to disk."""
import base64
import io
import json
import os
import unittest

from helpers import make_character, tmpdir

from pixelpet import screen as SC

# 150 % primary (2560x1440 physical seen as 1707x960) + 100 % secondary on its right.
MONS = [
    {"index": 0, "logical": (0, 0, 1707, 960), "work": (0, 0, 1707, 920), "physical": (0, 0, 2560, 1440), "primary": True},
    {"index": 1, "logical": (1707, 0, 3627, 1080), "work": (1707, 0, 3627, 1040), "physical": (2560, 0, 4480, 1080), "primary": False},
]


def write_settings(data, **kw):
    with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
        json.dump(kw, f)


class Mapping(unittest.TestCase):
    def test_round_trip_per_monitor(self):
        self.assertEqual(SC.to_logical(1280, 720, MONS), (1280 * 1707 / 2560, 720 * 960 / 1440))
        self.assertEqual(SC.to_logical(2660, 50, MONS), (1807, 50))          # 100 % monitor: offset only
        x, y = SC.to_physical(*SC.to_logical(2000, 1000, MONS), MONS)
        self.assertAlmostEqual(x, 2000, places=6)
        self.assertAlmostEqual(y, 1000, places=6)

    def test_rects(self):
        self.assertEqual(SC.rect_to_logical((300, 150, 1500, 1050), MONS), (200, 100, 1000, 700))
        self.assertEqual(SC.rect_to_physical((200, 100, 1000, 700), MONS), (300, 150, 1500, 1050))
        self.assertEqual(SC.rect_to_logical((2600, 100, 3600, 900), MONS), (1747, 100, 2747, 900))

    def test_identity_when_aware(self):
        same = [{"index": 0, "logical": (0, 0, 1920, 1080), "physical": (0, 0, 1920, 1080), "work": (0, 0, 1920, 1040)}]
        self.assertEqual(SC.to_logical(123, 456, same), (123, 456))

    def test_public_monitors_and_targets(self):
        pub = SC.public_monitors(MONS)
        self.assertEqual(pub[0], {"index": 0, "x": 0, "y": 0, "w": 1707, "h": 960, "primary": True, "scale": 1.5})
        self.assertEqual(SC.target_rect({}, MONS, (2000, 500))[0], (1707, 0, 3627, 1080))      # pet's monitor
        self.assertEqual(SC.target_rect({"monitor": 0}, MONS, (2000, 500))[0], (0, 0, 1707, 960))
        self.assertEqual(SC.target_rect({"monitor": -1}, MONS, (0, 0))[0], (0, 0, 3627, 1080))
        self.assertIsNone(SC.target_rect({"monitor": 7}, MONS, (0, 0))[0])
        self.assertEqual(SC.target_rect({"region": {"x": -50, "y": 10, "w": 300, "h": 200}}, MONS, (0, 0))[0], (0, 10, 250, 210))
        self.assertIsNone(SC.target_rect({"region": {"x": 9000, "y": 0, "w": 50, "h": 50}}, MONS, (0, 0))[0])
        self.assertIsNone(SC.target_rect({"region": {"x": "a"}}, MONS, (0, 0))[0])


class Windows(unittest.TestCase):
    def raw(self, **kw):
        w = {"title": "Doc - Editor", "cls": "Notepad", "pid": 42, "visible": True, "iconic": False, "cloaked": False,
             "tool": False, "owned": False, "rect": (300, 150, 1500, 1050), "foreground": False, "process": "notepad.exe"}
        w.update(kw)
        return w

    def test_filter_and_coordinates(self):
        raw = [self.raw(foreground=True), self.raw(pid=os.getpid(), title="pet"), self.raw(cloaked=True),
               self.raw(title=""), self.raw(tool=True), self.raw(iconic=True), self.raw(cls="Progman"),
               self.raw(rect=(0, 0, 10, 10)), self.raw(title="Side", rect=(2600, 100, 3600, 900))]
        got = SC.pick_windows(raw, os.getpid(), MONS)
        self.assertEqual(got, [
            {"title": "Doc - Editor", "process": "notepad.exe", "x": 200, "y": 100, "w": 800, "h": 600, "foreground": True, "monitor": 0},
            {"title": "Side", "process": "notepad.exe", "x": 1747, "y": 100, "w": 1000, "h": 800, "foreground": False, "monitor": 1},
        ])

    def test_limit_and_title_cut(self):
        got = SC.pick_windows([self.raw(title="x" * 500)] * 80, 0, MONS)
        self.assertEqual(len(got), SC.WINDOW_LIMIT)
        self.assertEqual(len(got[0]["title"]), SC.TITLE_MAX)


class Grid(unittest.TestCase):
    def test_steps(self):
        self.assertEqual(SC.grid_step(1707), 200)
        self.assertEqual(SC.grid_step(300), 50)
        self.assertEqual(SC.fit((2560, 1440)), (1280, 720))
        self.assertEqual(SC.fit((800, 600)), (800, 600))

    def test_render_shot(self):
        from PIL import Image
        img = Image.new("RGB", (2560, 1440), (10, 120, 60))
        d = SC.render_shot(img, (0, 0, 1707, 960))
        self.assertEqual(d["region"], {"x": 0, "y": 0, "w": 1707, "h": 960})
        self.assertEqual((d["image"]["width"], d["image"]["height"]), (1280, 720))
        self.assertEqual(d["grid"], 200)
        out = Image.open(io.BytesIO(base64.b64decode(d["image"]["base64"])))
        self.assertEqual(out.format, "JPEG")
        x200 = round(200 * 1280 / 1707)                 # grid line at screen x = 200
        self.assertNotEqual(out.getpixel((x200, 400)), out.getpixel((x200 + 20, 400)))


class FakeWin:
    def __init__(self):
        self.shown, self.events = True, []

    def winfo_viewable(self):
        return self.shown

    def withdraw(self):
        self.shown = False
        self.events.append("hide")

    def deiconify(self):
        self.shown = True
        self.events.append("show")

    def attributes(self, *a):
        pass


class FakeBubble:
    def __init__(self):
        self.windows = [FakeWin()]


class FakeApp:
    """What screen.command touches on PetApp."""

    def __init__(self, data):
        self.data_dir, self.offscreen, self.topmost, self.hwnd = data, True, True, None
        self.root = FakeWin()
        self.root.after = lambda ms, fn: fn()
        self.bubble, self.hub, self.furniture = FakeBubble(), None, {}
        self.cameras, self.grabs = 0, []

    def body_screen(self):
        return 400, 500, 500, 700

    def screen_monitors(self):
        return MONS

    def screen_windows(self):
        return [Windows.raw(None, foreground=True)]

    def screen_grab(self, bbox):
        from PIL import Image
        self.grabs.append((bbox, self.root.shown, self.bubble.windows[0].shown))
        return Image.new("RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), (200, 200, 200))

    def show_camera(self):
        self.cameras += 1


def finish(r, body):
    from pixelpet.app import PetApp
    return PetApp.finish_result(r, body)


class Command(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()
        self.app = FakeApp(self.data)

    def test_refused_when_switch_off(self):
        for settings in ({}, {"screen": False}, {"screen": "yes"}):
            write_settings(self.data, **settings)
            ok, msg, *_ = SC.command(self.app, {"cmd": "screen", "mode": "shot"})
            self.assertFalse(ok)
            self.assertEqual(msg, SC.REFUSED)
        os.remove(os.path.join(self.data, "settings.json"))
        self.assertFalse(SC.command(self.app, {"mode": "windows"})[0])
        self.assertEqual(self.app.grabs, [])
        self.assertEqual(self.app.cameras, 0)

    def test_windows(self):
        write_settings(self.data, screen=True)
        r = finish(SC.command(self.app, {"cmd": "screen", "mode": "windows"}), {"cmd": "screen"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["data"]["windows"][0]["x"], 200)
        self.assertEqual(r["data"]["pet"], {"x": 450, "y": 700})
        self.assertEqual(len(r["data"]["monitors"]), 2)
        self.assertEqual(self.app.cameras, 0)                     # no pixels, no camera

    def test_shot_hides_pet_and_leaves_no_files(self):
        write_settings(self.data, screen=True)
        before = sorted(os.listdir(self.data))
        r = finish(SC.command(self.app, {"cmd": "screen", "mode": "shot", "monitor": 0}), {"cmd": "screen"})
        self.assertTrue(r["ok"], r)
        bbox, root_shown, bubble_shown = self.app.grabs[0]
        self.assertEqual(bbox, (0, 0, 2560, 1440))                 # physical pixels of the 150 % monitor
        self.assertFalse(root_shown)
        self.assertFalse(bubble_shown)
        self.assertTrue(self.app.root.shown)                       # restored afterwards
        self.assertEqual(self.app.cameras, 1)
        self.assertEqual(r["data"]["region"], {"x": 0, "y": 0, "w": 1707, "h": 960})
        self.assertEqual(r["data"]["image"]["mediaType"], "image/jpeg")
        self.assertEqual(sorted(os.listdir(self.data)), before)

    def test_shot_region_and_keep_pet(self):
        write_settings(self.data, screen=True)
        r = finish(SC.command(self.app, {"mode": "shot", "region": {"x": 1807, "y": 100, "w": 400, "h": 300}, "hidePet": False}), {})
        self.assertTrue(r["ok"])
        bbox, root_shown, _ = self.app.grabs[0]
        self.assertEqual(bbox, (2660, 100, 3060, 400))
        self.assertTrue(root_shown)
        self.assertEqual(self.app.root.events, [])

    def test_bad_mode(self):
        write_settings(self.data, screen=True)
        self.assertFalse(SC.command(self.app, {"mode": "video"})[0])


class RealPet(unittest.TestCase):
    """PetApp off-screen routes `screen` to screen.py; the camera is a real (off-screen) Tk window."""

    def setUp(self):
        import tkinter as tk
        try:
            self.root = tk.Tk()
        except tk.TclError as exc:
            self.skipTest("no display: %s" % exc)
        self.root.withdraw()

    def test_route_and_camera(self):
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        data = tmpdir()
        app = PetApp(self.root, root_dir, data_dir=data, character="tester", offscreen=True, speed=4000.0)
        try:
            self.assertEqual(app.command({"cmd": "screen", "mode": "windows"})[1], SC.REFUSED)
            write_settings(data, screen=True)
            self.assertFalse(app.command({"cmd": "screen", "mode": "shot"})[0])   # off-screen, no grabber: refused
            badge = SC.CameraBadge(app, ms=50)
            self.assertTrue(badge.win.winfo_exists())
            badge.close()
        finally:
            app.quit()


if __name__ == "__main__":
    unittest.main()
