"""听歌小卡：贴靠几何、窗口进程定位（cardwin.Card）、桌宠侧生命周期（CardHost）。Win32 / 进程全部用假对象。"""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "runtime")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "music"))
from pixelpet import card_dock as CD  # noqa: E402
from pixelmusic import cardwin as CW  # noqa: E402

WORK = (0, 0, 1920, 1040)
BODY = (800, 600, 900, 760)


class Geometry(unittest.TestCase):
    def test_right_by_default_bottom_aligned(self):
        self.assertEqual(CD.dock_rect(BODY, (340, 500), WORK), (906, 260, "right"))

    def test_flips_left_at_right_edge(self):
        x, y, side = CD.dock_rect((1700, 600, 1800, 760), (340, 500), WORK)
        self.assertEqual((x, side), (1700 - 6 - 340, "left"))

    def test_sticky_left_until_left_blocked(self):
        self.assertEqual(CD.dock_rect(BODY, (340, 500), WORK, "left")[2], "left")
        self.assertEqual(CD.dock_rect((100, 600, 200, 760), (340, 500), WORK, "left")[2], "right")

    def test_vertical_clamped_into_work(self):
        self.assertEqual(CD.dock_rect((800, 0, 900, 120), (340, 500), WORK)[1], 0)
        self.assertEqual(CD.dock_rect((800, 900, 900, 1100), (340, 500), WORK)[1], 540)

    def test_second_monitor_negative_coords(self):
        x, y, side = CD.dock_rect((-150, 500, -50, 700), (340, 500), (-1920, 0, 0, 1040))
        self.assertEqual(side, "left")
        self.assertTrue(-1920 <= x and x + 340 <= 0)

    def test_neither_side_fits_stays_on_screen(self):
        x, y, side = CD.dock_rect((150, 100, 250, 300), (340, 500), (0, 0, 400, 600))
        self.assertTrue(0 <= x and x + 340 <= 400)

    def test_mini_above_middle_and_flips(self):
        self.assertEqual(CD.mini_rect(BODY, 64, WORK), (906, int(600 + 160 * 0.3 - 32), "right"))
        self.assertEqual(CD.mini_rect((1820, 600, 1900, 760), 64, WORK)[2], "left")


class SizeEnforced(unittest.TestCase):
    """The window process sets its own size on every placement: card / record size, DPI-scaled."""

    def test_full_and_mini_sizes(self):
        (w, h), pad, vis = CW.box_for("full", 1.0)
        self.assertEqual(vis, (CD.CARD_W, CD.CARD_H))
        self.assertEqual((w, h), (CD.CARD_W + 2 * pad, CD.CARD_H + 2 * pad))
        (w, h), pad, vis = CW.box_for("mini", 1.5)
        self.assertEqual(vis, (96, 96))
        self.assertEqual(w, h)

    def test_target_puts_visible_part_on_dock_rect(self):
        x, y, w, h, side = CW.target({"body": BODY, "work": WORK}, "full", 1.0, "right")
        vx, vy, _ = CD.dock_rect(BODY, (CD.CARD_W, CD.CARD_H), WORK)
        self.assertEqual((x + CW.PAD, y + CW.PAD), (vx, vy))


class FakeWin:
    def __init__(self):
        self.calls, self.hwnd, self._scale = [], 5, 1.0

    def find(self): return self.hwnd
    def scale(self): return self._scale
    def place(self, *a): self.calls.append(("place",) + a)
    def show(self, on): self.calls.append(("show", on))
    def shape(self, *a): self.calls.append(("shape",) + a)


class WindowProcess(unittest.TestCase):
    def setUp(self):
        self.dock = {"body": list(BODY), "work": list(WORK), "visible": True, "topmost": True}
        self.alive = True
        orig = CW.pid_alive
        self.addCleanup(setattr, CW, "pid_alive", orig)
        CW.pid_alive = lambda pid: self.alive
        self.win = FakeWin()
        self.c = CW.Card("x", 1, self.win, read=lambda: self.dock)

    def test_owned_by_pet_window_zorder_follows_owner(self):
        """Pet not topmost (covered by other apps): the card must not float alone above them."""
        self.dock.update(topmost=False, owner=4242)
        owned, placed = [], []
        self.win.own = owned.append
        self.win.place = lambda *a, **k: placed.append(k.get("owned", False))
        self.c.step()
        self.assertEqual(owned, [4242])
        self.assertEqual(placed, [True], "owned: move/size only, z-order left to the owner")

    def _layout(self):
        return CW.layout(self.dock, 1.0, "right")

    def test_starts_mini_circle_inside_full_size_window(self):
        self.c.step()
        (x, y, w, h), _, circle, card, corner = self._layout()
        self.assertEqual(self.win.calls[1], ("shape",) + circle + (64,))
        self.assertEqual(self.win.calls[2][3:5], (w, h), "window keeps the full card size even collapsed")
        mx, my, _ = CD.mini_rect(BODY, 64, WORK)
        self.assertEqual((x + circle[0], y + circle[1]), (mx, my), "record sits where mini_rect wants it on screen")

    def test_instant_mode_switch_reshapes(self):
        self.c.step()
        self.c.set_mode("full", animate=False)
        self.c.step()
        _, _, _, card, corner = self._layout()
        self.assertEqual(self.win.calls[-1], ("shape",) + card + (corner,))

    def test_morph_circle_to_card_and_back(self):
        self.c.step()
        _, _, circle, card, corner = self._layout()
        t = [0.0]
        orig = CW.time.monotonic
        self.addCleanup(setattr, CW.time, "monotonic", orig)
        CW.time.monotonic = lambda: t[0]

        def tick(_):
            t[0] += 1 / 60
        self.c.sleep = tick
        self.c._morph = self._sync_morph = CW.Card._morph.__get__(self.c)    # run on this thread
        started = []
        CW.threading.Thread, orig_thread = (lambda target, args, daemon: type("T", (), {"start": lambda s: started.append(target(*args))})()), CW.threading.Thread
        self.addCleanup(setattr, CW.threading, "Thread", orig_thread)
        info = self.c.set_mode("full")
        shapes = [c[1:] for c in self.win.calls if c[0] == "shape"]
        self.assertEqual(shapes[1], circle + (64,), "starts from the mini circle")
        self.assertEqual(shapes[-1], card + (corner,), "ends on the card")
        self.assertGreater(len(shapes), 15, "~60 fps over 300 ms")
        self.assertEqual((info["x"], info["y"], info["d"], info["ms"]), (circle[0], circle[1], 64, 300))
        self.assertFalse(self.c.animating)
        self.c.set_mode("mini")
        self.assertEqual(self.win.calls[-1][1:], circle + (64,))

    def test_placement_waits_while_morphing(self):
        self.c.step()
        self.c.animating = True
        self.dock["body"] = [700, 600, 800, 760]
        n = len(self.win.calls)
        self.assertIsNone(self.c.step())
        self.assertEqual(len(self.win.calls), n)
        self.assertEqual(self.c.set_mode("full")["mode"], "mini", "repeat clicks ignored mid-animation")
        self.c.animating = False
        self.c.step()
        self.assertEqual(self.win.calls[-1][0], "place")

    def test_mini_spot_pushed_to_page(self):
        sent = []
        self.c.notify = sent.append
        self.c.step()
        self.c.step()
        _, _, circle, _, _ = self._layout()
        self.assertEqual(sent, ["window.__cardMini && window.__cardMini(%.2f, %.2f, %.2f)" % (circle[0], circle[1], 64)])

    def test_no_redundant_moves_and_follows_pet(self):
        self.c.step()
        n = len(self.win.calls)
        self.c.step()
        self.assertEqual(len(self.win.calls), n)
        self.dock["body"] = [820, 600, 920, 760]
        self.c.step()
        self.assertEqual(self.win.calls[-1][0], "place")
        self.assertEqual(len(self.win.calls), n + 1, "same size: no re-clip")

    def test_hidden_with_pet(self):
        self.c.step()
        self.dock["visible"] = False
        self.c.step()
        self.c.step()
        self.assertEqual([c for c in self.win.calls if c[0] == "show"], [("show", True), ("show", False)])

    def test_quits_when_pet_gone(self):
        self.alive = False
        self.assertEqual(self.c.step(), "quit")

    def test_bad_mode_ignored(self):
        self.assertEqual(self.c.set_mode("huge")["mode"], "mini")


class FakeProc:
    def __init__(self): self.code, self.terminated = None, False
    def poll(self): return self.code
    def terminate(self): self.terminated, self.code = True, -15
    def wait(self, timeout=None): return self.code


class FakePet:
    def __init__(self, data_dir):
        self.data_dir, self.topmost, self.shown = data_dir, True, True
    def body_screen(self): return BODY
    def work_area(self): return WORK
    def visible(self): return self.shown


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.py = os.path.join(self.tmp, "python.exe")
        open(self.py, "w").close()
        self.cfg = {"listen": {"enabled": True, "python": self.py}}
        self.t = [0.0]
        self.spawned = []

        def spawn(argv, cwd):
            p = FakeProc()
            self.spawned.append((argv, p))
            return p
        self.h = CD.CardHost(FakePet(self.tmp), spawn=spawn, clock=lambda: self.t[0], settings=lambda: self.cfg,
                             base="http://127.0.0.1:3080/dsh-pixel-pet")

    def test_auto_open_when_enabled_and_dock_file_written(self):
        self.h.tick()
        argv = self.spawned[0][0]
        self.assertEqual(argv[:3], [self.py, "-m", "pixelmusic.cardwin"])
        self.assertIn("http://127.0.0.1:3080/dsh-pixel-pet/card", argv)
        with open(self.h.dock_path(), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["body"], list(BODY))

    def test_listen_off_closes(self):
        self.h.tick()
        self.cfg["listen"]["enabled"] = False
        self.t[0] = 3
        self.h.tick()
        self.assertTrue(self.spawned[0][1].terminated)
        self.assertIsNone(self.h.proc)

    def test_user_close_is_remembered_until_manual_open(self):
        self.h.tick()
        self.spawned[0][1].code = CD.EXIT_DISMISSED
        self.t[0] = 1
        self.h.tick()
        self.t[0] = 100
        self.h.tick()
        self.assertEqual(len(self.spawned), 1)
        self.assertEqual(self.h.open(), (True, "ok"))
        self.assertEqual(len(self.spawned), 2)

    def test_crash_backoff_then_give_up(self):
        self.h.tick()
        for wait in CD.RETRY_S:
            self.spawned[-1][1].code = 1
            self.h.tick()
            n = len(self.spawned)
            self.t[0] += wait - 0.5
            self.h.tick()
            self.assertEqual(len(self.spawned), n, "still backing off")
            self.t[0] += 1
            self.h.tick()
            self.assertEqual(len(self.spawned), n + 1)
        self.spawned[-1][1].code = 1
        self.h.tick()
        self.t[0] += 999
        self.h.tick()
        self.assertTrue(self.h.dismissed)

    def test_long_run_resets_retry_budget(self):
        self.h.tick()
        for _ in range(3):
            self.t[0] += 120                 # ran fine for two minutes, then died (e.g. killed for a restart)
            self.spawned[-1][1].code = 1
            self.h.tick()
            self.t[0] += CD.RETRY_S[0] + 0.1
            self.h.tick()
        self.assertFalse(self.h.dismissed)
        self.assertEqual(self.h.failures, 1)

    def test_manual_open_needs_listen_and_python(self):
        self.cfg["listen"]["enabled"] = False
        self.assertFalse(self.h.open()[0])
        self.cfg["listen"] = {"enabled": True, "python": os.path.join(self.tmp, "missing.exe")}
        self.assertFalse(self.h.open()[0])

    def test_no_host_base_no_spawn(self):
        self.h.base = ""
        self.h.tick()
        self.assertEqual(self.spawned, [])

    def test_stop_on_quit(self):
        self.h.tick()
        self.h.stop()
        self.assertTrue(self.spawned[0][1].terminated)

    def test_music_python_falls_back_to_listen_json(self):
        with open(os.path.join(self.tmp, "listen.json"), "w", encoding="utf-8") as f:
            json.dump({"python": self.py}, f)
        self.assertEqual(CD.music_python({}, self.tmp), self.py)
        self.assertEqual(CD.music_python({"listen": {"python": "C:/nope.exe"}}, os.path.join(self.tmp, "x")), "")


if __name__ == "__main__":
    unittest.main()
