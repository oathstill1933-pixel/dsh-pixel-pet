"""File-only analysis with generated samples and an isolated service profile."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock
import wave

from helpers import ROOT

sys.path.insert(0, str(Path(ROOT) / "runtime/music"))
import numpy as np
from pixelmusic import clap, songmap
from pixelmusic.__main__ import Service, handle


class FileAnalysisTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.service = Service(self.root / "profile")
        self.addCleanup(songmap.set_cache_dir, None)
        try:
            import soundfile
        except ImportError:
            self.skipTest("需要 soundfile")
        self.samplerate = 22050

    def sample(self, seconds, *, quiet=False):
        y = np.arange(round(seconds * self.samplerate), dtype=np.float64) / self.samplerate
        vals = np.zeros_like(y) if quiet else 0.25 * np.sin(2 * np.pi * 440 * y)
        path = self.root / f"{seconds}-{int(quiet)}.wav"
        with wave.open(str(path), "wb") as f:
            f.setparams((1, 2, self.samplerate, 0, "NONE", "not compressed"))
            f.writeframes((vals * 32767).astype("<i2").tobytes())
        return path

    def analyze(self, p):
        return self.service.control({"action": "analyze_file", "value": {"path": str(p)}})

    def test_short_sine_returns_finite_acoustics_and_a4_without_playback(self):
        with mock.patch.object(self.service, "start", side_effect=AssertionError("started playback service")):
            result = self.analyze(self.sample(3))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["kind"], "short")
        self.assertEqual(result["seconds"], 3)
        self.assertIsNone(result["tags"])
        self.assertGreater(result["numbers"]["audible_ratio"], .98)
        if songmap.available():
            self.assertEqual(result["numbers"]["pitch_note"], "A4")
            self.assertAlmostEqual(result["numbers"]["pitch_hz"], 440, delta=10)
        self.assertIn("不转写说话内容", result["sentence"])
        self.assertNotIn(str(self.root), json.dumps(result, allow_nan=False, ensure_ascii=False))

    def test_short_measurements_also_work_without_librosa(self):
        with mock.patch.object(songmap, "librosa", None):
            result = self.analyze(self.sample(3))
        self.assertTrue(result["ok"], result)
        self.assertNotIn("pitch_hz", result["numbers"])

    def test_silence_and_too_short(self):
        silent = self.analyze(self.sample(3, quiet=True))
        self.assertIn("几乎没有声音", silent["sentence"])
        self.assertEqual(silent["numbers"]["audible_ratio"], 0)
        self.assertEqual(self.analyze(self.sample(.3))["code"], "too_short")

    @unittest.skipUnless(songmap.available(), "需要 librosa")
    def test_twelve_second_file_reuses_songmap_and_cache(self):
        path = self.sample(12)
        with mock.patch.object(songmap, "analyze_path", wraps=songmap.analyze_path) as whole:
            result = self.analyze(path)
            self.assertEqual(result.get("kind"), "full", result)
            self.assertEqual(result["seconds"], 12)
            self.assertFalse(result["truncated"])
            self.assertEqual(result["tags"], None)
            self.assertTrue(result["numbers"]["segments"])
            self.assertEqual(self.analyze(path), result)
            whole.assert_called_once_with(path)
        self.assertIsNotNone(songmap.lookup(path))

    @unittest.skipUnless(songmap.available(), "需要 librosa")
    def test_pipe_returns_file_analysis_with_stdin_open(self):
        file = self.sample(12)
        profile = self.root / "pipe-profile"
        env = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
        proc = subprocess.Popen([sys.executable, "-B", "-X", "utf8", "-m", "pixelmusic", "--data-dir", str(profile)],
                                cwd=Path(ROOT) / "runtime/music", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, encoding="utf-8", env=env)
        replies = queue.Queue()

        def read():
            for line in proc.stdout:
                replies.put(json.loads(line))

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            req = {"command": "control", "id": 1,
                   "args": {"action": "analyze_file", "value": {"path": str(file)}}}
            proc.stdin.write(json.dumps(req) + "\n")
            proc.stdin.write(json.dumps({"command": "ping", "id": 2}) + "\n")
            proc.stdin.flush()
            a = replies.get(timeout=30)
            b = replies.get(timeout=30)
            messages = {m["id"]: m["data"] for m in (a, b)}
            self.assertTrue(messages[2]["pong"])
            self.assertEqual(messages[1]["kind"], "full")
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            reader.join(timeout=2)
            proc.stdin.close()
            proc.stdout.close()

    def test_long_file_marks_truncation(self):
        path = self.sample(1)
        summary = {"segments": [], "tempo": {"bpm": 90.0}}
        with mock.patch("soundfile.info", return_value=types.SimpleNamespace(duration=910)), \
                mock.patch.object(songmap, "available", return_value=True), \
                mock.patch.object(songmap, "analyze_path", return_value=summary) as analyze:
            result = self.analyze(path)
        analyze.assert_called_once_with(path)
        self.assertEqual((result["kind"], result["seconds"], result["truncated"]), ("full", 910, True))
        self.assertIn("前 15 分钟", result["sentence"])

    def test_concurrent_same_file_waits_then_reuses_result(self):
        path = self.sample(1)
        start = threading.Event()
        finish = threading.Event()
        received = []
        stub = {"ok": True, "file": path.name, "kind": "short", "sentence": "测到的特征。",
                "seconds": 1, "numbers": {}, "tags": None, "truncated": False}

        def measure(*_args):
            start.set()
            finish.wait(3)
            return stub

        analyzer = self.service.file_analyzer
        with mock.patch.object(analyzer, "_measure", side_effect=measure) as method:
            jobs = [threading.Thread(target=lambda: received.append(self.analyze(path))) for _ in range(2)]
            jobs[0].start()
            self.assertTrue(start.wait(2))
            jobs[1].start()
            other = self.sample(2)
            self.assertEqual(self.analyze(other)["code"], "busy")
            finish.set()
            for job in jobs:
                job.join(3)
            self.assertEqual(received, [stub, stub])
            self.assertEqual(self.analyze(path), stub)
            method.assert_called_once()

    def test_clap_pads_short_audio_and_maps_kind_only_at_threshold(self):
        class Tagger:
            ready = True

            def __init__(self):
                self.probs = [.7, .3]

            def tag(self, y, *, include_kind=False):
                assert y.size == clap.SR * 10 and np.count_nonzero(y[clap.SR * 3 + 100:]) == 0
                assert include_kind
                return {"kind": [(name, prob) for name, prob in zip(
                    ["说话", "纯音乐", "音效", "环境声", "唱歌"], self.probs)]}

        analyzer = self.service.file_analyzer
        analyzer.tags_enabled = lambda: True
        tagger = Tagger()
        analyzer.tagger = lambda: tagger
        with mock.patch.object(clap, "status", return_value={"state": "ready"}), \
                mock.patch.object(songmap, "librosa", None):
            a = self.analyze(self.sample(3))
            self.assertEqual(a["tags"]["kind"][0][0], "说话")
            self.assertIn("听着像", a["sentence"])
            tagger.probs = [.24, .21, .2, .18, .17]
            self.assertIsNone(self.analyze(self.sample(2.5))["tags"])

    def test_service_response_hides_decoder_exception_details(self):
        path = self.sample(1)
        replies = []
        with mock.patch("soundfile.info", side_effect=RuntimeError(str(path))):
            handle(self.service, replies.append, 5, "control", {"action": "analyze_file", "value": {"path": str(path)}})
        self.assertEqual(replies[0]["data"]["code"], "analysis_failed")
        self.assertNotIn(str(self.root), json.dumps(replies, ensure_ascii=False, allow_nan=False))
        self.assertEqual(self.analyze(path.with_suffix(".amr"))["code"], "unsupported")


class FolderRevocationTests(unittest.TestCase):
    def test_window_settings_save_cannot_restore_revoked_folders(self):
        from pixelpet.app import load_settings, save_settings
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "settings.json"
            path.write_text(json.dumps({"listen": {"enabled": True, "audioDirs": [scratch]}}))
            stale = load_settings(scratch)
            path.write_text(json.dumps({"listen": {"enabled": True, "audioDirs": []}}))
            save_settings(scratch, stale)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["listen"]["audioDirs"], [])


class ClapKindTests(unittest.TestCase):
    def test_realtime_summaries_explicitly_ignore_kind(self):
        acc = {}
        for _ in range(3):
            clap.accumulate(acc, {"mood": [("平静", .8), ("激昂", .2)], "kind": [("说话", .8), ("纯音乐", .2)]})
        self.assertNotIn("kind", clap.summarize(acc))
        self.assertIn("kind", clap.summarize(acc, include_kind=True))
        self.assertEqual(clap.tags_sentence({"kind": [["说话", .9]]}), "")
        self.assertIn("说话", clap.tags_sentence({"kind": [["说话", .9]]}, include_kind=True))

    def test_new_labels_hash_invalidates_builder_cache_and_updates_four_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            groups = clap.labels()["groups"]
            old_groups = {k: v for k, v in groups.items() if k != "kind"}
            old_hash = clap.labels_hash(old_groups)
            self.assertNotEqual(old_hash, clap.labels_hash(groups))
            np.save(root / "label_emb.npy", np.ones((sum(map(len, old_groups.values())), 3)))
            (root / "labels_meta.json").write_text(json.dumps({"labels_hash": old_hash, "model_id": clap.MODEL_ID}), encoding="utf8")
            fake = types.SimpleNamespace(from_pretrained=lambda *a, **kw: types.SimpleNamespace(eval=lambda: None))
            model = types.SimpleNamespace(ClapModel=fake, ClapProcessor=fake)
            with mock.patch.dict(sys.modules, {"transformers": model}), \
                    mock.patch.object(clap, "_text_vectors", side_effect=lambda m, p, prompt: np.ones((len(prompt), 3))) as encode:
                result = clap.build_label_emb(root)
                self.assertEqual(encode.call_count, 4)
                self.assertEqual(result["labels"], sum(map(len, groups.values())))
                self.assertTrue(clap.build_label_emb(root)["cached"])
                self.assertEqual(encode.call_count, 4)
            self.assertEqual(clap._groups_for_hash(groups, old_hash), ("mood", "genre", "inst"))


if __name__ == "__main__":
    unittest.main()
