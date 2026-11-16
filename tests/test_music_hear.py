"""「一起听歌」听得更细（2026-11-15）：滚动整曲图 / 说话窗口 / 每秒特征耗时 / CLAP 组件（没装则 skip）。

在 pye-music venv 里跑（要 numpy + librosa + scipy）：
    <venv python> -X utf8 -m unittest test_music_hear -v   （tests 目录）
"""
import importlib.util
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "music"))

import numpy as np  # noqa: E402

try:
    import librosa  # noqa: E402
except Exception:
    librosa = None

from pixelmusic import songmap  # noqa: E402
from pixelmusic import clap  # noqa: E402
from pixelmusic.loopback import Analyzer, Meter  # noqa: E402


def sine(freq, seconds, rate=48000, amp=0.2):
    t = np.arange(int(rate * seconds), dtype=np.float32)
    return (amp * np.sin(2 * np.pi * freq * t / rate)).astype(np.float32)


def chord_rows(seconds, *, base_bin=0, energy, loud_db, tempo=120.0, perc=0.3, pos0=0.0):
    """合成「C 三和弦为主」的每秒特征行（直接造行，不算音频）。pos 从 pos0 起每秒 +1。"""
    chroma = [0.0] * 12
    chroma[base_bin % 12] = 0.30
    chroma[(base_bin + 4) % 12] = 0.12
    chroma[(base_bin + 7) % 12] = 0.12
    rows = []
    for i in range(seconds):
        rows.append({
            "t": i * 1.0, "pos": pos0 + i, "energy": energy, "brightness": 0.5, "tempo": tempo,
            "loud_db": loud_db + float(np.random.default_rng(i).uniform(-0.5, 0.5)),
            "chroma": [round(c, 4) for c in chroma],
            "mfcc": [0.0] * 13, "onset": 0.4, "perc": perc,
        })
    return rows


@unittest.skipIf(librosa is None, "需要 librosa")
class RollingMap(unittest.TestCase):
    def test_three_sections_and_A_prime(self):
        """安静段 → 响段 → 安静段（与第一段相同的和声）：3 段、第 3 段标 A′、调性正确。"""
        rows = chord_rows(30, base_bin=0, energy=0.15, loud_db=-28.0) \
            + chord_rows(30, base_bin=1, energy=0.75, loud_db=-8.0, perc=0.55) \
            + chord_rows(30, base_bin=0, energy=0.15, loud_db=-28.0)
        m = songmap.rolling_map(rows)
        self.assertIsNotNone(m)
        self.assertEqual(len(m["segments"]), 3)
        labels = [s["label"] for s in m["segments"]]
        self.assertEqual(labels[0], "A")
        self.assertEqual(labels[1], "B")
        self.assertTrue(labels[2].startswith("A′"), labels)
        self.assertTrue(m["segments"][-1].get("ongoing"))
        self.assertEqual(m["key"]["name"], "C 大调")
        self.assertTrue(m["tempo"]["reliable"])
        self.assertEqual(m["tempo"]["bpm"], 120.0)

    def test_recent_change_reported(self):
        """突变只在已听部分里找；发生在最近 10 秒内的才报「刚刚突然变轻」。"""
        rows = chord_rows(30, base_bin=0, energy=0.75, loud_db=-8.0, perc=0.5) \
            + chord_rows(38, base_bin=0, energy=0.15, loud_db=-28.0)
        m = songmap.rolling_map(rows)
        self.assertEqual(m.get("recent_change"), None)  # 变轻发生在 30 秒前：不进 recent
        rows2 = chord_rows(30, base_bin=0, energy=0.15, loud_db=-28.0) \
            + chord_rows(30, base_bin=0, energy=0.75, loud_db=-8.0, perc=0.5) \
            + chord_rows(8, base_bin=0, energy=0.15, loud_db=-28.0)
        m2 = songmap.rolling_map(rows2)
        self.assertIsNotNone(m2.get("recent_change"))
        self.assertEqual(m2["recent_change"]["direction"], "变轻")

    def test_bpm_jitter_marks_unreliable(self):
        """BPM 抖动 > ±8%（96 与 120 混着来）→ 标不可靠、不报 BPM。"""
        rows = chord_rows(40, base_bin=0, energy=0.5, loud_db=-15.0, tempo=120.0)
        for i, r in enumerate(rows):
            if i % 3 == 0:
                r["tempo"] = 96.0
        m = songmap.rolling_map(rows)
        self.assertFalse(m["tempo"]["reliable"])
        self.assertIsNone(m["tempo"]["bpm"])

    def test_old_format_rows_still_work(self):
        """旧格式行（没有 chroma/mfcc/loud_db）：不报调性，句子照出。"""
        rows = [{"t": i, "energy": 0.1 if i < 40 else 0.7, "brightness": 0.6, "tempo": 120.0} for i in range(80)]
        d = songmap.describe_rolling(rows)
        self.assertTrue(d["sentence"].startswith("测到的特征："))
        self.assertIn("更响", d["sentence"])
        self.assertIsNone(d["rolling"].get("key"))  # 没有 chroma：不报调性

    def test_too_short_returns_none(self):
        self.assertIsNone(songmap.rolling_map([{"t": 0, "energy": 0.5} for _ in range(5)]))


@unittest.skipIf(librosa is None, "需要 librosa")
class MeterGates(unittest.TestCase):
    def test_speaking_window_samples_not_in_history(self):
        """桌宠说话（duck 窗口）期间：特征行不进 history，live 特征也不被自己的声音覆盖。"""
        m = Meter(rate=48000)
        m.feed(sine(440, 3.0))
        m.tick_features()
        self.assertEqual(len(m.history), 1)
        m.duck(60.0)
        m.feed(sine(880, 1.0, amp=0.3))
        m.tick_features()
        self.assertEqual(len(m.history), 1)                                   # duck 内不记
        self.assertEqual(m.features.get("loud_db"), m.history[-1]["loud_db"])  # live 特征也没被覆盖
        m.duck_until = m.clock() - 1                                          # 窗口过期：恢复累计
        m._feat_at = 0                                                        # 1 秒节流重置（真节流不在此测）
        m.feed(sine(440, 1.0))
        m.tick_features()
        self.assertGreater(len(m.history), 1)

    def test_silence_samples_not_in_history(self):
        """暂停 / 音量 0：数字静音（rms < 1e-4）不进 history（last_feed 仍在更新的边界也算静音）。"""
        m = Meter(rate=48000)
        m.feed(np.zeros(48000 * 3, dtype=np.float32))
        m.tick_features()
        self.assertEqual(len(m.history), 0)
        m._feat_at = 0
        m.feed(sine(440, 3.0))
        m.tick_features()
        self.assertEqual(len(m.history), 1)

    def test_history_capped_at_600(self):
        """history 上限 600 行（stub 掉重计算，只验这条逻辑）。"""
        m = Meter(rate=48000)
        m.feed(sine(440, 3.0))
        m.analyzer.vector = lambda y, rate, heavy=True, tempo_y=None: {
            "energy": 0.5, "brightness": 0.5, "tempo": 120.0, "loud_db": -15.0,
            "onset": 0.0, "chroma": None, "mfcc": None, "perc": None}
        base = 1e9
        for i in range(620):
            m.clock = lambda i=i: (base + i * 2.0)
            m.feed(sine(440, 0.1))
            m.tick_features()
        self.assertEqual(len(m.history), 600)


@unittest.skipIf(librosa is None, "需要 librosa")
class VectorTiming(unittest.TestCase):
    def test_heavy_vector_under_budget_after_warmup(self):
        """单次（含 HPSS / chroma / mfcc）热态 < 80 ms；超了 Meter 自动降到每 3 秒一次。"""
        a = Analyzer()
        y = sine(440, 3.0, amp=0.2)
        a.vector(y, 48000, heavy=True)  # 首次触发 numba JIT，不计入
        worst = 0.0
        for _ in range(5):
            t0 = time.perf_counter()
            v = a.vector(y, 48000, heavy=True)
            worst = max(worst, (time.perf_counter() - t0) * 1000.0)
            self.assertEqual(len(v["chroma"]), 12)
            self.assertEqual(len(v["mfcc"]), 13)
        self.assertLess(worst, 80.0, f"热态单次 {worst:.1f} ms 超 80 ms 预算")

    def test_meter_downgrades_when_over_budget(self):
        """实测单次 > 80 ms → heavy_every 降到 3（每 3 秒算一次重特征）。"""
        m = Meter(rate=48000)
        m.feed(sine(440, 3.0, amp=0.2))

        def slow_vector(y, rate, heavy=True, tempo_y=None):
            time.sleep(0.09)  # 模拟慢机器上的重特征
            return {"energy": 0.5, "brightness": 0.5, "tempo": 120.0, "loud_db": -15.0,
                    "onset": 0.0, "chroma": None, "mfcc": None, "perc": None}

        m.analyzer.vector = slow_vector
        m.feed(sine(440, 1.0))
        m.tick_features()
        self.assertEqual(m.heavy_every, 3)


class Clap(unittest.TestCase):
    """CLAP 组件：模型没装时走纯数学路径 / skip，不算失败。"""

    def setUp(self):
        self.installed = clap.status()["state"] == "ready"

    def test_accumulate_and_summarize_math(self):
        """累计不足 3 次不报；每组只报前 2 名；top1 ≥ 0.35 才报；句子口径「模型听着像」。"""
        def with_probs(g, probs):
            # probs: {zh: 原始概率}，未给的均摊；返回全组 softmax（和为 1）
            items = [(it["zh"], 0.0) for it in clap.labels().get("groups", {}).get(g, [])]
            rest = max(0.0, 1.0 - sum(probs.values())) / max(1, len(items) - len(probs))
            pairs = []
            for zh, p0 in items:
                pairs.append((zh, probs.get(zh, rest)))
            total = sum(p for _z, p in pairs)
            return [(z, p / total) for z, p in pairs]
        acc = {}
        t1 = {"mood": with_probs("mood", {"伤感": 0.52, "温柔": 0.21, "欢快": 0.05, "激昂": 0.04})}
        clap.accumulate(acc, t1, alpha=0.5)
        self.assertIsNone(clap.summarize(acc))                     # 累计 1 次（< 3）：不报
        clap.accumulate(acc, t1, alpha=0.5)
        self.assertIsNone(clap.summarize(acc))                     # 2 次仍不报
        clap.accumulate(acc, t1, alpha=0.5)
        out = clap.summarize(acc)
        self.assertIsNotNone(out)                                  # 3 次起报
        self.assertEqual(out["mood"][0][0], "伤感")
        self.assertGreaterEqual(out["mood"][0][1], 0.35)
        # top1 < 0.35：这一组不报
        acc2 = {}
        t2 = {"genre": with_probs("genre", {"民谣": 0.30, "流行": 0.25})}
        for _ in range(4):
            clap.accumulate(acc2, t2, alpha=0.5)
        g = clap.summarize(acc2)
        self.assertTrue(g is None or "genre" not in g)
        # 句子口径
        s = clap.tags_sentence(out)
        self.assertIn("模型听着像", s)
        self.assertEqual(clap.tags_sentence(None), "")

    def test_status_shape(self):
        """状态视图字段齐全；state 随安装情况变化（装好是 ready，没装是 not_installed）。"""
        st = clap.status(enabled=False)
        for k in ("model_id", "dir", "enabled", "state", "backend", "emb_bytes", "disk_mb"):
            self.assertIn(k, st)
        self.assertIn(st["state"], ("ready", "not_installed"))

    def test_tagger_and_builder_take_no_args(self):
        # 参数曾叫 model_dir，盖住同名模块函数 → 不传参 None() TypeError
        tagger = clap.Tagger()
        self.assertEqual(tagger.dir, clap.model_dir())
        self.assertIsInstance(tagger.ready, bool)  # 没装：False，不抛

    def test_service_clap_path_never_raises(self):
        # 实例属性 _clap_tagger 曾盖住同名方法 → 打开 CLAP 后 now() 整个报错
        import json
        import tempfile
        from pathlib import Path
        from pixelmusic.__main__ import Service
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "music").mkdir()
            (Path(d) / "music" / "clap.json").write_text(json.dumps({"enabled": True}), encoding="utf-8")
            svc = Service.__new__(Service)
            svc._music_root = Path(d) / "music"
            svc._clap_obj = None
            svc._clap_acc = {}
            svc._clap_last_at = -1e9
            svc.clock = time.monotonic
            m = Meter()
            m.feed(sine(440, 3.0), 48000)
            self.assertIsInstance(svc._clap_tagger(), clap.Tagger)
            svc._clap_tags(m)  # 没装模型：返回 None，不抛

    @unittest.skipUnless(librosa is not None, "需要 librosa")
    def test_live_tempo_not_stuck_at_zero(self):
        # _estimate_tempo 被删、调用还在 → 回环 BPM 恒 0，librosa 特征静默退回 numpy
        rate = 48000
        y = np.zeros(rate * 3, dtype=np.float32)
        for k in range(6):  # 120 BPM 的咔哒
            i = int(k * 0.5 * rate)
            y[i:i + 400] = np.hanning(400).astype(np.float32) * 0.8
        a = Analyzer()
        f = a._librosa_features(y, rate)  # 不再 AttributeError
        self.assertGreater(f["tempo"], 0.0)
        self.assertGreater(a.vector(y, rate, True)["tempo"], 0.0)

    @unittest.skipUnless(clap.status()["state"] == "ready" and all(importlib.util.find_spec(m) for m in ("torch", "transformers")),
                         "CLAP 模型没装，或缺 torch / transformers：skip（装好后再跑）")
    def test_tag_real_audio(self):
        tagger = clap.Tagger()
        t = np.arange(48000 * 10, dtype=np.float32)
        y = (0.2 * np.sin(2 * np.pi * 220 * t / 48000)).astype(np.float32)
        out = tagger.tag(y)
        self.assertIn("mood", out)
        for _g, pairs in out.items():
            total = sum(p for _z, p in pairs)
            self.assertAlmostEqual(total, 1.0, places=2)


if __name__ == "__main__":
    unittest.main()


# ---------------- review 修复（2026-11-15 二轮） ----------------
class ReviewFixes(unittest.TestCase):
    """10 号 review 单要求补的用例：后台采样 / 歌曲位置时间轴 / 采样率 / 标点 / 最近突变。"""

    @unittest.skipIf(librosa is None, "需要 librosa")
    def test_background_tick_collects_without_requests(self):
        """不调用 now()：后台 tick 走 15 秒 → history ≥ 10 行；暂停期间不增长。"""
        from pixelmusic.__main__ import Service

        class Clock:
            v = 1000.0

            def __call__(self):
                return self.v

        clock = Clock()

        class Smtc:
            playing = True
            pos = 40.0

            def start(self):
                pass

            def stop(self):
                pass

            def snapshot(self):
                self.pos += 1.0
                return {"title": "X", "artist": "Y", "album": "", "playing": self.playing,
                        "position": self.pos, "duration": 200.0, "position_source": "estimated"}

        class Loop:
            running = False
            error = ""

            def set_active(self, on):
                pass

            def stop(self):
                pass

        m = Meter(rate=48000, clock=clock)
        smtc = Smtc()
        svc = Service(None, smtc=smtc, loopback=Loop(), cloud_meter=m)
        svc.clock = clock
        for i in range(15):
            clock.v += 1.0
            m.feed(np.random.default_rng(i).standard_normal(48000).astype(np.float32) * 0.1)
            m.last_rms = 0.2
            svc._tick_once()
        self.assertGreaterEqual(len(m.history), 10)
        n = len(m.history)
        smtc.playing = False
        for i in range(5):
            clock.v += 1.0
            m.feed(np.random.default_rng(i + 30).standard_normal(48000).astype(np.float32) * 0.1)
            m.last_rms = 0.2
            svc._tick_once()
        self.assertEqual(len(m.history), n)   # 暂停：不增长
        svc.close()

    def test_rolling_map_uses_song_position(self):
        """从 90 秒开始听：段落起点 ≥ 90；时间都用歌曲位置（不是行号）。"""
        rows = chord_rows(20, base_bin=0, energy=0.2, loud_db=-25.0)
        for i, r in enumerate(rows):
            r["pos"] = 90.0 + i
        m = songmap.rolling_map(rows)
        self.assertEqual(m["position_source"], "song")
        self.assertGreaterEqual(min(s["start"] for s in m["segments"]), 90.0)
        self.assertGreaterEqual(m["climax"]["time"], 90.0)
        self.assertEqual(m["position_end"], 109.0 + 1.0)

    @unittest.skipIf(librosa is None, "需要 librosa")
    def test_loop_and_seek_clear_history(self):
        """pos 回退 >10 秒（单曲循环/往回拖）或前拖 >30 秒：history 清空、epoch +1。"""
        m = Meter(rate=48000)
        m.feed(sine(440, 3.0), 48000)
        m.tick_features(170.0)
        m._feat_at = 0
        m.tick_features(171.0)
        self.assertEqual(len(m.history), 2)
        m._feat_at = 0
        m.tick_features(2.0)                      # 循环回到开头
        self.assertEqual(len(m.history), 1)
        self.assertEqual(m.epoch, 1)
        m._feat_at = 0
        m.tick_features(60.0)                     # 往前拖 58 秒
        self.assertEqual(len(m.history), 1)
        self.assertEqual(m.epoch, 2)

    def test_clap_resample_lengths(self):
        """44.1k / 22.05k 的输入送进模型前都必须是 480000 个采样。"""
        self.assertEqual(clap.resample_for_clap(np.zeros(44100, dtype=np.float32), 44100).size, 480000)
        self.assertEqual(clap.resample_for_clap(np.zeros(22050 * 10, dtype=np.float32), 22050).size, 480000)
        self.assertEqual(clap.resample_for_clap(np.zeros(1000, dtype=np.float32), 48000).size, 480000)

    def test_tags_punctuation_inserted_before_period(self):
        """「…）。；模型听着像…。」→「…）；模型听着像…。」"""
        tags = {"mood": [("伤感", 0.5)], "genre": [("民谣", 0.4)], "inst": [("吉他", 0.6)]}
        out = clap.with_tags("测到的特征：已听 1:00，第 1 段（系统回环实时测得）。", tags)
        self.assertIn("）；模型听着像", out)
        self.assertNotIn("）。；", out)
        self.assertTrue(out.endswith("。"))
        self.assertEqual(clap.with_tags("没有标签。", None), "没有标签。")

    def test_recent_change_independent_of_top6(self):
        """最近 10 秒里的突变即使幅度排不进前 6 也要报（单独从最近窗口找）。"""
        rows = []
        pos = 0.0
        # 先造 6 个更大幅度、但都在 30 秒以前的突变
        for _ in range(6):
            rows += chord_rows(5, base_bin=0, energy=0.15, loud_db=-28.0, pos0=pos)
            pos += 5
            rows += chord_rows(5, base_bin=1, energy=0.9, loud_db=-2.0, pos0=pos)
            pos += 5
            rows += chord_rows(5, base_bin=0, energy=0.15, loud_db=-28.0, pos0=pos)
            pos += 5
        rows += chord_rows(12, base_bin=0, energy=0.15, loud_db=-28.0, pos0=pos)
        pos += 12
        rows += chord_rows(6, base_bin=0, energy=0.42, loud_db=-20.0, pos0=pos)   # 最近 10 秒内 +8 dB
        m = songmap.rolling_map(rows)
        self.assertIsNotNone(m.get("recent_change"), m.get("changes"))
        self.assertEqual(m["recent_change"]["direction"], "变响")

    def test_local_tags_scheduled_once_analysis_ready(self):
        """review 6：整曲解析完成、缓存里还没有 clap_tags 时排队（原先只在「解析没完成」分支排队 → 永远算不出）；
        CLAP 关着时排队的函数自己不干活。"""
        import json
        import tempfile
        from pathlib import Path
        from unittest import mock
        from pixelmusic.__main__ import Service

        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "music").mkdir()
            flag = Path(d) / "music" / "clap.json"
            flag.write_text(json.dumps({"enabled": True}), encoding="utf-8")
            svc = Service.__new__(Service)
            svc._music_root = Path(d) / "music"
            svc._clap_bg = None
            svc._clap_acc = {}
            svc._clap_epoch = 0
            svc._clap_last_at = 0.0
            svc._clap_error = ""
            svc.clock = time.monotonic
            svc.meter = Meter()
            svc.cloud_meter = Meter()
            svc.worker = mock.Mock()
            svc.worker.schedule.return_value = "ready"
            svc._scope_note = lambda: "测试"
            svc.local = mock.Mock()
            svc.local.current_path.return_value = "x.mp3"
            svc._clap_obj = mock.Mock(ready=True)
            calls = []
            orig = Service._clap_schedule_local_tags

            def spy(self_, path, res=None):
                calls.append(str(path))
                return orig(self_, path, res)

            with mock.patch.object(Service, "_clap_schedule_local_tags", spy),                  mock.patch.object(songmap, "lookup", lambda p: {"version": 1, "segments": []}),                  mock.patch.object(clap, "tag_file", lambda path, tagger: None):
                svc._heard("local", {"position": 10.0, "title": "t", "artist": "a"})
                self.assertEqual(len(calls), 1)          # 解析完成分支排了队
                self.assertIsNotNone(svc._clap_bg)       # 真起了后台线程
                svc._clap_bg.join(2)
                # CLAP 关着：排队函数直接返回，不起线程
                flag.write_text(json.dumps({"enabled": False}), encoding="utf-8")
                svc._clap_bg = None
                svc._clap_schedule_local_tags("x.mp3", {"version": 1})
                self.assertIsNone(svc._clap_bg)


if __name__ == "__main__":
    unittest.main()
