import unittest

import helpers  # noqa: F401

from pixelpet.state import FrameClock, choose_state, degrees_to_gaze, gaze_index, mood_lease, resolve

S = {k: {} for k in ("idle", "walk-left", "walk-right", "waving", "jumping", "failed", "waiting", "running",
                      "review", "lie", "attentive", "mood-happy", "drag-left")}


class ChooseState(unittest.TestCase):
    def test_priority_chain(self):
        now = 100.0
        full = dict(drag="drag-left", walk="walk-right", transient=("waving", now + 1), voice="thinking",
                    manual="failed", pose=("lie", None), mood=("mood-happy", now + 5), now=now)
        self.assertEqual(choose_state(S, **full), "drag-left")
        full["drag"] = None
        self.assertEqual(choose_state(S, **full), "walk-right")
        full["walk"] = None
        self.assertEqual(choose_state(S, **full), "waving")
        full["transient"] = ("waving", now - 1)          # expired
        self.assertEqual(choose_state(S, **full), "mood-happy")   # a live mood outranks voice thinking
        full["mood"] = None
        self.assertEqual(choose_state(S, **full), "running")      # voice thinking over a held pose
        full["mood"] = ("mood-happy", now + 5)
        full["voice"] = "idle"
        self.assertEqual(choose_state(S, **full), "failed")
        full["manual"] = "idle"
        self.assertEqual(choose_state(S, **full), "lie")
        full["pose"] = None
        self.assertEqual(choose_state(S, **full), "mood-happy")
        full["mood"] = ("mood-happy", now - 1)
        self.assertEqual(choose_state(S, **full), "idle")

    def test_pose_covers_listening_only(self):
        now = 10.0
        self.assertEqual(choose_state(S, voice="listening", pose=("lie", None), now=now), "lie")
        self.assertEqual(choose_state(S, voice="listening", now=now), "attentive")
        self.assertEqual(choose_state(S, voice="thinking", pose=("lie", None), now=now), "running")

    def test_listening_falls_back_when_missing(self):
        small = {k: {} for k in ("idle", "running")}
        self.assertEqual(choose_state(small, voice="listening", now=1), "idle")

    def test_unknown_states_ignored(self):
        self.assertEqual(choose_state(S, drag="drag-right", manual="nope", pose=("nope", None), now=1), "idle")

    def test_resolve(self):
        self.assertEqual(resolve(S, "work", {"work": "running"}), "running")
        self.assertIsNone(resolve(S, "x"))


class Clock(unittest.TestCase):
    def test_advances_with_durations(self):
        c = FrameClock()
        d = [100, 200, 300]
        self.assertEqual(c.tick("a", d, 0.0), 0)
        self.assertEqual(c.tick("a", d, 0.05), 0)
        self.assertEqual(c.tick("a", d, 0.11), 1)
        self.assertEqual(c.tick("a", d, 0.31), 2)
        self.assertEqual(c.tick("a", d, 0.61), 0)       # loops
        self.assertEqual(c.tick("b", d, 0.62), 0)       # state change restarts

    def test_no_loop_holds_last(self):
        c = FrameClock()
        d = [100, 100]
        c.tick("a", d, 0.0, loop=False)
        self.assertEqual(c.tick("a", d, 5.0, loop=False), 1)

    def test_reduced_pins_first_frame(self):
        c = FrameClock()
        self.assertEqual(c.tick("a", [100, 100], 0.0), 0)
        self.assertEqual(c.tick("a", [100, 100], 0.5, reduced=True), 0)


class Gaze(unittest.TestCase):
    def test_directions(self):
        self.assertEqual(gaze_index(0, -100), 0)
        self.assertEqual(gaze_index(100, 0), 4)
        self.assertEqual(gaze_index(0, 100), 8)
        self.assertEqual(gaze_index(-100, 0), 12)
        self.assertIsNone(gaze_index(3, 3))
        self.assertIsNone(gaze_index(5000, 0))

    def test_hysteresis(self):
        import math
        # 12° off "up" would round to 1 without hysteresis; holding 0 keeps it
        dx, dy = math.sin(math.radians(12)) * 100, -math.cos(math.radians(12)) * 100
        self.assertEqual(gaze_index(dx, dy, previous=0), 0)
        self.assertEqual(gaze_index(dx, dy), 1)

    def test_degrees(self):
        self.assertEqual(degrees_to_gaze(90), 4)
        self.assertEqual(degrees_to_gaze(-22.5), 15)


class Mood(unittest.TestCase):
    def test_lease(self):
        moods = {"开心": "mood-happy"}
        self.assertEqual(mood_lease(moods, {"tag": "开心", "seq": 1, "until": 20}, now=10), ("mood-happy", 20, 1))
        self.assertIsNone(mood_lease(moods, {"tag": "开心", "seq": 1, "until": 20}, seen_seq=1, now=10))
        self.assertIsNone(mood_lease(moods, {"tag": "未知", "seq": 2, "until": 20}, now=10))
        self.assertIsNone(mood_lease(moods, {"tag": "开心", "seq": 2, "until": 5}, now=10))
        self.assertEqual(mood_lease(moods, {"tag": "开心", "seq": 3, "until": 999}, now=10)[1], 40)


if __name__ == "__main__":
    unittest.main()
