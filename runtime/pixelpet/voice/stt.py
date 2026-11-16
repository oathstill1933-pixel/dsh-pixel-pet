"""Speech to text. The plugin ships no recogniser.

    dsh         (default) the recogniser DSH's own voice input uses (SenseVoice, `ctx.speechToText`).
                The pet posts a 16 kHz mono PCM16 wav to the plugin host route /api/stt, the host hands it
                to that service. Nothing leaves the machine.
    local-http  any loopback recogniser that takes raw PCM and answers JSON {"text": "..."}
    off         no voice input (text questions still work)

Contract: transcribe(pcm: bytes, sample_rate=16000) -> str   (16-bit mono little-endian PCM)
"""
import io
import json
import os
import wave
from urllib.parse import urlparse

from . import VoiceError


class SttEngine:
    name = "base"

    def available(self):
        return True

    def transcribe(self, pcm, sample_rate=16000):
        raise NotImplementedError


class NoStt(SttEngine):
    name = "off"

    def available(self):
        return False

    def transcribe(self, pcm, sample_rate=16000):
        raise VoiceError("语音识别关着")


class StubStt(SttEngine):
    """Returns queued texts in order (then ""), records what it was given."""
    name = "stub"

    def __init__(self, *texts):
        self.texts = list(texts)
        self.calls = []

    def transcribe(self, pcm, sample_rate=16000):
        if not isinstance(pcm, (bytes, bytearray)):
            raise TypeError("pcm must be bytes")
        self.calls.append((len(pcm), sample_rate))
        return self.texts.pop(0) if self.texts else ""


def wav_bytes(pcm, sample_rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(pcm))
    return buf.getvalue()


def resample16k(pcm, rate):
    """Linear resample of PCM16 mono to 16 kHz (mic devices that refuse 16 kHz)."""
    if rate == 16000:
        return bytes(pcm)
    import array
    src = array.array("h")
    src.frombytes(bytes(pcm))
    n = int(len(src) * 16000 / rate)
    out = array.array("h", [0]) * n
    step = rate / 16000.0
    for i in range(n):
        x = i * step
        j = int(x)
        k = min(j + 1, len(src) - 1)
        out[i] = int(src[j] + (src[k] - src[j]) * (x - j))
    return out.tobytes()


class HostStt(SttEngine):
    """DSH's built-in recogniser, reached through the plugin host (which holds ctx.speechToText)."""
    name = "dsh"

    def __init__(self, host_base=None, key=None, timeout=60, post=None):
        self.host_base = (host_base or os.environ.get("PIXELPET_HOST_BASE") or "").rstrip("/")
        self.key = key if key is not None else os.environ.get("PIXELPET_BRIDGE_KEY", "")
        u = urlparse(self.host_base)
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("识别只走本机 DSH 地址")
        self.timeout = timeout
        self._post = post or _post_status

    def transcribe(self, pcm, sample_rate=16000):
        if not isinstance(pcm, (bytes, bytearray)):
            raise TypeError("pcm must be bytes")
        body = wav_bytes(resample16k(pcm, sample_rate), 16000)
        status, data = self._post(self.host_base + "/api/stt", body,
                                  {"Content-Type": "audio/wav", "X-PixelPet-Key": self.key}, self.timeout)
        try:
            obj = json.loads(data.decode("utf-8"))
        except Exception:  # noqa: BLE001
            obj = {}
        if status != 200 or not obj.get("ok"):
            raise VoiceError(obj.get("message") or "识别失败（HTTP %s）" % status)
        return str(obj.get("text") or "").strip()


class LocalHttpStt(SttEngine):
    """POST raw PCM to a loopback recogniser; expects JSON {"text": "..."}."""
    name = "local-http"

    def __init__(self, endpoint, timeout=25, post=None):
        u = urlparse(endpoint or "")
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("识别服务只接受本机地址（http://127.0.0.1:端口/...）")
        self.endpoint, self.timeout = endpoint, timeout
        self._post = post or _post

    def available(self):
        return bool(self.endpoint)

    def transcribe(self, pcm, sample_rate=16000):
        data = self._post(self.endpoint, bytes(pcm), {"Content-Type": "application/octet-stream",
                                                     "X-Sample-Rate": str(sample_rate)}, self.timeout)
        try:
            return str(json.loads(data.decode("utf-8")).get("text") or "").strip()
        except Exception:  # noqa: BLE001
            return ""


def _post(url, body, headers, timeout):
    import urllib.request
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _post_status(url, body, headers, timeout):
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        raise VoiceError("连不上 DSH：%s" % getattr(e, "reason", e))


def make_stt(cfg):
    kind = (cfg or {}).get("engine", "dsh")
    if kind == "local-http":
        return LocalHttpStt(cfg.get("endpoint", ""))
    if kind in ("dsh", "stub"):              # "stub": placeholder default of earlier builds
        try:
            return HostStt()
        except ValueError:
            return NoStt()
    return NoStt()
