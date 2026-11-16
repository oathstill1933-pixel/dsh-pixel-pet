"""Microphone capture for push-to-talk.

Recorder.start() opens the default input device (16 kHz mono PCM16 through `sounddevice`, which the
voice component installs); stop() returns the PCM bytes. With `auto_stop`, should_stop() turns true
after the speaker has talked and then stayed quiet for `tail_s` (used by the menu "说话" entry, where
nobody holds a key). Hard cap `max_s`.

key_down(name) polls a global key (Windows GetAsyncKeyState) so a held hotkey works without hooks.
"""
import array
import math
import os
import sys
import threading
import time

from . import VoiceError

VK = {"F6": 0x75, "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
      "Pause": 0x13, "ScrollLock": 0x91, "XButton1": 0x05, "XButton2": 0x06, "RCtrl": 0xA3, "RAlt": 0xA5}


def key_down(name):
    vk = VK.get(name)
    if not vk or os.name != "nt":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)
    except Exception:  # noqa: BLE001
        return False


def add_pylibs(data_dir):
    """Make the component-installed packages importable here (appended: the pet's own packages win)."""
    from .deps import py_tag
    p = os.path.join(data_dir, "pylibs", py_tag())
    if os.path.isdir(p) and p not in sys.path:
        sys.path.append(p)


def rms(pcm):
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if not a:
        return 0.0
    return math.sqrt(sum(x * x for x in a) / len(a))


class Recorder:
    RATE = 16000

    def __init__(self, data_dir=None, max_s=30.0, tail_s=1.2, threshold=500.0, sd=None):
        self.data_dir = data_dir
        self.max_s, self.tail_s, self.threshold = max_s, tail_s, threshold
        self._sd = sd
        self._stream = None
        self._chunks = []
        self._lock = threading.Lock()
        self.started = 0.0
        self.auto_stop = False
        self._spoke = False
        self._quiet_since = None
        self.level = 0.0

    def _module(self):
        if self._sd is None:
            if self.data_dir:
                add_pylibs(self.data_dir)
            try:
                import sounddevice
            except Exception as exc:  # noqa: BLE001
                raise VoiceError("麦克风组件还没装好（%s）" % type(exc).__name__)
            self._sd = sounddevice
        return self._sd

    @property
    def active(self):
        return self._stream is not None

    def start(self, auto_stop=False):
        if self._stream is not None:
            return
        sd = self._module()
        self._chunks, self._spoke, self._quiet_since = [], False, None
        self.auto_stop = auto_stop
        self.started = time.monotonic()

        def cb(indata, frames, t, status):
            b = bytes(indata)
            with self._lock:
                self._chunks.append(b)
            lv = rms(b)
            self.level = lv
            now = time.monotonic()
            if lv >= self.threshold:
                self._spoke, self._quiet_since = True, None
            elif self._spoke and self._quiet_since is None:
                self._quiet_since = now
        try:
            self._stream = sd.RawInputStream(samplerate=self.RATE, channels=1, dtype="int16", blocksize=1600, callback=cb)
            self._stream.start()
        except Exception as exc:  # noqa: BLE001
            self._stream = None
            raise VoiceError("打不开麦克风：%s" % str(exc)[:120])

    def should_stop(self):
        if self._stream is None:
            return False
        now = time.monotonic()
        if now - self.started >= self.max_s:
            return True
        return bool(self.auto_stop and self._spoke and self._quiet_since and now - self._quiet_since >= self.tail_s)

    def stop(self):
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.stop()
                s.close()
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            pcm, self._chunks = b"".join(self._chunks), []
        return pcm

    def cancel(self):
        self.stop()
