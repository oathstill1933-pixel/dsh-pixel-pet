"""「一起听歌」小卡片窗口：pywebview（WebView2）无边框透明置顶窗口，加载宿主的 /card 页面。

    python -m pixelmusic.cardwin --url http://127.0.0.1:3080/dsh-pixel-pet/card --dock <data>/card-dock.json --parent <pet pid>

Started and stopped by the pet runtime (runtime/pixelpet/card_host.py). The pet writes its body box,
work area and visibility to the dock file; this process places itself beside the pet with the same
geometry as before (pixelpet.card_dock.dock_rect / mini_rect). The page talks to us via js_api:
set_mode('mini'|'full') and close(). Exit code 3 = closed by the user (the pet then stops
auto-opening for this session). Exits on its own when the pet process is gone.

Needs pywebview + pythonnet (settings.listen.python env, see docs/MUSIC_CONTRACT.md). No PIL, no paths logged.
"""
import argparse
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))          # runtime/ -> pixelpet.card_dock
from pixelpet.card_dock import CARD_H, CARD_W, MINI_PX, dock_rect, mini_rect  # noqa: E402
from pixelpet import window as pet_windows

TITLE = "pet-listen-card"
PAD = 14            # transparent margin around the full card for its CSS shadow (css px)
MINI_PAD = 6
EXIT_DISMISSED = 3
RADIUS = 18
ANIM_S = 0.3        # collapse/expand; the page animates its record with the same duration + ease-out cubic
GO_WAIT_S = 0.5     # how long a prepared morph waits for the page's go()


def box_for(mode, scale):
    """Window size (physical px) and the visible part's offset inside it, for a mode."""
    if mode == "mini":
        d = round((MINI_PX + 2 * MINI_PAD) * scale)
        return (d, d), round(MINI_PAD * scale), (round(MINI_PX * scale),) * 2
    return ((round((CARD_W + 2 * PAD) * scale), round((CARD_H + 2 * PAD) * scale)), round(PAD * scale),
            (round(CARD_W * scale), round(CARD_H * scale)))


def target(dock, mode, scale, side):
    """dock = {'body': [l,t,r,b], 'work': [l,t,r,b]} -> (x, y, w, h, side) of the window."""
    (w, h), pad, vis = box_for(mode, scale)
    body, work = tuple(dock["body"]), tuple(dock["work"])
    if mode == "mini":
        x, y, side = mini_rect(body, vis[0], work, side)
    else:
        x, y, side = dock_rect(body, vis, work, side)
    return x - pad, y - pad, w, h, side


def layout(dock, scale, side):
    """The window is always the full card's size (so expanding never resizes it). The mini record is a
    circle inside it, at the spot mini_rect wants on screen (clamped into the window).
    -> ((x, y, w, h), side, circle (l, t, r, b), card (l, t, r, b), corner) in window px."""
    x, y, w, h, side = target(dock, "full", scale, side)
    d = round(MINI_PX * scale)
    mx, my, _ = mini_rect(tuple(dock["body"]), d, tuple(dock["work"]), side)
    ox, oy = max(0, min(mx - x, w - d)), max(0, min(my - y, h - d))
    pad = round(PAD * scale)
    return (x, y, w, h), side, (ox, oy, ox + d, oy + d), (pad, pad, w - pad, h - pad), round(RADIUS * scale * 2)


def shape_for(mode, circle, card, corner):
    """Window region as (l, t, r, b, corner): a circle is a round rect whose corner = its diameter."""
    return circle + (circle[2] - circle[0],) if mode == "mini" else card + (corner,)


def ease_out(t):
    return 1 - (1 - t) ** 3


def lerp_shape(a, b, t):
    k = ease_out(max(0.0, min(1.0, t)))
    return tuple(round(p + (q - p) * k) for p, q in zip(a, b))


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
    """The few Win32 calls on our own window."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes as wt
        self.ct, self.wt, self.u = ctypes, wt, ctypes.windll.user32
        self.u.FindWindowW.restype = wt.HWND
        self.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.UINT]
        self.u.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
        self.u.SetWindowLongW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_long]
        self.hwnd = None
        self._styled = False

    def find(self):
        self.hwnd = self.hwnd or (self.u.FindWindowW(None, TITLE) or None)
        if self.hwnd and not self._styled:   # tool window: no taskbar button, no Alt-Tab
            ex = self.u.GetWindowLongW(self.hwnd, -20)
            self.u.SetWindowLongW(self.hwnd, -20, (ex | 0x80) & ~0x40000)
            self._styled = True
        return self.hwnd

    def shape(self, l, t, r, b, corner):
        """Window region = the visible card / record (round rect; corner = diameter -> circle). pywebview's
        WinForms `transparent` leaves the form's grey showing and a colour key makes WebView2 click-through,
        so a region does both shape and hit-test."""
        g = self.ct.windll.gdi32
        rgn = g.CreateRoundRectRgn(int(l), int(t), int(r) + 1, int(b) + 1, int(corner), int(corner))
        if rgn and not self.u.SetWindowRgn(self.hwnd, rgn, True):
            g.DeleteObject(rgn)

    def scale(self):
        try:
            return (self.u.GetDpiForWindow(self.hwnd) or 96) / 96
        except Exception:  # noqa: BLE001
            return 1.0

    def own(self, owner):
        """Make the card an owned window of the pet (GWLP_HWNDPARENT): Windows then keeps it directly above
        its owner, so it is covered together with the pet and never floats alone over other apps."""
        if not owner or owner == getattr(self, "_owner", None):
            return
        try:
            set_long = self.u.SetWindowLongPtrW
            set_long.argtypes = [self.wt.HWND, self.ct.c_int, self.ct.c_ssize_t]
            set_long(self.hwnd, -8, int(owner))
            # Do not demote an owned card here: HWND_NOTOPMOST also demotes its owner (the pet).
            # place() applies the requested setting next; invalidate the cache after binding an owner.
            self._owner, self._topmost = owner, None
        except Exception:  # noqa: BLE001
            pass

    def place(self, x, y, w, h, topmost=True, owned=False):
        if owned:
            # Tk's -topmost on the pet does not carry its owned windows along, so mirror the pet's topmost bit
            # ourselves whenever it changes; otherwise only move / size and leave z-order to the owner.
            self.sync_topmost(topmost)
            self.u.SetWindowPos(self.hwnd, None, int(x), int(y), int(w), int(h), 0x10 | 0x4)   # NOACTIVATE | NOZORDER
            return
        self.u.SetWindowPos(self.hwnd, -1 if topmost else -2, int(x), int(y), int(w), int(h), 0x10)   # NOACTIVATE

    def sync_topmost(self, on):
        # WebView/WinForms can reset native state after startup; never trust only our cached value.
        if not pet_windows.topmost_matches(self.hwnd, on):
            if self.u.SetWindowPos(self.hwnd, -1 if on else -2, 0, 0, 0, 0, 0x13):
                self._topmost = bool(on)
        if on:
            pet_windows.yield_to_system_popups(self.hwnd)

    def show(self, on):
        self.u.ShowWindow(self.hwnd, 4 if on else 0)                                        # SHOWNOACTIVATE / HIDE


class Api:
    """What the page may call (window.pywebview.api.*). Kept tiny: pywebview exposes every public attribute."""

    def __init__(self, card):
        self._card = card

    def set_mode(self, mode, animate=True):
        return self._card.set_mode(mode, bool(animate))

    def go(self):
        return self._card.go()

    def close(self):
        return self._card.close()


class Card:
    def __init__(self, dock_file, parent, win=None, read=None):
        self.dock_file, self.parent = dock_file, parent
        self.win = win
        self.read = read or self._read
        self.mode, self.side = "mini", "right"
        self.shown = None
        self.last = None
        self.dismissed = False
        self.window = None
        self._mtime, self._dock = None, None
        self.geo = None           # (circle, card, corner, scale) of the current layout
        self.region = None        # region currently applied
        self.pushed = None        # mini circle last told to the page
        self.animating = False
        self.notify = None        # callable(js) -> page; set in main()
        self.sleep = time.sleep

    # ---- js_api (called from the page)
    def info(self):
        if not self.geo:
            return {"mode": self.mode}
        (l, t, r, _), _, _, scale = self.geo
        return {"mode": self.mode, "x": l / scale, "y": t / scale, "d": (r - l) / scale, "ms": round(ANIM_S * 1000)}

    def set_mode(self, mode, animate=True):
        """Collapse / expand. With a layout known, the region morphs circle <-> card over ANIM_S on a timer
        thread (placement waits meanwhile). -> info() for the page's matching record animation."""
        if mode not in ("mini", "full") or mode == self.mode or self.animating:
            return self.info()
        self.mode = mode
        if not self.geo or not animate:
            self.region = None                 # step() applies the new shape at once
            return self.info()
        circle, card, corner, _ = self.geo
        start = self.region or shape_for("full" if mode == "mini" else "mini", circle, card, corner)
        end = shape_for(mode, circle, card, corner)
        self.animating = True
        self._go = threading.Event()
        threading.Thread(target=self._morph, args=(start, end), daemon=True).start()
        return self.info()

    def go(self):
        """The page starts its record animation in this same frame: start the region morph now, so both
        run on (nearly) the same clock. Without it the morph starts on its own after GO_WAIT_S."""
        ev = getattr(self, "_go", None)
        if ev is not None:
            ev.set()
        return True

    def _morph(self, start, end):
        try:
            ev = getattr(self, "_go", None)
            if ev is not None:
                ev.wait(GO_WAIT_S)
            t0 = time.monotonic()
            while True:
                t = (time.monotonic() - t0) / ANIM_S
                self.win.shape(*lerp_shape(start, end, t))
                if t >= 1:
                    break
                self.sleep(1 / 60)
            self.region = end
        finally:
            self.animating, self.last = False, None    # re-dock now if the pet moved meanwhile

    def close(self):
        self.dismissed = True
        if self.window is not None:
            def later():
                time.sleep(0.2)      # let the js_api call return before the WebView goes away
                self.window.destroy()
            threading.Thread(target=later, daemon=True).start()
        return True

    # ---- docking
    def _read(self):
        try:
            m = os.stat(self.dock_file).st_mtime_ns
            if m != self._mtime:
                with open(self.dock_file, encoding="utf-8") as f:
                    self._dock, self._mtime = json.load(f), m
        except (OSError, ValueError):
            pass
        return self._dock

    def step(self):
        """One placement pass. -> 'quit' when the pet is gone, else the placed rect or None."""
        if not pid_alive(self.parent):
            return "quit"
        if self.animating:
            return None
        dock = self.read()
        if not dock or not self.win or not self.win.find():
            return None
        visible = bool(dock.get("visible", True))
        if visible != self.shown:
            self.win.show(visible)
            self.shown, self.last = visible, None
        if not visible:
            return None
        scale = self.win.scale()
        (x, y, w, h), self.side, circle, card, corner = layout(dock, scale, self.side)
        self.geo = (circle, card, corner, scale)
        owner = int(dock.get("owner") or 0)
        if owner and hasattr(self.win, "own"):
            self.win.own(owner)
        if hasattr(self.win, "sync_topmost"):
            self.win.sync_topmost(bool(dock.get("topmost", True)))
        rect = (x, y, w, h, bool(dock.get("topmost", True)))
        shape = shape_for(self.mode, circle, card, corner)
        if shape != self.region:
            self.win.shape(*shape)
            self.region = shape
        if circle != self.pushed and self.notify:
            i = self.info()
            self.notify("window.__cardMini && window.__cardMini(%.2f, %.2f, %.2f)" % (i["x"], i["y"], i["d"]))
            self.pushed = circle          # only once the page has it
        if rect != self.last:
            if owner and hasattr(self.win, "own"):
                self.win.place(*rect, owned=True)
            else:
                self.win.place(*rect)
            self.last = rect
        return rect

    def loop(self):
        while True:
            try:
                if self.step() == "quit":
                    self.close()
                    self.dismissed = False
                    return
            except Exception:  # noqa: BLE001 - never let placement kill the window
                pass
            time.sleep(0.033)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--dock", required=True)
    ap.add_argument("--parent", type=int, default=0)
    a = ap.parse_args(argv)
    if not a.url.startswith(("http://127.0.0.1", "http://localhost")):
        return 2
    import webview
    card = Card(a.dock, a.parent, Win())
    card.window = webview.create_window(
        TITLE, a.url, js_api=Api(card), min_size=(16, 16), width=CARD_W + 2 * PAD, height=CARD_H + 2 * PAD,
        frameless=True, transparent=True, on_top=True, easy_drag=False,
        background_color="#000000", shadow=False)
    card.notify = lambda js: card.window.evaluate_js(js)
    threading.Thread(target=card.loop, daemon=True).start()
    webview.start(gui="edgechromium", private_mode=True)
    return EXIT_DISMISSED if card.dismissed else 0


if __name__ == "__main__":
    sys.exit(main())
