"""User layer ("再编辑"/已装用户包) wins over the built-in copy at runtime.

Everything here runs on synthetic packs in temp dirs; no plugin file is read as data.
"""
import json
import os
import unittest

from helpers import make_character, make_furniture, tmpdir

from pixelpet.app import PetApp
from pixelpet.character import character_folder, load_character
from pixelpet.furniture import load_furniture


class CharacterFolder(unittest.TestCase):
    def setUp(self):
        self.plugin = tmpdir()
        self.data = tmpdir()
        make_character(self.plugin, "whale-girl")

    def test_user_copy_overrides_the_builtin_one(self):
        make_character(self.data, "whale-girl", extra=lambda d: d.update(name="改过的"))
        folder = character_folder(self.plugin, self.data, "whale-girl")
        self.assertEqual(folder, os.path.join(self.data, "characters", "whale-girl"))
        self.assertEqual(load_character(folder).name, "改过的")

    def test_broken_user_copy_falls_back_to_the_builtin(self):
        bad = os.path.join(self.data, "characters", "whale-girl")
        os.makedirs(bad)
        with open(os.path.join(bad, "character.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "whale-girl", "name": "broken"}, f)  # no states: not a complete pack
        folder = character_folder(self.plugin, self.data, "whale-girl")
        self.assertEqual(folder, os.path.join(self.plugin, "characters", "whale-girl"))

    def test_user_only_pack_is_used(self):
        make_character(self.data, "user-cat")
        self.assertEqual(character_folder(self.plugin, self.data, "user-cat"),
                         os.path.join(self.data, "characters", "user-cat"))
        self.assertEqual(PetApp._first_runnable(self.plugin, self.data), "whale-girl")
        # no built-in packs at all: a runnable user pack is the one to start
        empty = tmpdir()
        self.assertEqual(PetApp._first_runnable(empty, self.data), "user-cat")


class FurnitureLayers(unittest.TestCase):
    def setUp(self):
        self.plugin = tmpdir()
        self.data = tmpdir()

    def test_user_copy_of_a_builtin_piece_wins(self):
        make_furniture(self.plugin, "nest", extra=lambda d: d.update(name="内置窝", order=10))
        make_furniture(self.data, "nest", extra=lambda d: d.update(name="我改的窝", floorY=40))
        defs, errors = load_furniture(self.plugin, with_images=False, user_root=self.data)
        self.assertEqual(defs["nest"]["name"], "我改的窝")
        self.assertTrue(defs["nest"]["_user"])
        self.assertEqual(defs["nest"]["floorY"], 40)
        self.assertEqual(errors, {})

    def test_user_only_piece_is_added_and_order_is_kept(self):
        make_furniture(self.plugin, "nest", extra=lambda d: d.update(order=10))
        make_furniture(self.data, "mine", extra=lambda d: d.update(order=30))
        defs, _ = load_furniture(self.plugin, with_images=False, user_root=self.data)
        self.assertEqual(list(defs), ["nest", "mine"])
        self.assertFalse(defs["nest"]["_user"])
        self.assertTrue(defs["mine"]["_user"])

    def test_a_broken_user_copy_does_not_hide_the_builtin(self):
        make_furniture(self.plugin, "nest", extra=lambda d: d.update(name="内置窝"))
        bad = os.path.join(self.data, "furniture", "nest")
        os.makedirs(bad)
        with open(os.path.join(bad, "furniture.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "nest", "name": "bad"}, f)
        defs, errors = load_furniture(self.plugin, with_images=False, user_root=self.data)
        self.assertEqual(defs["nest"]["name"], "内置窝")
        self.assertEqual(errors, {})  # the broken edit falls back quietly, it must not hide the piece


if __name__ == "__main__":
    unittest.main()
