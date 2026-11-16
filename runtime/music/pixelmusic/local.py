"""本地播放：只放用户显式添加的文件（宿主弹系统选择框后登记路径），只读源文件、不扫盘。

解码：soundfile（libsndfile 1.2）——wav / flac / ogg / mp3；m4a(AAC) 当前环境解不了，登记时直接拒绝。
输出：sounddevice OutputStream 回调里按块读文件；输出块同时喂给 Meter（频谱/特征），不用回环。
队列登记存 <dataDir>/music/local.json（只存路径列表，给宿主之外的任何地方都不暴露路径）。
"""
from __future__ import annotations

import json
import os
import random
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np

SUPPORTED = {".wav", ".flac", ".ogg", ".mp3"}
KNOWN = SUPPORTED | {".m4a"}
MAX_QUEUE = 500


def guess_tags(path: Path) -> tuple[str, str]:
    """「歌手 - 歌名」文件名约定；否则歌手空。"""
    stem = path.stem.strip()
    m = re.match(r"^\s*(.+?)\s+-\s+(.+?)\s*$", stem)
    if m:
        return m.group(2), m.group(1)
    return stem, ""


def _default_open(path: str):
    import soundfile as sf  # type: ignore

    return sf.SoundFile(path)


def _default_stream(rate: int, channels: int, callback: Callable, finished: Callable):
    import sounddevice as sd  # type: ignore

    return sd.OutputStream(samplerate=rate, channels=channels, dtype="float32", callback=callback, finished_callback=finished, blocksize=1024)


class LocalPlayer:
    def __init__(self, store: Path | None, meter: Any = None, open_file: Callable = _default_open, make_stream: Callable = _default_stream) -> None:
        self.store = Path(store) if store else None
        self.meter = meter
        self.open_file = open_file
        self.make_stream = make_stream
        self.queue: list[str] = []
        self.index = -1
        self.volume = 0.8
        self.mode = "list"  # list | one | shuffle
        self._file: Any = None
        self._stream: Any = None
        self._rate = 0
        self._frames = 0
        self._pos = 0
        self._playing = False
        self._lock = threading.RLock()
        self._advance = False
        self._load()

    # ---------- 登记 ----------
    def _load(self) -> None:
        if not self.store or not self.store.is_file():
            return
        try:
            data = json.loads(self.store.read_text(encoding="utf-8"))
            self.queue = [p for p in data.get("queue", []) if isinstance(p, str)][:MAX_QUEUE]
        except (OSError, ValueError):
            self.queue = []

    def _save(self) -> None:
        if not self.store:
            return
        try:
            self.store.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix="lq.", suffix=".tmp", dir=str(self.store.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as h:
                json.dump({"queue": self.queue}, h, ensure_ascii=False)
            os.replace(tmp, self.store)
        except OSError:
            pass

    def add(self, paths: list[str]) -> dict:
        added, rejected = 0, 0
        unsupported = 0
        with self._lock:
            for raw in paths or []:
                p = Path(str(raw))
                ext = p.suffix.lower()
                if ext not in KNOWN or not p.is_file():
                    rejected += 1
                    continue
                if ext not in SUPPORTED:
                    unsupported += 1
                    continue
                s = str(p.resolve())
                if s in self.queue or len(self.queue) >= MAX_QUEUE:
                    continue
                self.queue.append(s)
                added += 1
            self._save()
        return {"added": added, "rejected": rejected, "unsupported": unsupported, "total": len(self.queue)}

    def items(self) -> list[dict]:
        out = []
        for i, s in enumerate(self.queue):
            t, a = guess_tags(Path(s))
            out.append({"index": i, "title": t, "artist": a})
        return out

    # ---------- 播放 ----------
    def _callback(self, outdata, frames, _time, _status) -> None:
        with self._lock:
            f = self._file
            if f is None or not self._playing:
                outdata.fill(0)
                return
            data = f.read(frames, dtype="float32", always_2d=True)
            n = len(data)
            ch = outdata.shape[1]
            if data.shape[1] != ch:
                data = np.repeat(data.mean(axis=1, keepdims=True), ch, axis=1)
            outdata[:n] = data * self.volume
            if n < frames:
                outdata[n:] = 0
            self._pos += n
            if n and self.meter is not None:
                try:
                    self.meter.feed(data, self._rate)
                except Exception:
                    pass
            if n < frames:
                self._playing = False
                self._advance = True

    def _finished(self) -> None:
        pass

    def _close(self) -> None:
        s, f = self._stream, self._file
        self._stream, self._file = None, None
        for obj in (s, f):
            if obj is None:
                continue
            try:
                if obj is s:
                    obj.stop()
                obj.close()
            except Exception:
                pass

    def play(self, index: int | None = None) -> None:
        with self._lock:
            if not self.queue:
                raise RuntimeError("还没有添加本地歌曲")
            if index is None:
                if self._file is not None:
                    self._playing = True
                    self._ensure_stream()
                    return
                index = max(0, self.index)
            if not 0 <= index < len(self.queue):
                raise RuntimeError("没有这一首")
            self._close()
            f = self.open_file(self.queue[index])
            self._file = f
            self._rate = int(f.samplerate)
            self._frames = int(f.frames) if int(getattr(f, "frames", 0) or 0) > 0 else 0
            self._pos = 0
            self.index = index
            self._playing = True
            self._advance = False
            self._ensure_stream()

    def _ensure_stream(self) -> None:
        if self._stream is None and self._file is not None:
            ch = min(2, int(getattr(self._file, "channels", 2) or 2))
            self._stream = self.make_stream(self._rate, ch, self._callback, self._finished)
            self._stream.start()

    def pause(self) -> None:
        with self._lock:
            self._playing = False

    def toggle(self) -> None:
        with self._lock:
            if self._playing:
                self._playing = False
            else:
                self.play(None if self._file is not None else max(0, self.index))

    def step(self, delta: int) -> None:
        with self._lock:
            if not self.queue:
                raise RuntimeError("还没有添加本地歌曲")
            self.play((max(0, self.index) + delta) % len(self.queue))

    def seek(self, seconds: float) -> None:
        with self._lock:
            if self._file is None:
                raise RuntimeError("没有在放本地歌曲")
            target = int(max(0.0, float(seconds)) * self._rate)
            if self._frames:
                target = min(target, self._frames - 1)
            self._file.seek(target)
            self._pos = target

    def set_mode(self, mode: str) -> None:
        if mode not in ("list", "one", "shuffle"):
            raise ValueError("模式只能是 list/one/shuffle")
        self.mode = mode

    def set_volume(self, v: float) -> None:
        self.volume = max(0.0, min(1.0, float(v)))

    def poll(self) -> None:
        """服务循环里调用：放完自动下一首。"""
        if self._advance:
            self._advance = False
            try:
                if not self.queue:
                    return
                if self.mode == "one":
                    self.play(max(0, self.index))
                elif self.mode == "shuffle" and len(self.queue) > 1:
                    self.play(random.choice([i for i in range(len(self.queue)) if i != self.index]))
                elif len(self.queue) > 1:
                    self.step(1)
            except Exception:
                pass

    def current_path(self) -> Path | None:
        if 0 <= self.index < len(self.queue):
            return Path(self.queue[self.index])
        return None

    def snapshot(self) -> dict | None:
        with self._lock:
            p = self.current_path()
            if p is None or self._file is None:
                return None
            title, artist = guess_tags(p)
            return {
                "playing": self._playing,
                "title": title,
                "artist": artist,
                "album": "",
                "duration": round(self._frames / self._rate, 2) if self._frames and self._rate else None,
                "position": round(self._pos / self._rate, 2) if self._rate else 0.0,
                "index": self.index,
                "volume": int(round(self.volume * 100)),
                "mode": self.mode,
            }

    def close(self) -> None:
        with self._lock:
            self._playing = False
            self._close()
