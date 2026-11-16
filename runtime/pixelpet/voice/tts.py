"""Text to speech.

Engines (settings.voice.tts.engine):
    qwen    built-in Qwen3-TTS (GGUF) running in its own worker process (runtime/tts_worker.py)
    custom  the user's own TTS: a loopback HTTP endpoint or a command template that turns {text} into a wav
Voices for `qwen`:
    <character id>    a public preset from an authorized, enabled pack or the built-in characters/
    clone-<10 hex>    a voice the user cloned from their own reference audio (data dir only, never shipped)

Contract shared by every engine:
    synthesize(text, voice) -> path of a .wav file (one sentence; the bridge splits longer replies)
"""
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import wave
from urllib.parse import urlparse

from . import DependencyMissing, VoiceError
from ..packkit import PackKitError, enumerate_packs, packed_characters, read_voice_preset

REF_EXTS = (".wav", ".flac", ".mp3", ".ogg")
DEFAULT_VOICE = "whale-girl"
MARK = "@@pp "
_SENT_END = "。！？!?；;…\n"
# worker idle lifetime: a lonely pet keeps it short, continuous listening keeps it resident
IDLE_SECONDS = 120
IDLE_LISTENING_SECONDS = 1800


# ---------------------------------------------------------------------------------------------- text
def split_sentences(text, limit=48, first_short=True):
    """Reply -> short speakable chunks (sentence ends first, then commas, then a hard cut).

    first_short: the very first chunk is cut at a comma after 6-14 characters when it would otherwise
    be long, because that chunk is the first thing the user hears (the rest goes out while it plays).
    """
    text = re.sub(r"[ \t\r\f\v]+", " ", str(text or "")).strip()
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"[*_`#>]+", "", text)
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch in _SENT_END:
            _push(out, buf, limit)
            buf = ""
    _push(out, buf, limit)
    merged = []
    for s in out:                       # glue tiny fragments ("嗯。") to the next one
        if merged and len(merged[-1]) < 4:
            merged[-1] += s
        else:
            merged.append(s)
    merged = [s for s in merged if re.search(r"\w", s)]
    if first_short and merged:
        cut = _first_short_split(merged[0])
        if cut:
            merged = cut + merged[1:]
    return merged


def _first_short_split(sentence, low=6, high=14):
    """["前半句，", "后半句"] for the first sentence when a comma lands inside [low, high] chars."""
    if len(sentence) <= high:
        return None
    for i, ch in enumerate(sentence):
        if ch not in "，,、：:":
            continue
        cut = i + 1
        if cut < low:
            continue
        if cut > high:
            return None
        head, tail = sentence[:cut].strip(), sentence[cut:].strip()
        if head and tail and re.search(r"\w", tail):
            return [head, tail]
        return None
    return None


def _push(out, s, limit):
    s = s.strip()
    while len(s) > limit:
        cut = max(s.rfind(c, 0, limit) for c in "，,、：: ")
        cut = cut + 1 if cut >= limit // 3 else limit
        out.append(s[:cut].strip())
        s = s[cut:].strip()
    if s:
        out.append(s)


def wav_seconds(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except (OSError, wave.Error, EOFError):
        return 0.0


# ---------------------------------------------------------------------------------------------- voices
class VoiceStore:
    """Presets from character packs + the user's clones."""
    ID_RE = re.compile(r"^(clone-[0-9a-f]{10}|[a-z0-9][a-z0-9-]{0,39})$")

    def __init__(self, data_dir, pack_root=None):
        self.data_dir = data_dir
        self.pack_root = pack_root or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        self.root = os.path.join(data_dir, "voices")

    def _preset(self, vid, packed):
        builtin = os.path.join(self.pack_root, "characters", vid)
        installed = packed.get(vid)
        for folder in (installed[1] if installed else None, builtin):
            if not folder:
                continue
            try:
                preset = read_voice_preset(folder)
            except PackKitError:
                continue
            if preset:
                return preset
        return None

    def presets(self):
        packed = packed_characters(self.data_dir)
        ids = dict.fromkeys([os.path.basename(p) for p in enumerate_packs(self.pack_root, "character")] + list(packed))
        out = []
        for vid in ids:
            preset = self._preset(vid, packed)
            if preset:
                out.append({"id": vid, "name": preset["meta"]["name"], "kind": "preset"})
        return out

    def clones(self):
        out = []
        try:
            names = sorted(os.listdir(self.root))
        except OSError:
            return out
        for vid in names:
            meta = os.path.join(self.root, vid, "voice.json")
            if self.ID_RE.match(vid) and vid.startswith("clone-") and os.path.isfile(meta):
                try:
                    with open(meta, encoding="utf-8") as f:
                        m = json.load(f)
                except (OSError, ValueError):
                    continue
                out.append({"id": vid, "name": str(m.get("name") or vid), "kind": "clone", "hasText": bool(m.get("text"))})
        return out

    def list(self):
        return self.presets() + self.clones()

    def resolve(self, vid):
        """-> spec for the worker: {key, ref, text, anchor, mode, language}. Unknown ids fall back to the default preset."""
        vid = str(vid or "")
        if vid.startswith("clone-") and self.ID_RE.match(vid):
            d = os.path.join(self.root, vid)
            meta = _read_json(os.path.join(d, "voice.json"))
            if meta:
                ref = os.path.join(d, meta.get("ref") or "ref.wav")
                text = str(meta.get("text") or "")
                return {"key": vid + ":" + _digest(ref), "ref": ref, "text": text,
                        "anchor": os.path.join(d, "anchor.json"),
                        "mode": "icl" if text and meta.get("mode") == "icl" else "zero_shot",
                        "language": meta.get("language") or "chinese"}
        packed = packed_characters(self.data_dir)
        for cand in dict.fromkeys(([vid] if self.ID_RE.fullmatch(vid) and not vid.startswith("clone-") else []) + [DEFAULT_VOICE]):
            preset = self._preset(cand, packed)
            if not preset:
                continue
            meta, ref, anchor = preset["meta"], preset["ref"], preset["anchor"]
            spec = {"key": "preset:" + cand + ":" + _digest(anchor), "ref": ref, "text": meta.get("text", ""),
                    "anchor": anchor, "anchorCache": os.path.join(self.data_dir, "voices", ".preset-" + cand + ".json"),
                    "mode": meta["mode"], "language": meta["language"] or "chinese"}
            # Decoder-state cache: public presets from built-in characters and enabled packs only.
            # A user's clone is never hashed or cached by this branch.
            sha = content_sha256(anchor)
            if sha:
                spec["key"] = "preset:" + cand + ":" + sha
                spec["anchorSha"], spec["stateDir"] = sha, os.path.join(self.data_dir, "voices")
            return spec
        raise VoiceError("没有可用的音色")

    def add(self, ref_audio, name=None, text=None):
        if not os.path.isfile(ref_audio):
            raise FileNotFoundError(ref_audio)
        ext = os.path.splitext(ref_audio)[1].lower()
        if ext not in REF_EXTS:
            raise ValueError("参考音频只支持 %s" % " / ".join(REF_EXTS))
        with open(ref_audio, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()[:10]
        vid = "clone-" + digest
        dest = os.path.join(self.root, vid)
        os.makedirs(dest, exist_ok=True)
        shutil.copyfile(ref_audio, os.path.join(dest, "ref" + ext))
        try:
            os.remove(os.path.join(dest, "anchor.json"))    # the reference may have new text: re-encode
        except OSError:
            pass
        text = str(text or "").strip()[:400]
        with open(os.path.join(dest, "voice.json"), "w", encoding="utf-8") as f:
            json.dump({"name": (name or vid)[:40], "ref": "ref" + ext, "text": text, "mode": "icl" if text else "zero_shot",
                       "createdAt": int(time.time())}, f, ensure_ascii=False)
        return vid

    def has(self, vid):
        return os.path.isfile(os.path.join(self.root, vid, "voice.json"))

    def remove(self, vid):
        if vid.startswith("clone-") and self.ID_RE.match(vid):
            shutil.rmtree(os.path.join(self.root, vid), ignore_errors=True)


def _read_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def _digest(path):
    try:
        st = os.stat(path)
        return "%x-%x" % (st.st_size, int(st.st_mtime))
    except (OSError, TypeError):
        return "0"


def content_sha256(path, chunk=1 << 20):
    """sha256 of a file's bytes; only ever pointed at public preset anchors (never a user clone)."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(chunk), b""):
                h.update(block)
    except (OSError, TypeError):
        return ""
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------- engines
class TtsEngine:
    name = "base"

    def __init__(self, data_dir):
        self.out = os.path.join(data_dir, "tts-cache")
        self._n = 0

    def _out_path(self):
        os.makedirs(self.out, exist_ok=True)
        self._n += 1
        _prune(self.out, keep=40)
        return os.path.join(self.out, "%d-%d.wav" % (int(time.time() * 1000), self._n))

    def synthesize(self, text, voice=DEFAULT_VOICE):
        raise NotImplementedError

    def warm(self):
        pass

    def warm_async(self):
        """Start loading in the background; never blocks the UI thread and never raises."""
        return False

    def set_idle(self, seconds):
        """How long an idle engine stays resident (does not stop a running one)."""
        return False

    def close(self):
        pass


def _prune(folder, keep):
    try:
        files = sorted((os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".wav")), key=os.path.getmtime)
    except OSError:
        return
    for p in files[:-keep]:
        try:
            os.remove(p)
        except OSError:
            pass


class StubTts(TtsEngine):
    """A short tone per request (length grows with text), so playback paths are testable without a model."""
    name = "stub"

    def __init__(self, data_dir, pack_root=None):
        super().__init__(data_dir)
        self.store = VoiceStore(data_dir, pack_root)
        self.calls = []

    def voices(self):
        return self.store.list()

    def synthesize(self, text, voice=DEFAULT_VOICE):
        text = str(text or "").strip()
        if not text:
            raise ValueError("没有要念的文字")
        if str(voice).startswith("clone-") and not self.store.has(voice):
            raise KeyError("没有这个音色：%s" % voice)
        path = self._out_path()
        _tone(path, seconds=min(3.0, 0.15 + 0.03 * len(text)))
        self.calls.append((text, voice, path))
        return path

    def clone(self, ref_audio, name=None, text=None):
        return self.store.add(ref_audio, name, text)


class QwenTts(TtsEngine):
    """Built-in Qwen3-TTS. The model lives in a worker process that is started on first use and stopped
    after `idle_s` without requests, so the pet itself stays light."""
    name = "qwen"

    def __init__(self, data_dir, deps, store, python=None, worker=None, provider="auto", idle_s=IDLE_SECONDS,
                 load_timeout=240, env=None):
        super().__init__(data_dir)
        from .deps import runtime_paths
        self.deps, self.store = deps, store
        self.paths = runtime_paths(data_dir)
        self.python = python or sys.executable
        self.worker = worker or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tts_worker.py")
        self.provider = provider
        self.idle_s, self.load_timeout = idle_s, load_timeout
        self.extra_env = env or {}
        self.log_path = os.path.join(data_dir, "logs", "tts-worker.log")
        self.last_error = None
        self._proc = None
        self._lock = threading.Lock()
        self._replies = {}
        self._cv = threading.Condition()
        self._seq = 0
        self._last = 0.0
        self._ready = None
        self._timer = None
        self._warm_lock = threading.Lock()
        self._warm_thread = None
        self._warm_done = None          # { ok, message, s } of the last warm attempt
        self._closing = False           # close() during a warm must not leave a decoder behind
        self._busy = 0                  # requests in flight: the idle timer must never kill those

    def available(self):
        return self.deps.ready()

    def _need(self):
        for dep in ("py-deps", "qwen3-tts-engine", "qwen3-tts-model"):
            if dep in self.deps.catalog and not self.deps.installed(dep):
                raise DependencyMissing(dep)

    # ---- worker process
    def _start(self):
        if self._closing:
            raise VoiceError("语音引擎已关闭")
        self._need()
        if self._closing:
            raise VoiceError("语音引擎已关闭")
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", **self.extra_env)
        cmd = [self.python, "-X", "utf8", "-u", self.worker, "--engine-dir", self.paths["engine"],
               "--model-dir", self.paths["model"], "--pylibs", self.paths["pylibs"], "--provider", self.provider]
        log = open(self.log_path, "ab")
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=env,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        log.close()
        self._ready = None
        threading.Thread(target=self._read, args=(self._proc,), daemon=True).start()
        deadline = time.monotonic() + self.load_timeout
        with self._cv:
            while (not self._closing and self._ready is None and self._proc.poll() is None
                   and time.monotonic() < deadline):
                self._cv.wait(0.5)
        if not (self._ready and self._ready.get("event") == "ready"):
            msg = (self._ready or {}).get("message") or ("语音引擎没启动起来（%s）" % ("超时" if self._proc.poll() is None else "进程退出"))
            self._kill()
            raise VoiceError(msg)

    def _read(self, proc):
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith(MARK):
                continue
            try:
                msg = json.loads(line[len(MARK):])
            except ValueError:
                continue
            with self._cv:
                if proc is not self._proc:
                    return              # generation check and mutation must be atomic under the CV
                if "id" in msg:
                    self._replies[msg["id"]] = msg
                else:
                    self._ready = msg
                self._cv.notify_all()
        with self._cv:
            if proc is not self._proc:
                return                  # this reader belongs to a worker we already replaced
            if self._ready is None:
                self._ready = {"event": "exit"}
            self._cv.notify_all()

    def _kill(self):
        with self._cv:
            p, self._proc = self._proc, None
            self._replies.clear()
            self._cv.notify_all()
        if p is None:
            return
        try:
            p.stdin.write(b'{"op":"quit"}\n')
            p.stdin.flush()
            p.wait(3)
        except Exception:  # noqa: BLE001
            pass
        if p.poll() is None:
            try:
                # Only our tracked worker tree; no service names or unrelated PIDs are targeted.
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if p.poll() is None:
                    p.kill()
                p.wait(5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        for s in (p.stdin, p.stdout):
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass

    def _arm_idle(self):
        if self._timer:
            self._timer.cancel()
        if self.idle_s and not self._closing:
            self._timer = threading.Timer(self.idle_s, self._idle_check)
            self._timer.daemon = True
            self._timer.start()

    def _idle_check(self):
        with self._lock:
            if self._closing or not self.idle_s:
                return
            if self._busy:                      # a request is in flight: re-arm, never kill it
                self._last = time.monotonic()
                self._arm_idle()
                return
            if time.monotonic() - self._last >= self.idle_s - 1:
                self._kill()

    def warm(self):
        with self._lock:
            if self._closing:
                return
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            self._last = time.monotonic()
            self._arm_idle()

    def warm_async(self):
        """Load the engine now, on a background thread, coalesced: N calls in a row start one load.

        Called when a turn is about to need audio (VAD start / hotkey / mic / ask) so the ~5-10 s of
        model loading overlaps with STT and the LLM. Never raises into the caller.
        """
        with self._warm_lock:
            if self._closing:
                return False
            if self._warm_thread is not None and self._warm_thread.is_alive():
                return False
            if self._proc is not None and self._proc.poll() is None:
                self._last = time.monotonic()
                self._arm_idle()
                return False
            t0 = time.monotonic()
            self._warm_done = None

            def run():
                try:
                    self.warm()
                    self._warm_done = {"ok": True, "s": round(time.monotonic() - t0, 2)}
                except Exception as exc:  # noqa: BLE001 - a failed warm must not break audio
                    self.last_error = "预热失败：%s" % str(exc)[:160]
                    self._warm_done = {"ok": False, "message": self.last_error}
            self._warm_thread = threading.Thread(target=run, daemon=True, name="tts-warm")
            self._warm_thread.start()
            return True

    def warm_result(self, timeout=0.0):
        """-> None while a warm is still running, else {'ok': bool, ...} of the last attempt."""
        t = self._warm_thread
        if t is None:
            return self._warm_done
        if t.is_alive() and timeout > 0:
            t.join(timeout)
        if t.is_alive():
            return None
        return self._warm_done

    def set_idle(self, seconds):
        """Idle lifetime; re-arms the timer when the engine is up."""
        try:
            seconds = max(0, int(seconds))
        except (TypeError, ValueError):
            return False
        self.idle_s = seconds
        if self._proc is not None and self._proc.poll() is None:
            self._last = time.monotonic()
            self._arm_idle()
        return True

    def request(self, body, timeout):
        with self._lock:
            if self._closing:
                raise VoiceError("语音引擎已关闭")
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            self._seq += 1
            rid = self._seq
            data = (json.dumps(dict(body, id=rid), ensure_ascii=False) + "\n").encode("utf-8")
            self._busy += 1
            try:
                try:
                    self._proc.stdin.write(data)
                    self._proc.stdin.flush()
                except OSError:
                    self._kill()
                    raise VoiceError("语音引擎断开了")
                deadline = time.monotonic() + timeout
                with self._cv:
                    while rid not in self._replies and self._proc and self._proc.poll() is None and time.monotonic() < deadline:
                        self._cv.wait(0.5)
                    msg = self._replies.pop(rid, None)
                if msg is None:
                    self._kill()
                    raise VoiceError("语音引擎没回应")
                self._last = time.monotonic()
                self._arm_idle()
                if not msg.get("ok"):
                    raise VoiceError(msg.get("message") or "合成失败")
                return msg
            finally:
                self._busy = max(0, self._busy - 1)

    def _model_rev(self):
        """Pinned revision of the decoder model files: part of the decoder-state cache key."""
        try:
            from .deps import component_rev
            comp = (self.deps.catalog or {}).get("qwen3-tts-model")
            return component_rev(comp) if comp else ""
        except Exception:  # noqa: BLE001 - a cache key must never break synthesis
            return ""

    def synthesize(self, text, voice=DEFAULT_VOICE, seed=42):
        text = str(text or "").strip()
        if not text:
            raise ValueError("没有要念的文字")
        spec = self.store.resolve(voice)
        if spec.get("stateDir"):
            spec["modelRev"] = self._model_rev()
        out = self._out_path()
        msg = self.request({"op": "synth", "text": text, "voice": spec, "out": out, "seed": seed},
                           timeout=60 + 4 * len(text))
        self.last_stats = msg
        return msg.get("wav") or out

    def clone(self, ref_audio, name=None, text=None):
        return self.store.add(ref_audio, name, text)

    def close(self):
        self._closing = True            # first thing: a warm finishing later must not revive the worker
        if self._timer:
            self._timer.cancel()
        warm = self._warm_thread
        with self._lock:
            self._kill()
        if warm is not None and warm.is_alive():
            # a load in progress would otherwise finish after the kill and leave a decoder behind
            warm.join(5)
            with self._lock:
                self._kill()


class CustomTts(TtsEngine):
    """The user's own TTS.

    mode=http:    POST {"text", "voice"} as JSON to a loopback URL; the reply is wav bytes
                  (or JSON {"path": "<wav on this machine>"}).
    mode=command: an argument template, e.g.  mytts --text {text} --out {out}
                  run without a shell; the wav is read from {out}, or from stdout when {out} is absent.
    """
    name = "custom"

    def __init__(self, data_dir, cfg, post=None, run=None, timeout=120):
        super().__init__(data_dir)
        cfg = cfg or {}
        self.mode = cfg.get("mode") or "http"
        self.url = str(cfg.get("url") or "")
        self.command = str(cfg.get("command") or "")
        self.voice_name = str(cfg.get("voice") or "")
        self.timeout = timeout
        self._post = post or _post_bytes
        self._run = run or _run_cmd
        if self.mode == "http":
            u = urlparse(self.url)
            if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
                raise VoiceError("自定义 TTS 只接本机地址（http://127.0.0.1:端口/...）")
        elif self.mode == "command":
            if "{text}" not in self.command and "{textfile}" not in self.command:
                raise VoiceError("命令模板里要有 {text}")
        else:
            raise VoiceError("自定义 TTS 的方式只有 http / command")

    def synthesize(self, text, voice=None):
        text = str(text or "").strip()
        if not text:
            raise ValueError("没有要念的文字")
        out = self._out_path()
        if self.mode == "http":
            body = json.dumps({"text": text, "voice": self.voice_name}, ensure_ascii=False).encode("utf-8")
            data, ctype = self._post(self.url, body, self.timeout)
            if data[:4] != b"RIFF":
                try:
                    p = json.loads(data.decode("utf-8")).get("path")
                except Exception:  # noqa: BLE001
                    p = None
                if not p or not os.path.isfile(p):
                    raise VoiceError("自定义 TTS 没返回 wav")
                with open(p, "rb") as f:
                    data = f.read()
            with open(out, "wb") as f:
                f.write(data)
        else:
            textfile = out[:-4] + ".txt"
            with open(textfile, "w", encoding="utf-8") as f:
                f.write(text)
            argv = [a.replace("{text}", text).replace("{out}", out).replace("{textfile}", textfile)
                    for a in split_template(self.command)]
            code, stdout, stderr = self._run(argv, self.timeout)
            try:
                os.remove(textfile)
            except OSError:
                pass
            if code != 0:
                raise VoiceError("自定义 TTS 命令失败（退出码 %s）%s" % (code, (" " + stderr[-120:]) if stderr else ""))
            if "{out}" not in self.command:
                with open(out, "wb") as f:
                    f.write(stdout)
        with open(out, "rb") as f:
            if f.read(4) != b"RIFF":
                raise VoiceError("自定义 TTS 输出的不是 wav")
        return out


def split_template(cmd):
    """Whitespace-separated, double quotes group words; no shell, so nothing in {text} is ever interpreted."""
    out, cur, quoted, has = [], "", False, False
    for ch in str(cmd):
        if ch == '"':
            quoted, has = not quoted, True
        elif ch.isspace() and not quoted:
            if cur or has:
                out.append(cur)
            cur, has = "", False
        else:
            cur += ch
    if cur or has:
        out.append(cur)
    return out


def _post_bytes(url, body, timeout):
    import urllib.request
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def _run_cmd(argv, timeout):
    try:
        r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except FileNotFoundError:
        raise VoiceError("找不到命令：%s" % (argv[0] if argv else ""))
    except subprocess.TimeoutExpired:
        raise VoiceError("自定义 TTS 命令超时")
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace").strip()


def _tone(path, seconds=0.3, rate=16000, hz=660):
    n = int(rate * seconds)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * hz * i / rate) * min(1, (n - i) / 800)))
                               for i in range(n)))


def concat_wavs(paths, out):
    """Join same-format wavs (sentences of one reply) into one file."""
    params, frames = None, []
    for p in paths:
        with wave.open(p) as w:
            if params is None:
                params = w.getparams()
            frames.append(w.readframes(w.getnframes()))
    with wave.open(out, "wb") as w:
        w.setparams(params)
        for fr in frames:
            w.writeframes(fr)
    return out


def make_tts(cfg, data_dir, deps, pack_root=None, **kw):
    cfg = cfg or {}
    store = VoiceStore(data_dir, pack_root)
    engine = cfg.get("engine")
    if engine == "custom":
        return CustomTts(data_dir, cfg.get("custom"))
    # "stub" was the placeholder default of earlier builds; old settings files still carry it -> built-in engine
    return QwenTts(data_dir, deps, store, **kw)
