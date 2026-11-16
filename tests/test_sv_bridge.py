# -*- coding: utf-8 -*-
"""声纹闸在 VoiceBridge 里的接线测试（用 stub STT/TTS/LLM + 可控的假校验器，不录音）。

要证明的四件事：
  1. 拒绝的段**不进 STT**、不切 thinking、不取消正在进行的回合；
  2. 拒绝的追问回到 waiting，不推进回合；
  3. 打断探测用宽松档，拒绝时不暂停；
  4. 校验器抛异常 = 拒绝（fail-closed），开关关着 = 直通。
"""
import os
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "runtime"))

from helpers import tmpdir  # noqa: E402
from pixelpet.voice.bridge import VoiceBridge  # noqa: E402
from pixelpet.voice.llm import StubLlm  # noqa: E402
from pixelpet.voice.stt import StubStt  # noqa: E402
from pixelpet.voice.tts import StubTts  # noqa: E402

PCM = b"\x00\x00" * 16000


class CountingStt(StubStt):
    """StubStt 本身会记录 calls（每次调用一条）；这里只加一个独立的计数器方便断言。"""

    def __init__(self, text="你好"):
        super().__init__(text)
        self.count = 0

    def transcribe(self, pcm, sample_rate=16000):
        self.count += 1
        return super().transcribe(pcm, sample_rate)


class FakeVerifier:
    """可控的声纹闸：mode -> 是否通过。"""

    def __init__(self, strict_ok=True, loose_ok=True, boom=False):
        self.strict_ok, self.loose_ok, self.boom = strict_ok, loose_ok, boom
        self.calls = []
        self.last = None

    def verify(self, pcm, rate=16000, mode="strict"):
        self.calls.append(mode)
        self.last = "pass" if self.strict_ok else "reject"
        if self.boom:
            raise RuntimeError("模型炸了")
        ok = self.strict_ok if mode == "strict" else self.loose_ok
        return {"ok": ok, "reason": "ok" if ok else "strict", "sim": .5, "self_sim": None,
                "self_ready": False, "slot": -1, "mode": mode, "ms": 5, "echo": "missing"}

    def summary(self):
        return {"enabled": True, "enrolled": 1, "last": self.last}


class Rec:
    def __init__(self):
        self.states, self.played, self.stops = [], [], 0
        self.rearms = 0

    def on_state(self, s):
        self.states.append(s)

    def play(self, path):
        self.played.append(path)

    def stop(self):
        self.stops += 1

    def rearm(self):
        self.rearms += 1


def build(data, sv=None, stt=None, rec=None, llm=None):
    rec = rec or Rec()
    stt = stt or CountingStt()
    b = VoiceBridge(stt, StubTts(data), llm or StubLlm(), play=rec.play, stop=rec.stop,
                    on_state=rec.on_state, on_barge_rearm=rec.rearm, sv=sv)
    return b, rec, stt


class HearGate(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def test_rejected_segment_never_reaches_stt(self):
        sv = FakeVerifier(strict_ok=False)
        b, rec, stt = build(self.data, sv=sv)
        b.listen()
        out = b.hear(PCM, 16000)
        self.assertTrue(out.get("rejected"))
        self.assertEqual(out.get("heard"), "")
        self.assertEqual(stt.count, 0, "被拒的段不许进 STT（也省下 DSH 识别服务）")
        self.assertEqual(b.state, "listening", "拒绝不能切 thinking，也不能把 listening 打断")
        self.assertEqual(rec.states, ["listening"])
        self.assertEqual(sv.calls, ["strict"])

    def test_rejection_does_not_cancel_a_running_turn(self):
        gate, started = threading.Event(), threading.Event()

        def slow(t):
            started.set()
            gate.wait(3)
            return "迟到的回复"
        sv = FakeVerifier(strict_ok=False)
        b, rec, stt = build(self.data, sv=sv, llm=StubLlm(slow))
        box = {}
        th = threading.Thread(target=lambda: box.update(b.ask_text("x")))
        th.start()
        self.assertTrue(started.wait(3))
        turn_before = b._turn
        stops_before = rec.stops
        denied = b.hear(PCM, 16000)
        self.assertTrue(denied.get("rejected"))
        self.assertEqual(b._turn, turn_before, "拒绝不许推进/取消当前回合")
        self.assertEqual(rec.stops, stops_before, "拒绝不许 stop_play")
        gate.set()
        th.join(3)
        self.assertIn("reply", box)

    def test_accepted_segment_proceeds(self):
        sv = FakeVerifier(strict_ok=True)
        b, rec, stt = build(self.data, sv=sv)
        b.listen()
        out = b.hear(PCM, 16000)
        self.assertEqual(out.get("heard"), "你好")
        self.assertEqual(stt.count, 1)
        self.assertIn("thinking", rec.states)

    def test_disabled_verifier_passes_through(self):
        class Off:
            def verify(self, pcm, rate=16000, mode="strict"):
                return {"ok": True, "reason": "disabled"}
        b, rec, stt = build(self.data, sv=Off())
        self.assertEqual(b.hear(PCM, 16000).get("heard"), "你好")

    def test_verifier_exception_is_rejection(self):
        sv = FakeVerifier(boom=True)
        b, rec, stt = build(self.data, sv=sv)
        out = b.hear(PCM, 16000)
        self.assertTrue(out.get("rejected"))
        self.assertEqual(out.get("reason"), "model-error")
        self.assertEqual(stt.count, 0)

    def test_no_verifier_keeps_old_behaviour(self):
        b, rec, stt = build(self.data, sv=None)
        self.assertEqual(b.hear(PCM, 16000).get("heard"), "你好")
        self.assertIsNone(b.status().get("voiceprint"))


class FollowupGate(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def _speaking_bridge(self, sv):
        playing, stopped = threading.Event(), threading.Event()

        def play(path):
            playing.set()
            stopped.wait(3)
        b = VoiceBridge(StubStt("你好"), StubTts(self.data), StubLlm(lambda t: "第一句。第二句。第三句。"),
                        play=play, stop=stopped.set, sv=sv)
        box = {}
        th = threading.Thread(target=lambda: box.update(b.ask_text("x")))
        th.start()
        self.assertTrue(playing.wait(3))
        # 直接把状态摆到「等追问」，避免依赖 TTS/播放的时序
        with b._cv:
            b._speech.phase = "waiting"
            b._speech.deadline = time.monotonic() + 5
            b._speech.utterance_at = None
        return b, th, stopped, box

    def test_rejected_followup_returns_to_waiting(self):
        sv = FakeVerifier(strict_ok=False)
        b, th, stopped, box = self._speaking_bridge(sv)
        calls_before = len(b.stt.calls)
        out = b.hear_followup(PCM, 16000)
        self.assertTrue(out.get("rejected"))
        self.assertEqual(out.get("heard"), "")
        self.assertEqual(b._speech.phase, "waiting", "拒绝的追问要退回等待态继续听")
        self.assertTrue(out.get("resumed"))
        self.assertEqual(len(b.stt.calls), calls_before, "拒绝的追问不许进 STT")
        stopped.set()
        th.join(3)

    def test_accepted_followup_advances(self):
        sv = FakeVerifier(strict_ok=True)
        b, th, stopped, box = self._speaking_bridge(sv)
        out = b.hear_followup(PCM, 16000)
        self.assertEqual(out.get("heard"), "你好")
        self.assertNotIn("rejected", out)
        stopped.set()
        th.join(3)


class InterruptGate(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def _bridge(self, sv):
        playing, stopped = threading.Event(), threading.Event()
        b = VoiceBridge(StubStt("你好"), StubTts(self.data), StubLlm(lambda t: "第一句。"),
                        play=lambda p: playing.set(), stop=stopped.set, sv=sv)
        b._sv_stopped = stopped
        b.speak("第一句。第二句。第三句。")   # 只是为了让 _turn/_speech 处于播放态
        return b

    def _bridge_idle_with_speech(self, sv):
        """摆一个「正在播放」的 speech（不跑真实播放，专测打断闸）。"""
        b = self._bridge(sv)
        from types import SimpleNamespace
        s = SimpleNamespace(turn=b._turn, parts=["一。", "二。"], index=0, current="一。", offset=0.,
                            duration=3., started=0., paused=False, phase="playing", pause_seq=0,
                            deadline=0., utterance_at=None, cancelled=False, superseded=False, phase_at=0.)
        b._speech = s
        b._last_probe = -10.
        return b, s

    def test_loose_mode_used_and_rejection_does_not_pause(self):
        sv = FakeVerifier(strict_ok=False, loose_ok=False)
        b, s = self._bridge_idle_with_speech(sv)
        self.assertTrue(b.request_interrupt(PCM, 16000))
        for _ in range(40):
            if not b._probe_busy and sv.calls:
                break
            time.sleep(.05)
        self.assertEqual(sv.calls, ["loose"], "打断必须走宽松档，不能拿严格档去卡双讲")
        self.assertFalse(s.paused, "被拒的打断不许暂停播放")
        self.assertEqual(b._turn, s.turn)

    def test_accepted_interrupt_pauses(self):
        sv = FakeVerifier(strict_ok=False, loose_ok=True)
        b, s = self._bridge_idle_with_speech(sv)
        self.assertTrue(b.request_interrupt(PCM, 16000))
        for _ in range(40):
            if s.paused:
                break
            time.sleep(.05)
        self.assertTrue(s.paused, "通过校验的近端说话应该能打断")


class StatusLeak(unittest.TestCase):
    def test_status_summary_has_no_names_or_scores(self):
        b, rec, stt = build(tmpdir(), sv=FakeVerifier())
        vp = b.status()["voiceprint"]
        self.assertEqual(set(vp.keys()), {"enabled", "enrolled", "last"})
        self.assertEqual(vp["enrolled"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
