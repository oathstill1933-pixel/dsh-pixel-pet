"""Exercise the shipped assets, loader, runtime receipt, and state matrix."""
import json
import os
import subprocess
import time
import sys
import unittest
from pathlib import Path
from zipfile import ZipFile

from helpers import ROOT, tmpdir

sys.path.insert(0, str(Path(ROOT) / "runtime"))
from pixelpet import packkit
from pixelpet.app import PetApp, load_settings
from pixelpet.character import character_folder, load_character
from pixelpet.state import music_state
from pixelpet.voice.tts import VoiceStore

PLUGIN = Path(ROOT)
PACK_ID = "builtin.claude-girl"


def _build_pack():
    """The pack is a Release asset, not part of the plugin: build it from packs-src (reproducible archive)."""
    done = subprocess.run([sys.executable, "-B", "-X", "utf8", str(PLUGIN / "tools/build_claude_pack.py"), "--out-dir", tmpdir()],
                          capture_output=True, text=True, encoding="utf-8", timeout=120, check=True)
    meta = json.loads(done.stdout.strip().splitlines()[-1])
    return Path(done.args[-1]) / meta["file"]


PACK = _build_pack()


class ClaudePackTests(unittest.TestCase):
    def setUp(self):
        self.data = Path(tmpdir())

    def cli(self, action, *args):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(PLUGIN / "runtime/pack_cli.py"),
             action, "--data-dir", str(self.data), *map(str, args)],
            capture_output=True, encoding="utf-8", check=False, timeout=45,
        )
        self.assertTrue(result.stdout, result.stderr)
        return json.loads(result.stdout)

    def install(self, archive=PACK, root=PLUGIN, enable=True):
        args = ["--enable", 1] if enable else []
        return self.cli("install", "--plugin-root", root, "--pack", archive, *args)

    def test_conflict_with_another_pack_and_builtin(self):
        self.assertTrue(self.install()["ok"])
        other = self.data / "duplicate.petpack"
        with ZipFile(PACK) as orig, ZipFile(other, "w") as out:
            for item in orig.namelist():
                content = orig.read(item)
                if item == "manifest.json":
                    manifest = json.loads(content)
                    manifest["id"] = "example.duplicate"
                    content = json.dumps(manifest)
                out.writestr(item, content)
        self.assertEqual(self.install(other)["code"], "E_ID_CONFLICT")
        fake_root = self.data / "plugin"
        (fake_root / "characters/claude-girl").mkdir(parents=True)
        other_data = self.data / "other"
        self.data = other_data
        self.assertEqual(self.install(other, root=fake_root)["code"], "E_ID_CONFLICT")

    def test_gate_and_character_load(self):
        self.assertTrue(self.install(enable=False)["ok"])
        self.assertIsNone(packkit.resolve_one(PLUGIN, self.data, "character", "claude-girl"))
        reg, _ = packkit.read_registry_lenient(self.data)
        reg["packs"][PACK_ID]["active"]["permissions"] = ["docs.read"]
        reg["packs"][PACK_ID]["wantEnabled"] = True
        self.assertEqual(packkit.packed_characters(self.data, reg), {})
        self.assertTrue(self.cli("grant", "--pack-id", PACK_ID)["ok"])
        item = packkit.resolve_one(PLUGIN, self.data, "character", "claude-girl")
        self.assertEqual(item["base"], "pack")
        character = load_character(character_folder(PLUGIN, self.data, item["id"]))
        self.assertEqual(len(character.frames["headphones-music"]), 16)

    def test_pack_voice_resolves_and_disabling_falls_back(self):
        store = VoiceStore(self.data, PLUGIN)
        self.assertNotIn("claude-girl", [v["id"] for v in store.presets()])
        self.assertTrue(self.install()["ok"])
        voice = store.resolve("claude-girl")
        self.assertEqual(voice["mode"], "icl")
        self.assertEqual(len(voice["anchorSha"]), 64)
        self.assertEqual(Path(voice["ref"]).name, "ref.wav")
        self.assertTrue(Path(voice["anchor"]).is_relative_to((self.data / "packs/store").resolve()))
        self.assertTrue(self.cli("disable", "--pack-id", PACK_ID)["ok"])
        self.assertTrue(store.resolve("claude-girl")["key"].startswith("preset:whale-girl:"))

    def test_preset_cannot_resolve_a_voice_directory_link_outside_the_character(self):
        self.assertTrue(self.install()["ok"])
        store = VoiceStore(self.data, PLUGIN)
        voice = Path(store.resolve("claude-girl")["ref"]).parent
        outside = self.data / "outside-voice"
        voice.rename(outside)
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(outside), str(voice))
        else:
            voice.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(packkit.PackKitError) as cm:
            packkit.read_voice_preset(voice.parent)
        self.assertEqual(cm.exception.code, "E_FIELD_INVALID")
        self.assertTrue(store.resolve("claude-girl")["key"].startswith("preset:whale-girl:"))

    def test_loaded_book_bed_sleep_wake_and_uninstall(self):
        import tkinter as tk
        fid = "claude-book-bed"
        self.assertFalse((PLUGIN / "furniture" / fid).exists())
        self.assertTrue(self.install()["ok"])
        with (self.data / "settings.json").open("w", encoding="utf8") as f:
            json.dump({"character": "whale-girl", "furniture": {fid: {"enabled": True, "x": 132, "y": 452}}}, f)
        try:
            root = tk.Tk()
        except tk.TclError as exc:
            self.skipTest(f"no display: {exc}")
        app = PetApp(root, PLUGIN, data_dir=self.data, offscreen=True, speed=4000.0)
        try:
            self.assertIn(fid, app.furniture)
            self.assertTrue(app.furniture_defs[fid]["_pack"])
            started = app.command({"cmd": "use", "id": fid, "verb": "sleep"})
            self.assertTrue(started[0], started[1])
            deadline = time.monotonic() + 5
            while not app.inside and time.monotonic() < deadline:
                root.update()
                time.sleep(.01)
            self.assertEqual(app.inside[0], fid)
            self.assertIsNotNone(app.furniture[fid].occupant)
            self.assertTrue(app.command({"cmd": "use", "id": fid, "verb": "wake"})[0])
            self.assertIsNone(app.inside)
            removed = self.cli("uninstall", "--pack-id", PACK_ID, "--plugin-root", PLUGIN)
            self.assertTrue(removed["ok"], removed)
            self.assertTrue(app.command({"cmd": "packs", "action": "reload", "generation": removed["generation"]})[0])
            self.assertNotIn(fid, app.furniture_defs)
            self.assertNotIn(fid, app.furniture)
        finally:
            app.quit()

    def test_every_music_transition_for_both_characters(self):
        self.assertTrue(self.install()["ok"])
        for cid, frames in (("claude-girl", 16), ("whale-girl", 24)):
            with self.subTest(character=cid):
                ch = load_character(character_folder(PLUGIN, self.data, cid))
                self.assertEqual(len(ch.frames["headphones-music"]), frames)
                # The role, rather than the state id, selects the animation.
                states = {("custom-" + sid if st.get("role") else sid): st for sid, st in ch.states.items()}
                for playback, voice, role in (
                    ("playing", "idle", "music-listening"), ("playing", "speaking", "music-speaking"),
                    ("paused", "idle", "music-idle"), ("paused", "speaking", "music-speaking"),
                    ("off", "idle", None), ("off", "speaking", None),
                ):
                    desired = music_state(states, voice, playback, voice=voice)
                    if role:
                        self.assertTrue(desired.startswith("custom-"))
                        self.assertEqual(states[desired]["role"], role)
                    else:
                        self.assertEqual(desired, voice)
                self.assertEqual(music_state(states, "idle", "paused", paused_seconds=600), "idle")
                self.assertEqual(music_state(states, "speaking", "paused", voice="speaking", paused_seconds=600), "speaking")
                for state in ("walk-left", "drag-right", "lie", "mood-happy", "running"):
                    self.assertEqual(music_state(states, state, "playing"), state)
                self.assertEqual(music_state(states, "idle", "playing", protected=True), "idle")
                self.assertEqual(music_state({"idle": {}}, "idle", "playing"), "idle")

    def test_runtime_receipt_and_disabling_or_uninstalling_selected_role(self):
        import tkinter as tk
        for action in ("disable", "uninstall"):
            with self.subTest(action=action):
                self.data = Path(tmpdir())
                installed = self.install()
                self.assertTrue(installed["ok"], installed)
                (self.data / "settings.json").write_text(
                    json.dumps({"character": "claude-girl", "listen": {"enabled": True}}), encoding="utf-8")
                try:
                    root = tk.Tk()
                except tk.TclError as exc:
                    self.skipTest(f"no display: {exc}")
                app = PetApp(root, PLUGIN, data_dir=self.data, offscreen=True)
                try:
                    self.assertEqual(app.char.id, "claude-girl")
                    ok, _, _, receipt = app.command({"cmd": "packs", "action": "reload", "generation": installed["generation"]})
                    self.assertTrue(ok)
                    self.assertEqual(receipt["loaded"]["characters"], ["claude-girl"])
                    app.command({"cmd": "music", "state": "playing"})
                    self.assertEqual(app.desired_state(), "headphones-music")
                    args = ["--plugin-root", PLUGIN] if action == "uninstall" else []
                    removed = self.cli(action, "--pack-id", PACK_ID, *args)
                    self.assertTrue(removed["ok"], removed)
                    bubbles = []
                    app.bubble.show = lambda text, seconds: bubbles.append(text)
                    rc = app.command({"cmd": "packs", "action": "reload", "generation": removed["generation"]})
                    self.assertTrue(rc[0], rc)
                    self.assertEqual(app.char.id, "whale-girl")
                    self.assertEqual(load_settings(self.data)["character"], "whale-girl")
                    self.assertEqual(bubbles, ["换回鲸鱼娘了"])
                    self.assertEqual(app.desired_state(), "headphones-music")
                    app.cfg["listen"]["enabled"] = False
                    self.assertEqual(app.desired_state(), "idle")
                finally:
                    app.quit()


if __name__ == "__main__":
    unittest.main()
