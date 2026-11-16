"""「日历与日记」：台历家具的 feature 闸（furniture.py）与点击 glue（calendardock.py）。纯逻辑，不跑 UI。"""
import unittest

from helpers import ROOT
from pixelpet import furniture as FU
from pixelpet import calendardock as CD


class Gate(unittest.TestCase):
    def test_calendar_feature_gate(self):
        cfg_on = {"calendar": {"enabled": True}}
        cfg_off = {"calendar": {"enabled": False}}
        defn = {"feature": "calendar"}
        self.assertTrue(FU.gate_open(defn, None))          # 无 cfg 不闸
        self.assertTrue(FU.gate_open(defn, cfg_on))
        self.assertFalse(FU.gate_open(defn, cfg_off))
        self.assertFalse(FU.gate_open({"feature": "reading"}, cfg_on))  # reading 的闸看 reading.enabled
        self.assertTrue(FU.gate_open({"feature": "reading"}, {"reading": {"enabled": True}}))

    def test_sync_sig_reflects_calendar_gate(self):
        cfg = {"calendar": {"enabled": True}}
        sig1 = FU.sync_sig({}, cfg)
        cfg["calendar"]["enabled"] = False
        self.assertNotEqual(sig1, FU.sync_sig({}, cfg))    # 闸变化要触发家具重摆


class DeskCalendarGlue(unittest.TestCase):
    def test_options_defaults_and_pack_block(self):
        self.assertEqual(CD.options({}), {"openState": "open"})
        self.assertEqual(CD.options({"calendar": {"openState": "idle"}}), {"openState": "idle"})
        self.assertEqual(CD.options({"calendar": {"openState": 42}}), {"openState": "open"})  # 类型不对回默认

    def test_open_calendar_without_base(self):
        ok, msg = CD.open_calendar(None)
        self.assertFalse(ok)
        self.assertTrue(msg)

    def test_open_calendar_posts_and_parses(self):
        calls = []

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"ok": true, "message": ""}'

        seen = {}

        def fake_urlopen(req, timeout):
            seen["url"] = req.get_full_url()
            seen["timeout"] = timeout
            return FakeResp()

        orig = CD.urllib.request.urlopen
        CD.urllib.request.urlopen = fake_urlopen
        try:
            ok, msg = CD.open_calendar("http://127.0.0.1:3080/dsh-pixel-pet", 1.5)
        finally:
            CD.urllib.request.urlopen = orig
        self.assertTrue(ok)
        self.assertEqual(msg, "")
        self.assertTrue(seen["url"].endswith("/api/calendar/open"))
        self.assertEqual(seen["timeout"], 1.5)

    def test_open_calendar_failure_degrades(self):
        def fake_urlopen(req, timeout):
            raise OSError("boom")

        orig = CD.urllib.request.urlopen
        CD.urllib.request.urlopen = fake_urlopen
        try:
            ok, msg = CD.open_calendar("http://127.0.0.1:3080/dsh-pixel-pet")
        finally:
            CD.urllib.request.urlopen = orig
        self.assertFalse(ok)
        self.assertEqual(msg, CD.NOT_READY)


if __name__ == "__main__":
    unittest.main()
