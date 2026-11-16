"""Qwen3-TTS worker: loads the engine once, then answers JSON requests on stdin.

    python -X utf8 tts_worker.py --engine-dir D --model-dir M --pylibs P [--provider auto|cpu|dml|cuda] [--threads N]

Requests (one JSON object per line):
    {"id": 1, "op": "synth", "text": "...", "out": "x.wav", "seed": 42,
     "voice": {"key", "ref", "text", "anchor", "anchorCache", "mode": "zero_shot"|"icl", "language",
               "stateDir", "anchorSha", "modelRev"}}
    {"id": 2, "op": "ping"}            {"op": "quit"}
Replies are lines starting with "@@pp " followed by JSON. Every other stdout line is engine chatter (the
upstream engine and its decoder subprocesses print freely) and is ignored by the reader.

Three upstream patches are applied here, each guarded by the structure it relies on; when the installed
engine does not look like the version this was written against the patch is skipped and reported in the
ready event instead of half-applying:
    no-play-proc   the engine's own playback subprocess is not started (the plugin plays the wav itself)
    lazy-encoders  codec/speaker encoders load on first use (preset anchors never need them)
    cpu-threads    CPU decode pins intra-op threads instead of the hardcoded OMP_NUM_THREADS=4

The engine prints emoji: the parent must start this with PYTHONUTF8=1 / PYTHONIOENCODING=utf-8 / -X utf8,
otherwise a GBK console kills the decoder subprocess during start-up.
"""
import argparse
import hashlib
import json
import os
import sys
import time

MARK = "@@pp "
STREAMING = False         # whole sentences, never the engine's streaming playback path
STATE_SCHEMA = 2          # exact pinned decoder layout + pre-allocation NPY validation
STATE_COMPRESSED_LIMIT = 32 << 20    # refuse an implausibly large cache file
STATE_TOTAL_LIMIT = 64 << 20         # cumulative decompressed size of one cache file
STATE_MEMBER_LIMIT = 16 << 20        # any single member (checked before decompression)
STATE_DTYPES = ("float16", "float32")
# Upstream files the two patches below are written against (catalog pins this engine revision, so the
# hashes are stable). A different file means "do not patch, run upstream as-is" — never half-apply.
UPSTREAM_SHA256 = {
    "decoder.py": "128ef25e2e0c36171f8c33e1d08c4a6a1f066f0d553df2467f96b7b4248a3e45",
    "proxy.py": "10bbef4ff3c6b196ce0fa94c1c87d134c7aad14d8860ac609b022d00183c454c",
    "engine.py": "48b9de1d99434b17c5fa0c56a9a8cc917adbd28217f87ab5d7c64bc50f250281",
    "workers/speaker.py": "b4a6d1c6749cec55ee07a3f87ee20bbf18b8b3fb76914fa4dcdd8817f5fc2329",
    "workers/decoder.py": "9e08e7d3cddced185308eae2d46eb3dc58c184a7efa71619d403b06a4376a0ca",
    "schema/protocol.py": "2a007f3eeeda71cb947875fbe9e514938c215131c764ffece3da753d07af9865",
}


def emit(obj):
    sys.stdout.write(MARK + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pick_provider(name):
    """-> (requested, effective, note).

    `requested` is what the caller asked for, `effective` is what this wheel can actually do. A forced
    name is never trusted blindly: onnxruntime silently keeps the CPU EP when the requested one is
    missing, and the cache key and the reported speed-up must follow what really runs, not the wish.
    """
    requested = (name or "auto").lower()
    try:
        import onnxruntime as ort
        av = [p.upper() for p in ort.get_available_providers()]
    except Exception:  # noqa: BLE001
        return requested.upper(), "CPU", "onnxruntime unavailable"
    def has(tag):
        return any(tag in p for p in av)
    if requested == "auto":
        for tag in ("DML", "CUDA"):
            if has(tag):
                return "AUTO", tag, ""
        return "AUTO", "CPU", ""
    want = requested.upper()
    tag = {"DML": "DML", "CUDA": "CUDA", "TRT": "TENSORRT", "TENSORRT": "TENSORRT", "CPU": "CPU"}.get(want)
    if tag is None or not has(tag):
        return want, "CPU", "%s 不在这个 onnxruntime 里，退回 CPU" % want
    return want, want, ""


def ort_version():
    try:
        import onnxruntime as ort
        return str(getattr(ort, "__version__", "") or "")
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------------------------------- patches
def upstream_hash(module, relative):
    """sha256 of an installed upstream file, or '' when it cannot be located."""
    path = getattr(module, "__file__", None)
    if not path:
        return ""
    target = os.path.join(os.path.dirname(os.path.abspath(path)), *relative.split("/"))
    try:
        h = hashlib.sha256()
        with open(target, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()
    except OSError:
        return ""


def patch_no_play_proc(threads=0, streaming=False):
    """Do not start the engine's own speaker subprocess (it is never fed; the plugin plays .wav).

    -> (applied, note). The readiness flag for the speaker is set because no process will ever report
    it; the decoder still has to become READY on its own before the engine counts as loaded. The patch
    is only sound for non-streaming synthesis: streaming playback is what the speaker process is for.
    """
    if streaming:
        return False, "streaming synthesis needs the engine's player"
    try:
        import multiprocessing as mp
        import threading
        from qwen3_tts_gguf.inference import proxy as proxy_mod
        from qwen3_tts_gguf.inference.workers import speaker as speaker_mod
        from qwen3_tts_gguf.inference.workers.decoder import decoder_worker_proc
    except Exception as exc:  # noqa: BLE001
        return False, "import failed: %s" % type(exc).__name__
    if not speaker_mod or not decoder_worker_proc:      # pragma: no cover - import guard
        return False, "workers missing"
    for rel, mod in ((rel, proxy_mod) for rel in
                     ("proxy.py", "workers/speaker.py", "workers/decoder.py", "decoder.py", "schema/protocol.py")):
        got, want = upstream_hash(mod, rel), UPSTREAM_SHA256.get(rel, "")
        if not got or (want and got != want):
            return False, "upstream %s changed (%s)" % (rel, (got or "unreadable")[:12])
    proxy = getattr(proxy_mod, "DecoderProxy", None)
    if proxy is None:
        return False, "DecoderProxy missing"
    start_code = getattr(getattr(proxy, "start", None), "__code__", None)
    init_code = getattr(getattr(proxy, "__init__", None), "__code__", None)
    if start_code is None or init_code is None:
        return False, "DecoderProxy.start/__init__ not inspectable"
    need_start = {"decoder_worker_proc", "speaker_worker_proc", "Process", "Thread", "_listen_loop"}
    need_init = {"codes_q", "result_q", "play_q", "ready_states", "decoder_proc", "play_proc", "onnx_path"}
    if not need_start <= set(start_code.co_names):
        return False, "DecoderProxy.start changed upstream"
    if not need_init <= set(init_code.co_names):
        return False, "DecoderProxy.__init__ changed upstream"

    original_handler = proxy._handle_decoder_msg

    def handle(self, msg):
        if msg.msg_type == "READY":
            self.actual_decoder_provider = getattr(msg, "actual_provider", None)
            self.decoder_fallback_note = getattr(msg, "fallback_note", "")
        return original_handler(self, msg)

    def start(self):
        self.actual_decoder_provider = None
        self.decoder_proc = mp.Process(
            target=decoder_entry,
            args=(self.codes_q, self.result_q, self.onnx_path, self.onnx_provider, self.chunk_size, int(threads)),
            daemon=True,
        )
        self.decoder_proc.start()
        self.play_proc = None                      # the plugin's Player handles audio
        self.ready_states["speaker"] = True        # nothing will report it: no speaker process runs
        self.listener_thread = threading.Thread(target=self._listen_loop, daemon=True)
        self.listener_thread.start()
    start.__doc__ = "dsh-pixel-pet: decoder only (no playback subprocess)."
    proxy.start = start
    proxy._handle_decoder_msg = handle
    return True, "ok"


def patch_lazy_encoders():
    """codec/speaker encoders created on first use instead of during engine start."""
    try:
        from qwen3_tts_gguf.inference import engine as eng
        from qwen3_tts_gguf.inference.encoder import CodecEncoder, SpeakerEncoder
    except Exception as exc:  # noqa: BLE001
        return False, "import failed: %s" % type(exc).__name__
    got, want = upstream_hash(eng, "engine.py"), UPSTREAM_SHA256.get("engine.py", "")
    if not got or (want and got != want):
        return False, "upstream engine.py changed (%s)" % (got or "unreadable")[:12]
    init_code = getattr(getattr(eng.TTSEngine, "__init__", None), "__code__", None)
    if init_code is None:
        return False, "TTSEngine.__init__ not inspectable"
    # the encoder classes are looked up by name; the model paths are dict *constants*, not names
    consts = {c for c in init_code.co_consts if isinstance(c, str)}
    if not {"CodecEncoder", "SpeakerEncoder"} <= set(init_code.co_names):
        return False, "TTSEngine.__init__ changed upstream"
    if not {"codec_enc_onnx", "spk_enc_onnx"} <= consts:
        return False, "TTSEngine.__init__ paths changed upstream"

    def lazy(factory):
        box = {"real": None}

        def real():
            if box["real"] is None:
                box["real"] = factory()
            return box["real"]

        class _Lazy:
            def encode(self, x):
                return real().encode(x)

            def encode_audio(self, x):
                return real().encode_audio(x)

            def __getattr__(self, name):
                return getattr(real(), name)

        return _Lazy()

    eng.CodecEncoder = lambda path: lazy(lambda: CodecEncoder(path))
    eng.SpeakerEncoder = lambda path: lazy(lambda: SpeakerEncoder(path))
    return True, "ok"


def decoder_entry(codes_q, result_q, onnx_path, provider, chunk_size, threads=0):
    """Spawn-safe child entry. Attach the *actual warmed session* EP to upstream's real READY.

    Missing DX12 devices or an EP initialization error fall back to CPU here, not to a fictitious DML
    success in the parent. No READY is sent if both constructors/warmups fail.
    """
    import onnxruntime as ort
    from qwen3_tts_gguf.inference import decoder as dec
    from qwen3_tts_gguf.inference.workers.decoder import decoder_worker_proc
    original_session = ort.InferenceSession
    original_decoder = dec.StatefulDecoder
    info = {"provider": None, "note": ""}
    cpu_threads = int(threads) if threads else max(1, (os.cpu_count() or 4) // 4)

    def make_session(*args, **kwargs):
        opts = kwargs.get("sess_options")
        providers = kwargs.get("providers") or []
        dml = "DmlExecutionProvider" in providers
        if opts is not None:
            if dml:
                opts.enable_mem_pattern = False
                opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            elif not getattr(opts, "intra_op_num_threads", 0):
                opts.intra_op_num_threads = cpu_threads
        return original_session(*args, **kwargs)

    def make_decoder(path, onnx_provider="CPU", chunk_size=12):
        try:
            obj = original_decoder(path, onnx_provider=onnx_provider, chunk_size=chunk_size)
        except Exception as exc:
            if onnx_provider == "CPU":
                raise
            info["note"] = "%s initialization failed (%s); CPU fallback" % (onnx_provider, type(exc).__name__)
            obj = original_decoder(path, onnx_provider="CPU", chunk_size=chunk_size)
        info["provider"] = obj.active_provider
        return obj

    class ReportingQueue:
        def put(self, msg):
            if getattr(msg, "msg_type", "") == "READY":
                msg.actual_provider = info["provider"]
                msg.fallback_note = info["note"]
            return result_q.put(msg)

    ort.InferenceSession = make_session
    dec.StatefulDecoder = make_decoder
    decoder_worker_proc(codes_q, ReportingQueue(), onnx_path, provider, chunk_size)


# ---------------------------------------------------------------------------------- decoder state
def _codes_sha(codes):
    try:
        return hashlib.sha1(codes.tobytes()).hexdigest()[:16]
    except Exception:  # noqa: BLE001
        return ""


def _state_path(v, provider, ortver):
    """-> path of the decoder-state cache for this voice, or None when this voice is not cacheable."""
    d, sha, rev = v.get("stateDir"), v.get("anchorSha"), v.get("modelRev")
    if not (d and sha and rev) or provider not in ("CPU", "DML", "CUDA", "TRT"):
        return None
    key = "|".join([str(sha), str(rev), str(provider), str(ortver), str(STATE_SCHEMA)])
    return os.path.join(d, ".state-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:24] + ".npz")


def _state_load(path, v, provider, ortver, codes_sha):
    """-> DecoderState or None. Every field is type-, shape- and size-checked; anything odd means recompute.

    The file is written by us, but it is read from disk on the next start: a truncated, replaced or
    hand-edited .npz must be a cache miss, never a crash and never an unbounded allocation. So:
    allow_pickle=False, a compressed-size cap, a cumulative decompressed cap, per-field ndim/dtype/
    shape whitelists, and a provider + runtime + model + anchor fingerprint in the key AND in the file.
    """
    if not path or not os.path.isfile(path):
        return None
    try:
        import numpy as np
        import zipfile
        from qwen3_tts_gguf.inference.schema.protocol import DecoderState
        if os.path.getsize(path) > STATE_COMPRESSED_LIMIT:
            return None
        # Read the zip's central directory first: uncompressed member sizes are known WITHOUT
        # decompressing anything, so a zip bomb is rejected before numpy allocates a single byte.
        try:
            with zipfile.ZipFile(path) as zf:
                members = zf.infolist()
                sizes = [i.file_size for i in members]
                if (not sizes or len(sizes) > 32 or len({i.filename for i in members}) != len(members)
                        or any(s > STATE_MEMBER_LIMIT for s in sizes) or sum(sizes) > STATE_TOTAL_LIMIT):
                    return None
                # NPY headers can claim a huge shape even in a tiny ZIP entry. Validate the header's
                # allocation size before np.load sees it (central-directory budgets alone aren't enough).
                import math
                for member in members:
                    if not member.filename.endswith(".npy") or "/" in member.filename or "\\" in member.filename:
                        return None
                    with zf.open(member) as f:
                        version = np.lib.format.read_magic(f)
                        if version == (1, 0):
                            shape, order, dtype = np.lib.format.read_array_header_1_0(f, max_header_size=4096)
                        elif version == (2, 0):
                            shape, order, dtype = np.lib.format.read_array_header_2_0(f, max_header_size=4096)
                        else:
                            return None
                        nbytes = math.prod(shape) * dtype.itemsize
                        if dtype.hasobject or nbytes > STATE_MEMBER_LIMIT or f.tell() + nbytes != member.file_size:
                            return None
        except (OSError, ValueError, zipfile.BadZipFile):
            return None
        budget = STATE_TOTAL_LIMIT
        with np.load(path, allow_pickle=False) as z:
            def text(key):
                return str(z[key].item()) if key in z.files else ""
            if text("_schema") != str(STATE_SCHEMA):
                return None
            if text("_anchor_sha") != str(v.get("anchorSha")):
                return None
            if text("_model_rev") != str(v.get("modelRev")):
                return None
            if text("_provider") != str(provider) or text("_ort") != str(ortver):
                return None
            if text("_codes_sha") != codes_sha:
                return None

            def array(key, ndim, shape_ok):
                """Load one member and check dtype/shape/finiteness against the decoder's real layout."""
                nonlocal budget
                if key not in z.files:
                    raise ValueError("missing field " + key)
                a = z[key]
                if not hasattr(a, "dtype") or a.dtype.name not in STATE_DTYPES:
                    raise ValueError("dtype " + str(getattr(a, "dtype", "?")))
                if a.ndim != ndim or not shape_ok(a.shape):
                    raise ValueError("shape %s for %s" % (getattr(a, "shape", "?"), key))
                budget -= int(a.nbytes)
                if budget < 0:
                    raise ValueError("too large")
                if not bool(np.isfinite(a).all()):
                    raise ValueError("not finite")
                return a

            # Pinned decoder.py: 8 layers, 16 heads, dim 64; windows 2/4/4 and KV <=72.
            def hist(ch, window):
                return lambda s: s[0] == 1 and s[1] == ch and 0 <= s[2] <= window
            pre = array("pre_conv_history", 3, hist(512, 2))
            latent = array("latent_buffer", 3, hist(1024, 4))
            conv = array("conv_history", 3, hist(1024, 4))
            kv_len = int(text("_kv_len") or 0)
            if kv_len != 16:
                raise ValueError("kv length %d" % kv_len)
            kv = []
            ref = None
            for i in range(kv_len):
                a = array("kv_%d" % i, 4, lambda s: s[0] == 1 and s[1] == 16 and 0 <= s[2] <= 72 and s[3] == 64)
                if ref is None:
                    ref = a.shape
                elif a.shape != ref:
                    raise ValueError("kv entries disagree")
                kv.append(a)
            if len({a.dtype.name for a in kv} | {pre.dtype.name, latent.dtype.name, conv.dtype.name}) != 1:
                raise ValueError("mixed dtypes")
            skip = int(text("_skip_samples") or -1)
            if skip < 0 or skip > 4 * 1920 * 4:
                raise ValueError("skip_samples %d" % skip)
            audio = None
            if "latent_audio" in z.files:
                audio = array("latent_audio", 1, lambda s: 0 <= s[0] <= 1920 * 8)
                if audio.dtype.name != "float32":
                    raise ValueError("latent_audio dtype")
            state = DecoderState(pre_conv_history=pre, latent_buffer=latent, conv_history=conv,
                                 kv_cache=kv, skip_samples=skip, latent_audio=audio)
        return state
    except Exception:  # noqa: BLE001 - any doubt, damaged or unexpected file is a cache miss
        return None


def _state_save(path, v, provider, ortver, voice):
    """Persist the anchor's decoder state atomically; failures only cost the next start its shortcut."""
    if not path or voice is None:
        return False
    state = getattr(voice, "final_state", None)
    if state is None:
        return False
    tmp = None
    try:
        import numpy as np
        kv = [np.asarray(a) for a in (getattr(state, "kv_cache", None) or [])]
        fields = {
            "pre_conv_history": getattr(state, "pre_conv_history", None),
            "latent_buffer": getattr(state, "latent_buffer", None),
            "conv_history": getattr(state, "conv_history", None),
            "latent_audio": getattr(state, "latent_audio", None),
        }
        payload = {}
        for name, arr in fields.items():
            if arr is not None:
                arr = np.asarray(arr)
                # only what _state_load can accept is written: a cache that never reads back is not a cache
                if arr.dtype.name not in STATE_DTYPES or not bool(np.isfinite(arr).all()):
                    return False
                if name == "latent_audio" and arr.dtype.name != "float32":
                    return False
                payload[name] = arr
        for i, arr in enumerate(kv):
            if arr.dtype.name not in STATE_DTYPES or not bool(np.isfinite(arr).all()):
                return False
            payload["kv_%d" % i] = arr
        if not payload:
            return False
        payload.update({
            "_schema": np.int64(STATE_SCHEMA),
            "_anchor_sha": str(v.get("anchorSha")),
            "_model_rev": str(v.get("modelRev")),
            "_provider": str(provider),
            "_ort": str(ortver),
            "_codes_sha": _codes_sha(getattr(voice, "codes", None)),
            "_kv_len": np.int64(len(kv)),
            "_skip_samples": np.int64(int(getattr(state, "skip_samples", 0) or 0)),
        })
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".%d.tmp" % os.getpid()
        with open(tmp, "wb") as f:
            np.savez_compressed(f, **payload)
        os.replace(tmp, path)
        return True
    except Exception:  # noqa: BLE001
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def set_voice(stream, v, provider="", ortver="", use_cache=True):
    """Anchor json (shipped or cached) when present, else encode the reference audio once and cache it.

    The decoder-state cache only ever applies to the voice spec that carries stateDir/anchorSha, which
    tts.py sets for a shipped preset only (a user's clone is never hashed or read for the cache).
    use_cache=False recomputes the decoder memory and leaves the file alone (the failed-hit path).
    """
    state_path = _state_path(v, provider, ortver) if use_cache else None
    for key in ("anchor", "anchorCache"):
        p = v.get(key)
        if p and os.path.isfile(p):
            if state_path:
                restored = _restore_voice(stream, p, v, provider, ortver, state_path)
                if restored:
                    return restored
            if stream.set_voice(p):
                if state_path:
                    _state_save(state_path, v, provider, ortver, getattr(stream, "voice", None))
                return "anchor"
    ref = v.get("ref")
    if not ref or not os.path.isfile(ref):
        raise RuntimeError("音色缺参考音频")
    res = stream.set_voice(ref, text=v.get("text") or "")
    if not res:
        raise RuntimeError("参考音频编码失败")
    target = v.get("anchor") if v.get("anchor") and not v.get("anchorCache") else v.get("anchorCache")
    if target:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            res.save(target)
        except Exception:  # noqa: BLE001
            pass
    return "encoded"


def _restore_voice(stream, anchor_path, v, provider, ortver, state_path):
    """Anchor + cached decoder memory -> skip the pre-decode pass. -> label or None on any doubt."""
    host = None
    try:
        from qwen3_tts_gguf.inference.schema.result import TTSResult
        host = TTSResult.from_json(str(anchor_path))
        if host is None or not getattr(host, "is_valid_anchor", False):
            return None
        sha = _codes_sha(getattr(host, "codes", None))
        state = _state_load(state_path, v, provider, ortver, sha)
        if state is None:
            return None
        host.final_state = state
        if stream.set_voice(host):
            return "anchor+state"
    except Exception:  # noqa: BLE001 - fall back to the normal path below
        return None
    return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-dir", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--pylibs", default="")
    ap.add_argument("--provider", default="auto")
    ap.add_argument("--threads", type=int, default=-1,
                    help="CPU decode intra-op threads; -1 = auto (cpu_count//4), 0 = upstream default")
    ap.add_argument("--no-patches", action="store_true")
    a = ap.parse_args(argv)
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for p in (a.engine_dir, a.pylibs):
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)
    t0 = time.time()
    patches = {}
    threads = 0
    try:
        from qwen3_tts_gguf.inference import TTSConfig, TTSEngine  # noqa: F401
        requested, effective, pnote = pick_provider(a.provider)
        if effective == "CPU":
            threads = a.threads if a.threads >= 0 else max(1, (os.cpu_count() or 4) // 4)
        if not a.no_patches:
            ok, note = patch_lazy_encoders()
            patches["lazy-encoders"] = "applied" if ok else "skipped: " + note
            ok, note = patch_no_play_proc(threads=threads, streaming=STREAMING)
            patches["no-play-proc"] = "applied" if ok else "skipped: " + note
        else:
            patches["lazy-encoders"] = patches["no-play-proc"] = "skipped: --no-patches"
        ov = ort_version()
        engine = TTSEngine(model_dir=a.model_dir, onnx_provider=effective, verbose=False)
        stream = engine.create_stream() if engine.ready else None
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "message": "语音引擎加载失败：%s: %s" % (type(exc).__name__, str(exc)[:200])})
        return 2
    if stream is None:
        emit({"event": "error", "message": "语音引擎没就绪（解码器或声卡初始化失败）"})
        try:
            engine.shutdown()
        except Exception:  # noqa: BLE001
            pass
        return 2
    decoder = getattr(stream, "decoder", None)
    decoder_ep = getattr(decoder, "actual_decoder_provider", None)
    offered = effective
    # Only the patched child can attest which session survived warmup. If the version guard skipped
    # it, do not key a cache or claim a speedup on the basis of requested/available providers alone.
    effective = {"CPUExecutionProvider": "CPU", "DmlExecutionProvider": "DML",
                 "CUDAExecutionProvider": "CUDA", "TensorrtExecutionProvider": "TRT"}.get(decoder_ep, "UNKNOWN")
    pnote = "; ".join(s for s in (pnote, getattr(decoder, "decoder_fallback_note", "")) if s)
    emit({"event": "ready", "loadS": round(time.time() - t0, 2),
          "requested": requested, "offered": offered, "effective": effective, "decoder": decoder_ep or "unverified",
          "decoder_verified": bool(decoder_ep), "note": pnote,
          "ort": ov, "threads": threads, "streaming": STREAMING, "patches": patches})

    current = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid, op = req.get("id"), req.get("op")
        if op == "quit":
            break
        if op == "ping":
            emit({"id": rid, "ok": True})
            continue
        if op != "synth":
            emit({"id": rid, "ok": False, "message": "unknown op"})
            continue
        try:
            t1 = time.time()
            v = req.get("voice") or {}
            text = str(req.get("text") or "").strip()
            seed = int(req.get("seed") or 42)
            cfg = TTSConfig(temperature=0.6, sub_temperature=0.6, seed=seed, sub_seed=seed + 3, streaming=STREAMING,
                            max_steps=max(120, min(900, 40 + len(text) * 9)))

            def once(voice_spec, use_cache=True):
                how = "cached"
                if current != voice_spec.get("key"):
                    how = set_voice(stream, voice_spec, effective, ov, use_cache=use_cache)
                    return how, stream.clone(text=text, language=voice_spec.get("language") or "chinese",
                                             zero_shot=(voice_spec.get("mode") != "icl"), config=cfg), True
                return how, stream.clone(text=text, language=voice_spec.get("language") or "chinese",
                                         zero_shot=(voice_spec.get("mode") != "icl"), config=cfg), False

            how, res, switched = once(v)
            if switched:
                current = v.get("key")
            if (res is None or res.audio is None or len(res.audio) == 0) and how == "anchor+state" and switched:
                # A restored decoder memory that the decoder rejects must not turn an optimisation into a
                # failure: drop that file and redo the voice setup from the pre-decode path, exactly once.
                bad = _state_path(v, effective, ov)
                if bad:
                    try:
                        os.remove(bad)
                    except OSError:
                        pass
                current = None
                how, res, switched = once(v, use_cache=False)
                if switched:
                    current = v.get("key")
            if res is None or res.audio is None or len(res.audio) == 0:
                current = None
                raise RuntimeError("这一句没合成出来")
            res.save(req["out"])
            emit({"id": rid, "ok": True, "wav": req["out"], "voice": how, "s": round(time.time() - t1, 3),
                  "audioS": round(float(res.duration), 3)})
        except Exception as exc:  # noqa: BLE001
            emit({"id": rid, "ok": False, "message": "%s: %s" % (type(exc).__name__, str(exc)[:200])})
    try:
        engine.shutdown()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
