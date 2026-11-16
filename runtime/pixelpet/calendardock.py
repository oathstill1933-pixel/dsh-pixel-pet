"""台历家具 glue（pet side）for 「日历与日记」。Tk-free，参照 bookshelf.py。

日历窗住在宿主侧（openWindow，默认浏览器窗口），桌宠点台历只能请宿主开：POST
<PIXELPET_HOST_BASE>/api/calendar/open（本机、无凭据，同其它日历接口）。失败降级为气泡，绝不抛。
"""
import json
import os
import urllib.request

NOT_READY = "日历窗还没准备好"


def options(defn):
    o = {"openState": "open"}
    raw = (defn or {}).get("calendar")
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in o and isinstance(v, type(o[k])):
                o[k] = v
    return o


def open_calendar(base=None, timeout=2.0):
    """-> (ok, bubble text；'' when nothing needs saying)。fire-and-forget，2 秒超时。"""
    base = base if base is not None else os.environ.get("PIXELPET_HOST_BASE", "")
    if not base:
        return False, NOT_READY
    url = base.rstrip("/") + "/api/calendar/open"
    req = urllib.request.Request(url, data=b"{}", method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
            if body.get("ok") is True:
                return True, ""
            return False, str(body.get("message") or NOT_READY)
    except Exception:  # noqa: BLE001
        return False, NOT_READY
