# -*- coding: utf-8 -*-
"""声纹验证（SV）：只和录入过的人说话。

这是**便利过滤**，不是身份认证：不抗重放、不抗深伪、不保证「只有本人能说话」，
只是把电视、旁人、桌宠自己的回声挡在 STT 之外。

设计要点
--------
* 模型：3D-Speaker **CAM++ zh-cn 16k common**（192 维 embedding，Apache-2.0），推理走
  `onnxruntime` CPU EP。**不引入 sherpa-onnx**：80 维 kaldi fbank 这里用 numpy 自己算
  （25 ms / 10 ms 帧、povey 窗、preemph 0.97、去直流、mel 80、20 Hz..Nyquist、n_fft 512、
  snip_edges、CMN）。与 `kaldi_native_fbank`（sherpa-onnx 内部同一套）的数值一致性由
  `tests/test_sv_fbank.py` 验证——**只有跑过那个 parity 才算对齐过**，没跑就是没验证。
* 存储：`<data>/voiceprint/templates.bin` + `ortho.bin` + `entropy.bin`
  - Windows：DPAPI（CurrentUser）+ 正交盐，**先加密再写盘**；
    写盘顺序 = 写临时文件 → Win32 API 把临时文件 DACL 收成「只有当前用户、摘掉继承」→
    `os.replace` 原子替换。ACL 收不紧就删掉临时文件、不发布。
  - `entropy.bin` 是**明文**的域分隔值，**不是第二道防线**：它挡不住同一用户下的其它进程。
    真正的保护只有 DPAPI 的 CurrentUser 绑定，而 DPAPI 同样防不住同用户进程。
  - 其它平台：权限 0600，`status()['encrypted'] is False`，UI 必须明示「未加密」。
  - 「仅本次运行」模式：模板只在内存里，重启即失效。它只是**少一份落盘暴露**，
    不承诺内存里读不到（同用户进程仍可读进程内存 / 注入）。
* 隐私边界：
  - 只存 192 维均值向量 + 名字 + 句数；PCM 只在调用栈里用一下，本模块**不主动持久化音频**、
    不把它写日志，但**不保证零副本**：numpy / onnxruntime 内部可能有临时缓冲区，
    Python 也没有可靠的方式保证内存清零；
  - 向量用随机正交阵 R 左乘做盐（cos 不变），泄露的向量没法直接跟外部声纹库比对；
  - `verify()` 不含姓名、不含向量；`status()` / `summary()` 连分数和槽位都没有；
    姓名只出现在用户自己打开的设置界面（隔离接口，不进 settings、不进 agent status）。
* fail-closed：开关开着但没录入、模型缺失、模型 rev 跟模板记录不符、embedding 出错、
  段太短/太轻 —— 一律 `ok=False`，绝不悄悄放行，也绝不把开关改成 false。
* 负模板（桌宠自己的 TTS 音色）只拦回声，且**绑定当前音色 digest**：换音色 → `echo='stale'`，
  旧负模板不参与判定。没准备就是没准备：`echo='missing'` / `self_ready=False`，
  严格档只用 τ，并如实标「回声防护未完成」——不拿 self_sim=0 假装算过。
* 导入成本：本模块顶层会 import numpy（如果还没导入）。**打开开关之前不要在 app 启动路径
  上 import 它**——按 M5 的内存目标，numpy 应当等真正要用（启用/录入/试一下）时再拉。

不依赖第三方音频库：只有 numpy（桌宠运行时自带）+ 标准库 + onnxruntime（语音组件装的）。
"""

import base64
import ctypes
import hashlib
import json
import math
import os
import re
import struct
import sys
import threading
import time

try:
    import numpy as np
except Exception as _exc:  # noqa: BLE001 - numpy 是桌宠运行时自带的，缺了也只在用到时降级
    np = None
    _NP_ERROR = repr(_exc)
else:
    _NP_ERROR = None

SAMPLE_RATE = 16000
FEATURE_DIM = 80
EMBED_DIM = 192
MIN_SEG_S = 0.6            # 短于这个的段直接判不通过（嗯/好 这类短应答会被丢掉，文档里写明）
MIN_RMS = 120.0            # 低于这个当作没说话
SELF_MARGIN = 0.10         # sim_self 领先量
LOOSE_TAU = 0.20           # 打断用的宽松档
SELF_TAU = 0.20            # 宽松档里 sim_self 的上限
SELF_STRONG = 0.50         # 严格档里「明显是自己」的判回声线（只影响拒绝原因，不影响放行）
MAX_PEOPLE = 5
TEMPLATE_VERSION = 1

MAGIC_TEMPLATES = b"PYVPTMPL1"
MAGIC_ORTHO = b"PYVPORTHO1"
MAGIC_ENTROPY = b"PYVPENTR1"

REASONS = {
    "ok": "通过",
    "disabled": "声纹开关关着",
    "short": "这段太短",
    "quiet": "这段太轻",
    "no-enroll": "还没有录入任何人",
    "model-missing": "声纹模型还没装好",
    "model-error": "声纹模型出错了",
    "model-rev": "换了模型，旧模板已作废",
    "strict": "没到严格档的门限",
    "loose": "没到宽松档的门限",
    "self-echo": "像是桌宠自己的声音",
    "bad-mode": "判定模式不认识",
    "config-error": "读不到声纹设置",
    "re-enroll": "换了「仅本次运行 / 落盘」模式，需要重新录入",
}


class SvError(Exception):
    pass


class SvUnavailable(SvError):
    """模型/依赖没就绪；上层应按 fail-closed 处理（拒绝），不要当成通过。"""

    def __init__(self, reason="model-missing", detail=""):
        self.reason = reason
        self.detail = detail
        super().__init__("%s%s" % (REASONS.get(reason, reason), ("：" + detail) if detail else ""))


def _clean_exc(exc, limit=120):
    """错误文本可能带绝对路径/十六进制；截断并抹掉，别让它流到 agent status 或日志里。"""
    s = str(exc)
    s = re.sub(r"[A-Za-z]:[\\/][^\s'\"]*", "<path>", s)
    s = re.sub(r"/(?:Users|home)/[^\s'\"]*", "<path>", s)
    s = re.sub(r"0x[0-9a-fA-F]{6,}", "<hex>", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


# ────────────────────────────── 80 维 kaldi fbank ──────────────────────────────

def _mel_scale(freq):
    return 1127.0 * np.log(1.0 + np.asarray(freq, dtype=np.float64) / 700.0)


def mel_filterbank(rate=SAMPLE_RATE, n_fft=512, n_mels=FEATURE_DIM, low_freq=20.0, high_freq=0.0):
    """kaldi MelBanks 的等三角形滤波器（不做面积归一化），形状 (n_mels, n_fft//2+1)。"""
    nyquist = rate / 2.0
    high = nyquist if high_freq <= 0 else min(high_freq, nyquist)
    mel_low, mel_high = float(_mel_scale(low_freq)), float(_mel_scale(high))
    delta = (mel_high - mel_low) / (n_mels + 1)
    bins = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float64)
    freqs = np.arange(n_fft // 2 + 1, dtype=np.float64) * (rate / float(n_fft))
    mels = _mel_scale(freqs)
    for i in range(n_mels):
        left = mel_low + i * delta
        center = left + delta
        right = center + delta
        rise = (mels - left) / (center - left)
        fall = (right - mels) / (right - center)
        w = np.where(mels <= center, rise, fall)
        w = np.where((mels > left) & (mels < right), w, 0.0)
        bins[i] = w
    return bins


def _povey_window(n):
    k = np.arange(n, dtype=np.float64)
    return (0.5 - 0.5 * np.cos(2.0 * math.pi * k / (n - 1))) ** 0.85


def pcm_to_float(pcm):
    """PCM16 字节 -> float32 数组（保持 int16 数值域，和 kaldi 一致）。"""
    if np is None:
        raise SvUnavailable("model-error", "numpy 不可用：" + str(_NP_ERROR))
    if isinstance(pcm, np.ndarray):
        a = np.asarray(pcm)
        if a.dtype == np.int16:
            return a.astype(np.float32)
        if a.dtype.kind == "f":
            return (a * 32768.0).astype(np.float32) if np.max(np.abs(a)) <= 1.5 else a.astype(np.float32)
        return a.astype(np.float32)
    b = bytes(pcm)
    b = b[: len(b) - (len(b) % 2)]
    return np.frombuffer(b, dtype="<i2").astype(np.float32)


def fbank(pcm, rate=SAMPLE_RATE, n_mels=FEATURE_DIM, frame_ms=25.0, shift_ms=10.0,
          dither=0.0, snip_edges=True, preemph=0.97, remove_dc=True, _cache={}):
    """kaldi 默认参数下的 log-mel fbank，返回 (T, n_mels) float32。

    与 kaldi_native_fbank 的数值对齐由 tests/test_sv_fbank.py 验证（合成噪声/正弦，不用人声）。
    """
    x = pcm_to_float(pcm)
    key = (rate, n_mels, frame_ms, shift_ms, snip_edges)
    cfg = _cache.get(key)
    if cfg is None:
        n_fft = 1
        win = int(round(rate * frame_ms / 1000.0))
        while n_fft < win:
            n_fft *= 2                                  # kaldi: round_to_power_of_two
        shift = int(round(rate * shift_ms / 1000.0))
        cfg = dict(win=win, shift=shift, n_fft=n_fft, window=_povey_window(win),
                   banks=mel_filterbank(rate, n_fft, n_mels))
        _cache[key] = cfg
    win, shift, n_fft = cfg["win"], cfg["shift"], cfg["n_fft"]
    banks = cfg["banks"]
    n = x.shape[0]
    if snip_edges:
        if n < win:
            frames = 0
        else:
            frames = 1 + (n - win) // shift
        starts = np.arange(frames, dtype=np.int64) * shift
    else:
        frames = int(math.ceil(float(n) / shift)) if n > 0 else 0
        center = win // 2
        starts = np.arange(frames, dtype=np.int64) * shift - center
    if frames <= 0:
        return np.zeros((0, n_mels), dtype=np.float32)
    idx = starts[:, None] + np.arange(win, dtype=np.int64)[None, :]      # (T, win)
    if snip_edges:
        buf = x[idx]
    else:
        pad = np.zeros((frames, win), dtype=np.float32)
        ok = (idx >= 0) & (idx < n)
        pad[ok] = x[idx[ok]]
        buf = pad
    if dither != 0.0:
        rng = np.random.RandomState(0)
        buf = buf + rng.normal(0.0, dither, buf.shape).astype(np.float32)
    # kaldi ProcessWindow 的顺序：dither → 去直流 → 预加重 → 加窗（顺序错了数值就对不上）
    if remove_dc:
        buf = buf - buf.mean(axis=1, keepdims=True)
    if preemph != 0.0:
        y = np.empty_like(buf)
        y[:, 0] = buf[:, 0] - preemph * buf[:, 0]
        y[:, 1:] = buf[:, 1:] - preemph * buf[:, :-1]
        buf = y
    buf = buf * cfg["window"].astype(np.float32)
    spec = np.fft.rfft(buf, n=n_fft, axis=1)
    power = spec.real.astype(np.float64) ** 2 + spec.imag.astype(np.float64) ** 2
    mel = power @ banks.T                                     # (T, n_mels)
    eps = np.finfo(np.float32).eps
    return np.log(np.maximum(mel, eps)).astype(np.float32)


def cmn(feats):
    """倒谱均值归一化（逐维减时间均值）；算的时候抬到 float64，避免 float32 累积误差。"""
    if feats.shape[0] == 0:
        return feats
    f = np.asarray(feats, dtype=np.float64)
    return (f - f.mean(axis=0, keepdims=True)).astype(np.float32)


def features(pcm, rate=SAMPLE_RATE, normalize=True):
    f = fbank(pcm, rate)
    return cmn(f) if normalize else f


def rms(pcm):
    """均方根；NaN/Inf 一律当 0（→ 走「太轻」拒绝，绝不让 NaN 混过阈值比较）。"""
    x = pcm_to_float(pcm) if np is not None else None
    if x is None or x.size == 0:
        return 0.0
    if not np.all(np.isfinite(x)):
        return 0.0
    v = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    return v if math.isfinite(v) else 0.0


def pcm_seconds(pcm, rate=SAMPLE_RATE):
    if isinstance(pcm, np.ndarray):
        return float(pcm.shape[0]) / rate
    return (len(pcm) // 2) / float(rate)


def cosine(a, b):
    """余弦相似度。形状不符 / 非有限 / 零向量一律抛错，让上层按 fail-closed 拒绝。"""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.shape != b.shape or a.size == 0:
        raise SvError("向量维度不一致")
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
        raise SvError("向量里有 NaN/Inf")
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if not math.isfinite(na) or not math.isfinite(nb) or na <= 0 or nb <= 0:
        raise SvError("向量模长为 0")
    c = float(np.dot(a, b) / (na * nb))
    if not math.isfinite(c):
        raise SvError("余弦不是有限值")
    return c


def l2norm(v):
    """L2 归一化。非法 shape / NaN / Inf / 零模长都抛错（调用方必须拒绝，不能当通过）。"""
    a = np.asarray(v, dtype=np.float32)
    if a.ndim != 1 or a.size == 0:
        raise SvError("向量形状不对")
    if not np.all(np.isfinite(a)):
        raise SvError("向量里有 NaN/Inf")
    n = float(np.linalg.norm(a.astype(np.float64)))
    if not math.isfinite(n) or n <= 0:
        raise SvError("向量模长为 0")
    return (a / n).astype(np.float32)


def finite01(v, default=None):
    """把一个数收成 [0,1] 的有限值；NaN/Inf/非数字 → default（None 表示判错）。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return max(0.0, min(1.0, f))


# ────────────────────────────── 判定（纯函数，好测） ──────────────────────────────

def decide(sims, taus, self_sim=None, self_ready=False, mode="strict", strictness=0.5):
    """纯判定：sims/taus 是每位录入人的相似度与门限。

    mode='strict'：sim_i >= tau_i(+宽严滑块) 且（若负模板就绪）sim_i - self_sim >= 0.10
    mode='loose' ：sim_i >= 0.20 且（若负模板就绪）self_sim < 0.20
    -> (ok, reason, slot, best)

    说明：这是**便利过滤**，不是身份认证——不抗重放、不抗深伪、不抗录放攻击。
    相似度为负也算「没过线」（strict/loose），不再错归成 no-enroll。

    数值安全：NaN/Inf、长度不匹配、未知 mode、门限不在 (0,1]、strictness 非有限 ——
    全部直接判不通过（model-error），因为 `NaN < tau` 是 False，不挡住就会变成「通过」。
    """
    if mode not in ("strict", "loose"):
        return False, "bad-mode", -1, 0.0
    try:
        sims = list(sims or [])
        taus = list(taus or [])
    except TypeError:
        return False, "model-error", -1, 0.0
    if not sims or not taus:
        return False, "no-enroll", -1, 0.0
    if len(sims) != len(taus):
        return False, "model-error", -1, 0.0
    clean = []
    for s, t in zip(sims, taus):
        try:
            s, t = float(s), float(t)
        except (TypeError, ValueError):
            return False, "model-error", -1, 0.0
        if not (math.isfinite(s) and math.isfinite(t)):
            return False, "model-error", -1, 0.0
        if not (0.0 < t <= 1.0):
            return False, "model-error", -1, 0.0
        clean.append((s, t))
    st = finite01(strictness)
    if st is None:
        return False, "model-error", -1, 0.0
    if self_ready:
        if self_sim is None:
            return False, "model-error", -1, 0.0
        try:
            self_sim = float(self_sim)
        except (TypeError, ValueError):
            return False, "model-error", -1, 0.0
        if not math.isfinite(self_sim):
            return False, "model-error", -1, 0.0
    shift = (st - 0.5) * 0.16 if mode == "strict" else 0.0
    best_i, best = 0, clean[0][0]
    for i, (s, _t) in enumerate(clean[1:], 1):
        if s > best:
            best_i, best = i, s
    tau = clean[best_i][1] + shift
    if mode == "loose":
        if best < LOOSE_TAU:
            return False, "loose", best_i, best
        if self_ready and self_sim is not None and self_sim >= SELF_TAU:
            return False, "self-echo", best_i, best
        return True, "ok", best_i, best
    # 严格档：明显是自己的声音就先判回声（比「没过线」更准确的原因）
    if self_ready and self_sim is not None and self_sim >= SELF_STRONG:
        return False, "self-echo", best_i, best
    if best < tau:
        return False, "strict", best_i, best
    if self_ready and self_sim is not None and (best - float(self_sim)) < SELF_MARGIN:
        return False, "self-echo", best_i, best
    return True, "ok", best_i, best


# ────────────────────────────── embedder ──────────────────────────────

class OnnxEmbedder:
    """CAM++ onnx，CPU EP，1~2 线程。

    实测的公共模型（3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx）签名是
    `x: [N, T, 80] float32` → `embedding: [N, 192]`，模型元数据写着
    `feature_normalize_type=global-mean`（逐维减时间均值，就是 CMN）、`output_dim=192`。
    所以这里按 rank 自动补 batch 维，并对输出维度做**实测**校验——stub 测过不算 ORT 路径能用。
    """

    def __init__(self, model_path, threads=1, normalize=True):
        if np is None:
            raise SvUnavailable("model-error", "numpy 不可用：" + str(_NP_ERROR))
        if not model_path or not os.path.isfile(model_path):
            raise SvUnavailable("model-missing", "没有模型文件")
        try:
            import onnxruntime as ort
        except Exception as exc:  # noqa: BLE001
            raise SvUnavailable("model-missing", "onnxruntime 不可用（%s）" % type(exc).__name__)
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, int(threads))
        so.inter_op_num_threads = 1
        so.log_severity_level = 3
        try:
            self.sess = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        except Exception as exc:  # noqa: BLE001
            raise SvUnavailable("model-error", "会话建不起来：%s" % str(exc)[:160])
        inp = self.sess.get_inputs()[0]
        self.input_name = inp.name
        self.input_rank = len(inp.shape) if inp.shape else 0
        if self.input_rank not in (2, 3) or inp.shape[-1] != FEATURE_DIM or inp.type != "tensor(float)":
            raise SvUnavailable("model-error", "模型输入不是 [T,80] / [N,T,80] float32")
        self.output_name = self.sess.get_outputs()[0].name
        self.normalize = normalize
        self.dim = EMBED_DIM
        self.model_path = model_path
        meta = {}
        try:
            meta = dict(self.sess.get_modelmeta().custom_metadata_map or {})
        except Exception:  # noqa: BLE001
            meta = {}
        self.meta = meta
        dim_hint = str(meta.get("output_dim") or "").strip()
        if dim_hint.isdigit() and int(dim_hint) != EMBED_DIM:
            raise SvUnavailable("model-error", "模型元数据写着 output_dim=%s，不是 %d"
                               % (dim_hint, EMBED_DIM))
        rate_hint = str(meta.get("sample_rate") or "").strip()
        if rate_hint.isdigit() and int(rate_hint) != SAMPLE_RATE:
            raise SvUnavailable("model-error", "模型要求 %s Hz，这里只做 16 kHz"
                               % rate_hint)

    def embed(self, pcm, rate=SAMPLE_RATE):
        if rate != SAMPLE_RATE:
            raise SvError("声纹只接收 16 kHz PCM")
        feats = features(pcm, rate)
        if feats.shape[0] < 10:
            raise SvError("段太短，算不出特征")
        x = feats[None, :, :] if self.input_rank == 3 else feats
        out = self.sess.run([self.output_name], {self.input_name: x})[0]
        v = np.asarray(out, dtype=np.float32).reshape(-1)
        if v.size != EMBED_DIM:
            # 实测校验：模型换错 / 输出维度不对，绝不当成能用
            raise SvError("模型输出维度是 %d，不是 %d" % (v.size, EMBED_DIM))
        if not np.all(np.isfinite(v)):
            raise SvError("模型输出里有 NaN/Inf")
        return l2norm(v) if self.normalize else v

    def close(self):
        """放掉 onnxruntime 会话（换模型 / 关开关时用，旧 session 不留着占内存）。"""
        try:
            self.sess = None
        except Exception:  # noqa: BLE001
            pass


class StubEmbedder:
    """**只给测试用**：不加载模型，把「测试标签」编进 PCM 里，返回可预测的向量。

    生产路径永远用 OnnxEmbedder（或 settings 里指定的真实模型）；注入本类只出现在 tests/ 里。
    协议：第 1 个 int16 样本 = TAG_BASE + 标签号（TAG_BASE=1000，标签 0..999），其余是正弦。
    标签不能放在字节头里——那样会塞进两个 2 万多的大样本，把 RMS 抬到 200 以上，
    「太轻」这类判定就没法测了。
    """

    TAG_BASE = 1000

    def __init__(self, dim=EMBED_DIM, prototypes=None):
        self.dim = dim
        self.normalize = True
        self.model_path = "stub"
        self._proto = dict(prototypes or {})
        self.calls = 0

    @staticmethod
    def pcm(tag, seconds=1.5, rate=SAMPLE_RATE, amp=3000, quiet=False, noise=0.0):
        """造一段带标签的合成信号（正弦 + 可选噪声），不用人声。"""
        tag = int(tag)
        if not 0 <= tag < 1000:
            raise ValueError("stub 标签 0..999")
        n = int(seconds * rate)
        t = np.arange(n, dtype=np.float64) / rate
        sig = amp * np.sin(2 * math.pi * (300 + 40 * (tag % 20)) * t)
        if noise:
            sig = sig + np.random.RandomState(tag).normal(0, noise * amp, n)
        x = sig.astype(np.float32)
        if quiet:
            x = x * 0.01
        arr = np.clip(x, -32768, 32767).astype("<i2")
        arr[0] = StubEmbedder.TAG_BASE + tag
        return arr.tobytes()

    def prototype(self, tag):
        if tag not in self._proto:
            rng = np.random.RandomState(1000 + int(tag))
            self._proto[tag] = l2norm(rng.normal(0, 1, self.dim))
        return self._proto[tag]

    def embed(self, pcm, rate=SAMPLE_RATE):
        self.calls += 1
        if len(pcm) < rate * 2 * MIN_SEG_S:
            raise SvError("段太短")
        first = struct.unpack("<h", bytes(pcm[0:2]))[0]
        return self.prototype(first - StubEmbedder.TAG_BASE).copy()


def make_embedder(model_path=None, embedder=None, threads=1):
    if embedder is not None:
        return embedder
    return OnnxEmbedder(model_path, threads=threads)


# ────────────────────────────── 加密 / ACL ──────────────────────────────

DPAPI_UI_FORBIDDEN = 0x1


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.c_void_p)]


# ────────────────────────────── Win32 绑定 ──────────────────────────────
# 约定（都是防御性写法，不是已确诊的故障根因）：
#   1. DLL 句柄模块级缓存，签名只配一次。注意：CPython 的 CDLL/WinDLL 没有 __del__，
#      GC 并不会调 FreeLibrary，所以「句柄被回收导致硬崩」这条因果**没有证据**，不能据此归因；
#      早前那次 0xC06D007F 硬崩在本机没能复现。
#   2. 每个函数写完整 argtypes/restype：避免默认 c_int(32 位) restype 截断 x64 指针这类
#      隐性错误。同样是防御，不是已证实的根因。
#   3. 结构体里指针字段用 c_void_p，不要用 POINTER(c_char)，避免隐式转换。

_DLLS = {}
_SIGS = set()


def _dll(name):
    h = _DLLS.get(name)
    if h is None:
        h = ctypes.WinDLL(name, use_last_error=True)
        _DLLS[name] = h
    return h


def _fn(handle, name, argtypes, restype):
    key = (id(handle), name)
    fn = getattr(handle, name)
    if key not in _SIGS:
        fn.argtypes = argtypes
        fn.restype = restype
        _SIGS.add(key)
    return fn


DPAPI_UI_FORBIDDEN = 0x1

# ── ACL：用真实 token SID，不依赖 USERNAME 环境字符串（域账户/伪造都会出问题） ──
TOKEN_QUERY = 0x0008
TokenUser = 1
SE_FILE_OBJECT = 1
DACL_SECURITY_INFORMATION = 0x00000004
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
SE_DACL_PROTECTED = 0x1000
ACL_REVISION = 2
CONTAINER_INHERIT_ACE = 0x02
OBJECT_INHERIT_ACE = 0x01
FILE_ALL_ACCESS = 0x001F01FF


def _current_user_sid():
    """当前进程令牌里的用户 SID（bytes）。"""
    if os.name != "nt":
        raise SvError("非 Windows，没有 token SID")
    adv = _dll("advapi32")
    k32 = _dll("kernel32")
    get_current = _fn(k32, "GetCurrentProcess", [], ctypes.c_void_p)
    close_handle = _fn(k32, "CloseHandle", [ctypes.c_void_p], ctypes.c_int)
    open_token = _fn(adv, "OpenProcessToken",
                     [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)], ctypes.c_int)
    get_info = _fn(adv, "GetTokenInformation",
                   [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
                    ctypes.POINTER(ctypes.c_uint32)], ctypes.c_int)
    token = ctypes.c_void_p()
    if not open_token(get_current(), TOKEN_QUERY, ctypes.byref(token)):
        raise SvError("OpenProcessToken 失败 winerr=%s" % ctypes.get_last_error())
    try:
        size = ctypes.c_uint32(0)
        get_info(token, TokenUser, None, 0, ctypes.byref(size))
        if not size.value:
            raise SvError("读不到令牌长度 winerr=%s" % ctypes.get_last_error())
        buf = ctypes.create_string_buffer(size.value)
        if not get_info(token, TokenUser, buf, size.value, ctypes.byref(size)):
            raise SvError("GetTokenInformation 失败 winerr=%s" % ctypes.get_last_error())
        sid_ptr = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        if not sid_ptr:
            raise SvError("令牌里没有 SID")
        sub_authority_count = ctypes.cast(sid_ptr, ctypes.POINTER(ctypes.c_ubyte))[1]
        return ctypes.string_at(sid_ptr, 8 + 4 * sub_authority_count)
    finally:
        close_handle(token)


def _set_owner_only_dacl(path, sid, is_dir=False):
    """把 path 的 DACL 换成「只有这个 SID」并摘掉继承（PROTECTED_DACL）。

    用 SetNamedSecurityInfoW（它要绝对格式的 ACL）；SetFileSecurityW 只吃 self-relative
    描述符，实测回读拿不到 SE_DACL_PROTECTED，会假装收紧成功。
    """
    adv = _dll("advapi32")
    init_acl = _fn(adv, "InitializeAcl", [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32], ctypes.c_int)
    add_ace = _fn(adv, "AddAccessAllowedAceEx",
                  [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
                   ctypes.c_void_p], ctypes.c_int)
    set_info = _fn(adv, "SetNamedSecurityInfoW",
                   [ctypes.c_wchar_p, ctypes.c_int, ctypes.c_uint32, ctypes.c_void_p,
                    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p], ctypes.c_uint32)
    acl_buf = ctypes.create_string_buffer(1024)
    if not init_acl(acl_buf, 1024, ACL_REVISION):
        raise SvError("InitializeAcl 失败 winerr=%s" % ctypes.get_last_error())
    sid_buf = ctypes.create_string_buffer(sid, len(sid))
    flags = (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) if is_dir else 0
    if not add_ace(acl_buf, ACL_REVISION, flags, FILE_ALL_ACCESS, sid_buf):
        raise SvError("AddAccessAllowedAceEx 失败 winerr=%s" % ctypes.get_last_error())
    info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
    rc = set_info(str(path), SE_FILE_OBJECT, info, None, None, acl_buf, None)
    if rc != 0:
        raise SvError("SetNamedSecurityInfoW 失败 rc=%s" % rc)


def _dacl_protected(path):
    """回读 DACL：继承是否真的被摘掉（SE_DACL_PROTECTED）。"""
    if os.name != "nt":
        return True
    adv = _dll("advapi32")
    get_sec = _fn(adv, "GetFileSecurityW",
                  [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                   ctypes.POINTER(ctypes.c_uint32)], ctypes.c_int)
    need = ctypes.c_uint32(0)
    get_sec(str(path), DACL_SECURITY_INFORMATION, None, 0, ctypes.byref(need))
    if need.value <= 0:
        return False
    buf = ctypes.create_string_buffer(need.value)
    if not get_sec(str(path), DACL_SECURITY_INFORMATION, buf, need.value, ctypes.byref(need)):
        return False
    control = struct.unpack_from("<H", buf.raw, 2)[0]
    return bool(control & SE_DACL_PROTECTED)


def _dpapi(data, entropy, decrypt=False):
    """DPAPI 加密/解密（CurrentUser）。返回 bytes；失败抛错。"""
    if os.name != "nt":
        raise SvError("这台机器没有 DPAPI")
    crypt32 = _dll("crypt32")
    k32 = _dll("kernel32")
    prot = _fn(crypt32, "CryptUnprotectData" if decrypt else "CryptProtectData",
               [ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.POINTER(_DataBlob),
                ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                ctypes.POINTER(_DataBlob)], ctypes.c_int)
    local_free = _fn(k32, "LocalFree", [ctypes.c_void_p], ctypes.c_void_p)
    raw = bytes(data)
    buf_in = ctypes.create_string_buffer(raw, max(1, len(raw)))
    blob_in = _DataBlob(len(raw), ctypes.cast(buf_in, ctypes.c_void_p))
    ent = bytes(entropy)
    buf_ent = ctypes.create_string_buffer(ent, max(1, len(ent)))
    blob_ent = _DataBlob(len(ent), ctypes.cast(buf_ent, ctypes.c_void_p))
    blob_out = _DataBlob()
    if not prot(ctypes.byref(blob_in), None, ctypes.byref(blob_ent), None, None,
                DPAPI_UI_FORBIDDEN, ctypes.byref(blob_out)):
        raise SvError("DPAPI %s 失败（winerr=%s）" % ("解开" if decrypt else "加密",
                                                      ctypes.get_last_error()))
    try:
        if not blob_out.pbData:
            raise SvError("DPAPI 返回空指针")
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        if blob_out.pbData:
            local_free(blob_out.pbData)


class Codec:
    """DPAPI(CurrentUser) 包一层；非 Windows 退化成「不加密 + 0600」（status 会如实标记）。"""

    def __init__(self, data_dir, entropy=None, use_dpapi=None):
        self.data_dir = data_dir
        self.dir = os.path.join(data_dir, "voiceprint")
        self.is_windows = os.name == "nt"
        self.want_dpapi = self.is_windows if use_dpapi is None else bool(use_dpapi)
        self.errors = []
        self.acl_ok = None
        self._entropy = entropy
        self._lock = threading.Lock()

    # -- entropy -------------------------------------------------------
    # 注意：entropy 只是「域分隔」，**不是第二道防线**——它明文躺在这里，同一用户读得到。
    # 真正的保护是 DPAPI 的 CurrentUser 绑定；DPAPI 防不住同一用户下的其它进程，这一点
    # 必须如实写在界面和 README 里，不许说成「DPAPI + entropy 双保险」。
    def _entropy_path(self):
        return os.path.join(self.dir, "entropy.bin")

    def entropy(self):
        with self._lock:
            if self._entropy is not None:
                return self._entropy
            if not self.want_dpapi:
                self._entropy = b"dsh-pixel-pet/voiceprint/v1"
                return self._entropy
            path = self._entropy_path()
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                if raw.startswith(MAGIC_ENTROPY) and len(raw) >= len(MAGIC_ENTROPY) + 16:
                    self._entropy = raw[len(MAGIC_ENTROPY):]
                    return self._entropy
            except OSError:
                pass
            if not self.ensure_dir():
                raise SvError("声纹目录不可用")
            ent = os.urandom(32)
            self._write_raw(path, MAGIC_ENTROPY + ent)   # 明文写：不能走 protect（会绕回 entropy）
            self._entropy = ent
            return self._entropy

    # -- DPAPI ---------------------------------------------------------
    @property
    def encrypted(self):
        return bool(self.want_dpapi)

    def protect(self, plain):
        if not self.want_dpapi:
            return bytes(plain)
        return _dpapi(plain, self.entropy(), decrypt=False)

    def unprotect(self, blob):
        if not self.want_dpapi:
            return bytes(blob)
        return _dpapi(blob, self.entropy(), decrypt=True)

    # -- ACL -----------------------------------------------------------
    def ensure_dir(self):
        try:
            os.makedirs(self.dir, exist_ok=True)
        except OSError as exc:
            self.errors.append("建目录失败：%s" % _clean_exc(exc))
            return False
        self.tighten(self.dir)          # 目录只是顺带收紧；失败不阻塞（文件自己还会收紧一次）
        return True

    def tighten(self, path):
        """去掉继承、只留当前用户（真实 token SID）。回读确认 SE_DACL_PROTECTED 才算成功。"""
        if not self.is_windows:
            try:
                os.chmod(path, 0o700 if os.path.isdir(path) else 0o600)
                self.acl_ok = True
            except OSError as exc:
                self.acl_ok = False
                self.errors.append("chmod 失败：%s" % _clean_exc(exc))
            return self.acl_ok
        ok = False
        try:
            sid = _current_user_sid()
            _set_owner_only_dacl(path, sid, is_dir=os.path.isdir(path))
            ok = _dacl_protected(path)
            if not ok:
                self.errors.append("收紧后回读 DACL 仍可继承")
        except Exception as exc:  # noqa: BLE001
            self.errors.append("收紧 ACL 失败：%s" % _clean_exc(exc))
        self.acl_ok = ok
        return ok

    def _write_raw(self, path, payload):
        """不加密的写（只给 entropy 用）：临时文件 → 收紧 → 原子替换；收紧失败就删掉不发布。"""
        tmp = "%s.%d.tmp" % (path, os.getpid())
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(bytes(payload))
                f.flush()
                os.fsync(f.fileno())
            if not self.tighten(tmp):
                raise SvError("临时文件 ACL 没收紧，拒绝发布")
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return len(payload)

    def _write_atomic(self, path, blob):
        """blob 已是密文：写临时文件 → 收紧 ACL（失败即删）→ 原子替换。"""
        tmp = "%s.%d.tmp" % (path, os.getpid())
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(blob)
                f.flush()
                os.fsync(f.fileno())
            if not self.tighten(tmp):
                raise SvError("临时文件 ACL 没收紧，拒绝发布（%s）"
                              % (_clean_exc(self.errors[-1]) if self.errors else "未知"))
            os.replace(tmp, path)          # 先收紧再改名：最终名一次都没松过
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return len(blob)

    def read(self, path):
        with open(path, "rb") as f:
            return self.unprotect(f.read())

    def write(self, path, payload):
        if not self.want_dpapi and self.is_windows:
            raise SvError("Windows 上没启用 DPAPI，拒绝写声纹模板")
        if not self.ensure_dir():
            raise SvError("声纹目录不可用")
        return self._write_atomic(path, self.protect(payload))


# ────────────────────────────── 模板 ──────────────────────────────

class Templates:
    """内存里的模板表；持久化由 VoicePrint 通过 Codec 负责。

    结构：{"v":1, "rev":str, "dim":192,
           "people":[{"name","n","created","tau","vec": np.float32[192]}],
           "self":{"digest":str, "vec": np.float32[192]} | None}
    """

    def __init__(self, rev="", dim=EMBED_DIM):
        self.v = TEMPLATE_VERSION
        self.rev = rev
        self.dim = dim
        self.people = []
        self.self_vec = None
        self.self_digest = ""

    # -- 序列化 --------------------------------------------------------
    def to_bytes(self):
        people = []
        for p in self.people:
            people.append({"name": p["name"], "n": int(p["n"]), "created": p["created"],
                           "tau": float(p["tau"]), "vec": _b64(p["vec"])})
        self_block = None
        if self.self_vec is not None:
            self_block = {"digest": self.self_digest, "vec": _b64(self.self_vec)}
        doc = {"v": self.v, "rev": self.rev, "dim": self.dim, "people": people, "self": self_block}
        return MAGIC_TEMPLATES + json.dumps(doc, ensure_ascii=False, sort_keys=True).encode("utf-8")

    @classmethod
    def from_bytes(cls, raw, dim=EMBED_DIM):
        if not bytes(raw).startswith(MAGIC_TEMPLATES):
            raise SvError("模板格式不认识")
        doc = json.loads(bytes(raw)[len(MAGIC_TEMPLATES):].decode("utf-8"))
        if doc.get("v") != TEMPLATE_VERSION or int(doc.get("dim") or 0) != EMBED_DIM:
            raise SvError("模板版本或维度不合法")
        t = cls(rev=str(doc.get("rev") or ""), dim=EMBED_DIM)
        if len(doc.get("people") or []) > MAX_PEOPLE:
            raise SvError("模板人数超过上限")
        for p in doc.get("people") or []:
            vec = _unb64(p.get("vec"), t.dim)
            if vec is None:
                raise SvError("模板里的向量不合法（尺寸/NaN）")
            tau = finite01(p.get("tau"), None)
            if tau is None or not (0.0 < tau <= 1.0):
                raise SvError("模板里的门限不合法")
            t.people.append({"name": str(p.get("name") or "")[:24], "n": int(p.get("n") or 0),
                             "created": float(p.get("created") or 0.0), "tau": tau, "vec": vec})
        s = doc.get("self")
        if isinstance(s, dict):
            vec = _unb64(s.get("vec"), t.dim)
            if vec is None:
                raise SvError("负模板向量不合法（尺寸/NaN）")
            t.self_vec = vec
            t.self_digest = str(s.get("digest") or "")
        return t

    # -- 操作 ----------------------------------------------------------
    def find(self, name):
        for i, p in enumerate(self.people):
            if p["name"] == name:
                return i
        return -1

    def put(self, name, vec, n, tau):
        name = str(name or "").strip()[:24]
        if not name:
            raise SvError("名字不能为空")
        i = self.find(name)
        vec = l2norm(vec)                       # 非法 shape/NaN/零模长这里就抛错
        tau = finite01(tau, None)
        if tau is None or not (0.0 < tau <= 1.0):
            raise SvError("门限必须是 0..1 的有限值")
        rec = {"name": name, "n": int(n), "created": time.time(), "tau": tau, "vec": vec}
        if i < 0:
            if len(self.people) >= MAX_PEOPLE:
                raise SvError("最多 %d 个人" % MAX_PEOPLE)
            self.people.append(rec)
        else:
            self.people[i] = rec
        return rec

    def drop(self, name):
        i = self.find(name)
        if i >= 0:
            self.people.pop(i)
            return True
        return False

    def clear(self):
        self.people = []
        self.self_vec = None
        self.self_digest = ""

    @property
    def ready(self):
        return bool(self.people)


def _b64(vec):
    return base64.b64encode(np.asarray(vec, dtype=np.float32).tobytes()).decode("ascii")


def _unb64(s, dim):
    try:
        raw = base64.b64decode(s.encode("ascii"))
        expected = dim * 4
        if len(raw) != expected:
            return None
        vec = np.frombuffer(raw, dtype=np.float32).copy()
        return vec if np.all(np.isfinite(vec)) else None
    except Exception:  # noqa: BLE001
        return None


def orthogonal(dim=EMBED_DIM, seed=None):
    """随机正交阵（QR），cos 不变、方向乱掉，用来给向量加盐。"""
    rng = np.random.RandomState(seed if seed is not None else int.from_bytes(os.urandom(4), "little"))
    a = rng.normal(0.0, 1.0, (dim, dim))
    q, r = np.linalg.qr(a)
    d = np.sign(np.diag(r))
    d[d == 0] = 1.0
    q = q * d[None, :]
    return np.asarray(q, dtype=np.float32)


# ────────────────────────────── 主类 ──────────────────────────────

DEFAULT_SETTINGS = {"enabled": False, "mode": "disk", "strictness": 0.5}


class VoicePrint:
    """声纹验：一个对象管模型、模板、加盐、判定。

    settings_getter → {"enabled": bool, "mode": "disk"|"memory", "strictness": 0.0..1.0}
    名字只在 `people()`（设置页专用）里出现；status()/verify() 不带姓名。
    """

    def __init__(self, data_dir, settings_getter=None, model_path=None, embedder=None,
                 codec=None, clock=time.time, threads=1, voice_digest_getter=None):
        self.data_dir = data_dir
        self.settings_getter = settings_getter or (lambda: dict(DEFAULT_SETTINGS))
        self.model_path = model_path
        self.clock = clock
        self.threads = threads
        self._embedder = embedder
        self._codec = codec or Codec(data_dir)
        self._lock = threading.RLock()
        self._rev_cache = None
        self._tpl = Templates()                 # rev 读到模板/模型时再定，别在构造里读 27 MB 模型
        self._loaded = False
        self._load_error = ""
        self._salt = None
        self._salt_broken = False
        self._cfg_good = None
        self._mode_seen = None
        self._tpl_source = None
        self._needs_reenroll = False
        self.voice_digest_getter = voice_digest_getter
        self.last = None
        self._last_detail = {}

    # -- 配置 ----------------------------------------------------------
    @property
    def cfg(self):
        """设置来源坏了就 sticky fail-closed：沿用上次读到的开关（enabled 保持 true），
        从没读到过就当作「开着但不可用」→ 一律拒绝，绝不因为读不到就默认关闭放行。
        """
        try:
            raw = self.settings_getter()
            if not isinstance(raw, dict):
                raise TypeError("settings 不是 dict")
        except Exception:  # noqa: BLE001
            if self._cfg_good is not None:
                out = dict(self._cfg_good)
                out["error"] = "config-error"
                return out
            return {"enabled": True, "mode": "disk", "strictness": 0.5, "error": "config-error"}
        out = dict(DEFAULT_SETTINGS)
        out["enabled"] = bool(raw.get("enabled", False))
        out["mode"] = "memory" if raw.get("mode") == "memory" else "disk"
        v = finite01(raw.get("strictness", 0.5), None)
        out["strictness"] = 0.5 if v is None else v
        if raw.get("error") or raw.get("mode", "disk") not in ("memory", "disk") or v is None or not isinstance(raw.get("enabled", False), bool):
            out["error"] = "config-error"
            out["enabled"] = True  # 非法配置永不关闭闸门
        self._cfg_good = dict(out)
        return out

    @property
    def enabled(self):
        return bool(self.cfg["enabled"])

    @property
    def memory_only(self):
        return self.cfg["mode"] == "memory"

    # -- 路径 ----------------------------------------------------------
    @property
    def dir(self):
        return os.path.join(self.data_dir, "voiceprint")

    @property
    def templates_path(self):
        return os.path.join(self.dir, "templates.bin")

    @property
    def ortho_path(self):
        return os.path.join(self.dir, "ortho.bin")

    # -- 模型 rev ------------------------------------------------------
    def model_rev(self):
        """模型内容指纹（前 16 位 sha256）；文件不在就返回空串。结果按 path+大小+时间缓存。"""
        p = self.model_path
        if not p or not os.path.isfile(p):
            return ""
        try:
            st = os.stat(p)
            key = (p, st.st_size, int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))))
        except OSError:
            return ""
        with self._lock:
            if self._rev_cache and self._rev_cache[0] == key:
                return self._rev_cache[1]
        h = hashlib.sha256()
        try:
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
        except OSError:
            return ""
        rev = h.hexdigest()[:16]
        with self._lock:
            self._rev_cache = (key, rev)
        return rev

    # -- 加载 ----------------------------------------------------------
    def _load_salt(self):
        if self._salt is not None or self._salt_broken:
            return self._salt
        if self.memory_only:
            # 仅本次运行：盐也只在内存里生成，绝不读盘（免得把盘上旧盐/模板牵进来）
            self._salt = orthogonal(EMBED_DIM)
            return self._salt
        codec = self._codec
        try:
            raw = codec.read(self.ortho_path)
            if not raw.startswith(MAGIC_ORTHO):
                raise SvError("盐文件格式不认识")
            dim = struct.unpack("<I", raw[len(MAGIC_ORTHO):len(MAGIC_ORTHO) + 4])[0]
            body = raw[len(MAGIC_ORTHO) + 4:]
            if dim != EMBED_DIM or len(body) != dim * dim * 4:
                raise SvError("盐文件尺寸不对")
            self._salt = np.frombuffer(body, dtype=np.float32).reshape(dim, dim).copy()
        except FileNotFoundError:
            if os.path.exists(self.templates_path):
                self._salt_broken = True
                self._load_error = "模板存在但盐缺失，必须清除旧模板再重新录入"
                return None
            self._salt = orthogonal(EMBED_DIM)
            try:
                codec.write(self.ortho_path, MAGIC_ORTHO + struct.pack("<I", EMBED_DIM)
                            + self._salt.tobytes())
            except Exception as exc:  # noqa: BLE001 - disk 模式不能发布一份无法恢复盐的模板
                self._salt = None
                self._salt_broken = True
                self._load_error = "盐没写成：%s" % _clean_exc(exc)
        except Exception as exc:  # noqa: BLE001
            self._salt_broken = True
            self._load_error = "盐读不出来（%s）" % _clean_exc(exc)
            self._salt = None
        return self._salt

    def load(self, force=False):
        with self._lock:
            mode = "memory" if self.memory_only else "disk"
            if self._mode_seen != mode:
                # 切换模式：盐和模板是成对的，旧的一律作废（要求重新录入），
                # 既不许把 disk 模板带进 memory，也不许把 memory 模板落盘。
                # 注意：这一步必须早于 _loaded 的提前返回，否则开关改了也不生效。
                if self._mode_seen is not None:
                    self._tpl = Templates()
                    self._needs_reenroll = True
                self._mode_seen = mode
                self._salt = None
                self._salt_broken = False
                self._loaded = False        # 模式变了就得重新走一遍加载
            if self._loaded and not force:
                return self
            self._loaded = True
            if self.memory_only:
                self._tpl_source = "memory"
                return self
            self._load_salt()
            if self._needs_reenroll:
                self._tpl = Templates(rev=self.model_rev())
                self._tpl_source = "disk"
                return self
            try:
                raw = self._codec.read(self.templates_path)
                self._tpl = Templates.from_bytes(raw, EMBED_DIM)
                self._tpl_source = "disk"
            except FileNotFoundError:
                self._tpl = Templates(rev=self.model_rev())
                self._tpl_source = "disk"
            except Exception as exc:  # noqa: BLE001 - 坏文件不崩，按「没有模板」处理（fail-closed）
                self._tpl = Templates(rev=self.model_rev())
                self._tpl_source = "disk"
                self._load_error = "模板读不出来（%s）" % _clean_exc(exc)
            return self

    def close(self):
        """放掉 onnxruntime 会话（换模型/关开关时调，别让旧 session 占内存）。

        内存模式下盐和模板必须一起失效（否则重开会换一份盐，旧模板算出来全是垃圾）；
        disk 模式盐可以从盘上原样读回，模板保留没影响。
        """
        with self._lock:
            emb = self._embedder
            self._embedder = None
            self._salt = None
            self._loaded = False
            if self.memory_only and self._tpl.people:
                self._tpl = Templates()
                self._needs_reenroll = True
        closer = getattr(emb, "close", None)
        if closer:
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass
        return True

    def reload(self):
        """换模型 / 改了开关之后调用：旧会话必须关掉重建，再按 rev 校验模板。"""
        stub = getattr(self._embedder, "model_path", None) == "stub"
        injected = self._embedder if stub else None
        self.close()
        with self._lock:
            self._embedder = injected          # 测试注入的 stub 不动
            self._salt_broken = False
            self._load_error = ""
        self.load(force=True)
        return self.readiness()

    @staticmethod
    def _clone(tpl):
        """深拷贝一份模板，改完再提交——保存失败时内存状态不会被改坏。"""
        return Templates.from_bytes(tpl.to_bytes(), tpl.dim)

    def _commit(self, draft):
        """把草稿写盘（或写进内存）；成功才替换内存里的模板。-> (ok, err)"""
        with self._lock:
            # rev 只由录入路径设置；删除/负模板更新绝不把旧人声模板重贴为新模型。
            old = self._tpl
            self._tpl = draft
            try:
                self._save()
            except Exception as exc:  # noqa: BLE001
                self._tpl = old
                return False, _clean_exc(exc)
            self._needs_reenroll = False
            return True, ""

    def _save(self):
        with self._lock:
            if self.memory_only or self._tpl_source == "memory":
                return                # L5：只留内存；内存里录的也绝不落盘
            self._codec.write(self.templates_path, self._tpl.to_bytes())

    # -- 模板变换 ------------------------------------------------------
    def _salt_vec(self, vec):
        salt = self._load_salt()
        if salt is None:
            raise SvUnavailable("model-error", "盐不可用")
        return l2norm(np.asarray(vec, dtype=np.float32) @ salt)

    @property
    def salt_broken(self):
        return bool(self._salt_broken)

    # -- 就绪检查（fail-closed 的核心） --------------------------------
    def readiness(self):
        """-> (ok, reason)。任何一项不满足都不许放行。"""
        self.load()
        if self.cfg.get("error") == "config-error":
            return False, "config-error"
        if self._salt_broken:
            return False, "model-error"
        if self._needs_reenroll:
            return False, "re-enroll"
        rev = self.model_rev()
        if not rev:
            return False, "model-missing"
        if not self._tpl.ready:
            return False, "no-enroll"
        if not self._templates_sane():
            return False, "model-error"
        # 换了模型（或模板没记 rev）一律作废：内存模式也一样，不许把旧模板贴上新的 rev
        if not self._tpl.rev or self._tpl.rev != rev:
            return False, "model-rev"
        return True, "ok"

    def _templates_sane(self):
        """内存里的模板也可能是被改过的（NaN/维度/门限越界），用之前再核一遍。"""
        try:
            for p in self._tpl.people:
                v = np.asarray(p["vec"], dtype=np.float64)
                if v.shape != (EMBED_DIM,) or not np.all(np.isfinite(v)):
                    return False
                if float(np.linalg.norm(v)) <= 0:
                    return False
                t = finite01(p.get("tau"), None)
                if t is None or not (0.0 < t <= 1.0):
                    return False
            if self._tpl.self_vec is not None:
                sv = np.asarray(self._tpl.self_vec, dtype=np.float64)
                if sv.shape != (EMBED_DIM,) or not np.all(np.isfinite(sv)):
                    return False
        except Exception:  # noqa: BLE001
            return False
        return True

    # -- embedding -----------------------------------------------------
    def _build_embedder(self):
        rev = self.model_rev()
        if self._embedder is not None and getattr(self._embedder, 'model_path', None) != 'stub' and getattr(self, '_embedder_rev', rev) != rev:
            self._embedder.close()
            self._embedder = None
        if self._embedder is not None:
            return self._embedder
        if not self.model_path or not os.path.isfile(self.model_path):
            raise SvUnavailable("model-missing", "没找到声纹模型")
        self._embedder = OnnxEmbedder(self.model_path, threads=self.threads)
        self._embedder_rev = rev
        return self._embedder

    def warm(self):
        """把模型和模板一次加载好（上层在后台线程里调，别堵 UI）。"""
        try:
            self._build_embedder()
            self.load(force=True)
            return True
        except Exception as exc:  # noqa: BLE001
            self._load_error = str(exc)
            return False

    def embed(self, pcm, rate=SAMPLE_RATE):
        with self._lock:
            self.load()   # 首句录入同样必须先定好盐/模式
            if rate != SAMPLE_RATE:
                raise SvError("声纹只接收 16 kHz PCM")
            emb = self._build_embedder().embed(pcm, rate)
            if np.asarray(emb).shape != (EMBED_DIM,):
                raise SvError("声纹输出必须是 192 维")
            return self._salt_vec(emb)

    # -- 录入 ----------------------------------------------------------
    def enroll(self, name, pcms, rate=SAMPLE_RATE, tau=None, min_pair=0.5):
        """用 3~5 段（建议 5 段）算均值模板；返回 {ok, n, tau, mu, message}，不带音频。"""
        name = str(name or "").strip()[:24]
        if not name:
            return {"ok": False, "message": "名字不能为空"}
        self.load()                      # 先把模式/盐定下来，再算 embedding（否则盐会被换掉）
        vecs = []
        for i, pcm in enumerate(pcms or []):
            if pcm_seconds(pcm, rate) < MIN_SEG_S:
                return {"ok": False, "message": "第 %d 句太短（要 ≥0.6 s）" % (i + 1)}
            if rms(pcm) < MIN_RMS:
                return {"ok": False, "message": "第 %d 句太轻，凑近点再说" % (i + 1)}
            try:
                vecs.append(self.embed(pcm, rate))
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "message": "第 %d 句算不出声纹（%s）" % (i + 1, type(exc).__name__)}
        return self.enroll_vectors(name, vecs, tau=tau, min_pair=min_pair, min_count=3)

    def enrollment_context(self):
        """原生窗口的本次录入令牌（仅进程内，不是 HTTP/agent 数据）。"""
        with self._lock:
            self.load()
            self._load_salt()
            return (self.model_rev(), self._mode_seen, id(self._salt))

    def enroll_vectors(self, name, vecs, tau=None, min_pair=0.5, min_count=5, context=None):
        """本地窗口逐句丢掉 PCM 后提交已加盐向量；默认必须恰好五句。"""
        name = str(name or "").strip()[:24]
        with self._lock:
            self.load()
            if context is not None and context != self.enrollment_context():
                return {"ok": False, "message": "录入中模型或保存方式变了，请重新录入"}
            if not self.cfg['enabled'] or self.cfg.get('error'):
                return {"ok": False, "message": "声纹已关闭或设置不可用"}
            if not name or not self.model_rev() or self._salt_broken:
                return {"ok": False, "message": "名字、模型或盐不可用"}
            if len(vecs) < min_count or len(vecs) > 5:
                return {"ok": False, "message": "请完整录入五句"}
            try:
                vecs = [l2norm(v) for v in vecs]
                if any(v.shape != (EMBED_DIM,) for v in vecs):
                    raise SvError("声纹必须是 192 维")
                if not math.isfinite(float(min_pair)) or not 0.5 <= float(min_pair) <= 1.0:
                    raise SvError("一致性门限不合法")
            except Exception:
                return {"ok": False, "message": "声纹向量或一致性门限不合法"}
        # 留一法：每句跟其余句子的平均相似度，取最低的那句作质检线
        sims = []
        for i in range(len(vecs)):
            others = [cosine(vecs[i], vecs[j]) for j in range(len(vecs)) if j != i]
            sims.append(sum(others) / max(1, len(others)))
        weakest = min(sims)
        mu = sum(sims) / len(sims)
        if weakest < min_pair:
            return {"ok": False, "n": len(vecs), "message": "这几句听起来不太像同一个人（最低 %.2f），重录一次" % weakest}
        tau_auto = max(0.30, min(0.50, mu - 0.20))
        with self._lock:
            self.load()
            try:
                if context is not None and context != self.enrollment_context():
                    raise SvError("录入上下文变了，请重录")
                rev = self.model_rev()
                draft = self._clone(self._tpl) if self._tpl.rev == rev else Templates(rev=rev)
                draft.rev = rev
                draft.put(name, _mean(vecs), len(vecs), tau if tau is not None else tau_auto)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "message": "存不了这个模板：%s" % _clean_exc(exc)}
            ok, err = self._commit(draft)
            if not ok:
                return {"ok": False, "message": "存不下模板：%s" % err}
        return {"ok": True, "name": name, "n": len(vecs), "mu": round(mu, 3), "tau": round(tau_auto, 3)}

    def remove(self, name):
        with self._lock:
            self.load()
            if self._tpl.find(name) < 0:
                return {"ok": False, "message": "没有这个人"}
            draft = self._clone(self._tpl)
            draft.drop(name)
            ok, err = self._commit(draft)
            if not ok:
                return {"ok": False, "message": "写不回去：%s" % err}
        return {"ok": True}

    def clear(self):
        """删掉所有模板。磁盘删不掉必须报失败并保持「有模板」的拒绝状态，不能假成功。

        顺序：先删盘上的密文，删成功了再清内存；删失败就什么都不动（内存里也留着，
        这样重启前后行为一致，不会「界面说清空了、重启又复活」）。
        """
        with self._lock:
            self.load()
            path = self.templates_path
            if self._tpl_source == "disk" and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError as exc:
                    return {"ok": False, "message": "删不掉模板文件：%s" % _clean_exc(exc)}
            self._tpl.clear()
            self._needs_reenroll = False
            if self._salt_broken:
                self._salt_broken = False
                self._salt = None
        return {"ok": True}

    def set_self_template(self, digest, pcms, rate=SAMPLE_RATE):
        """负模板：桌宠自己音色的几句合成语音。换音色（digest 变）就失效。"""
        self.load()                      # 同上：先定模式/盐
        if self._tpl.people and self._tpl.rev != self.model_rev():
            return {"ok": False, "message": "模型已改变，请先重新录入"}
        if not digest:
            return {"ok": False, "message": "音色指纹未知，回声防护未完成"}
        vecs = []
        for pcm in pcms or []:
            try:
                vecs.append(self.embed(pcm, rate))
            except Exception:  # noqa: BLE001
                continue
        if not vecs:
            return {"ok": False, "message": "算不出自己的声纹"}
        with self._lock:
            self.load()
            draft = self._clone(self._tpl)
            draft.self_vec = _mean(vecs)
            draft.self_digest = str(digest or "")
            ok, err = self._commit(draft)
            if not ok:
                return {"ok": False, "message": "存不下负模板：%s" % err}
        return {"ok": True, "n": len(vecs)}

    # -- 负模板状态 ----------------------------------------------------
    def voice_digest(self):
        """当前音色指纹（由上层注入）；没有就返回 None。"""
        g = self.voice_digest_getter
        if not g:
            return None
        try:
            return str(g() or "") or None
        except Exception:  # noqa: BLE001
            return None

    def echo_state(self):
        """'ok' = 负模板在且对得上当前音色；'stale' = 换过音色，旧负模板作废；'missing' = 没准备。

        注意：负模板只拦「桌宠自己声音的回声」，没准备好就是没准备——不许拿 self_sim=0 装算过。
        """
        if self._tpl.self_vec is None:
            return "missing"
        cur = self.voice_digest()
        if self.voice_digest_getter is not None and (not cur or not self._tpl.self_digest):
            return "stale"
        if cur is not None and cur != self._tpl.self_digest:
            return "stale"
        return "ok"

    # -- 查询 ----------------------------------------------------------
    def people(self):
        """**只给用户界面用**：姓名 + 句数。绝不放进 settings 或 agent status。"""
        self.load()
        return [{"name": p["name"], "n": int(p["n"]), "created": float(p["created"])}
                for p in self._tpl.people]

    def status(self):
        """给 agent / 通用状态用：**没有姓名、没有分数、没有槽位、没有向量、没有路径**。"""
        cfg = self.cfg
        if not cfg["enabled"]:
            # 关着就什么都不碰：不加载模型、不建目录、不读模板
            return {"enabled": False, "mode": cfg["mode"], "enrolled": len(self._tpl.people),
                    "ready": False, "reason": "disabled", "encrypted": bool(self._codec.encrypted),
                    "memory": cfg["mode"] == "memory", "echoReady": False, "echo": "missing",
                    "last": self.last, "message": REASONS["disabled"]}
        self.load()
        ok, reason = self.readiness()
        echo = self.echo_state()
        return {
            "enabled": True,
            "mode": cfg["mode"],
            "enrolled": len(self._tpl.people),
            "ready": bool(ok),
            "reason": reason,
            "encrypted": bool(self._codec.encrypted),
            "memory": self.memory_only,
            "echoReady": echo == "ok",
            "echo": echo,
            "last": self.last,
            "message": REASONS.get(reason, reason),
        }

    def summary(self):
        """给 agent / 工具的白名单摘要：只有 enabled / enrolled / 最后结果，别的都不许出去。"""
        st = self.status()
        return {"enabled": bool(st["enabled"]), "enrolled": int(st["enrolled"]),
                "last": st["last"] if st["last"] in ("pass", "reject") else None}

    # -- 判定 ----------------------------------------------------------
    def verify(self, pcm, rate=SAMPLE_RATE, mode="strict"):
        with self._lock:
            return self._verify(pcm, rate, mode)

    def _verify(self, pcm, rate=SAMPLE_RATE, mode="strict"):
        """-> {ok, reason, sim, self_sim, self_ready, slot, mode, ms, echo}

        slot 是内部用的槽位（给设置页「试一下」显示是谁），**不许原样交给 agent**；
        对外的只有 summary() 里的 pass/reject。
        """
        t0 = self.clock()
        out = {"ok": False, "reason": "", "sim": 0.0, "self_sim": None, "self_ready": False,
               "slot": -1, "mode": mode, "ms": 0, "echo": "missing"}
        cfg = self.cfg
        if cfg.get("error"):
            out["reason"] = "config-error"
            return self._record(out, t0)
        if not cfg["enabled"]:
            out.update(ok=True, reason="disabled")
            return out
        try:
            if pcm_seconds(pcm, rate) < MIN_SEG_S:
                out["reason"] = "short"
                return self._record(out, t0)
            if rms(pcm) < MIN_RMS:
                out["reason"] = "quiet"
                return self._record(out, t0)
            ok, reason = self.readiness()
            if not ok:
                out["reason"] = reason
                return self._record(out, t0)
            echo = self.echo_state()
            vec = self.embed(pcm, rate)
            sims = [cosine(vec, p["vec"]) for p in self._tpl.people]
            taus = [p["tau"] for p in self._tpl.people]
            self_ready = echo == "ok"
            self_sim = cosine(vec, self._tpl.self_vec) if self_ready else None
            ok, reason, slot, best = decide(sims, taus, self_sim, self_ready, mode, cfg["strictness"])
            out.update(ok=ok, reason=reason, sim=round(best, 4), slot=slot, echo=echo,
                       self_ready=self_ready,
                       self_sim=None if self_sim is None else round(self_sim, 4))
            return self._record(out, t0)
        except Exception as exc:  # noqa: BLE001 - 算不出来就拒绝，不崩、不放行
            out.update(ok=False, reason=getattr(exc, "reason", "model-error"))
            self._load_error = _clean_exc(exc)
            return self._record(out, t0)

    def _record(self, out, t0):
        out["ms"] = int((self.clock() - t0) * 1000)
        if out.get("reason") != "disabled":
            self.last = "pass" if out["ok"] else "reject"
        if not out["ok"]:
            out.setdefault("message", REASONS.get(out.get("reason"), ""))
        self._last_detail = dict(out)
        return out

    def test_embedding(self, pcm, rate=SAMPLE_RATE):
        """设置页「试一下」：只给分数和槽位（人名由界面自己映射），不给向量。"""
        return self.verify(pcm, rate, mode="strict")


def _mean(vecs):
    arr = np.stack([np.asarray(v, dtype=np.float32) for v in vecs], axis=0)
    return l2norm(arr.mean(axis=0))


def describe(reason):
    return REASONS.get(reason, reason)
