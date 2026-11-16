"""Independent security regressions. Synthetic signals only; no real recordings or user data."""
import os
import tempfile
import unittest
from unittest import mock

import helpers  # noqa: F401 - sets the isolated runtime import path
from pixelpet.voice import sv


class DecisionBoundaryTests(unittest.TestCase):
    def assert_refused(self, **kwargs):
        try:
            result = sv.decide(**kwargs)
        except (ValueError, TypeError, sv.SvError):
            return  # explicit input rejection is also fail-closed
        self.assertFalse(result[0], repr(kwargs))

    def test_nonfinite_scores_never_pass(self):
        for mode in ('strict', 'loose'):
            for number in (float('nan'), float('inf'), float('-inf')):
                with self.subTest(mode=mode, number=number):
                    self.assert_refused(sims=[number], taus=[0.4], mode=mode)

    def test_nonfinite_thresholds_never_pass(self):
        for number in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(number=number):
                self.assert_refused(sims=[0.8], taus=[number], mode='strict')

    def test_invalid_self_scores_never_pass_when_ready(self):
        for number in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(number=number):
                self.assert_refused(sims=[0.8], taus=[0.4], self_sim=number,
                                    self_ready=True, mode='strict')

    def test_unknown_mode_does_not_downgrade(self):
        self.assert_refused(sims=[0.8], taus=[0.4], mode='typo')


class MemoryBoundaryTests(unittest.TestCase):
    def build(self, root):
        model = os.path.join(root, 'synthetic-model.bin')
        with open(model, 'wb') as stream:
            stream.write(b'not-an-onnx-model: fixture revision one')
        cfg = {'enabled': True, 'mode': 'memory', 'strictness': 0.5}
        codec = mock.Mock()
        codec.read.side_effect = FileNotFoundError
        codec.write.side_effect = AssertionError('memory mode must not write templates')
        engine = sv.VoicePrint(root, settings_getter=lambda: cfg, model_path=model,
                               embedder=sv.StubEmbedder(), codec=codec)
        signals = [sv.StubEmbedder.pcm(1, seconds=2.2) for _ in range(5)]
        enrolled = engine.enroll('fixture-person', signals)
        self.assertTrue(enrolled['ok'], enrolled)
        return engine, codec, model, signals[0]

    def test_memory_mode_does_not_read_disk_templates_or_salt(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-memory-') as root:
            engine, codec, _, signal = self.build(root)
            self.assertTrue(engine.verify(signal)['ok'])
            codec.read.assert_not_called()
            codec.write.assert_not_called()
            self.assertFalse(os.path.exists(os.path.join(root, 'voiceprint')))

    def test_model_revision_cannot_relabel_existing_memory_templates(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-revision-') as root:
            engine, _, model, signal = self.build(root)
            original_rev = engine._tpl.rev
            with open(model, 'wb') as stream:
                stream.write(b'not-an-onnx-model: different revision two with a changed length')
            engine.load(force=True)
            self.assertEqual(engine._tpl.rev, original_rev)
            verdict = engine.verify(signal)
            self.assertFalse(verdict['ok'], verdict)
            self.assertEqual(verdict['reason'], 'model-rev')


class PortablePermissionsTests(unittest.TestCase):
    def test_private_directory_retains_owner_traversal_permission(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-permissions-') as root:
            codec = sv.Codec(root, use_dpapi=False)
            codec.is_windows = False  # pure branch test, no platform ACL mutation
            with mock.patch.object(sv.os, 'chmod') as chmod:
                self.assertTrue(codec.tighten(root))
                self.assertEqual(chmod.call_args.args[1], 0o700)


class FacadeBoundaryTests(unittest.TestCase):
    def test_config_error_cannot_disable_an_enabled_gate(self):
        from pixelpet.voiceprint_integration import VoicePrintHost

        class Pet:
            broken = False

            @property
            def cfg(self):
                if self.broken:
                    raise OSError('synthetic settings access failure')
                return {'voiceprint': {'enabled': True, 'mode': 'memory', 'strictness': 0.5}}

        pet = Pet()
        host = VoicePrintHost(pet)
        self.assertTrue(host.enabled)
        pet.broken = True
        self.assertTrue(host.enabled, 'wrapper must not turn a broken enabled gate into None')


if __name__ == '__main__':
    unittest.main()
