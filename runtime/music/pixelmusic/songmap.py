"""整曲离线解析：让 agent 基于"测到的声学特征"听这首歌。

只做 librosa 能可靠测出来的东西：
  - 速度与节拍网格（beat_track）
  - 段落结构（chroma + MFCC + 响度 自相似矩阵 → 棋盘核新颖度分段；
    新颖度找不到边界的长曲目回退 agglomerative），并标 A / B / A′ 重复关系
  - 能量（响度 dB）/ 明暗（频谱重心）曲线，最响处、最安静处、突变点
  - 调性估计（chroma 与 Krumhansl 模板相关，附置信度）
  - HPSS 打击/和声能量占比

边界（写死）：本模块只报 librosa 测得到的特征，描述一律标明是"测到的特征"；
不识别乐器、情绪、副歌、曲风。可选组件 clap.py（「听得更细」，LAION CLAP）开着时，
另报「模型听着像」的标签句（那是模型猜的，不当成事实），由服务层拼在句尾。
librosa 不可用时如实报告未启用，绝不拿歌词或文件名冒充。

结果按 (路径, 大小, mtime) 缓存到 <dataDir>/music/analysis/*.json（只存特征数字，不存音频）；
首次播放时由后台单线程（低优先级）计算，播放不等它。

迁自 dsh_music/songmap.py（只读归档，2026-11-14 复制改造）：
  - 去掉 ffmpeg 依赖，用 soundfile 解码（wav/flac/ogg/mp3）+ librosa 重采样；
  - 缓存目录由 set_cache_dir() 注入，不再读 dsh_music.config；
  - 新增 rolling_map() / describe_rolling()：云端（回环）每秒特征向量 → 与整曲解析
    同口径的滚动图（调性 / BPM 可靠性 / 段落 A-B-A′ / 最响最静 / 突变 / 打击占比）。
    rolling_sentence() 保留为 describe_rolling 的薄包装（测试兼容）。
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np


try:  # 可选依赖
    import librosa
except Exception:  # pragma: no cover - 没装 librosa
    librosa = None

ANALYSIS_VERSION = 1
SR = 22050
HOP = 512
BLOCK_SECONDS = 0.5
MAX_SECONDS = 15 * 60
MIN_SECONDS = 8.0
SCOPE_NOTE = "以上是测到的声学特征；不识别乐器、情绪、副歌或曲风。"

NOTE_NAMES = ["C", "C#", "D", "E♭", "E", "F", "F#", "G", "A♭", "A", "B♭", "B"]
# Krumhansl–Kessler 调性轮廓
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_PRIMES = ["", "′", "″", "‴"]


class SongmapError(RuntimeError):
    pass


def available() -> bool:
    return librosa is not None


def unavailable_reason() -> str:
    return "" if available() else "librosa 不可用（未安装或导入失败）"


# ---------------- 缓存 ----------------
_CACHE_DIR: list[Path] = []


def set_cache_dir(path: Path | str | None) -> None:
    _CACHE_DIR[:] = [Path(path)] if path else []
    with _mem_lock:
        _mem.clear()


def cache_dir() -> Path:
    if not _CACHE_DIR:
        raise SongmapError("没有配置缓存目录")
    return _CACHE_DIR[0]


def cache_key(path: Path) -> str:
    p = Path(path).resolve()
    st = p.stat()
    raw = f"{p}|{st.st_size}|{st.st_mtime_ns}|v{ANALYSIS_VERSION}"
    return hashlib.sha1(raw.encode("utf-8", "surrogatepass")).hexdigest()[:24]


def cache_file(path: Path) -> Path:
    return cache_dir() / f"{cache_key(path)}.json"


_mem: dict[str, dict] = {}
_mem_lock = threading.Lock()


def lookup(path: Path) -> dict | None:
    """只读缓存，不计算。"""
    try:
        key = cache_key(path)
    except OSError:
        return None
    with _mem_lock:
        if key in _mem:
            return _mem[key]
    f = cache_dir() / f"{key}.json"
    if not f.is_file():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("version") != ANALYSIS_VERSION:
        return None
    with _mem_lock:
        if len(_mem) > 16:
            _mem.clear()
        _mem[key] = data
    return data


def _write_cache(path: Path, data: dict) -> None:
    d = cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = cache_file(path)
    fd, tmp = tempfile.mkstemp(prefix="an.", suffix=".tmp", dir=str(d))
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, target)
    with _mem_lock:
        _mem[target.stem] = data


# ---------------- 解码 ----------------
def decode(path: Path) -> np.ndarray:
    """soundfile 解码 → 单声道 → SR；只读源文件。"""
    try:
        import soundfile as sf
    except Exception as exc:  # pragma: no cover
        raise SongmapError("soundfile 不可用") from exc
    try:
        with sf.SoundFile(str(path)) as f:
            frames = min(f.frames, int(MAX_SECONDS * f.samplerate)) if f.frames > 0 else int(MAX_SECONDS * f.samplerate)
            data = f.read(frames=frames, dtype="float32", always_2d=True)
            rate = f.samplerate
    except Exception as exc:
        raise SongmapError("无法解码：" + type(exc).__name__) from exc
    y = data.mean(axis=1).astype(np.float32)
    if rate != SR:
        if librosa is None:
            raise SongmapError(unavailable_reason())
        y = librosa.resample(y, orig_sr=rate, target_sr=SR).astype(np.float32)
    return y


# ---------------- 短音频 ----------------
FILE_SCOPE_NOTE = "只描述声学特征，不转写说话内容。"


def analyze_short(y: np.ndarray, sr: int) -> dict:
    """Acoustic measurements for a mono clip under eight seconds."""
    y = np.nan_to_num(np.asarray(y, dtype=np.float32).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)
    frame = max(8, round(sr * .05))
    hop = max(1, round(sr * .025))
    frames = np.lib.stride_tricks.sliding_window_view(y, frame)[::hop]
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-6))
    audible = db > max(-55.0, float(db.max()) - 32.0)
    ratio = float(audible.mean())
    numbers = {"rms_median_dbfs": round(float(np.median(db)), 1),
               "peak_dbfs": round(float(20 * np.log10(max(float(np.abs(y).max()), 1e-6))), 1),
               "dynamic_db": round(float(np.percentile(db, 90) - np.percentile(db, 10)), 1),
               "audible_ratio": round(ratio, 3), "centroid_hz": 0}
    if not audible.any():
        return {"sentence": "这段音频几乎没有声音。" + FILE_SCOPE_NOTE, "numbers": numbers}

    spec = np.abs(np.fft.rfft(frames[audible] * np.hanning(frame), axis=1))
    freqs = np.fft.rfftfreq(frame, d=1 / sr)
    centroid = float(np.median((spec @ freqs) / np.maximum(spec.sum(axis=1), 1e-9)))
    numbers["centroid_hz"] = round(centroid)
    brightness = "偏暗" if centroid < 800 else "偏亮" if centroid >= 2500 else "中等"
    sentence = (f"测到的声学特征：响度中位数约 {numbers['rms_median_dbfs']:.1f} dBFS，"
                f"峰值约 {numbers['peak_dbfs']:.1f} dBFS，响静差约 {numbers['dynamic_db']:.1f} dB，"
                f"约 {ratio:.0%} 的时间有声音，声音{brightness}")
    if librosa is not None:
        try:
            pitch_signal = librosa.resample(y, orig_sr=sr, target_sr=SR) if sr != SR else y
            f0, voiced, _ = librosa.pyin(pitch_signal, sr=SR, fmin=65.4, fmax=1400, frame_length=2048)
            values = f0[voiced & np.isfinite(f0)]
            if values.size:
                mid, lo, hi = (float(np.median(values)), float(values.min()), float(values.max()))
                notes = [str(librosa.hz_to_note(hz, unicode=False)) for hz in (mid, lo, hi)]
                numbers.update(pitch_hz=round(mid, 1), pitch_low_hz=round(lo, 1), pitch_high_hz=round(hi, 1),
                               pitch_note=notes[0], pitch_low_note=notes[1], pitch_high_note=notes[2])
                sentence += f"，音高大约在 {notes[1]} 到 {notes[2]}，中位约 {notes[0]}"
        except Exception:
            pass  # Pitch is optional; the other acoustic measurements still apply.
    return {"sentence": sentence + "。" + FILE_SCOPE_NOTE, "numbers": numbers}


# ---------------- 分析 ----------------
def _blocks(mat: np.ndarray, fpb: int, nb: int) -> np.ndarray:
    m = mat[..., : nb * fpb]
    return m.reshape(*m.shape[:-1], nb, fpb).mean(axis=-1)


def _smooth(x: np.ndarray, width: int) -> np.ndarray:
    if width <= 1 or x.size < width:
        return x.copy()
    k = np.ones(width) / width
    pad = width // 2
    xp = np.pad(x, (pad, width - 1 - pad), mode="edge")
    return np.convolve(xp, k, mode="valid")


def _zscore_rows(m: np.ndarray) -> np.ndarray:
    mu = m.mean(axis=1, keepdims=True)
    sd = m.std(axis=1, keepdims=True)
    sd[sd < 1e-6] = 1.0
    return (m - mu) / sd


def _novelty(ssm: np.ndarray, half: int) -> np.ndarray:
    n = ssm.shape[0]
    g = np.exp(-0.5 * (np.linspace(-2, 2, 2 * half) ** 2))
    kern = np.outer(g, g)
    sign = np.ones((2 * half, 2 * half))
    sign[:half, half:] = -1
    sign[half:, :half] = -1
    kern = kern * sign
    padded = np.pad(ssm, half, mode="edge")
    out = np.zeros(n)
    for i in range(n):
        out[i] = float(np.sum(padded[i:i + 2 * half, i:i + 2 * half] * kern))
    out[out < 0] = 0
    peak = out.max()
    return out / peak if peak > 0 else out


def _pick_peaks(nov: np.ndarray, min_gap: int, max_peaks: int) -> list[int]:
    if nov.size == 0 or nov.max() <= 0:
        return []
    thresh = max(0.2, float(nov.mean() + 0.5 * nov.std()))
    cands = [i for i in range(1, nov.size - 1)
             if nov[i] >= thresh and nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1]]
    cands.sort(key=lambda i: -nov[i])
    chosen: list[int] = []
    for i in cands:
        if i < min_gap or i > nov.size - min_gap:
            continue
        if all(abs(i - j) >= min_gap for j in chosen):
            chosen.append(i)
        if len(chosen) >= max_peaks:
            break
    return sorted(chosen)


def _estimate_key(chroma_mean: np.ndarray) -> dict:
    c = chroma_mean - chroma_mean.mean()
    if not np.any(c):
        return {"name": None, "confidence": "低", "score": 0.0}
    scores = []
    for mode, prof in (("大调", _MAJOR), ("小调", _MINOR)):
        p = prof - prof.mean()
        for tonic in range(12):
            r = float(np.corrcoef(c, np.roll(p, tonic))[0, 1])
            scores.append((r, tonic, mode))
    scores.sort(key=lambda s: -s[0])
    best, second = scores[0], scores[1]
    gap = best[0] - second[0]
    if best[0] >= 0.75 and gap >= 0.08:
        conf = "高"
    elif best[0] >= 0.55 and gap >= 0.03:
        conf = "中"
    else:
        conf = "低"
    return {
        "name": f"{NOTE_NAMES[best[1]]} {best[2]}",
        "confidence": conf,
        "score": round(best[0], 3),
        "runner_up": f"{NOTE_NAMES[second[1]]} {second[2]}",
    }


def _label_segments(segs: list[dict], ssm: np.ndarray) -> tuple[list[dict], list[str]]:
    """按跨段自相似标 A / B / A′（≥0.85 判为重复）。analyze_signal 与 rolling_map 共用。"""
    self_sim = [float(ssm[s["_a"]:s["_b"], s["_a"]:s["_b"]].mean()) for s in segs]
    letters: list[str] = []
    reps: list[int] = []  # 每个字母第一次出现的段
    counts: dict[str, int] = {}
    for j, s in enumerate(segs):
        best, best_rel = None, 0.0
        for li, i in enumerate(reps):
            cross = float(ssm[segs[i]["_a"]:segs[i]["_b"], s["_a"]:s["_b"]].mean())
            rel = cross / max(1e-6, np.sqrt(self_sim[i] * self_sim[j]))
            if rel > best_rel:
                best, best_rel = li, rel
        if best is not None and best_rel >= 0.85:
            letter = chr(ord("A") + best)
            counts[letter] += 1
            s["label"] = letter + _PRIMES[min(counts[letter], len(_PRIMES) - 1)]
            s["repeat_of"] = reps[best]
            s["similarity"] = round(best_rel, 3)
        else:
            letter = chr(ord("A") + len(reps)) if len(reps) < 26 else "?"
            reps.append(j)
            counts[letter] = 0
            s["label"] = letter
        letters.append(letter)
    return segs, letters


def analyze_signal(y: np.ndarray, sr: int = SR) -> dict:
    if librosa is None:
        raise SongmapError(unavailable_reason())
    y = np.asarray(y, dtype=np.float32).reshape(-1)
    duration = y.size / float(sr)
    if duration < MIN_SECONDS:
        raise SongmapError(f"太短（{duration:.1f} 秒），不做整曲解析")
    t0 = time.monotonic()

    # 节拍
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP, units="time")
    tempo = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0
    beats = np.asarray(beats, dtype=float)
    tempo_ok = 40.0 <= tempo <= 220.0 and beats.size >= 8

    # 频谱与 HPSS（在幅度谱上分离，省一次 istft）
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    H, P = librosa.decompose.hpss(S)
    eh, ep = float(np.sum(H ** 2)), float(np.sum(P ** 2))
    perc = ep / (eh + ep) if eh + ep > 0 else 0.0

    power = S ** 2
    rms = librosa.feature.rms(S=S, frame_length=2048, hop_length=HOP)[0]
    cent = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    chroma = librosa.feature.chroma_stft(S=power, sr=sr)
    mel_db = librosa.power_to_db(librosa.feature.melspectrogram(S=power, sr=sr, n_mels=64))
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)

    fpb = max(1, int(round(BLOCK_SECONDS * sr / HOP)))
    nb = min(rms.size, chroma.shape[1]) // fpb
    if nb < 8:
        raise SongmapError("有效帧太少")
    block_sec = fpb * HOP / float(sr)
    rms_b = _blocks(rms, fpb, nb)
    w = _blocks((rms * cent)[None, :], fpb, nb)[0]
    cent_b = w / np.maximum(rms_b, 1e-9)
    loud_db = 20 * np.log10(np.maximum(rms_b, 1e-6))
    chroma_b = _blocks(chroma, fpb, nb)
    mfcc_b = _blocks(mfcc[1:], fpb, nb)

    # 自相似 → 新颖度分段
    feat = np.vstack([_zscore_rows(chroma_b), _zscore_rows(mfcc_b), 2.0 * _zscore_rows(loud_db[None, :])])
    norm = np.linalg.norm(feat, axis=0, keepdims=True)
    norm[norm < 1e-9] = 1.0
    fn = feat / norm
    ssm = (fn.T @ fn + 1.0) / 2.0
    half = max(4, int(round(4.0 / block_sec)))
    min_gap = max(4, int(round(8.0 / block_sec)))
    nov = _novelty(ssm, half)
    max_segments = int(np.clip(duration / 15.0, 2, 12))
    bounds = _pick_peaks(nov, min_gap, max_segments - 1)
    method = "ssm-novelty"
    if not bounds and duration >= 60:
        k = int(np.clip(round(duration / 30.0), 2, 8))
        try:
            b = librosa.segment.agglomerative(feat, k)
            bounds = [int(x) for x in b if min_gap <= x <= nb - min_gap]
            method = "agglomerative"
        except Exception:
            bounds = []
    edges = [0] + bounds + [nb]

    # 段落与重复关系（标注逻辑抽成 _label_segments 共用）
    segs: list[dict] = []
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        segs.append({
            "_a": a, "_b": b,
            "start": round(a * block_sec, 2),
            "end": round(min(duration, b * block_sec), 2),
            "loudness_db": round(float(np.mean(loud_db[a:b])), 2),
            "brightness_hz": round(float(np.mean(cent_b[a:b])), 1),
        })
    segs, letters = _label_segments(segs, ssm)
    for s in segs:
        s.pop("_a"), s.pop("_b")

    # 能量/明暗曲线与特殊点
    sm = max(1, int(round(3.0 / block_sec)))
    loud_s = _smooth(loud_db, sm)
    bright_s = _smooth(cent_b, sm)
    active = loud_s > (loud_s.max() - 40.0)
    climax_i = int(np.argmax(loud_s))
    quiet_pool = np.where(active)[0]
    quiet_i = int(quiet_pool[np.argmin(loud_s[quiet_pool])]) if quiet_pool.size else int(np.argmin(loud_s))
    win = max(2, int(round(2.0 / block_sec)))
    changes = []
    for i in range(win, nb - win):
        d = float(loud_db[i:i + win].mean() - loud_db[i - win:i].mean())
        changes.append((abs(d), i, d))
    changes.sort(key=lambda c: -c[0])
    picked: list[tuple[int, float]] = []
    for mag, i, d in changes:
        if mag < 6.0:
            break
        if all(abs(i - j) >= min_gap for j, _ in picked):
            picked.append((i, d))
        if len(picked) >= 6:
            break
    picked.sort()

    chroma_w = (chroma * rms[None, : chroma.shape[1]]).sum(axis=1) if rms.size >= chroma.shape[1] else chroma.sum(axis=1)

    return {
        "version": ANALYSIS_VERSION,
        "engine": "librosa " + str(getattr(librosa, "__version__", "")),
        "duration": round(duration, 2),
        "analyzed_at": time.time(),
        "elapsed": round(time.monotonic() - t0, 2),
        "tempo": {"bpm": round(tempo, 1) if tempo_ok else None, "reliable": bool(tempo_ok),
                  "beats": [round(float(b), 3) for b in beats[:4000]]},
        "segmentation_method": method,
        "segments": segs,
        "curves": {
            "step": round(block_sec, 4),
            "loudness_db": [round(float(v), 1) for v in loud_s],
            "brightness_hz": [round(float(v)) for v in bright_s],
        },
        "climax": {"time": round(climax_i * block_sec, 2), "loudness_db": round(float(loud_s[climax_i]), 1)},
        "quietest": {"time": round(quiet_i * block_sec, 2), "loudness_db": round(float(loud_s[quiet_i]), 1)},
        "changes": [{"time": round(i * block_sec, 2), "delta_db": round(d, 1)} for i, d in picked],
        "key": _estimate_key(chroma_w),
        "percussive_ratio": round(perc, 3),
    }


def analyze_path(path: Path, *, force: bool = False) -> dict:
    path = Path(path)
    if not force:
        hit = lookup(path)
        if hit is not None:
            return hit
    if librosa is None:
        raise SongmapError(unavailable_reason())
    result = analyze_signal(decode(path), SR)
    _write_cache(path, result)
    return result


# ---------------- 后台 ----------------
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


class Worker:
    """单线程后台队列；同一文件只排一次。"""

    def __init__(self) -> None:
        self._q: queue.Queue[Path] = queue.Queue()
        self._state: dict[str, str] = {}
        self._errors: dict[str, str] = {}
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def state(self, path: Path) -> str:
        if not available():
            return "unavailable"
        if lookup(path) is not None:
            return "ready"
        try:
            key = cache_key(path)
        except OSError:
            return "error"
        with self._lock:
            return self._state.get(key, "idle")

    def error(self, path: Path) -> str:
        try:
            return self._errors.get(cache_key(path), "")
        except OSError:
            return "文件读不到"

    def schedule(self, path: Path) -> str:
        if not available():
            return "unavailable"
        path = Path(path)
        if lookup(path) is not None:
            return "ready"
        try:
            key = cache_key(path)
        except OSError:
            return "error"
        with self._lock:
            if self._state.get(key) in ("pending", "running"):
                return self._state[key]
            self._state[key] = "pending"
            self._q.put(path)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="pixelmusic-songmap", daemon=True)
                self._thread.start()
        return "pending"

    def _run(self) -> None:
        _lower_priority()
        while True:
            try:
                path = self._q.get(timeout=30)
            except queue.Empty:
                with self._lock:
                    if self._q.empty():
                        self._thread = None
                        return
                continue
            try:
                key = cache_key(path)
            except OSError:
                continue
            with self._lock:
                self._state[key] = "running"
            try:
                analyze_path(path)
                with self._lock:
                    self._state[key] = "ready"
            except Exception as exc:
                with self._lock:
                    self._state[key] = "error"
                    self._errors[key] = str(exc)[:200]

    def wait_idle(self, timeout: float = 120.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                busy = any(v in ("pending", "running") for v in self._state.values())
            if not busy:
                return True
            time.sleep(0.05)
        return False


WORKER = Worker()


# ---------------- 描述 ----------------
def _clock(sec: float) -> str:
    sec = max(0, int(round(sec)))
    return f"{sec // 60}:{sec % 60:02d}"


def describe(result: dict, position: float) -> dict:
    segs = result.get("segments") or []
    if not segs:
        return {"sentence": "测到的特征：没有可用的段落数据。" , "segment": None}
    idx = len(segs) - 1
    for i, s in enumerate(segs):
        if s["start"] <= position < s["end"]:
            idx = i
            break
    s = segs[idx]
    head = f"第 {idx + 1} 段（{s['label']}，约 {_clock(s['start'])}-{_clock(s['end'])}）"
    compare = None
    clauses: list[str] = []
    if idx > 0:
        p = segs[idx - 1]
        dl = s["loudness_db"] - p["loudness_db"]
        db = (s["brightness_hz"] - p["brightness_hz"]) / max(1.0, p["brightness_hz"])
        loud = "明显更响" if dl >= 4 else "稍响" if dl >= 1.5 else "明显更轻" if dl <= -4 else "稍轻" if dl <= -1.5 else ""
        bright = "更亮" if db >= 0.15 else "更暗" if db <= -0.15 else ""
        compare = {"delta_db": round(dl, 1), "brightness_change": round(db, 3)}
        if loud or bright:
            clauses.append("比上一段" + "、".join(x for x in (loud, bright) if x))
        else:
            clauses.append("和上一段响度、明暗相近")
    else:
        clauses.append("开头段")
    if "repeat_of" in s:
        r = s["repeat_of"]
        clauses.append(f"与第 {r + 1} 段（{segs[r]['label']}）相似")
    top = max(x["loudness_db"] for x in segs)
    low = min(x["loudness_db"] for x in segs)
    climax_t = (result.get("climax") or {}).get("time", -1)
    near_climax = False
    if s["start"] <= climax_t < s["end"]:
        clauses.append("全曲最响处就在这段")
        near_climax = True
    elif len(segs) > 1 and s["loudness_db"] >= top - 1.5:
        clauses.append("接近全曲最高点")
        near_climax = True
    elif len(segs) > 2 and s["loudness_db"] <= low + 0.5:
        clauses.append("是全曲最安静的一段")
    upcoming = None
    for c in result.get("changes") or []:
        ahead = c["time"] - position
        if 0 < ahead <= 12:
            upcoming = {"in_seconds": round(ahead, 1), **c}
            clauses.append(f"约 {int(round(ahead))} 秒后有一次明显{'变响' if c['delta_db'] > 0 else '变轻'}")
            break
    facts: list[str] = []
    tempo = result.get("tempo") or {}
    if tempo.get("reliable") and tempo.get("bpm"):
        facts.append(f"约 {int(round(tempo['bpm']))} BPM")
    key = result.get("key") or {}
    if key.get("name"):
        facts.append(f"估计 {key['name']}（置信度{key['confidence']}）")
    pr = result.get("percussive_ratio")
    if pr is not None:
        facts.append(f"打击成分约 {int(round(pr * 100))}%")
    sentence = "测到的特征：" + head + "，" + "，".join(clauses) + ("；" + "；".join(facts) if facts else "") + "。"
    return {
        "sentence": sentence,
        "segment": {"index": idx, **s},
        "segments_total": len(segs),
        "compare_previous": compare,
        "near_climax": near_climax,
        "upcoming_change": upcoming,
    }


def listen_payload(track: dict | None, position: float, *, worker: Worker | None = None, schedule: bool = True) -> dict:
    worker = worker or WORKER
    base: dict[str, Any] = {"scope": SCOPE_NOTE, "position": round(float(position or 0.0), 2)}
    if not track:
        return {**base, "available": available(), "state": "idle", "track": None, "sentence": "现在没有在放歌。"}
    brief = {k: track.get(k) for k in ("id", "title", "artist", "album", "genre", "duration") if k in track}
    base["track"] = brief
    if not available():
        return {**base, "available": False, "state": "unavailable",
                "sentence": "整曲解析未启用：" + unavailable_reason() + "。不会用歌词或文件名代替。"}
    path = Path(track.get("path") or "")
    result = lookup(path) if path.name else None
    if result is None:
        state = worker.schedule(path) if schedule and path.is_file() else worker.state(path)
        if state == "error":
            return {**base, "available": True, "state": "error", "sentence": "整曲解析失败：" + (worker.error(path) or "未知原因")}
        return {**base, "available": True, "state": state if state != "idle" else "pending",
                "sentence": "整曲解析进行中（首次播放时后台分析一次，稍后再问）。"}
    out = describe(result, float(position or 0.0))
    return {
        **base, "available": True, "state": "ready", **out,
        "tempo_bpm": (result.get("tempo") or {}).get("bpm"),
        "key": result.get("key"),
        "percussive_ratio": result.get("percussive_ratio"),
        "climax": result.get("climax"),
        "quietest": result.get("quietest"),
        "segments": [{k: v for k, v in s.items() if k in ("start", "end", "label", "loudness_db")} for s in result.get("segments") or []],
        "engine": result.get("engine"),
    }


# ---------------- 云端：回环滚动整曲图 ----------------
def _frow(row: dict, key: str, shape, fill=0.0):
    v = row.get(key)
    if v is None:
        return np.full(shape, fill, dtype=float)
    return np.asarray(v, dtype=float).reshape(-1)


def rolling_map(history: list[dict]) -> dict | None:
    """history: 回环每秒一条特征向量（Meter.history，同一首歌内，≤600 行）。

    把「到目前为止已听的部分」汇成与整曲解析同一口径的滚动图：
      - 调性：累计 chroma 平均 → _estimate_key（≥ 20 秒才报，带置信度）
      - BPM：各行 tempo 中位数；抖动 > ±8% 标不可靠，不报
      - 段落：chroma+mfcc+响度 自相似 → 新颖度分段（最短 8 秒），标 A / B / A′；
        只对已听部分分段，最后一段标 ongoing（进行中）
      - 最响处 / 最安静处 / 突变：已听部分里的；最近 10 秒内的突变记 recent_change
      - 打击成分占比：已听部分平均
    回环没有未来的音频，不做任何预测。行缺 chroma/mfcc（旧格式）时按零处理（调性/段落降级）。
    -> {seconds, key, tempo, segments, climax, quietest, changes, recent_change, percussive_ratio} | None
    """
    rows = [r for r in (history or []) if isinstance(r, dict)]
    n = len(rows)
    if n < 10:
        return None
    # ---- 时间轴：优先用每行的歌曲位置 pos（review 修复 2：原来用「行号×步长」= 开始听了多久，
    #      中途开始听、暂停、桌宠说话跳过的秒数都会让段落时间和歌词对不上）。旧格式行没有 pos，退回行号。
    poss: list[float | None] = []
    for r in rows:
        v = r.get("pos")
        poss.append(float(v) if isinstance(v, (int, float)) and v is not None and float(v) >= 0 else None)
    monotonic = all(b >= a - 0.01 for a, b in zip(poss, poss[1:])) if all(p is not None for p in poss) else False
    use_pos = all(p is not None for p in poss) and monotonic and float(poss[-1]) > float(poss[0])
    if use_pos:
        times = [float(p) for p in poss]
        deltas = [b - a for a, b in zip(times, times[1:]) if b > a]
        step = float(np.median(deltas)) if deltas else 1.0
    else:
        ts = [float(r.get("t") or 0.0) for r in rows]
        gaps = [b - a for a, b in zip(ts, ts[1:]) if b > a]
        step = float(np.median(gaps)) if gaps else 1.0
        times = [i * (step if 1.0 <= step <= 5.0 else 1.0) for i in range(n)]
        step = float(times[1] - times[0]) if n > 1 else 1.0
    if step <= 0 or step > 5.0:
        step = 1.0
    start_t = float(times[0])
    end_t = float(times[-1]) + step          # 最后一行的覆盖终点
    heard = max(0.0, end_t - start_t)

    def loud_of(r):
        if r.get("loud_db") is not None:
            return float(r["loud_db"])
        return 20.0 * float(np.log10(max(float(r.get("energy") or 0.0) / 3.0, 1e-6)))

    loud = np.array([loud_of(r) for r in rows], dtype=float)
    bright = np.array([float(r.get("brightness") or 0.0) for r in rows], dtype=float)
    chroma = np.array([_frow(r, "chroma", (12,)) for r in rows])          # n×12
    mfcc = np.array([_frow(r, "mfcc", (13,)) for r in rows])              # n×13
    percs = [float(r["perc"]) for r in rows if r.get("perc") is not None]
    tempos = [float(r["tempo"]) for r in rows if r.get("tempo")]

    out: dict[str, Any] = {"seconds": int(round(heard)), "step": round(step, 3), "heard_rows": n,
                           "position_start": round(start_t, 2), "position_end": round(end_t, 2),
                           "position_source": "song" if use_pos else "rows"}
    if chroma.sum() > 0 and n >= 20:
        out["key"] = _estimate_key(chroma.mean(axis=0))
    if tempos:
        med = float(np.median(tempos))
        spread = (float(np.percentile(tempos, 90)) - float(np.percentile(tempos, 10))) / med if med else 9.0
        reliable = bool(med and 40.0 <= med <= 220.0 and spread <= 0.16)
        out["tempo"] = {"bpm": round(med, 1) if reliable else None,  # 抖动超 ±8%：标不可靠，不报
                        "reliable": reliable}
    if percs:
        out["percussive_ratio"] = round(float(np.mean(percs)), 3)

    # 段落：特征矩阵（列 = 一行）
    feat = np.vstack([_zscore_rows(chroma.T), _zscore_rows(mfcc.T), 2.0 * _zscore_rows(loud[None, :])])
    norm = np.linalg.norm(feat, axis=0, keepdims=True)
    norm[norm < 1e-9] = 1.0
    fn = feat / norm
    ssm = (fn.T @ fn + 1.0) / 2.0
    half = max(3, int(round(4.0 / step)))
    min_gap = max(3, int(round(8.0 / step)))
    nov = _novelty(ssm, half)
    max_segments = int(np.clip(heard / 15.0, 2, 12))
    bounds = _pick_peaks(nov, min_gap, max_segments - 1)
    edges = [0] + bounds + [n]
    segs: list[dict] = []
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        segs.append({
            "_a": a, "_b": b,
            "start": round(times[a], 2),
            "end": round(times[b - 1] + step, 2),   # 段落时间用歌曲位置
            "loudness_db": round(float(np.mean(loud[a:b])), 2),
            "brightness": round(float(np.mean(bright[a:b])), 3),
        })
    segs, letters = _label_segments(segs, ssm)
    if segs:
        segs[-1]["ongoing"] = True  # 最后一段 = 正在进行的段落
    out["segments"] = segs

    # 已听部分的能量曲线与特殊点（时间都用歌曲位置）
    sm = max(1, int(round(3.0 / step)))
    loud_s = _smooth(loud, sm)
    active = loud_s > (loud_s.max() - 40.0)
    climax_i = int(np.argmax(loud_s))
    quiet_pool = np.where(active)[0]
    quiet_i = int(quiet_pool[np.argmin(loud_s[quiet_pool])]) if quiet_pool.size else int(np.argmin(loud_s))
    out["climax"] = {"time": round(times[climax_i], 2), "loudness_db": round(float(loud_s[climax_i]), 1)}
    out["quietest"] = {"time": round(times[quiet_i], 2), "loudness_db": round(float(loud_s[quiet_i]), 1)}
    win = max(2, int(round(2.0 / step)))
    deltas_all: list[tuple[int, float]] = []
    for i in range(win, n - win):
        d = float(loud[i:i + win].mean() - loud[i - win:i].mean())
        deltas_all.append((i, d))
    ranked = sorted(deltas_all, key=lambda x: -abs(x[1]))
    picked: list[tuple[int, float]] = []
    for i, d in ranked:
        if abs(d) < 6.0:
            break
        if all(abs(i - j) >= min_gap for j, _ in picked):
            picked.append((i, d))
        if len(picked) >= 6:
            break
    picked.sort()
    out["changes"] = [{"time": round(times[i], 2), "delta_db": round(d, 1)} for i, d in picked]
    # review 修复 8：最近 10 秒（歌曲位置）里的突变单独找，不依赖上面「按幅度前 6」——
    # 幅度排不进前 6 的「刚刚突然变响/变轻」以前会被挤掉。
    recent = [(i, d) for i, d in deltas_all if times[i] >= end_t - 10.5 and abs(d) >= 6.0]
    if recent:
        i, d = max(recent, key=lambda x: abs(x[1]))
        out["recent_change"] = {"delta_db": round(d, 1), "time": round(times[i], 2),
                                "direction": "变响" if d > 0 else "变轻"}
    return out


def describe_rolling(history: list[dict], position: float | None = None, scope_note: str | None = None) -> dict | None:
    """滚动整曲图 → 与 describe() 同口径的句子（开头仍是「测到的特征：」）。

    scope_note：句尾括号说明（由服务层按 CLAP 开关决定，默认同旧口径）。
    """
    m = rolling_map(history)
    if not m:
        return None
    segs = m.get("segments") or []
    clauses: list[str] = []
    idx = len(segs) - 1
    if position is not None and segs:
        for i, s2 in enumerate(segs):
            if s2["start"] <= float(position) < s2["end"]:
                idx = i
                break
    s2 = segs[idx] if segs else None
    if s2 is not None:
        ongoing = "，进行中" if s2.get("ongoing") else ""
        head = f"第 {idx + 1} 段（{s2['label']}，约 {_clock(s2['start'])}-{_clock(s2.get('end') or m['seconds'])}{ongoing}）"
        clauses.append(head)
        if idx > 0:
            p = segs[idx - 1]
            dl = s2["loudness_db"] - p["loudness_db"]
            db = (s2["brightness"] - p["brightness"]) / max(1.0, p["brightness"])
            loud = "明显更响" if dl >= 4 else "稍响" if dl >= 1.5 else "明显更轻" if dl <= -4 else "稍轻" if dl <= -1.5 else ""
            br2 = "更亮" if db >= 0.15 else "更暗" if db <= -0.15 else ""
            if loud or br2:
                clauses.append("比上一段" + "、".join(x for x in (loud, br2) if x))
            else:
                clauses.append("和上一段响度、明暗相近")
        if "repeat_of" in s2:
            r = s2["repeat_of"]
            clauses.append(f"与第 {r + 1} 段（{segs[r]['label']}）相似")
        top = max(x["loudness_db"] for x in segs)
        low = min(x["loudness_db"] for x in segs)
        if s2["loudness_db"] >= top - 1.5:
            clauses.append("已听部分最响处就在这段")
        elif len(segs) > 2 and s2["loudness_db"] <= low + 0.5:
            clauses.append("是已听部分最安静的一段")
    rc = m.get("recent_change")
    if rc:
        clauses.append("刚刚突然" + rc["direction"])
    facts: list[str] = []
    tempo = m.get("tempo") or {}
    if tempo.get("reliable") and tempo.get("bpm"):
        facts.append(f"约 {int(round(tempo['bpm']))} BPM")
    key = m.get("key") or {}
    if key.get("name"):
        facts.append(f"估计 {key['name']}（置信度{key['confidence']}）")
    pr = m.get("percussive_ratio")
    if pr is not None:
        facts.append(f"打击成分约 {int(round(pr * 100))}%")
    mm = m.get("seconds") or 0
    span = f"{mm // 60}:{mm % 60:02d}" if mm >= 60 else f"{mm} 秒"
    if m.get("position_source") == "song":
        span += "（歌曲进度）"
    note = scope_note if scope_note is not None else "系统回环实时测得，只到已播放的部分；不识别乐器、情绪、副歌或曲风"
    sentence = "测到的特征：已听 " + span + "，" + "，".join(clauses) + ("；" + "；".join(facts) if facts else "") + "（" + note + "）。"
    return {"sentence": sentence, "rolling": m, "segment": s2, "recent_change": rc}


def rolling_sentence(history: list[dict]) -> str:
    """兼容包装：describe_rolling 的句子部分（旧调用方 / 旧格式行都能吃）。"""
    d = describe_rolling(history)
    return d["sentence"] if d else ""
