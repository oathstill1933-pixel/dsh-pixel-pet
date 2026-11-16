# -*- coding: utf-8 -*-
"""M1 热加载回执测试：真实 pack_cli 安装 + 离屏 PetApp 的 packs 控制命令。

覆盖：冷启动读注册表、reload 回执（含 loaded/errors）、激活代次不一致、卸载后窗口销毁
（陈旧窗口修复）、registry mtime 门控自愈、settings.furniture 开关照常作用于包家具。
全部素材程序生成；桌宠 offscreen；绝不偷偷启动真实进程。
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
import zipfile

from helpers import ROOT, make_character, tmpdir  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "runtime"))

from PIL import Image  # noqa: E402

CLI = os.path.join(ROOT, "runtime", "pack_cli.py")
PACK_ID = "petdev.reload-demo"


def png_bytes(size, color=(90, 140, 200, 255)):
    buf = __import__("io").BytesIO()
    Image.new("RGBA", size, color).save(buf, "PNG")
    return buf.getvalue()


def build_petpack(path, version="1.0.0", permissions=()):
    manifest = {
        "id": PACK_ID, "version": version, "name": "热加载演示", "manifestVersion": 1,
        "packApi": 1, "license": "MIT", "permissions": list(permissions),
        "entryFurniture": {"id": "reload-lamp", "dir": "furniture/reload-lamp"},
        "characterAdapters": [],
    }
    furniture = {
        "id": "reload-lamp", "name": "演示灯", "version": 1, "size": [40, 24],
        "anchor": "bottom-right", "defaultEnabled": True, "idle": "idle",
        "states": {"idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [900]}},
        "interactions": [{"verb": "看", "mode": "beside"}],
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        zf.writestr("furniture/reload-lamp/furniture.json", json.dumps(furniture, ensure_ascii=False))
        zf.writestr("furniture/reload-lamp/sprites/idle_00.png", png_bytes((40, 24)))


def run_cli(*args):
    r = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, timeout=120,
                       env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    lines = [x for x in r.stdout.strip().splitlines() if x.strip()]
    return json.loads(lines[-1]) if lines else {"ok": False}


class PacksReload(unittest.TestCase):
    def setUp(self):
        import tkinter as tk
        try:
            self.tkroot = tk.Tk()
        except tk.TclError as exc:
            self.skipTest("no display: %s" % exc)
        self.tkroot.withdraw()
        self.data = tmpdir()
        self.plugin = tmpdir()
        make_character(self.plugin, "tester")
        os.makedirs(os.path.join(self.plugin, "characters"), exist_ok=True)
        self.pack = os.path.join(self.data, "demo.petpack")
        build_petpack(self.pack)
        self.installed = False

    def tearDown(self):
        self._safe_quit()
        shutil.rmtree(self.data, ignore_errors=True)
        shutil.rmtree(self.plugin, ignore_errors=True)

    def _safe_quit(self):
        app = getattr(self, "_app", None)
        if app is not None:
            try:
                app.quit()
            except Exception:  # noqa: BLE001 - app.quit() 销毁的是整个 Tk 应用，可能已销毁
                pass
            self._app = None
        try:
            self.tkroot.destroy()
        except Exception:  # noqa: BLE001
            pass

    def install_pack(self, version="1.0.0", enable=True, permissions=()):
        build_petpack(self.pack, version=version, permissions=permissions)
        v = run_cli("install", "--data-dir", self.data, "--plugin-root", self.plugin, "--pack", self.pack,
                    *(("--enable", "1") if enable else ()))
        self.assertTrue(v["ok"], v)
        self.installed = True
        return v

    def make_app(self):
        from pixelpet.app import PetApp
        app = PetApp(self.tkroot, self.plugin, data_dir=self.data, character="tester", offscreen=True, speed=4000.0)
        self._app = app
        return app

    def test_cold_start_reads_registry_and_loads_pack_furniture(self):
        v = self.install_pack()
        app = self.make_app()
        self.assertIn("reload-lamp", app.furniture_defs)
        self.assertTrue(app.furniture_defs["reload-lamp"].get("_pack"))
        self.assertIn("reload-lamp", app.furniture)  # defaultEnabled → 已摆上桌面
        self.assertEqual(app._packs_gen, v["generation"])

    def test_reload_command_receipt(self):
        v = self.install_pack()
        app = self.make_app()
        ok, msg, _motion, data = app.command({"cmd": "packs", "action": "reload", "generation": v["generation"]})
        self.assertTrue(ok, msg)
        self.assertTrue(data["ok"])
        self.assertEqual(data["generation"], v["generation"])
        self.assertIn("reload-lamp", data["loaded"]["furniture"])
        st = app.command({"cmd": "packs", "action": "status"})[3]
        self.assertEqual(st["generation"], v["generation"])
        self.assertIn("reload-lamp", st["packFurniture"])

    def test_generation_mismatch_refused(self):
        self.install_pack()
        app = self.make_app()
        ok, msg, _m, data = app.command({"cmd": "packs", "action": "reload", "generation": 999})
        self.assertFalse(ok)
        self.assertEqual(data["reason"], "generation-mismatch")
        self.assertIn("reload-lamp", app.furniture_defs)  # 旧状态照常

    def test_uninstall_drops_window_no_stale(self):
        self.install_pack()
        app = self.make_app()
        self.assertIn("reload-lamp", app.furniture)
        v = run_cli("uninstall", "--data-dir", self.data, "--plugin-root", self.plugin, "--pack-id", PACK_ID)
        self.assertTrue(v["ok"])
        ok, msg, _m, data = app.command({"cmd": "packs", "action": "reload", "generation": v["generation"]})
        self.assertTrue(data["ok"], data)
        self.assertNotIn("reload-lamp", app.furniture_defs)
        self.assertNotIn("reload-lamp", app.furniture)  # 陈旧窗口已销毁

    def test_registry_mtime_selfheal_without_command(self):
        # 宠物先启动（此时还没有包），安装器改了注册表：mtime 门控自愈，不需要任何 reload 命令
        app = self.make_app()
        self.assertNotIn("reload-lamp", app.furniture_defs)
        self.install_pack()
        app._packs_check()
        self.assertIn("reload-lamp", app.furniture_defs)
        self.assertIn("reload-lamp", app.furniture)

    def test_settings_toggle_disables_pack_furniture(self):
        self.install_pack()
        app = self.make_app()
        self.assertIn("reload-lamp", app.furniture)
        app.cfg["furniture"]["reload-lamp"] = {"enabled": False}
        app._fcfg_sig = None
        app.sync_furniture()
        self.assertNotIn("reload-lamp", app.furniture)
        self.assertIn("reload-lamp", app.furniture_defs)  # 定义还在，只是没摆出来

    def test_failed_reload_keeps_old_furniture(self):
        self.install_pack()
        app = self.make_app()
        self.assertIn("reload-lamp", app.furniture_defs)
        # load_furniture 本身抛错（磁盘/解码故障）时：重载失败，旧定义原样保留
        import pixelpet.app as appmod

        def boom(*a, **k):
            raise RuntimeError("boom")

        orig = appmod.load_furniture
        appmod.load_furniture = boom
        try:
            ok, msg, _m, data = app.command({"cmd": "packs", "action": "reload"})
        finally:
            appmod.load_furniture = orig
        self.assertFalse(ok)
        self.assertIn("reload-lamp", app.furniture_defs)  # 旧定义未动
        self.assertIn("reload-lamp", app.furniture)

    # ---- 权限门（M1 通过条件⑤）：未确认 / 未启用的包整包不加载，defaultEnabled 不生效
    def test_install_without_enable_is_not_loaded(self):
        v = self.install_pack(enable=False)
        self.assertEqual(v["state"], "installed-disabled")
        self.assertFalse(v["load"])
        app = self.make_app()
        self.assertNotIn("reload-lamp", app.furniture_defs)
        self.assertNotIn("reload-lamp", app.furniture)

    def test_needs_confirm_permission_blocks_default_enabled_until_grant(self):
        v = self.install_pack(enable=True, permissions=["playback.control"])
        self.assertEqual(v["state"], "waiting-authorization")
        self.assertEqual(v["pendingPermissions"], ["playback.control"])
        app = self.make_app()
        self.assertNotIn("reload-lamp", app.furniture_defs)  # defaultEnabled:true 也不摆
        g = run_cli("grant", "--data-dir", self.data, "--pack-id", PACK_ID)
        self.assertTrue(g["ok"], g)
        self.assertEqual(g["state"], "installed-disabled")
        self.assertTrue(g["load"])
        ok, msg, _m, data = app.command({"cmd": "packs", "action": "reload", "generation": g["generation"]})
        self.assertTrue(ok, msg)
        self.assertIn("reload-lamp", data["loaded"]["furniture"])
        self.assertIn("reload-lamp", app.furniture)

    def test_update_adding_permission_pauses_new_version_keeps_old(self):
        self.install_pack("1.0.0")
        v = self.install_pack("1.1.0", permissions=["screen.capture"])
        self.assertEqual(v["state"], "waiting-authorization")
        self.assertEqual(v["loadVersion"], "1.0.0")  # 新增能力暂停，旧版继续
        from pixelpet import packkit as PK
        roots = PK.pack_furniture_roots(self.data)
        self.assertEqual(len(roots), 1)
        self.assertTrue(roots[0].replace("\\", "/").endswith("/1.0.0"))

    def test_generation_ahead_is_accepted(self):
        v = self.install_pack()
        app = self.make_app()
        ok, msg, _m, data = app.command({"cmd": "packs", "action": "reload", "generation": v["generation"] - 1})
        self.assertTrue(ok, msg)  # 宠物代次 >= 要求即可（中间有别的写入）
        self.assertIn("reload-lamp", data["loaded"]["furniture"])


if __name__ == "__main__":
    unittest.main()
