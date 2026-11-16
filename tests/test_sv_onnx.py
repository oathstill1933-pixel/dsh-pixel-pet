# -*- coding: utf-8 -*-
"""真实 ONNX 路径的自测：**只用合成信号**（正弦/噪声/静音），不录音、不用人声。

需要真实模型 + onnxruntime：
    set SV_MODEL_PATH=<...>/campplus_sv_zh-cn_16k-common.onnx
没有就 SKIP —— 这时只能说明 stub 路径通，**不能**声称 ORT 路径可用。

覆盖：
  * 模型签名（输入 rank / 输出维度）与我们代码的假设一致
  * fbank → 模型 → 192 维单位向量，且全部有限
  * 同一段信号两次结果一致（确定性）
  * 静音/超短段不崩、不产出 NaN
  * 两段不同合成信号的余弦在 [-1,1] 且有限（不是身份判断，只是数值健全性）
"""
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import numpy as np  # noqa: E402

from pixelpet.voice import sv  # noqa: E402

MODEL = os.environ.get("SV_MODEL_PATH") or ""
if not MODEL:
    cand = os.path.join(os.environ.get("TEMP", ""), "_sv_model", "camppls_check.onnx")
    alt = os.path.join(os.environ.get("TEMP", ""), "_sv_model", "campplus_zh_16k.onnx")
    MODEL = alt if os.path.isfile(alt) else (cand if os.path.isfile(cand) else "")

try:
    import onnxruntime  # noqa: F401
    HAS_ORT = True
except Exception:  # noqa: BLE001
    HAS_ORT = False


def tone(seconds=1.5, freq=320.0, amp=6000.0, rate=16000):
    n = int(seconds * rate)
    t = np.arange(n, dtype=np.float64) / rate
    x = amp * np.sin(2 * math.pi * freq * t) + 0.4 * amp * np.sin(2 * math.pi * 2.3 * freq * t + .4)
    return np.clip(x, -32768, 32767).astype(np.int16)


def noise(seconds=1.5, amp=2500.0, seed=3, rate=16000):
    rng = np.random.RandomState(seed)
    return np.clip(rng.normal(0, amp, int(seconds * rate)), -32768, 32767).astype(np.int16)


@unittest.skipUnless(MODEL and os.path.isfile(MODEL), "没有真实模型（设 SV_MODEL_PATH）——ORT 路径未验证")
@unittest.skipUnless(HAS_ORT, "没有 onnxruntime——ORT 路径未验证")
class RealOnnx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.emb = sv.OnnxEmbedder(MODEL, threads=1)

    def test_model_signature_matches_our_assumption(self):
        inp = self.emb.sess.get_inputs()[0]
        self.assertEqual(len(inp.shape), 3, "CAM++ 输入应为 [N, T, 80]，实际 %s" % (inp.shape,))
        self.assertEqual(int(inp.shape[2]), sv.FEATURE_DIM)
        self.assertEqual(self.emb.input_rank, 3)
        self.assertEqual(str(inp.type), "tensor(float)")

    def test_embedding_is_unit_192_and_finite(self):
        v = self.emb.embed(tone(), 16000)
        self.assertEqual(v.shape, (sv.EMBED_DIM,))
        self.assertTrue(np.all(np.isfinite(v)))
        self.assertAlmostEqual(float(np.linalg.norm(v)), 1.0, places=4)

    def test_deterministic(self):
        a = self.emb.embed(noise(), 16000)
        b = self.emb.embed(noise(), 16000)
        self.assertLess(float(np.max(np.abs(a - b))), 1e-6)

    def test_different_signals_differ(self):
        a = self.emb.embed(tone(), 16000)
        b = self.emb.embed(noise(), 16000)
        c = sv.cosine(a, b)
        self.assertTrue(math.isfinite(c))
        self.assertLessEqual(abs(c), 1.0)
        self.assertLess(c, 0.99)

    def test_silence_and_short_do_not_produce_nan(self):
        v = self.emb.embed(np.zeros(16000, dtype=np.int16), 16000)
        self.assertTrue(np.all(np.isfinite(v)))
        with self.assertRaises(Exception):
            self.emb.embed(np.zeros(800, dtype=np.int16), 16000)

    def test_metadata_declares_cmn_and_dim(self):
        meta = getattr(self.emb, "meta", {}) or {}
        if meta.get("output_dim"):
            self.assertEqual(int(meta["output_dim"]), sv.EMBED_DIM)
        if meta.get("sample_rate"):
            self.assertEqual(int(meta["sample_rate"]), sv.SAMPLE_RATE)
        if meta.get("feature_normalize_type"):
            # 模型自己说是 global-mean（CMN）；我们 features() 默认就做 CMN
            self.assertIn(str(meta["feature_normalize_type"]), ("global-mean", "cmn"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
