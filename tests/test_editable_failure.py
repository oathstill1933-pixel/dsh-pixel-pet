"""Editable failure lines: isolated cfg, fake voice, no Tk/audio/SV models or user data."""
import json
import os
import queue
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from helpers import ROOT  # noqa: F401 - runtime on sys.path
from pixelpet.app import PetApp, load_settings


class FakeVoice:
    def __init__(self, result=None, exc=None):
        self._turn = 0
        self.calls = []
        self.interrupts = []
        self.barge = []
        self.closed = 0
        self.result = result
        self.exc = exc
        self.after_speak = None

    def speak(self, text):
        self._turn += 1
        self.calls.append(text)
        if self.after_speak:
            self.after_speak()
        if self.exc:
            raise self.exc
        return self.result

    def configure_interrupt(self, value):
        self.interrupts.append(value)

    def set_barge_listening(self, on):
        self.barge.append(on)

    def close(self):
        self.closed += 1
        self._turn += 1

    def status(self):
        return {"lastError": None}


class EditableFailureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pixelpet-editable-failure-")
        self.addCleanup(self.temp.cleanup)
        self.mtime = 1700000000000000000
        self.workers = []
        workers = self.workers

        class Thread:
            def __init__(self, target, args=(), daemon=None):
                self.target, self.args = target, args

            def start(self):
                workers.append(lambda: self.target(*self.args))

        self.thread_patch = patch("pixelpet.app.threading.Thread", Thread)
        self.thread_patch.start()
        self.addCleanup(self.thread_patch.stop)

    def save(self, **voice):
        path = os.path.join(self.temp.name, "settings.json")
        with open(path, "w", encoding="utf-8") as stream:
            json.dump({"voice": voice}, stream)
        self.mtime += 1000000000
        os.utime(path, ns=(self.mtime, self.mtime))

    def app(self, voice=None):
        app = PetApp.__new__(PetApp)
        app.data_dir = self.temp.name
        app.cfg = load_settings(app.data_dir)
        app.size = app.cfg["size"]
        app._cfg_mtime = None
        app._closed = False
        app._ui_queue = queue.SimpleQueue()
        app._own_voice = True
        app._voice_sig = app._engine_signature()
        app.voice = voice or FakeVoice()
        app.last_failure_error = None
        app.listener = None
        app.hub = None
        app.inside = None
        app.manual, app._manual_until = "idle", None
        app.char = SimpleNamespace(states={"idle": {}, "failed": {}})
        app.gate_closes, app.syncs, app.rebuilds = [], [], []
        app.voiceprint = SimpleNamespace(enabled=False)
        app._close_voiceprint = lambda: app.gate_closes.append(True)
        app.sync_furniture = lambda: app.syncs.append(True)
        app.set_listening = lambda on: self.fail("must not reset microphone")
        app._set_tts_idle = lambda: None
        app._make_voice = lambda: (app.rebuilds.append(True) or FakeVoice())
        app.messages = []
        app.bubble = SimpleNamespace(show=lambda *args: app.messages.append(args))
        return app

    def run_workers(self):
        while self.workers:
            self.workers.pop(0)()

    def fail_and_drain(self, app):
        app.set_activity("failed")
        self.run_workers()
        app._drain()

    def test_latest_custom_line_and_failure_dedup(self):
        self.save(failure={"enabled": True, "reply": " 新台词 "})
        app = self.app()
        app.set_activity("failed")
        app.set_activity("failed")
        self.run_workers()
        self.assertEqual(app.voice.calls, ["新台词"])
        app.set_activity("idle")
        self.fail_and_drain(app)
        self.assertEqual(app.voice.calls, ["新台词", "新台词"])

    def test_first_tick_save_race_reads_latest_without_bridge_rebuild(self):
        self.save(failure={"reply": "旧"}, interruption={"reply": "旧回应"})
        app = self.app()
        old = app.voice
        self.save(failure={"reply": "首轮新台词"}, interruption={"reply": "请讲"})
        app._hot_reload()
        self.assertEqual(app.cfg["voice"]["failure"]["reply"], "首轮新台词")
        self.assertIs(app.voice, old)
        self.assertEqual(app.rebuilds, [])
        self.assertEqual(old.interrupts[-1], {"reply": "请讲"})
        self.assertTrue(app.gate_closes, "first reload must retain safety-gate close")
        self.fail_and_drain(app)
        self.assertEqual(old.calls, ["首轮新台词"])

    def test_normal_reload_and_same_mtime_noop(self):
        self.save(failure={"reply": "旧"})
        app = self.app()
        app._hot_reload()
        syncs = len(app.syncs)
        app._hot_reload()
        self.assertEqual(len(app.syncs), syncs)
        self.save(failure={"reply": "后续新台词"}, interruption={"enabled": False, "reply": ""})
        app._hot_reload()
        self.fail_and_drain(app)
        self.assertEqual(app.voice.calls, ["后续新台词"])
        self.assertEqual(app.rebuilds, [])

    def test_failure_before_tick_synchronizes_latest_settings(self):
        self.save(failure={"reply": "旧"})
        app = self.app()
        app._hot_reload()
        self.save(failure={"reply": "同 tick 新台词"})
        self.fail_and_drain(app)
        self.assertEqual(app.voice.calls, ["同 tick 新台词"])

    def test_first_reload_engine_change_rebuilds_only_once(self):
        self.save(tts={"engine": "fake-a"})
        app = self.app()
        old = app.voice
        self.save(tts={"engine": "fake-b"})
        app._hot_reload()
        self.run_workers()
        self.assertEqual(app.rebuilds, [True])
        self.assertEqual(old.closed, 1)
        app._hot_reload()
        self.assertEqual(app.rebuilds, [True])

    def test_malformed_settings_keeps_fail_closed_marker(self):
        self.save(failure={"reply": "旧"})
        app = self.app()
        path = os.path.join(app.data_dir, "settings.json")
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("{unreadable")
        self.mtime += 1000000000
        os.utime(path, ns=(self.mtime, self.mtime))
        app._hot_reload()
        self.assertTrue(app.cfg["_voiceprintConfigError"])
        self.assertTrue(app.gate_closes)
        with open(path, encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "{unreadable")

    def test_return_error_reports_only_on_ui_and_retains_diagnostic(self):
        self.save(failure={"reply": "报错台词"})
        app = self.app(FakeVoice(result={"error": "fake synth failed"}))
        app.set_activity("failed")
        self.run_workers()
        self.assertEqual(app.messages, [])
        self.assertIsNone(app.last_failure_error)
        app._drain()
        self.assertIn("fake synth failed", app.messages[0][0])
        self.assertEqual(app.last_failure_error, "fake synth failed")
        self.assertEqual(app.voice_cmd({"action": "status"})[3]["lastFailureError"], "fake synth failed")
        app.set_activity("failed")
        self.run_workers()
        self.assertEqual(len(app.voice.calls), 1, "text error must not recursively synthesize")

    def test_raise_reports_error_without_recursive_speech(self):
        self.save(failure={"reply": "报错台词"})
        app = self.app(FakeVoice(exc=RuntimeError("fake exception")))
        self.fail_and_drain(app)
        self.assertEqual(app.last_failure_error, "RuntimeError: fake exception")
        self.assertEqual(len(app.messages), 1)
        self.assertEqual(len(app.voice.calls), 1)

    def test_cancelled_or_interrupted_error_is_not_failure(self):
        for key in ("cancelled", "interrupted"):
            with self.subTest(key=key):
                self.save(failure={"reply": "报错台词"})
                app = self.app(FakeVoice(result={key: True, "error": "must not show"}))
                self.fail_and_drain(app)
                self.assertEqual(app.messages, [])
                self.assertIsNone(app.last_failure_error)
                self.assertEqual(len(app.voice.calls), 1, "do not replay cancelled line")

    def test_stale_bridge_or_turn_during_speech_is_not_reported(self):
        for change in ("bridge", "turn"):
            with self.subTest(change=change):
                self.save(failure={"reply": "报错台词"})
                voice = FakeVoice(result={"error": "stale"})
                app = self.app(voice)
                def supersede():
                    if change == "bridge":
                        app.voice = FakeVoice()
                    else:
                        voice._turn += 1
                voice.after_speak = supersede
                self.fail_and_drain(app)
                self.assertEqual(app.messages, [])
                self.assertIsNone(app.last_failure_error)

    def test_stale_queued_ui_result_does_not_show(self):
        for change in ("bridge", "turn", "closed"):
            with self.subTest(change=change):
                self.save(failure={"reply": "报错台词"})
                app = self.app(FakeVoice(result={"error": "late UI"}))
                app.set_activity("failed")
                self.run_workers()
                if change == "bridge":
                    app.voice = FakeVoice()
                elif change == "turn":
                    app.voice._turn += 1
                else:
                    app._closed = True
                app._drain()
                self.assertEqual(app.messages, [])
                self.assertIsNone(app.last_failure_error)

    def test_delayed_worker_does_not_replace_new_turn(self):
        self.save(failure={"reply": "报错台词"})
        app = self.app()
        app.set_activity("failed")
        app.voice._turn += 1
        self.run_workers()
        self.assertEqual(app.voice.calls, [])
        self.assertEqual(app.voice._turn, 1)

    def test_disabled_or_blank_is_silent_even_after_save(self):
        for failure in ({"enabled": False, "reply": "不该说"}, {"enabled": True, "reply": "  "}):
            with self.subTest(failure=failure):
                self.save(failure={"reply": "旧"})
                app = self.app()
                self.save(failure=failure)
                self.fail_and_drain(app)
                self.assertEqual(app.voice.calls, [])
                self.assertEqual(app.messages, [])
                self.assertEqual(app.rebuilds, [])

    def test_real_bridge_guard_contract_is_used_and_rejection_stays_silent(self):
        self.save(failure={"reply": "报错台词"})
        voice = FakeVoice(result={"error": "must not synthesize"})
        guarded_calls = []
        def guarded(text, expected):
            guarded_calls.append((text, expected))
            # Simulate a new user turn arriving after app's precheck but before bridge ownership check.
            voice._turn += 1
            return {"cancelled": True, "turn": expected}
        voice.speak_if_current = guarded
        app = self.app(voice)
        self.fail_and_drain(app)
        self.assertEqual(guarded_calls, [("报错台词", 0)])
        self.assertEqual(voice.calls, [])
        self.assertEqual(app.messages, [])
        self.assertIsNone(app.last_failure_error)

    def test_ui_names_scope_session_failure(self):
        with open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8") as stream:
            html = stream.read()
        self.assertIn("会话报错台词", html)
        self.assertIn("仅会话进入失败状态时播放，不含所有识别或合成错误", html)


if __name__ == "__main__":
    unittest.main()
