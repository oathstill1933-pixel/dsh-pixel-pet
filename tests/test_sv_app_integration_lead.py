"""Lead integration tests: synthetic settings and injected engines only; no microphone/user data."""
import json
import os
import tempfile
import types
import unittest
from unittest import mock

import helpers  # noqa: F401
from pixelpet.app import PetApp, load_settings, save_settings
from pixelpet.voiceprint_integration import VoicePrintHost


class AppVoiceprintWiring(unittest.TestCase):
    def test_malformed_settings_reject_without_overwriting_original(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-settings-') as root:
            path = os.path.join(root, 'settings.json')
            for raw in ('{broken', '[1,2,3]'):
                with self.subTest(raw=raw):
                    with open(path, 'w', encoding='utf-8') as stream:
                        stream.write(raw)
                    cfg = load_settings(root)
                    self.assertTrue(cfg.get('_voiceprintConfigError'))
                    gate = VoicePrintHost(types.SimpleNamespace(cfg=cfg))
                    self.assertFalse(gate.verify(b'synthetic not-a-recording')['ok'])
                    save_settings(root, cfg)
                    with open(path, encoding='utf-8') as stream:
                        self.assertEqual(stream.read(), raw)

    def test_first_install_stays_disabled_without_biometric_directory(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-first-') as root:
            cfg = load_settings(root)
            gate = VoicePrintHost(types.SimpleNamespace(cfg=cfg, data_dir=root))
            self.assertFalse(gate.enabled)
            self.assertTrue(gate.verify(b'synthetic')['ok'])
            self.assertFalse(os.path.exists(os.path.join(root, 'voiceprint')))

    def test_make_voice_attaches_facade_and_rejects_before_stt(self):
        with tempfile.TemporaryDirectory(prefix='pp-lead-sv-wire-') as root:
            app = PetApp.__new__(PetApp)
            app.cfg = {}
            app.data_dir = app.pack_root = root
            app.post_ui = lambda fn: None
            app.listener = None
            app.voiceprint = types.SimpleNamespace(
                verify=mock.Mock(return_value={'ok': False, 'reason': 'no-enroll'}),
                summary=lambda: {'enabled': True, 'enrolled': 0, 'last': 'reject'})
            stt = types.SimpleNamespace(name='test', transcribe=mock.Mock())
            tts = types.SimpleNamespace(name='test', close=lambda: None)
            llm = types.SimpleNamespace(name='test', ask=mock.Mock())
            with mock.patch('pixelpet.voice.stt.make_stt', return_value=stt), \
                 mock.patch('pixelpet.voice.tts.make_tts', return_value=tts), \
                 mock.patch('pixelpet.voice.llm.make_llm', return_value=llm):
                bridge = app._make_voice()
            try:
                self.assertIs(bridge.sv, app.voiceprint)
                before = bridge._turn
                out = bridge.hear(b'synthetic', speak=False)
                self.assertTrue(out.get('rejected'))
                self.assertEqual(bridge._turn, before)
                stt.transcribe.assert_not_called()
                llm.ask.assert_not_called()
            finally:
                bridge.close()


if __name__ == '__main__':
    unittest.main()
