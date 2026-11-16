import hashlib
import http.server
import io
import json
import os
import re
import sys
import tarfile
import threading
import time
import unittest
import unittest.mock
import wave
import zipfile

from helpers import ROOT, tmpdir

from pixelpet.voice import DependencyMissing, RouteUnset, VoiceError
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.deps import CATALOG, Dependencies, NotConfigured, component_rev
from pixelpet.voice.fetch import DownloadError, IntegrityError, extract, extract_tar, fetch_file
from pixelpet.voice.llm import NoRoute, SessionRoute, StubLlm, make_llm
from pixelpet.voice.stt import HostStt, LocalHttpStt, NoStt, StubStt, make_stt, resample16k
from pixelpet.voice.tts import (CustomTts, QwenTts, StubTts, VoiceStore, concat_wavs, make_tts, split_sentences,
                                split_template)

def read(p):
    with open(p, "rb") as f:
        return f.read()


HEX64 = re.compile(r"^[0-9a-f]{64}$")


def make_wav(path, seconds=0.2, rate=16000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * int(rate * seconds))
    return path


class Recorder:
    def __init__(self):
        self.states, self.played, self.stops = [], [], 0

    def on_state(self, s):
        self.states.append(s)

    def play(self, path):
        self.played.append(path)

    def stop(self):
        self.stops += 1


def bridge(data, stt=None, llm=None, rec=None, tts=None):
    rec = rec or Recorder()
    return VoiceBridge(stt or StubStt("你好"), tts or StubTts(data), llm or StubLlm(), play=rec.play, stop=rec.stop,
                       on_state=rec.on_state), rec


# ------------------------------------------------------------------------------------------ fake HTTP server
class Blob(http.server.BaseHTTPRequestHandler):
    files = {}
    log = []
    honor_range = True
    cut_after = None          # bytes: drop the connection after this many on a full (non-range) request

    def log_message(self, *a):
        pass

    def do_GET(self):
        data = self.files.get(self.path)
        rng = self.headers.get("Range")
        Blob.log.append((self.path, rng))
        if data is None:
            self.send_response(404)
            self.end_headers()
            return
        if rng and self.honor_range:
            start = int(rng.split("=")[1].split("-")[0])
            if start >= len(data):
                self.send_response(416)
                self.end_headers()
                return
            body = data[start:]
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, len(data) - 1, len(data)))
        else:
            body = data
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.cut_after is not None and not rng:
            self.wfile.write(body[:self.cut_after])
            self.wfile.flush()
            self.connection.shutdown(2)
            return
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8"))
        Blob.log.append((self.path, body))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(b"\x00\x00" * 2400)
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server:
    def __enter__(self):
        Blob.files, Blob.log, Blob.honor_range, Blob.cut_after = {}, [], True, None
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Blob)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        return self

    def add(self, path, data):
        Blob.files[path] = data
        return {"path": path.lstrip("/"), "url": self.base + path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()


# ------------------------------------------------------------------------------------------ catalog
class Catalog(unittest.TestCase):
    def test_catalog_is_pinned_and_public(self):
        comps = CATALOG["components"]
        ids = [c["id"] for c in comps]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), {"py-deps", "qwen3-tts-engine", "qwen3-tts-model", "python-runtime", "speaker-model"})
        allowed = ("huggingface.co", "raw.githubusercontent.com", "github.com")
        for c in comps:
            if c["id"] == "speaker-model":
                self.assertFalse(c.get("auto"), "speaker model must stay opt-in")
            else:
                self.assertTrue(c.get("auto"), c["id"])
            if c["kind"] == "pip":
                self.assertTrue(c["packages"] and c["modules"])
                continue
            paths = set()
            for f in c["files"]:
                self.assertRegex(f["url"], r"^https://(%s)/" % "|".join(re.escape(h) for h in allowed))
                self.assertRegex(f["sha256"], HEX64)
                self.assertIsInstance(f["size"], int)
                self.assertNotIn("..", f["path"].split("/"))
                self.assertFalse(re.match(r"^[A-Za-z]:|^/", f["path"]))
                self.assertNotIn(f["path"], paths)
                paths.add(f["path"])
                if "huggingface.co" in f["url"]:
                    self.assertRegex(f["url"], r"/resolve/[0-9a-f]{40}/")      # pinned revision, not main
                if "raw.githubusercontent.com" in f["url"]:
                    self.assertRegex(f["url"], r"/[0-9a-f]{40}/")
            total = sum(f["size"] for f in c["files"])
            if c["id"] == "speaker-model":
                self.assertGreater(total, 0)
            else:
                self.assertEqual(c["size"], total)
        model = next(c for c in comps if c["id"] == "qwen3-tts-model")
        names = {os.path.basename(f["path"]) for f in model["files"]}
        for need in ("qwen3_tts_talker.q5_k.gguf", "qwen3_tts_predictor.q8_0.gguf", "qwen3_tts_decoder.fp16.onnx",
                     "qwen3_tts_speaker_encoder.fp16.onnx", "qwen3_tts_codec_encoder.fp16.onnx", "tokenizer.json",
                     "text_embedding_projected.npy", "codec_embedding_15.npy"):
            self.assertIn(need, names)

    def test_rev_tracks_file_set(self):
        a = {"files": [{"path": "a", "sha256": "0" * 64, "size": 1}]}
        b = {"files": [{"path": "a", "sha256": "1" * 64, "size": 1}]}
        self.assertNotEqual(component_rev(a), component_rev(b))


# ------------------------------------------------------------------------------------------ downloader
class Fetch(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.data = os.urandom(300_000)

    def test_full_download_and_present(self):
        with Server() as s:
            e = s.add("/m/a.bin", self.data)
            dest = os.path.join(self.dir, "a.bin")
            seen = []
            self.assertEqual(fetch_file(e, dest, progress=lambda d, t: seen.append(d)), "download")
            self.assertEqual(read(dest), self.data)
            self.assertEqual(seen[-1], len(self.data))
            self.assertFalse(os.path.exists(dest + ".part"))
            n = len(Blob.log)
            self.assertEqual(fetch_file(e, dest), "present")
            self.assertEqual(len(Blob.log), n)

    def test_resume_with_range(self):
        with Server() as s:
            e = s.add("/m/b.bin", self.data)
            dest = os.path.join(self.dir, "b.bin")
            with open(dest + ".part", "wb") as f:
                f.write(self.data[:123_456])
            self.assertEqual(fetch_file(e, dest), "download")
            self.assertEqual(Blob.log, [("/m/b.bin", "bytes=123456-")])
            self.assertEqual(read(dest), self.data)

    def test_interrupted_then_resumed(self):
        with Server() as s:
            e = s.add("/m/c.bin", self.data)
            Blob.cut_after = 100_000
            dest = os.path.join(self.dir, "c.bin")
            self.assertEqual(fetch_file(e, dest, sleep=lambda s: None), "download")
            self.assertIsNone(Blob.log[0][1])
            self.assertTrue(any(r and r.startswith("bytes=") for _, r in Blob.log[1:]))
            self.assertEqual(read(dest), self.data)

    def test_server_ignores_range_restarts(self):
        with Server() as s:
            e = s.add("/m/d.bin", self.data)
            Blob.honor_range = False
            dest = os.path.join(self.dir, "d.bin")
            with open(dest + ".part", "wb") as f:
                f.write(b"garbage" * 100)
            self.assertEqual(fetch_file(e, dest), "download")
            self.assertEqual(read(dest), self.data)

    def test_sha_mismatch_rejected_and_partial_dropped(self):
        with Server() as s:
            e = s.add("/m/e.bin", self.data)
            e["sha256"] = "0" * 64
            dest = os.path.join(self.dir, "e.bin")
            with self.assertRaises(IntegrityError):
                fetch_file(e, dest)
            self.assertFalse(os.path.exists(dest))
            self.assertFalse(os.path.exists(dest + ".part"))

    def test_http_errors_and_url_policy(self):
        with Server() as s:
            e = s.add("/m/f.bin", self.data)
            e["url"] = s.base + "/missing"
            with self.assertRaises(DownloadError):
                fetch_file(e, os.path.join(self.dir, "f.bin"))
        with self.assertRaises(DownloadError):
            fetch_file({"url": "http://example.com/x", "sha256": "0" * 64, "size": 1, "path": "x"}, os.path.join(self.dir, "x"))

    def test_local_cache_bypasses_network(self):
        cache = tmpdir()
        os.makedirs(os.path.join(cache, "embeddings"))
        with open(os.path.join(cache, "embeddings", "g.npy"), "wb") as f:
            f.write(self.data)
        e = {"path": "embeddings/g.npy", "url": "https://example.invalid/g.npy",
             "sha256": hashlib.sha256(self.data).hexdigest(), "size": len(self.data)}
        dest = os.path.join(self.dir, "g.npy")
        self.assertEqual(fetch_file(e, dest, cache_dirs=[cache]), "cache")
        self.assertEqual(read(dest), self.data)

    def test_empty_file(self):
        e = {"path": "__init__.py", "url": "https://example.invalid/x", "sha256": hashlib.sha256(b"").hexdigest(), "size": 0}
        dest = os.path.join(self.dir, "__init__.py")
        fetch_file(e, dest)
        self.assertEqual(os.path.getsize(dest), 0)

    def test_extract_flat_and_filtered(self):
        z = os.path.join(self.dir, "bin.zip")
        with zipfile.ZipFile(z, "w") as zf:
            zf.writestr("build/bin/llama.dll", b"a")
            zf.writestr("../evil.dll", b"b")
            zf.writestr("llama-cli.exe", b"c")
        out = extract(z, os.path.join(self.dir, "bin"), ["*.dll"])
        self.assertEqual(sorted(out), ["evil.dll", "llama.dll"])
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "bin", "evil.dll")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "evil.dll")))


class Tar(unittest.TestCase):
    """the portable Python runtime arrives as a .tar.gz tree, not a flat zip"""

    def setUp(self):
        self.dir = tmpdir()

    def _targz(self, entries):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for name, data, kind in entries:
                info = tarfile.TarInfo(name)
                if kind == "dir":
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    tf.addfile(info)
                    continue
                if kind == "link":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/passwd"
                    tf.addfile(info)
                    continue
                info.size = len(data)
                info.mode = 0o644
                tf.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    def test_extract_tar_keeps_tree_and_strips_prefix(self):
        gz = os.path.join(self.dir, "py.tar.gz")
        with open(gz, "wb") as f:
            f.write(self._targz([
                ("python/", b"", "dir"),
                ("python/python.exe", b"MZ", "file"),
                ("python/Lib/os.py", b"x = 1\n", "file"),
                ("python/tcl/tk8.6/init.tcl", b"package provide Tk 8.6\n", "file"),
            ]))
        out = os.path.join(self.dir, "python")
        self.assertEqual(extract_tar(gz, out, strip=1), 3)
        self.assertTrue(os.path.isfile(os.path.join(out, "python.exe")))
        self.assertEqual(read(os.path.join(out, "Lib", "os.py")), b"x = 1\n")
        self.assertTrue(os.path.isfile(os.path.join(out, "tcl", "tk8.6", "init.tcl")))
        self.assertFalse(os.path.exists(os.path.join(out, "python")))

    def test_extract_tar_refuses_escapes_and_links(self):
        gz = os.path.join(self.dir, "evil.tar.gz")
        with open(gz, "wb") as f:
            f.write(self._targz([
                ("python/ok.txt", b"fine", "file"),
                ("python/../../escaped.txt", b"no", "file"),
                ("/abs.txt", b"no", "file"),
                ("python/link", b"", "link"),
            ]))
        out = os.path.join(self.dir, "dest")
        extract_tar(gz, out, strip=1)
        self.assertTrue(os.path.isfile(os.path.join(out, "ok.txt")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "escaped.txt")))
        self.assertFalse(os.path.exists(os.path.join(out, "abs.txt")))
        self.assertFalse(os.path.lexists(os.path.join(out, "link")))

    def test_component_dest_installs_outside_models(self):
        data = tmpdir()
        blob = b"runtime-archive-bytes"
        with Server() as s:
            entry = s.add("/py/rt.tar.gz", blob)
            entry["extract"] = {"archive": "tar.gz", "to": "", "strip": 1}
            cat = {"components": [{"id": "python-runtime", "kind": "files", "auto": True, "dest": "runtime/python",
                                   "files": [entry]}]}
            opener = None
            # the archive itself is nonsense: only the download path, dest and marker matter here
            d = Dependencies(data, catalog=cat, cache_dirs=[])
            with self.assertRaises(tarfile.ReadError):
                d.install("python-runtime")
            self.assertEqual(d.path("python-runtime"), os.path.join(data, "runtime", "python"))
            self.assertEqual([x["id"] for x in d.status()], ["python-runtime"])

    def test_dest_cannot_escape_the_data_dir(self):
        data = tmpdir()
        cat = {"components": [{"id": "bad", "kind": "files", "dest": "../outside", "files": []}]}
        d = Dependencies(data, catalog=cat, cache_dirs=[])
        with self.assertRaises(NotConfigured):
            d.path("bad")

    def test_shipped_catalog_pins_the_python_runtime(self):
        comp = [c for c in CATALOG["components"] if c["id"] == "python-runtime"][0]
        f = comp["files"][0]
        self.assertTrue(comp["auto"])
        self.assertEqual(comp["dest"], "runtime/python")
        self.assertEqual(comp["files"] and f["platform"], "win32")
        self.assertEqual(f["size"], 39573204)
        self.assertEqual(f["sha256"], "cb023e83e42d8937ba77c7cf83641083c3b81e88e1226e1c694a347ae1924d54")
        self.assertTrue(f["url"].startswith("https://github.com/astral-sh/python-build-standalone/releases/download/"))
        self.assertEqual(f["extract"], {"archive": "tar.gz", "to": "", "strip": 1, "include": ["*"]})
        self.assertEqual(len(component_rev(comp)), 16)


# ------------------------------------------------------------------------------- 首句短切 / 预热 / 空闲
class FirstShortSplit(unittest.TestCase):
    """D: only the first chunk is cut short, at a comma after 6-14 characters."""

    def test_long_first_sentence_is_cut_at_a_comma(self):
        got = split_sentences("我觉得这个方案挺不错的，不过我们得先看看预算，再决定要不要继续往下做。")
        self.assertGreaterEqual(len(got), 2)
        self.assertTrue(got[0].endswith("，"))
        self.assertLessEqual(len(got[0]), 14)
        self.assertEqual("".join(got), "我觉得这个方案挺不错的，不过我们得先看看预算，再决定要不要继续往下做。")

    def test_no_comma_in_window_leaves_the_sentence_alone(self):
        text = "一二三四五六七八九十十一十二十三十四十五，后面还有很多内容需要继续说下去才行。"
        self.assertEqual(split_sentences(text), [text])        # the only comma sits after 14 chars
        self.assertEqual(split_sentences("好呀。"), ["好呀。"])

    def test_early_comma_is_skipped_in_favour_of_the_next_one(self):
        got = split_sentences("嗯，我觉得这个方案挺不错的，后面还有很长的话要说清楚才行。")
        self.assertTrue(got[0].endswith("，"))
        self.assertLessEqual(len(got[0]), 14)
        self.assertGreater(len(got[0]), 4)

    def test_can_be_turned_off(self):
        text = "我觉得这个方案挺不错的，不过我们得先看看预算。"
        self.assertEqual(len(split_sentences(text, first_short=False)), 1)
        self.assertGreaterEqual(len(split_sentences(text)), 2)


class WarmAndIdle(unittest.TestCase):
    """A: warm_async is non-blocking and coalesced; M4: idle never kills an in-flight request."""

    def _tts(self):
        from pixelpet.voice.tts import QwenTts
        deps = Dependencies(tmpdir(), cache_dirs=[])
        store = VoiceStore(tmpdir(), ROOT)
        return QwenTts(tmpdir(), deps, store)

    def test_warm_async_returns_immediately_and_coalesces(self):
        tts = self._tts()
        started = threading.Event()

        def slow_start():
            started.set()
            time.sleep(0.6)
        tts._start = slow_start
        t0 = time.monotonic()
        self.assertTrue(tts.warm_async())
        self.assertLess(time.monotonic() - t0, 0.3)
        self.assertTrue(started.wait(1.0))
        self.assertFalse(tts.warm_async(), "a second call while loading must not start another load")
        self.assertIsNone(tts.warm_result(timeout=0), "still running")
        tts._warm_thread.join(3)
        self.assertEqual(tts.warm_result(), {"ok": True, "s": unittest.mock.ANY})
        tts.close()

    def test_warm_failure_is_recorded_not_raised(self):
        tts = self._tts()

        def boom():
            raise RuntimeError("显存不足")
        tts._start = boom
        self.assertTrue(tts.warm_async())
        tts._warm_thread.join(3)
        done = tts.warm_result()
        self.assertFalse(done["ok"])
        self.assertIn("显存不足", tts.last_error)
        self.assertTrue(tts.warm_async(), "a failed warm can be retried")
        tts._warm_thread.join(3)
        tts.close()

    def test_close_during_warm_does_not_revive_it(self):
        tts = self._tts()
        gate = threading.Event()
        entered = threading.Event()

        def slow_need():
            entered.set()
            gate.wait(2)
            raise RuntimeError("stop here")      # never let the real worker process start in a test
        tts._need = slow_need
        tts.warm_async()
        self.assertTrue(entered.wait(1.0))
        closer = threading.Thread(target=tts.close)
        closer.start()
        gate.set()
        closer.join(5)
        self.assertIsNone(tts._proc, "close leaves no worker behind")
        with self.assertRaises(VoiceError):
            tts._start()                         # a load attempted after close must be refused
        with self.assertRaises(VoiceError):
            tts.request({"op": "ping"}, timeout=1)

    def test_idle_never_kills_an_in_flight_request(self):
        tts = self._tts()
        killed = []
        tts._kill = lambda: killed.append(1)
        tts.idle_s = 120
        tts._last = 0.0                  # long idle
        tts._busy = 1
        tts._idle_check()
        self.assertEqual(killed, [], "a request was in flight")
        self.assertGreater(tts._last, 0.0, "the timer must be re-armed, not fired")
        tts._busy = 0
        tts._last = 0.0
        tts._idle_check()
        self.assertEqual(killed, [1])
        tts.close()

    def test_idle_switch_and_constants(self):
        from pixelpet.voice.tts import IDLE_LISTENING_SECONDS, IDLE_SECONDS
        self.assertEqual((IDLE_SECONDS, IDLE_LISTENING_SECONDS), (120, 1800))
        tts = self._tts()
        self.assertTrue(tts.set_idle(IDLE_LISTENING_SECONDS))
        self.assertEqual(tts.idle_s, 1800)
        self.assertTrue(tts.set_idle(IDLE_SECONDS))
        self.assertEqual(tts.idle_s, 120)
        tts.close()


class PatchGuards(unittest.TestCase):
    """M1/M2: an upstream that does not match the pinned hashes must be left completely unpatched."""

    def setUp(self):
        self._qwen_modules = {k: v for k, v in sys.modules.items() if k.startswith("qwen3_tts_gguf")}
        def restore():
            for key in list(sys.modules):
                if key.startswith("qwen3_tts_gguf"):
                    sys.modules.pop(key)
            sys.modules.update(self._qwen_modules)
        self.addCleanup(restore)

    @staticmethod
    def _fake_decoder_state():
        """A stand-in `qwen3_tts_gguf.inference.schema.protocol` so the cache test needs no engine install."""
        import dataclasses
        import types
        names = ["qwen3_tts_gguf", "qwen3_tts_gguf.inference", "qwen3_tts_gguf.inference.schema",
                 "qwen3_tts_gguf.inference.schema.protocol"]
        for n in names:
            if n not in sys.modules:
                mod = types.ModuleType(n)
                mod.__path__ = []
                sys.modules[n] = mod

        @dataclasses.dataclass
        class DecoderState:
            pre_conv_history: object = None
            latent_buffer: object = None
            conv_history: object = None
            kv_cache: list = dataclasses.field(default_factory=list)
            skip_samples: int = 0
            latent_audio: object = None

        sys.modules[names[-1]].DecoderState = DecoderState
        return DecoderState

    def test_decoder_state_cache_fingerprints(self):
        import numpy as np
        import tts_worker as W
        DecoderState = self._fake_decoder_state()
        spec = {"stateDir": tmpdir(), "anchorSha": "a" * 64, "modelRev": "rev1"}

        class Voice:
            pass
        voice = Voice()
        voice.codes = np.zeros((3, 16), dtype=np.int64)
        voice.final_state = DecoderState(
            pre_conv_history=np.zeros((1, 512, 2), dtype=np.float16),
            latent_buffer=np.zeros((1, 1024, 4), dtype=np.float16),
            conv_history=np.zeros((1, 1024, 4), dtype=np.float16),
            kv_cache=[np.zeros((1, 16, 72, 64), dtype=np.float16) for _ in range(16)],
            skip_samples=7680, latent_audio=np.zeros(16, dtype=np.float32))
        path = W._state_path(spec, "DML", "1.24.4")
        codes_sha = W._codes_sha(voice.codes)
        self.assertTrue(W._state_save(path, spec, "DML", "1.24.4", voice))
        # exactly the layouts decoder.py produces survive the load
        loaded = W._state_load(path, spec, "DML", "1.24.4", codes_sha)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.skip_samples, 7680)
        self.assertEqual(len(loaded.kv_cache), 16)
        self.assertEqual(loaded.pre_conv_history.shape, (1, 512, 2))
        self.assertEqual(loaded.latent_audio.dtype.name, "float32")
        # every part of the fingerprint matters
        self.assertIsNone(W._state_load(path, spec, "CPU", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, spec, "DML", "1.23.0", codes_sha))
        self.assertIsNone(W._state_load(path, dict(spec, anchorSha="b" * 64), "DML", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, dict(spec, modelRev="rev2"), "DML", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", "deadbeef"))
        # a damaged, foreign or hostile file is a cache miss, never a crash
        with open(path, "wb") as f:
            f.write(b"not an npz at all")
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", codes_sha))

    def test_cache_rejects_wrong_shapes_and_non_finite_members(self):
        import numpy as np
        import tts_worker as W
        DecoderState = self._fake_decoder_state()
        spec = {"stateDir": tmpdir(), "anchorSha": "a" * 64, "modelRev": "r"}
        codes_sha = W._codes_sha(np.zeros((1, 16), dtype=np.int64))   # what _state_save records
        good = dict(
            pre_conv_history=np.zeros((1, 512, 2), dtype=np.float16),
            latent_buffer=np.zeros((1, 1024, 4), dtype=np.float16),
            conv_history=np.zeros((1, 1024, 4), dtype=np.float16),
            kv_cache=[np.zeros((1, 16, 72, 64), dtype=np.float16) for _ in range(16)],
            skip_samples=0, latent_audio=None)
        path = W._state_path(spec, "CPU", "1")

        def save(**over):
            state = DecoderState(**dict(good, **over))
            voice = type("V", (), {"codes": np.zeros((1, 16), dtype=np.int64), "final_state": state})()
            return W._state_save(path, spec, "CPU", "1", voice)

        self.assertTrue(save())
        self.assertIsNotNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        # (2,5,7) instead of (1,512,N): a real schema mismatch must not be accepted
        self.assertTrue(save(pre_conv_history=np.zeros((2, 5, 7), dtype=np.float16)))
        self.assertIsNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        self.assertTrue(save(kv_cache=[np.zeros((3, 2, 4, 5), dtype=np.float16)] * 2))
        self.assertIsNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        nan = np.zeros((1, 1024, 4), dtype=np.float16)
        nan[0, 0, 0] = np.inf
        self.assertFalse(save(latent_buffer=nan))         # the write side refuses non-finite data
        # …and a file that carries it anyway (other version, edited file) is refused on read too
        with open(path, "wb") as f:
            np.savez_compressed(f, **dict(good, latent_buffer=nan, _schema=np.int64(W.STATE_SCHEMA),
                                          _anchor_sha="a" * 64, _model_rev="r", _provider="CPU", _ort="1",
                                          _codes_sha=codes_sha, _kv_len=np.int64(2), _skip_samples=np.int64(0)))
        self.assertIsNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        self.assertTrue(save(skip_samples=-5))
        self.assertIsNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        self.assertTrue(save(skip_samples=10 ** 9))
        self.assertIsNone(W._state_load(path, spec, "CPU", "1", codes_sha))
        self.assertFalse(save(latent_audio=np.zeros(16, dtype=np.float16)))    # must be float32
        self.assertFalse(save(latent_buffer=np.zeros((1, 1024, 4), dtype=np.int64)))  # int state is unreadable

    def test_unknown_upstream_is_not_patched(self):
        import tts_worker as W
        ok, note = W.patch_no_play_proc()
        if ok:                                           # real engine with the pinned hashes: it applies
            self.skipTest("engine installed here and the patch applies")
        self.assertFalse(ok)
        self.assertTrue("upstream" in note or "import failed" in note, note)
        ok2, note2 = W.patch_lazy_encoders()
        self.assertFalse(ok2)
        self.assertTrue("upstream" in note2 or "import failed" in note2, note2)

    def test_streaming_never_gets_the_no_play_proc_patch(self):
        import tts_worker as W
        ok, note = W.patch_no_play_proc(streaming=True)
        self.assertFalse(ok)
        self.assertIn("streaming", note)

    def test_decoder_state_cache_roundtrip_and_rejects_tampering(self):
        import numpy as np
        import tts_worker as W
        DecoderState = self._fake_decoder_state()
        state_dir = tmpdir()
        spec = {"stateDir": state_dir, "anchorSha": "a" * 64, "modelRev": "rev1"}

        class Voice:
            pass
        voice = Voice()
        voice.codes = np.zeros((3, 16), dtype=np.int64)
        voice.final_state = DecoderState(
            pre_conv_history=np.zeros((1, 512, 2), dtype=np.float16),
            latent_buffer=np.zeros((1, 1024, 4), dtype=np.float16),
            conv_history=np.zeros((1, 1024, 4), dtype=np.float16),
            kv_cache=[np.zeros((1, 16, 72, 64), dtype=np.float16) for _ in range(16)],
            skip_samples=7680, latent_audio=np.zeros(16, dtype=np.float32))
        path = W._state_path(spec, "DML", "1.24.4")
        self.assertTrue(W._state_save(path, spec, "DML", "1.24.4", voice))
        codes_sha = W._codes_sha(voice.codes)
        loaded = W._state_load(path, spec, "DML", "1.24.4", codes_sha)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.skip_samples, 7680)
        self.assertEqual(len(loaded.kv_cache), 16)
        self.assertEqual(loaded.pre_conv_history.shape, (1, 512, 2))
        # every part of the fingerprint matters
        self.assertIsNone(W._state_load(path, spec, "CPU", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, spec, "DML", "1.23.0", codes_sha))
        self.assertIsNone(W._state_load(path, dict(spec, anchorSha="b" * 64), "DML", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, dict(spec, modelRev="rev2"), "DML", "1.24.4", codes_sha))
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", "deadbeef"))
        # a damaged or hostile file is a cache miss, never a crash
        with open(path, "wb") as f:
            f.write(b"not an npz at all")
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", codes_sha))
        with open(path, "wb") as f:
            f.write(b"\0" * 16)
        self.assertIsNone(W._state_load(path, spec, "DML", "1.24.4", codes_sha))

    def test_state_cache_is_skipped_without_a_public_preset(self):
        import tts_worker as W
        self.assertIsNone(W._state_path({"anchorSha": "a" * 64}, "DML", "1"))       # no stateDir
        self.assertIsNone(W._state_path({"stateDir": tmpdir()}, "DML", "1"))        # no anchor sha
        self.assertIsNone(W._state_path({"stateDir": tmpdir(), "anchorSha": "a" * 64}, "DML", "1"))

    def test_state_cache_refuses_oversized_files(self):
        import tts_worker as W
        path = os.path.join(tmpdir(), ".state-bomb.npz")
        with open(path, "wb") as f:
            f.write(b"\0" * 1024)
        spec = {"stateDir": os.path.dirname(path), "anchorSha": "a", "modelRev": "r"}
        orig = W.STATE_COMPRESSED_LIMIT
        try:
            W.STATE_COMPRESSED_LIMIT = 8
            self.assertIsNone(W._state_load(path, spec, "DML", "1", "x"))
        finally:
            W.STATE_COMPRESSED_LIMIT = orig

    def test_public_preset_spec_carries_a_content_hash_but_clones_do_not(self):
        store = VoiceStore(tmpdir(), ROOT)
        preset = store.resolve("whale-girl")
        self.assertIn("anchorSha", preset)
        self.assertIn("stateDir", preset)
        self.assertEqual(len(preset["anchorSha"]), 64)
        self.assertTrue(preset["anchor"].replace("\\", "/").startswith(ROOT.replace("\\", "/")))
        # a clone is never hashed or opened for the cache
        data = tmpdir()
        clone_dir = os.path.join(data, "voices", "clone-0123456789")
        os.makedirs(clone_dir, exist_ok=True)
        with open(os.path.join(clone_dir, "voice.json"), "w", encoding="utf-8") as f:
            json.dump({"ref": "ref.wav", "text": "", "mode": "zero_shot"}, f)
        spec = VoiceStore(data, ROOT).resolve("clone-0123456789")
        self.assertNotIn("anchorSha", spec)
        self.assertNotIn("stateDir", spec)


class Install(unittest.TestCase):
    def test_install_progress_retry_and_pip(self):
        data = tmpdir()
        blob = os.urandom(50_000)
        zbuf = io.BytesIO()
        with zipfile.ZipFile(zbuf, "w") as zf:
            zf.writestr("x/ggml.dll", b"dll")
        with Server() as s:
            good = s.add("/eng/pkg.py", blob)
            z = s.add("/eng/bin.zip", zbuf.getvalue())
            z["extract"] = {"to": "pkg/bin", "include": ["*.dll"]}
            bad = s.add("/model/w.bin", blob)
            bad["sha256"] = "1" * 64
            pip_calls = []
            cat = {"components": [
                {"id": "py-deps", "kind": "pip", "auto": True, "packages": ["json5>=0", "wave"], "modules": ["wave", "nonexistent_mod_xyz"]},
                {"id": "eng", "kind": "files", "auto": True, "files": [good, z]},
                {"id": "model", "kind": "files", "auto": True, "files": [bad]},
            ]}

            def pip(py, target, pkgs):
                pip_calls.append(pkgs)
                os.makedirs(os.path.join(target, "nonexistent_mod_xyz"), exist_ok=True)
                open(os.path.join(target, "nonexistent_mod_xyz", "__init__.py"), "w").close()
            d = Dependencies(data, catalog=cat, cache_dirs=[], pip_runner=pip)
            self.assertFalse(d.ready())
            with self.assertRaises(IntegrityError):
                d.install_all()
            self.assertEqual(len(pip_calls), 1)
            self.assertTrue(d.installed("py-deps"))
            self.assertTrue(d.installed("eng"))
            self.assertTrue(os.path.isfile(os.path.join(d.path("eng"), "pkg", "bin", "ggml.dll")))
            self.assertFalse(d.installed("model"))
            p = d.read_progress()
            self.assertEqual(p["phase"], "failed")
            self.assertIn("校验", p["message"])
            # fix the catalog (a new release) and retry: only the missing part is fetched
            bad["sha256"] = hashlib.sha256(blob).hexdigest()
            d = Dependencies(data, catalog=cat, cache_dirs=[], pip_runner=pip)
            n = len(Blob.log)
            self.assertEqual(d.install_all(), ["py-deps", "eng", "model"])
            self.assertEqual([x[0] for x in Blob.log[n:]], ["/model/w.bin"])
            self.assertTrue(d.ready())
            p = d.read_progress()
            self.assertEqual((p["phase"], p["overall"]["done"]), ("done", p["overall"]["total"]))
            # a changed pin invalidates the marker
            good["sha256"] = "2" * 64
            self.assertFalse(Dependencies(data, catalog=cat, cache_dirs=[]).installed("eng"))

    def test_qwen_needs_components(self):
        data = tmpdir()
        t = QwenTts(data, Dependencies(data, cache_dirs=[]), VoiceStore(data, ROOT))
        with self.assertRaises(DependencyMissing):
            t.synthesize("你好")


# ------------------------------------------------------------------------------------------ voices
class Voices(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def test_whale_preset_is_default(self):
        st = VoiceStore(self.data, ROOT)
        presets = st.presets()
        self.assertEqual(presets[0]["id"], "whale-girl")
        spec = st.resolve("whale-girl")
        self.assertTrue(os.path.isfile(spec["ref"]))
        self.assertIn("深度思考", spec["text"])
        self.assertEqual(spec["mode"], "icl")
        # 2026-11-16：参考音换成 Qwen3-TTS VoiceDesign 产出的 wav（24 kHz 单声道 16 位），anchor 由它派生
        self.assertEqual(os.path.basename(spec["ref"]), "ref.wav")
        with wave.open(spec["ref"], "rb") as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (24000, 1, 2))
        self.assertTrue(os.path.isfile(spec["anchor"]))
        self.assertEqual(st.resolve("nope")["key"], spec["key"])            # unknown -> default preset
        self.assertEqual(st.resolve("clone-0000000000")["key"], spec["key"])

    def test_clone_store(self):
        st = VoiceStore(self.data, ROOT)
        ref = make_wav(os.path.join(self.data, "me.wav"))
        vid = st.add(ref, "我的声音", "你好呀")
        self.assertRegex(vid, r"^clone-[0-9a-f]{10}$")
        spec = st.resolve(vid)
        self.assertEqual((spec["text"], spec["mode"]), ("你好呀", "icl"))
        self.assertTrue(spec["anchor"].startswith(os.path.join(self.data, "voices", vid)))
        self.assertIn(vid, [v["id"] for v in st.list()])
        vid2 = st.add(make_wav(os.path.join(self.data, "b.wav"), 0.3))
        self.assertEqual(st.resolve(vid2)["mode"], "zero_shot")
        txt = os.path.join(self.data, "notes.txt")
        open(txt, "w").close()
        with self.assertRaises(ValueError):
            st.add(txt)
        with self.assertRaises(FileNotFoundError):
            st.add(os.path.join(self.data, "missing.wav"))
        st.remove(vid)
        self.assertNotIn(vid, [v["id"] for v in st.list()])

    def test_make_tts_selects_engine(self):
        deps = Dependencies(self.data, cache_dirs=[])
        self.assertIsInstance(make_tts({}, self.data, deps, ROOT), QwenTts)
        self.assertIsInstance(make_tts({"engine": "qwen", "voice": "whale-girl"}, self.data, deps, ROOT), QwenTts)
        self.assertIsInstance(make_tts({"engine": "stub", "voice": "default"}, self.data, deps, ROOT), QwenTts)   # old settings
        self.assertIsInstance(make_tts({"engine": "custom", "custom": {"mode": "http", "url": "http://127.0.0.1:9/tts"}},
                                       self.data, deps, ROOT), CustomTts)
        with self.assertRaises(VoiceError):
            make_tts({"engine": "custom", "custom": {"mode": "http", "url": "http://10.1.1.1/tts"}}, self.data, deps, ROOT)

    def test_split_sentences(self):
        self.assertEqual(split_sentences("嗯。今天天气不错！要出去走走吗？"), ["嗯。今天天气不错！", "要出去走走吗？"])
        long = "这是一个很长的句子，" * 12
        parts = split_sentences(long, limit=30)
        self.assertTrue(all(len(p) <= 30 for p in parts))
        self.assertEqual("".join(parts), long.strip())
        self.assertEqual(split_sentences("**粗体** `code` ……"), ["粗体 code …"])
        self.assertEqual(split_sentences("   "), [])


class Custom(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def test_http_channel(self):
        with Server() as s:
            t = CustomTts(self.data, {"mode": "http", "url": s.base + "/tts", "voice": "mine"})
            wav = t.synthesize("你好")
            with wave.open(wav) as w:
                self.assertEqual(w.getframerate(), 24000)
            self.assertEqual(Blob.log[-1], ("/tts", {"text": "你好", "voice": "mine"}))

    def test_http_channel_json_path(self):
        p = make_wav(os.path.join(self.data, "x.wav"))
        t = CustomTts(self.data, {"mode": "http", "url": "http://127.0.0.1:1/tts"},
                      post=lambda u, b, to: (json.dumps({"path": p}).encode(), "application/json"))
        self.assertTrue(read(t.synthesize("x")).startswith(b"RIFF"))
        bad = CustomTts(self.data, {"mode": "http", "url": "http://127.0.0.1:1/tts"}, post=lambda u, b, to: (b"oops", ""))
        with self.assertRaises(VoiceError):
            bad.synthesize("x")

    def test_command_channel_real_process(self):
        script = os.path.join(self.data, "mytts.py")
        with open(script, "w", encoding="utf-8") as f:
            f.write("import sys, wave\nargs = sys.argv[1:]\ntext, out = args[args.index('--text') + 1], args[args.index('--out') + 1]\n"
                    "assert text == '你好 \"世界\"; rm -rf /', text\n"
                    "w = wave.open(out, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)\n"
                    "w.writeframes(b'\\0\\0' * 1600); w.close()\n")
        t = CustomTts(self.data, {"mode": "command", "command": '"%s" "%s" --text {text} --out {out}' % (sys.executable, script)})
        wav = t.synthesize('你好 "世界"; rm -rf /')
        self.assertTrue(read(wav).startswith(b"RIFF"))

    def test_command_stdout_and_failures(self):
        p = make_wav(os.path.join(self.data, "y.wav"))
        seen = []

        def run(argv, timeout):
            seen.append(argv)
            return 0, read(p), ""
        t = CustomTts(self.data, {"mode": "command", "command": "say --t {text}"}, run=run)
        self.assertTrue(os.path.isfile(t.synthesize("a b")))
        self.assertEqual(seen[0], ["say", "--t", "a b"])
        t2 = CustomTts(self.data, {"mode": "command", "command": "say {text}"}, run=lambda a, to: (3, b"", "boom"))
        with self.assertRaisesRegex(VoiceError, "退出码 3"):
            t2.synthesize("x")
        with self.assertRaises(VoiceError):
            CustomTts(self.data, {"mode": "command", "command": "say hello"})
        self.assertEqual(split_template('a "b c" "" d'), ["a", "b c", "", "d"])


# ------------------------------------------------------------------------------------------ worker protocol
FAKE_WORKER = r'''
import json, sys, wave
MARK = "@@pp "
print("chatter with emoji \U0001F680 before ready")
mode = sys.argv[sys.argv.index("--provider") + 1]
if mode == "fail":
    print(MARK + json.dumps({"event": "error", "message": "boom"}), flush=True); sys.exit(2)
print(MARK + json.dumps({"event": "ready", "loadS": 0.01}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "quit": break
    if req["text"] == "crash": sys.exit(9)
    print("noise", flush=True)
    w = wave.open(req["out"], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(b"\0\0" * 240); w.close()
    print(MARK + json.dumps({"id": req["id"], "ok": True, "wav": req["out"], "voice": req["voice"]["key"]}, ensure_ascii=False), flush=True)
'''


class Worker(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()
        self.script = os.path.join(self.data, "fake_worker.py")
        with open(self.script, "w", encoding="utf-8") as f:
            f.write(FAKE_WORKER)

    def engine(self, provider="ok"):
        d = Dependencies(self.data, catalog={"components": []}, cache_dirs=[])
        return QwenTts(self.data, d, VoiceStore(self.data, ROOT), worker=self.script, provider=provider, idle_s=0, load_timeout=20)

    def test_protocol_ignores_chatter_and_restarts(self):
        t = self.engine()
        try:
            w1 = t.synthesize("你好")
            self.assertTrue(os.path.isfile(w1))
            self.assertTrue(t.last_stats["voice"].startswith("preset:whale-girl"))
            pid = t._proc.pid
            t.synthesize("再来一句")
            self.assertEqual(t._proc.pid, pid)                       # one warm process
            with self.assertRaises(VoiceError):
                t.synthesize("crash")
            self.assertTrue(os.path.isfile(t.synthesize("又好了")))   # restarted on demand
        finally:
            t.close()
        self.assertIsNone(t._proc)

    def test_load_failure_message(self):
        t = self.engine("fail")
        with self.assertRaisesRegex(VoiceError, "boom"):
            t.synthesize("x")


# ------------------------------------------------------------------------------------------ bridge
class Bridge(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()

    def test_full_voice_turn(self):
        b, rec = bridge(self.data)
        b.listen()
        out = b.hear(b"\x00\x00" * 1600)
        self.assertEqual(out["heard"], "你好")
        self.assertEqual(out["reply"], "收到：你好")
        self.assertEqual(rec.states, ["listening", "thinking", "speaking", "idle"])
        self.assertEqual(rec.played, [out["wav"]])
        with wave.open(out["wav"]) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 16000))
        self.assertEqual(b.status()["state"], "idle")

    def test_sentences_pipelined_in_order(self):
        speak = []
        b, rec = bridge(self.data, llm=StubLlm(lambda t: "第一句话。第二句话！第三句话？"))
        b.on_speak = lambda i, s, secs: speak.append((i, s))
        out = b.ask_text("x")
        self.assertEqual([s for _, s in speak], ["第一句话。", "第二句话！", "第三句话？"])
        self.assertEqual(rec.played, out["wavs"])
        self.assertEqual(rec.states, ["thinking", "speaking", "idle"])

    def test_text_turn_and_silence(self):
        b, rec = bridge(self.data, stt=StubStt(""))
        self.assertEqual(b.hear(b"\x00\x00")["heard"], "")
        self.assertEqual(rec.states, ["thinking", "idle"])
        self.assertEqual(b.ask_text("在吗")["reply"], "收到：在吗")

    def test_speak_without_llm(self):
        llm = StubLlm()
        b, rec = bridge(self.data, llm=llm)
        out = b.speak("主人好。")
        self.assertEqual(len(out["wavs"]), 1)
        self.assertEqual(llm.calls, [])
        self.assertEqual(rec.states, ["speaking", "idle"])

    def test_no_session_selected(self):
        b, rec = bridge(self.data, llm=NoRoute())
        out = b.ask_text("hi")
        self.assertIn("会话", out["error"])
        self.assertEqual(b.state, "idle")
        self.assertEqual(rec.played, [])

    def test_tts_missing_keeps_reply(self):
        data = self.data
        tts = QwenTts(data, Dependencies(data, cache_dirs=[]), VoiceStore(data, ROOT))
        replies = []
        b, rec = bridge(data, tts=tts)
        b.on_reply = replies.append
        out = b.ask_text("x")
        self.assertEqual(replies, ["收到：x"])
        self.assertIn("语音组件", out["error"])
        self.assertEqual(rec.states, ["thinking", "idle"])

    def test_error_after_first_sentence(self):
        class Flaky(StubTts):
            def synthesize(self, text, voice=None):
                if "二" in text:
                    raise VoiceError("合成失败")
                return super().synthesize(text, voice)
        b, rec = bridge(self.data, llm=StubLlm(lambda t: "一一一。二二二。"), tts=Flaky(self.data))
        out = b.ask_text("x")
        self.assertEqual(len(rec.played), 1)
        self.assertEqual(out["error"], "合成失败")
        self.assertEqual(b.state, "idle")

    def test_interrupt_drops_result(self):
        gate, started = threading.Event(), threading.Event()

        def slow(t):
            started.set()
            gate.wait(2)
            return "迟到的回复"
        b, rec = bridge(self.data, llm=StubLlm(slow))
        box = {}
        th = threading.Thread(target=lambda: box.update(b.ask_text("x")))
        th.start()
        started.wait(2)
        b.interrupt()
        gate.set()
        th.join(2)
        self.assertTrue(box.get("cancelled"))
        self.assertEqual(rec.played, [])
        self.assertEqual(b.state, "idle")

    def test_interrupt_while_speaking_stops_playback(self):
        playing = threading.Event()
        stopped = threading.Event()

        def play(path):
            playing.set()
            stopped.wait(3)
        b = VoiceBridge(StubStt(), StubTts(self.data), StubLlm(lambda t: "第一句。第二句。第三句。"),
                        play=play, stop=stopped.set)
        box = {}
        th = threading.Thread(target=lambda: box.update(b.ask_text("x")))
        th.start()
        self.assertTrue(playing.wait(3))
        self.assertEqual(b.state, "speaking")
        b.interrupt()
        th.join(3)
        self.assertTrue(box.get("cancelled"))
        self.assertEqual(len(box["wavs"]), 1)
        self.assertEqual(b.state, "idle")

    def test_stt_type_check(self):
        b, _ = bridge(self.data)
        self.assertIn("error", b.hear("not bytes"))

    def test_concat(self):
        a = make_wav(os.path.join(self.data, "a.wav"), 0.1)
        c = make_wav(os.path.join(self.data, "c.wav"), 0.2)
        out = concat_wavs([a, c], os.path.join(self.data, "ac.wav"))
        with wave.open(out) as w:
            self.assertEqual(w.getnframes(), 1600 + 3200)


# ------------------------------------------------------------------------------------------ routes / stt
class Routes(unittest.TestCase):
    def test_session_route(self):
        seen = {}

        def post(url, body, headers, timeout):
            seen.update(url=url, body=body, headers=headers)
            return 200, {"ok": True, "protocol": 1, "requestId": body['requestId'], "sessionId": body['sessionId'],
                         "state": "completed", "delivery": "accepted", "accepted": True, "reply": " 在的 "}
        r = SessionRoute("s-1", host_base="http://127.0.0.1:3080/dsh-pixel-pet", key="k", post=post)
        self.assertEqual(r.ask("在吗"), "在的")
        self.assertEqual(seen["url"], "http://127.0.0.1:3080/dsh-pixel-pet/api/ask/start")
        self.assertRegex(seen['body']['requestId'], r'^[0-9a-f-]{36}$')
        self.assertEqual(seen["body"], {"sessionId": "s-1", "text": "在吗", 'requestId': seen['body']['requestId']})
        self.assertEqual(seen["headers"], {"X-PixelPet-Key": "k"})

    def test_session_route_errors(self):
        r = SessionRoute("s", host_base="http://127.0.0.1:1", key="k", post=lambda *a: (409, {"ok": False, "message": "忙"}))
        with self.assertRaises(VoiceError):
            r.ask("x")
        with self.assertRaises(RouteUnset):
            SessionRoute("")
        with self.assertRaises(VoiceError):
            SessionRoute("s", host_base="https://example.com", key="k")
        self.assertIsInstance(make_llm({"sessionId": ""}), NoRoute)

    def test_host_stt_sends_wav(self):
        seen = {}

        def post(url, body, headers, timeout):
            seen.update(url=url, body=body, headers=headers)
            return 200, json.dumps({"ok": True, "text": " 你好 "}).encode()
        s = HostStt(host_base="http://127.0.0.1:3080/dsh-pixel-pet", key="k", post=post)
        self.assertEqual(s.transcribe(b"\x01\x00" * 4800, 48000), "你好")
        self.assertEqual(seen["url"], "http://127.0.0.1:3080/dsh-pixel-pet/api/stt")
        self.assertEqual(seen["headers"]["X-PixelPet-Key"], "k")
        with wave.open(io.BytesIO(seen["body"])) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getnframes()), (16000, 1, 1600))
        bad = HostStt(host_base="http://127.0.0.1:1", key="k", post=lambda *a: (503, b'{"ok":false,"message":"DSH \xe8\xaf\xad\xe9\x9f\xb3\xe8\xbe\x93\xe5\x85\xa5\xe6\xb2\xa1\xe5\xbc\x80"}'))
        with self.assertRaisesRegex(VoiceError, "DSH"):
            bad.transcribe(b"\x00\x00")
        with self.assertRaises(ValueError):
            HostStt(host_base="http://10.0.0.1/x", key="k")

    def test_make_stt(self):
        os.environ.pop("PIXELPET_HOST_BASE", None)
        self.assertIsInstance(make_stt({"engine": "dsh"}), NoStt)            # no host -> off, not a crash
        self.assertIsInstance(make_stt({"engine": "off"}), NoStt)
        os.environ["PIXELPET_HOST_BASE"], os.environ["PIXELPET_BRIDGE_KEY"] = "http://127.0.0.1:3080/dsh-pixel-pet", "k"
        try:
            self.assertIsInstance(make_stt({"engine": "stub"}), HostStt)                     # old settings
        finally:
            os.environ.pop("PIXELPET_HOST_BASE", None)
            os.environ.pop("PIXELPET_BRIDGE_KEY", None)
        self.assertIsInstance(make_stt({"engine": "local-http", "endpoint": "http://127.0.0.1:9/asr"}), LocalHttpStt)
        self.assertEqual(len(resample16k(b"\x00\x00" * 2400, 24000)), 1600 * 2)

    def test_local_stt(self):
        s = LocalHttpStt("http://127.0.0.1:9/asr", post=lambda u, b, h, t: '{"text": " 你好 "}'.encode())
        self.assertEqual(s.transcribe(b"\x00\x00"), "你好")
        with self.assertRaises(ValueError):
            LocalHttpStt("http://10.0.0.2/asr")


if __name__ == "__main__":
    unittest.main()
