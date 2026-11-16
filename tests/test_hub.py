"""Hub bar: state rules (fold / draft / auto-collapse), placement (bar under the pet, chip beside it),
VAD end-of-speech, screenshots, the upload + ask route and the bridge's images / speak switches. Tk passes
drive the real HubBar and the pet's listening switch when a display is available."""
import array
import io
import math
import unittest

from helpers import ROOT, make_character, tmpdir  # noqa: F401  (puts runtime/ on sys.path)

from pixelpet import capture
from pixelpet.hub import DEFAULT_HUB, MAX_SHOTS, HubModel, hub_cfg, place_beside, place_under
from pixelpet.voice import VoiceError
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.llm import SessionRoute, StubLlm
from pixelpet.voice.stt import StubStt
from pixelpet.voice.tts import StubTts
from pixelpet.voice.vad import Listener, Vad


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def tone(seconds, amp, rate=16000):
    n = int(seconds * rate)
    a = array.array("h", (int(amp * math.sin(i * 0.3)) for i in range(n)))
    return a.tobytes()


def chunks(pcm, size=3200):
    return [pcm[i:i + size] for i in range(0, len(pcm), size)]


# ------------------------------------------------------------------------------------------ state
class Model(unittest.TestCase):
    def test_starts_collapsed_and_folding_keeps_draft(self):
        m = HubModel(20, clock=Clock())
        self.assertTrue(m.collapsed)
        m.expand()
        m.set_draft("还没写完")
        m.add_shot({"png": b"1"})
        m.collapse()
        self.assertTrue(m.collapsed)
        self.assertEqual(m.draft, "还没写完")
        self.assertEqual(len(m.shots), 1)
        self.assertTrue(m.has_draft)
        self.assertFalse(m.toggle())
        self.assertEqual(m.draft, "还没写完")

    def test_auto_collapse_after_idle(self):
        c = Clock()
        m = HubModel(20, clock=c)
        m.expand()
        c.t += 19.9
        self.assertFalse(m.should_autocollapse())
        m.set_draft("x")                       # typing counts as activity
        c.t += 19.9
        self.assertFalse(m.should_autocollapse())
        c.t += 0.2
        self.assertTrue(m.should_autocollapse())

    def test_auto_collapse_waits_while_busy_and_can_be_off(self):
        c = Clock()
        m = HubModel(5, clock=c)
        m.expand()
        c.t += 60
        for flag in ("sending", "listening", "capturing"):
            setattr(m, flag, True)
            self.assertFalse(m.should_autocollapse(), flag)
            setattr(m, flag, False)
        self.assertTrue(m.should_autocollapse())
        m.auto_s = 0
        self.assertFalse(m.should_autocollapse())
        m.auto_s = 5
        m.collapse()
        self.assertFalse(m.should_autocollapse())

    def test_take_restore_and_shot_cap(self):
        m = HubModel(clock=Clock())
        self.assertFalse(m.can_send())
        for i in range(MAX_SHOTS):
            self.assertTrue(m.add_shot({"png": bytes([i])}))
        self.assertFalse(m.add_shot({"png": b"x"}))
        self.assertTrue(m.remove_shot(0))
        self.assertFalse(m.remove_shot(9))
        m.set_draft("  看这个  ")
        self.assertTrue(m.can_send())
        text, shots = m.take()
        self.assertEqual((text, len(shots)), ("看这个", MAX_SHOTS - 1))
        self.assertEqual((m.draft, m.shots), ("", []))
        m.sending = True
        m.set_draft("新的")
        self.assertFalse(m.can_send())
        m.restore(text, shots)
        self.assertEqual(m.draft, "新的")      # newer typing wins over the failed draft
        self.assertEqual(len(m.shots), MAX_SHOTS - 1)

    def test_cfg(self):
        self.assertEqual(hub_cfg(None), DEFAULT_HUB)
        self.assertNotIn("handsFree", DEFAULT_HUB)
        self.assertEqual(hub_cfg({"show": "no", "autoCollapseS": 7.6, "speak": False, "handsFree": True}),
                         {"show": True, "autoCollapseS": 8, "speak": False})     # retired key ignored
        self.assertEqual(hub_cfg({"autoCollapseS": -3})["autoCollapseS"], 20)
        self.assertEqual(hub_cfg({"autoCollapseS": "x"})["autoCollapseS"], 20)


class Placement(unittest.TestCase):
    WORK = (0, 0, 1920, 1040)

    def test_prefers_right_then_left(self):
        x, y = place_beside((800, 600, 900, 800), (300, 36), self.WORK)
        self.assertEqual(x, 908)
        self.assertLessEqual(y + 36, 800)
        x, _ = place_beside((1700, 600, 1800, 800), (300, 36), self.WORK)
        self.assertEqual(x, 1700 - 8 - 300)

    def test_below_or_above_when_sides_blocked(self):
        x, y = place_beside((0, 300, 1920, 500), (300, 36), self.WORK)
        self.assertEqual(y, 508)
        _, y = place_beside((0, 900, 1920, 1040), (300, 36), self.WORK)
        self.assertEqual(y, 900 - 8 - 36)

    def test_clamped_inside_when_nothing_fits(self):
        x, y = place_beside((0, 0, 1920, 1040), (300, 36), self.WORK)
        self.assertTrue(0 <= x <= 1920 - 300 and 0 <= y <= 1040 - 36)

    def test_bar_centred_under_feet(self):
        x, y = place_under((800, 600, 900, 800), (300, 36), self.WORK)
        self.assertEqual((x + 150, y), (850, 804))

    def test_bar_goes_above_near_bottom_edge(self):
        _, y = place_under((800, 900, 900, 1020), (300, 36), self.WORK)
        self.assertEqual(y, 900 - 4 - 36)

    def test_bar_clamped_sideways(self):
        x, _ = place_under((0, 300, 60, 500), (300, 36), self.WORK)
        self.assertEqual(x, 0)
        x, _ = place_under((1880, 300, 1920, 500), (300, 36), self.WORK)
        self.assertEqual(x, 1920 - 300)


# ------------------------------------------------------------------------------------------ VAD
class VadTests(unittest.TestCase):
    def feed_all(self, vad, pcm):
        return [e for c in chunks(pcm) for e in [vad.feed(c)] if e]

    def test_speech_then_silence_ends_with_preroll(self):
        v = Vad(tail_s=0.6, pre_roll_s=0.3)
        quiet, loud = tone(1.0, 60), tone(1.0, 6000)
        ev = self.feed_all(v, quiet + loud + quiet)
        self.assertEqual([e[0] for e in ev], ["start", "end"])
        pcm = ev[1][1]
        secs = len(pcm) / 32000.0
        self.assertGreaterEqual(secs, 1.0 + 0.6)       # speech + tail
        self.assertLessEqual(secs, 1.0 + 0.6 + 0.3 + 0.21)  # + at most the pre-roll
        self.assertFalse(v.active)

    def test_short_blip_is_dropped(self):
        v = Vad(min_speech_s=0.3, tail_s=0.5)
        ev = self.feed_all(v, tone(0.5, 60) + tone(0.1, 8000) + tone(0.8, 60))
        self.assertEqual([e[0] for e in ev], ["start", "drop"])

    def test_max_length_forces_end(self):
        v = Vad(max_s=2.0)
        ev = self.feed_all(v, tone(3.0, 6000))
        self.assertEqual([e[0] for e in ev][:2], ["start", "end"])

    def test_steady_noise_raises_threshold(self):
        v = Vad(min_level=300)
        for c in chunks(tone(6.0, 280)):
            self.assertIsNone(v.feed(c))
        self.assertGreater(v.threshold, 300)

    def test_listener_pauses_and_delivers_segments(self):
        got, events = [], []

        class FakeStream:
            def __init__(self, callback, **kw):
                self.cb = callback

            def start(self):
                pass

            def stop(self):
                pass

            def close(self):
                pass

        class FakeSd:
            stream = None

            @classmethod
            def RawInputStream(cls, **kw):
                cls.stream = FakeStream(**kw)
                return cls.stream

        import threading
        done = threading.Event()
        lst = Listener(on_segment=lambda pcm: (got.append(pcm), done.set()), on_event=events.append, sd=FakeSd,
                       vad=Vad(tail_s=0.4))
        lst.start()
        cb = FakeSd.stream.cb
        lst.pause(True)
        for c in chunks(tone(1.0, 6000)):
            cb(c, len(c) // 2, None, None)
        self.assertFalse(lst.vad.active)
        lst.pause(False)
        for c in chunks(tone(0.3, 60) + tone(0.8, 6000) + tone(0.6, 60)):
            cb(c, len(c) // 2, None, None)
        self.assertTrue(done.wait(2))
        lst.stop()
        self.assertEqual(len(got), 1)
        self.assertIn("start", events)


# ------------------------------------------------------------------------------------------ capture
class CaptureTests(unittest.TestCase):
    def test_box_scaling_and_tiny_selection(self):
        bounds = (-1920, 0, 3840, 1080)
        self.assertEqual(capture.to_image_box((100, 50, 300, 250), bounds, (7680, 2160)), (200, 100, 600, 500))
        self.assertEqual(capture.to_image_box((300, 250, 100, 50), bounds, (3840, 1080)), (100, 50, 300, 250))
        self.assertIsNone(capture.to_image_box((10, 10, 13, 40), bounds, (3840, 1080)))
        self.assertEqual(capture.monitor_rect(bounds, (0, 0, 1920, 1080)), (1920, 0, 3840, 1080))

    def test_encode_fits_budget_and_thumb(self):
        from PIL import Image
        import random
        rnd = random.Random(1)
        im = Image.frombytes("RGB", (900, 700), bytes(rnd.getrandbits(8) for _ in range(900 * 700 * 3)))
        data = capture.encode(im, max_side=1920, max_bytes=300_000)
        self.assertLessEqual(len(data), 300_000)
        self.assertTrue(data.startswith(b"\x89PNG"))
        out = Image.open(io.BytesIO(data))
        self.assertLess(out.width, 900)
        self.assertEqual(capture.thumbnail(im).size, capture.THUMB)


# ------------------------------------------------------------------------------------------ route / bridge
class RouteTests(unittest.TestCase):
    def test_uploads_then_asks_with_ids(self):
        calls = []

        def post(url, body, headers, timeout):
            calls.append((url.rsplit("/", 1)[-1], body, headers))
            if url.endswith("/api/shot"):
                return 200, {"ok": True, "id": "shot-%016x" % len(calls)}
            return 200, {"ok": True, "protocol": 1, "requestId": body['requestId'], "sessionId": body['sessionId'],
                         "state": "completed", "delivery": "accepted", "accepted": True, "reply": "看到了"}
        r = SessionRoute("s-1", host_base="http://127.0.0.1:3080/dsh-pixel-pet", key="k", post=post)
        self.assertEqual(r.ask("这是什么", images=[b"\x89PNGa", b"\x89PNGb"]), "看到了")
        self.assertEqual([c[0] for c in calls], ["shot", "shot", "start"])
        self.assertEqual(calls[0][1], b"\x89PNGa")
        self.assertEqual(calls[0][2]["X-PixelPet-Key"], "k")
        self.assertRegex(calls[2][1]['requestId'], r'^[0-9a-f-]{36}$')
        self.assertEqual(calls[2][1], {"sessionId": "s-1", "text": "这是什么", 'requestId': calls[2][1]['requestId'],
                                       "shots": ["shot-%016x" % 1, "shot-%016x" % 2]})
        calls.clear()
        self.assertEqual(r.ask("", images=[b"\x89PNGc"]), "看到了")
        self.assertEqual(calls[-1][1]["text"], "")

    def test_upload_refused(self):
        r = SessionRoute("s", host_base="http://127.0.0.1:1", key="k", post=lambda *a: (413, {"ok": False}))
        with self.assertRaises(VoiceError):
            r.ask("x", images=[b"\x89PNG"])


class BridgeTests(unittest.TestCase):
    def make(self, llm):
        played, states = [], []
        data = tmpdir()
        b = VoiceBridge(StubStt("说的话"), StubTts(data), llm, play=played.append, on_state=states.append)
        return b, played, states

    def test_images_reach_llm_and_speak_off_skips_tts(self):
        llm = StubLlm()
        replies = []
        b, played, states = self.make(llm)
        b.on_reply = replies.append
        out = b.ask_text("看", images=[b"png"], speak=False)
        self.assertEqual(out["reply"], "收到：看")
        self.assertEqual(llm.images, [[b"png"]])
        self.assertEqual(played, [])
        self.assertEqual(states, ["thinking", "idle"])
        self.assertEqual(replies, ["收到：看"])

    def test_voice_turn_with_images(self):
        llm = StubLlm()
        b, played, _ = self.make(llm)
        out = b.hear(b"\x00\x00" * 1600, images=[b"a"], speak=True)
        self.assertEqual(out["heard"], "说的话")
        self.assertEqual(llm.images, [[b"a"]])
        self.assertEqual(len(played), 1)


# ------------------------------------------------------------------------------------------ Tk
class FakePet:
    offscreen = True

    def __init__(self, root, cfg):
        self.root, self.cfg = root, cfg
        self.sent, self.listen = [], 0

    def hub_cfg(self):
        return hub_cfg(self.cfg)

    def body_screen(self):
        return (-5000, -5000, -4900, -4800)

    def work_area(self):
        return (-6000, -6000, -2400, -2400)

    def hub_send(self, text, shots):
        self.sent.append((text, len(shots)))

    def hub_listen(self):
        self.listen += 1

    def hub_capture(self):
        pass


class BarTk(unittest.TestCase):
    def setUp(self):
        import tkinter as tk
        try:
            self.root = tk.Tk()
        except tk.TclError as exc:
            self.skipTest("no display: %s" % exc)
        self.root.withdraw()

    def tearDown(self):
        self.root.destroy()

    def test_fold_draft_autocollapse_send(self):
        from PIL import Image
        from pixelpet.hub import HubBar
        pet = FakePet(self.root, {"autoCollapseS": 3})
        bar = HubBar(pet)
        c = Clock()
        bar.m.clock = c
        self.assertTrue(bar.m.collapsed)
        bar.expand(focus=False)
        self.root.update()
        self.assertFalse(bar.m.collapsed)
        self.assertTrue(bar.win.winfo_viewable())
        bar.var.set("草稿")
        bar.add_shot({"png": b"\x89PNG", "thumb": Image.new("RGB", capture.THUMB)})
        w_with_shot = bar.width()
        bar.collapse()
        self.root.update()
        self.assertTrue(bar.chip.winfo_viewable())
        self.assertFalse(bar.win.winfo_viewable())
        bar.expand(focus=False)
        self.assertEqual(bar.var.get(), "草稿")
        self.assertEqual(len(bar.m.shots), 1)
        c.t += 2.9
        bar.tick(c())
        self.assertFalse(bar.m.collapsed)
        c.t += 0.2
        bar.tick(c())
        self.assertTrue(bar.m.collapsed)
        self.assertEqual(bar.var.get(), "草稿")
        bar.expand(focus=False)
        bar.send()
        self.assertEqual(pet.sent, [("草稿", 1)])
        self.assertEqual(bar.var.get(), "")
        self.assertTrue(bar.m.sending)
        self.assertLess(bar.width(), w_with_shot)
        bar.sent(False, "草稿", [{"png": b"x", "thumb": Image.new("RGB", capture.THUMB)}])
        self.assertEqual(bar.var.get(), "草稿")       # failed send puts the draft back
        self.assertEqual(len(bar.m.shots), 1)
        bar.remove_shot(0)
        self.assertEqual(bar.m.shots, [])
        pet.cfg["show"] = False
        bar.sync(pet.hub_cfg())
        self.root.update()
        self.assertFalse(bar.win.winfo_viewable() or bar.chip.winfo_viewable())
        bar.destroy()

    def geom(self, w):
        w.update_idletasks()
        import re
        m = re.match(r"(\d+)x(\d+)\+?(-?\d+)\+?(-?\d+)$", w.geometry())   # "WxH+X+Y", X/Y may be "+-123"
        return tuple(int(v) for v in m.groups())

    def test_bar_under_pet_chip_beside(self):
        from pixelpet.hub import BTN, HubBar
        pet = FakePet(self.root, {})
        bar = HubBar(pet)
        l, t, r, b = pet.body_screen()
        self.root.update()
        cw, ch, cx, cy = self.geom(bar.chip)
        self.assertEqual((cw, ch), (BTN, BTN))
        self.assertEqual((cx, cy), place_beside(pet.body_screen(), (BTN, BTN), pet.work_area(), gap=14))
        self.assertGreater(cx, r)                                # chip: right of the pet, as before
        bar.expand(focus=False)
        self.root.update()
        w, h, x, y = self.geom(bar.win)
        self.assertEqual(abs((x + w / 2.0) - (l + r) / 2.0) <= 1, True)   # centred under the feet
        self.assertEqual(y, b + 4)
        bar.collapse()
        self.root.update()
        self.assertEqual(self.geom(bar.chip)[2:], (cx, cy))      # chip back where it was
        bar.destroy()

    def test_mic_is_a_switch(self):
        from pixelpet.hub import ICON_HI, PANEL, HubBar
        pet = FakePet(self.root, {})
        bar = HubBar(pet)
        bar.expand(focus=False)
        bar._toggle_listen()
        self.assertEqual(pet.listen, 1)
        self.assertEqual(bar.cv.itemcget("mic-bg", "fill"), PANEL)
        bar.set_listening(True)
        self.assertEqual(bar.cv.itemcget("mic-bg", "fill"), ICON_HI)
        bar._hover("mic", True)
        self.assertEqual(bar.cv.itemcget("mic-bg", "fill"), ICON_HI)      # hover keeps the "on" fill
        bar._draw()                                                      # redraw keeps it too
        self.assertEqual(bar.cv.itemcget("mic-bg", "fill"), ICON_HI)
        self.assertFalse(bar.m.should_autocollapse(bar.m.clock() + 3600))  # no folding away while listening
        bar.set_listening(False)
        self.assertEqual(bar.cv.itemcget("mic-bg", "fill"), PANEL)
        bar.destroy()

    def test_chip_rim_is_thin(self):
        from pixelpet.hub import HubBar
        bar = HubBar(FakePet(self.root, {}))
        widths = {float(bar.ccv.itemcget(i, "width")) for i in bar.ccv.find_all() if bar.ccv.type(i) == "polygon"}
        self.assertEqual(widths, {1.0})
        bar.destroy()


class FakeSd:
    streams = []

    class Stream:
        def __init__(self, callback, **kw):
            self.cb, self.open = callback, False

        def start(self):
            self.open = True

        def stop(self):
            self.open = False

        def close(self):
            pass

    @classmethod
    def RawInputStream(cls, **kw):
        s = cls.Stream(**kw)
        cls.streams.append(s)
        return s


class PetListening(BarTk):
    """Real PetApp off-screen: the mic button and the hotkey flip one continuous listener; no halo window."""

    def test_toggle_and_no_halo(self):
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        data = tmpdir()
        with open(data + "/settings.json", "w", encoding="utf-8") as f:
            f.write('{"hub": {"handsFree": true}}')              # stale key from the old switch: ignored
        app = PetApp(self.root, root_dir, data_dir=data, character="tester", offscreen=True, speed=4000.0)
        try:
            self.assertFalse(hasattr(app, "halo"))
            self.assertIsNone(app.listener)                      # starts off whatever the old setting said
            self.assertNotIn("handsFree", app.hub_cfg())
            self.assertFalse(app.set_listening(True))            # off-screen never opens the real mic
            app._fake_sd = FakeSd
            app.hub.expand(focus=False)
            app.hub._toggle_listen()
            self.assertIsNotNone(app.listener)
            self.assertTrue(FakeSd.streams[-1].open)
            self.assertTrue(app.hub.m.listening)
            self.assertTrue(app.command({"cmd": "hub"})[3]["listening"])
            app.voice_state = "speaking"
            app._tick_hub(1e9)
            self.assertTrue(app.listener._paused)                # never hears itself
            app.voice_state = "idle"
            app._tick_hub(1e9)
            self.assertFalse(app.listener._paused)
            app.hub_listen()                                     # hotkey path: same flip
            self.assertIsNone(app.listener)
            self.assertFalse(FakeSd.streams[-1].open)
            self.assertFalse(app.hub.m.listening)
        finally:
            app.quit()
            self.root = None

    def tearDown(self):
        if self.root is not None:
            self.root.destroy()


if __name__ == "__main__":
    unittest.main()
