"""Bookshelf furniture glue (pet side) for 「一起看书」. Tk-free.

A furniture pack opts in with "feature": "reading" and an optional block:
    "reading": {"openState": "read"}
The piece is only placed while settings.reading.enabled is on (furniture.FEATURE_GATES). Clicking it plays
openState and asks the pet's ReadingHost (app.reading, owned by the reading pack: .open() -> (ok, message))
to open the reading window. It is called in-process on the UI thread on purpose: POST /api/reading/open
would come back to this pet as cmd "reading" on the same UI thread and deadlock until timeout.
Anything missing or failing degrades to a bubble, never an exception.
"""

DEFAULTS = {"openState": "read"}
NOT_READY = "阅读窗还没准备好"


def options(defn):
    o = dict(DEFAULTS)
    raw = (defn or {}).get("reading")
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in DEFAULTS and isinstance(v, type(DEFAULTS[k])):
                o[k] = v
    return o


def open_reading(reading):
    """reading: the ReadingHost or None. -> (ok, bubble text; '' when nothing needs saying)."""
    opener = getattr(reading, "open", None)
    if not callable(opener):
        return False, NOT_READY
    try:
        r = opener()
    except Exception:  # noqa: BLE001
        return False, NOT_READY
    if isinstance(r, tuple) and r:
        ok = bool(r[0])
        msg = r[1] if len(r) > 1 and isinstance(r[1], str) else ""
    else:
        ok, msg = bool(r), ""
    if ok:
        return True, ""
    return False, (msg.strip()[:80] or NOT_READY)
