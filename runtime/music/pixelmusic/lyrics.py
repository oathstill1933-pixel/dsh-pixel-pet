"""歌词：本地同名 .lrc 优先；云端查 LRCLIB 公开库（只发歌名/歌手/时长），结果缓存。

缓存：<dataDir>/music/lyrics-cache/<sha1>.json，只存带时间轴歌词文本（或「没找到」标记），不存音频。
查询在后台线程进行，取不到时 available:false，绝不硬凑。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

TIME_RE = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
LRCLIB = "https://lrclib.net/api/get"
LRCLIB_SEARCH = "https://lrclib.net/api/search"
USER_AGENT = "pixelmusic/1.0 (dsh-pixel-pet)"
MISS_TTL = 24 * 3600

Lines = list[tuple[float, str]]


def parse(text: str) -> Lines:
    lines: Lines = []
    for raw in (text or "").splitlines():
        stamps = list(TIME_RE.finditer(raw))
        if not stamps:
            continue
        body = TIME_RE.sub("", raw).strip()
        if not body:
            continue
        for m in stamps:
            try:
                stamp = int(m.group(1)) * 60 + int(m.group(2)) + int((m.group(3) or "0").ljust(3, "0")[:3]) / 1000.0
            except ValueError:
                continue
            lines.append((stamp, body))
    lines.sort(key=lambda it: it[0])
    return lines


def at(lines: Lines, position: float) -> int:
    """当前行号；早于第一行为 -1。"""
    idx = -1
    for i, (stamp, _) in enumerate(lines):
        if stamp <= position + 0.05:
            idx = i
        else:
            break
    return idx


def view(lines: Lines | None, position: float) -> dict:
    if not lines:
        return {"available": False, "index": -1, "line": "", "next": "", "prev": "", "window": {"before": [], "current": "", "after": []}}
    i = at(lines, position)
    return {
        "window": {
            "before": [t for _, t in lines[max(0, i - 2):max(0, i)]],
            "current": lines[i][1] if i >= 0 else "",
            "after": [t for _, t in lines[i + 1:i + 3]],
        },
        "available": True,
        "index": i,
        "line": lines[i][1] if i >= 0 else "",
        "next": lines[i + 1][1] if i + 1 < len(lines) else "",
        "prev": lines[i - 1][1] if i >= 1 else "",
    }


def local_lrc(audio: Path) -> Lines | None:
    for cand in (audio.with_suffix(".lrc"), audio.with_suffix(".LRC")):
        try:
            if cand.is_file():
                raw = cand.read_bytes()
                for enc in ("utf-8-sig", "gb18030"):
                    try:
                        return parse(raw.decode(enc))
                    except UnicodeDecodeError:
                        continue
                return parse(raw.decode("utf-8", "replace"))
        except OSError:
            return None
    return None


def http_get_json(url: str, timeout: float = 8.0) -> tuple[int, object]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


class LyricsStore:
    """云端歌词：缓存 + 后台查询。fetch 可注入（测试不联网）。"""

    def __init__(self, cache_dir: Path | None, fetch: Callable[[str], tuple[int, object]] = http_get_json, now: Callable[[], float] = time.time) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.fetch = fetch
        self.now = now
        self._mem: dict[str, Lines | None] = {}
        self._pending: set[str] = set()
        self._fail: dict[str, float] = {}
        self._dur: dict[str, float] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key(title: str, artist: str, duration: float | None) -> str:
        raw = f"{(title or '').strip().lower()}|{(artist or '').strip().lower()}|{int(round(duration or 0))}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]

    def _file(self, key: str) -> Path | None:
        return self.cache_dir / f"{key}.json" if self.cache_dir else None

    def _read_cache(self, key: str) -> tuple[bool, Lines | None]:
        f = self._file(key)
        if not f or not f.is_file():
            return False, None
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False, None
        if data.get("miss"):
            if self.now() - float(data.get("at") or 0) > MISS_TTL:
                return False, None
            return True, None
        if data.get("duration"):
            self._dur[key] = float(data["duration"])
        return True, parse(str(data.get("synced") or "")) or None

    def duration(self, title: str, artist: str, duration: float | None) -> float | None:
        """歌词库记录里的时长（客户端没给时长时兜底）。"""
        return self._dur.get(self.key(title, artist, duration))

    def search_url(self, title: str, artist: str) -> str:
        return LRCLIB_SEARCH + "?" + urllib.parse.urlencode({"track_name": title, "artist_name": artist})

    @staticmethod
    def _norm(s: str) -> str:
        return re.sub(r"\s+", "", (s or "").lower())

    def _pick(self, rows: object, title: str, artist: str) -> dict | None:
        if not isinstance(rows, list):
            return None
        t, a = self._norm(title), self._norm(artist)
        for r in rows:
            if not isinstance(r, dict) or not r.get("syncedLyrics"):
                continue
            if self._norm(str(r.get("trackName") or "")) == t and a and a in self._norm(str(r.get("artistName") or "")):
                return r
        return None

    def _write_cache(self, key: str, synced: str | None, duration: float | None = None) -> None:
        f = self._file(key)
        if not f:
            return
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            body = {"miss": True, "at": self.now()} if not synced else {"synced": synced, "at": self.now()}
            if synced and duration:
                body["duration"] = float(duration)
            fd, tmp = tempfile.mkstemp(prefix="ly.", suffix=".tmp", dir=str(f.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as h:
                json.dump(body, h, ensure_ascii=False)
            os.replace(tmp, f)
        except OSError:
            pass

    def url(self, title: str, artist: str, duration: float | None) -> str:
        q = {"track_name": title, "artist_name": artist}
        if duration and 1 <= duration <= 3600:
            q["duration"] = str(int(round(duration)))
        return LRCLIB + "?" + urllib.parse.urlencode(q)

    def lookup(self, title: str, artist: str, duration: float | None, *, background: bool = True) -> tuple[str, Lines | None]:
        """-> (state, lines)；state: ready | missing | pending | skip"""
        if not title or not artist:
            return "skip", None
        k = self.key(title, artist, duration)
        with self._lock:
            if k in self._mem:
                v = self._mem[k]
                return ("ready" if v else "missing"), v
            if k in self._pending:
                return "pending", None
            if self.now() - self._fail.get(k, -1e9) < 60:
                return "missing", None
        hit, lines = self._read_cache(k)
        if hit:
            with self._lock:
                self._mem[k] = lines
            return ("ready" if lines else "missing"), lines
        with self._lock:
            self._pending.add(k)
        if background:
            threading.Thread(target=self._query, args=(k, title, artist, duration), name="pixelmusic-lyrics", daemon=True).start()
            return "pending", None
        self._query(k, title, artist, duration)
        return self.lookup(title, artist, duration, background=False)

    def _query(self, k: str, title: str, artist: str, duration: float | None) -> None:
        synced: str | None = None
        found_dur: float | None = None
        ok = False
        try:
            code, data = self.fetch(self.url(title, artist, duration))
            if code == 200 and isinstance(data, dict):
                ok = True
                synced = data.get("syncedLyrics") or None
                found_dur = data.get("duration")
            elif code == 404:
                ok = True
            if not synced and not duration:  # 没时长时 get 很难命中：按标题+歌手搜索兜底
                code, rows = self.fetch(self.search_url(title, artist))
                if code == 200:
                    hit = self._pick(rows, title, artist)
                    if hit:
                        synced, found_dur = hit.get("syncedLyrics"), hit.get("duration")
                elif code != 404:
                    ok = False
        except Exception:
            ok = False
        lines = parse(synced) if synced else None
        try:
            found_dur = float(found_dur) if found_dur else None
        except (TypeError, ValueError):
            found_dur = None
        if lines and found_dur:
            self._dur[k] = found_dur
        if ok:
            self._write_cache(k, synced if lines else None, found_dur)
        with self._lock:
            self._pending.discard(k)
            if ok:
                self._mem[k] = lines or None
            else:
                self._fail[k] = self.now()
