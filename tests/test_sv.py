# -*- coding: utf-8 -*-
"""声纹验证核心测试：判定逻辑、模板、fail-closed、加密/ACL、越界、不泄露向量。

全部用 **stub embedding + 合成信号**（正弦/噪声），不用任何人声，不读任何真实录音。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

from pixelpet.voice import sv  # noqa: E402


def settings(**kw):
    base = dict(sv.DEFAULT_SETTINGS)
    base.update(kw)
    return lambda: dict(base)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pixelpet-sv-")
        self.model = os.path.join(self.dir, "campplus.fake.onnx")
        with open(self.model, "wb") as f:
            f.write(b"CAM++-revision-A")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def vp(self, **cfg):
        return sv.VoicePrint(self.dir, settings_getter=settings(**cfg), model_path=self.model,
                             embedder=sv.StubEmbedder())

    def enroll(self, vp, name="x", tag=1, n=5, seconds=1.5):
        return vp.enroll(name, [sv.StubEmbedder.pcm(tag, seconds) for _ in range(n)])


class Decide(unittest.TestCase):
    def test_strict_pass(self):
        ok, reason, slot, best = sv.decide([0.62, 0.10], [0.40, 0.40])
        self.assertTrue(ok)
        self.assertEqual(slot, 0)
        self.assertAlmostEqual(best, 0.62)

    def test_strict_reject(self):
        ok, reason, _, _ = sv.decide([0.31], [0.40])
        self.assertFalse(ok)
        self.assertEqual(reason, "strict")

    def test_strictness_slider_shifts_threshold(self):
        # 0.44 在 0.40 门限下过，滑块拉到最严（+0.08 → 0.48）就不过
        self.assertTrue(sv.decide([0.44], [0.40], strictness=0.5)[0])
        self.assertFalse(sv.decide([0.44], [0.40], strictness=1.0)[0])
        self.assertTrue(sv.decide([0.36], [0.40], strictness=0.0)[0])

    def test_margin_against_self(self):
        ok, reason, _, _ = sv.decide([0.60], [0.40], self_sim=0.55, self_ready=True)
        self.assertFalse(ok)
        self.assertEqual(reason, "self-echo")
        self.assertTrue(sv.decide([0.60], [0.40], self_sim=0.10, self_ready=True)[0])

    def test_self_not_ready_does_not_fake_a_score(self):
        # 负模板没就绪：不许拿 self_sim=0 装算过，判定只用 tau，且 self_ready 保持 False
        ok, reason, _, _ = sv.decide([0.60], [0.40], self_sim=None, self_ready=False)
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")

    def test_loose_mode(self):
        self.assertTrue(sv.decide([0.22], [0.40], mode="loose")[0])
        self.assertFalse(sv.decide([0.18], [0.40], mode="loose")[0])
        ok, reason, _, _ = sv.decide([0.30], [0.40], self_sim=0.25, self_ready=True, mode="loose")
        self.assertFalse(ok)
        self.assertEqual(reason, "self-echo")

    def test_no_enroll(self):
        ok, reason, _, _ = sv.decide([], [])
        self.assertFalse(ok)
        self.assertEqual(reason, "no-enroll")


class FailClosed(Base):
    def test_disabled_is_passthrough(self):
        vp = self.vp(enabled=False)
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertTrue(out["ok"])
        self.assertEqual(out["reason"], "disabled")

    def test_enabled_without_enrollment_rejects(self):
        vp = self.vp(enabled=True)
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "no-enroll")
        st = vp.status()
        self.assertTrue(st["enabled"], "开关不能被悄悄改回 false")
        self.assertFalse(st["ready"])

    def test_model_missing_rejects_but_keeps_switch_on(self):
        vp = sv.VoicePrint(self.dir, settings_getter=settings(enabled=True),
                           model_path=os.path.join(self.dir, "nope.onnx"),
                           embedder=sv.StubEmbedder())
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "model-missing")
        self.assertTrue(vp.status()["enabled"])

    def test_short_segment_rejects(self):
        vp = self.vp(enabled=True)
        self.enroll(vp)
        out = vp.verify(sv.StubEmbedder.pcm(1, seconds=0.3), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "short")

    def test_quiet_segment_rejects(self):
        vp = self.vp(enabled=True)
        self.enroll(vp)
        out = vp.verify(sv.StubEmbedder.pcm(1, seconds=1.5, quiet=True), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "quiet")

    def test_model_rev_change_invalidates_templates(self):
        vp = self.vp(enabled=True)
        self.assertTrue(self.enroll(vp)["ok"])
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])
        with open(self.model, "wb") as f:
            f.write(b"CAM++-revision-B")
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "model-rev")

    def test_embed_error_rejects(self):
        class Boom(sv.StubEmbedder):
            def embed(self, pcm, rate=sv.SAMPLE_RATE):
                raise RuntimeError("onnx 炸了")

        # 正常录入之后再让 embedding 挂掉：已录入的人也不许因为算不出来就放行
        vp = self.vp(enabled=True)
        self.assertTrue(self.enroll(vp, "x", tag=1)["ok"])
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])
        vp._embedder = Boom()
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "model-error")


class Enrollment(Base):
    def test_enroll_and_match(self):
        vp = self.vp(enabled=True)
        r = self.enroll(vp, "x", tag=3)
        self.assertTrue(r["ok"])
        self.assertEqual(r["n"], 5)
        self.assertGreaterEqual(r["tau"], 0.30)
        self.assertLessEqual(r["tau"], 0.50)
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(3), 16000)["ok"])

    def test_other_voice_rejected(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=3)
        out = vp.verify(sv.StubEmbedder.pcm(9), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "strict")

    def test_multi_person_any_match(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "a", tag=1)
        self.enroll(vp, "b", tag=2)
        self.assertEqual(len(vp.people()), 2)
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(2), 16000)["ok"])
        self.assertFalse(vp.verify(sv.StubEmbedder.pcm(5), 16000)["ok"])

    def test_max_five_people(self):
        vp = self.vp(enabled=True)
        for i in range(5):
            self.assertTrue(self.enroll(vp, "p%d" % i, tag=i + 1)["ok"])
        six = vp.enroll("p6", [sv.StubEmbedder.pcm(7) for _ in range(3)])
        self.assertFalse(six["ok"])

    def test_inconsistent_voices_refused(self):
        vp = self.vp(enabled=True)
        pcms = [sv.StubEmbedder.pcm(1), sv.StubEmbedder.pcm(2), sv.StubEmbedder.pcm(3)]
        r = vp.enroll("x", pcms)
        self.assertFalse(r["ok"])
        self.assertIn("同一个人", r["message"])

    def test_too_few_sentences(self):
        vp = self.vp(enabled=True)
        self.assertFalse(vp.enroll("x", [sv.StubEmbedder.pcm(1), sv.StubEmbedder.pcm(1)])["ok"])

    def test_reenroll_overwrites(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        self.enroll(vp, "x", tag=4)
        self.assertEqual(len(vp.people()), 1)
        self.assertTrue(vp.verify(sv.StubEmbedder.pcm(4), 16000)["ok"])
        self.assertFalse(vp.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])

    def test_remove_and_clear(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "a", tag=1)
        self.enroll(vp, "b", tag=2)
        self.assertTrue(vp.remove("a")["ok"])
        self.assertEqual(len(vp.people()), 1)
        self.assertFalse(vp.remove("nobody")["ok"])
        vp.clear()
        self.assertEqual(len(vp.people()), 0)
        self.assertEqual(vp.verify(sv.StubEmbedder.pcm(2), 16000)["reason"], "no-enroll")

    def test_self_template_and_digest(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        r = vp.set_self_template("tts-digest-1", [sv.StubEmbedder.pcm(8) for _ in range(3)])
        self.assertTrue(r["ok"])
        self.assertTrue(vp.status()["echoReady"])
        out = vp.verify(sv.StubEmbedder.pcm(8), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "self-echo")
        self.assertTrue(out["self_ready"])

    def test_self_template_invalidated_by_voice_change(self):
        """换音色（digest 变）后，旧负模板不许继续参与判定。"""
        voice = {"digest": "tts-A"}
        vp = sv.VoicePrint(self.dir, settings_getter=settings(enabled=True), model_path=self.model,
                           embedder=sv.StubEmbedder(), voice_digest_getter=lambda: voice["digest"])
        self.enroll(vp, "x", tag=1)
        self.assertTrue(vp.set_self_template("tts-A", [sv.StubEmbedder.pcm(8) for _ in range(3)])["ok"])
        self.assertEqual(vp.echo_state(), "ok")
        self.assertEqual(vp.verify(sv.StubEmbedder.pcm(8), 16000)["reason"], "self-echo")

        voice["digest"] = "tts-B"                      # 用户换了音色
        self.assertEqual(vp.echo_state(), "stale")
        st = vp.status()
        self.assertFalse(st["echoReady"])
        self.assertEqual(st["echo"], "stale")
        out = vp.verify(sv.StubEmbedder.pcm(8), 16000)
        self.assertFalse(out["ok"], "换音色后不许拿旧负模板判 self-echo，也不许悄悄放行")
        self.assertFalse(out["self_ready"])
        self.assertIsNone(out["self_sim"])
        self.assertEqual(out["reason"], "strict")

    def test_self_missing_reported_honestly(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        st = vp.status()
        self.assertFalse(st["echoReady"])
        self.assertEqual(st["echo"], "missing")
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertTrue(out["ok"])
        self.assertFalse(out["self_ready"], "没算负模板就不能声称回声防护已完成")
        self.assertIsNone(out["self_sim"])

    def test_reload_rebuilds_and_keeps_rev_check(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        ok, reason = vp.reload()
        self.assertTrue(ok, reason)
        with open(self.model, "wb") as f:
            f.write(b"CAM++-revision-B")
        ok, reason = vp.reload()
        self.assertFalse(ok)
        self.assertEqual(reason, "model-rev")


class Storage(Base):
    def test_encrypted_on_windows_and_no_plaintext(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "秘密名字", tag=1)
        self.assertTrue(vp.status()["encrypted"])
        with open(vp.templates_path, "rb") as f:
            raw = f.read()
        self.assertFalse(raw.startswith(sv.MAGIC_TEMPLATES), "模板文件不能是明文")
        self.assertNotIn("秘密名字".encode("utf-8"), raw, "名字不能以明文出现")
        self.assertNotIn(b"PYVPTMPL1", raw)
        # 能读回来
        vp2 = sv.VoicePrint(self.dir, settings_getter=settings(enabled=True), model_path=self.model,
                            embedder=sv.StubEmbedder())
        self.assertEqual(len(vp2.people()), 1)
        self.assertTrue(vp2.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])

    def test_acl_tightened(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        self.assertTrue(vp._codec.acl_ok, "ACL 应该收紧成功：%s" % vp._codec.errors)
        if os.name == "nt":
            # 回读 DACL：继承必须真的被摘掉（SE_DACL_PROTECTED），不能只看调用返回
            self.assertTrue(sv._dacl_protected(vp.templates_path), "模板文件的 DACL 没摘掉继承")
            self.assertTrue(sv._dacl_protected(vp.ortho_path))
            self.assertTrue(sv._dacl_protected(os.path.join(self.dir, "voiceprint")))

    def test_acl_uses_real_sid(self):
        if os.name != "nt":
            self.skipTest("只在 Windows 上验证")
        sid = sv._current_user_sid()
        self.assertTrue(sid.startswith(b"\x01"), "SID 应该以修订号 1 开头")
        self.assertGreater(len(sid), 8)

    def test_refuses_plaintext_write_on_windows(self):
        if os.name != "nt":
            self.skipTest("只在 Windows 上验证")
        vp = self.vp(enabled=True)
        vp._codec.want_dpapi = False
        r = self.enroll(vp, "x", tag=1)
        self.assertFalse(r["ok"])
        self.assertFalse(os.path.exists(vp.templates_path), "拒绝写明文时不能留下文件")

    def test_dpapi_failure_leaves_no_file(self):
        vp = self.vp(enabled=True)

        def boom(_plain):
            raise sv.SvError("DPAPI 模拟失败")

        orig = vp._codec.protect
        vp._codec.protect = boom
        try:
            r = self.enroll(vp, "x", tag=1)
        finally:
            vp._codec.protect = orig
        self.assertFalse(r["ok"])
        self.assertFalse(os.path.exists(vp.templates_path))

    def test_acl_failure_blocks_save_and_cleans_temp(self):
        """ACL 收不紧就不发布：不落最终文件、临时密文也要清掉。"""
        vp = self.vp(enabled=True)
        vp._codec.tighten = lambda path: False
        r = self.enroll(vp, "x", tag=1)
        self.assertFalse(r["ok"], "ACL 失败时必须拒绝保存")
        self.assertFalse(os.path.exists(vp.templates_path))
        leftovers = [n for n in os.listdir(os.path.join(self.dir, "voiceprint"))
                     if n.endswith(".tmp")] if os.path.isdir(os.path.join(self.dir, "voiceprint")) else []
        self.assertEqual(leftovers, [], "临时密文必须清理干净")

    def test_memory_only_mode_writes_nothing(self):
        vp = self.vp(enabled=True, mode="memory")
        self.assertTrue(self.enroll(vp, "x", tag=1)["ok"])
        self.assertTrue(vp.status()["memory"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "voiceprint")),
                         "仅本次运行模式不许落盘")
        # 重启（新对象）就没了 → 必须判 no-enroll
        vp2 = sv.VoicePrint(self.dir, settings_getter=settings(enabled=True), model_path=self.model,
                            embedder=sv.StubEmbedder())
        self.assertEqual(vp2.verify(sv.StubEmbedder.pcm(1), 16000)["reason"], "no-enroll")

    def test_corrupt_templates_fail_closed(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        with open(vp.templates_path, "wb") as f:
            f.write(b"garbage")
        vp2 = sv.VoicePrint(self.dir, settings_getter=settings(enabled=True), model_path=self.model,
                            embedder=sv.StubEmbedder())
        out = vp2.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "no-enroll")

    def test_orthogonal_salt_preserves_cosine_but_not_values(self):
        r = sv.orthogonal(sv.EMBED_DIM, seed=7)
        self.assertTrue(np.allclose(r @ r.T, np.eye(sv.EMBED_DIM), atol=1e-4))
        a = np.random.RandomState(1).normal(0, 1, sv.EMBED_DIM).astype(np.float32)
        b = np.random.RandomState(2).normal(0, 1, sv.EMBED_DIM).astype(np.float32)
        self.assertAlmostEqual(sv.cosine(a, b), sv.cosine(a @ r, b @ r), places=4)
        self.assertLess(sv.cosine(a, a @ r), 0.999)

    def test_stored_vector_is_salted(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        raw = sv.StubEmbedder().prototype(1)
        stored = vp._tpl.people[0]["vec"]
        self.assertLess(sv.cosine(raw, stored), 0.999, "落盘向量应是加盐后的，不是原始 embedding")


class NoLeak(Base):
    def test_status_has_no_names_or_vectors(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "小明", tag=1)
        st = vp.status()
        blob = json.dumps(st, ensure_ascii=False)
        self.assertNotIn("小明", blob)
        self.assertNotIn("vec", blob)
        self.assertEqual(set(st.keys()), {"enabled", "mode", "enrolled", "ready", "reason",
                                          "encrypted", "memory", "echoReady", "echo", "last", "message"})
        self.assertEqual(st["enrolled"], 1)

    def test_verify_has_no_names_or_vectors(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "小明", tag=1)
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertEqual(set(out.keys()), {"ok", "reason", "sim", "self_sim", "self_ready", "slot",
                                           "mode", "ms", "echo"})
        blob = json.dumps(out, ensure_ascii=False)
        self.assertNotIn("小明", blob)
        self.assertNotIn("vec", blob)
        self.assertIsInstance(out["sim"], float)

    def test_people_only_for_ui(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "小明", tag=1)
        self.assertEqual(vp.people()[0]["name"], "小明")


class Robustness(Base):
    def test_weird_inputs_do_not_crash(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        for pcm in (b"", b"\x01", b"\x00" * 32000, np.zeros(16000, dtype=np.float32),
                    np.ones(40000, dtype=np.int16) * 32767):
            out = vp.verify(pcm, 16000)
            self.assertIsInstance(out["ok"], bool)

    def test_bad_settings_do_not_crash(self):
        # 设置读不到 → sticky fail-closed（当作「开着但不可用」），绝不当成关闭放行
        vp = sv.VoicePrint(self.dir, settings_getter=lambda: "not a dict", model_path=self.model,
                           embedder=sv.StubEmbedder())
        self.assertTrue(vp.enabled)
        self.assertEqual(vp.cfg.get("error"), "config-error")
        out = vp.verify(sv.StubEmbedder.pcm(1), 16000)
        self.assertFalse(out["ok"], "设置坏了必须拒绝，不能当没开声纹")
        self.assertEqual(out["reason"], "config-error")
        vp2 = sv.VoicePrint(self.dir, settings_getter=lambda: {"enabled": True, "strictness": "x"},
                            model_path=self.model, embedder=sv.StubEmbedder())
        self.assertEqual(vp2.cfg["strictness"], 0.5)

    def test_rapid_verify_no_state_leak(self):
        vp = self.vp(enabled=True)
        self.enroll(vp, "x", tag=1)
        for _ in range(50):
            self.assertTrue(vp.verify(sv.StubEmbedder.pcm(1), 16000)["ok"])
            self.assertFalse(vp.verify(sv.StubEmbedder.pcm(6), 16000)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
