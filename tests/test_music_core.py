"""pixelmusic 单测：合成音频、假 SMTC、假 HTTP；不联网、不真实录音/放音。

用 dsh-music venv 跑：<venv>\\Scripts\\python.exe -X utf8 -m unittest test_music_core
其它 Python 缺 numpy/librosa 时相关用例自动跳过。
"""
from __future__ import annotations

import asyncio
import datetime as dt
import io
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime" / "music"))

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

try:
    import librosa  # noqa: F401
    HAVE_LIBROSA = True
except Exception:
    HAVE_LIBROSA = False

try:
    import soundfile as sf
except Exception:
    sf = None

if np is not None:
    from pixelmusic import lyrics as lyr
    from pixelmusic import smtc as smtc_mod
    from pixelmusic import songmap
    from pixelmusic.__main__ import Service, serve
    from pixelmusic.local import LocalPlayer, guess_tags
    from pixelmusic.loopback import BARS, LoopbackCapture, Meter
    from pixelmusic.volume import AppVolume, proc_names


def sine(freq=440.0, sec=1.0, rate=48000, amp=0.5):
    t = np.arange(int(sec * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


# ---------------- 假 SMTC ----------------
class _Done:
    def __init__(self, v=True):
        self.v = v

    def __await__(self):
        if False:
            yield
        return self.v


class FakeInfo:
    def __init__(self, status, seek=False, repeat=None, shuffle=None, mode_ok=False):
        self.playback_status = status
        self.auto_repeat_mode = repeat
        self.is_shuffle_active = shuffle

        class C:
            is_playback_position_enabled = seek
            is_repeat_enabled = mode_ok
            is_shuffle_enabled = mode_ok
        self.controls = C()


class FakeTimeline:
    def __init__(self, pos, end):
        self.position = dt.timedelta(seconds=pos)
        self.start_time = dt.timedelta(0)
        self.end_time = dt.timedelta(seconds=end)
        self.last_updated_time = dt.datetime.now(dt.timezone.utc)


class FakeProps:
    def __init__(self, title, artist, album=""):
        self.title, self.artist, self.album_title, self.album_artist = title, artist, album, ""
        self.thumbnail = None


class FakeSession:
    def __init__(self, aumid, title="示例曲目", artist="示例艺人", status=4, pos=10.0, end=259.0, seek=False, repeat=None, shuffle=None, mode_ok=False):
        self.source_app_user_model_id = aumid
        self._p = FakeProps(title, artist)
        self._i = FakeInfo(status, seek, repeat, shuffle, mode_ok)
        self._t = FakeTimeline(pos, end)
        self.calls = []

    async def try_get_media_properties_async(self):
        return self._p

    def get_timeline_properties(self):
        return self._t

    def get_playback_info(self):
        return self._i

    def _act(self, name):
        self.calls.append(name)
        return _Done(True)

    def try_toggle_play_pause_async(self): return self._act("toggle")
    def try_play_async(self): return self._act("play")
    def try_pause_async(self): return self._act("pause")
    def try_skip_next_async(self): return self._act("next")
    def try_skip_previous_async(self): return self._act("prev")

    def try_change_auto_repeat_mode_async(self, mode):
        self.calls.append(("repeat", int(mode)))
        return _Done(True)

    def try_change_shuffle_active_async(self, on):
        self.calls.append(("shuffle", bool(on)))
        return _Done(True)

    def try_change_playback_position_async(self, ticks):
        self.calls.append(("seek", ticks))
        return _Done(True)


class FakeManager:
    def __init__(self, sessions, current=None):
        self.sessions = sessions
        self.current = current

    def get_sessions(self):
        return self.sessions

    def get_current_session(self):
        return self.current


@unittest.skipIf(np is None, "需要 numpy")
class SmtcTest(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(smtc_mod.classify("cloudmusic.exe"), "netease")
        self.assertEqual(smtc_mod.classify("NetEase.CloudMusic_xxx!App"), "netease")
        self.assertEqual(smtc_mod.classify("QQMusic.exe"), "qqmusic")
        self.assertEqual(smtc_mod.classify("Tencent.QQMusic_abc!QQMusic"), "qqmusic")
        self.assertEqual(smtc_mod.classify("chrome"), "other")
        self.assertEqual(smtc_mod.classify(None), "other")

    def test_pick_prefers_playing_known_client(self):
        chrome = FakeSession("chrome", status=4)
        ne = FakeSession("cloudmusic.exe", status=4)
        qq = FakeSession("QQMusic.exe", status=5)
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([chrome, qq, ne], current=chrome))
        snap = asyncio.run(src.refresh())
        self.assertEqual(snap["app"], "netease")
        self.assertTrue(snap["playing"])
        self.assertEqual(snap["title"], "示例曲目")
        self.assertAlmostEqual(snap["duration"], 259.0)
        self.assertGreaterEqual(snap["position"], 10.0)
        self.assertFalse(snap["seek"])

    def test_empty_manager(self):
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([], None))
        self.assertIsNone(asyncio.run(src.refresh()))
        self.assertIsNone(src.snapshot())

    def test_control_in_background_loop(self):
        s = FakeSession("QQMusic.exe", seek=True)
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), poll=0.05)
        src.start()
        try:
            self.assertTrue(src.control("next"))
            self.assertTrue(src.control("seek", 30))
        finally:
            src.stop()
        self.assertIn("next", s.calls)
        self.assertIn(("seek", 300000000), s.calls)

    def test_mode_read_and_change(self):
        self.assertEqual(smtc_mod.read_mode(FakeInfo(4, repeat=1, shuffle=False)), "one")
        self.assertEqual(smtc_mod.read_mode(FakeInfo(4, repeat=2, shuffle=True)), "shuffle")
        self.assertEqual(smtc_mod.read_mode(FakeInfo(4, repeat=0)), "list")
        self.assertIsNone(smtc_mod.read_mode(FakeInfo(4)))
        s = FakeSession("QQMusic.exe", repeat=2, shuffle=False, mode_ok=True)
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), poll=0.05)
        src.start()
        try:
            time.sleep(0.2)
            self.assertEqual(src.snapshot()["mode"], "list")
            src.control("mode", "one")
            src.control("mode", "shuffle")
        finally:
            src.stop()
        self.assertIn(("repeat", 1), s.calls)
        self.assertIn(("shuffle", True), s.calls)

    def test_mode_unsupported_is_reported(self):
        s = FakeSession("cloudmusic.exe", mode_ok=False)
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), poll=0.05)
        src.start()
        try:
            time.sleep(0.2)
            self.assertFalse(src.snapshot()["mode_ok"])
            with self.assertRaises(RuntimeError):
                src.control("mode", "one")
        finally:
            src.stop()

    def test_volume_proc_map(self):
        self.assertEqual(proc_names("netease"), ("cloudmusic.exe",))
        self.assertEqual(proc_names("qqmusic"), ("qqmusic.exe",))
        self.assertEqual(proc_names("other", "Foobar2000.EXE"), ("foobar2000.exe",))
        self.assertEqual(proc_names("other", "Microsoft.ZuneMusic_8wekyb3d8bbwe!App"), ())

    def test_self_clock_when_timeline_stuck(self):
        # 网易云：时间轴恒为 0、无时长 → 自有时钟；暂停停表、恢复续表、换歌归零
        t = [100.0]
        s = FakeSession("cloudmusic.exe", pos=0.0, end=0.0, seek=True)
        s._t.last_updated_time = None
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), clock=lambda: t[0])
        snap = asyncio.run(src.refresh())
        self.assertEqual(snap["position_source"], "smtc")
        t[0] += 1
        snap = asyncio.run(src.refresh())
        self.assertEqual(snap["position_source"], "estimated")
        self.assertFalse(snap["seek"])
        t[0] += 1
        asyncio.run(src.refresh())
        t[0] += 0.5
        self.assertAlmostEqual(src.snapshot()["position"], 2.5, places=2)
        s._i.playback_status = 5  # 暂停
        t[0] += 0.5
        asyncio.run(src.refresh())
        t[0] += 10
        asyncio.run(src.refresh())
        self.assertAlmostEqual(src.snapshot()["position"], 3.0, places=2)
        s._i.playback_status = 4
        asyncio.run(src.refresh())
        t[0] += 2
        asyncio.run(src.refresh())
        self.assertAlmostEqual(src.snapshot()["position"], 5.0, places=2)
        s._p.title = "下一首"
        asyncio.run(src.refresh())
        self.assertLess(src.snapshot()["position"], 0.5)

    def test_poll_survives_a_hung_winrt_call(self):
        # WinRT 调用卡住不回来时，轮询不能跟着卡死；超时后重建管理器继续轮询
        s = FakeSession("cloudmusic.exe", pos=10.0, end=200.0)
        made = []

        class HangOnce:
            def __init__(self):
                self.n = 0

            def __call__(self):
                self.n += 1
                made.append(self.n)
                if self.n == 1:
                    async def never():
                        await asyncio.sleep(3600)
                    return never()
                return FakeManager([s], s)

        src = smtc_mod.SmtcSource(manager_factory=HangOnce(), poll=0.05)
        src.REFRESH_TIMEOUT_S = 0.3
        src.start()
        try:
            deadline = time.time() + 5
            while time.time() < deadline and src.snapshot() is None:
                time.sleep(0.05)
            self.assertIsNotNone(src.snapshot(), "超时后应重建管理器并拿到快照")
            self.assertGreaterEqual(len(made), 2)
        finally:
            src.stop()

    def test_self_clock_wraps_by_lyrics_duration_hint(self):
        # 网易云不报曲长，同一首歌循环时自有时钟要按歌词库时长回绕（实测曾一路涨到 1235 s / 186 s）
        t = [0.0]
        s = FakeSession("cloudmusic.exe", pos=0.0, end=0.0, seek=True)
        s._t.last_updated_time = None
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), clock=lambda: t[0])
        src.duration_hint = lambda title, artist: 10.0
        for _ in range(3):
            asyncio.run(src.refresh())
            t[0] += 1
        self.assertEqual(src.snapshot()["position_source"], "estimated")
        for _ in range(9):  # 再走 9 秒：超过 10 秒的部分回到开头
            t[0] += 1
            asyncio.run(src.refresh())
        self.assertLess(src.snapshot()["position"], 10.0)
        self.assertIsNone(src.snapshot()["duration"])
        t[0] += 25  # 刷新线程卡住时，snapshot 外推也要回绕
        self.assertLess(src.snapshot()["position"], 10.0)
        src.duration_hint = None  # 没有任何时长：照旧一路走，不乱绕
        t[0] += 1
        asyncio.run(src.refresh())
        t[0] += 30
        self.assertGreater(src.snapshot()["position"], 10.0)

    def test_real_timeline_not_estimated(self):
        t = [0.0]
        s = FakeSession("QQMusic.exe", pos=10.0, end=200.0)
        s._t.last_updated_time = None
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), clock=lambda: t[0])
        for i in range(4):
            s._t.position = dt.timedelta(seconds=10 + i)
            t[0] += 1
            snap = asyncio.run(src.refresh())
        self.assertEqual(snap["position_source"], "smtc")
        self.assertAlmostEqual(snap["position"], 13.0)

    def test_seek_refused_when_not_allowed(self):
        s = FakeSession("cloudmusic.exe", seek=False)
        src = smtc_mod.SmtcSource(manager_factory=lambda: FakeManager([s], s), poll=0.05)
        src.start()
        try:
            with self.assertRaises(RuntimeError):
                src.control("seek", 30)
        finally:
            src.stop()


# ---------------- 歌词 ----------------
LRC = "[ti:x]\n[00:01.00]第一行\n[00:05.50]第二行\n[00:10.00][00:20.00]重复行\n"


@unittest.skipIf(np is None, "需要 numpy")
class LyricsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_parse_and_view(self):
        lines = lyr.parse(LRC)
        self.assertEqual(len(lines), 4)
        self.assertEqual(lyr.view(lines, 0.5)["index"], -1)
        v = lyr.view(lines, 6.0)
        self.assertEqual((v["index"], v["line"], v["next"]), (1, "第二行", "重复行"))
        self.assertFalse(lyr.view(None, 3)["available"])

    def test_local_lrc_gbk(self):
        audio = self.tmp / "a.mp3"
        (self.tmp / "a.lrc").write_bytes(LRC.encode("gb18030"))
        self.assertEqual(lyr.local_lrc(audio)[0][1], "第一行")

    def test_lrclib_query_cache_and_miss(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if "track_name=%E7%A4%BA" in url:  # 「示」例曲目
                return 200, {"syncedLyrics": LRC, "plainLyrics": "x"}
            return 404, None

        st = lyr.LyricsStore(self.tmp / "cache", fetch=fetch)
        state, lines = st.lookup("示例曲目", "示例艺人", 259.4, background=False)
        self.assertEqual(state, "ready")
        self.assertEqual(lines[1][1], "第二行")
        self.assertIn("duration=259", calls[0])
        self.assertNotIn("album", calls[0])
        state, _ = st.lookup("无此歌", "某人", 100, background=False)
        self.assertEqual(state, "missing")
        # 新实例只读缓存，不再联网
        st2 = lyr.LyricsStore(self.tmp / "cache", fetch=lambda u: self.fail("不应联网"))
        self.assertEqual(st2.lookup("示例曲目", "示例艺人", 259.4)[0], "ready")
        self.assertEqual(st2.lookup("无此歌", "某人", 100)[0], "missing")
        files = list((self.tmp / "cache").glob("*.json"))
        self.assertEqual(len(files), 2)
        for f in files:
            body = json.loads(f.read_text(encoding="utf-8"))
            self.assertLessEqual(set(body), {"synced", "miss", "at"})

    def test_search_fallback_without_duration(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if "/api/get" in url:
                return 404, None
            return 200, [{"trackName": "Other", "artistName": "kadan", "syncedLyrics": "[00:01.00]x"},
                         {"trackName": "DISTANCE", "artistName": "kadan", "duration": 201.0, "syncedLyrics": LRC}]

        st = lyr.LyricsStore(self.tmp / "c", fetch=fetch)
        state, lines = st.lookup("DISTANCE", "kadan", None, background=False)
        self.assertEqual(state, "ready")
        self.assertEqual(lines[0][1], "第一行")
        self.assertTrue(any("/api/search" in u for u in calls))
        self.assertEqual(st.duration("DISTANCE", "kadan", None), 201.0)
        # 有时长时不搜（避免错配）
        calls.clear()
        st.lookup("Nope", "kadan", 180, background=False)
        self.assertFalse(any("/api/search" in u for u in calls))
        # 搜索无匹配 → missing
        st2 = lyr.LyricsStore(self.tmp / "c2", fetch=lambda u: (404, None) if "/api/get" in u else (200, []))
        self.assertEqual(st2.lookup("A", "B", None, background=False)[0], "missing")

    def test_network_error_backs_off(self):
        n = []

        def boom(url):
            n.append(1)
            raise OSError("offline")

        st = lyr.LyricsStore(self.tmp / "c", fetch=boom)
        self.assertEqual(st.lookup("a", "b", 10, background=False)[0], "missing")
        self.assertEqual(st.lookup("a", "b", 10)[0], "missing")
        self.assertEqual(len(n), 1)
        self.assertFalse((self.tmp / "c").exists())


# ---------------- 回环/频谱 ----------------
class FakeRecorder:
    def __init__(self, freq=1000.0):
        self.freq = freq
        self.opened = 0
        self.closed = 0
        self.t = 0

    def __call__(self, rate, block):
        self.rate, self.block = rate, block
        return self

    def __enter__(self):
        self.opened += 1
        return self

    def __exit__(self, *a):
        self.closed += 1

    def record(self, numframes):
        t = (np.arange(numframes) + self.t) / self.rate
        self.t += numframes
        time.sleep(numframes / self.rate / 4)
        x = (0.4 * np.sin(2 * np.pi * self.freq * t)).astype(np.float32)
        return np.stack([x, x], axis=1)


@unittest.skipIf(np is None, "需要 numpy")
class LoopbackTest(unittest.TestCase):
    def test_meter_bars_and_features(self):
        m = Meter(rate=48000)
        m.feed(sine(440, 2.0))
        bars = m.bars()
        self.assertEqual(len(bars), BARS)
        self.assertTrue(all(0.0 <= b <= 1.0 for b in bars))
        self.assertGreater(max(bars), 0.3)
        m.feed(sine(440, 0.5))  # 首次 librosa 计算可能超过 1 s，模拟持续进流
        f = m.tick_features()
        self.assertGreater(f["energy"], 0.0)
        self.assertEqual(len(m.history), 1)

    def test_capture_start_stop_releases_device(self):
        m = Meter()
        rec = FakeRecorder()
        cap = LoopbackCapture(m, recorder_factory=rec)
        cap.set_active(True)
        deadline = time.time() + 3
        while m.last_rms == 0.0 and time.time() < deadline:
            time.sleep(0.02)
        self.assertGreater(m.last_rms, 0.1)
        cap.stop()
        self.assertFalse(cap.running)
        self.assertEqual((rec.opened, rec.closed), (1, 1))

    def test_capture_error_is_type_name_only(self):
        def boom(rate, block):
            raise RuntimeError("Error 0x100000001 扬声器 (某设备)")

        cap = LoopbackCapture(Meter(), recorder_factory=boom)
        cap.set_active(True)
        cap._thread.join(2)
        self.assertEqual(cap.error, "RuntimeError")
        self.assertFalse(cap.running)

    def test_rolling_sentence_bounds(self):
        hist = [{"t": i, "energy": 0.1 if i < 30 else 0.7, "brightness": 0.6, "tempo": 120.0} for i in range(60)]
        s = songmap.rolling_sentence(hist)
        self.assertTrue(s.startswith("测到的特征："))
        self.assertIn("更响", s)
        self.assertIn("120 BPM", s)
        claim = s.split("（")[0]  # 括号里是边界声明本身
        for bad in ("吉他", "钢琴", "鼓", "悲伤", "开心", "副歌", "摇滚", "流行"):
            self.assertNotIn(bad, claim)
        self.assertEqual(songmap.rolling_sentence([]), "")


# ---------------- 整曲分析 ----------------
@unittest.skipUnless(np is not None and HAVE_LIBROSA, "需要 librosa")
class SongmapTest(unittest.TestCase):
    def test_analyze_synthetic(self):
        sr = songmap.SR
        quiet = sine(220, 12, sr, 0.05)
        loud = sine(880, 12, sr, 0.6)
        y = np.concatenate([quiet, loud, quiet, loud])
        res = songmap.analyze_signal(y, sr)
        self.assertGreaterEqual(len(res["segments"]), 2)
        d = songmap.describe(res, 30.0)
        self.assertTrue(d["sentence"].startswith("测到的特征："))
        for bad in ("吉他", "钢琴", "悲伤", "副歌", "曲风"):
            self.assertNotIn(bad, d["sentence"])

    @unittest.skipIf(sf is None, "需要 soundfile")
    def test_decode_and_cache_dir(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            wav = tmp / "x.wav"
            sf.write(str(wav), sine(440, 1.0, 44100), 44100)
            y = songmap.decode(wav)
            self.assertAlmostEqual(y.size / songmap.SR, 1.0, places=1)
            songmap.set_cache_dir(tmp / "an")
            self.assertTrue(str(songmap.cache_file(wav)).startswith(str(tmp / "an")))
        finally:
            songmap.set_cache_dir(None)
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------- 本地播放 ----------------
class FakeStream:
    def __init__(self, rate, ch, cb, fin):
        self.rate, self.ch, self.cb = rate, ch, cb
        self.started = self.closed = False

    def start(self):
        self.started = True

    def stop(self):
        pass

    def close(self):
        self.closed = True

    def pull(self, frames=1024):
        out = np.zeros((frames, self.ch), dtype=np.float32)
        self.cb(out, frames, None, None)
        return out


@unittest.skipUnless(np is not None and sf is not None, "需要 soundfile")
class LocalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.a = self.tmp / "歌手甲 - 第一首.wav"
        self.b = self.tmp / "second.flac"
        sf.write(str(self.a), sine(440, 1.0, 22050), 22050)
        sf.write(str(self.b), sine(660, 0.5, 22050), 22050)
        self.before = {p: p.read_bytes() for p in (self.a, self.b)}
        self.streams = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def mk(self, *a):
        s = FakeStream(*a)
        self.streams.append(s)
        return s

    def player(self, meter=None):
        return LocalPlayer(self.tmp / "data" / "local.json", meter=meter, make_stream=self.mk)

    def test_add_filters_and_persists(self):
        (self.tmp / "x.m4a").write_bytes(b"\0" * 10)
        (self.tmp / "y.txt").write_text("no")
        p = self.player()
        r = p.add([str(self.a), str(self.b), str(self.tmp / "x.m4a"), str(self.tmp / "y.txt"), str(self.tmp / "missing.mp3"), str(self.a)])
        self.assertEqual((r["added"], r["unsupported"], r["rejected"]), (2, 1, 2))
        self.assertEqual(guess_tags(self.a), ("第一首", "歌手甲"))
        self.assertEqual(len(self.player().queue), 2)
        self.assertEqual(p.items()[0], {"index": 0, "title": "第一首", "artist": "歌手甲"})

    def test_play_pause_seek_next_and_readonly(self):
        meter = Meter(rate=22050)
        p = self.player(meter)
        p.add([str(self.a), str(self.b)])
        p.play(0)
        out = self.streams[-1].pull(2048)
        self.assertGreater(float(np.abs(out).max()), 0.1)
        self.assertGreater(meter.last_rms, 0.1)
        snap = p.snapshot()
        self.assertTrue(snap["playing"])
        self.assertAlmostEqual(snap["duration"], 1.0, places=2)
        p.seek(0.5)
        self.assertAlmostEqual(p.snapshot()["position"], 0.5, places=2)
        p.pause()
        self.assertFalse(np.abs(self.streams[-1].pull()).max())
        p.toggle()
        self.assertTrue(p.snapshot()["playing"])
        # 放到结尾 → poll 自动下一首
        for _ in range(20):
            self.streams[-1].pull(1024)
        p.poll()
        self.assertEqual(p.index, 1)
        # 单曲循环：结尾回到同一首
        p.set_mode("one")
        for _ in range(20):
            self.streams[-1].pull(1024)
        p.poll()
        self.assertEqual(p.index, 1)
        self.assertEqual(p.snapshot()["mode"], "one")
        self.assertIsInstance(p.snapshot()["volume"], int)
        with self.assertRaises(ValueError):
            p.set_mode("loop")
        p.close()
        self.assertTrue(self.streams[0].closed)
        for path, data in self.before.items():
            self.assertEqual(path.read_bytes(), data)


# ---------------- 服务/协议 ----------------
class StubSmtc:
    def __init__(self, snap=None):
        self.snap = snap
        self.calls = []

    def start(self): pass
    def stop(self): pass
    def snapshot(self): return dict(self.snap) if self.snap else None
    def cover(self): return (b"\x89PNG\r\n\x1a\nabc", "image/png") if self.snap else None

    def control(self, action, value=None):
        self.calls.append(action)
        return True


class FakeVol:
    def __init__(self, level):
        self.level = level

    def GetMasterVolume(self):
        return self.level

    def SetMasterVolume(self, v, ctx):
        self.level = v


class StubLoop:
    def __init__(self):
        self.want = []
        self.running = False
        self.error = ""

    def set_active(self, on):
        self.want.append(on)
        self.running = on

    def stop(self):
        self.running = False


@unittest.skipIf(np is None, "需要 numpy")
class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        songmap.set_cache_dir(None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def svc(self, snap, vol=None):
        st = lyr.LyricsStore(self.tmp / "ly", fetch=lambda u: (200, {"syncedLyrics": LRC}))
        return Service(self.tmp, smtc=StubSmtc(snap), loopback=StubLoop(), lyrics_store=st,
                       app_volume=AppVolume(sessions=lambda: (vol or {}).get("s", [])),
                       local=LocalPlayer(self.tmp / "music" / "local.json", make_stream=lambda *a: FakeStream(*a)))

    def test_cloud_snapshot_shape(self):
        snap = {"app": "netease", "playing": True, "title": "示例曲目", "artist": "示例艺人", "album": "", "duration": 259.0,
                "position": 6.0, "seek": False, "cover": "abc123"}
        s = self.svc(snap)
        s.lyrics.lookup("示例曲目", "示例艺人", 259.0, background=False)
        n = s.now()
        self.assertEqual((n["source"], n["app"], n["playing"]), ("cloud", "netease", True))
        self.assertEqual(n["track"]["cover"], "abc123")
        self.assertEqual(n["lyric"]["line"], "第二行")
        self.assertEqual(len(n["spectrum"]["bars"]), 48)
        self.assertFalse(n["capabilities"]["seek"])
        self.assertEqual(s.loopback.want[-1], True)
        s.smtc.snap["playing"] = False
        s.now()
        self.assertEqual(s.loopback.want[-1], False)
        lv = s.live()
        self.assertEqual(set(lv), {"source", "playing", "playback", "position", "lyric", "spectrum"})
        self.assertEqual(lv["playback"], "paused")
        s.smtc.snap["playback"] = "off"
        self.assertEqual(s.live()["playback"], "off")

    def test_none_and_controls(self):
        s = self.svc(None)
        n = s.now()
        self.assertEqual(n["source"], "none")
        self.assertIsNone(n["track"])
        with self.assertRaises(RuntimeError):
            s.control({"action": "volume", "value": 50})
        s.smtc.snap = {"app": "qqmusic", "playing": True, "title": "t", "artist": "a", "album": "", "duration": 100.0, "position": 1.0, "seek": False}
        s.control({"action": "next"})
        self.assertEqual(s.smtc.calls, ["next"])

    def test_protocol_and_no_path_leak(self):
        wav = self.tmp / "歌手 - 秘密路径歌.wav"
        if sf is None:
            self.skipTest("需要 soundfile")
        sf.write(str(wav), sine(440, 1.0, 22050), 22050)
        s = self.svc(None)
        lines = [
            {"id": 1, "command": "ping"},
            {"id": 2, "command": "control", "args": {"action": "local_add", "value": [str(wav)]}},
            {"id": 3, "command": "control", "args": {"action": "local_play", "value": 0}},
            {"id": 4, "command": "bogus"},
        ]
        out = io.StringIO()
        inp = io.StringIO("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\nnot json\n")
        t = threading.Thread(target=serve, args=(s, inp, out))
        t.start()
        t.join(5)
        time.sleep(0.2)
        got = {m["id"]: m for m in map(json.loads, out.getvalue().splitlines())}
        self.assertTrue(got[1]["ok"])
        self.assertEqual(got[2]["data"]["added"], 1)
        self.assertEqual(got[4]["error"]["code"], "unknown_command")
        s2 = self.svc(None)
        s2.local.play(0)
        n = s2.now()
        self.assertEqual(n["source"], "local")
        self.assertEqual(n["track"]["title"], "秘密路径歌")
        dump = json.dumps(n, ensure_ascii=False) + json.dumps(s2.control({"action": "local_list"}), ensure_ascii=False)
        self.assertNotIn(str(self.tmp), dump)
        self.assertNotIn(".wav", dump)
        s2.close()

    def test_cloud_volume_mode_window(self):
        v = FakeVol(0.4)
        snap = {"app": "netease", "aumid": "cloudmusic.exe", "playing": True, "title": "示例曲目", "artist": "示例艺人", "album": "",
                "duration": 259.0, "position": 6.0, "seek": False, "mode": "one", "mode_ok": True}
        s = self.svc(snap, {"s": [("chrome.exe", FakeVol(1.0)), ("cloudmusic.exe", v)]})
        s.lyrics.lookup("示例曲目", "示例艺人", 259.0, background=False)
        n = s.now()
        self.assertEqual((n["volume"], n["mode"]), (40, "one"))
        self.assertTrue(n["capabilities"]["volume"] and n["capabilities"]["mode"])
        self.assertEqual(n["lyric"]["window"], {"before": ["第一行"], "current": "第二行", "after": ["重复行", "重复行"]})
        self.assertEqual(s.live()["lyric"]["window"]["current"], "第二行")
        self.assertEqual(s.control({"action": "volume", "value": 75})["volume"], 75)
        self.assertAlmostEqual(v.level, 0.75)
        s.control({"action": "mode", "value": "shuffle"})
        self.assertEqual(s.smtc.calls[-1], "mode")
        # 不支持音量的客户端如实报 None/False
        s2 = self.svc({**snap, "app": "other", "aumid": "Some.App!Main", "mode_ok": False, "mode": None})
        n2 = s2.now()
        self.assertIsNone(n2["volume"])
        self.assertFalse(n2["capabilities"]["volume"] or n2["capabilities"]["mode"])
        with self.assertRaises(RuntimeError):
            s2.control({"action": "volume", "value": 10})

    def test_cover(self):
        s = self.svc({"app": "other", "playing": False, "title": "t", "artist": "", "album": "", "duration": None, "position": 0, "seek": False})
        c = s.cover()
        self.assertEqual(c["mime"], "image/png")


if __name__ == "__main__":
    unittest.main()
