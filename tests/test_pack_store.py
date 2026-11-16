# -*- coding: utf-8 -*-
"""pack_cli（M1 安装器 CLI）测试：事务安装、zip 防御矩阵、幂等/冲突/回滚、注册表原子性。

CLI 以真实 Python 子进程跑（单行 JSON 判决约定一并覆盖）；纯函数分支（扫描/上限）直接调用 +
monkeypatch 上限常量，避免造几百 MB 的真实数据。全部素材程序生成，无任何真实内容。
"""
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from helpers import ROOT, make_furniture, png, tmpdir  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "runtime"))

from PIL import Image  # noqa: E402

CLI = os.path.join(ROOT, "runtime", "pack_cli.py")

MANIFEST = {
    "id": "petdev.store-demo", "version": "1.0.0", "name": "店测包", "manifestVersion": 1,
    "packApi": 1, "license": "MIT", "permissions": [],
    "entryFurniture": {"id": "demo-desk", "dir": "furniture/demo-desk"},
    "characterAdapters": [],
}

FURNITURE = {
    "id": "demo-desk", "name": "店测桌", "version": 1, "size": [48, 32],
    "anchor": "bottom-right", "defaultEnabled": True, "idle": "idle",
    "states": {"idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [800]}},
    "interactions": [{"verb": "坐", "mode": "beside"}],
}


def png_bytes(size, color=(90, 140, 200, 255)):
    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, "PNG")
    return buf.getvalue()


def build_petpack(path, manifest=None, furniture=None, extra_members=None, skip=()):
    m = json.loads(json.dumps(MANIFEST))
    if manifest:
        m.update(manifest)
    f = json.loads(json.dumps(FURNITURE))
    if furniture:
        f.update(furniture)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        if "manifest" not in skip:
            zf.writestr("manifest.json", json.dumps(m, ensure_ascii=False))
        if "furniture" not in skip:
            zf.writestr("furniture/demo-desk/furniture.json", json.dumps(f, ensure_ascii=False))
            zf.writestr("furniture/demo-desk/sprites/idle_00.png", png_bytes((48, 32)))
        for name, data in (extra_members or {}).items():
            zf.writestr(name, data)
    return path


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_cli(*args):
    r = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
                       env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    lines = [x for x in r.stdout.strip().splitlines() if x.strip()]
    verdict = json.loads(lines[-1]) if lines else {"ok": False, "code": "NO-OUTPUT"}
    return r.returncode, verdict


class Base(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()
        self.plugin = tmpdir()
        make_furniture(self.plugin, "builtin-box")  # 内置家具，用来测撞名
        os.makedirs(os.path.join(self.plugin, "characters"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)
        shutil.rmtree(self.plugin, ignore_errors=True)

    def install(self, pack_path, extra=()):
        return run_cli("install", "--data-dir", self.data, "--plugin-root", self.plugin, "--pack", pack_path, *extra)

    def registry(self):
        with open(os.path.join(self.data, "packs", "registry.json"), encoding="utf-8") as f:
            return json.load(f)


class InstallFlow(Base):
    def test_install_import_places_store_and_registry(self):
        pack = build_petpack(os.path.join(self.data, "in.petpack"))
        code, v = self.install(pack)
        self.assertTrue(v["ok"], v)
        self.assertEqual(code, 0)
        self.assertEqual(v["id"], "petdev.store-demo")
        self.assertEqual(v["generation"], 1)
        store = os.path.join(self.data, "packs", "store", "petdev", "store-demo", "1.0.0")
        self.assertTrue(os.path.isfile(os.path.join(store, "manifest.json")))
        self.assertTrue(os.path.isfile(os.path.join(store, "furniture", "demo-desk", "sprites", "idle_00.png")))
        reg = self.registry()
        self.assertEqual(reg["v"], 2)
        e = reg["packs"]["petdev.store-demo"]
        a = e["active"]
        # 权限门：安装落地 installed-disabled，未表达启用意图就不加载（defaultEnabled 不生效）
        self.assertEqual(e["state"], "installed-disabled")
        self.assertFalse(e["wantEnabled"])
        self.assertFalse(v["load"])
        self.assertNotIn("status", a)
        self.assertEqual(a["furnitureIds"], ["demo-desk"])
        self.assertEqual(a["sha256"], sha(pack))
        self.assertIsNone(e["receipt"])

    def test_idempotent_same_version_same_sha(self):
        pack = build_petpack(os.path.join(self.data, "in.petpack"))
        self.install(pack)
        code, v = self.install(pack)
        self.assertTrue(v["ok"] and v.get("idempotent"))
        self.assertEqual(v["generation"], 1)  # generation 不再 +1

    def test_conflict_same_version_diff_sha(self):
        self.install(build_petpack(os.path.join(self.data, "a.petpack")))
        other = build_petpack(os.path.join(self.data, "b.petpack"), manifest={"name": "同版不同内容"})
        code, v = self.install(other)
        self.assertFalse(v["ok"])
        self.assertEqual(v["code"], "E_ID_CONFLICT")

    def test_furniture_id_collision_rejected(self):
        # 包内家具目录名就叫 builtin-box（id 与目录名一致才是合法家具），撞内置 id
        path = os.path.join(self.data, "c.petpack")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(
                {**MANIFEST, "entryFurniture": {"id": "builtin-box", "dir": "furniture/builtin-box"}}, ensure_ascii=False))
            zf.writestr("furniture/builtin-box/furniture.json", json.dumps(
                {**FURNITURE, "id": "builtin-box", "name": "撞名桌"}, ensure_ascii=False))
            zf.writestr("furniture/builtin-box/sprites/idle_00.png", png_bytes((48, 32)))
        code, v = self.install(path)
        self.assertFalse(v["ok"])
        self.assertEqual(v["code"], "E_ID_CONFLICT")

    def test_upgrade_keeps_previous_and_rollback_restores(self):
        self.install(build_petpack(os.path.join(self.data, "v1.petpack")), extra=("--enable", "1"))
        self.install(build_petpack(os.path.join(self.data, "v2.petpack"), manifest={"version": "1.1.0"}), extra=("--enable", "1"))
        reg = self.registry()
        entry = reg["packs"]["petdev.store-demo"]
        self.assertEqual(entry["active"]["version"], "1.1.0")
        self.assertEqual(entry["previous"]["version"], "1.0.0")
        code, v = run_cli("rollback", "--data-dir", self.data, "--pack-id", "petdev.store-demo")
        self.assertTrue(v["ok"])
        self.assertEqual(v["active"], "1.0.0")
        entry = self.registry()["packs"]["petdev.store-demo"]
        self.assertEqual(entry["active"]["version"], "1.0.0")
        self.assertEqual(entry["failed"]["version"], "1.1.0")
        self.assertEqual(entry["state"], "installed-disabled")  # load-failed --rollback-ok--> installed-disabled
        self.assertTrue(entry["wantEnabled"])  # 旧版继续加载
        self.assertTrue(os.path.isdir(os.path.join(self.data, "packs", "store", "petdev", "store-demo", "1.1.0")))

    def test_uninstall_removes_store_and_is_idempotent(self):
        self.install(build_petpack(os.path.join(self.data, "in.petpack")))
        code, v = run_cli("uninstall", "--data-dir", self.data, "--plugin-root", self.plugin,
                          "--pack-id", "petdev.store-demo")
        self.assertTrue(v["ok"])
        self.assertFalse(os.path.isdir(os.path.join(self.data, "packs", "store", "petdev", "store-demo", "1.0.0")))
        self.assertNotIn("petdev.store-demo", self.registry()["packs"])
        code, v = run_cli("uninstall", "--data-dir", self.data, "--plugin-root", self.plugin,
                          "--pack-id", "petdev.store-demo")
        self.assertTrue(v["ok"] and v.get("idempotent"))

    def test_receipt_is_recorded(self):
        self.install(build_petpack(os.path.join(self.data, "in.petpack")), extra=("--enable", "1"))
        code, v = run_cli("receipt", "--data-dir", self.data, "--pack-id", "petdev.store-demo",
                          "--generation", "1", "--pet-running", "1", "--ok-flag", "1",
                          "--loaded", '["demo-desk"]')
        self.assertTrue(v["ok"])
        e = self.registry()["packs"]["petdev.store-demo"]
        receipt = e["receipt"]
        self.assertEqual(receipt["generation"], 1)
        self.assertTrue(receipt["ok"] and receipt["petRunning"])  # --ok-flag 1 → ok 真
        self.assertEqual(receipt["loaded"], {"furniture": ["demo-desk"], "characters": []})
        self.assertEqual(e["state"], "enabled")  # installed-disabled --load-receipt-ok--> enabled
        run_cli("receipt", "--data-dir", self.data, "--pack-id", "petdev.store-demo",
                "--generation", "1", "--pet-running", "1", "--ok-flag", "0", "--loaded", "[]")
        e = self.registry()["packs"]["petdev.store-demo"]
        self.assertFalse(e["receipt"]["ok"])
        self.assertEqual(e["state"], "load-failed")

    def test_corrupt_registry_refuses_write(self):
        os.makedirs(os.path.join(self.data, "packs"), exist_ok=True)
        with open(os.path.join(self.data, "packs", "registry.json"), "w", encoding="utf-8") as f:
            f.write("{ 不是 JSON")
        pack = build_petpack(os.path.join(self.data, "in.petpack"))
        code, v = self.install(pack)
        self.assertFalse(v["ok"])
        self.assertEqual(v["code"], "E_REGISTRY_INVALID")

    def test_catalog_id_mismatch_refused(self):
        pack = build_petpack(os.path.join(self.data, "in.petpack"))
        code, v = self.install(pack, extra=("--pack-id", "petdev.other"))
        self.assertFalse(v["ok"])
        self.assertEqual(v["code"], "E_FIELD_INVALID")

    def test_download_via_loopback_with_sha(self):
        data = open(build_petpack(os.path.join(self.data, "in.petpack")), "rb").read()

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            url = "http://127.0.0.1:%d/petpack" % srv.server_address[1]
            code, v = run_cli("install", "--data-dir", self.data, "--plugin-root", self.plugin,
                              "--url", url, "--sha256", hashlib.sha256(data).hexdigest(),
                              "--size", str(len(data)), "--pack-id", "petdev.store-demo")
            self.assertTrue(v["ok"], v)
            self.assertEqual(v["id"], "petdev.store-demo")
            # 错哈希拒收
            code, v = run_cli("install", "--data-dir", self.data, "--plugin-root", self.plugin,
                              "--url", url, "--sha256", "0" * 64, "--size", str(len(data)),
                              "--pack-id", "petdev.store-demo")
            self.assertFalse(v["ok"])
        finally:
            srv.shutdown()


class ZipDefense(Base):
    def test_traversal_refused(self):
        pack = build_petpack(os.path.join(self.data, "evil.petpack"),
                             extra_members={"../evil.txt": b"x"})
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_ZIP_INVALID")

    def test_absolute_and_drive_refused(self):
        for name in ("/abs.txt", "C" + ":/abs.txt"):
            pack = build_petpack(os.path.join(self.data, "evil.petpack"), extra_members={name: b"x"})
            code, v = self.install(pack)
            self.assertEqual(v["code"], "E_ZIP_INVALID")

    def test_symlink_member_refused(self):
        path = os.path.join(self.data, "evil.petpack")
        with zipfile.ZipFile(path, "w") as zf:
            zi = zipfile.ZipInfo("link.png")
            zi.external_attr = (stat.S_IFLNK | 0o644) << 16
            zf.writestr(zi, "somewhere-else")
        code, v = self.install(path)
        self.assertEqual(v["code"], "E_ZIP_INVALID")

    def test_duplicate_and_case_collision_refused(self):
        pack = build_petpack(os.path.join(self.data, "evil.petpack"),
                             extra_members={"Furniture/demo-desk/furniture.json": b"{}"})
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_ZIP_INVALID")

    def test_member_count_limit(self):
        members = {"m/%04d.txt" % i: b"x" for i in range(600)}
        pack = build_petpack(os.path.join(self.data, "many.petpack"), extra_members=members)
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_ZIP_LIMIT")

    def test_single_file_size_limit(self):
        big = b"\0" * (33 * 1024 * 1024)
        pack = build_petpack(os.path.join(self.data, "big.petpack"), extra_members={"big.bin": big})
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_ZIP_LIMIT")

    def test_total_and_pixel_limits_via_direct_call(self):
        import pack_cli
        pack = build_petpack(os.path.join(self.data, "some.petpack"),
                             extra_members={"a.bin": b"\0" * 2048, "b.bin": b"\0" * 2048})
        old = pack_cli.TOTAL_LIMIT
        pack_cli.TOTAL_LIMIT = 1024
        try:
            with self.assertRaises(pack_cli.CliError) as cm:
                pack_cli._scan_zip(pack)
            self.assertEqual(cm.exception.code, "E_ZIP_LIMIT")
        finally:
            pack_cli.TOTAL_LIMIT = old
        # 像素预算：直接对暂存目录校验
        stage = tempfile.mkdtemp(prefix="pixelpet-pixel-")
        try:
            png(os.path.join(stage, "a.png"), size=(64, 64))
            old = pack_cli.PIXEL_BUDGET
            pack_cli.PIXEL_BUDGET = 100
            try:
                with self.assertRaises(pack_cli.CliError) as cm:
                    pack_cli._pixel_budget(stage)
                self.assertEqual(cm.exception.code, "E_ZIP_LIMIT")
            finally:
                pack_cli.PIXEL_BUDGET = old
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def test_missing_manifest_refused(self):
        pack = build_petpack(os.path.join(self.data, "no.manifest"), skip=("manifest",))
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_MANIFEST_MISSING")

    def test_unsupported_manifest_version_refused(self):
        pack = build_petpack(os.path.join(self.data, "v2.petpack"), manifest={"manifestVersion": 2})
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_MANIFEST_VERSION_UNSUPPORTED")

    def test_bad_furniture_refused(self):
        pack = build_petpack(os.path.join(self.data, "badf.petpack"), furniture={"idle": "nope"})
        code, v = self.install(pack)
        self.assertEqual(v["code"], "E_FIELD_INVALID")


if __name__ == "__main__":
    unittest.main()
