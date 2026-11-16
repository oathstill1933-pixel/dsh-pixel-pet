"""「一起看书」阅读窗：几何（默认贴主屏右侧、记住位置大小）+ 由桌宠管理的窗口进程。

The window is a normal pywebview (WebView2) window with the system title bar, run by the music
environment (`python -m pixelpet.reading_win`, reading_win.py). Unlike the 听歌 card it does not
follow the pet. The pet owns its lifecycle (like CardHost):
  * opens it only on demand (settings page 「打开阅读窗」, the bookshelf furniture, POST /api/reading/open);
  * closes it when 「一起看书」 is switched off or the pet quits (the window also exits by itself
    when its parent process is gone);
  * the window process remembers its rect in <data>/reading/window.json; a second launch focuses the
    running window instead of opening another one.
No paths or document text are logged here.
"""
import json
import os
import subprocess
import time

STATE_FILE = os.path.join("reading", "window.json")
DEFAULT_W, MIN_W, MIN_H = 520, 360, 420     # logical px
MIN_VISIBLE = 120                           # px of a saved rect that must still be on some monitor
HOLD_S = 75.0                               # longest a reading-window recording may hold the pet's listener


def default_rect(work, scale=1.0):
    """Right edge of the primary monitor's work area, full height. work = (l, t, r, b) physical px."""
    l, t, r, b = work
    w = min(round(DEFAULT_W * scale), max(round(MIN_W * scale), round((r - l) * 0.45)))
    w = min(w, r - l)
    return (r - w, t, w, b - t)


def visible_part(rect, work):
    x, y, w, h = rect
    l, t, r, b = work
    return max(0, min(x + w, r) - max(x, l)), max(0, min(y + h, b) - max(y, t))


def restore_rect(saved, works, scale=1.0):
    """A saved (x, y, w, h) if enough of it is still on one of the monitors' work areas (else None).
    Too-small sizes are raised to the minimum; a rect taller/wider than its monitor is shrunk into it."""
    try:
        x, y, w, h = (int(v) for v in saved)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    best, area = None, 0
    for work in works or ():
        vw, vh = visible_part((x, y, w, h), work)
        if vw >= MIN_VISIBLE and vh >= MIN_VISIBLE // 2 and vw * vh > area:
            best, area = work, vw * vh
    if best is None:
        return None
    l, t, r, b = best
    w = max(round(MIN_W * scale), min(w, r - l))
    h = max(round(MIN_H * scale), min(h, b - t))
    y = max(t, min(y, b - min(h, b - t)))      # the title bar must stay reachable
    return (x, y, w, h)


def read_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(path, state):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def reading_python(cfg, data_dir):
    """settings.reading.python, else settings.listen.python, else <data>/listen.json python."""
    cfg = cfg or {}
    for p in (str(((cfg.get("reading") or {}).get("python")) or "").strip(),
              str(((cfg.get("listen") or {}).get("python")) or "").strip()):
        if p and os.path.isfile(p):
            return p
    try:
        with open(os.path.join(data_dir, "listen.json"), encoding="utf-8") as f:
            p = str(json.load(f).get("python") or "").strip()
    except (OSError, ValueError, AttributeError):
        p = ""
    return p if p and os.path.isfile(p) else ""


def focus_window(state, alive, win):
    """Bring the running window (hwnd from window.json, owned by its pid) to the front. -> bool.
    win: owner(hwnd) -> pid, front(hwnd) (reading_win.Win or a fake)."""
    try:
        hwnd, pid = int(state.get("hwnd") or 0), int(state.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    if not hwnd or not pid or pid == os.getpid() or not alive(pid):
        return False
    try:
        if win.owner(hwnd) != pid:          # a stale hwnd now owned by someone else
            return False
        win.front(hwnd)
        return True
    except Exception:  # noqa: BLE001
        return False


class ReadingHost:
    """pet: data_dir; settings() -> settings dict (re-read every 2 s); spawn(argv, cwd) -> Popen-like."""

    def __init__(self, pet, spawn=None, clock=None, settings=None, base=None, focus=None):
        self.pet = pet
        self.spawn = spawn or self._spawn
        self.clock = clock or time.monotonic
        self.settings = settings or (lambda: getattr(pet, "cfg", {}) or {})
        self.base = base if base is not None else os.environ.get("PIXELPET_HOST_BASE", "")
        self.focus = focus
        self.proc = None
        self._cfg_at = -1e9
        self._cfg = {}

    def state_path(self):
        return os.path.join(self.pet.data_dir, STATE_FILE)

    def enabled(self):
        return ((self._cfg.get("reading") or {}).get("enabled")) is True

    def url(self):
        b = str(self.base or "")
        return b.rstrip("/") + "/reading/" if b.startswith(("http://127.0.0.1", "http://localhost")) else ""

    def argv(self):
        py = reading_python(self._cfg, self.pet.data_dir)
        if not py or not self.url():
            return None
        return [py, "-X", "utf8", "-m", "pixelpet.reading_win", "--url", self.url(), "--state", self.state_path(),
                "--parent", str(os.getpid())]

    @staticmethod
    def _spawn(argv, cwd):
        return subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def _focus(self):
        if self.focus is not None:
            return self.focus()
        try:
            from .reading_win import Win, pid_alive
            return focus_window(read_state(self.state_path()), pid_alive, Win())
        except Exception:  # noqa: BLE001
            return False

    def open(self):
        """-> (ok, message). Focuses the window when it is already open."""
        self._cfg, self._cfg_at = self.settings(), self.clock()
        if not self.enabled():
            return False, "「一起看书」没有打开。"
        if self.running():
            self._focus()
            return True, "ok"
        argv = self.argv()
        if not argv:
            return False, "没有找到阅读窗用的 Python（「一起听歌」的音乐服务 Python），或宿主地址未知。"
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # runtime/
        try:
            self.proc = self.spawn(argv, cwd)
        except OSError:
            self.proc = None
            return False, "阅读窗没能打开。"
        return True, "ok"

    def stop(self):
        p, self.proc = self.proc, None
        if p is not None and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass

    def capturing(self):
        """The pet itself is taking voice right now (input-bar capture or the talk recorder)."""
        pet = self.pet
        hub, mic = getattr(pet, "hub", None), getattr(pet, "mic", None)
        return bool((hub is not None and getattr(getattr(hub, "m", None), "capturing", False))
                    or (mic is not None and getattr(mic, "active", False)))

    def mic(self, on):
        """Reading window recording: hold the pet's hands-free listener meanwhile (released on `on=False` or after
        HOLD_S). When the pet is already capturing, the window should not record (busy=True)."""
        if not on:
            self.pet.reading_hold_until = 0.0
            return True, "ok", None, {"busy": False}
        if self.capturing():
            return True, "桌宠正在听。", None, {"busy": True}
        self.pet.reading_hold_until = self.clock() + HOLD_S
        return True, "ok", None, {"busy": False, "held": getattr(self.pet, "listener", None) is not None}

    def command(self, body):
        """pet `reading` command. -> (ok, message, None[, data])."""
        op = (body or {}).get("op")
        if op == "close":
            self.stop()
            return True, "ok", None
        if op == "mic":
            return self.mic(bool((body or {}).get("on")))
        ok, msg = self.open()
        return ok, msg, None

    def tick(self):
        now = self.clock()
        if now - self._cfg_at >= 2.0:
            self._cfg_at, self._cfg = now, self.settings()
        if self.proc is not None and self.proc.poll() is not None:
            self.proc = None                      # closed by the user: no auto-reopen
        if self.proc is not None and not self.enabled():
            self.stop()
