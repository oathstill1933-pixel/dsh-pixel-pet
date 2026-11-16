# -*- coding: utf-8 -*-
"""17 号：拓展包改走 GitHub Release 附件。下载器必须正确跟随 GitHub 的 302 跳转并校验，且跳转本身只许 https。

用一个本机 HTTP 服务模拟 Release：/releases/download/.. 先 302 到 /cdn/<签名>/..，再给文件。
覆盖：跟随 302 + sha256 校验、校验不符、跳到明文 http 被拒、跳转死循环、慢速 / 断网（有界）、整条 pack_cli install --url 管线。
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from helpers import ROOT, tmpdir

sys.path.insert(0, os.path.join(ROOT, "runtime"))

import pack_cli  # noqa: E402
from PIL import Image  # noqa: E402
from pixelpet.voice import fetch  # noqa: E402
from pixelpet.voice.fetch import DownloadError, IntegrityError, fetch_file  # noqa: E402

BODY = (b"petpack-bytes-" * 5000)
SHA = hashlib.sha256(BODY).hexdigest()


class Release(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        p = self.path
        if p == "/releases/download/v0.1.0/pack.petpack":
            return self._send(302, headers={"Location": "/cdn/signed-abc/pack.petpack"})       # what github.com answers
        if p == "/cdn/signed-abc/pack.petpack":
            rng = self.headers.get("Range")
            if rng:                                                                              # the CDN honours Range
                start = int(rng.split("=")[1].split("-")[0])
                return self._send(206, BODY[start:], {"Content-Range": "bytes %d-%d/%d" % (start, len(BODY) - 1, len(BODY))})
            return self._send(200, BODY)
        if p == "/releases/download/v0.1.0/wrong.petpack":
            return self._send(302, headers={"Location": "/cdn/signed-abc/wrong.petpack"})
        if p == "/cdn/signed-abc/wrong.petpack":
            return self._send(200, b"X" * len(BODY))                                             # right size, wrong bytes
        if p == "/to-http":
            return self._send(302, headers={"Location": "http://example.invalid/evil.petpack"})  # downgrade to plain http
        if p == "/to-ftp":
            return self._send(302, headers={"Location": "ftp://example.invalid/evil.petpack"})
        if p == "/loop":
            return self._send(302, headers={"Location": "/loop"})
        if p == "/slow":
            self.send_response(200)
            self.send_header("Content-Length", str(len(BODY)))
            self.end_headers()
            self.wfile.write(BODY[:10])
            self.wfile.flush()
            time.sleep(3)
            return
        self._send(404)


def build_pack(path, version="1.0.0"):
    manifest = {"id": "petdev.release-demo", "version": version, "name": "发布测试包", "manifestVersion": 1, "packApi": 1, "license": "MIT",
                "permissions": [], "entryFurniture": {"id": "demo-desk", "dir": "furniture/demo-desk"}, "characterAdapters": []}
    furniture = {"id": "demo-desk", "name": "测试桌", "version": 1, "size": [48, 32], "anchor": "bottom-right", "defaultEnabled": True,
                 "idle": "idle", "states": {"idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [800]}},
                 "interactions": [{"verb": "坐", "mode": "beside"}]}
    buf = io.BytesIO()
    Image.new("RGBA", (48, 32), (90, 140, 200, 255)).save(buf, "PNG")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        zf.writestr("furniture/demo-desk/furniture.json", json.dumps(furniture, ensure_ascii=False))
        zf.writestr("furniture/demo-desk/sprites/idle_00.png", buf.getvalue())
    return path


def cli(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        pack_cli.main(list(argv))
    lines = [x for x in out.getvalue().splitlines() if x.strip()]
    return json.loads(lines[-1])


class ReleaseDownload(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Release)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def entry(self, path, sha=SHA, size=len(BODY)):
        return {"url": self.base + path, "sha256": sha, "size": size, "path": "pack.petpack"}

    # ---- fetch_file
    def test_follows_the_github_style_302_and_verifies(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        self.assertEqual(fetch_file(self.entry("/releases/download/v0.1.0/pack.petpack"), dest, retries=0), "download")
        with open(dest, "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), SHA)
        self.assertFalse(os.path.exists(dest + ".part"))

    def test_resumes_a_partial_download_through_the_redirect(self):
        d = tmpdir()
        dest = os.path.join(d, "pack.petpack")
        with open(dest + ".part", "wb") as f:
            f.write(BODY[:12345])
        self.assertEqual(fetch_file(self.entry("/releases/download/v0.1.0/pack.petpack"), dest, retries=0), "download")
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), BODY)

    def test_wrong_bytes_after_the_redirect_are_rejected_and_nothing_is_left(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        with self.assertRaises(IntegrityError):
            fetch_file(self.entry("/releases/download/v0.1.0/wrong.petpack"), dest, retries=0)
        self.assertFalse(os.path.exists(dest)); self.assertFalse(os.path.exists(dest + ".part"))

    def test_declared_sha_mismatch_is_rejected(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        with self.assertRaises(IntegrityError):
            fetch_file(self.entry("/releases/download/v0.1.0/pack.petpack", sha="0" * 64), dest, retries=0)
        self.assertFalse(os.path.exists(dest))

    def test_a_redirect_to_plain_http_or_another_scheme_is_refused(self):
        for path in ("/to-http", "/to-ftp"):
            dest = os.path.join(tmpdir(), "pack.petpack")
            with self.assertRaisesRegex(DownloadError, "只接受 https"):
                fetch_file(self.entry(path), dest, retries=0)
            self.assertFalse(os.path.exists(dest))

    def test_https_redirect_targets_are_allowed_by_the_handler(self):
        handler = fetch._SafeRedirect()
        req = urllib.request.Request("https://github.com/o/r/releases/download/v1/a.petpack")
        new = handler.redirect_request(req, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/x?sig=1")
        self.assertEqual(new.full_url, "https://release-assets.githubusercontent.com/x?sig=1")
        with self.assertRaises(DownloadError):
            handler.redirect_request(req, None, 302, "Found", {}, "http://release-assets.githubusercontent.com/x")

    def test_redirect_loop_gives_up(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        with self.assertRaises(DownloadError):
            fetch_file(self.entry("/loop"), dest, retries=0)

    def test_slow_server_times_out_instead_of_hanging(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        t0 = time.monotonic()
        with self.assertRaises(DownloadError):
            fetch_file(self.entry("/slow"), dest, retries=0, timeout=0.6)
        self.assertLess(time.monotonic() - t0, 2.5)

    def test_connection_refused_fails_fast_when_retries_are_off(self):
        dest = os.path.join(tmpdir(), "pack.petpack")
        t0 = time.monotonic()
        with self.assertRaisesRegex(DownloadError, "连不上"):
            fetch_file({"url": "http://127.0.0.1:9/pack.petpack", "sha256": SHA, "size": len(BODY), "path": "pack.petpack"}, dest, retries=0)
        self.assertLess(time.monotonic() - t0, 3)

    # ---- the whole install pipeline (what the catalog's url entry runs)
    def test_pack_cli_install_url_through_the_redirect(self):
        data = tmpdir()
        pack = build_pack(os.path.join(data, "src.petpack"))
        body = open(pack, "rb").read()
        saved = (globals()["BODY"], globals()["SHA"])
        globals()["BODY"], globals()["SHA"] = body, hashlib.sha256(body).hexdigest()
        try:
            r = cli("install", "--data-dir", data, "--plugin-root", ROOT, "--url", self.base + "/releases/download/v0.1.0/pack.petpack",
                    "--sha256", globals()["SHA"], "--size", str(len(body)), "--pack-id", "petdev.release-demo", "--enable", "1", "--retries", "0")
        finally:
            globals()["BODY"], globals()["SHA"] = saved
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["id"], "petdev.release-demo"); self.assertEqual(r["version"], "1.0.0")
        with open(os.path.join(data, "packs", "registry.json"), encoding="utf-8") as f:
            self.assertIn("petdev.release-demo", json.load(f)["packs"])
        self.assertFalse(os.listdir(os.path.join(data, "packs", ".downloads")), "下载暂存用完即删")

    def test_pack_cli_install_url_with_wrong_sha_leaves_no_pack(self):
        data = tmpdir()
        r = cli("install", "--data-dir", data, "--plugin-root", ROOT, "--url", self.base + "/releases/download/v0.1.0/wrong.petpack",
                "--sha256", SHA, "--size", str(len(BODY)), "--pack-id", "petdev.release-demo", "--retries", "0")
        self.assertFalse(r["ok"]); self.assertEqual(r["code"], "E_HASH_MISMATCH")
        reg = os.path.join(data, "packs", "registry.json")
        self.assertFalse(os.path.exists(reg) and json.load(open(reg, encoding="utf-8"))["packs"])

    def test_pack_cli_install_url_offline_fails_fast(self):
        data = tmpdir()
        t0 = time.monotonic()
        r = cli("install", "--data-dir", data, "--plugin-root", ROOT, "--url", "http://127.0.0.1:9/pack.petpack",
                "--sha256", SHA, "--size", str(len(BODY)), "--pack-id", "petdev.release-demo", "--retries", "0")
        self.assertFalse(r["ok"])
        self.assertLess(time.monotonic() - t0, 5)


if __name__ == "__main__":
    unittest.main()
