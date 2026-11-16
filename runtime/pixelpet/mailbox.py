"""Mailbox furniture glue (pet side). The host owns the InboxStore; the pet only reads its small summary
<data>/mailbox/state.json to raise / lower the flag, and opens the host's mailbox window on click.

A furniture pack opts in with "feature": "mailbox" and an optional block:
    "mailbox": {"flagState": "flag", "openState": "open", "verb": "check", "autoWave": true}
"""
import json
import os
import subprocess
import threading
import webbrowser

DEFAULTS = {"flagState": "flag", "openState": "open", "verb": "check", "autoWave": True}


def options(defn):
    o = dict(DEFAULTS)
    raw = defn.get("mailbox")
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in DEFAULTS and isinstance(v, type(DEFAULTS[k])):
                o[k] = v
    return o


def state_path(data_dir):
    return os.path.join(data_dir, "mailbox", "state.json")


def read_state(data_dir):
    """-> (unread, latestUnreadAt|None) or None when missing / unreadable."""
    try:
        with open(state_path(data_dir), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    unread = d.get("unread") if isinstance(d, dict) else None
    if not isinstance(unread, int) or isinstance(unread, bool) or unread < 0:
        return None
    latest = d.get("latestUnreadAt")
    return unread, latest if isinstance(latest, str) else None


def is_fresh(prev_unread, prev_latest, unread, latest):
    """A new letter arrived since the last look (never on the very first read)."""
    return (prev_unread is not None and unread > 0 and latest is not None
            and (prev_latest is None or latest > prev_latest))


class MailFlag:
    """Change-detecting reader of state.json (mtime-gated, Tk-free)."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.unread = None
        self.latest = None
        self._mtime = None

    def poll(self):
        """-> None (nothing new) or (unread, latest, fresh)."""
        try:
            m = os.stat(state_path(self.data_dir)).st_mtime_ns
        except OSError:
            return None
        if m == self._mtime:
            return None
        self._mtime = m
        r = read_state(self.data_dir)
        if r is None:
            return None
        unread, latest = r
        fresh = is_fresh(self.unread, self.latest, unread, latest)
        self.unread, self.latest = unread, latest
        return unread, latest, fresh


def mailbox_url():
    base = os.environ.get("PIXELPET_HOST_BASE") or ""
    return base.rstrip("/") + "/mailbox" if base.startswith(("http://127.0.0.1", "http://localhost")) else ""


def _browser():
    """A Chromium-family browser for a chromeless app window, from standard install locations only."""
    names = (("Microsoft", "Edge", "Application", "msedge.exe"), ("Google", "Chrome", "Application", "chrome.exe"))
    for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        root = os.environ.get(env)
        if not root:
            continue
        for parts in names:
            p = os.path.join(root, *parts)
            if os.path.isfile(p):
                return p
    return None


def open_window(url, size=(460, 720)):
    """Open the mailbox as a small app window (falls back to the default browser). Never blocks the UI thread."""
    if not url:
        return False

    def run():
        exe = _browser() if os.name == "nt" else None
        if exe:
            try:
                subprocess.Popen([exe, "--app=" + url, "--window-size=%d,%d" % size],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                return
            except OSError:
                pass
        webbrowser.open(url)
    threading.Thread(target=run, daemon=True).start()
    return True
