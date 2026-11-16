"""Authorized, file-only analysis. Never changes player state or opens an input device."""
from concurrent.futures import Future
import json
import math
import os
from pathlib import Path
import tempfile
import threading

import numpy as np

from . import clap, songmap

_EXTENSIONS = {".wav", ".flac", ".ogg", ".mp3"}
_MAX_BYTES = 100 * 1024 * 1024
_CACHE_VERSION = 1


def _error(code, message):
    return {"ok": False, "code": code, "message": message}


def _full_numbers(result):
    curves = result.get("curves") or {}
    loud = curves.get("loudness_db") or []
    bright = curves.get("brightness_hz") or []
    items = {
        "segments": len(result.get("segments") or []),
        "bpm": (result.get("tempo") or {}).get("bpm"),
        "peak_time": (result.get("climax") or {}).get("time"),
        "percussive_ratio": result.get("percussive_ratio"),
    }
    if loud:
        items["loudness_median_db"] = round(float(np.median(loud)), 1)
        items["dynamic_db"] = round(float(max(loud) - min(loud)), 1)
    if bright:
        items["centroid_hz"] = round(float(np.median(bright)))
    return {k: v for k, v in items.items() if isinstance(v, (int, float)) and math.isfinite(v)}


class FileAnalyzer:
    """Keep an in-flight result shareable, then cache it under the file fingerprint."""

    def __init__(self, cache, tags_enabled, tagger):
        self.cache = cache
        self.tags_enabled = tags_enabled
        self.tagger = tagger
        self.lock = threading.Lock()
        self.pending = None

    def analyze(self, requested):
        if not isinstance(requested, str) or not requested:
            return _error("not_found", "找不到这个音频文件。")
        path = Path(requested)
        if not path.is_absolute() or path.drive.startswith("\\\\"):
            return _error("outside", "这个文件夹没被允许。")
        if path.suffix.lower() not in _EXTENSIONS:
            return _error("unsupported", "这个格式还听不了。")
        try:
            if path.resolve(strict=True) != path:
                return _error("outside", "这个文件夹没被允许。")
            if not path.is_file():
                return _error("not_found", "找不到这个音频文件。")
            if path.stat().st_size > _MAX_BYTES:
                return _error("too_big", "这个音频文件超过 100 MB。")
            wants_tags = self.tags_enabled() and clap.status()["state"] == "ready"
            key = f"{songmap.cache_key(path)}-{_CACHE_VERSION}"
            if wants_tags:
                key += "-" + clap.labels_hash()
        except (OSError, RuntimeError, ValueError):
            return _error("not_found", "找不到这个音频文件。")

        target = self.cache / (key + ".json") if self.cache else None
        with self.lock:
            if target:
                try:
                    hit = json.loads(target.read_text(encoding="utf-8"))
                    if isinstance(hit, dict) and hit.get("ok") is True and hit.get("file") == path.name:
                        json.dumps(hit, allow_nan=False)
                        return hit
                except (OSError, ValueError):
                    pass
            owner = self.pending is None
            if owner:
                job = Future()
                self.pending = (key, job)
            elif self.pending[0] == key:
                _, job = self.pending
            else:
                return _error("busy", "正在分析另一段音频，请稍后再试。")
        if not owner:
            return job.result()
        result = _error("analysis_failed", "没能解码或分析这段音频。")
        try:
            songmap._lower_priority()
            result = self._measure(path, wants_tags)
            if target and result.get("ok"):
                self._save(target, result)
        except Exception:
            # File or decoder exceptions can contain the path. Return the fixed message only.
            pass
        finally:
            with self.lock:
                job.set_result(result)
                self.pending = None
        return result

    def _save(self, target, result):
        draft = None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="listen-", suffix=".tmp",
                                             dir=target.parent, delete=False) as f:
                draft = Path(f.name)
                json.dump(result, f, ensure_ascii=False, allow_nan=False)
            os.replace(draft, target)
        except (OSError, ValueError):
            if draft:
                try:
                    draft.unlink(missing_ok=True)
                except OSError:
                    pass

    def _measure(self, path, wants_tags):
        try:
            import soundfile as sf
        except ImportError:
            return _error("unavailable", "当前音乐服务缺少音频分析组件。")
        seconds = float(sf.info(str(path)).duration)
        if not math.isfinite(seconds) or seconds < .5:
            return _error("too_short", "这段音频太短了，听不出东西。")
        truncated = seconds > songmap.MAX_SECONDS
        short = seconds < songmap.MIN_SECONDS
        y, sr = None, None
        if short:
            y, sr = sf.read(str(path), dtype="float32", always_2d=True)
            y = y.mean(axis=1)
            described = songmap.analyze_short(y, sr)
            sentence, numbers = described["sentence"], described["numbers"]
        else:
            if not songmap.available():
                return _error("unavailable", "当前音乐服务缺少整段音频分析组件。")
            full = songmap.analyze_path(path)
            sentence = songmap.describe(full, 0)["sentence"]
            sentence += ("只分析了前 15 分钟。" if truncated else "") + songmap.FILE_SCOPE_NOTE
            numbers = _full_numbers(full)
        tags = None
        if wants_tags:
            try:
                tagger = self.tagger()
                if tagger.ready:
                    if seconds >= 10:
                        tags = clap.tag_file(path, tagger, include_kind=True)
                    else:
                        if y is None:
                            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
                            y = data.mean(axis=1)
                        clip = clap.resample_all(y, sr)
                        count = 10 * clap.SR
                        clip = np.pad(clip[:count], (0, max(0, count - clip.size)))
                        acc = clap.accumulate({}, tagger.tag(clip, include_kind=True))
                        tags = clap.summarize(acc, min_count=1, include_kind=True)
                    json.dumps(tags, allow_nan=False)
            except Exception:
                tags = None  # CLAP is optional, independent of acoustic measurements.
        if tags:
            # Keep the scope sentence last and mark model labels as estimates.
            base = sentence.removesuffix(songmap.FILE_SCOPE_NOTE)
            sentence = clap.with_tags(base, tags, include_kind=True) + songmap.FILE_SCOPE_NOTE
        return {"ok": True, "file": path.name, "seconds": round(seconds, 2),
                "kind": "short" if short else "full", "sentence": sentence,
                "numbers": numbers, "tags": tags, "truncated": truncated}
