"""Continuous listening (the hub's mic switch / the hotkey): an energy VAD with an adaptive noise floor,
and a mic stream that feeds it.

Vad.feed(chunk) -> None | ("start",) | ("end", pcm) | ("drop",)
  start  level rose above the threshold (noise floor x ratio, at least min_level)
  end    speech went quiet for tail_s, or hit max_s; pcm includes pre_roll_s of audio before the start
  drop   it went quiet again before min_speech_s of voiced audio (a cough, a click)

Listener keeps one 16 kHz input stream open and calls on_segment(pcm) off the audio thread. While
paused (the pet is thinking / speaking, the menu's one-shot mic is on, a capture is running) input is
ignored and the detector is reset, so the pet never hears itself.
"""
import collections
import queue
import threading
import time

from . import VoiceError
from .mic import add_pylibs, rms


class Vad:
    def __init__(self, rate=16000, ratio=3.0, min_level=420.0, floor=200.0, min_speech_s=0.3, tail_s=0.8,
                 max_s=30.0, pre_roll_s=0.3):
        self.rate = rate
        self.ratio, self.min_level = ratio, min_level
        self.floor = floor
        self.min_speech_s, self.tail_s, self.max_s, self.pre_roll_s = min_speech_s, tail_s, max_s, pre_roll_s
        self.reset()

    def reset(self):
        self.active = False
        self.level = 0.0
        self._pre = collections.deque()
        self._pre_s = 0.0
        self._buf = []
        self._voiced = self._quiet = self._total = 0.0

    @property
    def threshold(self):
        return max(self.min_level, self.floor * self.ratio)

    def feed(self, chunk):
        n = len(chunk) // 2
        if not n:
            return None
        dur = n / float(self.rate)
        lv = rms(chunk)
        self.level = lv
        loud = lv >= self.threshold
        if not self.active:
            if not loud:
                self.floor = self.floor * 0.95 + lv * 0.05
                self._pre.append((chunk, dur))
                self._pre_s += dur
                while self._pre and self._pre_s - self._pre[0][1] >= self.pre_roll_s:
                    self._pre_s -= self._pre.popleft()[1]
                return None
            self.active = True
            self._buf = [c for c, _ in self._pre] + [chunk]
            self._pre.clear()
            self._pre_s = 0.0
            self._voiced, self._quiet, self._total = dur, 0.0, dur
            return ("start",)
        self._buf.append(chunk)
        self._total += dur
        if loud:
            self._voiced += dur
            self._quiet = 0.0
        else:
            self._quiet += dur
        if self._quiet >= self.tail_s or self._total >= self.max_s:
            voiced, pcm = self._voiced, b"".join(self._buf)
            self.reset()
            return ("end", pcm) if voiced >= self.min_speech_s else ("drop",)
        return None


class Listener:
    RATE = 16000

    def __init__(self, on_segment, on_event=None, data_dir=None, vad=None, sd=None, on_barge=None):
        self.on_segment, self.on_event = on_segment, on_event
        self.data_dir = data_dir
        self.vad = vad or Vad(self.RATE)
        self._sd = sd
        self._stream = None
        self._paused = False
        self._q = queue.SimpleQueue()
        self._worker = None
        self.on_barge=on_barge
        self._playback=False
        self._processor=None
        self._epoch=0
        self._barge_vad=Vad(self.RATE,min_level=500,min_speech_s=.6,tail_s=.3,pre_roll_s=.1)
        self._barge_sent=False
        self._barge_gen=0

    @property
    def active(self):
        return self._stream is not None

    @property
    def level(self):
        return self.vad.level if self.vad.active else 0.0

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

    def pause(self, on=True):
        if bool(on)!=self._paused:
            self._paused=bool(on);self._epoch+=1

    def set_playback_mode(self,on,processor=None):
        if bool(on)!=self._playback:
            self._playback=bool(on);self._epoch+=1
        self._processor=processor

    def rearm_barge(self):
        """Forget buffered barge audio and allow a new probe (new sentence, or last probe was echo).
        Safe from any thread: the worker applies it before its next packet."""
        self._barge_gen+=1

    def _cb(self, indata, frames, t, status):
        if self._paused:
            return
        # Never run FFT, VAD, STT or UI work on PortAudio's real-time callback.
        self._q.put((self._epoch,time.monotonic(),bytes(indata)))

    def _run(self):
        epoch=-1
        barge_gen=self._barge_gen
        while True:
            packet = self._q.get()
            if packet is None:
                return
            try:
                version,at,pcm=packet
                if version!=self._epoch or self._paused or time.monotonic()-at>.35:continue
                if epoch!=version:
                    self.vad.reset();self._barge_vad.reset();self._barge_sent=False;epoch=version
                if barge_gen!=self._barge_gen:
                    barge_gen=self._barge_gen;self._barge_vad.reset();self._barge_sent=False
                if self._playback:
                    if self._barge_sent or not self._processor:continue
                    pcm=self._processor(pcm)
                    self._barge_vad.feed(pcm)
                    v=self._barge_vad
                    if v.active and v._voiced>=.6:
                        self._barge_sent=True
                        if self.on_barge:self.on_barge(b''.join(v._buf))
                    continue
                ev=self.vad.feed(pcm)
                if not ev:continue
                if ev[0] == "end":
                    self.on_segment(ev[1])
                elif self.on_event:
                    self.on_event(ev[0])
            except Exception:  # noqa: BLE001
                pass

    def start(self):
        if self._stream is not None:
            return
        sd = self._module()
        self.vad.reset()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        try:
            self._stream = sd.RawInputStream(samplerate=self.RATE, channels=1, dtype="int16", blocksize=1600,
                                             callback=self._cb)
            self._stream.start()
        except Exception as exc:  # noqa: BLE001
            self._stream = None
            self._q.put(None)
            raise VoiceError("打不开麦克风：%s" % str(exc)[:120])

    def stop(self):
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.stop()
                s.close()
            except Exception:  # noqa: BLE001
                pass
            self._q.put(None)
        self.vad.reset()
