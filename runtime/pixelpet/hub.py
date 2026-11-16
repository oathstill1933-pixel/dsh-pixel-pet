"""Hub bar: a small input strip under the pet, folding to a chip beside it.

    [ fold | mic | text ........ | shots… | capture | send ]          expanded, centred under the feet
    [ ◘ ]                                                             collapsed, right of the pet

Enter sends the text (plus any screenshots) to the pointed DSH session; the reply lands in the bubble
and is read aloud when settings.hub.speak is on. The mic is a switch: on = keep listening, every
finished sentence is recognised and sent (voice/vad.py); off = stop. Esc or the fold key collapses;
after settings.hub.autoCollapseS idle seconds it collapses by itself (not while listening). Collapsing
never clears the draft: text and screenshots are still there when it opens again.

HubModel holds the state and rules (no Tk) so they can be tested; HubBar draws it.
"""
import time

DEFAULT_HUB = {"show": True, "autoCollapseS": 20, "speak": True}
MAX_SHOTS = 4


def hub_cfg(raw):
    """settings.hub -> clean dict (mirrors lib/hub.js sanitizeHub). Retired keys (handsFree) drop out."""
    out = dict(DEFAULT_HUB)
    src = raw if isinstance(raw, dict) else {}
    for k in ("show", "speak"):
        if isinstance(src.get(k), bool):
            out[k] = src[k]
    try:
        n = float(src.get("autoCollapseS", out["autoCollapseS"]))
        if 0 <= n <= 3600:
            out["autoCollapseS"] = int(round(n))
    except (TypeError, ValueError):
        pass
    return out


def place_beside(body, size, work, gap=8):
    """Where a (w, h) window goes next to the pet's body rect, staying inside the work area.

    Tries right of the body (bottom-aligned), then left, then below, then above; the first that fits
    wins, otherwise the first one clamped into the work area. -> (x, y)
    """
    l, t, r, b = body
    w, h = size
    wl, wt, wr, wb = work
    cx = (l + r) / 2.0
    lower = b - h - max(0, (b - t) * .12)
    options = [(r + gap, lower), (l - gap - w, lower), (cx - w / 2.0, b + gap), (cx - w / 2.0, t - gap - h)]
    for x, y in options:
        if wl <= x and x + w <= wr and wt <= y and y + h <= wb:
            return int(round(x)), int(round(y))
    x, y = options[0]
    x = max(wl, min(x, wr - w))
    y = max(wt, min(y, wb - h))
    return int(round(x)), int(round(y))


def place_under(body, size, work, gap=4):
    """A (w, h) window centred under the body's feet; above the head when the bottom edge is too
    close. Clamped sideways into the work area. -> (x, y)"""
    l, t, r, b = body
    w, h = size
    wl, wt, wr, wb = work
    x = (l + r) / 2.0 - w / 2.0
    y = b + gap
    if y + h > wb:
        y = t - gap - h
    x = max(wl, min(x, wr - w))
    y = max(wt, min(y, wb - h))
    return int(round(x)), int(round(y))


class HubModel:
    def __init__(self, auto_s=20, collapsed=True, clock=time.monotonic):
        self.clock = clock
        self.auto_s = auto_s
        self.collapsed = collapsed
        self.draft = ""
        self.shots = []
        self.sending = self.listening = self.capturing = False
        self.send_sequence = 0
        self.active_send = None
        self.delivery = None
        self.recoveries = []  # explicitly unsent voice drafts; never overwrite a newer typed draft
        self.last_activity = clock()

    # ---- activity / folding
    def touch(self):
        self.last_activity = self.clock()

    @property
    def busy(self):
        return self.sending or self.listening or self.capturing

    @property
    def has_draft(self):
        return bool(self.draft.strip() or self.shots)

    def expand(self):
        self.collapsed = False
        self.touch()

    def collapse(self):
        """Fold. The draft stays."""
        self.collapsed = True

    def toggle(self):
        if self.collapsed:
            self.expand()
        else:
            self.collapse()
        return self.collapsed

    def should_autocollapse(self, now=None):
        if self.collapsed or self.busy or not self.auto_s:
            return False
        now = self.clock() if now is None else now
        return now - self.last_activity >= self.auto_s

    # ---- draft
    def set_draft(self, text):
        if text != self.draft:
            self.draft = text
            self.touch()

    def add_shot(self, shot):
        if len(self.shots) >= MAX_SHOTS:
            return False
        self.shots.append(shot)
        self.touch()
        return True

    def remove_shot(self, index):
        if 0 <= index < len(self.shots):
            self.shots.pop(index)
            self.touch()
            return True
        return False

    def can_send(self):
        return not self.sending and self.has_draft

    def take(self):
        """Hand the draft over for sending and clear it. -> (text, shots)"""
        text, shots = self.draft.strip(), list(self.shots)
        self.draft, self.shots = "", []
        self.touch()
        return text, shots

    def restore(self, text, shots):
        """A send failed: put the draft back unless something new was typed meanwhile."""
        if not self.draft.strip():
            self.draft = text
        room = MAX_SHOTS - len(self.shots)
        self.shots = list(shots[:max(0, room)]) + self.shots
        self.touch()


# ----------------------------------------------------------------------------- view
PANEL, EDGE = "#1E232C", "#3A4352"
TEXT, ICON, ICON_HI, ICON_EDGE = "#E8ECF2", "#9AA5B5", "#4FD1C5", "#2B8C83"
REC, BUSY, DRAFT = "#F06A6A", "#566173", "#FFC56B"
H, PAD, BTN, ENTRY_W, THUMB_W = 36, 6, 26, 200, 34


def stepped_rect(x0, y0, x1, y1, s=3):
    """Pixel-style rounded rectangle: corners cut in two steps."""
    return [x0 + 2 * s, y0, x1 - 2 * s, y0, x1 - 2 * s, y0 + s, x1 - s, y0 + s, x1 - s, y0 + 2 * s, x1, y0 + 2 * s,
            x1, y1 - 2 * s, x1 - s, y1 - 2 * s, x1 - s, y1 - s, x1 - 2 * s, y1 - s, x1 - 2 * s, y1,
            x0 + 2 * s, y1, x0 + 2 * s, y1 - s, x0 + s, y1 - s, x0 + s, y1 - 2 * s, x0, y1 - 2 * s,
            x0, y0 + 2 * s, x0 + s, y0 + 2 * s, x0 + s, y0 + s, x0 + 2 * s, y0 + s]


class Tip:
    """Hover hint for canvas items (the only words on the bar)."""

    def __init__(self, root):
        import tkinter as tk
        self.root = root
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.label = tk.Label(self.win, bg="#11151B", fg=TEXT, padx=7, pady=3, font=("Microsoft YaHei UI", 9))
        self.label.pack()
        self.win.withdraw()
        self._job = None

    def bind(self, canvas, tag, text):
        canvas.tag_bind(tag, "<Enter>", lambda e: self._later(text), add="+")
        canvas.tag_bind(tag, "<Leave>", lambda e: self.hide(), add="+")
        canvas.tag_bind(tag, "<ButtonPress-1>", lambda e: self.hide(), add="+")

    def _later(self, text):
        self.hide()
        self._job = self.root.after(550, lambda: self._show(text))

    def _show(self, text):
        self._job = None
        self.label.config(text=text)
        x, y = self.root.winfo_pointerxy()
        self.win.geometry("%+d%+d" % (x + 12, y + 18))
        self.win.deiconify()

    def hide(self):
        if self._job:
            self.root.after_cancel(self._job)
            self._job = None
        self.win.withdraw()

    def destroy(self):
        self.hide()
        self.win.destroy()


class HubBar:
    """pet must offer: root, hub_cfg(), body_screen(), work_area(), hub_send(text, shots),
    hub_listen() (flip continuous listening, then call set_listening), hub_capture(), offscreen."""

    def __init__(self, pet):
        import tkinter as tk
        from . import window as W
        self.pet, self.W, self.tk = pet, W, tk
        cfg = pet.hub_cfg()
        self.m = HubModel(cfg["autoCollapseS"], collapsed=True)
        self.visible = True
        self._photos = []
        self._hover_shot = None
        self._last_body = None
        self._last_size = None
        self.font = ("Microsoft YaHei UI", 10)

        # expanded bar
        self.win = tk.Toplevel(pet.root)
        self.win, self.cv = W.overlay(self.win, 10, H, topmost=True)
        self.var = tk.StringVar()
        self.entry = tk.Entry(self.win, textvariable=self.var, bd=0, relief="flat", bg=PANEL, fg=TEXT,
                              insertbackground=ICON_HI, highlightthickness=0, font=self.font,
                              disabledbackground=PANEL)
        self.entry.bind("<Return>", lambda e: self.send())
        self.entry.bind("<Escape>", lambda e: self.collapse())
        self.entry.bind("<Button-3>", self._recovery_menu, add="+")
        self.entry.bind("<Key>", lambda e: self.m.touch(), add="+")
        self.var.trace_add("write", lambda *a: self.m.set_draft(self.var.get()))
        self.cv.bind("<Motion>", lambda e: self.m.touch())
        self.cv.bind("<Button-1>", self._on_click, add="+")
        self.tip = Tip(pet.root)
        self._draw()
        self._bind_static()
        W.tool_flags(self.win)
        self.win.withdraw()

        # collapsed chip
        self.chip = tk.Toplevel(pet.root)
        self.chip, self.ccv = W.overlay(self.chip, BTN, BTN, topmost=True)
        self._draw_chip()
        self.ccv.bind("<Button-1>", lambda e: self.expand())
        W.native_flags(self.chip)
        self.chip.withdraw()
        self.sync(cfg)

    # ------------------------------------------------------------------ drawing
    def width(self):
        return PAD + BTN // 2 + 4 + BTN + 6 + ENTRY_W + 6 + THUMB_W * len(self.m.shots) + BTN + 2 + BTN + PAD

    def _draw(self):
        cv = self.cv
        cv.delete("all")
        w = self.width()
        cv.configure(width=w, height=H)
        cv.create_polygon(stepped_rect(0, 0, w - 1, H - 1), fill=PANEL, outline=EDGE, width=1)
        cy = H // 2
        x = PAD
        # fold
        fx = x + 5
        cv.create_rectangle(fx - 4, cy - 9, fx + 6, cy + 9, fill=PANEL, outline="", tags=("fold", "btn"))
        cv.create_line(fx + 3, cy - 5, fx - 1, cy, fx + 3, cy + 5, fill=ICON, width=2, tags=("fold", "fold-ic"))
        x += BTN // 2 + 4
        # mic: a switch, filled while listening
        mx = x + BTN // 2
        on = self.m.listening
        cv.create_polygon(stepped_rect(x, cy - BTN // 2, x + BTN - 1, cy + BTN // 2 - 1, 2),
                          fill=ICON_HI if on else PANEL, outline="", tags=("mic", "btn", "mic-bg"))
        col = PANEL if on else ICON
        cv.create_rectangle(mx - 3, cy - 8, mx + 3, cy + 2, fill=col, outline=col, tags=("mic", "mic-ic"))
        cv.create_line(mx - 6, cy - 2, mx - 6, cy + 1, mx - 3, cy + 5, mx + 3, cy + 5, mx + 6, cy + 1, mx + 6, cy - 2,
                       fill=col, width=2, tags=("mic", "mic-ic"))
        cv.create_line(mx, cy + 5, mx, cy + 9, fill=col, width=2, tags=("mic", "mic-ic"))
        cv.create_line(mx - 4, cy + 9, mx + 5, cy + 9, fill=col, width=2, tags=("mic", "mic-ic"))
        x += BTN + 6
        # text
        cv.create_line(x, cy + 11, x + ENTRY_W, cy + 11, fill=EDGE)
        cv.create_window(x, cy, anchor="w", window=self.entry, width=ENTRY_W, height=22)
        x += ENTRY_W + 6
        # screenshots
        self._photos = []
        from PIL import ImageTk
        for i, shot in enumerate(self.m.shots):
            tag = "shot%d" % i
            ph = ImageTk.PhotoImage(shot["thumb"])
            self._photos.append(ph)
            cv.create_rectangle(x - 1, cy - 12, x + 31, cy + 12, outline=EDGE, fill=PANEL, tags=(tag, "shot"))
            cv.create_image(x, cy - 11, image=ph, anchor="nw", tags=(tag, "shot"))
            cv.create_rectangle(x + 20, cy - 12, x + 31, cy - 1, fill=REC, outline="", state="hidden",
                                tags=(tag, "shot", tag + "-x"))
            cv.create_line(x + 23, cy - 9, x + 28, cy - 4, fill="#FFFFFF", width=2, state="hidden",
                           tags=(tag, "shot", tag + "-x"))
            cv.create_line(x + 28, cy - 9, x + 23, cy - 4, fill="#FFFFFF", width=2, state="hidden",
                           tags=(tag, "shot", tag + "-x"))
            # per-redraw tags: plain tag_bind replaces the previous binding, so nothing piles up
            cv.tag_bind(tag, "<Enter>", lambda e, t=tag: cv.itemconfigure(t + "-x", state="normal"))
            cv.tag_bind(tag, "<Leave>", lambda e, t=tag: cv.itemconfigure(t + "-x", state="hidden"))
            cv.tag_bind(tag, "<ButtonRelease-1>", lambda e, k=i: self.remove_shot(k))
            x += THUMB_W
        # capture
        sx = x + BTN // 2
        cv.create_rectangle(x, cy - BTN // 2, x + BTN, cy + BTN // 2, fill=PANEL, outline="", tags=("cap", "btn"))
        col = BUSY if len(self.m.shots) >= MAX_SHOTS else ICON
        for ax, ay, dx, dy in ((-8, -6, 1, 1), (8, -6, -1, 1), (-8, 6, 1, -1), (8, 6, -1, -1)):
            cv.create_line(sx + ax, cy + ay + 4 * dy, sx + ax, cy + ay, sx + ax + 4 * dx, cy + ay,
                           fill=col, width=2, tags=("cap", "cap-ic"))
        cv.create_rectangle(sx - 1, cy - 1, sx + 1, cy + 1, fill=col, outline=col, tags=("cap", "cap-ic"))
        x += BTN + 2
        # send
        nx = x + BTN // 2
        cv.create_rectangle(x, cy - BTN // 2, x + BTN, cy + BTN // 2, fill=PANEL, outline="", tags=("send", "btn"))
        col = BUSY if self.m.sending else ICON_HI if self.m.has_draft else ICON
        cv.create_polygon(nx - 7, cy - 7, nx + 8, cy, nx - 7, cy + 7, nx - 4, cy, fill=col, outline=col,
                          tags=("send", "send-ic"))
        self._last_size = None

    def _bind_static(self):
        """Once: bindings on the fixed button tags survive every redraw."""
        cv = self.cv
        for tag, tip in (("fold", "收起 · Esc"), ("mic", "持续监听"), ("cap", "截图 · 拖选区域 / 单击整屏"),
                         ("send", "发送 · Enter")):
            self.tip.bind(cv, tag, tip)
            cv.tag_bind(tag, "<Enter>", lambda e, t=tag: self._hover(t, True), add="+")
            cv.tag_bind(tag, "<Leave>", lambda e, t=tag: self._hover(t, False), add="+")
        cv.tag_bind("fold", "<ButtonRelease-1>", lambda e: self.collapse(), add="+")
        cv.tag_bind("mic", "<ButtonRelease-1>", lambda e: self._toggle_listen(), add="+")
        cv.tag_bind("cap", "<ButtonRelease-1>", lambda e: self.capture(), add="+")
        cv.tag_bind("send", "<ButtonRelease-1>", lambda e: self.send(), add="+")

    def _hover(self, tag, on):
        if tag == "mic":
            listening = self.m.listening
            base = PANEL if listening else ICON
            bg = ICON_HI if listening else PANEL
            self.cv.itemconfigure("mic-bg", fill=bg)
            col = base if listening or not on else ICON_HI
        else:
            base = {"send": BUSY if self.m.sending else ICON_HI if self.m.has_draft else ICON, "fold": ICON,
                    "cap": BUSY if len(self.m.shots) >= MAX_SHOTS else ICON}[tag]
            col = ICON_HI if on and base == ICON else base
        for item in self.cv.find_withtag(tag + "-ic"):
            kind = self.cv.type(item)
            if kind in ("rectangle", "polygon"):
                self.cv.itemconfigure(item, fill=col, outline=col)
            else:
                self.cv.itemconfigure(item, fill=col)

    def _draw_chip(self):
        """A light speech bubble with a 1px rim; dots: amber = draft waiting, red = listening."""
        c = self.ccv
        c.delete("all")
        x0, y0, x1, y1, s = 3, 5, 22, 18, 2
        pts = stepped_rect(x0, y0, x1, y1, s)
        pts[22:22] = [x0 + 2 * s + 4, y1, x0 + 2 * s, y1 + 4]   # tail, before the bottom edge's left end
        c.create_polygon(pts, fill=ICON_HI, outline=ICON_EDGE, width=1)
        for dx in (8, 12, 16):
            c.create_rectangle(dx, 11, dx + 1, 12, fill=PANEL, outline=PANEL)
        if self.m.has_draft:
            c.create_rectangle(BTN - 6, 1, BTN - 3, 4, fill=DRAFT, outline=DRAFT)
        if self.m.listening:
            c.create_rectangle(1, 1, 4, 4, fill=REC, outline=REC)

    def refresh(self):
        self._draw()
        self._draw_chip()
        self.follow(force=True)

    # ------------------------------------------------------------------ placement
    def follow(self, force=False):
        if not self.visible:
            return
        body = self.pet.body_screen()
        win = self.chip if self.m.collapsed else self.win
        size = (BTN, BTN) if self.m.collapsed else (self.width(), H)
        key = (body, size, self.m.collapsed)
        if not force and key == self._last_body:
            return
        self._last_body = key
        if self.m.collapsed:
            x, y = place_beside(body, size, self.pet.work_area(), gap=14)
        else:
            x, y = place_under(body, size, self.pet.work_area())
        win.geometry("%dx%d%+d%+d" % (size[0], size[1], x, y))

    def _show_current(self):
        if not self.visible:
            self.win.withdraw()
            self.chip.withdraw()
            return
        if self.m.collapsed:
            self.win.withdraw()
            self._draw_chip()
            self.chip.deiconify()
            self.W.native_flags(self.chip)
        else:
            self.chip.withdraw()
            self.win.deiconify()
            self.W.tool_flags(self.win)
        self.follow(force=True)

    # ------------------------------------------------------------------ state changes
    def sync(self, cfg):
        """settings changed (or first start)."""
        self.m.auto_s = cfg["autoCollapseS"]
        self.set_visible(cfg["show"])

    def set_visible(self, on):
        on = bool(on) and self.pet.hub_cfg()["show"]
        if on == self.visible and (self.win.winfo_viewable() or self.chip.winfo_viewable()):
            return
        self.visible = on
        if not on:
            self.tip.hide()
        self._show_current()

    def expand(self, focus=True):
        if not self.visible:
            return
        self.m.expand()
        self._draw()
        self._show_current()
        if focus and not self.pet.offscreen:
            self.win.after(30, self._focus)

    def _focus(self):
        try:
            self.win.focus_force()
            self.entry.focus_set()
            self.entry.icursor("end")
        except self.tk.TclError:
            pass

    def collapse(self):
        if self.m.collapsed:
            return
        self.tip.hide()
        self.m.collapse()
        self._show_current()

    def toggle(self):
        if self.m.collapsed:
            self.expand()
        else:
            self.collapse()

    def tick(self, now=None):
        if not self.visible:
            return
        if self.m.should_autocollapse(now):
            self.collapse()
        self.follow()

    def _on_click(self, e):
        self.m.touch()
        if not self.cv.find_withtag("current") or "btn" not in self.cv.gettags("current"):
            self._focus()

    # ------------------------------------------------------------------ actions
    def set_listening(self, on):
        """The pet says whether continuous listening is on; the mic button and chip show it."""
        on = bool(on)
        if on == self.m.listening:
            return
        self.m.listening = on
        self.m.touch()
        self._hover("mic", False)
        self._draw_chip()

    def _toggle_listen(self):
        self.m.touch()
        self.tip.hide()
        self.pet.hub_listen()

    def capture(self):
        if self.m.capturing or len(self.m.shots) >= MAX_SHOTS:
            return
        self.m.capturing = True
        self.tip.hide()
        self.pet.hub_capture()

    def add_shot(self, shot):
        self.m.capturing = False
        if shot is not None:
            self.m.add_shot(shot)
        self.refresh()
        self._focus()

    def remove_shot(self, index):
        if self.m.remove_shot(index):
            self.refresh()

    def send(self):
        self.m.set_draft(self.var.get())
        if not self.m.can_send():
            return
        text, shots = self.m.take()
        self.var.set("")
        self.m.send_sequence += 1
        ticket = self.m.send_sequence
        self.m.active_send = ticket
        self.m.delivery = 'submitting'
        self.m.sending = True
        self.refresh()
        guarded = getattr(self.pet, 'hub_send_ticket', None)
        if callable(guarded):guarded(text, shots, ticket)
        else:self.pet.hub_send(text, shots)  # injected legacy/test pet

    def accepted(self, ticket):
        """Submission receipt, not the final answer. Never touches the next typed draft."""
        if ticket != self.m.active_send:return False
        self.m.delivery = 'accepted'
        self.m.sending = False
        self.m.touch()
        self.refresh()
        return True

    def finish_send(self, ticket, ok, delivery, text='', shots=()):
        # Voice delivery must not release or restore an unrelated text-send ticket.
        if ticket is None and self.m.active_send is not None:
            if delivery == 'not-sent' and (text or shots):
                self.m.recoveries.append((text, list(shots)))
                self.m.touch()
                self.refresh()
                return True
            return False
        return self.sent(ok, text, shots, send_id=ticket, delivery=delivery)

    def _recovery_menu(self, event):
        if not self.m.recoveries:return
        menu=self.tk.Menu(self.win,tearoff=False)
        for index in range(len(self.m.recoveries)):
            menu.add_command(label='恢复未发送草稿 '+str(index+1),command=lambda i=index:self.recover(i))
        try:menu.tk_popup(event.x_root,event.y_root)
        finally:menu.grab_release()
        return 'break'

    def recover(self, index=0):
        if self.m.sending or self.m.has_draft or not 0 <= index < len(self.m.recoveries):return False
        text,shots=self.m.recoveries.pop(index)
        self.m.restore(text,shots)
        self.var.set(self.m.draft)
        self.refresh()
        self._focus()
        return True

    def sent(self, ok, text="", shots=(), send_id=None, delivery=None):
        """Only a definitely unsubmitted message is a failed draft. Legacy callers retain their API."""
        if send_id is not None and send_id != self.m.active_send:return False
        accepted = (send_id is not None and self.m.delivery == 'accepted') or delivery == 'accepted' or bool(ok)
        self.m.sending = False
        restore = not accepted and not ok and (delivery == 'not-sent' or delivery is None)
        if restore and (text or shots):
            if self.m.has_draft:
                self.m.recoveries.append((text, list(shots)))
            else:
                self.m.restore(text, list(shots))
                if not self.var.get().strip():self.var.set(self.m.draft)
        self.m.delivery = 'accepted' if accepted else (delivery or 'not-sent')
        self.m.active_send = None
        self.m.touch()
        self.refresh()
        return True

    def take_shots(self):
        """Screenshots ride along with a voice message too."""
        shots, self.m.shots = list(self.m.shots), []
        if shots:
            self.refresh()
        return shots

    def destroy(self):
        for w in (self.tip, self.win, self.chip):
            try:
                w.destroy()
            except Exception:  # noqa: BLE001
                pass
