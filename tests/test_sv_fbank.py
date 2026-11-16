# -*- coding: utf-8 -*-
"""fbank 与 kaldi 的数值一致性（parity）测试 + CMN 自洽性测试。

对齐对象是 **kaldi_native_fbank**——sherpa-onnx 内部算特征用的就是它，也就是 CAM++ 真实前处理
的那一套参数（25 ms/10 ms、povey、preemph 0.97、去直流、mel 80、20 Hz..Nyquist、n_fft 512、
snip_edges、log）。输入一律是**合成信号**（正弦/噪声），不用任何人声、不读任何用户音频。

约定：kaldi_native_fbank 装在临时目录（`pip install --target`），用环境变量指过去：
    KNF_PATH=%TEMP%\\_knf311  python tests/test_sv_fbank.py
没设或没装就 SKIP（并明确说明"未对齐、不得声称可用"）。
"""
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

try:
    import numpy as np
except Exception:  # noqa: BLE001
    np = None

from pixelpet.voice import sv  # noqa: E402

KNF_PATH = os.environ.get("KNF_PATH") or ""
if KNF_PATH and KNF_PATH not in sys.path:
    sys.path.insert(0, KNF_PATH)
try:
    import kaldi_native_fbank as knf
except Exception:  # noqa: BLE001
    knf = None


def tone(seconds=1.0, freq=440.0, rate=16000, amp=6000.0, seed=0):
    n = int(seconds * rate)
    t = np.arange(n, dtype=np.float64) / rate
    x = amp * np.sin(2 * math.pi * freq * t)
    x += 0.3 * amp * np.sin(2 * math.pi * 3 * freq * t + 0.7)
    return np.clip(x, -32768, 32767).astype(np.int16)


def noise(seconds=1.0, rate=16000, amp=3000.0, seed=7):
    rng = np.random.RandomState(seed)
    return np.clip(rng.normal(0, amp, int(seconds * rate)), -32768, 32767).astype(np.int16)


def mixed(seconds=1.2, rate=16000):
    """正弦 + 噪声 + 静音段：把帧边界/能量范围都覆盖到。"""
    a = tone(seconds / 2, 300, rate, 5000).astype(np.float64)
    b = noise(seconds / 2, rate, 1200, seed=3).astype(np.float64)
    b[: 800] = 0.0
    return np.clip(np.concatenate([a, b]), -32768, 32767).astype(np.int16)


def kaldi_fbank(x_int16, rate=16000, dim=80):
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = rate
    opts.frame_opts.dither = 0.0
    opts.frame_opts.preemph_coeff = 0.97
    opts.frame_opts.remove_dc_offset = True
    opts.frame_opts.window_type = "povey"
    opts.frame_opts.round_to_power_of_two = True
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = dim
    opts.mel_opts.low_freq = 20.0
    opts.mel_opts.high_freq = 0.0
    opts.use_energy = False
    fb = knf.OnlineFbank(opts)
    # kaldi 约定：样本值保持在 int16 数值域（sherpa-onnx 用 normalize_samples 把 [-1,1] 乘回 32768）
    fb.accept_waveform(rate, [float(v) for v in x_int16])
    fb.input_finished()
    return np.stack([np.asarray(fb.get_frame(i), dtype=np.float32)
                     for i in range(fb.num_frames_ready)])


@unittest.skipIf(knf is None, "没有 kaldi_native_fbank（设 KNF_PATH 指向临时安装目录）——fbank 未对齐，不得声称可用")
class FbankParity(unittest.TestCase):
    def compare(self, x, label, tol=1e-3):
        mine = sv.fbank(x)
        ref = kaldi_fbank(x)
        self.assertEqual(mine.shape, ref.shape, "%s 帧数/维度不一致" % label)
        diff = float(np.max(np.abs(mine.astype(np.float64) - ref.astype(np.float64))))
        print("  [%s] 帧=%d 维=%d  max-abs-diff=%.3e" % (label, mine.shape[0], mine.shape[1], diff))
        self.assertLess(diff, tol, "%s 与 kaldi 不一致：%.3e" % (label, diff))
        return diff

    def test_tone(self):
        self.compare(tone(), "440Hz 正弦")

    def test_noise(self):
        self.compare(noise(), "白噪声")

    def test_mixed_silence(self):
        self.compare(mixed(), "正弦+噪声+静音")

    def test_short_input_zero_frames(self):
        x = tone(seconds=0.01)
        self.assertEqual(sv.fbank(x).shape[0], 0)

    def test_seconds_rounding(self):
        # 1.0 s @16k -> 98 帧（kaldi snip_edges：1+(16000-400)//160）
        self.assertEqual(sv.fbank(tone(1.0)).shape[0], 98)


class CmnAndHelpers(unittest.TestCase):
    def test_cmn_mean_zero(self):
        f = sv.features(tone())
        self.assertLess(float(np.max(np.abs(f.mean(axis=0)))), 1e-5)

    def test_frames_are_finite(self):
        f = sv.fbank(noise())
        self.assertTrue(np.all(np.isfinite(f)))

    def test_rms_and_seconds(self):
        self.assertAlmostEqual(sv.rms(tone(1.0, amp=1000)), 1000 * math.sqrt(0.5) * math.sqrt(1 + 0.09),
                               delta=40)
        self.assertAlmostEqual(sv.pcm_seconds(tone(seconds=2.0)), 2.0, delta=0.01)

    def test_pcm_float_input(self):
        x = tone()[: 16000]
        a = sv.fbank(x)
        b = sv.fbank(x.astype(np.float32) / 32768.0)
        self.assertEqual(a.shape, b.shape)
        self.assertLess(float(np.max(np.abs(a - b))), 1e-4)


if __name__ == "__main__":
    if knf is None:
        print("!! 没有 kaldi_native_fbank：parity 用例会 skip——此时 **不能** 声称 fbank 已对齐")
    unittest.main(verbosity=2)
