"""回环录音 → 实时频谱（48 段 0-1 平滑）与特征（能量/明暗/估速）。

- 只在「一起听歌」开启且云端正在播放时采集（由服务调 set_active 控制）；停止即关闭录音设备。
- 所有音频只在内存环形缓冲里，不落盘、不上传。
- Analyzer 迁自 dsh_music/analysis.py（只读归档，2026-11-14 复制）。
- 本地播放不用回环：播放器把输出块直接喂给同一个 Meter。
"""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Callable

import numpy as np

try:  # 可选依赖
    import librosa
except Exception:  # pragma: no cover - 没装 librosa 时走 numpy
    librosa = None


ENGINE_LIBROSA = "librosa"
ENGINE_NUMPY = "numpy"
HOP_MUSIC = 512


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


class Analyzer:
    """有状态分析器：维护起音强度历史，用来估速度。"""

    def __init__(self) -> None:
        self.engine = ENGINE_LIBROSA if librosa is not None else ENGINE_NUMPY
        self._onset: deque[tuple[float, float]] = deque(maxlen=512)
        self._tempo = 0.0
        self._smooth: np.ndarray | None = None
        self._last: dict[str, Any] = {}

    # ---------------- 频谱 ----------------
    def spectrum(self, mono: np.ndarray, rate: int, bars: int = 32) -> list[float]:
        if mono is None or mono.size < 512 or bars <= 0:
            return [0.0] * max(0, bars)
        try:
            values = self._mel_bands(mono, rate, bars) if self.engine == ENGINE_LIBROSA else None
        except Exception:
            values = None
        if values is None:
            values = self._fft_bands(mono, rate, bars)
        return self._shape(values, bars)

    def _mel_bands(self, mono: np.ndarray, rate: int, bars: int) -> np.ndarray:
        n_fft = 2048 if mono.size >= 2048 else 1024
        hop = max(256, n_fft // 4)
        mel = librosa.feature.melspectrogram(
            y=mono.astype(np.float32),
            sr=int(rate),
            n_fft=n_fft,
            hop_length=hop,
            n_mels=64,
            fmin=40.0,
            fmax=min(rate / 2 * 0.95, 16000.0),
            power=2.0,
        )
        db = librosa.power_to_db(mel, ref=np.max, top_db=70.0)
        profile = np.nan_to_num(db.mean(axis=1), nan=0.0, posinf=0.0, neginf=0.0)
        if float(np.max(profile)) <= 0.0 and float(np.max(mel)) <= 0.0:
            return np.zeros(bars)  # 静音段：别让 log(0) 传染成 NaN
        floor = float(profile.max()) - 70.0
        norm = np.clip((profile - floor) / 70.0, 0.0, 1.0)
        idx = np.linspace(0.0, float(norm.size - 1), bars)
        return np.interp(idx, np.arange(norm.size, dtype=float), norm)

    def _fft_bands(self, mono: np.ndarray, rate: int, bars: int) -> np.ndarray:
        window = np.hanning(mono.size).astype(np.float32)
        spec = np.abs(np.fft.rfft(mono * window))
        freqs = np.fft.rfftfreq(mono.size, d=1.0 / float(rate))
        out = np.zeros(bars, dtype=np.float32)
        if spec.sum() <= 0:
            return out
        edges = np.geomspace(40.0, max(80.0, rate / 2 * 0.95), bars + 1)
        peak = float(np.percentile(spec, 99)) or 1.0
        for i in range(bars):
            mask = (freqs >= edges[i]) & (freqs < edges[i + 1])
            if mask.any():
                out[i] = min(1.0, (float(spec[mask].mean()) / peak) ** 0.62)
        return out

    def _shape(self, values: np.ndarray, bars: int) -> list[float]:
        arr = np.nan_to_num(np.asarray(values, dtype=np.float32).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)
        if arr.size != bars:
            arr = np.interp(
                np.linspace(0.0, float(arr.size - 1), bars),
                np.arange(arr.size, dtype=float),
                arr,
            )
        if self._smooth is None or self._smooth.size != bars:
            self._smooth = arr.astype(np.float32)
        else:
            self._smooth = self._smooth * 0.62 + arr.astype(np.float32) * 0.38
        return [float(_clamp01(v)) for v in self._smooth]

    # ---------------- 特征 ----------------
    def features(self, mono: np.ndarray, rate: int) -> dict[str, Any]:
        if mono is None or mono.size < 512:
            return dict(self._last) if self._last else self._empty()
        try:
            feats = self._librosa_features(mono, rate) if self.engine == ENGINE_LIBROSA else None
        except Exception:
            feats = None
        if feats is None:
            feats = self._numpy_features(mono, rate)
        feats["engine"] = self.engine
        feats["summary"] = self.describe(feats)
        self._last = feats
        return feats

    def _librosa_features(self, mono: np.ndarray, rate: int) -> dict[str, Any]:
        y = mono.astype(np.float32)
        hop = 512
        rms = float(np.mean(librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)))
        centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=int(rate), hop_length=hop)))
        rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=int(rate), hop_length=hop)))
        zcr = float(np.mean(librosa.feature.zero_crossing_rate(y)))
        onset_env = librosa.onset.onset_strength(y=y, sr=int(rate), hop_length=hop)
        onset = float(np.mean(onset_env)) if onset_env.size else 0.0
        self._push_onset(float(np.max(onset_env)) if onset_env.size else 0.0)
        return {
            "rms": round(rms, 5),
            "centroid_hz": round(centroid, 1),
            "rolloff_hz": round(rolloff, 1),
            "zcr": round(zcr, 5),
            "onset": round(onset, 4),
            "tempo": self._estimate_tempo(onset_env, int(rate), hop),
            "energy": round(_clamp01(rms * 3.0), 3),
            "brightness": round(_clamp01(centroid / 4000.0), 3),
        }

    def _numpy_features(self, mono: np.ndarray, rate: int) -> dict[str, Any]:
        rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(mono).astype(np.int8)))))
        window = np.hanning(mono.size).astype(np.float32)
        spec = np.abs(np.fft.rfft(mono * window))
        freqs = np.fft.rfftfreq(mono.size, d=1.0 / float(rate))
        total = float(spec.sum()) or 1.0
        centroid = float((spec * freqs).sum() / total)
        return {
            "rms": round(rms, 5),
            "centroid_hz": round(centroid, 1),
            "rolloff_hz": round(sum(freqs[spec > spec.max() * 0.01][:1]) if spec.size else 0.0, 1),
            "zcr": round(zcr, 5),
            "onset": 0.0,
            "tempo": self._tempo,
            "energy": round(_clamp01(rms * 3.0), 3),
            "brightness": round(_clamp01(centroid / 4000.0), 3),
        }

    def _push_onset(self, value: float) -> None:
        self._onset.append((time.monotonic(), value))

    def _estimate_tempo(self, onset_env: np.ndarray, rate: int, hop: int) -> float:
        """这一窗的帧级起音包络直接估速。旧实现被删了、调用却留着，
        每次 AttributeError → 整条 librosa 特征静默退回 numpy 粗算、BPM 恒 0。
        2026-11-15（review 修复 12）：窗从 3 秒拉到 8 秒（tempo_of），±5% 以内。"""
        value = 0.0
        if onset_env is not None and onset_env.size >= 64:
            try:
                value = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=onset_env, sr=rate, hop_length=hop))[0])
            except Exception:
                try:
                    value = float(np.atleast_1d(librosa.beat.tempo(onset_envelope=onset_env, sr=rate, hop_length=hop))[0])
                except Exception:
                    value = 0.0
        if 40.0 <= value <= 220.0:
            self._tempo = value
        return round(self._tempo, 1)

    def tempo_of(self, y: np.ndarray, rate: int) -> float:
        """用一段（约 8 秒）音频估速：帧级起音包络 + librosa.feature.tempo。3 秒窗偏差太大。"""
        if y is None or y.size < 4096 or librosa is None:
            return round(self._tempo, 1)
        try:
            env = librosa.onset.onset_strength(y=np.asarray(y, dtype=np.float32), sr=int(rate), hop_length=512)
            return self._estimate_tempo(env, int(rate), 512)
        except Exception:
            return round(self._tempo, 1)

    def vector(self, y: np.ndarray, rate: int, heavy: bool = True, tempo_y: np.ndarray | None = None) -> dict[str, Any]:
        """每秒特征向量（约 3 秒窗）：能量/明暗/响度 dB/估速/起音 + 重特征（chroma[12]/mfcc[13]/HPSS 打击占比）。

        heavy=True 才算重特征；False 复用上次的重特征（自适应降档时约每 3 秒刷新）。
        重特征走优化管线：重采样到 22.05k → 手写中值滤波 HPSS（时间轴先压到 ~32 帧算比例）→
        缓存 mel 基。热态全程实测 ~20 ms（预算 80 ms，见 tests/test_music_hear.py）。
        只返回数字，绝不返回音频。"""
        if y is None or y.size < 2048:
            return dict(self._vector_last) if getattr(self, '_vector_last', None) else self._empty()
        try:
            feats = self._librosa_features(y, rate) if self.engine == ENGINE_LIBROSA else None
        except Exception:
            feats = None
        if feats is None:
            feats = self._numpy_features(y, rate)
        if tempo_y is not None and self.engine == ENGINE_LIBROSA:
            feats['tempo'] = self.tempo_of(tempo_y, rate)  # 8 秒窗估速（review 修复 12）
        rms = float(feats.get('rms') or 0.0)
        out = {
            'energy': feats['energy'],
            'brightness': feats['brightness'],
            'tempo': feats['tempo'],
            'loud_db': round(20.0 * float(np.log10(max(rms, 1e-6))), 1),
            'onset': feats['onset'],
            'chroma': None,
            'mfcc': None,
            'perc': None,
        }
        if heavy or not getattr(self, '_heavy', None):
            h = {}
            try:
                if self.engine == ENGINE_LIBROSA and librosa is not None:
                    from scipy.ndimage import median_filter

                    y22 = y if rate <= 24000 else librosa.resample(y, orig_sr=rate, target_sr=22050).astype(np.float32)
                    r22 = 22050 if rate > 24000 else rate
                    S = np.abs(librosa.stft(y22, n_fft=2048, hop_length=HOP_MUSIC))
                    P = S ** 2
                    nb = S.shape[1]
                    k = max(1, nb // 32)  # 时间轴压到 ~32 帧再中值滤波：打击占比只要比例，不要精度
                    Sb = S[:, :nb // k * k].reshape(S.shape[0], -1, k).mean(axis=2) if k > 1 else S
                    hh = median_filter(Sb, size=(1, 17))
                    pp = median_filter(Sb, size=(17, 1))
                    eh, ep = float(np.sum(hh ** 2)), float(np.sum(pp ** 2))
                    h['perc'] = round(ep / (eh + ep), 3) if eh + ep > 0 else 0.0
                    ch = librosa.feature.chroma_stft(S=P, sr=r22).mean(axis=1)
                    h['chroma'] = [round(float(v), 4) for v in ch / max(1e-9, float(ch.sum()))]
                    if not hasattr(self, '_mel_fb') or self._mel_fb_rate != r22:
                        self._mel_fb = librosa.filters.mel(sr=r22, n_fft=2048, n_mels=64).astype(np.float32)
                        self._mel_fb_rate = r22
                    mel_db = librosa.power_to_db(np.maximum(P.T @ self._mel_fb.T, 1e-10))
                    h['mfcc'] = [round(float(v), 3) for v in librosa.feature.mfcc(S=mel_db, n_mfcc=13).mean(axis=1)]
            except Exception:
                h = {}
            if h.get('chroma'):
                self._heavy = h
        hv = getattr(self, '_heavy', None) or {}
        out['chroma'] = hv.get('chroma')
        out['mfcc'] = hv.get('mfcc')
        out['perc'] = hv.get('perc')
        self._vector_last = out
        return out

    def _empty(self) -> dict[str, Any]:
        return {
            "rms": 0.0,
            "centroid_hz": 0.0,
            "rolloff_hz": 0.0,
            "zcr": 0.0,
            "onset": 0.0,
            "tempo": 0.0,
            "energy": 0.0,
            "brightness": 0.0,
            "engine": self.engine,
            "summary": "还没开始放",
        }

    # ---------------- 描述 ----------------
    def describe(self, feats: dict[str, Any]) -> str:
        energy = float(feats.get("energy") or 0.0)
        bright = float(feats.get("brightness") or 0.0)
        tempo = float(feats.get("tempo") or 0.0)
        parts = []
        parts.append("能量很轻" if energy < 0.2 else "能量中等" if energy < 0.55 else "能量很足")
        parts.append("音色偏暗" if bright < 0.25 else "音色居中" if bright < 0.55 else "音色明亮")
        if tempo:
            parts.append(f"约 {int(round(tempo))} BPM")
        note = "librosa 特征" if self.engine == ENGINE_LIBROSA else "numpy 估算"
        return " · ".join(parts) + f"（{note}）"


BARS = 48


class Meter:
    """内存环形缓冲 + 频谱/特征；feed() 可来自回环或本地播放。"""

    def __init__(self, rate: int = 48000, seconds: float = 10.0, clock: Callable[[], float] = time.monotonic) -> None:
        # 10 秒：CLAP 每次要最近 10 秒，估速要最近 8 秒（review 修复 12）
        self.rate = rate
        self.seconds = float(seconds)
        self.clock = clock
        self._buf = np.zeros(int(rate * seconds), dtype=np.float32)
        self._filled = 0
        self._lock = threading.Lock()
        self.analyzer = Analyzer()
        self._bars: list[float] = [0.0] * BARS
        self._bars_at = 0.0
        self._feat_at = 0.0
        self.features: dict[str, Any] = {}
        self.history: list[dict] = []  # 每秒一条特征向量，同一首歌内滚动（上限 600 行 ≈ 10 分钟）
        self.last_rms = 0.0
        self.last_feed = 0.0
        self.duck_until = 0.0          # 桌宠自己出声期间暂停累计特征（宿主经 notify 通道设置）
        self.pos = 0.0                 # SMTC / 播放器位置；网易云自走表估算时 pos_source = estimated
        self.pos_source = ''
        self.last_vector_ms = 0.0      # 重特征单次耗时（实测）
        self.heavy_every = 1           # 耗时超预算时降到每 3 秒算一次重特征
        self._heavy_i = 0
        self.epoch = 0                 # history 被清空一次 +1（切歌 / 循环 / 拖动）；CLAP 累计跟着清
        self._last_row_pos: float | None = None

    def duck(self, seconds: float) -> None:
        """桌宠自己说话 / 提示音期间暂停累计特征（到点自动恢复）。只暂停，不丢已有历史。"""
        self.duck_until = max(self.duck_until, self.clock() + max(0.0, float(seconds)))

    def set_position(self, pos: float, source: str = '') -> None:
        self.pos = float(pos or 0.0)
        if source:
            self.pos_source = source

    def reset(self, rate: int | None = None) -> None:
        with self._lock:
            if rate and rate != self.rate:
                self.rate = rate
                self._buf = np.zeros(int(rate * self.seconds), dtype=np.float32)
            self._buf[:] = 0
            self._filled = 0
            self._bars = [0.0] * BARS
            self.history = []
            self.features = {}
            self.analyzer = Analyzer()
            self._heavy_i = 0
            self.heavy_every = 1
            self._last_row_pos = None
            self.epoch += 1

    def feed(self, block: np.ndarray, rate: int | None = None) -> None:
        a = np.asarray(block, dtype=np.float32)
        if a.ndim == 2:
            a = a.mean(axis=1)
        a = np.nan_to_num(a.reshape(-1))
        if rate and rate != self.rate:
            self.reset(rate)
        with self._lock:
            n = a.size
            if n >= self._buf.size:
                self._buf[:] = a[-self._buf.size:]
            else:
                self._buf = np.roll(self._buf, -n)
                self._buf[-n:] = a
            self._filled = min(self._buf.size, self._filled + n)
            self.last_rms = float(np.sqrt(np.mean(a * a))) if n else 0.0
            self.last_feed = self.clock()

    def window(self, seconds: float) -> np.ndarray:
        """最近 N 秒的音频（只读拷贝；给 CLAP 每 10 秒的听更细用）。绝不落盘。"""
        return self._tail(seconds)

    def _tail(self, seconds: float) -> np.ndarray:
        with self._lock:
            n = min(self._filled, int(self.rate * seconds))
            return self._buf[-n:].copy() if n else np.zeros(0, dtype=np.float32)

    def bars(self) -> list[float]:
        now = self.clock()
        if now - self._bars_at >= 0.05:
            self._bars_at = now
            if now - self.last_feed > 1.0:
                self._bars = [round(v * 0.6, 3) for v in self._bars]
            else:
                self._bars = [round(v, 3) for v in self.analyzer.spectrum(self._tail(0.1), self.rate, BARS)]
        return list(self._bars)

    def tick_features(self, pos: float | None = None, pos_source: str | None = None) -> dict[str, Any]:
        """约每秒记一条特征向量（进 history）。三种情况不记：
        - 暂停 / 静音：last_feed 停更超 1 s，或送进来的是数字静音（last_rms < 1e-4，音量 0 也算）
        - 桌宠自己出声（duck 窗口内）：自己的 TTS / 提示音不能当成听到的歌
        频谱照常跑（视觉不受影响）。"""
        now = self.clock()
        if pos is not None:
            self.pos = float(pos)
        if pos_source:
            self.pos_source = pos_source
        if now - self._feat_at >= 1.0 and now - self.last_feed <= 1.0:
            self._feat_at = now
            if now >= self.duck_until and self.last_rms >= 1e-4:
                # review 修复 2：单曲循环 / 往回拖（pos 回退 >10 秒）或往前拖（>30 秒）→ 整曲图只描述这一遍
                if self._last_row_pos is not None and pos is not None:
                    jump = float(pos) - float(self._last_row_pos)
                    if jump < -10.0 or jump > 30.0:
                        self.history = []
                        self._heavy_i = 0
                        self.heavy_every = 1
                        self.epoch += 1
                y = self._tail(3.0)
                if y.size >= 2048:
                    heavy = (self._heavy_i % max(1, self.heavy_every) == 0)
                    self._heavy_i += 1
                    t0 = time.perf_counter()
                    f = self.analyzer.vector(y, self.rate, heavy, tempo_y=self._tail(8.0))
                    self.last_vector_ms = round((time.perf_counter() - t0) * 1000.0, 1)
                    if self.last_vector_ms > 80.0 and self.heavy_every < 3:
                        self.heavy_every = 3  # 单次超预算：重特征降到每 3 秒一次（方案 A.1 的降档）
                    self.features = f
                    row = {"t": now, "pos": round(self.pos, 2),
                           "energy": f.get("energy", 0.0), "brightness": f.get("brightness", 0.0),
                           "tempo": f.get("tempo", 0.0), "loud_db": f.get("loud_db"),
                           "chroma": f.get("chroma"), "mfcc": f.get("mfcc"),
                           "onset": f.get("onset"), "perc": f.get("perc")}
                    if self.pos_source == 'estimated':
                        row['pos_source'] = 'estimated'
                    self.history.append(row)
                    self._last_row_pos = float(self.pos)
                    if len(self.history) > 600:
                        del self.history[:-600]
        return self.features


def _default_recorder_factory(rate: int, block: int):
    import soundcard as sc  # type: ignore

    spk = sc.default_speaker()
    mic = sc.get_microphone(id=str(spk.name), include_loopback=True)
    return mic.recorder(samplerate=rate, channels=2, blocksize=block)


class LoopbackCapture:
    """后台线程：默认扬声器 loopback → Meter.feed。active=False 时退出并释放设备。"""

    def __init__(self, meter: Meter, recorder_factory: Callable[[int, int], Any] | None = None, rate: int = 48000, block: int = 1024) -> None:
        self.meter = meter
        self.factory = recorder_factory or _default_recorder_factory
        self.rate = rate
        self.block = block
        self._want = False
        self._thread: threading.Thread | None = None
        self.error = ""
        self.running = False

    def set_active(self, on: bool) -> None:
        self._want = bool(on)
        if self._want and not (self._thread and self._thread.is_alive()):
            self._thread = threading.Thread(target=self._run, name="pixelmusic-loopback", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        com = False
        try:
            # soundcard 在首次 import 时自己 CoInitializeEx，若本线程已先初始化它会拿到 S_FALSE 并抛
            # RuntimeError("Error 0x100000001")。所以先 import，再按需补初始化。
            if self.factory is _default_recorder_factory:
                import soundcard  # noqa: F401  # type: ignore
                import warnings

                warnings.filterwarnings("ignore", message="data discontinuity")
            try:
                import ctypes

                com = ctypes.windll.ole32.CoInitializeEx(None, 0) == 0  # 仅本次真初始化才配对 Uninitialize
            except Exception:
                com = False
            self.meter.reset(self.rate)
            with self.factory(self.rate, self.block) as rec:
                self.running = True
                self.error = ""
                while self._want:
                    data = rec.record(numframes=self.block)
                    self.meter.feed(data)
        except Exception as exc:
            self.error = type(exc).__name__  # 只给类型名，不带设备名/路径
            self._want = False
        finally:
            self.running = False
            if com:
                try:
                    import ctypes

                    ctypes.windll.ole32.CoUninitialize()
                except Exception:
                    pass

    def stop(self, wait: float = 2.0) -> None:
        self._want = False
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(wait)
