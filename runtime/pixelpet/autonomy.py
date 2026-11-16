"""「主动一点」: local rules that move the pet while nobody is talking to it. No AI, no network.

Pure: the clock, the keyboard/mouse idle time, the fullscreen probe and the activity probes (foreground window,
process names, learned table, log) are injected, and `tick()` only returns actions; PetApp (app.py) carries them
out. Follows settings.autonomy.enabled only (not aiControl: these rules never call the AI). Session status mirrors
(working / failed / done) live elsewhere and ignore it.

「允许感知在做什么」 (settings.autonomy.aware, default off): only while it is on does the engine look at the
foreground window (process name + class + a title yes/no, see window.foreground_app), scan process names
(every PROCESS_EVERY s), and write <dataDir>/activity-log.jsonl. Off = presence from keyboard / mouse idle only.

Actions (tuples):
    ("mood", tag, seconds)        mood by tag (困 / 开心 / 思考)
    ("transient", state)          one-shot animation (waving, jumping)
    ("pose", state, seconds|None) held pose; None = until something else replaces it
    ("say", text, seconds)        bubble
    ("use", fid, verb)            furniture verb (walks there; "sleep" goes inside)
    ("wake", kind, what)          undo our own sleep / pose: leave furniture `what` / drop pose `what`
    ("look",)                     look at the cursor
    ("look_center",)              glance at the middle of the screen (watching a video together)
    ("walk", dx)                  a few steps sideways
    ("aside",) / ("back",)        fullscreen started / ended (step to the corner / come back)
"""
import collections
import datetime
import os
import random

from . import activity

RULES = ("idleSleep", "welcomeBack", "breakReminder", "lateNight", "morningHello", "newMail", "fullscreenHide",
         "idleFidget", "gameCalm", "videoCompany", "meetingQuiet", "videoCorner")

AWAY_S = 600            # no keyboard / mouse for 10 min = away
BACK_S = 5              # input within the last 5 s after being away = back
BREAK_S = 300           # a 5-min pause resets the work stretch
WORK_S = 90 * 60        # 90 min of work without such a pause -> 「歇会儿吧」
ACTIVE_S = 60           # input within a minute = at the computer
LATE_FROM, LATE_TO = 23 * 60 + 30, 5 * 60   # 23:30 – 05:00
LATE_EVERY = 20 * 60
MORNING = (5, 12)       # 「早上问好」 hours
FIDGET_GAP = (240, 480)
CAP, CAP_WINDOW = 3, 600   # at most 3 proactive actions per 10 min
YAWN_S = 3.5
MAIL_TTL = 600
FULLSCREEN_EVERY = 2.0
ACTIVITY_EVERY = 3.0     # 每 3 秒看一眼前台窗口
PROCESS_EVERY = 20.0     # 每 20 秒扫一次进程名（只取名字）
DEBOUNCE_S = 25.0        # 新状态持续 25 秒才算数
GLANCE_GAP = (90, 180)   # 一起看视频时，隔一会儿转头看看屏幕中间
SLEEP_POSES = ("curl-sleep", "lie")
WATCH_POSES = ("attentive", "listening")
STRETCH = ("stretch", "jumping", "waving")
BUSY_VOICE = frozenset(("listening", "hearing", "thinking", "speaking"))
GAME_STATES = ("gaming", "gaming_break")


def _hhmm(v):
    if not isinstance(v, str) or len(v) != 5 or v[2] != ":":
        return None
    try:
        h, m = int(v[:2]), int(v[3:])
    except ValueError:
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def autonomy_cfg(raw):
    """settings.autonomy -> {enabled, aware, care, rules, quiet}. Missing = defaults (rules on, aware/care off)."""
    raw = raw if isinstance(raw, dict) else {}
    rules = raw.get("rules") if isinstance(raw.get("rules"), dict) else {}
    q = raw.get("quietHours") if isinstance(raw.get("quietHours"), dict) else {}
    start, end = _hhmm(q.get("start")), _hhmm(q.get("end"))
    return {"enabled": raw.get("enabled") is not False,
            "aware": raw.get("aware") is True,
            "care": raw.get("care") is True,
            "rules": {k: rules.get(k) is not False for k in RULES},
            "quiet": (start, end) if start is not None and end is not None and start != end else None}


def in_window(minute, start, end):
    return start <= minute < end if start < end else (minute >= start or minute < end)


def idle_seconds():
    """Seconds since the last keyboard / mouse input in this Windows session (GetLastInputInfo)."""
    if os.name != "nt":
        return 0.0
    try:
        import ctypes

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]
        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            return 0.0
        now = ctypes.windll.kernel32.GetTickCount() & 0xFFFFFFFF
        return ((now - lii.dwTime) & 0xFFFFFFFF) / 1000.0
    except Exception as exc:  # noqa: BLE001
        _debug("idle", exc)
        return 0.0


def fullscreen_now():
    """Foreground window covers its monitor (desktop / taskbar excluded), or Windows says a fullscreen app runs."""
    from .window import foreground_fullscreen
    return foreground_fullscreen()


def _foreground_now():
    """{process, class, video_hint}；见 window.foreground_app（标题不出函数）。"""
    from .window import foreground_app
    return foreground_app()


def _processes_now():
    from .window import running_processes
    return running_processes()


def _debug(where, exc):
    from .window import _debug as d
    d("autonomy." + where, exc)


class Autonomy:
    def __init__(self, clock=None, idle=None, fullscreen=None, rng=None, memory=None, on_memory=None,
                 foreground=None, processes=None, learned=None, log=None):
        self.clock = clock or datetime.datetime.now
        self.idle = idle or idle_seconds
        self.fullscreen = fullscreen or fullscreen_now
        self.foreground = foreground or _foreground_now
        self.processes = processes or _processes_now
        self.learned = learned or (lambda: {})
        self.log = log                         # activity.ActivityLog-like: write(state, app, dur)
        self.rng = rng or random.Random()
        self.memory = dict(memory or {})      # {"hello": "YYYY-MM-DD"}: survives restarts via on_memory
        self.on_memory = on_memory
        self.spent = collections.deque()
        self.media_pose = None                 # the watching pose *we* set (only that one is taken back)
        self._reset(None)
        self._mail_at = None

    def _reset(self, t):
        self.away = False
        self.slept_this_away = False
        self.yawn_at = None
        self.sleeping = None                  # (kind, what, since, reason)
        self.active_since = None
        self.aside = False
        self.quiet_slept = False
        self.last_late = None
        self.next_fidget = None
        self._fs, self._fs_at = False, None
        self._media_done = False
        self._next_glance = None
        self._game_back = False
        self._sense_reset()

    def _sense_reset(self):
        self._act_at = None
        self._procs, self._procs_at = frozenset(), None
        self._raw, self._raw_app, self._raw_since = None, "", None
        self.state, self.state_app, self.state_since = None, "", None

    # ------------------------------------------------------------------ helpers
    def note_mail(self):
        self._mail_at = self.clock().timestamp()

    def _cap_ok(self, t):
        while self.spent and t - self.spent[0] >= CAP_WINDOW:
            self.spent.popleft()
        return len(self.spent) < CAP

    def _spend(self, t):
        self.spent.append(t)

    def _remember(self, key, value):
        if self.memory.get(key) == value:
            return
        self.memory[key] = value
        if self.on_memory:
            try:
                self.on_memory(dict(self.memory))
            except Exception as exc:  # noqa: BLE001
                _debug("memory", exc)

    def _still_asleep(self, pet, t):
        s = self.sleeping
        if not s:
            return False
        kind, what, since, _ = s
        if kind == "furniture":
            ok = pet.get("inside") == what or (pet.get("inside") is None and t - since < 30)
        else:
            ok = pet.get("pose") == what
        if not ok:
            self.sleeping = None
        return ok

    def _wake(self):
        kind, what = self.sleeping[0], self.sleeping[1]
        self.sleeping = None
        return ("wake", kind, what)

    def _drop_media(self, pet):
        """Take back our own watching pose (if it is still the one showing)."""
        mp, self.media_pose = self.media_pose, None
        self._media_done = False
        self._next_glance = None
        return [("wake", "pose", mp)] if mp and pet.get("pose") == mp else []

    @staticmethod
    def _free(pet):
        return (pet.get("voice") not in BUSY_VOICE and not pet.get("dragging") and not pet.get("inside")
                and not pet.get("held") and not pet.get("moving") and pet.get("pose") is None)

    def _sleep(self, pet, t, reason):
        spot = pet.get("sleep_spot")
        if spot and not pet.get("stay_put"):
            self.sleeping = ("furniture", spot[0], t, reason)
            return [("use", spot[0], spot[1])]
        states = pet.get("states") or ()
        pose = next((s for s in SLEEP_POSES if s in states), None)
        if pose:
            self.sleeping = ("pose", pose, t, reason)
            return [("pose", pose, None)]
        return [("mood", "困", 30)]

    def _pick(self, pet, names):
        states = pet.get("states") or ()
        return next((s for s in names if s in states), None)

    # ------------------------------------------------------------------ what are you doing (aware only)
    def _sense(self, t, idle, fullscreen):
        """Every ACTIVITY_EVERY s: classify; a new state counts after DEBOUNCE_S. -> settled state."""
        if self._act_at is not None and t - self._act_at < ACTIVITY_EVERY:
            return self.state
        self._act_at = t
        try:
            if self._procs_at is None or t - self._procs_at >= PROCESS_EVERY:
                self._procs_at = t
                self._procs = frozenset(self.processes() or ())
            learned = self.learned() or {}
            fg = self.foreground()
            raw = activity.classify(fg, idle, fullscreen, self._procs, learned)
            app = (fg or {}).get("process") or ""
            if raw == "gaming_break":
                app = activity.running_game(self._procs, learned) or app
            elif raw == "away":
                app = ""
        except Exception as exc:  # noqa: BLE001
            _debug("sense", exc)
            return self.state
        if raw != self._raw:
            self._raw, self._raw_app, self._raw_since = raw, app, t
        if self.state is None or (raw != self.state and t - self._raw_since >= DEBOUNCE_S):
            prev = self.state
            self.state, self.state_app, self.state_since = raw, self._raw_app, self._raw_since
            if prev in GAME_STATES and raw not in GAME_STATES and raw not in ("away", "meeting"):
                self._game_back = True
            elif raw in GAME_STATES:
                self._game_back = False
            if self.log is not None:
                try:
                    self.log.write(raw, self._raw_app, t - self._raw_since)
                except Exception as exc:  # noqa: BLE001
                    _debug("log", exc)
        return self.state

    def snapshot(self):
        """For the settings page: the settled state and its process name (no titles exist here at all)."""
        return {"state": self.state, "label": activity.label(self.state) if self.state else "",
                "app": self.state_app or "", "raw": self._raw, "rawApp": self._raw_app or "",
                "since": self.state_since}

    def _schedule_fidget(self, t):
        self.next_fidget = t + self.rng.uniform(*FIDGET_GAP)

    def _glance(self, pet, t):
        if self._next_glance is None:
            self._next_glance = t + self.rng.uniform(*GLANCE_GAP)
            return []
        if (t >= self._next_glance and pet.get("can_look") and pet.get("voice") not in BUSY_VOICE
                and not pet.get("dragging") and not pet.get("moving") and not pet.get("held")):
            self._next_glance = t + self.rng.uniform(*GLANCE_GAP)
            return [("look_center",)]
        return []

    # ------------------------------------------------------------------ the rules
    def tick(self, cfg, pet):
        """cfg = settings dict; pet = snapshot (see PetApp._autonomy_view). -> list of actions."""
        now = self.clock()
        t = now.timestamp()
        a = autonomy_cfg((cfg or {}).get("autonomy"))
        r = a["rules"]
        out = []
        if not a["enabled"]:
            if self._still_asleep(pet, t):
                out.append(self._wake())
            out += self._drop_media(pet)
            self._reset(t)
            self._mail_at = None
            return out

        idle = max(0.0, float(self.idle() or 0.0))
        if self._fs_at is None or t - self._fs_at >= FULLSCREEN_EVERY:
            self._fs_at = t
            try:
                self._fs = bool(self.fullscreen())
            except Exception as exc:  # noqa: BLE001
                _debug("fullscreen", exc)
                self._fs = False
        asleep = self._still_asleep(pet, t)
        minute = now.hour * 60 + now.minute
        quiet = a["quiet"] is not None and in_window(minute, *a["quiet"])
        if self._mail_at is not None and t - self._mail_at > MAIL_TTL:
            self._mail_at = None

        # presence bookkeeping (a film without input is not "away")
        returned = False
        if idle >= AWAY_S and not self._fs:
            self.away = True
        elif self.away and idle < BACK_S:
            self.away, returned = False, True
            self.slept_this_away, self.yawn_at = False, None
        if idle >= BREAK_S:
            self.active_since = None
        elif self.active_since is None:
            self.active_since = t - idle

        # 1) what are you doing — only with the privacy switch on; off = no window / process access at all
        if a["aware"]:
            act = self._sense(t, idle, self._fs)
        else:
            if self.state is not None or self._raw is not None:
                self._sense_reset()
            self._game_back = False
            act = None

        # 2) watching a video together: our own attentive pose, retried until it lands, taken back when done
        if r["videoCompany"] and act == "video":
            if not self._media_done:
                st = self._pick(pet, WATCH_POSES)
                if st is None:
                    self._media_done = True
                elif self._free(pet):
                    self._media_done = True
                    self.media_pose = st
                    out.append(("pose", st, None))
        elif self.media_pose is not None or self._media_done:
            out += self._drop_media(pet)

        # 3) fullscreen: decided by what it is. Video -> corner (videoCorner); anything else -> aside
        if self._fs:
            want = r["videoCorner"] if act == "video" else r["fullscreenHide"]
            if (want and not self.aside and not pet.get("stay_put") and not pet.get("dragging")
                    and not pet.get("inside")):
                self.aside = True
                out.append(("aside",))
            if act == "video" and r["videoCompany"] and self.media_pose and not out:
                out += self._glance(pet, t)
            self.yawn_at = None
            return out
        if self.aside:
            self.aside = False
            return out + [("back",)]
        if pet.get("dragging"):
            return out

        # 4) quiet activities
        if act in GAME_STATES and r["gameCalm"]:
            self.yawn_at = None
            return out
        if act == "meeting" and r["meetingQuiet"]:
            self.yawn_at = None
            return out
        if act == "video" and r["videoCompany"]:
            self.yawn_at = None
            if self.media_pose and not out:
                out += self._glance(pet, t)
            return out
        if out:
            return out

        # back from a game: wave once
        if self._game_back:
            self._game_back = False
            if (r["gameCalm"] and r["welcomeBack"] and not quiet and pet.get("voice") not in BUSY_VOICE
                    and self._free(pet) and self._cap_ok(t)):
                self._spend(t)
                return [("transient", "waving")]

        # back at the computer: undo our sleep, wave
        if returned:
            if asleep and not quiet:
                out.append(self._wake())
                asleep = False
            if (r["welcomeBack"] and not quiet and not asleep and pet.get("voice") not in BUSY_VOICE
                    and self._cap_ok(t)):
                self._spend(t)
                out.append(("transient", "waving"))
                if MORNING[0] <= now.hour < MORNING[1]:
                    self._remember("hello", now.date().isoformat())
            if out:
                return out

        # quiet hours: sleeping only
        if quiet:
            if not asleep and not self.quiet_slept and self._free(pet):
                self.quiet_slept = True
                out += self._sleep(pet, t, "quiet")
            return out
        self.quiet_slept = False
        if asleep:
            if self.sleeping and self.sleeping[3] == "quiet":
                out.append(self._wake())                      # quiet hours are over
            return out

        # yawn -> go to sleep
        if self.yawn_at is not None:
            if t - self.yawn_at >= YAWN_S:
                self.yawn_at = None
                if (self.away and pet.get("voice") not in BUSY_VOICE and not pet.get("inside")
                        and not pet.get("moving") and pet.get("pose") is None):
                    out += self._sleep(pet, t, "idle")
            return out

        if not self._free(pet):
            return out

        if self.away:
            if r["idleSleep"] and not self.slept_this_away and self._cap_ok(t):
                self._spend(t)
                self.slept_this_away = True
                self.yawn_at = t
                out.append(("mood", "困", YAWN_S + 0.5))
            return out

        active = idle < ACTIVE_S
        today = now.date().isoformat()
        if (r["morningHello"] and active and MORNING[0] <= now.hour < MORNING[1] and self.memory.get("hello") != today
                and self._cap_ok(t)):
            self._spend(t)
            self._remember("hello", today)
            return [("transient", "waving")]

        if self._mail_at is not None:
            if not r["newMail"]:
                self._mail_at = None
            elif self._cap_ok(t):
                self._spend(t)
                self._mail_at = None
                box = pet.get("mailbox")
                if box and not pet.get("stay_put"):
                    out.append(("use", box[0], box[1]))
                return out + [("say", "有信", 5)]

        # 「主动关心」（care，宿主侧 lib/proactive.js）开着时本条让位：不再本地喊「歇会儿吧」，
        # 改由叫醒流程让 AI 自己决定怎么说；关掉 care 即恢复。
        if (r["breakReminder"] and not a["care"] and active and self.active_since is not None and t - self.active_since >= WORK_S
                and self._cap_ok(t)):
            self._spend(t)
            self.active_since = t
            out.append(("say", "歇会儿吧", 6))
            st = self._pick(pet, STRETCH)
            if st:
                out.append(("transient", st))
            return out

        if (r["lateNight"] and active and in_window(minute, LATE_FROM, LATE_TO)
                and (self.last_late is None or t - self.last_late >= LATE_EVERY) and self._cap_ok(t)):
            self._spend(t)
            self.last_late = t
            return [("mood", "困", 8)]

        # 干活时安静：不做闲逛小动作（提醒休息照常）
        if r["idleFidget"] and act != "work":
            if self.next_fidget is None:
                self._schedule_fidget(t)
            elif t >= self.next_fidget:
                self._schedule_fidget(t)
                if active and self._cap_ok(t):
                    choices = []
                    if pet.get("can_look"):
                        choices.append(("look",))
                    if not pet.get("stay_put"):
                        choices.append(("walk", self.rng.choice((-1, 1)) * self.rng.randint(60, 140)))
                    if "lie" in (pet.get("states") or ()):
                        choices.append(("pose", "lie", 6))
                    choices.append(("mood", self.rng.choice(("开心", "思考")), 4))
                    self._spend(t)
                    return [self.rng.choice(choices)]
        return out
