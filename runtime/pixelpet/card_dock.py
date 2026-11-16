"""「一起听歌」小卡片：贴靠几何 + 由桌宠管理的卡片窗口进程。

The card is a pywebview (WebView2) frameless transparent window run by the music environment
(`python -m pixelmusic.cardwin`, runtime/music/pixelmusic/cardwin.py). The pet owns its lifecycle:
  * opens it (collapsed) when 「一起听歌」 is on, closes it when that is turned off or the pet quits;
  * writes the pet's body box / work area / visibility to <data>/card-dock.json, the window process
    places itself from that with dock_rect / mini_rect below (it hides while the pet is hidden);
  * exit code 3 = the user closed the card -> no auto-open again in this session (a manual
    「打开小卡片」 clears that).
The old Edge --app + SetWindowRgn approach is retired (DirectComposition ignores window regions).
"""
import json
import os
import subprocess
import time

GAP = 6
CARD_W, CARD_H = 260, 330
MINI_PX = 64
DOCK_FILE = "card-dock.json"
EXIT_DISMISSED = 3
STABLE_S = 60.0               # a card that ran this long before exiting gets its retry budget back
RETRY_S = (5, 20, 60)          # back-off after unexpected exits; then give up for the session


def dock_rect(body, card, work, prefer="right", gap=GAP):
    """Where the card goes. body/work = (l, t, r, b) screen px, card = (w, h). -> (x, y, side).

    Side: `prefer` if the card fits there inside `work`, else the other side if it fits, else the
    side with more room (clamped). Vertically the card's bottom lines up with the pet's feet, then
    is clamped into the work area.
    """
    l, t, r, b = body
    w, h = card
    wl, wt, wr, wb = work
    fits = {"right": r + gap + w <= wr, "left": l - gap - w >= wl}
    other = "left" if prefer == "right" else "right"
    if fits.get(prefer):
        side = prefer
    elif fits.get(other):
        side = other
    else:
        side = "right" if (wr - r) >= (l - wl) else "left"
    x = r + gap if side == "right" else l - gap - w
    x = max(wl, min(x, wr - w))
    y = max(wt, min(b - h, wb - h))
    return int(x), int(y), side


def mini_rect(body, d, work, prefer="right", gap=GAP):
    """Collapsed record beside the pet, a little above its middle. -> (x, y, side)."""
    x, _, side = dock_rect(body, (d, d), work, prefer, gap)
    l, t, r, b = body
    y = t + (b - t) * 0.3 - d / 2
    y = max(work[1], min(y, work[3] - d))
    return int(x), int(y), side


def music_python(cfg, data_dir):
    """settings.listen.python, else <data>/listen.json python. Never a hard-coded path."""
    p = str(((cfg or {}).get("listen") or {}).get("python") or "").strip()
    if not p:
        try:
            with open(os.path.join(data_dir, "listen.json"), encoding="utf-8") as f:
                p = str(json.load(f).get("python") or "").strip()
        except (OSError, ValueError, AttributeError):
            p = ""
    return p if p and os.path.isfile(p) else ""


class CardHost:
    """pet: body_screen(), work_area(), visible(), topmost, data_dir.

    settings() -> settings dict (re-read every 2 s); spawn(argv, cwd) -> Popen-like. Both injectable."""

    def __init__(self, pet, spawn=None, clock=None, settings=None, base=None):
        self.pet = pet
        self.spawn = spawn or self._spawn
        self.clock = clock or time.monotonic
        self.settings = settings or (lambda: getattr(pet, "cfg", {}) or {})
        self.base = base if base is not None else os.environ.get("PIXELPET_HOST_BASE", "")
        self.proc = None
        self.dismissed = False      # user closed it: no auto-open until a manual open
        self.failures = 0
        self.retry_at = 0.0
        self._dock = None
        self._cfg_at = -1e9
        self._cfg = {}

    def dock_path(self):
        return os.path.join(self.pet.data_dir, DOCK_FILE)

    def enabled(self):
        return ((self._cfg.get("listen") or {}).get("enabled")) is True

    def url(self):
        b = str(self.base or "")
        return b.rstrip("/") + "/card" if b.startswith(("http://127.0.0.1", "http://localhost")) else ""

    def argv(self):
        py = music_python(self._cfg, self.pet.data_dir)
        if not py or not self.url():
            return None
        return [py, "-m", "pixelmusic.cardwin", "--url", self.url(), "--dock", self.dock_path(), "--parent", str(os.getpid())]

    @staticmethod
    def _spawn(argv, cwd):
        return subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def write_dock(self):
        """Pet geometry for the window process; written only when it changed (atomic replace)."""
        try:
            state = {"body": list(self.pet.body_screen()), "work": list(self.pet.work_area()),
                     "visible": bool(self.pet.visible()), "topmost": bool(getattr(self.pet, "topmost", True)),
                     # the card makes itself an owned window of the pet: it then always sits right above the pet in
                     # z-order (covered with it when the pet is not topmost, topmost with it when it is)
                     "owner": int(getattr(self.pet, "hwnd", 0) or 0)}
        except Exception:  # noqa: BLE001
            return False
        if state == self._dock:
            return False
        tmp = self.dock_path() + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f)
            os.replace(tmp, self.dock_path())
        except OSError:
            return False
        self._dock = state
        return True

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        if self.running():
            return True
        argv = self.argv()
        if not argv:
            return False
        self._dock = None
        self.write_dock()
        cwd = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "music")
        try:
            self.proc = self.spawn(argv, cwd)
            self.started_at = self.clock()
        except OSError:
            self.proc = None
            return False
        return True

    def stop(self):
        p, self.proc = self.proc, None
        if p is not None and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass

    def open(self):
        """Manual 「打开小卡片」. -> (ok, message)."""
        self._cfg, self._cfg_at = self.settings(), self.clock()
        if not self.enabled():
            return False, "「一起听歌」没有打开。"
        self.dismissed, self.failures, self.retry_at = False, 0, 0.0
        if not self.argv():
            return False, "没有找到音乐服务 Python，或宿主地址未知。"
        return (True, "ok") if self.start() else (False, "小卡片没能打开。")

    def tick(self):
        now = self.clock()
        if now - self._cfg_at >= 2.0:
            self._cfg_at, self._cfg = now, self.settings()
        if self.proc is not None and self.proc.poll() is not None:
            code, self.proc = self.proc.poll(), None
            if code == EXIT_DISMISSED:
                self.dismissed = True
            else:
                if now - getattr(self, "started_at", now) > STABLE_S:
                    self.failures = 0              # it ran fine for a while: a later exit is a fresh failure
                self.failures += 1
                if self.failures > len(RETRY_S):
                    self.dismissed = True          # keeps crashing: stop trying this session
                else:
                    self.retry_at = now + RETRY_S[self.failures - 1]
        if not (self.enabled() and not self.dismissed):
            if self.proc is not None:
                self.stop()
            return
        self.write_dock()
        if self.proc is None and now >= self.retry_at:
            self.start()
