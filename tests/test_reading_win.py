"""一起看书阅读窗：默认贴主屏右侧、记住位置大小（多屏/越界）、单实例聚焦、窗口进程放置与记忆、桌宠侧生命周期。
Win32 / 进程 / pywebview 全部用假对象。"""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "runtime")
sys.path.insert(0, ROOT)
from pixelpet import reading_dock as RD  # noqa: E402
from pixelpet import reading_win as RW  # noqa: E402

WORK = (0, 0, 1920, 1040)
RIGHT = (1920, 0, 3840, 1080)


class Geometry(unittest.TestCase):
    def test_default_right_edge_full_height(self):
        self.assertEqual(RD.default_rect(WORK, 1.0), (1400, 0, 520, 1040))

    def test_default_scales_with_dpi(self):
        x, y, w, h = RD.default_rect(WORK, 1.5)
        self.assertEqual((w, x + w, y, h), (780, 1920, 0, 1040))

    def test_default_on_small_screen_keeps_a_readable_width(self):
        x, y, w, h = RD.default_rect((0, 0, 800, 600), 1.0)
        self.assertEqual((x + w, w), (800, 360))

    def test_default_follows_primary_offset(self):
        x, y, w, h = RD.default_rect((-1920, 40, 0, 1080), 1.0)
        self.assertEqual((x + w, y, h), (0, 40, 1040))

    def test_restore_on_second_monitor(self):
        self.assertEqual(RD.restore_rect([2400, 100, 600, 900], [WORK, RIGHT]), (2400, 100, 600, 900))

    def test_restore_rejects_rect_from_a_monitor_that_is_gone(self):
        self.assertIsNone(RD.restore_rect([2400, 100, 600, 900], [WORK]))

    def test_restore_rejects_mostly_offscreen(self):
        self.assertIsNone(RD.restore_rect([1900, 100, 600, 900], [WORK]))

    def test_restore_clamps_size_and_keeps_title_bar_reachable(self):
        x, y, w, h = RD.restore_rect([100, -300, 200, 5000], [WORK])
        self.assertEqual((w, h, y), (RD.MIN_W, 1040, 0))

    def test_restore_garbage(self):
        for bad in (None, "x", [1, 2], [0, 0, 0, 0], [0, 0, -5, 10]):
            self.assertIsNone(RD.restore_rect(bad, [WORK]))


class FakeWin:
    def __init__(self, pid=4242, hwnd=77, works=(WORK,), owners=None):
        self.pid, self.hwnd, self._works = pid, hwnd, list(works)
        self.owners = owners or {hwnd: pid}
        self.calls = []
        self.r = None
        self.min = self.max = False
        self.findable = True

    def find(self, pid, title):
        self.calls.append(("find", pid, title))
        return self.hwnd if self.findable and pid == self.pid else None

    def owner(self, hwnd):
        return self.owners.get(hwnd, 0)

    def front(self, hwnd):
        self.calls.append(("front", hwnd))

    def place(self, hwnd, x, y, w, h):
        self.calls.append(("place", hwnd, x, y, w, h))
        self.r = (x, y, w, h)

    def rect(self, hwnd):
        return self.r

    def iconic(self, hwnd):
        return self.min

    def zoomed(self, hwnd):
        return self.max

    def maximize(self, hwnd):
        self.calls.append(("maximize", hwnd))
        self.max = True

    def scale(self, hwnd):
        return 1.0

    def works(self):
        return self._works


class FakeWindow:
    def __init__(self):
        self.shown = self.destroyed = 0
        self.titles = []

    def show(self):
        self.shown += 1

    def destroy(self):
        self.destroyed += 1

    def set_title(self, t):
        self.titles.append(t)


class ReaderProcess(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.state = os.path.join(self.dir, "reading", "window.json")
        self._alive = RW.pid_alive
        RW.pid_alive = lambda pid: pid != 999

    def tearDown(self):
        RW.pid_alive = self._alive

    def reader(self, win, parent=1):
        r = RW.Reader(self.state, parent, win, pid=win.pid)
        r.window = FakeWindow()
        return r

    def test_first_run_right_edge_then_shown_and_remembered(self):
        win = FakeWin()
        r = self.reader(win)
        r.step()
        self.assertIn(("place", 77, 1400, 0, 520, 1040), win.calls)
        self.assertEqual(r.window.shown, 1)
        st = RD.read_state(self.state)
        self.assertEqual((st["pid"], st["hwnd"], st["rect"], st["maximized"]), (4242, 77, [1400, 0, 520, 1040], False))

    def test_user_move_resize_is_saved_but_not_while_minimized_or_maximized(self):
        win = FakeWin()
        r = self.reader(win)
        r.step()
        win.r = (300, 120, 640, 800)
        r.step()
        self.assertEqual(RD.read_state(self.state)["rect"], [300, 120, 640, 800])
        win.min, win.r = True, (-32000, -32000, 160, 28)
        r.step()
        self.assertEqual(RD.read_state(self.state)["rect"], [300, 120, 640, 800])
        win.min, win.max, win.r = False, True, (0, 0, 1920, 1040)
        r.step()
        st = RD.read_state(self.state)
        self.assertEqual((st["rect"], st["maximized"]), ([300, 120, 640, 800], True))

    def test_reopen_restores_rect_and_maximized(self):
        RD.write_state(self.state, {"pid": 0, "hwnd": 0, "rect": [2400, 100, 600, 900], "maximized": True})
        win = FakeWin(works=(WORK, RIGHT))
        r = self.reader(win)
        r.step()
        self.assertIn(("place", 77, 2400, 100, 600, 900), win.calls)
        self.assertIn(("maximize", 77), win.calls)

    def test_saved_on_missing_monitor_falls_back_to_default(self):
        RD.write_state(self.state, {"rect": [2400, 100, 600, 900], "maximized": True})
        win = FakeWin(works=(WORK,))
        self.reader(win).step()
        self.assertIn(("place", 77, 1400, 0, 520, 1040), win.calls)
        self.assertNotIn(("maximize", 77), win.calls)

    def test_handle_not_there_yet_still_shows_after_a_moment(self):
        win = FakeWin()
        win.findable = False
        r = self.reader(win)
        r.step()
        self.assertEqual(r.window.shown, 0)
        r._t0 -= 2
        r.step()
        self.assertEqual(r.window.shown, 1)
        win.findable = True
        r.step()
        self.assertTrue(r.placed)
        self.assertEqual(r.window.shown, 1)

    def test_parent_gone_quits(self):
        r = self.reader(FakeWin(), parent=999)
        self.assertEqual(r.step(), "quit")

    def test_forget_pid_keeps_rect(self):
        win = FakeWin()
        r = self.reader(win)
        r.step()
        r.forget_pid()
        st = RD.read_state(self.state)
        self.assertEqual((st["pid"], st["hwnd"], st["rect"]), (0, 0, [1400, 0, 520, 1040]))

    def test_api_title_and_external(self):
        r = self.reader(FakeWin())
        api = RW.Api(r)
        api.set_title("示例讲义.pdf")
        api.set_title("")
        self.assertEqual(r.window.titles, ["示例讲义.pdf · 一起看书", "一起看书"])
        self.assertFalse(api.open_external("file:///C:/x"))
        self.assertFalse(api.open_external("javascript:alert(1)"))


class SingleInstance(unittest.TestCase):
    def test_focuses_running_window_of_that_pid(self):
        win = FakeWin(owners={77: 4242})
        self.assertTrue(RD.focus_window({"pid": 4242, "hwnd": 77}, lambda p: True, win))
        self.assertIn(("front", 77), win.calls)

    def test_stale_or_dead_or_foreign_hwnd_is_ignored(self):
        win = FakeWin(owners={77: 1})
        self.assertFalse(RD.focus_window({"pid": 4242, "hwnd": 77}, lambda p: True, win))
        self.assertFalse(RD.focus_window({"pid": 4242, "hwnd": 77}, lambda p: False, FakeWin()))
        self.assertFalse(RD.focus_window({}, lambda p: True, FakeWin()))
        self.assertFalse(RD.focus_window({"pid": "x", "hwnd": 77}, lambda p: True, FakeWin()))
        self.assertFalse(RD.focus_window({"pid": os.getpid(), "hwnd": 77}, lambda p: True, FakeWin(pid=os.getpid())))

    def test_main_refuses_non_loopback_url(self):
        self.assertEqual(RW.main(["--url", "https://example.com/", "--state", os.path.join(tempfile.mkdtemp(), "w.json")]), 2)


class Proc:
    def __init__(self):
        self.code = None
        self.terminated = 0

    def poll(self):
        return self.code

    def terminate(self):
        self.terminated += 1
        self.code = 0

    def wait(self, timeout=None):
        return self.code


class Pet:
    def __init__(self, d):
        self.data_dir = d


class Host(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.py = os.path.join(self.dir, "python.exe")
        open(self.py, "w").close()
        self.cfg = {"reading": {"enabled": True}, "listen": {"python": self.py}}
        self.t = [0.0]
        self.spawned = []
        self.focused = []

        def spawn(argv, cwd):
            p = Proc()
            self.spawned.append((argv, cwd, p))
            return p
        self.host = RD.ReadingHost(Pet(self.dir), spawn=spawn, clock=lambda: self.t[0], settings=lambda: self.cfg,
                                   base="http://127.0.0.1:3080/dsh-pixel-pet", focus=lambda: self.focused.append(1) or True)

    def test_opens_only_on_demand(self):
        for _ in range(5):
            self.t[0] += 3
            self.host.tick()
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.host.open(), (True, "ok"))
        argv, cwd, _ = self.spawned[0]
        self.assertEqual(argv[:5], [self.py, "-X", "utf8", "-m", "pixelpet.reading_win"])
        self.assertEqual(argv[argv.index("--url") + 1], "http://127.0.0.1:3080/dsh-pixel-pet/reading/")
        self.assertEqual(argv[argv.index("--state") + 1], os.path.join(self.dir, "reading", "window.json"))
        self.assertEqual(argv[argv.index("--parent") + 1], str(os.getpid()))
        self.assertTrue(cwd.replace("\\", "/").endswith("/runtime"))

    def test_second_open_focuses_instead_of_spawning(self):
        self.host.open()
        self.assertEqual(self.host.open(), (True, "ok"))
        self.assertEqual(len(self.spawned), 1)
        self.assertEqual(self.focused, [1])

    def test_switch_off_closes_and_refuses(self):
        self.host.open()
        proc = self.spawned[0][2]
        self.cfg = {"reading": {"enabled": False}, "listen": {"python": self.py}}
        self.t[0] += 3
        self.host.tick()
        self.assertEqual(proc.terminated, 1)
        ok, msg = self.host.open()
        self.assertFalse(ok)
        self.assertIn("没有打开", msg)

    def test_user_closed_window_is_not_reopened(self):
        self.host.open()
        self.spawned[0][2].code = 0
        for _ in range(3):
            self.t[0] += 3
            self.host.tick()
        self.assertEqual(len(self.spawned), 1)
        self.assertFalse(self.host.running())

    def test_pet_quit_stops(self):
        self.host.open()
        self.host.stop()
        self.assertEqual(self.spawned[0][2].terminated, 1)

    def test_python_fallbacks_and_missing(self):
        own = os.path.join(self.dir, "own.exe")
        open(own, "w").close()
        self.assertEqual(RD.reading_python({"reading": {"python": own}, "listen": {"python": self.py}}, self.dir), own)
        self.assertEqual(RD.reading_python({"listen": {"python": self.py}}, self.dir), self.py)
        with open(os.path.join(self.dir, "listen.json"), "w", encoding="utf-8") as f:
            json.dump({"python": own}, f)
        self.assertEqual(RD.reading_python({}, self.dir), own)
        self.cfg = {"reading": {"enabled": True}}
        os.remove(own)
        ok, msg = self.host.open()
        self.assertFalse(ok)
        self.assertIn("Python", msg)

    def test_non_loopback_base_refused(self):
        self.host.base = "http://example.com/x"
        self.assertFalse(self.host.open()[0])

    def test_command_close_and_open(self):
        self.assertEqual(self.host.command({"op": "open"}), (True, "ok", None))
        self.assertEqual(self.host.command({"op": "close"}), (True, "ok", None))
        self.assertFalse(self.host.running())


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class MicHold(unittest.TestCase):
    """阅读窗录音 ↔ 桌宠输入条语音：录音时暂停免提监听，结束恢复；桌宠正在收音时阅读窗不录。"""

    def setUp(self):
        self.t = [100.0]
        self.pet = Pet(tempfile.mkdtemp())
        self.pet.hub = _Obj(m=_Obj(capturing=False))
        self.pet.mic = None
        self.pet.listener = object()
        self.host = RD.ReadingHost(self.pet, spawn=lambda a, c: Proc(), clock=lambda: self.t[0], settings=lambda: {})

    def test_hold_and_release(self):
        ok, _, _, data = self.host.command({"op": "mic", "on": True})
        self.assertTrue(ok)
        self.assertEqual(data, {"busy": False, "held": True})
        self.assertEqual(self.pet.reading_hold_until, 100.0 + RD.HOLD_S)
        self.assertEqual(self.host.command({"op": "mic", "on": False})[3], {"busy": False})
        self.assertEqual(self.pet.reading_hold_until, 0.0)

    def test_busy_while_the_pet_is_capturing(self):
        self.pet.hub.m.capturing = True
        self.assertEqual(self.host.command({"op": "mic", "on": True})[3], {"busy": True})
        self.assertFalse(getattr(self.pet, "reading_hold_until", 0.0))
        self.pet.hub.m.capturing = False
        self.pet.mic = _Obj(active=True)
        self.assertTrue(self.host.command({"op": "mic", "on": True})[3]["busy"])

    def test_pet_listener_paused_during_hold_and_resumed_after(self):
        """PetApp._tick_hub pauses the hands-free listener while reading_hold_until is in the future."""
        from pixelpet.app import PetApp
        paused = []
        listener = _Obj(set_playback_mode=lambda *a: None, pause=lambda on: paused.append(on))
        pet = _Obj(voice=_Obj(interruption_phase="", filter_microphone=None, can_barge_monitor=False), hub=None, listener=listener,
                   mic=None, inside=None, _hf_resume_at=0.0, voice_state="idle", _hf_listening=False, reading_hold_until=0.0)
        PetApp._tick_hub(pet, 50.0)
        pet.reading_hold_until = 120.0
        PetApp._tick_hub(pet, 60.0)
        PetApp._tick_hub(pet, 121.0)
        self.assertEqual(paused, [False, True, False])


if __name__ == "__main__":
    unittest.main()
