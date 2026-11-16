"""Screenshots for the hub bar. Nothing touches the disk here: the image stays in memory as PNG bytes
until the message goes out (the host keeps it in <data>/tmp only for the length of that request).

ShotPicker hides the pet's own windows, grabs every monitor, then shows a dimmed copy of the desktop:
drag = that region, a click without dragging = the whole monitor under the pointer, Esc or
right-click = cancel. done(image | None) runs on the Tk thread.
"""
import io

MAX_SIDE = 1920
MAX_BYTES = 4 * 1024 * 1024
THUMB = (30, 22)


def to_image_box(rect, bounds, image_size):
    """Overlay rect (x0, y0, x1, y1, relative to bounds) -> crop box in grabbed-image pixels, or None if tiny."""
    bx, by, bw, bh = bounds
    iw, ih = image_size
    x0, x1 = sorted((max(0, min(bw, rect[0])), max(0, min(bw, rect[2]))))
    y0, y1 = sorted((max(0, min(bh, rect[1])), max(0, min(bh, rect[3]))))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return None
    sx, sy = iw / float(bw), ih / float(bh)
    return round(x0 * sx), round(y0 * sy), round(x1 * sx), round(y1 * sy)


def monitor_rect(bounds, monitor):
    """A monitor rect in desktop coordinates -> the same rect relative to the overlay."""
    bx, by = bounds[0], bounds[1]
    return monitor[0] - bx, monitor[1] - by, monitor[2] - bx, monitor[3] - by


def encode(image, max_side=MAX_SIDE, max_bytes=MAX_BYTES):
    """PIL image -> PNG bytes, shrunk until it fits max_bytes."""
    from PIL import Image
    im = image.convert("RGB")
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    while True:
        out = io.BytesIO()
        im.save(out, format="PNG", optimize=True)
        data = out.getvalue()
        if len(data) <= max_bytes or max(im.size) <= 240:
            return data
        im = im.resize((max(1, int(im.width * .8)), max(1, int(im.height * .8))), Image.Resampling.LANCZOS)


def thumbnail(image, size=THUMB):
    """Centre-cropped thumbnail that fills `size` exactly."""
    from PIL import ImageOps
    return ImageOps.fit(image.convert("RGB"), size)


class ShotPicker:
    DIM = .42
    EDGE = "#4FD1C5"

    def __init__(self, root, hide, done, grab=None, monitor_at=None, bounds=None):
        import tkinter as tk
        self.tk = tk
        self.root, self.done = root, done
        self._grab = grab
        self._monitor_at = monitor_at
        self._bounds = bounds
        self.overlay = None
        self.closed = False
        self.hidden = []
        for w in hide:
            try:
                if w is not None and w.winfo_viewable():
                    w.withdraw()
                    self.hidden.append(w)
            except tk.TclError:
                pass
        root.after(160, self._open)

    def _open(self):
        try:
            from PIL import ImageEnhance, ImageGrab, ImageTk
            from . import window as W
            self.bounds = self._bounds or W.virtual_screen(self.root)
            bx, by, bw, bh = self.bounds
            self.image = (self._grab or (lambda: ImageGrab.grab(all_screens=True)))()
            shown = self.image.convert("RGB").resize((bw, bh))
            self.bright = shown
            self.dim = ImageTk.PhotoImage(ImageEnhance.Brightness(shown).enhance(self.DIM))
            tk = self.tk
            ov = self.overlay = tk.Toplevel(self.root)
            ov.overrideredirect(True)
            ov.attributes("-topmost", True)
            ov.geometry("%dx%d%+d%+d" % (bw, bh, bx, by))
            cv = self.cv = tk.Canvas(ov, width=bw, height=bh, highlightthickness=0, bd=0, cursor="crosshair")
            cv.pack()
            cv.create_image(0, 0, image=self.dim, anchor="nw")
            self.lit = cv.create_image(0, 0, anchor="nw")
            self.edge = cv.create_rectangle(0, 0, 0, 0, outline=self.EDGE, width=2, state="hidden")
            self.start = None
            self._lit_img = None
            self._last = 0.0
            cv.bind("<ButtonPress-1>", self._press)
            cv.bind("<B1-Motion>", self._drag)
            cv.bind("<ButtonRelease-1>", self._release)
            ov.bind("<Escape>", lambda e: self.close())
            cv.bind("<Button-3>", lambda e: self.close())
            ov.update_idletasks()
            ov.focus_force()
            try:
                ov.grab_set()
            except tk.TclError:
                pass
        except Exception:  # noqa: BLE001
            self.close()

    def _show(self, x0, y0, x1, y1):
        import time
        from PIL import ImageTk
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        self.cv.coords(self.edge, x0, y0, x1, y1)
        self.cv.itemconfigure(self.edge, state="normal")
        now = time.monotonic()
        if now - self._last < .03 or x1 - x0 < 2 or y1 - y0 < 2:
            return
        self._last = now
        self._lit_img = ImageTk.PhotoImage(self.bright.crop((x0, y0, x1, y1)))
        self.cv.itemconfigure(self.lit, image=self._lit_img)
        self.cv.coords(self.lit, x0, y0)

    def _press(self, e):
        self.start = (e.x, e.y)

    def _drag(self, e):
        if self.start:
            self._show(self.start[0], self.start[1], e.x, e.y)

    def _release(self, e):
        if not self.start:
            return
        rect = (self.start[0], self.start[1], e.x, e.y)
        self.start = None
        box = to_image_box(rect, self.bounds, self.image.size)
        if box is None:                                 # a click: the monitor under the pointer
            from . import window as W
            px, py = self.bounds[0] + e.x, self.bounds[1] + e.y
            mon = (self._monitor_at or W.monitor_at)(px, py)
            rect = monitor_rect(self.bounds, mon[0]) if mon else (0, 0, self.bounds[2], self.bounds[3])
            box = to_image_box(rect, self.bounds, self.image.size)
        self.close(self.image.crop(box) if box else None)

    def close(self, image=None):
        if self.closed:
            return
        self.closed = True
        if self.overlay is not None:
            try:
                self.overlay.grab_release()
                self.overlay.destroy()
            except self.tk.TclError:
                pass
        for w in self.hidden:
            try:
                w.deiconify()
            except self.tk.TclError:
                pass
        self.done(image)
