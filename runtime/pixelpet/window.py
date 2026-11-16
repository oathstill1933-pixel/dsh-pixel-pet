"""Tk transparent overlay windows + the few Win32 calls the pet needs.

Colour key #FF00FF with binary alpha (alpha >= 128 -> opaque) so no edge pixel ever blends with
magenta. Windows get WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW: they never steal focus and stay off
the taskbar / Alt-Tab. Every Win32 call degrades to plain Tk when unavailable.
"""
import os

TRANSPARENT = "#FF00FF"
KEY_RGB = (255, 0, 255)
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
GWL_EXSTYLE = -20
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0004, 0x0010


def _user32():
    import ctypes
    return ctypes, ctypes.windll.user32


def flatten(im, factor=1.0):
    """RGBA PIL image -> RGB on the key colour, nearest-neighbour scaled, binary alpha."""
    from PIL import Image
    if abs(factor - 1) > .001:
        im = im.resize((max(8, round(im.width * factor)), max(8, round(im.height * factor))), Image.Resampling.NEAREST)
    flat = Image.new("RGB", im.size, KEY_RGB)
    flat.paste(im.convert("RGB"), mask=im.getchannel("A").point(lambda v: 255 if v >= 128 else 0))
    return flat


def photo(im, factor=1.0):
    from PIL import ImageTk
    return ImageTk.PhotoImage(flatten(im, factor))


def overlay(win, w, h, topmost=True):
    """Turn a Tk/Toplevel into a borderless colour-keyed window with one canvas. -> (win, canvas)."""
    import tkinter as tk
    win.overrideredirect(True)
    win.attributes("-topmost", bool(topmost))
    try:
        win.attributes("-transparentcolor", TRANSPARENT)
    except tk.TclError:           # non-Windows Tk: no colour key, still runs
        pass
    win.config(bg=TRANSPARENT)
    cv = tk.Canvas(win, width=w, height=h, bg=TRANSPARENT, highlightthickness=0, bd=0)
    cv.pack()
    win.update_idletasks()
    # Mapping a withdrawn Tk window can rebuild/reset its native window state.
    win._overlay_topmost = bool(topmost)
    def mapped(event):
        if event.widget is win:
            win.after_idle(lambda: sync_topmost(win, win._overlay_topmost))
    win.bind("<Map>", mapped, add="+")
    return win, cv


def hwnd_of(win):
    try:
        return int(str(win.frame()), 16)
    except Exception:  # noqa: BLE001
        return None


def native_flags(win):
    """Apply NOACTIVATE | TOOLWINDOW. -> hwnd or None."""
    hwnd = hwnd_of(win)
    if os.name != "nt" or not hwnd:
        return hwnd
    try:
        _, u = _user32()
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, u.GetWindowLongW(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    except Exception:  # noqa: BLE001
        pass
    return hwnd


def tool_flags(win):
    """TOOLWINDOW only (off the taskbar) but focusable: for windows that take typing. -> hwnd or None."""
    hwnd = hwnd_of(win)
    if os.name != "nt" or not hwnd:
        return hwnd
    try:
        _, u = _user32()
        st = u.GetWindowLongW(hwnd, GWL_EXSTYLE)
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, (st | WS_EX_TOOLWINDOW) & ~WS_EX_NOACTIVATE)
    except Exception:  # noqa: BLE001
        pass
    return hwnd


def click_through(win):
    """NOACTIVATE | TOOLWINDOW | LAYERED | TRANSPARENT: the mouse goes to whatever is underneath."""
    hwnd = hwnd_of(win)
    if os.name != "nt" or not hwnd:
        return hwnd
    try:
        _, u = _user32()
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, u.GetWindowLongW(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE
                         | WS_EX_TOOLWINDOW | 0x00080000 | 0x00000020)
    except Exception:  # noqa: BLE001
        pass
    return hwnd


def virtual_screen(win=None):
    """(x, y, w, h) of the whole desktop across monitors, in this process's coordinates."""
    if os.name == "nt":
        try:
            _, u = _user32()
            r = tuple(int(u.GetSystemMetrics(i)) for i in (76, 77, 78, 79))
            if r[2] > 0 and r[3] > 0:
                return r
        except Exception:  # noqa: BLE001
            pass
    if win is not None:
        return 0, 0, win.winfo_screenwidth(), win.winfo_screenheight()
    return 0, 0, 1920, 1080


def set_pos(win, hwnd, x, y):
    if os.name == "nt" and hwnd:
        try:
            _, u = _user32()
            u.SetWindowPos(hwnd, 0, int(x), int(y), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
            return
        except Exception:  # noqa: BLE001
            pass
    win.geometry("%+d%+d" % (int(x), int(y)))


def z_below(hwnd, above_hwnd):
    if os.name != "nt" or not hwnd or not above_hwnd:
        return
    try:
        _, u = _user32()
        u.SetWindowPos(hwnd, above_hwnd, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
    except Exception:  # noqa: BLE001
        pass


def ensure_below(win, above_win):
    """Repair relative overlay order without changing bands or moving already ordered windows."""
    hwnd, above_hwnd = hwnd_of(win), hwnd_of(above_win)
    if os.name != "nt" or not hwnd or not above_hwnd or hwnd == above_hwnd:
        return
    try:
        ct, u = _user32()
        from ctypes import wintypes as wt
        u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        u.GetWindow.restype = wt.HWND
        u.GetWindowLongW.argtypes = [wt.HWND, ct.c_int]
        u.IsWindowVisible.argtypes = [wt.HWND]
        if not u.IsWindowVisible(hwnd) or not u.IsWindowVisible(above_hwnd):
            return  # the pet can be hidden inside occupied furniture
        if (u.GetWindowLongW(hwnd, GWL_EXSTYLE) ^ u.GetWindowLongW(above_hwnd, GWL_EXSTYLE)) & 8:
            return  # band reconciliation must happen first; never demote a whole owner group here
        cur, seen = u.GetWindow(hwnd, 3), set()
        while cur and cur not in seen:
            if cur == above_hwnd:
                return
            seen.add(cur)
            cur = u.GetWindow(cur, 3)
        z_below(hwnd, above_hwnd)
    except Exception as exc:  # noqa: BLE001
        _debug("zorder.below", exc)


def force_topmost(win, on=True):
    """重启后置顶要点两次才生效的问题：用原生 SetWindowPos 直接把窗口顶到最上层。

    背景：native_flags() 会改写 GWL_EXSTYLE，改完扩展样式以后 Tk 的 -topmost 有时不落地
    （窗口还在普通层，只有卡片那种自己用 SetWindowPos 的窗口在上头）。
    这里绕过 Tk，直接下 HWND_TOPMOST / HWND_NOTOPMOST。-> hwnd or None
    """
    hwnd = hwnd_of(win)
    if os.name != "nt" or not hwnd:
        return hwnd
    try:
        _, u = _user32()
        u.SetWindowPos(hwnd, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x10)  # NOSIZE|NOMOVE|NOACTIVATE
        if on:
            yield_to_system_popups(hwnd)
    except Exception:  # noqa: BLE001
        pass
    return hwnd


def topmost_matches(hwnd, on=True):
    """Check the native bit AND the visible Z-order band; Tk's cached flag is insufficient."""
    if os.name != "nt" or not hwnd:
        return True
    try:
        ct, u = _user32()
        from ctypes import wintypes as wt
        u.GetWindowLongW.argtypes = [wt.HWND, ct.c_int]
        u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        u.GetWindow.restype = wt.HWND
        u.IsWindowVisible.argtypes = [wt.HWND]
        if bool(u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 8) != bool(on):
            return False
        if on and u.IsWindowVisible(hwnd):
            above = u.GetWindow(hwnd, 3)  # GW_HWNDPREV
            seen = set()
            while above and above not in seen:
                seen.add(above)
                if u.IsWindowVisible(above) and not (u.GetWindowLongW(above, GWL_EXSTYLE) & 8):
                    return False
                above = u.GetWindow(above, 3)
        return True
    except Exception as exc:  # noqa: BLE001
        _debug("topmost.check", exc)
        return False


def sync_topmost(win, on=True):
    """Reconcile only when necessary, without activating or continually raising healthy windows."""
    previous = getattr(win, "_overlay_topmost", None)
    win._overlay_topmost = bool(on)
    # On Windows Tk even querying wm attributes can reapply TOPMOST and raise the window.
    # Keep the requested Tk state locally; check the actual state exclusively through Win32.
    if previous is None or previous != bool(on):
        win.attributes("-topmost", bool(on))
    if not topmost_matches(hwnd_of(win), on):
        force_topmost(win, on)
    if on:
        yield_to_system_popups(hwnd_of(win))


# These transient classes are distinct from ordinary application windows. Keep the taskbar usable too.
SYSTEM_POPUP_CLASSES = frozenset({
    "#32768", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    "Xaml_WindowedPopupClass", "ControlCenterWindow", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
})
_popup_cache = (0.0, ())


def system_popups():
    """Visible native topmost menus / shell flyouts, front to back; cache for one UI polling interval."""
    global _popup_cache
    if os.name != "nt":
        return ()
    import time
    now = time.monotonic()
    if now - _popup_cache[0] < .1:
        return _popup_cache[1]
    try:
        ct, u = _user32()
        from ctypes import wintypes as wt
        u.IsWindowVisible.argtypes = [wt.HWND]
        u.GetWindowLongW.argtypes = [wt.HWND, ct.c_int]
        u.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ct.c_int]
        found = []
        callback = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        @callback
        def visit(hwnd, _):
            if u.IsWindowVisible(hwnd) and u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 8:
                name = ct.create_unicode_buffer(128)
                u.GetClassNameW(hwnd, name, len(name))
                if name.value in SYSTEM_POPUP_CLASSES:
                    found.append(hwnd)
            return True
        u.EnumWindows(visit, 0)
        _popup_cache = (now, tuple(found))
    except Exception as exc:  # noqa: BLE001
        _debug("popups.scan", exc)
        _popup_cache = (now, ())
    return _popup_cache[1]


def yield_to_system_popups(hwnd):
    """Move only our overlay behind protected popups; never modify another app's styles or focus."""
    if os.name != "nt" or not hwnd:
        return
    try:
        ct, u = _user32()
        from ctypes import wintypes as wt
        u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        u.GetWindow.restype = wt.HWND
        u.GetWindowLongW.argtypes = [wt.HWND, ct.c_int]
        u.IsWindowVisible.argtypes = [wt.HWND]
        if not u.IsWindowVisible(hwnd) or not u.GetWindowLongW(hwnd, GWL_EXSTYLE) & 8:
            return
        for popup in system_popups():
            if popup == hwnd or not u.IsWindowVisible(popup) or not u.GetWindowLongW(popup, GWL_EXSTYLE) & 8:
                continue
            above, seen = u.GetWindow(hwnd, 3), set()
            while above and above != popup and above not in seen:
                seen.add(above)
                above = u.GetWindow(above, 3)
            if above != popup:
                z_below(hwnd, popup)
    except Exception as exc:  # noqa: BLE001
        _debug("popups.yield", exc)


def monitor_at(x, y):
    """((monitor rect), (work rect)) of the monitor nearest to a point, or None."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes as wt
        u = ctypes.windll.user32

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]
        u.MonitorFromPoint.argtypes = [wt.POINT, wt.DWORD]
        u.MonitorFromPoint.restype = wt.HMONITOR
        hmon = u.MonitorFromPoint(wt.POINT(int(x), int(y)), 2)
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        u.GetMonitorInfoW(hmon, ctypes.byref(mi))
        r, w = mi.rcMonitor, mi.rcWork
        return (r.left, r.top, r.right, r.bottom), (w.left, w.top, w.right, w.bottom)
    except Exception:  # noqa: BLE001
        return None


def foreground_rect():
    """Foreground window rect (own process excluded). Reads geometry only."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes as wt
        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wt.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid():
            return None
        buf = ctypes.create_unicode_buffer(64)
        u.GetClassNameW(hwnd, buf, 64)
        if buf.value in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"):
            return None
        rect = wt.RECT()
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
            u.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect.left, rect.top, rect.right, rect.bottom
    except Exception:  # noqa: BLE001
        return None


def foreground_fullscreen():
    if os.name != "nt":
        return False
    try:
        import ctypes
        st = ctypes.c_int(0)
        if ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(st)) == 0 and st.value in (2, 3, 4):
            return True
    except Exception as exc:  # noqa: BLE001
        _debug("fullscreen.notify", exc)
    # 高 DPI：窗口矩形和显示器矩形都按物理像素取，否则缩放 150% 时永远判不成全屏
    from .screen import per_monitor_aware
    with per_monitor_aware():
        rect = foreground_rect()
        if not rect:
            return False
        mon = monitor_at((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
    return bool(mon) and rect[0] <= mon[0][0] and rect[1] <= mon[0][1] and rect[2] >= mon[0][2] and rect[3] >= mon[0][3]


# ------------------------------------------------------------------ 异常日志：限频，只记异常类型
_DEBUG_EVERY = 300.0
_debug_at = {}


def _debug(where, exc):
    """每个位置最多 5 分钟记一次，只记异常类型名——绝不记标题、路径或异常文本。"""
    import logging
    import time
    now = time.monotonic()
    if now - _debug_at.get(where, -1e9) < _DEBUG_EVERY:
        return
    _debug_at[where] = now
    logging.getLogger("pixelpet.window").debug("%s failed: %s", where, type(exc).__name__)


def foreground_app():
    """前台窗口 -> {"process": 小写进程名, "class": 窗口类名, "video_hint": bool} 或 None。

    标题只在这里读一次、跟 activity.VIDEO_TITLE_HINTS 比对完就丢弃；完整标题和 exe 路径都不出这个函数。
    只读查询：不注入、不抓画面。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes as wt
        from .activity import VIDEO_TITLE_HINTS
        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wt.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value or pid.value == os.getpid():
            return None
        cls = ctypes.create_unicode_buffer(64)
        u.GetClassNameW(hwnd, cls, 64)
        if cls.value in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"):
            return None
        hint = False
        n = u.GetWindowTextLengthW(hwnd)
        if n > 0:
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            low = buf.value.lower()
            hint = any(h in low for h in VIDEO_TITLE_HINTS)
            del low
            ctypes.memset(buf, 0, ctypes.sizeof(buf))
        process = ""
        try:
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)   # QUERY_LIMITED_INFORMATION
            if handle:
                try:
                    size = wt.DWORD(1024)
                    path = ctypes.create_unicode_buffer(1024)
                    if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                        process = path.value.rsplit("\\", 1)[-1].lower()
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)
        except Exception as exc:  # noqa: BLE001
            _debug("foreground.process", exc)
        return {"process": process, "class": cls.value, "video_hint": hint}
    except Exception as exc:  # noqa: BLE001
        _debug("foreground", exc)
        return None


def running_processes():
    """当前在跑的进程名（小写、去重）。只取名字：不读命令行、不开进程句柄。"""
    if os.name != "nt":
        return frozenset()
    try:
        import ctypes
        from ctypes import wintypes as wt

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                        ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                        ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                        ("szExeFile", ctypes.c_wchar * 260)]
        k = ctypes.windll.kernel32
        k.CreateToolhelp32Snapshot.restype = wt.HANDLE
        snap = k.CreateToolhelp32Snapshot(0x2, 0)                 # TH32CS_SNAPPROCESS
        if not snap or snap == wt.HANDLE(-1).value:
            return frozenset()
        names = set()
        try:
            e = PROCESSENTRY32W()
            e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = k.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                names.add(e.szExeFile.lower())
                ok = k.Process32NextW(snap, ctypes.byref(e))
        finally:
            k.CloseHandle(snap)
        return frozenset(names)
    except Exception as exc:  # noqa: BLE001
        _debug("processes", exc)
        return frozenset()


def reduced_motion_system():
    if os.name != "nt":
        return False
    try:
        import ctypes
        on = ctypes.c_int(1)
        ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(on), 0)   # SPI_GETCLIENTAREAANIMATION
        return not bool(on.value)
    except Exception:  # noqa: BLE001
        return False
