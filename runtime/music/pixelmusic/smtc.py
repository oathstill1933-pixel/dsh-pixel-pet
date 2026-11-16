"""云端：经 Windows SMTC（系统媒体传输控制）读/控网易云、QQ 音乐等客户端。

- 不登录、不调私有接口；只读 GlobalSystemMediaTransportControlsSessionManager。
- winrt 异步 API 跑在专属后台线程的事件循环里，stdio 主循环只读快照、投递控制。
- manager 工厂可注入（测试用假的）。

客户端识别（source_app_user_model_id，小写后子串匹配）：
  netease : 含 "cloudmusic"（网易云桌面版 cloudmusic.exe）或 "netease"
  qqmusic : 含 "qqmusic"（QQMusic.exe / 商店版 ...QQMusic...）
  other   : 其余一律归 other（浏览器、Spotify、系统播放器……）
有多个会话时：优先「正在播放」的网易云/QQ → 任一正在播放 → 系统当前会话 → 第一个。
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import hashlib
import threading
import time
from typing import Any, Callable

PLAYING = 4  # GlobalSystemMediaTransportControlsSessionPlaybackStatus.PLAYING
PAUSED = 5


def classify(aumid: str | None) -> str:
    a = (aumid or "").lower()
    if "cloudmusic" in a or "netease" in a:
        return "netease"
    if "qqmusic" in a:
        return "qqmusic"
    return "other"


def _seconds(v: Any) -> float:
    if v is None:
        return 0.0
    if isinstance(v, _dt.timedelta):
        return v.total_seconds()
    if hasattr(v, "duration"):  # winrt TimeSpan struct
        return float(v.duration) / 1e7
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _status(info: Any) -> int:
    try:
        return int(info.playback_status)
    except Exception:
        return 0


MODES = ("list", "one", "shuffle")
REPEAT_NONE, REPEAT_TRACK, REPEAT_LIST = 0, 1, 2


def _repeat_enum(v: int) -> Any:
    try:
        from winrt.windows.media import MediaPlaybackAutoRepeatMode  # type: ignore

        return MediaPlaybackAutoRepeatMode(v)
    except Exception:
        return v


def read_mode(info: Any) -> str | None:
    """SMTC 播放信息 -> list | one | shuffle；客户端没报就 None。"""
    shuffle = getattr(info, "is_shuffle_active", None)
    repeat = getattr(info, "auto_repeat_mode", None)
    try:
        if shuffle is not None and bool(shuffle):
            return "shuffle"
        if repeat is not None:
            return "one" if int(repeat) == REPEAT_TRACK else "list"
        if shuffle is not None:
            return "list"
    except Exception:
        return None
    return None


def _default_manager_factory():
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as M  # type: ignore

    return M.request_async()


async def _read_thumbnail(ref: Any) -> bytes | None:
    if ref is None:
        return None
    try:
        from winrt.windows.storage.streams import Buffer, InputStreamOptions  # type: ignore

        stream = await ref.open_read_async()
        size = int(stream.size)
        if size <= 0 or size > 4 * 1024 * 1024:
            return None
        buf = Buffer(size)
        out = await stream.read_async(buf, size, InputStreamOptions.READ_AHEAD)
        return bytes(memoryview(out))[: int(out.length)]
    except Exception:
        return None


class SmtcSource:
    def __init__(self, manager_factory: Callable[[], Any] | None = None, poll: float = 1.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.manager_factory = manager_factory or _default_manager_factory
        self.poll = poll
        self.clock = clock
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._snap: dict | None = None
        self._snap_at = 0.0
        self._cover: tuple[str, bytes, str] | None = None  # (version, bytes, mime)
        self._cover_track = ""
        self._session: Any = None
        self._mgr: Any = None
        self.error = ""
        self._stop = False
        # 自有时钟：网易云等客户端 SMTC 时间轴恒为 0 时兜底
        self._est_key = ""
        self._est_pos = 0.0
        self._est_at = 0.0
        self._est_playing = False
        self._raw_last: float | None = None
        self._raw_stuck = 0
        # 网易云 SMTC 不报曲长，卡片上的时长来自歌词库。自有时钟回绕必须也能用它，
        # 否则「播完回绕」永远不触发（实测 position 1235 s / 曲长 186 s）。由服务层注入：(title, artist) -> 秒 | None
        self.duration_hint: Callable[[str, str], float | None] | None = None
        self._wrap_dur = 0.0

    def _hint(self, title: str, artist: str) -> float:
        fn = self.duration_hint
        if fn is None:
            return 0.0
        try:
            v = float(fn(title, artist) or 0.0)
        except Exception:
            return 0.0
        return v if v > 0 else 0.0

    # ---------- 线程 ----------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop = False
        ready = threading.Event()

        def run() -> None:
            loop = asyncio.new_event_loop()
            self._loop = loop
            asyncio.set_event_loop(loop)
            ready.set()
            try:
                loop.run_until_complete(self._poll_forever())
            finally:
                loop.close()

        self._thread = threading.Thread(target=run, name="pixelmusic-smtc", daemon=True)
        self._thread.start()
        ready.wait(2)

    def stop(self) -> None:
        self._stop = True

    # 一次 refresh 最多等这么久。Windows 的媒体会话调用偶尔永远不回来（网易云刚启动 / 切歌 /
    # 被 orpheus:// 拉起的那一刻），以前这里没有超时，轮询线程就卡死在那一个 await 上——线程活着、不报错，
    # 但再也不更新，表现就是「刚起来能识别，过一会就识别不了」。超时后丢掉旧的会话管理器，下一轮重建。
    REFRESH_TIMEOUT_S = 6.0

    async def _poll_forever(self) -> None:
        while not self._stop:
            try:
                await asyncio.wait_for(self.refresh(), timeout=self.REFRESH_TIMEOUT_S)
            except asyncio.TimeoutError:
                self.error = "Timeout"
                self._mgr = None
                self._session = None
            except Exception as exc:
                self.error = type(exc).__name__
            await asyncio.sleep(self.poll)

    # ---------- 读 ----------
    async def _manager(self) -> Any:
        if self._mgr is None:
            m = self.manager_factory()
            self._mgr = await m if asyncio.iscoroutine(m) or hasattr(m, "__await__") else m
            self._mgr_at = self.clock()
        return self._mgr

    # A manager created on this pump-less worker thread can keep the session list it saw at creation
    # (e.g. NetEase turned SMTC on after we started). With nothing to show, re-create it now and then.
    REFRESH_MGR_S = 5.0

    def _pick(self, mgr: Any) -> Any:
        try:
            sessions = list(mgr.get_sessions())
        except Exception:
            sessions = []
        try:
            cur = mgr.get_current_session()
        except Exception:
            cur = None
        if not sessions:
            return cur
        known = [s for s in sessions if classify(s.source_app_user_model_id) != "other"]
        for pool in (known, sessions):
            for s in pool:
                try:
                    if _status(s.get_playback_info()) == PLAYING:
                        return s
                except Exception:
                    continue
        if known:
            return known[0]
        return cur or sessions[0]

    async def refresh(self) -> dict | None:
        mgr = await self._manager()
        s = self._pick(mgr)
        self._session = s
        if s is None:
            with self._lock:
                self._snap = None
            if self.clock() - getattr(self, "_mgr_at", 0.0) >= self.REFRESH_MGR_S:
                self._mgr = None
            return None
        aumid = str(s.source_app_user_model_id or "")
        props = await s.try_get_media_properties_async()
        tl = s.get_timeline_properties()
        info = s.get_playback_info()
        status = _status(info)
        ctrl = getattr(info, "controls", None)
        position = _seconds(getattr(tl, "position", 0))
        last = getattr(tl, "last_updated_time", None)
        if status == PLAYING and isinstance(last, _dt.datetime):
            try:
                lag = (_dt.datetime.now(_dt.timezone.utc) - last.astimezone(_dt.timezone.utc)).total_seconds()
                if 0 < lag < 3600:
                    position += lag
            except Exception:
                pass
        duration = _seconds(getattr(tl, "end_time", 0)) - _seconds(getattr(tl, "start_time", 0))
        title = str(getattr(props, "title", "") or "")
        artist = str(getattr(props, "artist", "") or "") or str(getattr(props, "album_artist", "") or "")
        album = str(getattr(props, "album_title", "") or "")
        tkey = f"{aumid}|{title}|{artist}|{album}"
        if tkey != self._cover_track:
            self._cover_track = tkey
            data = await _read_thumbnail(getattr(props, "thumbnail", None))
            with self._lock:
                if data:
                    ver = hashlib.sha1(data).hexdigest()[:12]
                    mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
                    self._cover = (ver, data, mime)
                else:
                    self._cover = None
        now = self.clock()
        playing = status == PLAYING
        raw = round(max(0.0, _seconds(getattr(tl, "position", 0))), 3)
        wrap = duration if duration > 0 else self._hint(title, artist)
        if tkey != self._est_key:
            self._est_key, self._est_pos, self._est_at = tkey, 0.0, now
            self._raw_last, self._raw_stuck = None, 0
        else:
            if self._est_playing:
                self._est_pos += max(0.0, now - self._est_at)
                # 2026-11-15：单曲循环时同一首歌会一直播下去，估算值必须按曲长回绕，
                # 否则会一路加上去（表现是「刻度到头不重置、歌词也不跟着回」）。
                # 曲长取 SMTC 的；没有就用歌词库的（wrap，见 duration_hint）
                if wrap > 0 and self._est_pos >= wrap:
                    self._est_pos = self._est_pos % wrap
            self._est_at = now
            if playing and self._raw_last is not None and abs(raw - self._raw_last) < 1e-3:
                self._raw_stuck += 1
            elif playing:
                self._raw_stuck = 0
        self._est_playing = playing
        self._raw_last = raw
        estimated = self._raw_stuck >= 2 or (duration <= 0 and raw <= 0 and playing and self._raw_stuck >= 1)
        snap = {
            "app": classify(aumid),
            "aumid": aumid,
            "playing": status == PLAYING,
            "playback": "playing" if status == PLAYING else "paused" if status == PAUSED else "off",
            "status": status,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": round(duration, 2) if duration > 0 else None,
            "position": round(self._est_pos if estimated else max(0.0, position), 2),
            "position_source": "estimated" if estimated else "smtc",
            "seek": False if estimated else bool(getattr(ctrl, "is_playback_position_enabled", False)),
            "mode": read_mode(info),
            "mode_ok": bool(getattr(ctrl, "is_repeat_enabled", False) or getattr(ctrl, "is_shuffle_enabled", False)),
            "repeat_ok": bool(getattr(ctrl, "is_repeat_enabled", False)),
            "shuffle_ok": bool(getattr(ctrl, "is_shuffle_enabled", False)),
        }
        with self._lock:
            self._snap = snap
            self._snap_at = self.clock()
            self._wrap_dur = wrap if estimated else 0.0
        return snap

    def snapshot(self) -> dict | None:
        with self._lock:
            if self._snap is None:
                return None
            snap = dict(self._snap)
            if snap["playing"]:
                pos = snap["position"] + max(0.0, self.clock() - self._snap_at)
                d = snap.get("duration") or self._wrap_dur
                # 2026-11-15：超过曲长就按曲长回绕（单曲循环），不再只是 min 截断卡在结尾
                if d and d > 0:
                    pos = pos % d if pos >= d else pos
                snap["position"] = round(max(0.0, pos), 2)
            snap["cover"] = self._cover[0] if self._cover else None
            return snap

    def cover(self) -> tuple[bytes, str] | None:
        with self._lock:
            return (self._cover[1], self._cover[2]) if self._cover else None

    # ---------- 控制 ----------
    async def _control(self, action: str, value: Any) -> bool:
        s = self._session
        if s is None:
            await self.refresh()
            s = self._session
        if s is None:
            raise RuntimeError("没有正在运行的音乐客户端")
        if action == "toggle":
            ok = await s.try_toggle_play_pause_async()
        elif action == "play":
            ok = await s.try_play_async()
        elif action == "pause":
            ok = await s.try_pause_async()
        elif action == "next":
            ok = await s.try_skip_next_async()
        elif action == "prev":
            ok = await s.try_skip_previous_async()
        elif action == "seek":
            snap = self.snapshot() or {}
            if not snap.get("seek"):
                raise RuntimeError("这个客户端不支持拖动进度")
            ok = await s.try_change_playback_position_async(int(float(value) * 1e7))
        elif action == "mode":
            if value not in MODES:
                raise ValueError("模式只能是 list/one/shuffle")
            snap = self.snapshot() or {}
            if value == "shuffle":
                if not snap.get("shuffle_ok"):
                    raise RuntimeError("这个客户端不支持通过系统切换随机播放")
                ok = await s.try_change_shuffle_active_async(True)
            else:
                if not snap.get("repeat_ok"):
                    raise RuntimeError("这个客户端不支持通过系统切换循环模式")
                if snap.get("shuffle_ok"):
                    await s.try_change_shuffle_active_async(False)
                ok = await s.try_change_auto_repeat_mode_async(_repeat_enum(REPEAT_TRACK if value == "one" else REPEAT_LIST))
        else:
            raise RuntimeError("云端不支持这个操作")
        try:
            await self.refresh()
        except Exception:
            pass
        return bool(ok)

    def control(self, action: str, value: Any = None, timeout: float = 5.0) -> bool:
        if self._loop is None:
            self.start()
        fut = asyncio.run_coroutine_threadsafe(self._control(action, value), self._loop)  # type: ignore[arg-type]
        return fut.result(timeout)
