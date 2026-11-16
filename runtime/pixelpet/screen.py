"""Screen sense for the AI tool pixelpet_screen (control command `screen`).

mode=windows  visible top-level windows (title, process, rect, foreground) via EnumWindows. No pixels.
mode=shot     one snapshot of a monitor or a region, scaled down, with a coordinate grid drawn on it,
              returned as base64 JPEG in the command reply. Nothing is written to disk; the pet's own
              windows are hidden for the grab; a small camera pops over the pet's head afterwards.

Coordinates: everything returned (and every region asked for) is in the pet process's own screen
coordinates, the same space `move_to` x / y use. A DPI-unaware process sees scaled ("logical")
coordinates on a high-DPI monitor while window bounds and the grab are physical pixels, so each
monitor is enumerated twice (process context and per-monitor-aware context) and points are mapped
linearly per monitor. When the process is already DPI aware both sets are identical.

The switch lives in settings.json (`screen: true`), re-read on every call: the host refuses first,
this module refuses again.
"""
import base64
import contextlib
import io
import json
import os
import threading

MAX_SIDE = 1280
JPEG_QUALITY = 80
WINDOW_LIMIT = 60
TITLE_MAX = 120
HIDE_DELAY_MS = 150
CAMERA_MS = 1600
GRID_STEPS = (10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000)
SKIP_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"}
REFUSED = "屏幕感知没开（设置页「屏幕感知」）。"


# ---------------------------------------------------------------------------------------- settings
def enabled(data_dir):
    try:
        with open(os.path.join(data_dir, "settings.json"), encoding="utf-8") as f:
            return json.load(f).get("screen") is True
    except (OSError, ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------------------- geometry
def _contains(rect, x, y):
    return rect[0] <= x < rect[2] and rect[1] <= y < rect[3]


def _nearest(mons, x, y, key):
    """Monitor whose `key` rect contains (x, y), else the closest one."""
    for m in mons:
        if _contains(m[key], x, y):
            return m

    def dist(m):
        r = m[key]
        dx = max(r[0] - x, 0, x - r[2])
        dy = max(r[1] - y, 0, y - r[3])
        return dx * dx + dy * dy
    return min(mons, key=dist)


def _map(x, y, src, dst):
    sw, sh = max(1, src[2] - src[0]), max(1, src[3] - src[1])
    dw, dh = dst[2] - dst[0], dst[3] - dst[1]
    return dst[0] + (x - src[0]) * dw / sw, dst[1] + (y - src[1]) * dh / sh


def to_logical(x, y, mons):
    """Physical pixel -> pet coordinates."""
    m = _nearest(mons, x, y, "physical")
    return _map(x, y, m["physical"], m["logical"])


def to_physical(x, y, mons):
    """Pet coordinates -> physical pixel."""
    m = _nearest(mons, x, y, "logical")
    return _map(x, y, m["logical"], m["physical"])


def rect_to_logical(rect, mons):
    """Physical (l, t, r, b) -> pet (l, t, r, b), mapped through the monitor holding its centre."""
    m = _nearest(mons, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, "physical")
    l, t = _map(rect[0], rect[1], m["physical"], m["logical"])
    r, b = _map(rect[2], rect[3], m["physical"], m["logical"])
    return round(l), round(t), round(r), round(b)


def rect_to_physical(rect, mons):
    m = _nearest(mons, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, "logical")
    l, t = _map(rect[0], rect[1], m["logical"], m["physical"])
    r, b = _map(rect[2], rect[3], m["logical"], m["physical"])
    return round(l), round(t), round(r), round(b)


def bounds(mons, key="logical"):
    rs = [m[key] for m in mons]
    return min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs)


def public_monitors(mons):
    out = []
    for m in mons:
        l, t, r, b = m["logical"]
        pw = m["physical"][2] - m["physical"][0]
        out.append({"index": m["index"], "x": l, "y": t, "w": r - l, "h": b - t, "primary": bool(m.get("primary")),
                    "scale": round(pw / float(max(1, r - l)), 3)})
    return out


def target_rect(body, mons, pet_point):
    """-> ((l, t, r, b) in pet coordinates, None) or (None, refusal)."""
    vb = bounds(mons)
    region = body.get("region")
    if region is not None:
        try:
            x, y, w, h = (float(region[k]) for k in ("x", "y", "w", "h"))
        except (KeyError, TypeError, ValueError):
            return None, "region 要有数字 x、y、w、h。"
        l, t = max(vb[0], x), max(vb[1], y)
        r, b = min(vb[2], x + w), min(vb[3], y + h)
        if r - l < 16 or b - t < 16:
            return None, "region 太小或不在屏幕上。"
        return (round(l), round(t), round(r), round(b)), None
    mon = body.get("monitor")
    if mon is not None:
        if mon == -1:
            return vb, None
        hit = [m for m in mons if m["index"] == mon]
        if not hit:
            return None, "没有这个显示器。可用：%s（-1 = 全部）。" % ", ".join(str(m["index"]) for m in mons)
        return tuple(hit[0]["logical"]), None
    return tuple(_nearest(mons, pet_point[0], pet_point[1], "logical")["logical"]), None


def grid_step(span, target=10):
    """A round step giving about `target` lines across `span` pet pixels."""
    for s in GRID_STEPS:
        if span / s <= target:
            return s
    return GRID_STEPS[-1]


def fit(size, max_side=MAX_SIDE):
    w, h = size
    k = min(1.0, float(max_side) / max(w, h))
    return max(1, round(w * k)), max(1, round(h * k))


def draw_grid(image, rect, step=None):
    """Grid lines every `step` pet pixels over an image showing `rect`; ticks labelled in pet coordinates.
    -> (RGB image, step)."""
    from PIL import Image, ImageDraw, ImageFont
    l, t, r, b = rect
    iw, ih = image.size
    sx, sy = iw / float(r - l), ih / float(b - t)
    step = step or grid_step(max(r - l, b - t))
    base = image.convert("RGBA")
    over = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    try:
        font = ImageFont.load_default(size=max(10, min(14, iw // 90)))
    except TypeError:                    # Pillow < 10.1
        font = ImageFont.load_default()
    line = (255, 40, 200, 110)
    major = (255, 40, 200, 170)
    gx = (l // step + 1) * step if l % step else l
    xs = []
    while gx < r:
        px = round((gx - l) * sx)
        xs.append((px, gx))
        d.line([(px, 0), (px, ih)], fill=major if gx % (step * 5) == 0 else line, width=1)
        gx += step
    gy = (t // step + 1) * step if t % step else t
    ys = []
    while gy < b:
        py = round((gy - t) * sy)
        ys.append((py, gy))
        d.line([(0, py), (iw, py)], fill=major if gy % (step * 5) == 0 else line, width=1)
        gy += step

    def label(x, y, text):
        box = d.textbbox((x, y), text, font=font)
        d.rectangle((box[0] - 2, box[1] - 1, box[2] + 2, box[3] + 1), fill=(20, 20, 28, 200))
        d.text((x, y), text, fill=(255, 255, 255, 255), font=font)
    for px, v in xs:
        label(px + 2, 1, str(int(v)))
    for py, v in ys:
        label(1, py + 2, str(int(v)))
    return Image.alpha_composite(base, over).convert("RGB"), step


def encode_jpeg(image, quality=JPEG_QUALITY):
    out = io.BytesIO()
    image.convert("RGB").save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def render_shot(image, rect, max_side=MAX_SIDE):
    """Grabbed image of `rect` -> reply data (scaled, grid, base64 JPEG). The input is not kept."""
    from PIL import Image
    small = image.convert("RGB").resize(fit(image.size, max_side), Image.Resampling.LANCZOS)
    gridded, step = draw_grid(small, rect)
    data = encode_jpeg(gridded)
    l, t, r, b = rect
    return {"region": {"x": l, "y": t, "w": r - l, "h": b - t}, "grid": step,
            "image": {"mediaType": "image/jpeg", "width": gridded.width, "height": gridded.height,
                      "base64": base64.b64encode(data).decode("ascii")},
            "perPixel": round((r - l) / float(gridded.width), 3)}


# ---------------------------------------------------------------------------------------- Win32
@contextlib.contextmanager
def per_monitor_aware():
    """Run the block with the thread in per-monitor DPI awareness (physical pixels); no-op elsewhere."""
    u = old = None
    if os.name == "nt":
        try:
            import ctypes
            u = ctypes.windll.user32
            u.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
            u.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            old = u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            old = None
    try:
        yield
    finally:
        if old:
            try:
                u.SetThreadDpiAwarenessContext(ctypes.c_void_p(old))
            except Exception:  # noqa: BLE001
                pass


def _enum_monitors():
    import ctypes
    from ctypes import wintypes as wt
    u = ctypes.windll.user32

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]
    found = []
    proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)

    def cb(hmon, _hdc, _rect, _lp):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if u.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            r, w = mi.rcMonitor, mi.rcWork
            found.append((int(hmon or 0), (r.left, r.top, r.right, r.bottom), (w.left, w.top, w.right, w.bottom),
                          bool(mi.dwFlags & 1)))
        return True
    u.EnumDisplayMonitors(None, None, proc(cb), 0)
    return found


def monitors():
    """[{index, logical, work, physical, primary}], primary first. [] off Windows."""
    if os.name != "nt":
        return []
    try:
        logical = _enum_monitors()
        with per_monitor_aware():
            physical = {h: r for h, r, _w, _p in _enum_monitors()}
    except Exception:  # noqa: BLE001
        return []
    logical.sort(key=lambda m: (not m[3], m[1][0], m[1][1]))
    return [{"index": i, "logical": r, "work": w, "physical": physical.get(h, r), "primary": p}
            for i, (h, r, w, p) in enumerate(logical)]


def _raw_windows():
    """Every top-level window with what the filter needs; rects physical."""
    import ctypes
    from ctypes import wintypes as wt
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    dwm = ctypes.windll.dwmapi
    fg = u.GetForegroundWindow()
    names = {}

    def process_name(pid):
        if pid in names:
            return names[pid]
        name = ""
        h = k.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            try:
                buf = ctypes.create_unicode_buffer(520)
                n = wt.DWORD(520)
                if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                    name = os.path.basename(buf.value)
            finally:
                k.CloseHandle(h)
        names[pid] = name
        return name
    out = []
    proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd, _lp):
        try:
            n = u.GetWindowTextLengthW(hwnd)
            title = ""
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                title = buf.value
            cls = ctypes.create_unicode_buffer(128)
            u.GetClassNameW(hwnd, cls, 128)
            pid = wt.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            cloaked = ctypes.c_int(0)
            dwm.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
            rect = wt.RECT()
            if dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
                u.GetWindowRect(hwnd, ctypes.byref(rect))
            ex = u.GetWindowLongW(hwnd, -20)
            out.append({"title": title, "cls": cls.value, "pid": pid.value, "visible": bool(u.IsWindowVisible(hwnd)),
                        "iconic": bool(u.IsIconic(hwnd)), "cloaked": bool(cloaked.value),
                        "tool": bool(ex & 0x80) and not (ex & 0x40000), "owned": bool(u.GetWindow(hwnd, 4)),
                        "rect": (rect.left, rect.top, rect.right, rect.bottom), "foreground": hwnd == fg,
                        "process": "", "_pid": pid.value})
        except Exception:  # noqa: BLE001
            pass
        return True
    with per_monitor_aware():
        u.EnumWindows(proc(cb), 0)
    for w in out:
        if w["visible"] and not w["cloaked"] and w["title"].strip():
            w["process"] = process_name(w["_pid"])
    return out


def pick_windows(raw, own_pid, mons, limit=WINDOW_LIMIT):
    """Raw top-level windows (z-order, top first) -> what the AI gets, in pet coordinates."""
    out = []
    for w in raw:
        if (not w.get("visible") or w.get("iconic") or w.get("cloaked") or w.get("tool") or w.get("owned")
                or w.get("pid") == own_pid or w.get("cls") in SKIP_CLASSES or not str(w.get("title") or "").strip()):
            continue
        l, t, r, b = w["rect"]
        if r - l < 40 or b - t < 30:
            continue
        if mons:
            vb = bounds(mons, "physical")
            if r <= vb[0] or l >= vb[2] or b <= vb[1] or t >= vb[3]:
                continue
            l, t, r, b = rect_to_logical((l, t, r, b), mons)
            mon = _nearest(mons, (l + r) / 2, (t + b) / 2, "logical")["index"]
        else:
            mon = 0
        out.append({"title": str(w["title"])[:TITLE_MAX], "process": w.get("process") or "",
                    "x": l, "y": t, "w": r - l, "h": b - t, "foreground": bool(w.get("foreground")), "monitor": mon})
        if len(out) >= limit:
            break
    return out


def real_grab(bbox):
    """Physical (l, t, r, b) -> PIL image of that part of the desktop."""
    from PIL import ImageGrab
    with per_monitor_aware():
        return ImageGrab.grab(bbox=bbox, all_screens=True)


# ---------------------------------------------------------------------------------------- camera
CAMERA = ["  ####      ",
          "############",
          "#####ww#####",
          "####wooW####",
          "###wobbow###",
          "###wobbow###",
          "####woow####",
          "#####ww#####",
          "############"]
CAMERA_COLOURS = {"#": "#2B2F3A", "w": "#F4F4F8", "W": "#F4F4F8", "o": "#7FD8FF", "b": "#1D4E89"}


class CameraBadge:
    """A tiny pixel camera over the pet's head for a moment. Click-through, never takes focus."""

    def __init__(self, app, ms=CAMERA_MS, px=3):
        import tkinter as tk
        from . import window as W
        w, h = len(CAMERA[0]) * px, len(CAMERA) * px
        self.win = tk.Toplevel(app.root)
        W.overlay(self.win, w, h, topmost=True)
        cv = self.win.winfo_children()[0]
        for y, row in enumerate(CAMERA):
            for x, ch in enumerate(row):
                if ch in CAMERA_COLOURS:
                    cv.create_rectangle(x * px, y * px, x * px + px - 1, y * px + px - 1, fill=CAMERA_COLOURS[ch], width=0)
        l, t, r, _b = app.body_screen()
        self.win.geometry("%dx%d%+d%+d" % (w, h, (l + r) // 2 - w // 2, t - h - 6))
        W.click_through(self.win)
        self.win.after(ms, self.close)

    def close(self):
        try:
            self.win.destroy()
        except Exception:  # noqa: BLE001
            pass


def show_camera(app):
    hook = getattr(app, "show_camera", None)
    if callable(hook):
        return hook()
    try:
        return CameraBadge(app)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------------------- command
def _monitors_for(app):
    hook = getattr(app, "screen_monitors", None)
    if callable(hook):
        return hook()
    if app.offscreen:
        return []
    return monitors()


def _pet_point(app):
    l, t, r, b = app.body_screen()
    return (l + r) / 2.0, float(b)


def _pet_windows(app):
    ws = [app.root] + list(getattr(app.bubble, "windows", []) or [])
    hub = getattr(app, "hub", None)
    if hub is not None:
        ws += [getattr(hub, "win", None), getattr(hub, "chip", None), getattr(getattr(hub, "tip", None), "win", None)]
    ws += [getattr(w, "win", None) for w in (getattr(app, "furniture", {}) or {}).values()]
    return [w for w in ws if w is not None]


def command(app, body):
    """UI thread. -> (ok, message, pending|None, data)."""
    if not enabled(app.data_dir):
        return False, REFUSED, None
    mode = body.get("mode")
    mons = _monitors_for(app)
    px, py = _pet_point(app)
    pet = {"x": round(px), "y": round(py)}
    if mode == "windows":
        raw_hook = getattr(app, "screen_windows", None)
        raw = raw_hook() if callable(raw_hook) else ([] if app.offscreen else _raw_windows())
        ws = pick_windows(raw, os.getpid(), mons)
        return True, "%d 个窗口。" % len(ws), None, {"windows": ws, "monitors": public_monitors(mons), "pet": pet}
    if mode != "shot":
        return False, "mode 用 windows 或 shot。", None
    grab = getattr(app, "screen_grab", None)
    if not callable(grab):
        grab = None if app.offscreen else real_grab
    if grab is None or not mons:
        return False, "现在拍不了屏幕。", None
    rect, refusal = target_rect(body, mons, (px, py))
    if rect is None:
        return False, refusal, None
    phys = rect_to_physical(rect, mons)
    hide = body.get("hidePet", True) is not False
    data = {"monitors": public_monitors(mons), "pet": pet}
    pending = {"event": threading.Event(), "result": None}
    hidden = []

    def finish(ok, message):
        pending["result"] = (ok, message)
        pending["event"].set()

    def encode(image):
        try:
            data.update(render_shot(image, rect))
            finish(True, "拍好了：%d×%d，网格每 %d 像素。" % (data["image"]["width"], data["image"]["height"], data["grid"]))
        except Exception as exc:  # noqa: BLE001
            finish(False, "截图处理失败：%s" % type(exc).__name__)

    def shoot():
        image = None
        try:
            image = grab(phys)
        except Exception as exc:  # noqa: BLE001
            finish(False, "截图失败：%s" % type(exc).__name__)
        finally:
            for w in hidden:
                try:
                    w.deiconify()
                except Exception:  # noqa: BLE001
                    pass
            if hidden:
                try:
                    from . import window as W
                    W.native_flags(app.root)
                    app.root.attributes("-topmost", app.topmost)
                    for f in (getattr(app, "furniture", {}) or {}).values():
                        f.below(app.hwnd)
                except Exception:  # noqa: BLE001
                    pass
            show_camera(app)
        if image is not None:
            threading.Thread(target=encode, args=(image,), daemon=True).start()

    if hide:
        for w in _pet_windows(app):
            try:
                if w.winfo_viewable():
                    w.withdraw()
                    hidden.append(w)
            except Exception:  # noqa: BLE001
                pass
    app.root.after(HIDE_DELAY_MS if hidden else 1, shoot)
    return True, "拍照中。", pending, data
