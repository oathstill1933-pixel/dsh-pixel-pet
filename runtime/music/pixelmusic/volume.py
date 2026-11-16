"""云端客户端音量：Windows 音频会话（pycaw）按进程名调该客户端的会话音量，不动系统主音量。

进程映射（小写比较）：
  netease : cloudmusic.exe
  qqmusic : qqmusic.exe
  other   : AUMID 本身若是 xxx.exe 就用它，否则不支持（返回 None）
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

APP_PROCS = {"netease": ("cloudmusic.exe",), "qqmusic": ("qqmusic.exe",)}


def proc_names(app: str | None, aumid: str | None = None) -> tuple[str, ...]:
    if app in APP_PROCS:
        return APP_PROCS[app]
    a = (aumid or "").strip().lower()
    if a.endswith(".exe") and "\\" not in a and "/" not in a:
        return (a,)
    return ()


def _default_sessions() -> list[tuple[str, Any]]:
    """[(进程名小写, ISimpleAudioVolume)]"""
    try:
        import comtypes  # type: ignore

        comtypes.CoInitialize()
    except Exception:
        pass
    from pycaw.pycaw import AudioUtilities  # type: ignore

    out = []
    for s in AudioUtilities.GetAllSessions():
        try:
            if s.Process is not None:
                out.append((s.Process.name().lower(), s.SimpleAudioVolume))
        except Exception:
            continue
    return out


class AppVolume:
    def __init__(self, sessions: Callable[[], list[tuple[str, Any]]] | None = None, cache: float = 1.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.sessions = sessions or _default_sessions
        self.cache = cache
        self.clock = clock
        self._lock = threading.Lock()
        self._memo: dict[tuple, tuple[float, int | None]] = {}

    def _match(self, names: tuple[str, ...]) -> list[Any]:
        if not names:
            return []
        try:
            return [vol for n, vol in self.sessions() if n in names]
        except Exception:
            return []

    def get(self, app: str | None, aumid: str | None = None) -> int | None:
        names = proc_names(app, aumid)
        if not names:
            return None
        now = self.clock()
        with self._lock:
            hit = self._memo.get(names)
            if hit and now - hit[0] < self.cache:
                return hit[1]
            vols = self._match(names)
            val: int | None = None
            if vols:
                try:
                    val = int(round(float(vols[0].GetMasterVolume()) * 100))
                except Exception:
                    val = None
            self._memo[names] = (now, val)
            return val

    def set(self, app: str | None, aumid: str | None, value: float) -> int:
        names = proc_names(app, aumid)
        vols = self._match(names)
        if not vols:
            raise RuntimeError("找不到这个客户端的音频会话（客户端没在出声或不支持）")
        v = max(0.0, min(100.0, float(value))) / 100.0
        for vol in vols:
            vol.SetMasterVolume(v, None)
        with self._lock:
            self._memo[names] = (self.clock(), int(round(v * 100)))
        return int(round(v * 100))
