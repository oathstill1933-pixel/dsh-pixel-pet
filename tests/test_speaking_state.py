import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime"))
from pixelpet.state import choose_state  # noqa: E402


class SpeakingStateTest(unittest.TestCase):
    def test_uses_speaking_when_present(self):
        self.assertEqual(choose_state({"idle": 1, "speaking": 1}, voice="speaking"), "speaking")

    def test_falls_back_to_idle(self):
        self.assertEqual(choose_state({"idle": 1}, voice="speaking"), "idle")

    def test_mood_lease_wins_while_speaking_or_thinking(self):
        import time
        st = {"idle": 1, "speaking": 1, "running": 1, "mood-happy": 1}
        lease = ("mood-happy", time.time() + 5)
        self.assertEqual(choose_state(st, voice="speaking", mood=lease), "mood-happy")
        self.assertEqual(choose_state(st, voice="thinking", mood=lease), "mood-happy")
        self.assertEqual(choose_state(st, voice="speaking"), "speaking")


if __name__ == "__main__":
    unittest.main()
