"""Independent runtime overlay checks; synthetic packs/new data only, no user's installed packs."""
import json
import os
import tempfile
import tkinter as tk
import types
import unittest

from helpers import make_character, make_furniture
from pixelpet.app import PetApp
from pixelpet.furniture import load_furniture


def rename_manifest(data, label):
    data['name'] = label


class OverlayBoundaryTests(unittest.TestCase):
    def test_runtime_character_uses_user_layer_without_mutating_base(self):
        with tempfile.TemporaryDirectory(prefix='pixelpet-reedit-overlay-lead-') as root:
            base, data = os.path.join(root, 'base'), os.path.join(root, 'data')
            source = make_character(base, extra=lambda x: rename_manifest(x, 'Fixture Base'))
            make_character(data, extra=lambda x: rename_manifest(x, 'Fixture User'))
            manifest = os.path.join(source, 'character.json')
            with open(manifest, 'rb') as stream:
                before = stream.read()
            voice = types.SimpleNamespace(state='idle', tts=types.SimpleNamespace(name='stub'),
                configure_interrupt=lambda *_: None, set_barge_listening=lambda *_: None,
                close=lambda: None, status=lambda: {'state': 'idle'})
            window = tk.Tk()
            app = None
            try:
                app = PetApp(window, base, data_dir=data, character='tester', offscreen=True, voice=voice)
                self.assertEqual(app.char.name, 'Fixture User')
            finally:
                if app is not None:
                    app.quit()
                else:
                    window.destroy()
            with open(manifest, 'rb') as stream:
                self.assertEqual(stream.read(), before)

    def test_runtime_furniture_uses_user_layer(self):
        with tempfile.TemporaryDirectory(prefix='pixelpet-reedit-overlay-lead-') as root:
            base, data = os.path.join(root, 'base'), os.path.join(root, 'data')
            source = make_furniture(base, extra=lambda x: rename_manifest(x, 'Fixture Base'))
            make_furniture(data, extra=lambda x: rename_manifest(x, 'Fixture User'))
            defs, errors = load_furniture(base, with_images=False, user_root=data)
            self.assertFalse(errors)
            self.assertEqual(defs['box']['name'], 'Fixture User')
            self.assertTrue(defs['box']['_user'])
            with open(os.path.join(source, 'furniture.json'), encoding='utf-8') as stream:
                self.assertEqual(json.load(stream)['name'], 'Fixture Base')

    def test_runtime_furniture_without_user_layer_restores_base(self):
        with tempfile.TemporaryDirectory(prefix='pixelpet-reedit-overlay-lead-') as root:
            base, data = os.path.join(root, 'base'), os.path.join(root, 'data')
            make_furniture(base, extra=lambda x: rename_manifest(x, 'Fixture Base'))
            os.makedirs(data)
            defs, errors = load_furniture(base, with_images=False, user_root=data)
            self.assertFalse(errors)
            self.assertEqual(defs['box']['name'], 'Fixture Base')
            self.assertFalse(defs['box']['_user'])


if __name__ == '__main__':
    unittest.main()
