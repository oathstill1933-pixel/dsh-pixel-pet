"""pixelmusic：一起听歌 v2 音乐服务。

    python -X utf8 -m pixelmusic --data-dir <dir>

stdio JSON 行协议：
  入 {"id": 1, "command": "now", "args": {...}}
  出 {"id": 1, "ok": true, "data": {...}}  /  {"id": 1, "ok": false, "error": {"code", "message"}}
stdin 关闭即退出（释放录音/播放设备）。stdout 只写协议行；日志不记歌词全文、音频、本地路径。

命令：ping | now | live | control | cover | local_list | shutdown
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import clap
from . import lyrics as lyr
from . import songmap
from .local import LocalPlayer
from .loopback import LoopbackCapture, Meter
from .audio_listen import FileAnalyzer
from .smtc import SmtcSource
from .volume import AppVolume

CLOUD_ACTIONS = {"toggle", "play", "pause", "next", "prev", "seek", "mode"}


def energy_envelope(path: Path | None, points: int = 96) -> list[float]:
    """整曲响度包络（来自 songmap 缓存）→ 0-1，约 96 点；没分析完返回 []。"""
    if path is None:
        return []
    res = songmap.lookup(path)
    curve = ((res or {}).get("curves") or {}).get("loudness_db") or []
    if len(curve) < 2:
        return []
    import numpy as np

    c = np.asarray(curve, dtype=float)
    c = np.interp(np.linspace(0, c.size - 1, points), np.arange(c.size), c)
    top = float(c.max())
    return [round(float(v), 3) for v in np.clip((c - (top - 40.0)) / 40.0, 0.0, 1.0)]


def _lower_priority() -> None:
    try:
        if os.name == "nt":
            import ctypes

            k = ctypes.windll.kernel32
            k.SetThreadPriority(k.GetCurrentThread(), -2)  # THREAD_PRIORITY_LOWEST
        else:
            os.nice(5)
    except Exception:
        pass


class Service:
    def __init__(self, data_dir: Path | None, *, smtc: Any = None, local: Any = None, lyrics_store: Any = None,
                 loopback: Any = None, meter: Any = None, cloud_meter: Any = None, worker: Any = None, app_volume: Any = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        root = Path(data_dir) / "music" if data_dir else None
        self._music_root = root
        if root is not None:
            songmap.set_cache_dir(root / "analysis")
        self.clock = clock
        self.meter = meter or Meter()            # 本地播放输出
        self.cloud_meter = cloud_meter or Meter()  # 回环
        self.smtc = smtc if smtc is not None else SmtcSource()
        self.local = local if local is not None else LocalPlayer(root / "local.json" if root else None, meter=self.meter)
        self.lyrics = lyrics_store if lyrics_store is not None else lyr.LyricsStore(root / "lyrics-cache" if root else None)
        # 网易云不报曲长：自有时钟按歌词库时长回绕（只读缓存，不发请求；smtc.duration_hint）
        if hasattr(self.smtc, "duration_hint"):
            self.smtc.duration_hint = lambda title, artist: self.lyrics.duration(title, artist, None)
        self.loopback = loopback if loopback is not None else LoopbackCapture(self.cloud_meter)
        self.worker = worker if worker is not None else songmap.WORKER
        self.app_volume = app_volume if app_volume is not None else AppVolume()
        self.prefer = "auto"
        self._cloud_key = ""
        self._clap_obj: clap.Tagger | None = None      # 「听得更细」；clap.json 开着才懒加载（别叫 _clap_tagger：会盖住同名方法）
        self.file_analyzer = FileAnalyzer(root / "audio-listen" if root else None, self._clap_enabled, self._clap_tagger)
        self._clap_acc: dict = {}                       # 按歌累计（指数平均），切歌清空
        self._clap_last_at = 0.0                        # 每 10 秒喂一次音频端
        self._clap_bg: threading.Thread | None = None   # 本地文件整曲标签（低优先级）
        self._clap_error = ""                            # Tagger 加载失败原因（GET /api/music/clap 透出）
        self._clap_epoch = -1                            # meter.epoch 变了（切歌/循环/拖动）→ 清累计
        self._tick_stop: threading.Event | None = None   # 后台每秒采样线程的退出信号
        self._tick_thread: threading.Thread | None = None
        self._local_lrc: tuple[str, Any] = ("", None)
        self._started = False
        self._lock = threading.RLock()

    def start(self) -> None:
        if not self._started:
            self._started = True
            try:
                self.smtc.start()
            except Exception:
                pass
            self._ensure_tick_thread()

    def close(self) -> None:
        # 后台采样线程随服务一起退出（review 修复 1：采样不再依赖有人请求）
        stop = self._tick_stop
        if stop is not None:
            stop.set()
        th = self._tick_thread
        if th is not None and th.is_alive() and th is not threading.current_thread():
            th.join(2.0)
        self._tick_stop = None
        self._tick_thread = None
        for fn in (self.loopback.stop, self.smtc.stop, self.local.close):
            try:
                fn()
            except Exception:
                pass

    # ---------- 后台采样（每秒一次，不靠请求驱动） ----------
    def _ensure_tick_thread(self) -> None:
        if self._tick_thread is not None and self._tick_thread.is_alive():
            return
        self._tick_stop = threading.Event()
        self._tick_thread = threading.Thread(target=self._tick_loop, name="pixelmusic-tick", daemon=True)
        self._tick_thread.start()

    def _tick_loop(self) -> None:
        _lower_priority()
        stop = self._tick_stop
        while stop is not None and not stop.wait(1.0):
            try:
                self._tick_once()
            except Exception:
                pass

    def _tick_once(self) -> None:
        """一秒一拍：选源 → 开关回环 → 对当前 meter 记一条特征 → CLAP 满 10 秒跑一次。

        review 修复 1：以前只在 now()/_heard() 里做，卡片关着就基本不采样，AI 问「现在听什么」
        经常凑不够 10 行。现在由后台线程驱动，now() 只读结果。
        review 修复 4：CLAP 推理（首次加载模型可能要好几秒）也在这里，绝不卡请求。"""
        self.local.poll()
        source, snap = self._pick()
        self._sync_capture(source, snap)
        if source == "none" or not snap or not snap.get("playing"):
            return
        meter = self._meter_for(source)
        if meter is None:
            return
        if meter.epoch != self._clap_epoch:
            self._clap_epoch = meter.epoch
            self._clap_acc = {}                       # 切歌 / 循环 / 拖动：标签累计重来
        meter.tick_features(float(snap.get("position") or 0.0),
                            snap.get("position_source") or ("player" if source == "local" else "smtc"))
        if self._clap_enabled():
            self._clap_step(meter)

    # ---------- 状态 ----------
    def _pick(self) -> tuple[str, dict | None]:
        cloud = self.smtc.snapshot()
        local = self.local.snapshot()
        if self.prefer == "local":
            return ("local", local) if local else ("none", None)
        if self.prefer == "cloud":
            return ("cloud", cloud) if cloud else ("none", None)
        if local and local["playing"]:
            return "local", local
        if cloud and (cloud["playing"] or not local):
            return "cloud", cloud
        if local:
            return "local", local
        return "none", None

    def _sync_capture(self, source: str, snap: dict | None) -> None:
        want = source == "cloud" and bool(snap and snap.get("playing"))
        self.loopback.set_active(want)
        if source == "cloud" and snap:
            key = f"{snap.get('title')}|{snap.get('artist')}"
            if key != self._cloud_key:
                self._cloud_key = key
                self.cloud_meter.history = []
                self._clap_acc = {}

    def _lyric(self, source: str, snap: dict) -> dict:
        pos = float(snap.get("position") or 0.0)
        if source == "local":
            p = self.local.current_path()
            key = str(p) if p else ""
            if self._local_lrc[0] != key:
                self._local_lrc = (key, lyr.local_lrc(p) if p else None)
            lines = self._local_lrc[1]
            if lines:
                return {**lyr.view(lines, pos), "origin": "lrc"}
        state, lines = self.lyrics.lookup(snap.get("title") or "", snap.get("artist") or "", snap.get("duration"))
        if lines:
            return {**lyr.view(lines, pos), "origin": "lrclib"}
        return {**lyr.view(None, pos), "state": state}

    # ---------- 「听得更细」（可选组件，clap.json 开着才生效） ----------
    def _clap_enabled(self) -> bool:
        root = self._music_root
        if not root:
            return False
        try:
            j = json.loads((root / "clap.json").read_text(encoding="utf-8"))
            return j.get("enabled") is True
        except Exception:
            return False

    def _clap_tagger(self) -> Any:
        if self._clap_obj is None:
            self._clap_obj = clap.Tagger()
        return self._clap_obj

    def _scope_note(self) -> str:
        # CLAP 开着时不再写「不识别情绪曲风」——标签句自己声明是模型猜的
        return "系统回环实时测得，只到已播放的部分" if self._clap_enabled() else \
            "系统回环实时测得，只到已播放的部分；不识别乐器、情绪、副歌或曲风"

    def _clap_step(self, meter: Any) -> None:
        """每 10 秒取最近 10 秒音频喂音频端（在后台线程里跑，不卡请求）；duck / 静音不送。

        review 修复 3：meter 可能是 44.1k，先重采样到 48k；review 修复 4：失败原因记下来给设置页。"""
        t = self.clock()
        if t - self._clap_last_at < 10.0:
            return
        self._clap_last_at = t
        if t < meter.duck_until or meter.last_rms < 1e-4 or self.clock() - meter.last_feed > 1.0:
            return
        try:
            tagger = self._clap_tagger()
            if not tagger.ready:
                self._clap_error = tagger.error() or "模型没准备好"
                return
            y = clap.resample_for_clap(meter.window(10.0), meter.rate)
            if y is not None:
                clap.accumulate(self._clap_acc, tagger.tag(y))
                self._clap_error = ""
        except Exception as exc:  # noqa: BLE001
            self._clap_error = type(exc).__name__ + ": " + str(exc)[:120]

    def _clap_tags(self, meter: Any) -> dict | None:
        """只读累计好的结果（不触发推理——review 修复 4：请求链里不做模型计算）。"""
        if not self._clap_enabled():
            return None
        return clap.summarize(self._clap_acc)

    def clap_status(self, args: dict | None = None) -> dict:
        """设置页用：模型是否就绪 / 后端 / 失败原因 / 当前累计标签。"""
        tagger = self._clap_obj
        return {
            "enabled": self._clap_enabled(),
            "ready": bool(tagger is not None and tagger.ready),
            "backend": tagger.backend() if tagger is not None else "",
            "error": self._clap_error or (tagger.error() if tagger is not None else ""),
            "tags": clap.summarize(self._clap_acc),
        }

    def _clap_schedule_local_tags(self, path, res: dict | None = None) -> None:
        """本地文件整曲解析**已完成**、缓存里还没有 clap_tags 时，低优先级补一遍全曲标签。

        review 修复 6：原先只在「解析还没完成」的分支里排队，真轮到又因为 lookup() 是空的把结果丢掉；
        解析完成的分支根本没排队 → 本地整曲标签永远算不出。现在由完成分支调用。"""
        if not path or not self._clap_enabled():
            return
        try:
            if not songmap.lookup(path):
                return  # 解析还没进缓存：下一轮再来
        except Exception:
            return
        if self._clap_bg is not None and self._clap_bg.is_alive():
            return

        def work():
            try:
                _lower_priority()
                tagger = self._clap_tagger()
                if not tagger.ready:
                    return
                tags = clap.tag_file(path, tagger)
                if not tags:
                    return
                data = songmap.lookup(path)
                if data:
                    data["clap_tags"] = {"tags": tags, "model": clap.MODEL_ID}
                    songmap._write_cache(path, data)
            except Exception:
                pass

        self._clap_bg = threading.Thread(target=work, name="pixelmusic-clap-local", daemon=True)
        self._clap_bg.start()

    def notify(self, args: dict) -> dict:
        """宿主通知：桌宠自己出声了（say speak=true），回环这段时间别把自己的声音当成歌。"""
        seconds = float(args.get("speaking_seconds") or 0.0)
        if seconds > 0:
            self.cloud_meter.duck(seconds)
        return {"ducked": max(0.0, seconds)}

    def _heard(self, source: str, snap: dict) -> dict:
        engine = "librosa" if songmap.available() else "numpy"
        if source == "local":
            p = self.local.current_path()
            res = songmap.lookup(p) if p else None
            if res is not None:
                d = songmap.describe(res, float(snap.get("position") or 0.0))
                out = {"available": True, "sentence": d["sentence"], "engine": engine, "kind": "songmap"}
                tags = (res.get("clap_tags") or {}).get("tags")
                if tags:
                    out["tags"] = tags
                    out["sentence"] = clap.with_tags(out["sentence"], tags)
                elif p:
                    self._clap_schedule_local_tags(p, res)   # 解析完成但还没标签：排一次（review 修复 6）
                return out
            state = self.worker.schedule(p) if p and songmap.available() else "unavailable"
            d = songmap.describe_rolling(self.meter.history, float(snap.get("position") or 0.0), scope_note=self._scope_note())
            if d:
                out = {"available": True, "sentence": d["sentence"], "engine": self.meter.analyzer.engine, "kind": "live", "songmap": state}
                tags = self._clap_tags(self.meter)
                if tags:
                    out["tags"] = tags
                    out["sentence"] = clap.with_tags(out["sentence"], tags)
                return out
            return {"available": False, "sentence": "", "engine": engine, "songmap": state}
        if source == "cloud":
            d = songmap.describe_rolling(self.cloud_meter.history, float(snap.get("position") or 0.0), scope_note=self._scope_note())
            if d:
                out = {"available": True, "sentence": d["sentence"], "engine": self.cloud_meter.analyzer.engine, "kind": "live", "rolling": d["rolling"]}
                tags = self._clap_tags(self.cloud_meter)
                if tags:
                    out["tags"] = tags
                    out["sentence"] = clap.with_tags(out["sentence"], tags)
                return out
        return {"available": False, "sentence": "", "engine": engine}

    def _meter_for(self, source: str) -> Meter | None:
        return self.meter if source == "local" else self.cloud_meter if source == "cloud" else None

    def now(self, args: dict | None = None) -> dict:
        self.start()
        self.local.poll()
        source, snap = self._pick()
        self._sync_capture(source, snap)  # 立刻反映播放状态；采样由后台线程做（review 修复 1）
        out: dict[str, Any] = {"source": source, "prefer": self.prefer, "app": None, "playing": False, "track": None,
                               "position": 0.0, "lyric": lyr.view(None, 0), "heard": {"available": False, "sentence": ""},
                               "volume": None, "mode": None,
                               "capabilities": {"seek": False, "playSpecific": False, "loopback": False, "volume": False, "mode": False},
                               "local": {"count": len(self.local.queue)}}
        if snap:
            out["app"] = snap.get("app") if source == "cloud" else None
            out["playing"] = bool(snap.get("playing"))
            out["position"] = snap.get("position") or 0.0
            out["lyric"] = self._lyric(source, snap)
            dur = snap.get("duration")
            if not dur and source == "cloud":
                dur = self.lyrics.duration(snap.get("title") or "", snap.get("artist") or "", None)
            out["track"] = {"title": snap.get("title") or "", "artist": snap.get("artist") or "", "album": snap.get("album") or "",
                            "duration": dur, "cover": snap.get("cover") if source == "cloud" else None}
            out["position_source"] = snap.get("position_source") or ("player" if source == "local" else "smtc")
            out["heard"] = self._heard(source, snap)
            if source == "cloud":
                try:
                    out["volume"] = self.app_volume.get(snap.get("app"), snap.get("aumid"))
                except Exception:
                    out["volume"] = None
            else:
                out["volume"] = snap.get("volume")
            out["mode"] = snap.get("mode")
            out["capabilities"] = {
                "seek": bool(snap.get("seek")) if source == "cloud" else True,
                "playSpecific": source == "local",
                "loopback": source == "cloud" and bool(getattr(self.loopback, "running", False)),
                "volume": out["volume"] is not None,
                "mode": bool(snap.get("mode_ok")) if source == "cloud" else True,
            }
            if source == "local":
                out["local"]["index"] = snap.get("index")
                env = energy_envelope(self.local.current_path())
                if env:
                    out["energy"] = env
        m = self._meter_for(source)
        out["spectrum"] = {"available": bool(m and out["playing"] and self.clock() - m.last_feed < 1.5),
                           "bars": m.bars() if m else [0.0] * 48}
        err = getattr(self.loopback, "error", "")
        if err:
            out["loopback_error"] = err
        return out

    def live(self, args: dict | None = None) -> dict:
        self.start()
        self.local.poll()
        source, snap = self._pick()
        self._sync_capture(source, snap)
        m = self._meter_for(source)
        pos = float(snap.get("position") or 0.0) if snap else 0.0
        lyric: dict[str, Any] = {"index": -1, "window": lyr.view(None, 0)["window"]}
        if snap:
            lv = self._lyric(source, snap)
            lyric = {"index": lv.get("index", -1), "window": lv.get("window") or lyric["window"]}
        playing = bool(snap and snap.get("playing"))
        playback = snap.get("playback", "playing" if playing else "paused") if snap else "off"
        return {"source": source, "playing": playing, "playback": playback, "position": round(pos, 2), "lyric": lyric,
                "spectrum": {"available": bool(m and playing and self.clock() - m.last_feed < 1.5), "bars": m.bars() if m else [0.0] * 48}}

    def control(self, args: dict) -> dict:
        action = str(args.get("action") or "")
        value = args.get("value")
        if action == "analyze_file":
            return self.file_analyzer.analyze(value.get("path") if isinstance(value, dict) else None)
        if action == "source":
            if value not in ("auto", "cloud", "local"):
                raise ValueError("来源只能是 auto/cloud/local")
            self.prefer = value
            if value == "cloud":
                self.local.pause()
            return {"prefer": self.prefer}
        if action == "local_add":
            paths = value if isinstance(value, list) else []
            return self.local.add([str(p) for p in paths][:200])
        if action == "local_list":
            return {"items": self.local.items(), "index": self.local.index}
        if action == "local_play":
            idx = int(value) if value is not None else None
            self.local.play(idx)
            self.prefer = "local" if self.prefer == "cloud" else self.prefer
            return {"index": self.local.index}
        source, _snap = self._pick()
        if source == "none" and self.local.queue and self.prefer != "cloud" and action in ("play", "toggle"):
            self.local.play(None)
            return {"source": "local"}
        if source == "local":
            if action == "toggle":
                self.local.toggle()
            elif action == "play":
                self.local.play(None)
            elif action == "pause":
                self.local.pause()
            elif action in ("next", "prev"):
                self.local.step(1 if action == "next" else -1)
            elif action == "seek":
                self.local.seek(float(value))
            elif action == "volume":
                self.local.set_volume(float(value) / 100.0)
            elif action == "mode":
                self.local.set_mode(str(value))
            else:
                raise ValueError("不支持的操作")
            return {"source": "local"}
        if action == "volume":
            if source != "cloud" or not _snap:
                raise RuntimeError("现在没有在放歌")
            return {"source": "cloud", "volume": self.app_volume.set(_snap.get("app"), _snap.get("aumid"), float(value))}
        if action not in CLOUD_ACTIONS:
            raise ValueError("不支持的操作")
        ok = self.smtc.control(action, value)
        if not ok:
            raise RuntimeError("客户端拒绝了这个操作")
        return {"source": "cloud"}

    def cover(self, args: dict | None = None) -> dict:
        c = self.smtc.cover()
        if not c:
            return {"available": False}
        data, mime = c
        return {"available": True, "mime": mime, "b64": base64.b64encode(data).decode("ascii")}

    def dispatch(self, command: str, args: dict) -> Any:
        if command == "ping":
            return {"pong": True, "songmap": songmap.available()}
        if command == "now":
            return self.now(args)
        if command == "live":
            return self.live(args)
        if command == "control":
            return self.control(args)
        if command == "cover":
            return self.cover(args)
        if command == "notify":
            return self.notify(args)
        if command == "clap_status":
            return self.clap_status(args)
        raise KeyError(command)


def handle(service: Service, reply: Callable[[dict], None], mid: Any, cmd: str, args: dict) -> None:
    try:
        data = service.dispatch(cmd, args)
        reply({"id": mid, "ok": True, "data": data})
    except KeyError:
        reply({"id": mid, "ok": False, "error": {"code": "unknown_command", "message": "未知命令"}})
    except (ValueError, RuntimeError, TimeoutError) as exc:
        reply({"id": mid, "ok": False, "error": {"code": "failed", "message": str(exc)[:200]}})
    except Exception as exc:  # 不回传堆栈/路径
        reply({"id": mid, "ok": False, "error": {"code": "internal", "message": type(exc).__name__}})


def serve(service: Service, stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    wlock = threading.Lock()
    warmed_file_analysis = False

    def reply(obj: dict) -> None:
        with wlock:
            stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            stdout.flush()

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get("id")
        cmd = str(msg.get("command") or "")
        if cmd == "shutdown":
            reply({"id": mid, "ok": True, "data": {}})
            break
        args = msg.get("args") or {}
        if cmd == "control":  # 控制与文件分析跑在线程里，留出 live 轮询。
            if not warmed_file_analysis and isinstance(args, dict) and args.get("action") == "analyze_file":
                warmed_file_analysis = True
                if sys.platform == "win32" and songmap.available():
                    # Some Windows builds hang loading the BLAS DLL for the first
                    # time from a worker while the main thread reads the pipe.
                    try:
                        import scipy.linalg  # noqa: F401
                    except Exception:
                        pass
            threading.Thread(target=handle, args=(service, reply, mid, cmd, args), daemon=True).start()
        else:
            handle(service, reply, mid, cmd, msg.get("args") or {})
    service.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pixelmusic")
    ap.add_argument("--data-dir", default="")
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    svc = Service(Path(a.data_dir) if a.data_dir else None)
    serve(svc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
