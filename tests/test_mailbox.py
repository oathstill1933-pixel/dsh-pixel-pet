"""Mailbox furniture: pack validity, reproducible sprites, flag logic, and the live pet raising the flag."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

from helpers import ROOT, make_character, tmpdir

from pixelpet import mailbox as MB

PACK = os.path.join(ROOT, "furniture", "mailbox")


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def write_state(data, unread, latest=None):
    os.makedirs(os.path.join(data, "mailbox"), exist_ok=True)
    p = MB.state_path(data)
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"unread": unread, "total": unread, "latestUnreadAt": latest}, f)
    st = os.stat(p)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))   # mtime moves even within one tick


class MailboxPack(unittest.TestCase):
    def test_validate_strict(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "runtime", "validate.py"), "--strict", PACK],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("OK", p.stdout)

    def test_manifest_and_license(self):
        with open(os.path.join(PACK, "furniture.json"), encoding="utf-8") as f:
            d = json.load(f)
        self.assertEqual(d["feature"], "mailbox")
        self.assertEqual(set(d["states"]), {"idle", "flag", "open"})
        self.assertEqual([i["verb"] for i in d["interactions"]], ["check"])
        self.assertEqual(d["size"], [144, 168])
        for n in ("LICENSE", "CREDITS.md", "preview.png", os.path.join("tools", "build_sprites.py")):
            self.assertTrue(os.path.isfile(os.path.join(PACK, n)), n)
        with open(os.path.join(PACK, "LICENSE"), encoding="utf-8") as f:
            self.assertIn("Attribution-NonCommercial-ShareAlike 4.0", f.read(200))

    def test_sprites_are_reproducible_on_the_2px_grid(self):
        from PIL import Image
        out = tmpdir()
        subprocess.run([sys.executable, os.path.join(PACK, "tools", "build_sprites.py"), "--out", out],
                       check=True, capture_output=True, timeout=60)
        names = sorted(os.listdir(os.path.join(PACK, "sprites")))
        self.assertEqual(names, ["flag_00.png", "flag_01.png", "idle_00.png", "open_00.png", "open_01.png"])
        for n in names:
            self.assertEqual(sha(os.path.join(out, "sprites", n)), sha(os.path.join(PACK, "sprites", n)), n)
            im = Image.open(os.path.join(PACK, "sprites", n)).convert("RGBA")
            self.assertEqual(im.size, (144, 168))
            small = im.resize((72, 84), Image.NEAREST).resize((144, 168), Image.NEAREST)
            self.assertEqual(small.tobytes(), im.tobytes(), n + " breaks the K=2 grid")
        self.assertEqual(sha(os.path.join(out, "preview.png")), sha(os.path.join(PACK, "preview.png")))
        # the flag really moves between states
        a = Image.open(os.path.join(PACK, "sprites", "idle_00.png"))
        b = Image.open(os.path.join(PACK, "sprites", "flag_00.png"))
        self.assertNotEqual(a.convert("RGBA").tobytes(), b.convert("RGBA").tobytes())


class MailFlagLogic(unittest.TestCase):
    def test_read_state_and_freshness(self):
        d = tmpdir()
        self.assertIsNone(MB.read_state(d))
        write_state(d, 2, "2026-11-10T01:00:00Z")
        self.assertEqual(MB.read_state(d), (2, "2026-11-10T01:00:00Z"))
        self.assertFalse(MB.is_fresh(None, None, 2, "x"))            # first look never waves
        self.assertTrue(MB.is_fresh(0, None, 1, "2026-11-10T01:00:00Z"))
        self.assertTrue(MB.is_fresh(1, "2026-11-10T01:00:00Z", 2, "2026-11-10T02:00:00Z"))
        self.assertFalse(MB.is_fresh(2, "2026-11-10T02:00:00Z", 1, "2026-11-10T02:00:00Z"))
        self.assertFalse(MB.is_fresh(1, "a", 0, None))

    def test_poll_is_mtime_gated(self):
        d = tmpdir()
        f = MB.MailFlag(d)
        self.assertIsNone(f.poll())
        write_state(d, 0)
        self.assertEqual(f.poll(), (0, None, False))
        self.assertIsNone(f.poll())
        write_state(d, 1, "2026-11-10T03:00:00Z")
        self.assertEqual(f.poll(), (1, "2026-11-10T03:00:00Z", True))
        with open(MB.state_path(d), "w", encoding="utf-8") as fh:
            fh.write('{"unread": -1}')
        os.utime(MB.state_path(d), ns=(0, os.stat(MB.state_path(d)).st_mtime_ns + 20_000_000))
        self.assertIsNone(f.poll())
        self.assertEqual(f.unread, 1)                                   # bad file keeps the last flag

    def test_options_and_url(self):
        self.assertEqual(MB.options({})["verb"], "check")
        self.assertEqual(MB.options({"mailbox": {"verb": "peek", "autoWave": "yes"}})["verb"], "peek")
        self.assertTrue(MB.options({"mailbox": {"autoWave": "yes"}})["autoWave"])
        with mock.patch.dict(os.environ, {"PIXELPET_HOST_BASE": "http://127.0.0.1:3080/dsh-pixel-pet"}):
            self.assertEqual(MB.mailbox_url(), "http://127.0.0.1:3080/dsh-pixel-pet/mailbox")
        with mock.patch.dict(os.environ, {"PIXELPET_HOST_BASE": "http://evil.example/x"}):
            self.assertEqual(MB.mailbox_url(), "")
        self.assertFalse(MB.open_window(""))


class LivePetFlag(unittest.TestCase):
    """Real PetApp, off-screen: state.json drives the flag, a fresh letter sends the pet over, click opens."""

    def test_flag_wave_and_click(self):
        import tkinter as tk
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        shutil.copytree(PACK, os.path.join(root_dir, "furniture", "mailbox"))
        data = tmpdir()
        root = tk.Tk()
        app = PetApp(root, root_dir, data_dir=data, character="tester", offscreen=True, speed=4000.0)
        try:
            self.assertIn("mailbox", app.furniture)
            w = app.furniture["mailbox"]
            self.assertEqual(w.base_state, "idle")
            write_state(data, 0)
            app.tick_mail()
            self.assertEqual(w.base_state, "idle")
            write_state(data, 1, "2026-11-10T05:00:00Z")
            r = app.tick_mail()
            self.assertEqual(r, (1, "2026-11-10T05:00:00Z", True))
            self.assertEqual(w.base_state, "flag")
            ok, msg, motion = app.command({"cmd": "use", "id": "mailbox", "verb": "check"})[:3]
            self.assertTrue(ok, msg)
            self.assertIsNotNone(motion)
            self.assertEqual(app.command({"cmd": "status"})[3]["mailUnread"], 1)
            opened = []
            with mock.patch.object(MB, "open_window", lambda url: opened.append(url)):
                app.on_furniture_click("mailbox")
            self.assertEqual(w.temp[0], "open")
            write_state(data, 0)
            app.tick_mail()
            self.assertEqual(w.base_state, "idle")
        finally:
            app.quit()


if __name__ == "__main__":
    unittest.main()
