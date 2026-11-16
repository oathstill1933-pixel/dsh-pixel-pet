"""Synthetic regression gates for A-D / M1-M6. No live model, service or user data needed."""
import io
import json
import os
import sys
import threading
import time
import types
import unittest
import unittest.mock as mock
import zipfile

from helpers import ROOT, tmpdir
import tts_worker as W
from pixelpet.voice.deps import Dependencies, DownloadError, _pkg_module, for_platform, probe_target
from pixelpet.voice.tts import QwenTts, VoiceStore


class Migration(unittest.TestCase):
    def package(self, target, providers, dist):
        d = os.path.join(target, "onnxruntime")
        os.makedirs(os.path.join(d, "capi"), exist_ok=True)
        with open(os.path.join(d, "__init__.py"), "w", encoding="utf8") as f:
            f.write("def get_available_providers(): return %r\n" % providers)
        with open(os.path.join(d, "capi", "fixture.dll"), "wb") as f: f.write(b"synthetic")
        os.makedirs(os.path.join(target, dist), exist_ok=True)

    def comp(self):
        return {"id": "py-deps", "kind": "pip", "packages": ["onnxruntime-directml>=1.24"],
                "modules": ["onnxruntime"], "want_ep": "DmlExecutionProvider",
                "conflicts": ["onnxruntime", "onnxruntime-directml", "onnxruntime-gpu"]}

    def test_native_migration_fresh_target_and_preserves_old(self):
        calls = []
        comp = self.comp()
        def pip(py, target, packages):
            calls.append((target, packages))
            self.assertFalse(os.path.exists(os.path.join(target, "onnxruntime")), "old native module removed from private stage")
            self.assertFalse(os.path.exists(os.path.join(target, "onnxruntime-1.0.dist-info")))
            self.package(target, ["DmlExecutionProvider", "CPUExecutionProvider"], "onnxruntime_directml-1.24.dist-info")
        d = Dependencies(tmpdir(), catalog=[comp], pip_runner=pip)
        self.package(d.pylibs(), ["CPUExecutionProvider"], "onnxruntime-1.0.dist-info")
        with mock.patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(__file__="outside", get_available_providers=lambda: ["CPUExecutionProvider"])}):
            result = d.install("py-deps")
        self.assertEqual(len(calls), 1)
        self.assertNotEqual(calls[0][0], result)
        check = probe_target(result, comp)
        self.assertEqual(check["missing"] + check["outside"], [])
        self.assertIn("DmlExecutionProvider", check["eps"])
        self.assertTrue(os.path.realpath(check["file"]).startswith(os.path.realpath(result) + os.sep))
        old = [n for n in os.listdir(os.path.dirname(result)) if ".old-" in n]
        self.assertEqual(len(old), 1)
        self.assertTrue(os.path.isfile(os.path.join(os.path.dirname(result), old[0], "onnxruntime", "capi", "fixture.dll")))
        self.assertTrue(d.installed("py-deps"))

    def test_failed_stage_never_removes_shared_target(self):
        comp = self.comp()
        def pip(*a): raise DownloadError("fixture install failure")
        d = Dependencies(tmpdir(), catalog=[comp], pip_runner=pip)
        self.package(d.pylibs(), ["CPUExecutionProvider"], "onnxruntime-1.0.dist-info")
        with self.assertRaises(DownloadError): d.install("py-deps")
        self.assertTrue(os.path.isfile(os.path.join(d.pylibs(), "onnxruntime", "capi", "fixture.dll")))
        self.assertFalse(d.installed("py-deps"))

    def test_dist_import_mapping_and_platform(self):
        self.assertEqual(_pkg_module("onnxruntime-directml>=1.24"), "onnxruntime")
        c = {"packages": ["onnxruntime"], "platforms": {"win32": {"packages": ["onnxruntime-directml"]}}}
        self.assertEqual(for_platform(c, "linux")["packages"], ["onnxruntime"])
        self.assertEqual(for_platform(c, "win32")["packages"], ["onnxruntime-directml"])


class WorkerPatches(unittest.TestCase):
    def modules(self):
        names = ["qwen3_tts_gguf", "qwen3_tts_gguf.inference", "qwen3_tts_gguf.inference.proxy",
                 "qwen3_tts_gguf.inference.decoder", "qwen3_tts_gguf.inference.workers",
                 "qwen3_tts_gguf.inference.workers.speaker", "qwen3_tts_gguf.inference.workers.decoder",
                 "qwen3_tts_gguf.inference.engine", "qwen3_tts_gguf.inference.encoder"]
        mods = {n: types.ModuleType(n) for n in names}
        for n in names: mods[n].__path__ = []
        for n in names:
            if "." in n:
                parent, key = n.rsplit(".", 1)
                if parent in mods: setattr(mods[parent], key, mods[n])
        self.enterContext(mock.patch.dict(sys.modules, mods))
        return mods

    def test_M1_no_player_and_decoder_ready_is_not_forged(self):
        m = self.modules()
        class Proxy:
            def __init__(self):
                self.codes_q = self.result_q = self.play_q = self.onnx_path = None
                self.ready_states = {"decoder": False, "speaker": False}
                self.decoder_proc = self.play_proc = None
                self.onnx_provider = "CPU"; self.chunk_size = 12
            def start(self):
                decoder_worker_proc; speaker_worker_proc; Process; Thread; self._listen_loop
            def _listen_loop(self): pass
            def _handle_decoder_msg(self, msg):
                if msg.msg_type == "READY": self.ready_states["decoder"] = True
        m["qwen3_tts_gguf.inference.proxy"].DecoderProxy = Proxy
        m["qwen3_tts_gguf.inference.workers.decoder"].decoder_worker_proc = lambda *a: None
        with mock.patch.object(W, "upstream_hash", side_effect=lambda mod, rel: W.UPSTREAM_SHA256[rel]), \
                mock.patch("multiprocessing.Process") as proc, mock.patch("threading.Thread"):
            self.assertTrue(W.patch_no_play_proc()[0])
            p = Proxy(); p.start()
            self.assertEqual(proc.call_count, 1)
            self.assertIsNone(p.play_proc)
            self.assertEqual(p.ready_states, {"decoder": False, "speaker": True})
            p._handle_decoder_msg(types.SimpleNamespace(msg_type="READY", actual_provider="CPUExecutionProvider"))
            self.assertTrue(p.ready_states["decoder"])
            self.assertEqual(p.actual_decoder_provider, "CPUExecutionProvider")

    def test_M2_encoders_are_created_only_on_use(self):
        m = self.modules(); made = []
        class Codec:
            def __init__(self, path): made.append(path)
            def encode(self, x): return x
        class Engine:
            def __init__(self):
                CodecEncoder; SpeakerEncoder
                a = "codec_enc_onnx"; b = "spk_enc_onnx"
        eng = m["qwen3_tts_gguf.inference.engine"]
        enc = m["qwen3_tts_gguf.inference.encoder"]
        eng.TTSEngine = Engine; enc.CodecEncoder = enc.SpeakerEncoder = Codec
        with mock.patch.object(W, "upstream_hash", return_value=W.UPSTREAM_SHA256["engine.py"]):
            self.assertTrue(W.patch_lazy_encoders()[0])
        codec, speaker = eng.CodecEncoder("codec"), eng.SpeakerEncoder("speaker")
        self.assertEqual(made, [])
        self.assertEqual(codec.encode(3), 3); codec.encode(4)
        self.assertEqual(made, ["codec"])
        speaker.encode(5); self.assertEqual(made, ["codec", "speaker"])

    def test_real_session_fallback_reports_cpu_and_does_not_fake_ready(self):
        m = self.modules(); messages = []; attempts = []
        dec = m["qwen3_tts_gguf.inference.decoder"]
        def decoder(path, onnx_provider, chunk_size):
            attempts.append(onnx_provider)
            if onnx_provider != "CPU": raise RuntimeError("no DX12 adapter")
            return types.SimpleNamespace(active_provider="CPUExecutionProvider")
        dec.StatefulDecoder = decoder
        def run(codes, result, path, provider, size):
            dec.StatefulDecoder(path, onnx_provider=provider, chunk_size=size)
            result.put(types.SimpleNamespace(msg_type="READY"))
        m["qwen3_tts_gguf.inference.workers.decoder"].decoder_worker_proc = run
        ort = types.SimpleNamespace(InferenceSession=lambda *a, **k: None)
        q = types.SimpleNamespace(put=messages.append)
        with mock.patch.dict(sys.modules, {"onnxruntime": ort}):
            W.decoder_entry(None, q, "public.onnx", "DML", 12)
        self.assertEqual(attempts, ["DML", "CPU"])
        self.assertEqual(messages[0].actual_provider, "CPUExecutionProvider")
        self.assertIn("fallback", messages[0].fallback_note)
        messages.clear()
        dec.StatefulDecoder = mock.Mock(side_effect=RuntimeError("both failed"))
        with mock.patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(InferenceSession=None)}):
            with self.assertRaises(RuntimeError): W.decoder_entry(None, q, "public.onnx", "DML", 12)
        self.assertEqual(messages, [])

    def test_provider_availability_is_not_blind_request(self):
        with mock.patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])}):
            self.assertEqual(W.pick_provider("dml")[:2], ("DML", "CPU"))
            self.assertEqual(W.pick_provider("auto")[:2], ("AUTO", "CPU"))
            self.assertEqual(W.pick_provider("nonsense")[:2], ("NONSENSE", "CPU"))
        self.assertIsNone(W._state_path({"stateDir": tmpdir(), "anchorSha": "a", "modelRev": "r"}, "UNKNOWN", "1"))


class WarmGeneration(unittest.TestCase):
    def make(self): return QwenTts(tmpdir(), Dependencies(tmpdir()), VoiceStore(tmpdir(), ROOT))

    def test_closed_async_warm_is_noop_and_idle_disabled_is_safe(self):
        t = self.make(); t.close()
        self.assertFalse(t.warm_async())
        t._closing = False; t._last = 0; t.idle_s = 0
        with mock.patch.object(t, "_kill") as kill: t._idle_check(); kill.assert_not_called()
        t.close()

    def test_reader_late_generation_cannot_overwrite_ready_or_replies(self):
        t = self.make()
        old = types.SimpleNamespace(stdout=[b'@@pp {"event":"error"}\n', b'@@pp {"id":1,"ok":false}\n'])
        t._proc = object(); t._ready = {"event": "ready"}
        t._read(old)
        self.assertEqual(t._ready, {"event": "ready"}); self.assertEqual(t._replies, {})
        t._proc = None; t.close()

    def test_warm_result_join_waits_for_finished_thread(self):
        t = self.make()
        def work(): time.sleep(.02); t._warm_done = {"ok": True}
        t._warm_thread = threading.Thread(target=work); t._warm_thread.start()
        self.assertEqual(t.warm_result(timeout=1), {"ok": True}); t.close()


class CacheHeaders(unittest.TestCase):
    def test_zip_budget_and_false_npy_allocation_header_are_cache_misses(self):
        import numpy as np
        # Header claims an enormous allocation, ZIP central directory claims only the tiny header.
        buf = io.BytesIO()
        np.lib.format.write_array_header_1_0(buf, {"descr": "<f4", "fortran_order": False, "shape": (10**12,)})
        path = os.path.join(tmpdir(), "bad.npz")
        with zipfile.ZipFile(path, "w") as z: z.writestr("pre_conv_history.npy", buf.getvalue())
        with mock.patch("numpy.load", side_effect=AssertionError("must not allocate")) as load:
            self.assertIsNone(W._state_load(path, {}, "CPU", "1", "x")); load.assert_not_called()
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("oversized.npy", b"0" * 2048)
        with mock.patch.object(W, "STATE_MEMBER_LIMIT", 1024), mock.patch("numpy.load") as load:
            self.assertIsNone(W._state_load(path, {}, "CPU", "1", "x")); load.assert_not_called()

    def test_playback_constructor_is_lazy(self):
        from pixelpet.voice.playback import PlaybackReference
        p = PlaybackReference(tmpdir())
        self.assertIsNone(p._np)
        self.assertFalse(p._tried)
        p.filter(b"\0\0" * 160)
        self.assertFalse(p._tried, "mic filter must not load numpy before first playback")


class AppWarmWiring(unittest.TestCase):
    def app(self):
        from pixelpet.app import PetApp
        app = PetApp.__new__(PetApp)
        app._closed = False; app.listener = None; app.voice_state = "idle"
        app.voice = types.SimpleNamespace(tts=mock.Mock(name="tts"), listen=mock.Mock(), ask_text=mock.Mock())
        return app

    def test_startup_waits_for_dependencies_then_asynchronously_warms(self):
        app = self.app(); app.root = mock.Mock()
        app.voice.tts.name = "qwen"; app.voice.tts.available.return_value = False
        app._startup_prewarm()
        app.voice.tts.warm_async.assert_not_called()
        app.root.after.assert_called_once_with(5000, app._startup_prewarm)
        app.voice.tts.available.return_value = True
        app._startup_prewarm(); app.voice.tts.warm_async.assert_called_once()

    def test_vad_and_control_ask_warm_without_waiting(self):
        app = self.app()
        app._hands_free_event("start")
        app.voice.tts.warm_async.assert_called_once(); app.voice.listen.assert_called_once()
        with mock.patch("threading.Thread"):
            self.assertTrue(app.voice_cmd({"action": "ask", "text": "synthetic"})[0])
        self.assertEqual(app.voice.tts.warm_async.call_count, 2)
        app._closed = True
        self.assertFalse(app._prewarm())
        self.assertEqual(app.voice.tts.warm_async.call_count, 2)

    def test_mode_switches_idle_lifetime(self):
        app = self.app(); app._set_tts_idle()
        app.voice.tts.set_idle.assert_called_with(120)
        app.listener = object(); app._set_tts_idle()
        app.voice.tts.set_idle.assert_called_with(1800)


if __name__ == "__main__": unittest.main()
