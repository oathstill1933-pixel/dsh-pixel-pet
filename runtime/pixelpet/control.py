"""Local command endpoint: POST http://127.0.0.1:<random port>/cmd with `Authorization: Bearer <token>`.

The token is generated fresh on every start (secrets.token_urlsafe) and written, together with the
port, to <data dir>/control.json so local tools can find it. Only 127.0.0.1, only /cmd, no Origin
header (blocks browser pages), JSON object bodies up to 4 KiB.

`dispatch(body) -> dict` runs on the HTTP thread; the pet passes a function that hands the work to
its UI thread and waits.
"""
import hmac
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY_LIMIT = 4096


class ControlServer:
    def __init__(self, dispatch, info_file=None, port=0):
        self.dispatch = dispatch
        self.token = secrets.token_urlsafe(24)
        self.info_file = info_file
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                return

            def _reply(self, code, obj):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                self._reply(404, {"ok": False})

            def do_POST(self):
                port = server.port
                host = self.headers.get("Host", "")
                if (self.client_address[0] != "127.0.0.1" or host not in ("127.0.0.1:%d" % port, "localhost:%d" % port)
                        or self.headers.get("Origin") or self.path != "/cmd"):
                    return self._reply(403, {"ok": False, "message": "forbidden"})
                auth = self.headers.get("Authorization", "")
                if not hmac.compare_digest(auth.encode(), ("Bearer " + server.token).encode()):
                    return self._reply(401, {"ok": False, "message": "unauthorized"})
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > BODY_LIMIT:
                    return self._reply(413, {"ok": False, "message": "bad body"})
                try:
                    body = json.loads(self.rfile.read(n).decode("utf-8"))
                    assert isinstance(body, dict)
                except Exception:  # noqa: BLE001
                    return self._reply(400, {"ok": False, "message": "bad json"})
                try:
                    out = server.dispatch(body)
                except Exception as exc:  # noqa: BLE001
                    out = {"ok": False, "message": "error: %s" % type(exc).__name__}
                self._reply(200, out)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self._write_info()

    def _write_info(self):
        if not self.info_file:
            return
        try:
            os.makedirs(os.path.dirname(self.info_file), exist_ok=True)
            tmp = self.info_file + ".%d.tmp" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"v": 1, "port": self.port, "token": self.token, "pid": os.getpid()}, f)
            os.replace(tmp, self.info_file)
        except OSError:
            pass

    def close(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:  # noqa: BLE001
            pass
        if self.info_file:
            try:
                with open(self.info_file, encoding="utf-8") as f:
                    mine = json.load(f).get("pid") == os.getpid()
                if mine:                     # remove after closing: Windows cannot delete an open file
                    os.remove(self.info_file)
            except Exception:  # noqa: BLE001
                pass


def send(info_file, body, timeout=30):
    """Client helper for tools/tests: read control.json and POST one command. -> dict."""
    import urllib.request
    with open(info_file, encoding="utf-8") as f:
        info = json.load(f)
    req = urllib.request.Request("http://127.0.0.1:%d/cmd" % info["port"], data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + info["token"]})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))
