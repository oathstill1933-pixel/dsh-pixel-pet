"""Bookshelf (「一起看书」入口占位家具): pack validity, reproducible sprites + pack avatar, the settings gate,
the beside interaction, and click -> ReadingHost.open() with graceful fallback."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock
from zipfile import ZipFile

from helpers import ROOT, make_character, tmpdir

from pixelpet import bookshelf as BS
from pixelpet.furniture import gate_open, is_enabled, summary, sync_sig

PACK = os.path.join(ROOT, "furniture", "bookshelf")
AVATAR = os.path.join(ROOT, "web", "packs", "reading.png")


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def manifest():
    with open(os.path.join(PACK, "furniture.json"), encoding="utf-8") as f:
        return json.load(f)


def write_settings(data, **kw):
    os.makedirs(data, exist_ok=True)
    p = os.path.join(data, "settings.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(kw, f)
    st = os.stat(p)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))


class BookshelfPack(unittest.TestCase):
    def test_validate_strict(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "runtime", "validate.py"), "--strict", PACK],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("OK", p.stdout)

    def test_manifest(self):
        d = manifest()
        self.assertEqual(d["id"], "bookshelf")
        self.assertIs(d["defaultEnabled"], False)
        self.assertEqual(d["feature"], "reading")
        self.assertEqual(d["idle"], "idle")
        self.assertEqual(BS.options(d)["openState"], "read")
        self.assertIn("read", d["states"])
        w, h = d["size"]
        self.assertEqual((w % 2, h % 2), (0, 0))
        self.assertTrue(0 < d["floorY"] <= h)
        self.assertLess(d["stand"]["left"], 0)
        self.assertGreater(d["stand"]["right"], w)
        inters = d["interactions"]
        self.assertEqual([i["verb"] for i in inters], ["browse"])
        it = inters[0]
        self.assertEqual(it["mode"], "beside")
        self.assertEqual(it["pose"], "review")            # every built-in character has it
        self.assertIn(it["furnitureState"], d["states"])
        self.assertTrue(500 <= it["holdMs"] <= 10000)
        self.assertLessEqual(len(it["say"]), 12)
        # Claude娘 拓展包是 Release 附件，不在插件目录里：从 packs-src 现场构建（tools/build_claude_pack.py，可复现）
        out = tmpdir()
        built = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_claude_pack.py"), "--out-dir", out],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        pack_file = os.path.join(out, json.loads(built.stdout.strip().splitlines()[-1])["file"])
        with ZipFile(pack_file) as archive:
            data = json.loads(archive.read("characters/claude-girl/character.json"))
            self.assertIn("review", data["states"], "claude-girl")
        # demo-cat 是私有 demo（不发布）：在才比对，不在也不影响干净克隆
        for cid in [c for c in ("whale-girl", "demo-cat") if os.path.isdir(os.path.join(ROOT, "characters", c))]:
            with open(os.path.join(ROOT, "characters", cid, "character.json"), encoding="utf-8") as f:
                self.assertIn("review", json.load(f)["states"], cid)
        for fn in ("CREDITS.md", "LICENSE", "preview.png", os.path.join("tools", "build_sprites.py")):
            self.assertTrue(os.path.isfile(os.path.join(PACK, fn)), fn)

    # 素材源不随仓库发布：设环境变量 BOOKSHELF_ART_SRC / PACK_COVERS_SRC 才跑「重导比对」，没设就跳过
    ART_SRC = os.environ.get("BOOKSHELF_ART_SRC", "")

    def test_sprites_come_from_the_art_import(self):
        # 2026-11-15：占位的代码绘制帧换成正式美术（tools/import_art_v2.py：不缩放、16 帧同一裁剪框）
        from PIL import Image
        d = manifest()
        self.assertEqual(len(d["states"]["read"]["frames"]), 16)
        self.assertIs(d["states"]["read"]["loop"], False)          # 抽书播一次，停在最后一帧
        for st in d["states"].values():
            for rel in st["frames"]:
                im = Image.open(os.path.join(PACK, rel))
                self.assertEqual((im.mode, list(im.size)), ("RGBA", d["size"]), rel)
        idle = Image.open(os.path.join(PACK, "sprites", "idle_00.png"))
        self.assertEqual(idle.tobytes(), Image.open(os.path.join(PACK, "sprites", "read_00.png")).tobytes())
        self.assertNotEqual(idle.tobytes(), Image.open(os.path.join(PACK, "sprites", "read_15.png")).tobytes())
        if not self.ART_SRC or not os.path.isdir(self.ART_SRC):
            self.skipTest("没设 BOOKSHELF_ART_SRC（美术源目录），跳过重导比对")
        work = tmpdir()
        copy = os.path.join(work, "bookshelf")
        shutil.copytree(PACK, copy)
        env = dict(os.environ, BOOKSHELF_BASE=copy, BOOKSHELF_ART_SRC=self.ART_SRC)
        p = subprocess.run([sys.executable, os.path.join(PACK, "tools", "import_art_v2.py")], env=env,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for st in d["states"].values():
            for rel in st["frames"]:
                self.assertEqual(sha(os.path.join(copy, rel)), sha(os.path.join(PACK, rel)), rel)

    COVERS_SRC = os.environ.get("PACK_COVERS_SRC", "")

    def test_pack_avatars_come_from_the_cover_art(self):
        # 2026-11-15：拓展包头像换成正式封面（tools/import_pack_avatars.py，168×168），不再由 build_sprites.py 画
        from PIL import Image
        for name in ("listen", "reading", "calendar"):
            a = Image.open(os.path.join(ROOT, "web", "packs", name + ".png"))
            self.assertEqual((a.mode, a.size), ("RGBA", (168, 168)), name)
        if not self.COVERS_SRC or not os.path.isdir(self.COVERS_SRC):
            self.skipTest("没设 PACK_COVERS_SRC（封面素材目录），跳过重导比对")
        out = tmpdir()
        env = dict(os.environ, PACK_COVERS_SRC=self.COVERS_SRC, PACK_AVATARS_OUT=out)
        p = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "import_pack_avatars.py")], env=env,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for name in ("listen", "reading", "calendar"):
            self.assertEqual(sha(os.path.join(out, name + ".png")), sha(os.path.join(ROOT, "web", "packs", name + ".png")), name)


class ReadingGate(unittest.TestCase):
    def test_gate_follows_settings_reading_enabled(self):
        d = manifest()
        on = {"bookshelf": {"enabled": True}}
        self.assertTrue(gate_open(d, None))                       # no settings given -> old behaviour
        self.assertFalse(gate_open(d, {}))
        self.assertFalse(gate_open(d, {"reading": {"enabled": "yes"}}))
        self.assertTrue(gate_open(d, {"reading": {"enabled": True}}))
        self.assertTrue(gate_open({"feature": "mailbox"}, {}))   # other features are not gated
        self.assertFalse(is_enabled(d, {}, {"reading": {"enabled": True}}))     # defaultEnabled false
        self.assertFalse(is_enabled(d, on, {"reading": {"enabled": False}}))
        self.assertTrue(is_enabled(d, on, {"reading": {"enabled": True}}))
        self.assertNotEqual(sync_sig(on, {}), sync_sig(on, {"reading": {"enabled": True}}))
        self.assertEqual(sync_sig(on, {"x": 1}), sync_sig(on, {}))
        defs = {"bookshelf": d}
        self.assertEqual(summary(defs, on, "tester", {}), [])
        s = summary(defs, on, "tester", {"reading": {"enabled": True}})
        self.assertEqual(s[0]["interactions"][0]["verb"], "browse")

    def test_open_reading_degrades(self):
        self.assertEqual(BS.open_reading(None), (False, BS.NOT_READY))
        self.assertEqual(BS.open_reading(object()), (False, BS.NOT_READY))

        class Host:
            def __init__(self, r):
                self.r, self.calls = r, 0

            def open(self):
                self.calls += 1
                if isinstance(self.r, Exception):
                    raise self.r
                return self.r

        h = Host((True, "ok"))
        self.assertEqual(BS.open_reading(h), (True, ""))
        self.assertEqual(h.calls, 1)
        self.assertEqual(BS.open_reading(Host((False, "先在设置里打开「一起看书」"))), (False, "先在设置里打开「一起看书」"))
        self.assertEqual(BS.open_reading(Host((False, ""))), (False, BS.NOT_READY))
        self.assertEqual(BS.open_reading(Host(RuntimeError("boom"))), (False, BS.NOT_READY))
        self.assertEqual(BS.open_reading(Host(True)), (True, ""))


class LivePetShelf(unittest.TestCase):
    """Real PetApp, off-screen: the shelf is only placed while 一起看书 is on; browse walks over; click opens."""

    def test_gate_browse_and_click(self):
        import tkinter as tk
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        shutil.copytree(PACK, os.path.join(root_dir, "furniture", "bookshelf"))
        data = tmpdir()
        write_settings(data, furniture={"bookshelf": {"enabled": True}})
        root = tk.Tk()
        app = PetApp(root, root_dir, data_dir=data, character="tester", offscreen=True, speed=4000.0)
        try:
            self.assertNotIn("bookshelf", app.furniture)                      # 一起看书 off
            ok, msg = app.command({"cmd": "use", "id": "bookshelf", "verb": "browse"})[:2]
            self.assertFalse(ok)
            write_settings(data, furniture={"bookshelf": {"enabled": True}}, reading={"enabled": True})
            app._hot_reload()
            self.assertIn("bookshelf", app.furniture)
            w = app.furniture["bookshelf"]
            self.assertEqual(w.base_state, "idle")
            data_list = app.command({"cmd": "furniture"})[3]
            self.assertIn("bookshelf", [f["id"] for f in data_list])
            ok, msg, motion = app.command({"cmd": "use", "id": "bookshelf", "verb": "browse"})[:3]
            self.assertTrue(ok, msg)
            self.assertIsNotNone(motion)

            class Host:
                calls = 0

                def open(self):
                    Host.calls += 1
                    return False, "阅读窗打不开：没找到 Python"

            shown = []
            with mock.patch.object(app, "offscreen", False), \
                    mock.patch.object(app.bubble, "show", lambda text, *a, **k: shown.append(text)):
                app.reading = Host()
                app.on_furniture_click("bookshelf")
                self.assertEqual(Host.calls, 1)
                self.assertEqual(shown, ["阅读窗打不开：没找到 Python"])
                app.reading = None
                app.on_furniture_click("bookshelf")
                self.assertEqual(shown[-1], BS.NOT_READY)
            self.assertEqual(w.temp[0], "read")
            write_settings(data, furniture={"bookshelf": {"enabled": True}}, reading={"enabled": False})
            app._hot_reload()
            self.assertNotIn("bookshelf", app.furniture)
        finally:
            app.reading = None
            app.quit()


if __name__ == "__main__":
    unittest.main()
