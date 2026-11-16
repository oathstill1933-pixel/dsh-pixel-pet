"""「一起看书」阅读窗：pywebview（WebView2）正常窗口，加载宿主的 /reading/ 页面。

    python -m pixelpet.reading_win --url http://127.0.0.1:3080/dsh-pixel-pet/reading/ --state <data>/reading/window.json --parent <pid>

Started by the pet runtime (reading_dock.ReadingHost) or, when the pet is not running, by the host.
System title bar (drag / resize / snap work as usual), placed at the right edge of the primary monitor
the first time and wherever the user left it afterwards (window.json). A second launch focuses the
running window and exits. Exits on its own when the parent process is gone.

Needs pywebview + pythonnet (the 一起听歌 music environment). Logs nothing.
"""
import argparse
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(HERE))
from pixelpet.reading_dock import (MIN_H, MIN_W, default_rect, focus_window, read_state,  # noqa: E402
                                   restore_rect, write_state)

TITLE = "一起看书"
BG = "#fbfaf7"


def pid_alive(pid):
    if not pid:
        return True
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))          # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259               # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


class Win:
    """The few Win32 calls the reading window needs (fakes in tests/test_reading_win.py)."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes as wt
        self.ct, self.wt, self.u = ctypes, wt, ctypes.windll.user32
        self.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.UINT]
        self.u.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
        self.u.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]

    def find(self, pid, title):
        """Top-level window of process `pid` whose title is `title` (pywebview's form, hidden or not)."""
        ct, wt, u = self.ct, self.wt, self.u
        hit = []
        proto = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

        def cb(hwnd, _):
            if self.owner(hwnd) == pid:
                n = u.GetWindowTextLengthW(hwnd)
                buf = ct.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value == title:
                    hit.append(hwnd)
                    return False
            return True
        u.EnumWindows(proto(cb), 0)
        return int(hit[0]) if hit else None

    def owner(self, hwnd):
        pid = self.wt.DWORD()
        self.u.GetWindowThreadProcessId(hwnd, self.ct.byref(pid))
        return int(pid.value)

    def rect(self, hwnd):
        r = self.wt.RECT()
        if not self.u.GetWindowRect(hwnd, self.ct.byref(r)):
            return None
        return (r.left, r.top, r.right - r.left, r.bottom - r.top)

    def place(self, hwnd, x, y, w, h):
        self.u.SetWindowPos(hwnd, None, int(x), int(y), int(w), int(h), 0x4 | 0x10)       # NOZORDER | NOACTIVATE

    def iconic(self, hwnd):
        return bool(self.u.IsIconic(hwnd))

    def zoomed(self, hwnd):
        return bool(self.u.IsZoomed(hwnd))

    def maximize(self, hwnd):
        self.u.ShowWindow(hwnd, 3)

    def front(self, hwnd):
        if self.iconic(hwnd):
            self.u.ShowWindow(hwnd, 9)                      # SW_RESTORE
        self.u.SetForegroundWindow(hwnd)

    def scale(self, hwnd):
        try:
            return (self.u.GetDpiForWindow(hwnd) or 96) / 96
        except Exception:  # noqa: BLE001
            return 1.0

    def works(self):
        """Work areas of all monitors, the primary one first. -> [(l, t, r, b)]."""
        ct, wt, u = self.ct, self.wt, self.u

        class MI(ct.Structure):
            _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]
        out = []
        proto = ct.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ct.POINTER(wt.RECT), wt.LPARAM)

        def cb(hmon, _hdc, _rc, _):
            mi = MI()
            mi.cbSize = ct.sizeof(MI)
            if u.GetMonitorInfoW(hmon, ct.byref(mi)):
                w = mi.rcWork
                out.append(((w.left, w.top, w.right, w.bottom), bool(mi.dwFlags & 1)))
            return True
        u.EnumDisplayMonitors(None, None, proto(cb), 0)
        out.sort(key=lambda x: not x[1])
        return [w for w, _ in out] or [(0, 0, 1920, 1040)]


class Reader:
    """Placement + remembering the rect. All Win32 goes through `win` (fake in tests)."""

    def __init__(self, state_path, parent, win, pid=None, title=TITLE):
        self.state_path, self.parent, self.win = state_path, parent, win
        self.pid = pid or os.getpid()
        self.title = title
        self.hwnd = None
        self.placed = False
        self.saved = None         # last state written
        self.window = None        # pywebview window (main)

    def initial_rect(self):
        st = read_state(self.state_path)
        works = self.win.works()
        scale = self.win.scale(self.hwnd) if self.hwnd else 1.0
        rect = restore_rect(st.get("rect"), works, scale) if st.get("rect") else None
        return (rect or default_rect(works[0], scale)), bool(st.get("maximized")) and rect is not None

    def place(self):
        """Find our window and put it where it belongs. -> True once placed."""
        if self.placed:
            return True
        self.hwnd = self.hwnd or self.win.find(self.pid, self.title)
        if not self.hwnd:
            return False
        rect, maxed = self.initial_rect()
        self.win.place(self.hwnd, *rect)
        if maxed:
            self.win.maximize(self.hwnd)
        self.placed = True
        self.remember()
        return True

    def remember(self):
        """Write {pid, hwnd, rect, maximized}; the rect only while the window is in its normal state."""
        if not self.hwnd:
            return False
        prev = read_state(self.state_path) if self.saved is None else self.saved
        st = {"pid": self.pid, "hwnd": int(self.hwnd), "rect": prev.get("rect"), "maximized": bool(prev.get("maximized"))}
        if not self.win.iconic(self.hwnd):
            st["maximized"] = self.win.zoomed(self.hwnd)
            if not st["maximized"]:
                r = self.win.rect(self.hwnd)
                if r and r[2] > 0 and r[3] > 0:
                    st["rect"] = list(r)
        if st == self.saved:
            return False
        if write_state(self.state_path, st):
            self.saved = st
        return True

    def forget_pid(self):
        st = dict(self.saved or read_state(self.state_path))
        st["pid"], st["hwnd"] = 0, 0
        write_state(self.state_path, st)

    def step(self):
        """One pass. -> 'quit' when the parent is gone."""
        if not pid_alive(self.parent):
            return "quit"
        if not self.placed:
            started = getattr(self, "_t0", None) or time.monotonic()
            self._t0 = started
            placed = self.place()
            # WinForms may only create the handle when the form is shown: show it after a moment either way
            if self.window is not None and not getattr(self, "shown", False) and (placed or time.monotonic() - started > 1.5):
                self.window.show()
                self.shown = True
            return None
        self.remember()
        return None

    def loop(self):
        while True:
            try:
                if self.step() == "quit":
                    if self.window is not None:
                        self.window.destroy()
                    return
            except Exception:  # noqa: BLE001 - never let placement kill the window
                pass
            time.sleep(0.1 if not self.placed else 0.5)


class Api:
    """What the page may call (window.pywebview.api.*). Kept tiny: pywebview exposes every public attribute."""

    def __init__(self, reader):
        self._reader = reader

    def set_title(self, text):
        t = str(text or "").replace("\n", " ").strip()[:80]
        w = self._reader.window
        if w is not None:
            w.set_title((t + " · " + TITLE) if t else TITLE)
        return True

    def open_external(self, url):
        u = str(url or "")
        if not u.startswith(("https://", "http://")) or len(u) > 2000:
            return False
        try:
            os.startfile(u)          # noqa: S606 - the default browser, http(s) only
            return True
        except Exception:  # noqa: BLE001
            return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--parent", type=int, default=0)
    a = ap.parse_args(argv)
    if not a.url.startswith(("http://127.0.0.1", "http://localhost")):
        return 2
    win = Win()
    if focus_window(read_state(a.state), pid_alive, win):
        return 0
    import webview
    reader = Reader(a.state, a.parent, win)
    reader.window = webview.create_window(
        TITLE, a.url, js_api=Api(reader), width=DEFAULT_SIZE[0], height=DEFAULT_SIZE[1], min_size=(MIN_W, MIN_H),
        hidden=True, text_select=True, background_color=BG, focus=True)
    threading.Thread(target=reader.loop, daemon=True).start()
    store = os.path.join(os.path.dirname(os.path.abspath(a.state)), "webview")
    try:
        webview.start(gui="edgechromium", private_mode=False, storage_path=store)
    finally:
        reader.forget_pid()
    return 0


DEFAULT_SIZE = (520, 900)

if __name__ == "__main__":
    sys.exit(main())
