import os
import time
import unittest

from helpers import ROOT  # noqa: F401  (puts runtime/ on sys.path)
from pixelpet.state import choose_state


class ActivityStateTest(unittest.TestCase):
    S = {k: {} for k in ("idle", "running", "waiting", "review", "failed", "listening", "attentive", "mood-happy")}

    def test_hearing_shows_listening(self):
        self.assertEqual(choose_state(self.S, voice="hearing"), "listening")
        self.assertEqual(choose_state({"idle": {}, "attentive": {}}, voice="hearing"), "attentive")

    def test_manual_activity_states(self):
        for sid in ("running", "waiting", "failed"):
            self.assertEqual(choose_state(self.S, manual=sid), sid)
        self.assertEqual(choose_state(self.S, manual="running", mood=("mood-happy", time.time() + 5)), "running")
        self.assertEqual(choose_state(self.S, manual="waiting", voice="speaking"), "waiting")


class FailureLineTest(unittest.TestCase):
    """Entering `failed` speaks settings.voice.failure.reply once; repeats inside the hold stay quiet."""

    def _app(self, failure):
        from pixelpet.app import PetApp
        import threading
        spoken = []
        app = PetApp.__new__(PetApp)
        app.char = type("C", (), {"states": {"failed": {}, "idle": {}}})()
        app.manual, app._manual_until = "idle", None
        app.cfg = {"voice": {"failure": failure}}
        app.voice = type("V", (), {"speak": lambda self, t: spoken.append(t)})()
        orig = threading.Thread
        class Now:
            def __init__(self, target, args=(), daemon=None): self.f, self.a = target, args
            def start(self): self.f(*self.a)
        threading.Thread = Now
        self.addCleanup(setattr, threading, "Thread", orig)
        return app, spoken

    def test_speaks_once_per_failure(self):
        app, spoken = self._app({"enabled": True, "reply": "糟糕"})
        app.set_activity("failed"); app.set_activity("failed")
        self.assertEqual(spoken, ["糟糕"])
        app.set_activity("idle"); app.set_activity("failed")
        self.assertEqual(spoken, ["糟糕", "糟糕"])

    def test_disabled_or_blank_is_silent(self):
        for f in ({"enabled": False, "reply": "糟糕"}, {"enabled": True, "reply": "  "}):
            app, spoken = self._app(f)
            app.set_activity("failed")
            self.assertEqual(spoken, [])


class ClassifyTest(unittest.TestCase):
    """activity.classify: foreground {process, class, video_hint} + idle + fullscreen + running process names."""

    def c(self, process, idle=0.0, fs=False, hint=False, cls="X", running=(), learned=None):
        from pixelpet import activity as A
        return A.classify({"process": process, "class": cls, "video_hint": hint}, idle, fs, running, learned)

    def test_meeting(self):
        for p in ("wemeetapp.exe", "ms-teams.exe", "teams.exe", "zoom.exe", "feishu.exe", "lark.exe", "dingtalk.exe"):
            self.assertEqual(self.c(p), "meeting", p)
        self.assertEqual(self.c("zoom.exe", fs=True), "meeting")

    def test_video_needs_player_or_browser_hint_plus_idle_or_fullscreen(self):
        self.assertEqual(self.c("chrome.exe", hint=True), "browsing")          # flipping through bilibili
        self.assertEqual(self.c("chrome.exe", hint=True, idle=25), "video")
        self.assertEqual(self.c("chrome.exe", hint=True, fs=True), "video")
        self.assertEqual(self.c("chrome.exe", idle=25), "browsing")            # no hint
        self.assertEqual(self.c("chrome.exe", fs=True), "browsing")            # F11 page, no hint
        self.assertEqual(self.c("vlc.exe", fs=True), "video")
        # a title hint in a non-video process is ignored
        self.assertEqual(self.c("wps.exe", hint=True, idle=25), "work")
        self.assertEqual(self.c("wechat.exe", hint=True, idle=25), "browsing")
        for p in ("wps.exe", "et.exe", "wpp.exe"):
            self.assertEqual(self.c(p), "work", p)

    def test_fullscreen_branch_is_live(self):
        self.assertEqual(self.c("unknown-game.exe", fs=True), "gaming")
        self.assertEqual(self.c("unknown-game.exe"), "browsing")
        self.assertEqual(self.c("code.exe", fs=True), "work")
        self.assertEqual(self.c("explorer.exe", fs=True), "other")

    def test_game_list(self):
        from pixelpet import activity as A
        self.assertEqual(self.c("genshinimpact.exe"), "gaming")
        self.assertEqual(self.c("x.exe", cls="UnityWndClass"), "gaming")
        for bad in ("steamwebhelper.exe", "steam.exe", "epicgameslauncher.exe", "d3d11.exe", "unityplayer.exe",
                    "unrealengine.exe"):
            self.assertNotIn(bad, A.GAME_PROCESSES)
            self.assertNotEqual(self.c(bad), "gaming", bad)

    def test_background_game_and_learned(self):
        self.assertEqual(self.c("wechat.exe", running={"genshinimpact.exe"}), "gaming_break")
        self.assertEqual(self.c("code.exe", running={"genshinimpact.exe"}), "work")
        self.assertEqual(self.c("mygame.exe", learned={"mygame.exe": "gaming"}), "gaming")
        self.assertEqual(self.c("chrome.exe", learned={"chrome.exe": "work"}), "work")
        self.assertEqual(self.c("wechat.exe", running={"mygame.exe"}, learned={"mygame.exe": "gaming"}), "gaming_break")
        self.assertEqual(self.c("x.exe", learned={"x.exe": "bogus"}), "browsing")
        self.assertEqual(self.c("code.exe", idle=700), "away")
        self.assertEqual(self.c("chrome.exe", hint=True, idle=700, fs=True), "video")


class StoreTest(unittest.TestCase):
    def test_learned_file_hot_reload(self):
        import json
        import os
        from helpers import tmpdir
        from pixelpet import activity as A
        d = tmpdir()
        L = A.Learned(d)
        self.assertEqual(L.get(), {})
        with open(os.path.join(d, "activity.json"), "w", encoding="utf-8") as f:
            json.dump({"learned": {"MyGame.exe": "gaming", "x.exe": "nope"}}, f)
        self.assertEqual(L.get(), {"mygame.exe": "gaming"})

    def test_log_rows_and_seven_day_rotation(self):
        import datetime
        import json
        import os
        from helpers import tmpdir
        from pixelpet import activity as A
        d = tmpdir()
        tz = datetime.timezone(datetime.timedelta(hours=8))
        now = [datetime.datetime(2026, 11, 14, 20, 10, tzinfo=tz)]
        path = os.path.join(d, A.LOG_NAME)
        old = datetime.datetime(2026, 11, 6, 9, 0, tzinfo=tz).isoformat()
        keep = datetime.datetime(2026, 11, 8, 9, 0, tzinfo=tz).isoformat()
        other = os.path.join(d, "other.jsonl")
        with open(other, "w", encoding="utf-8") as f:
            f.write("x\n")
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"t": old, "state": "work", "app": "a.exe", "dur": 0}) + "\n")
            f.write(json.dumps({"t": keep, "state": "video", "app": "b.exe", "dur": 0}) + "\n")
            f.write("garbage\n")
        log = A.ActivityLog(d, clock=lambda: now[0])
        self.assertTrue(log.write("gaming", "C:\\Games\\GenshinImpact.exe", 26.4))
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(x) for x in f if x.strip()]
        self.assertEqual([r["t"] for r in rows], [keep, "2026-11-14T20:10:00+08:00"])
        self.assertEqual(rows[-1], {"t": "2026-11-14T20:10:00+08:00", "state": "gaming", "app": "genshinimpact.exe", "dur": 26})
        for r in rows:
            self.assertEqual(set(r), {"t", "state", "app", "dur"})
        self.assertTrue(os.path.exists(other))                     # only its own file is touched
        self.assertFalse(log.write("bogus", "x.exe"))


class WindowPrivacyTest(unittest.TestCase):
    """window.foreground_app compares the title inside and returns only {process, class, video_hint}."""

    def _fake(self, title):
        import ctypes

        def setv(ref, v):
            ref._obj.value = v

        class U:
            def GetForegroundWindow(self):
                return 77

            def GetWindowThreadProcessId(self, hwnd, ref):
                setv(ref, 4242)

            def GetClassNameW(self, hwnd, buf, n):
                buf.value = "Chrome_WidgetWin_1"

            def GetWindowTextLengthW(self, hwnd):
                return len(title)

            def GetWindowTextW(self, hwnd, buf, n):
                buf.value = title

        class K:
            def OpenProcess(self, *a):
                return 9

            def QueryFullProcessImageNameW(self, h, f, buf, size):
                buf.value = "C:\\Users\\secret\\Chrome.exe"
                return 1

            def CloseHandle(self, h):
                return 1
        return type("W", (), {"user32": U(), "kernel32": K()})()

    @unittest.skipUnless(os.name == "nt", "Windows only")
    def test_no_title_no_exe(self):
        import ctypes
        from unittest import mock
        from pixelpet import window as W
        for title, hint in (("秘密合同.docx - 哔哩哔哩 - Google Chrome", True), ("银行 - Google Chrome", False)):
            with mock.patch.object(ctypes, "windll", self._fake(title)):
                r = W.foreground_app()
            self.assertEqual(r, {"process": "chrome.exe", "class": "Chrome_WidgetWin_1", "video_hint": hint})
            self.assertNotIn("title", r)
            self.assertNotIn("exe", r)
            self.assertFalse(any("秘密" in str(v) or "secret" in str(v) for v in r.values()))

    def test_debug_log_is_rate_limited_and_type_only(self):
        from pixelpet import window as W
        with self.assertLogs("pixelpet.window", level="DEBUG") as cm:
            W._debug_at.pop("t.where", None)
            W._debug("t.where", ValueError("窗口标题：秘密"))
            W._debug("t.where", ValueError("窗口标题：秘密"))
            import logging
            logging.getLogger("pixelpet.window").debug("sentinel")
        self.assertEqual(len([x for x in cm.output if "t.where" in x]), 1)
        self.assertTrue(all("秘密" not in x for x in cm.output))
        self.assertIn("ValueError", cm.output[0])


if __name__ == "__main__":
    unittest.main()
