import json
import os
import unittest
import urllib.error
import urllib.request

from helpers import tmpdir

from pixelpet.control import ControlServer, send


def post(port, path="/cmd", body=b'{"cmd":"status"}', headers=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=body, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class Control(unittest.TestCase):
    def setUp(self):
        self.info = os.path.join(tmpdir(), "control.json")
        self.got = []
        self.srv = ControlServer(lambda b: (self.got.append(b), {"ok": True, "message": "pong"})[1], self.info)
        self.auth = {"Authorization": "Bearer " + self.srv.token, "Content-Type": "application/json"}

    def tearDown(self):
        self.srv.close()

    def test_info_file_and_roundtrip(self):
        with open(self.info, encoding="utf-8") as f:
            info = json.load(f)
        self.assertEqual(info["port"], self.srv.port)
        self.assertEqual(info["pid"], os.getpid())
        self.assertEqual(send(self.info, {"cmd": "status"}), {"ok": True, "message": "pong"})
        self.assertEqual(self.got, [{"cmd": "status"}])

    def test_rejections(self):
        p = self.srv.port
        self.assertEqual(post(p)[0], 401)
        self.assertEqual(post(p, headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(post(p, path="/other", headers=self.auth)[0], 403)
        self.assertEqual(post(p, headers={**self.auth, "Origin": "http://evil.test"})[0], 403)
        self.assertEqual(post(p, body=b"[1]", headers=self.auth)[0], 400)
        self.assertEqual(post(p, body=b"x" * 5000, headers=self.auth)[0], 413)
        self.assertEqual(self.got, [])

    def test_tokens_are_fresh(self):
        other = ControlServer(lambda b: {"ok": True})
        try:
            self.assertNotEqual(other.token, self.srv.token)
            self.assertGreaterEqual(len(other.token), 30)
        finally:
            other.close()

    def test_close_removes_info(self):
        self.srv.close()
        self.assertFalse(os.path.exists(self.info))


if __name__ == "__main__":
    unittest.main()
