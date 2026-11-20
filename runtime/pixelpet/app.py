"""The desktop pet: one character window + furniture windows + control endpoint + voice bridge.

Mouse: click = wave, double-click = jump, drag = carry, wheel = resize, right-click = menu.
Voice: the hotkey (settings.voice.hotkey, default F8) and the hub's mic button both flip continuous
listening on / off (voice/vad.py: every finished sentence is recognised and sent); menu "说话" takes one
sentence (stops on silence). Hub bar (hub.py): text / listening switch / screenshots into the pointed session.
All Tk work happens on the main thread; other threads only post callables to `_ui_queue`
(calling root.after from a worker thread leaks Tcl event handles).
"""
import collections
import json
import math
import os
import queue
import threading
import time
import tkinter as tk

from . import mailbox as MB
from . import packkit as PK
from .autonomy import Autonomy, idle_seconds
from . import window as W
from .card_dock import CardHost
from .reading_dock import ReadingHost
from .character import PackError, character_folder, load_character
from .bubble import BubbleStack
from .control import ControlServer
from .furniture import (FurnitureWindow, clamp_spot, default_spot, is_enabled, load_furniture, pick_side,
                        fill_name, make_occupant, sanitize_cfg, stand_spot, summary, sync_sig)
from . import bookshelf as BS
from .petstate import PetStateLog
from . import calendardock as CD
from .hub import DEFAULT_HUB, hub_cfg
from .state import FrameClock, choose_state, degrees_to_gaze, gaze_index, music_state
from .voiceprint_integration import VoicePrintHost

DEFAULT_SETTINGS = {"character": "", "size": 0.65, "topmost": True, "stayPut": False, "follow": True,
                    "position": None, "furniture": {}, "voice": {"stt": {"engine": "dsh"},
                                                                  "tts": {"engine": "qwen", "voice": "whale-girl"},
                                                                  "llm": {"sessionId": ""}, "hotkey": "F8",
                                                                  "interruption": {"enabled": True,"reply":"嗯，你说"},
                                                                  "failure": {"enabled": True,"reply":"糟糕，服务器出现错了，快检查一下配置。"},
  "approval": {"enabled": True,"reply":"有个审批要你点一下。"},
  "question": {"enabled": True,"reply":"这里有个问题要问你。"},
  "tone": {"enabled": True}},
                    "hub": dict(DEFAULT_HUB)}
MOVE_LIMIT, MOVE_WINDOW = 6, 60.0
DIRECTIONS = {"up": 0, "up-right": 45, "right": 90, "down-right": 135, "down": 180, "down-left": 225,
              "left": 270, "up-left": 315}
OFFSCREEN_WORK = (-6000, -6000, -2400, -2400)
MOOD_FALLBACK = {"困": "mood-sleepy", "开心": "mood-happy", "思考": "mood-thinking"}


def default_data_dir():
    return os.environ.get("PIXELPET_DATA_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "dsh-pixel-pet")


def load_settings(data_dir):
    s = json.loads(json.dumps(DEFAULT_SETTINGS))
    try:
        with open(os.path.join(data_dir, "settings.json"), encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError('settings must be an object')
        s.update(raw)              # keep raw SV settings: malformed values must not become disabled
        # voice 是浅合并：settings.json 里没有的新分组（如 approval / question）要用默认值补上，
        # 否则 s.update(raw) 会把整块 voice 覆盖掉，新加的默认台词就丢了。
        if isinstance(raw.get("voice"), dict):
            merged_voice = dict(s.get("voice") or {})
            merged_voice.update(raw["voice"])
            s["voice"] = merged_voice
    except FileNotFoundError:
        pass                      # normal first install has no settings and SV stays off
    except (OSError, ValueError):
        s['_voiceprintConfigError'] = True  # runtime-only; the facade fails closed
    try:
        s["size"] = max(.3, min(3.0, float(s["size"])))
    except (TypeError, ValueError):
        s["size"] = 0.65
    s["furniture"] = sanitize_cfg(s.get("furniture"))
    s["hub"] = hub_cfg(s.get("hub"))
    return s


def save_settings(data_dir, s):
    if s.get('_voiceprintConfigError'):
        return  # never overwrite an unreadable settings file with fallback defaults
    s = {k: v for k, v in s.items() if k != '_voiceprintConfigError'}
    try:
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, "settings.json")
        # Only the host folder picker can grant audio access. A stale window
        # snapshot (e.g. saving its position) must not restore a revoked folder.
        try:
            with open(path, encoding="utf-8") as current:
                disk = json.load(current)
        except FileNotFoundError:
            disk = {}
        except ValueError:
            return
        saved_listen = disk.get("listen") if isinstance(disk, dict) else None
        next_listen = dict(s["listen"]) if isinstance(s.get("listen"), dict) else {}
        if isinstance(saved_listen, dict) and "audioDirs" in saved_listen:
            next_listen["audioDirs"] = saved_listen["audioDirs"]
        else:
            next_listen.pop("audioDirs", None)
        if "listen" in s or next_listen:
            s["listen"] = next_listen
        tmp = path + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


class PetApp:
    TICK_MS = 30

    @staticmethod
    def _first_runnable(pack_root, data_dir=None):
        """没选角色时：鲸鱼娘能跑就用她，否则用第一个能跑的包（骨架包跳过）。

        The data dir's characters/ is the user layer (packs made with "+ 新建角色" and edited copies of
        built-in packs); a runnable user version wins over the built-in one it is named after.
        """
        from .character import list_characters
        seen = {}
        for root, prefer in ((data_dir, True), (pack_root, False)):
            if not root:
                continue
            for p in list_characters(root):
                if not (p["ok"] and not p["draft"]):
                    continue
                if prefer or p["id"] not in seen:
                    seen[p["id"]] = p
        ids = list(seen)
        return "whale-girl" if "whale-girl" in ids else (ids[0] if ids else "whale-girl")

    def __init__(self, root, pack_root, data_dir=None, character=None, offscreen=False, speed=120.0,
                 fullscreen_probe=None, voice=None, idle_probe=None, foreground_probe=None, process_probe=None):
        self.root = root
        self.pack_root = pack_root
        self.data_dir = data_dir or default_data_dir()
        self.offscreen = offscreen
        self.speed = speed
        self.cfg = load_settings(self.data_dir)
        cid = character or self.cfg.get("character") or self._first_runnable(pack_root, self.data_dir)
        self._pack_character_dirs = PK.packed_characters(self.data_dir)
        try:
            self.char = load_character(character_folder(pack_root, self.data_dir, cid))
        except (PackError, OSError):
            if cid not in self._pack_character_dirs:
                raise
            self.char = load_character(character_folder(pack_root, self.data_dir, "whale-girl"))
        self._music_state = "off"
        self._music_paused_at = 0.0
        self.size = self.cfg["size"]
        self.topmost = bool(self.cfg.get("topmost", True))
        self._fullscreen_probe = fullscreen_probe or (lambda: False if offscreen else W.foreground_fullscreen())
        # 「允许感知在做什么」的探针：离屏运行（测试 / --selftest）默认什么都看不到，绝不读真实桌面
        self._foreground_probe = foreground_probe or ((lambda: None) if offscreen else W.foreground_app)
        self._process_probe = process_probe or ((lambda: frozenset()) if offscreen else W.running_processes)
        self.cache = collections.OrderedDict()
        self.clock = FrameClock()
        self.cur_state, self.frame_idx = "idle", 0
        self.manual = "idle"
        self._manual_until = None
        self.transient = self.pose = self.mood = None
        self.walk_dir = None
        self.motion = None
        self.drag = None
        self.drag_dir = None
        self.gaze, self.look_hold = None, None
        self.voice_state = "idle"
        self.last_failure_error = None
        self.inside = None
        self._use_pose = False
        self._move_times = collections.deque()
        self._click_job = None
        self._draw_key = None
        self._closed = False
        self._ui_queue = queue.SimpleQueue()
        self._cfg_mtime = None
        self._reduced = W.reduced_motion_system()
        self.seen_states = set()
        self.frames_drawn = 0

        self.root, self.canvas = W.overlay(root, *self.win_size(), topmost=self.topmost)
        self.hwnd = W.native_flags(root)
        c = self.canvas
        c.bind("<ButtonPress-1>", self.on_press)
        c.bind("<B1-Motion>", self.on_drag)
        c.bind("<ButtonRelease-1>", self.on_release)
        c.bind("<Double-Button-1>", self.on_double)
        c.bind("<Button-3>", self.on_menu)
        root.bind("<MouseWheel>", lambda e: self.set_size(self.size + (.05 if e.delta > 0 else -.05)))
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.menu = tk.Menu(root, tearoff=0)
        self.menu.add_command(label="说话", command=self.toggle_talk)
        self.menu.add_command(label="输入条", command=lambda: self.hub and self.hub.toggle())
        self.menu.add_separator()
        self.menu.add_command(label="置顶", command=self.toggle_topmost)
        self.menu.add_command(label="别乱走", command=self.toggle_stay)
        self.menu.add_separator()
        self.menu.add_command(label="退出", command=self.quit)
        self.bubble = BubbleStack(self)

        pos = self.cfg.get("position") or {}
        start = (pos.get("x", 200), pos.get("y", 200)) if not offscreen else (OFFSCREEN_WORK[0] + 400, OFFSCREEN_WORK[1] + 400)
        self.place(*start, clamp=not offscreen)
        self._draw()

        self.furniture_defs, self.furniture_errors, self.furniture = {}, {}, {}
        self._packs_mtime = None
        self._packs_gen = None
        self._packs_reg_error = None
        self._reload_packs()
        self._fcfg_sig = None
        self.mail = MB.MailFlag(self.data_dir)
        self._mail_at = 0.0
        self._packs_at = 0.0
        # 「一起听歌」 card window glued beside the pet (card_dock.py); off-screen runs skip Win32
        self.card = None if offscreen else CardHost(self, settings=lambda: load_settings(self.data_dir))
        # 「一起看书」 reading window (reading_dock.py): opened on demand, closed with the switch / the pet
        self.reading = None if offscreen else ReadingHost(self, settings=lambda: load_settings(self.data_dir))
        self.sync_furniture()
        # 「主动一点」 local rules (autonomy.py). Off-screen runs (tests, --selftest) only get them when handed an
        # idle probe, so a morning test run never waves on its own.
        self.autonomy = None
        self._auto_at = 0.0
        # 「活动与额度」页签 v2：桌宠状态监测（只记类别，去抖 10 s 写 pet-state.jsonl）
        self._state_at = 0.0
        self._state_log = PetStateLog(self.data_dir)
        self._aside_from = None
        if not offscreen or idle_probe is not None:
            from . import activity as ACT
            self._learned = ACT.Learned(self.data_dir)
            self.autonomy = Autonomy(idle=idle_probe or idle_seconds, fullscreen=self._fullscreen_probe,
                                     memory=self._auto_memory(), on_memory=self._auto_memory_save,
                                     foreground=self._foreground_probe, processes=self._process_probe,
                                     learned=self._learned.get, log=ACT.ActivityLog(self.data_dir))

        # Lightweight facade stays attached even while disabled; it imports no SV model here.
        self.voiceprint = VoicePrintHost(self)
        self.mic = None
        self._talk_key = False
        self._voice_sig = self._engine_signature()
        self.voice = voice
        self._own_voice = voice is None
        if self.voice is None:
            self.voice = self._make_voice()
        else:
            # Injected test bridges must obey the same dynamic gate as ordinary bridges.
            self.voice.sv = self.voiceprint
        self.listener = None
        self._fake_sd = None           # tests / selftest hand in a sounddevice stand-in
        self._hf_listening = False
        self._hf_resume_at = 0.0
        self.hub = None
        self.hub_errors = {}
        try:
            from .hub import HubBar
            self.hub = HubBar(self)
            self.apply_topmost()          # the bar is built topmost; follow the pet's own setting
            # 2026-11-15：启动阶段窗口还在铺、扩展样式也在改，topmost 容易丢；
            # 过一会儿再顶一次，省得每次重启都要手点两下。
            try:
                self.root.after(700, self.apply_topmost)
            except Exception:  # noqa: BLE001
                pass
        except Exception as exc:  # noqa: BLE001
            self.hub_errors["hub"] = "%s: %s" % (type(exc).__name__, str(exc)[:120])
        self.control = None
        try:
            self.control = ControlServer(self._dispatch_threadsafe, os.path.join(self.data_dir, "control.json"))
        except OSError:
            self.control = None
        self._prewarm_job = None
        if not self.offscreen and ((self.cfg.get("voice") or {}).get("tts") or {}).get("engine") != "custom":
            # Load the speech engine before the first turn needs it: the ~5-10 s of model loading then
            # overlaps with whatever the user is doing. Off by default for --selftest runs.
            try:
                self._prewarm_job = self.root.after(20000, self._startup_prewarm)
            except Exception:  # noqa: BLE001 - a Tk without timers must not break start-up
                self._prewarm_job = None
        self._loop_job = root.after(self.TICK_MS, self._loop)

    # ------------------------------------------------------------------ geometry
    def factor(self):
        return self.size * self.char.display_scale

    def win_size(self):
        return tuple(max(8, round(v * self.factor())) for v in self.char.canvas)

    def pos(self):
        return self._x, self._y

    def body_box(self):
        """Opaque bounding box of the idle frame in window px: (l, t, r, b)."""
        key = ("box", round(self.factor(), 3))
        if key not in self.cache:
            box = self.char.frames["idle"][0].getchannel("A").getbbox() or (0, 0) + self.char.canvas
            f = self.factor()
            self.cache[key] = tuple(round(v * f) for v in box)
        return self.cache[key]

    def body_screen(self):
        l, t, r, b = self.body_box()
        return self._x + l, self._y + t, self._x + r, self._y + b

    def work_area(self):
        l, t, r, b = self.body_screen()
        return self.mon((l + r) / 2, b)[1]

    def mon(self, x, y):
        if self.offscreen:
            return OFFSCREEN_WORK, OFFSCREEN_WORK
        m = W.monitor_at(x, y)
        if m:
            return m
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        return (0, 0, sw, sh), (0, 0, sw, sh)

    def clamp(self, x, y, work):
        l, t, r, b = self.body_box()
        nx = max(work[0] - l, min(x, work[2] - r))
        ny = max(work[1] - t, min(y, work[3] - b))
        return nx, ny, (abs(nx - x) > .5 or abs(ny - y) > .5)

    def place(self, x, y, clamp=True):
        if clamp:
            l, t, r, b = self.body_box()
            x, y, _ = self.clamp(x, y, self.mon(x + (l + r) / 2, y + b)[1])
        self._x, self._y = int(round(x)), int(round(y))
        W.set_pos(self.root, self.hwnd, self._x, self._y)

    # ------------------------------------------------------------------ drawing / state
    def _frame(self, state, idx):
        f = self.factor()
        key = (state, idx, round(f, 3))
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        src = self.char.look_frames if state == "look" else self.char.frames[state]
        img = W.photo(src[idx % len(src)], f)
        self.cache[key] = img
        while len(self.cache) > 160:
            self.cache.popitem(last=False)
        return img

    def _draw(self):
        state, idx = ("look", self.gaze) if self.gaze is not None else (self.cur_state, self.frame_idx)
        key = (state, idx, round(self.size, 3))
        if key == self._draw_key:
            return
        img = self._frame(state, idx)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=img, anchor="nw")
        self._img = img
        w, h = img.width(), img.height()
        if (int(self.canvas.cget("width")), int(self.canvas.cget("height"))) != (w, h):
            self.canvas.configure(width=w, height=h)
            self.root.geometry("%dx%d" % (w, h))
        self._draw_key = key
        self.frames_drawn += 1

    def desired_state(self):
        if self._manual_until is not None and time.time() > self._manual_until:
            self.manual, self._manual_until = "idle", None
        voice = self.voice_state
        lst = self.listener
        if voice in ("idle", "listening") and lst is not None:
            try:
                if lst.vad.active:
                    voice = "hearing"
            except Exception:
                pass
        now = time.time()
        ordinary = getattr(self.char, "base_states", self.char.states)
        desired = choose_state(ordinary, drag=self.drag_dir, walk=self.walk_dir, transient=self.transient,
                               voice=voice, manual=self.manual, pose=self.pose, mood=self.mood, now=now)
        if not (getattr(self, "cfg", {}).get("listen") or {}).get("enabled"):
            return desired
        protected = (self.inside or self.drag or self.walk_dir or any(lease and (lease[1] is None or lease[1] > now)
                            for lease in (self.transient, self.pose, self.mood, self.look_hold)))
        return music_state(self.char.states, desired, self._music_state, voice=voice, protected=protected,
                           paused_seconds=time.monotonic() - self._music_paused_at)

    ACTIVITY_HOLD = {"working": ("running", 600.0), "waiting": ("waiting", 600.0), "failed": ("failed", 20.0)}

    def set_activity(self, state):
        """The pointed session's own state (lib/activity.js): working / waiting / failed / done / idle."""
        # 等待是会话级覆盖层，不是工具级动作。结束/恢复时连同新版举牌一起撤掉，
        # 不改语音回合，也不误删刚发来的 ack 等其他瞬时动作。
        if state in ("working", "done", "idle", "failed"):
            live_transient = getattr(self, "transient", None)   # 测试夹具不一定带这个字段
            if live_transient and live_transient[0] in ("waiting", "pleading"):
                self.transient = None
        if state == 'working':self._deferred_done = None
        if state == "done":
            voice=getattr(self,'voice',None)
            status=getattr(voice,'status',None)
            try:
                snapshot=status() if callable(status) else {}
                speaking=bool(snapshot.get('progressSpeaking') or snapshot.get('state') in ('thinking','speaking'))
            except Exception:speaking=False
            if speaking:
                self._deferred_done=(voice,getattr(voice,'_turn',None))
                self.manual,self._manual_until='idle',None
                return True
            self.manual, self._manual_until = "idle", None
            # 正在播的瞬时动作（比如刚点完审批的点头）不能被 review 立刻盖掉：
            # review 只是收工的余韵，丢掉一瞬无妨，截断别的动作更难看。
            now = time.time()
            busy = getattr(self, "transient", None)
            busy = bool(busy) and (busy[1] is None or busy[1] > now)
            if "review" in self.char.states and not busy:
                self.transient = ("review", now + self.char.total_ms("review") / 1000)
            return True
        if state == "idle":
            self.manual, self._manual_until = "idle", None
            return True
        sid, hold = self.ACTIVITY_HOLD.get(state, (None, 0))
        if state == "waiting" and "pleading" in self.char.states:
            sid = "pleading"  # 审批用新举牌；旧 waiting 端碗帧仍完整保留。
        if not sid or sid not in self.char.states:
            return False
        entering = self.manual != sid or not self._manual_until or self._manual_until < time.time()
        self.manual, self._manual_until = sid, time.time() + hold
        if state == "waiting":
            # 举牌/端碗都高于「思考中」，一直等到审批结束；其他角色缺新帧时沿用端碗。
            self.transient = (sid, time.time() + hold)
            if entering:
                self._say_prompt("approval")       # 仍用既有的非回合旁白通道。
        if state == "failed" and entering:
            self._say_failure()
        return True

    # 工具级瞬时动作的计划名 → 现在角色里已有的状态（素材到位后从这里删掉即可）
    ACTION_ALIAS = {
        "searching": "attentive", "reading": "attentive", "writing": "attentive",
        "typing": "attentive", "shooting": "attentive", "noting": "attentive", "painting": "attentive",
        "pleading": "waiting", "asking": "mood-confused", "ack": "waving", "calling": "waving",
        "oops": "mood-oops",
    }

    def _anim_log(self, verdict, plan, state, hold):
        """动画排查日志：一行一次（只记状态名/时长，不记内容）。"""
        try:
            path = os.path.join(self.data_dir, "anim-log.jsonl")
            row = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "side": "pet", "kind": verdict,
                   "plan": plan, "state": state, "ms": int(hold * 1000)}
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001
            pass

    def play_action(self, state, ms=None, plan=None):
        """One-shot action from a tool call: overlay 0.3–1.2 s, then fall back to the session state.

        Never touches self.manual: the session's own state (working / waiting) keeps running
        underneath, so a failed or finished tool still leaves the pet in the right state.
        """
        if (plan or state) == "asking":
            self._say_prompt("question")           # 提问卡到达：和歪头同一拍念一句
        sid = state if state in self.char.states else self.ACTION_ALIAS.get(state)
        if not sid or sid not in self.char.states:
            self._anim_log("unknown", state, "", 0)
            return False
        try:
            want = float(ms) / 1000.0 if ms else 0.0     # ms 是毫秒（宿主传的就是毫秒）
        except (TypeError, ValueError):
            want = 0.0
        if want <= 0:
            want = self.char.total_ms(sid) / 1000.0
        hold = max(0.3, min(1.2, want))
        now = time.time()
        # a longer, more meaningful lease (drag / pose / mood) must not be cut short by a tool tick
        if self.transient and self.transient[1] and self.transient[1] - now > hold:
            self._anim_log("kept-longer", state, sid, hold)
            return True
        self.transient = (sid, now + hold)
        self._anim_log("play", state, sid, hold)
        return True

    def _say_prompt(self, kind):
        """审批 / 提问的旁白：照 interruption / failure 的做法（开关 + 台词），不占对话回合。"""
        voice = getattr(self, "voice", None)
        if voice is None:
            return
        conf = (self.cfg.get("voice") or {}).get(kind) or {}
        if conf.get("enabled", True) is False:
            return
        text = str(conf.get("reply") or "").strip()
        if not text:                     # 旧 settings.json 里还没这一项时，用内置默认台词
            text = str(((DEFAULT_SETTINGS.get("voice") or {}).get(kind) or {}).get("reply") or "").strip()
        if not text:
            return
        # 走 announce（不占回合）：用 speak 会把 _turn 推走，正在路上的回答会被静默丢掉
        talk = getattr(voice, "announce", None) or voice.speak

        def run():
            try:
                out = talk(text)
                skipped = bool(isinstance(out, dict) and out.get("skipped"))
                self._anim_log("announce-skip" if skipped else "announce-play", kind, "", 0)
            except Exception:  # noqa: BLE001 — 念不出来不影响桌宠
                self._anim_log("announce-error", kind, "", 0)

        try:
            threading.Thread(target=run, daemon=True).start()
        except Exception:  # noqa: BLE001
            pass

    def _say_failure(self):
        """Session failure only; speech failures get text feedback, never recursive speech."""
        # Activity events are drained before the tick's hot reload. Read through the same
        # safety gates here too, so a save + failed event in that tick uses the new line.
        if hasattr(self, "data_dir"):
            self._hot_reload()
        f = (self.cfg.get("voice") or {}).get("failure") or {}
        text = str(f.get("reply") or "").strip()
        if f.get("enabled", True) is False or not text or self.voice is None:
            return
        voice = self.voice
        before = getattr(voice, "_turn", None)

        def current(turn):
            return (not getattr(self, "_closed", False) and self.voice is voice
                    and (turn is None or getattr(voice, "_turn", None) == turn))

        def work():
            # Do not let a delayed worker replace a newer voice turn.
            if not current(before):
                return
            turn = before + 1 if isinstance(before, int) else None
            try:
                guarded = getattr(voice, "speak_if_current", None)
                # The real bridge compares ownership and begins the notification atomically.
                # Keep a plain-speak fallback for injected non-bridge voices/tests.
                out = guarded(text, before) if callable(guarded) else voice.speak(text)
            except Exception as exc:  # noqa: BLE001 - report without trying TTS again
                out = {"error": "%s: %s" % (type(exc).__name__, str(exc))}
            if not isinstance(out, dict) or out.get("cancelled") or out.get("interrupted"):
                return
            turn = out.get("turn", turn)
            error = out.get("error")
            if not error:
                return
            error = str(error)[:500]

            def report():
                # Ownership can change both while speaking and while this UI callback waits.
                if current(turn):
                    self.last_failure_error = error
                    self.bubble.show("会话报错台词未能播放：%s" % error, 6)
            self.post_ui(report)
        threading.Thread(target=work, daemon=True).start()

    def _update_gaze(self):
        now = time.time()
        if self.look_hold and self.look_hold[1] > now and self.char.look_frames:
            self.gaze = self.look_hold[0]
            return
        self.look_hold = None
        if (not self.char.look_frames or not self.cfg.get("follow", True) or self.cur_state != "idle"
                or self.drag or self.motion or self.offscreen):
            self.gaze = None
            return
        px, py = self.root.winfo_pointerxy()
        l, t, r, b = self.body_box()
        self.gaze = gaze_index(px - (self._x + (l + r) / 2), py - (self._y + t + (b - t) * .35), previous=self.gaze)

    def _loop(self):
        if self._closed:
            return
        now = time.monotonic()
        self._drain()
        self._hot_reload()
        if now - getattr(self, "_layers_at", 0.0) >= .1:
            self._layers_at = now
            self.apply_topmost()
        self._tick_motion(now)
        try:
            self._tick_talk()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._tick_furniture(now)
            if now - self._mail_at > 1.0:
                self._mail_at = now
                self.tick_mail()
            if now - self._packs_at > 1.0:
                self._packs_at = now
                self._packs_check()
        except Exception:  # noqa: BLE001
            pass
        if self.autonomy is not None and now - self._auto_at >= 1.0:
            self._auto_at = now
            try:
                self.tick_autonomy()
            except Exception:  # noqa: BLE001
                pass
        if now - self._state_at >= 1.0:
            self._state_at = now
            try:
                self._state_log.observe(self._monitor_snapshot())
                self._state_log.heartbeat(self._monitor_snapshot())  # 状态没变每 5 分钟一跳，宿主据此判 offline
            except Exception:  # noqa: BLE001
                pass
        want = self.desired_state()
        if want != self.cur_state:
            self.cur_state = want
            self._draw_key = None
        self.seen_states.add(want)
        self.frame_idx = self.clock.tick(want, self.char.durations(want), now, self._reduced, self.char.loops(want))
        self._update_gaze()
        self._draw()
        self.bubble.follow()
        if self.card is not None:
            try:
                self.card.tick()
            except Exception:  # noqa: BLE001
                pass
        if self.reading is not None:
            try:
                self.reading.tick()
            except Exception:  # noqa: BLE001
                pass
        try:
            self._tick_hub(now)
        except Exception:  # noqa: BLE001
            pass
        self._loop_job = self.root.after(self.TICK_MS, self._loop)

    def post_ui(self, fn):
        self._ui_queue.put(fn)

    def _drain(self):
        for _ in range(64):
            try:
                fn = self._ui_queue.get_nowait()
            except queue.Empty:
                return
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass

    def _hot_reload(self):
        try:
            m = os.stat(os.path.join(self.data_dir, "settings.json")).st_mtime_ns
        except OSError:
            return
        if m == self._cfg_mtime:
            return
        self._cfg_mtime = m
        # A save may land after __init__ read cfg but before this first stat.
        # Even the first observed mtime must read/apply the latest settings.
        previous = (getattr(self, "cfg", {}) or {}).get("character")
        self.cfg = load_settings(self.data_dir)
        cid = self.cfg.get("character")
        if cid and cid != previous and getattr(self, "char", None) and cid != self.char.id:
            pk = PK.resolve_one(self.pack_root, self.data_dir, "character", cid)
            if pk and pk["valid"]:
                self._switch_character(pk["dir"])
        want_top = bool(self.cfg.get("topmost", True))      # 设置页的「置顶」开关
        if want_top != getattr(self, "topmost", want_top) and getattr(self, "root", None) is not None:
            self.apply_topmost(want_top)
        if not self.voiceprint.enabled:
            self._close_voiceprint()
        if abs(self.cfg["size"] - self.size) > .001:
            self.set_size(self.cfg["size"], persist=False)
        self.sync_furniture()
        if self.hub is not None:
            self.hub.sync(self.hub_cfg())
            if self.inside:
                self.hub.set_visible(False)
        if self.listener is not None and not self.hub_cfg()["show"]:
            self.set_listening(False)
        sig = self._engine_signature()
        if sig != self._voice_sig and self._own_voice:
            self._voice_sig = sig
            old, self.voice = self.voice, self._make_voice()
            self._set_tts_idle()
            threading.Thread(target=old.close, daemon=True).start()
        if hasattr(self.voice,"configure_interrupt"):
            self.voice.configure_interrupt((self.cfg.get("voice") or {}).get("interruption"))
        _tune = getattr(self.voice, "configure_tone", None)
        if callable(_tune):
            _tune((self.cfg.get("voice") or {}).get("tone"))
            self.voice.set_barge_listening(self.listener is not None)

    def set_size(self, value, persist=True):
        self.size = max(.3, min(3.0, round(value, 2)))
        self.cache.clear()
        self._draw_key = None
        self._draw()
        for w in self.furniture.values():
            w._key = None
        if persist:
            self.cfg["size"] = self.size
            save_settings(self.data_dir, self.cfg)

    # ------------------------------------------------------------------ motion
    def start_motion(self, tx, ty, done, then=None, look_cursor=False):
        if self.motion:
            self.finish_motion(False, "被新的命令接替了。")
        self.pose = self.look_hold = None
        self.motion = {"x": float(self._x), "y": float(self._y), "tx": float(tx), "ty": float(ty), "done": done,
                       "then": then, "look_cursor": look_cursor, "last": time.monotonic(),
                       "event": threading.Event(), "result": None, "on_arrive": None}
        return self.motion

    def finish_motion(self, ok, message):
        m, self.motion = self.motion, None
        self.walk_dir = None
        if m:
            m["result"] = (ok, message)
            m["event"].set()

    def _tick_motion(self, now):
        m = self.motion
        if not m:
            return
        dt = max(0.0, min(0.1, now - m["last"]))
        m["last"] = now
        dx, dy = m["tx"] - m["x"], m["ty"] - m["y"]
        dist = math.hypot(dx, dy)
        step = self.speed * dt
        if abs(dx) > 1:
            self.walk_dir = "walk-right" if dx > 0 else "walk-left"
        elif not self.walk_dir:
            self.walk_dir = "walk-right"
        if dist <= step:
            m["x"], m["y"] = m["tx"], m["ty"]
        else:
            m["x"] += dx / dist * step
            m["y"] += dy / dist * step
        self.place(m["x"], m["y"], clamp=False)
        if dist <= step:
            if m["then"]:
                self.pose = (m["then"], None)
            if m["on_arrive"]:
                try:
                    m["on_arrive"]()
                except Exception:  # noqa: BLE001
                    pass
            self.finish_motion(True, m["done"])
            if m["look_cursor"]:
                self.command({"cmd": "look", "target": "cursor"})

    def move_guard(self, now):
        if self.cfg.get("stayPut"):
            return "设置了别动，这次没动。"
        if self._fullscreen_probe():
            return "前台是全屏应用，先不动。"
        while self._move_times and now - self._move_times[0] > MOVE_WINDOW:
            self._move_times.popleft()
        if len(self._move_times) >= MOVE_LIMIT:
            return "一分钟内已经走了 %d 次，歇一会儿。" % MOVE_LIMIT
        if self.drag:
            return "正被拿着，先不动。"
        return None

    def resolve_target(self, body):
        x0, y0 = self._x, self._y
        l, t, r, b = self.body_box()
        mon, work = self.mon(x0 + (l + r) / 2, y0 + b)
        if body.get("cmd") == "walk":
            try:
                dx = float(body.get("dx"))
            except (TypeError, ValueError):
                return None, "walk 需要数字 dx。"
            x, y, c = self.clamp(x0 + dx, y0, work)
            return (x, y, "到边了。" if c else "走好了。", False), None
        anchor = body.get("anchor")
        if anchor == "cursor":
            px, py = self.root.winfo_pointerxy()
            mon, work = self.mon(px, py)
            gap = (r - l) * .5 + 6
            x = px - gap - (l + r) / 2 if x0 + (l + r) / 2 <= px else px + gap - (l + r) / 2
            x, y, _ = self.clamp(x, py - (t + b) / 2, work)
            return (x, y, "到鼠标旁边了。", True), None
        if anchor == "taskbar":
            x, y, _ = self.clamp(x0, work[3] - b, work)
            return (x, y, "到任务栏上面了。", False), None
        if anchor == "active-window":
            rect = None if self.offscreen else W.foreground_rect()
            if not rect:
                return None, "现在没有可以靠过去的窗口。"
            mon, work = self.mon((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
            x, y = rect[2] - l, rect[3] - b
            if x + r > work[2]:
                x = rect[0] - r
            x, y, _ = self.clamp(x, y, work)
            return (x, y, "到当前窗口旁边了。", False), None
        if anchor == "home":
            p = self.cfg.get("position") or {"x": 200, "y": 200}
            x, y, _ = self.clamp(p["x"], p["y"], self.mon(p["x"], p["y"])[1])
            return (x, y, "回到原位了。", False), None
        if anchor not in (None, ""):
            return None, "不认识的位置。可用 taskbar / active-window / home / cursor，或给 x、y。"
        try:
            tx, ty = float(body["x"]), float(body["y"])
        except (KeyError, TypeError, ValueError):
            return None, "move_to 需要 anchor，或者数字 x、y。"
        if not (math.isfinite(tx) and math.isfinite(ty)):
            return None, "坐标不对。"
        x, y, c = self.clamp(tx - (l + r) / 2, ty - b, self.mon(tx, ty)[1])
        return (x, y, "停在屏幕边缘。" if c else "走到了。", False), None

    NOTICE_HOLD_MS = 2500

    SHELL_CLASSES = ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd")

    def _skip_window(self, w):
        """桌面/任务栏/自己这些不算「可以靠过去的窗口」。"""
        try:
            if str(w.get("cls") or "") in self.SHELL_CLASSES:
                return True
            if str(w.get("process") or "").lower() in ("explorer.exe",) and not str(w.get("title") or "").strip():
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def match_keys(needle):
        """一个 match 可能是窗口名、文件名，或**完整路径** —— 都拆成候选关键词（长词优先）。

        用户常直接给绝对路径（如 D:\\Projects\\app\\src\\main.js），
        窗口标题里通常只有文件名或文件夹名，所以要把路径拆开逐个试。
        """
        raw = str(needle or "").strip()
        if not raw:
            return []
        keys = [raw.lower()]
        norm = raw.replace("/", "\\").rstrip("\\")
        parts = [x for x in norm.split("\\") if x.strip()]
        if parts:
            base = parts[-1]
            keys.append(base.lower())
            stem = base.rsplit(".", 1)[0] if "." in base else base
            if stem and stem.lower() != base.lower():
                keys.append(stem.lower())
            if len(parts) >= 2:
                keys.append(parts[-2].lower())
            else:
                # 纯文件名（没有目录）：把点后当扩展名丢掉已经在上面做过
                pass
        generic = {"lib", "src", "bin", "web", "dist", "test", "tests", "docs", "doc",
                   "app", "assets", "node_modules", "temp", "tmp", "cache"}
        out = []
        for k in keys:
            k = k.strip()
            if not k or k in out:
                continue
            if len(k) < 3 or k in generic:      # 太短或太通用的目录名会把窗口认错
                continue
            out.append(k)
        out.sort(key=len, reverse=True)
        return out

    def window_rect_for(self, needle):
        """按标题或进程名找一扇窗口 → (rect, title, iconic)；找不到 (None, "", False)。

        同一程序常有好几个窗，取面积最大的那扇（主窗通常是它）。
        最小化的窗口也认：它没地方可站，调用方应当退到任务栏（它就缩在那儿）。
        """
        try:
            from . import screen as S
            keys = self.match_keys(needle)
            if not keys:
                return None, "", False
            best = None
            for w in S._raw_windows():
                if not w.get("visible") or w.get("cloaked") or self._skip_window(w):
                    continue
                title = str(w.get("title") or "")
                if not title.strip():
                    continue
                proc = str(w.get("process") or "")
                hay = (title + " " + proc).lower()
                if not any(k in hay for k in keys):
                    continue
                rect = w.get("rect")
                if not rect:
                    continue
                area = (rect[2] - rect[0]) * (rect[3] - rect[1])
                if w.get("iconic"):
                    area = -1                       # 最小化的先占位，只在没有正常窗口时才用
                elif rect[2] - rect[0] < 60 or rect[3] - rect[1] < 40:
                    continue
                if best is None or area > best[0]:
                    best = (area, rect, title, bool(w.get("iconic")))
            if best:
                return best[1], best[2], best[3]
        except Exception:  # noqa: BLE001 — 找不到就当没有，不打扰
            pass
        return None, "", False

    def biggest_window_rect(self):
        """前台窗口取不到时的兜底：面积最大的那扇可见窗口（排除桌宠自己）。"""
        try:
            from . import screen as S
            own = os.getpid()
            best = None
            for w in S._raw_windows():
                if not w.get("visible") or w.get("iconic") or w.get("cloaked") or self._skip_window(w):
                    continue
                if w.get("_pid") == own:
                    continue
                title = str(w.get("title") or "")
                rect = w.get("rect")
                if not title.strip() or not rect:
                    continue
                area = (rect[2] - rect[0]) * (rect[3] - rect[1])
                if area < 40_000:
                    continue
                if best is None or area > best[0]:
                    best = (area, rect, title)
            if best:
                return best[1], best[2]
        except Exception:  # noqa: BLE001
            pass
        return None, ""

    def target_near_rect(self, rect):
        """站在某扇窗口的右下角外侧，尽量不压内容。"""
        l, t, r, b = self.body_box()
        mon, work = self.mon((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
        x, y = rect[2] - l, rect[3] - b
        if x + r > work[2]:
            x = rect[0] - r
        x, y, _ = self.clamp(x, y, work)
        return (x, y, "到那扇窗口旁边了。", False)

    def _notice_log(self, verdict, anchor="", target=None):
        """位置行为的小日志（排查用）：只记裁决与坐标，不记用户内容。"""
        try:
            path = os.path.join(self.data_dir, "notice-log.jsonl")
            row = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "verdict": verdict,
                   "anchor": anchor, "target": list(target) if target else None}
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001
            pass

    def notice(self, body):
        """跑过去看一眼再回来（位置行为）。

        stayPut（别乱走）/ 前台全屏 / 正被拿着 / 一分钟走太多次 —— 一律安静不动，且不算失败：
        这是「顺路过去看一眼」，不是用户下的指令。
        """
        if self.motion:
            self._notice_log("busy")
            return True, "还在路上。", None
        refusal = self.move_guard(time.monotonic())
        if refusal:
            self._notice_log("refused:" + refusal[:20])
            return True, refusal, None
        if self.inside:
            self.leave_inside(animate=False)
        anchor = str(body.get("anchor") or "active-window")
        if anchor not in ("active-window", "taskbar", "cursor", "edge"):
            anchor = "active-window"
        # stay=True：审批这类「要人处理」的场景，到了就待在那儿，别自己跑回去。
        stay = bool(body.get("stay"))
        if stay and getattr(self, "_notice_stay", False) and not self.motion:
            self._notice_log("already-there")
            return True, "已经在窗口旁边了。", None
        match = str(body.get("match") or body.get("target") or "").strip()
        target = None
        fallback = ""
        if match:
            rect, title, iconic = self.window_rect_for(match)
            if rect and iconic:
                # 那扇窗缩在任务栏里 → 就去任务栏（它「在」那儿），而不是跑去看不到的位置
                target, why = self.resolve_target({"cmd": "move_to", "anchor": "taskbar"})
                fallback = "「%s」缩在任务栏，就去那儿守着。" % match[:16]
                self._notice_log("matched-taskbar", title[:24],
                                 (int(target[0]), int(target[1])) if target else None)
            elif rect:
                target = self.target_near_rect(rect)
                self._notice_log("matched", title[:24], (int(target[0]), int(target[1])))
            else:
                fallback = "没找到「%s」，先到当前窗口旁边。" % match[:16]
        if target is None and anchor == "edge":
            # 屏幕右边缘：用户把文件开在侧栏时，它靠过去比较像在「看那边」
            l, t, r, b = self.body_box()
            mon, work = self.mon(self._x, self._y + max(4, b // 2))
            x, y, _ = self.clamp(work[2] - r - 2, self._y, work)
            target = (x, y, "靠到屏幕右边了。", False)
            self._notice_log("edge", "", (int(x), int(y)))
        if target is None:
            target, why = self.resolve_target({"cmd": "move_to", "anchor": anchor})
        if target is None:
            # 前台窗口取不到（焦点在桌面/任务栏、僵在前台的是别的进程）→ 退到面积最大的可见窗口
            rect, title = self.biggest_window_rect()
            if rect:
                target = self.target_near_rect(rect)
                self._notice_log("fallback-biggest", title[:24], (int(target[0]), int(target[1])))
        if target is None:
            self._notice_log("no-window", anchor)
            return True, why or "没找到可以靠过去的窗口。", None
        try:
            hold = float(body.get("holdMs") or self.NOTICE_HOLD_MS)
        except (TypeError, ValueError):
            hold = float(self.NOTICE_HOLD_MS)
        hold = max(0.6, min(8.0, hold / 1000.0))
        self._move_times.append(time.monotonic())
        x, y, done, look = target
        self._notice_log("walk", anchor, (int(x), int(y)))
        motion = self.start_motion(x, y, done, None, look)

        def go_home():
            try:
                if self._closed or self.drag or self.inside or self.motion:
                    return
                if self.cfg.get("stayPut") or self._fullscreen_probe():
                    return
                self.command({"cmd": "move_to", "anchor": "home", "wait": False})
            except Exception:  # noqa: BLE001 — 回程失败不该影响桌宠
                pass

        try:
            if stay:
                self._notice_stay = True      # 等到审批结束（宿主会发 move_to home）再回去
            else:
                self.root.after(int(hold * 1000), go_home)
        except Exception:  # noqa: BLE001
            pass
        return True, "过去看一眼。" + fallback, motion

    # ------------------------------------------------------------------ commands
    def _dispatch_threadsafe(self, body):
        """HTTP thread -> UI thread, wait for the verdict (and arrival when asked)."""
        box, ready = {}, threading.Event()

        def job():
            try:
                box["r"] = self.command(body)
            except Exception as exc:  # noqa: BLE001
                box["r"] = (False, "处理命令出错：%s" % type(exc).__name__, None)
            ready.set()
        self.post_ui(job)
        if not ready.wait(3.0):
            return {"ok": False, "message": "桌宠没响应。"}
        return self.finish_result(box["r"], body)

    @staticmethod
    def finish_result(r, body):
        ok, message, motion = r[:3]
        data = r[3] if len(r) > 3 else None
        if ok and motion is not None and body.get("wait", True):
            motion["event"].wait(min(30.0, max(1.0, float(body.get("timeoutS", 25)))))
            if motion.get("result"):
                ok, message = motion["result"]
            else:
                message = "还在路上。"
        out = {"ok": bool(ok), "message": message}
        if data is not None:
            out["data"] = data
        return out

    def command(self, body):
        """UI thread. -> (ok, message, motion|None[, data])."""
        cmd = str(body.get("cmd") or "")
        if cmd == "use":
            return self.use(body)
        if cmd == "furniture":
            return True, "ok", None, summary(self.furniture_defs, self.cfg["furniture"], self.char.name, self.cfg)
        if cmd in ("pose", "look", "stop") and self.inside:
            self.leave_inside(animate=False)
        if cmd in ("move_to", "walk"):
            now = time.monotonic()
            refusal = self.move_guard(now)
            if refusal:
                return False, refusal, None
            if self.inside:
                self.leave_inside(animate=False)
            target, refusal = self.resolve_target(body)
            if target is None:
                return False, refusal, None
            if str(body.get("anchor") or "") == "home":
                self._notice_stay = False   # 回程：审批那趟「待着」到此结束
            then = body.get("pose")
            names = self.char.pose_names()
            if then and then not in names:
                return False, "不认识的姿势。", None
            then_state = names.get(then) if then else None
            if then_state in ("waving", "jumping"):
                then_state = None
            self._move_times.append(now)
            x, y, done, look = target
            return True, "出发了。", self.start_motion(x, y, done, then_state, look)
        if cmd == "notice":
            return self.notice(body)
        if cmd == "pose":
            names = self.char.pose_names()
            name = str(body.get("name") or "")
            if name not in names:
                return False, "不认识的姿势。可用：%s。" % " / ".join(sorted(k for k in names if k.isascii())), None
            state = names[name]
            if self.motion:
                self.finish_motion(False, "换了姿势，停下了。")
            if state is None:
                self.pose = None
                return True, "坐好了。", None
            if state in ("waving", "jumping", "review"):
                self.transient = (state, time.time() + self.char.total_ms(state) / 1000)
                return True, "做了。", None
            hold = body.get("holdMs")
            hold = None if hold is None and state == "lie" else max(500, min(600000, int(hold or 6000)))
            self.pose = (state, None if hold is None else time.time() + hold / 1000)
            return True, "好了。", None
        if cmd == "look":
            target = body.get("target", "cursor")
            hold = max(500, min(10000, int(body.get("holdMs") or 3000)))
            l, t, r, b = self.body_box()
            cx, cy = self._x + (l + r) / 2, self._y + t + (b - t) * .35
            if target == "cursor":
                px, py = self.root.winfo_pointerxy()
                deg = math.degrees(math.atan2(px - cx, -(py - cy)))
            elif isinstance(target, str) and target in DIRECTIONS:
                deg = DIRECTIONS[target]
            elif isinstance(target, dict) and all(isinstance(target.get(k), (int, float)) for k in ("x", "y")):
                deg = math.degrees(math.atan2(target["x"] - cx, -(target["y"] - cy)))
            else:
                return False, "look 的 target 用 cursor、方向或 {x, y}。", None
            if not self.char.look_frames:
                return False, "这个角色没有注视帧。", None
            self.pose = None
            self.look_hold = (degrees_to_gaze(deg), time.time() + hold / 1000)
            return True, "在看了。", None
        if cmd == "stop":
            if self.motion:
                self.finish_motion(False, "被叫停了。")
            self.pose = self.look_hold = self.walk_dir = None
            return True, "停下了。", None
        if cmd == "mood":
            state = self.char.moods.get(str(body.get("tag") or ""))
            if not state:
                return False, "不认识的心情。可用：%s。" % " / ".join(self.char.moods), None
            self.mood = (state, time.time() + max(1.0, min(30.0, float(body.get("seconds") or 6))))
            return True, "好。", None
        if cmd == "say":
            text = str(body.get("text") or "")
            if body.get("speak") and text.strip():
                threading.Thread(target=self.voice.speak, args=(text,), daemon=True).start()
                return True, "说了，也念出来了。", None
            self.bubble.show(text, float(body.get("seconds") or 8))
            return True, "说了。", None
        if cmd == "activity":
            state = str(body.get("state") or "")
            if body.get("once") or body.get("ms"):
                ok = self.play_action(state, body.get("ms"), body.get("plan"))
            else:
                ok = self.set_activity(state)
            return (True, "好。", None) if ok else (False, "这个角色没有这个状态。", None)
        if cmd == "screen":                     # pixelpet_screen (screen.py), gated by settings.screen
            from . import screen as SC
            return SC.command(self, body)
        if cmd == "voiceprint":
            # UI-only endpoint; no generic voiceprint action is exposed by the AI tool registry.
            return self.voiceprint.command(body)
        if cmd == "voice":
            return self.voice_cmd(body)
        if cmd == "hub":
            return self.hub_cmd(body)
        if cmd == "music":
            state = body.get("state")
            if state not in ("playing", "paused", "off"):
                return False, "音乐状态应为 playing / paused / off。", None
            if state != self._music_state:
                self._music_state = state
                if state == "paused":
                    self._music_paused_at = time.monotonic()
            return True, "ok", None
        if cmd == "packs":
            return self.packs_command(body)
        if cmd == "card":                       # 听歌小卡 (card_dock.py): settings page 「打开小卡片」
            if self.card is None:
                return False, "小卡片在这里不可用。", None
            if body.get("op") == "close":
                self.card.stop()
                return True, "ok", None
            ok, msg = self.card.open()
            return ok, msg, None
        if cmd == "reading":                    # 阅读窗 (reading_dock.py): op open | close
            if self.reading is None:
                return False, "阅读窗在这里不可用。", None
            return self.reading.command(body)
        if cmd == "awareness":                  # settings page: 「当前识别成」 (category + process name only)
            au = self.autonomy
            on = bool(au is not None and ((self.cfg.get("autonomy") or {}).get("aware") is True))
            snap = au.snapshot() if (au is not None and on) else {}
            return True, "ok", None, {"aware": on, **snap}
        if cmd == "status":
            return True, "ok", None, {"character": self.char.id, "state": self.cur_state, "moving": bool(self.motion),
                                      "inside": self.inside[0] if self.inside else None, "voice": self.voice_state,
                                      "stayPut": bool(self.cfg.get("stayPut")), "mailUnread": self.mail.unread,
                                      "voiceprint": self.voiceprint.summary()}
        return False, "不认识的命令。可用 move_to / walk / pose / look / stop / mood / say / use / furniture / voice / hub / packs / status。", None

    def hub_cmd(self, body):
        h = self.hub
        action = body.get("action") or "status"
        if h is None:
            return False, "输入条没起来：%s" % (self.hub_errors.get("hub") or "未知原因"), None
        if action == "expand":
            h.expand(focus=False)
        elif action == "collapse":
            h.collapse()
        elif action == "toggle":
            h.toggle()
        elif action == "listen":
            on=body.get("on")
            if not isinstance(on,bool):return False,"listen 需要 on: true / false。",None
            if self.set_listening(on)!=on:return False,"麦克风没打开。",None
        elif action != "status":
            return False, "hub 的 action：status / expand / collapse / toggle / listen。", None
        return True, "ok", None, {"visible": h.visible, "collapsed": h.m.collapsed, "hasDraft": h.m.has_draft,
                                  "shots": len(h.m.shots), "listening": self.listener is not None}

    def _close_voiceprint(self):
        gate = getattr(self, 'voiceprint', None)
        if gate is None:
            return
        window = getattr(gate, '_window', None)
        if window is not None:
            window.close()
        gate.close()

    # ------------------------------------------------------------------ voice
    def _engine_signature(self):
        v=self.cfg.get("voice") or {}
        return json.dumps({k:v.get(k) for k in ("stt","tts","llm")},sort_keys=True)

    def _make_voice(self):
        from .voice.bridge import VoiceBridge
        from .voice.deps import Dependencies
        from .voice.llm import make_llm
        from .voice.stt import make_stt
        from .voice.tts import make_tts
        v = self.cfg.get("voice") or {}
        deps = Dependencies(self.data_dir)
        try:
            stt = make_stt(v.get("stt"))
        except ValueError:
            from .voice.stt import NoStt
            stt = NoStt()
        try:
            tts = make_tts(v.get("tts"), self.data_dir, deps, pack_root=self.pack_root)
        except Exception:  # noqa: BLE001 - a bad custom channel must not stop the pet
            from .voice.tts import StubTts
            tts = StubTts(self.data_dir, self.pack_root)
            tts.name = "invalid"
        def ui(fn,state=None):
            turn=voice._turn
            self.post_ui(lambda:fn() if self.voice is voice and voice._turn==turn and not self._closed
                         and (state is None or voice.state==state) else None)
        voice=VoiceBridge(stt, tts, make_llm(v.get("llm")),
                         voice=(v.get("tts") or {}).get("voice") or "whale-girl",
                         character=lambda: getattr(self.char, "id", ""),
                         tone=v.get("tone"),
                         interruption=v.get("interruption"),data_dir=self.data_dir, sv=self.voiceprint,
                         on_state=lambda s:ui(lambda:self._on_voice(s),state=s),
                         on_heard=lambda text:ui(lambda:self._on_heard(text)),
                         on_reply=lambda text:ui(lambda:self._on_reply(text)),
                         on_caption=lambda text,secs:ui(lambda:self.bubble.show_caption(text,secs)),
                         on_speak=lambda i,s,secs:ui(lambda:self.bubble.hold(secs+3)),
                         on_barge_rearm=lambda:self._rearm_barge() if self.voice is voice and not self._closed else None)
        return voice

    def _engine_tts(self):
        """The TTS object behind the bridge (None when the bridge does not expose one)."""
        return getattr(self.voice, "tts", None)

    def _startup_prewarm(self):
        """Wait for background dependency installation without blocking Tk or repeatedly failing loads."""
        self._prewarm_job = None
        if self._closed:
            return
        tts = self._engine_tts()
        if getattr(tts, "name", "") != "qwen":
            return
        if not tts.available():
            self._prewarm_job = self.root.after(5000, self._startup_prewarm)
            return
        self._prewarm()

    def _prewarm(self):
        """Load the speech engine in the background. Cheap and coalesced: safe to call on every turn."""
        if self._closed:
            return False
        tts = self._engine_tts()
        if tts is None or not hasattr(tts, "warm_async"):
            return False
        try:
            return bool(tts.warm_async())
        except Exception as exc:  # noqa: BLE001 - warming is an optimisation, never a failure path
            self.bubble.show("预热失败：%s" % str(exc)[:80], 4)
            return False

    def _set_tts_idle(self):
        """Idle lifetime follows the mode: short when idle, long while continuous listening runs."""
        from .voice.tts import IDLE_LISTENING_SECONDS, IDLE_SECONDS
        tts = self._engine_tts()
        if tts is not None and hasattr(tts, "set_idle"):
            tts.set_idle(IDLE_LISTENING_SECONDS if self.listener is not None else IDLE_SECONDS)

    def _rearm_barge(self):
        lst = self.listener
        if lst is not None and hasattr(lst, "rearm_barge"):
            lst.rearm_barge()

    def _on_reply(self, text):
        self._replied = True

    def _on_heard(self,text):
        self._replied=False
        self.bubble.show(text,30,kind="user")

    def _on_voice(self, state):
        prev, self.voice_state = self.voice_state, state
        deferred=getattr(self,'_deferred_done',None)
        if deferred:
            voice,turn=deferred
            if self.voice is not voice or getattr(voice,'_turn',None)!=turn:self._deferred_done=None
            elif state=='idle':
                self._deferred_done=None
                self.set_activity('done')
        if state == "idle" and prev in ("thinking", "speaking"):
            self._hf_resume_at = time.monotonic() + 0.7      # let the room go quiet before listening again
        if prev == "idle" and state != "idle":
            self._replied = False
        if state != "idle" or prev == "idle":
            return
        err = getattr(self.voice, "last_error", None)
        if err and prev in ("thinking", "listening"):
            self.bubble.show(err, 6)
        elif self.bubble.until:
            self.bubble.hold(max(4.0, min(20.0, len(self.bubble.label.cget("text")) / 6.0)), exact=True)

    # one sentence from the menu entry (stops by itself after the speaker goes quiet)
    def _ensure_mic(self):
        if self.mic is None:
            from .voice.mic import Recorder
            self.mic = Recorder(self.data_dir)
        return self.mic

    def start_talk(self, auto_stop=False):
        if self.mic is not None and self.mic.active:
            return True
        try:
            self._ensure_mic().start(auto_stop=auto_stop)
        except Exception as exc:  # noqa: BLE001
            self.bubble.show(str(exc), 5)
            return False
        self._prewarm()
        self.voice.listen()
        return True

    def end_talk(self):
        if self.mic is None or not self.mic.active:
            return
        pcm = self.mic.stop()
        if len(pcm) < 16000 * 2 * 0.3:              # under 0.3 s: a tap, not speech
            self.voice.interrupt()
            return
        self._prewarm()
        threading.Thread(target=self.voice.hear, args=(pcm, 16000), daemon=True).start()

    # ------------------------------------------------------------------ hub bar
    def hub_cfg(self):
        return hub_cfg(self.cfg.get("hub"))

    @staticmethod
    def _hub_delivery(out):
        if out.get('accepted') or out.get('interrupted') or out.get('delivery')=='accepted':return 'accepted'
        delivery=out.get('delivery')
        if delivery in ('not-sent','unknown'):return delivery
        if out.get('rejected'):return 'not-sent'
        if not out.get('error') and not out.get('cancelled'):return 'accepted'
        return 'unknown'

    def _finish_hub_delivery(self, hub, ticket, out, text, shots):
        if hub is None or self.hub is not hub or getattr(self,'_closed',False):return
        delivery=PetApp._hub_delivery(out)
        ok=delivery=='accepted'
        finish=getattr(hub,'finish_send',None)
        if callable(finish):
            handled=finish(ticket,ok,delivery,text,shots)
        else:
            # Existing injected views retain their three-argument API.
            hub.sent(ok,text,shots);handled=True
        if not handled or not out.get('error'):return
        error=str(out['error'])[:220]
        if delivery=='accepted':message='消息已送达，但回复或播音失败：'+error
        elif delivery=='unknown':message='送达状态不确定，请先查看会话，避免重复发送。'+error
        else:
            message='消息未送达：'+error
            if getattr(getattr(hub,'m',None),'recoveries',None):message+='（右键输入框可恢复未发送草稿）'
        bubble=getattr(self,'bubble',None)
        if bubble is not None:bubble.show(message,8)

    def hub_send_ticket(self, text, shots, ticket):
        return self.hub_send(text,shots,send_id=ticket)

    def hub_send(self, text, shots, send_id=None):
        """A receipt releases this exact send; later generation/TTS errors are not failed drafts."""
        hub,voice=self.hub,self.voice
        pngs=[s['png'] for s in shots]
        speak=self.hub_cfg()['speak']
        self._prewarm()
        def accepted(receipt):
            def apply():
                if self.hub is hub and hub is not None and not getattr(self,'_closed',False):
                    fn=getattr(hub,'accepted',None)
                    if callable(fn) and send_id is not None:fn(send_id)
            self.post_ui(apply)
        def work():
            try:
                out=voice.ask_text(text,images=pngs or None,speak=speak,on_accepted=accepted)
            except Exception as exc:
                out={'error':str(exc),'delivery':getattr(exc,'delivery','unknown')}
            self.post_ui(lambda:PetApp._finish_hub_delivery(self,hub,send_id,out,text,shots))
        threading.Thread(target=work,daemon=True).start()

    def _hub_voice(self, pcm, followup=False):
        """Voice delivery has no text-send ticket and cannot clear a newer typed message."""
        hub,voice=self.hub,self.voice
        shots=hub.take_shots() if hub is not None else []
        pngs=[s['png'] for s in shots]
        speak=self.hub_cfg()['speak']
        self._prewarm()
        def work():
            try:
                hear=voice.hear_followup if followup else voice.hear
                out=hear(pcm,16000,images=pngs or None,speak=speak)
            except Exception as exc:
                out={'error':str(exc),'delivery':getattr(exc,'delivery','unknown')}
            if PetApp._hub_delivery(out)=='accepted' and not out.get('error'):return
            if out.get('error') or out.get('cancelled') or out.get('rejected'):
                heard=str(out.get('heard') or '')
                if heard or shots or out.get('error'):
                    self.post_ui(lambda:PetApp._finish_hub_delivery(self,hub,None,out,heard,shots))
        threading.Thread(target=work,daemon=True).start()

    def hub_listen(self):
        """Mic button / hotkey: flip continuous listening."""
        self.set_listening(self.listener is None)

    def hub_capture(self):
        if self.offscreen:
            self.hub.add_shot(None)
            return
        from . import capture

        def done(image):
            shot = None
            if image is not None:
                try:
                    shot = {"png": capture.encode(image), "thumb": capture.thumbnail(image)}
                except Exception:  # noqa: BLE001
                    shot = None
            W.native_flags(self.root)
            self.apply_topmost()
            for w in self.furniture.values():
                w.below(self.hwnd)
            if self.hub is not None:
                self.hub.add_shot(shot)
        hide = [self.root]+self.bubble.windows
        if self.hub is not None:
            hide += [self.hub.win, self.hub.chip, self.hub.tip.win]
        hide += [w.win for w in self.furniture.values()]
        capture.ShotPicker(self.root, hide, done)

    def set_listening(self, on):
        """Continuous listening on / off (runtime only, starts off). -> whether it is on now."""
        if on and self.listener is None and (self._fake_sd is not None or not self.offscreen):
            from .voice.vad import Listener
            lst = Listener(on_segment=lambda pcm: self.post_ui(lambda: self._hands_free_segment(pcm)),
                           on_event=lambda ev: self.post_ui(lambda: self._hands_free_event(ev)),
                           on_barge=lambda pcm: self.post_ui(lambda: self.listener and self.voice.request_interrupt(pcm)),
                           data_dir=self.data_dir, sd=self._fake_sd)
            try:
                lst.start()
            except Exception as exc:  # noqa: BLE001
                self.bubble.show(str(exc), 5)
            else:
                self.listener = lst
        elif not on and self.listener is not None:
            lst, self.listener = self.listener, None
            lst.stop()
            if self._hf_listening:
                self._hf_listening = False
                if self.voice_state == "listening" and not getattr(self.voice,"interruption_phase",""):
                    self.voice.interrupt()
        if hasattr(self.voice,"set_barge_listening"):
            self.voice.set_barge_listening(self.listener is not None)
        if self.hub is not None:
            self.hub.set_listening(self.listener is not None)
        if self.listener is not None:
            self._prewarm()                 # a hands-free turn is coming: load while the room is quiet
        self._set_tts_idle()                # 120 s idle vs 1800 s while listening (M4)
        return self.listener is not None

    def _hands_free_event(self, ev):
        if getattr(self.voice,"interruption_phase","")=="waiting":
            if ev=="start":self.voice.note_followup_started()
            elif ev=="drop":self.voice.drop_followup()
            return
        if ev == "start" and self.voice_state == "idle":
            self._hf_listening = True
            self._prewarm()                 # someone is talking: overlap the load with their sentence
            self.voice.listen()
        elif ev == "drop" and self._hf_listening:
            self._hf_listening = False
            if self.voice_state == "listening":
                self.voice.interrupt()

    def _hands_free_segment(self, pcm):
        self._hf_listening = False
        if getattr(self.voice,"interruption_phase","")=="waiting":
            self._hub_voice(pcm,followup=True)
            return
        if self.voice_state not in ("idle", "listening"):
            return
        self._hub_voice(pcm)

    def _tick_hub(self, now):
        if hasattr(self.voice,"tick_interrupt"):self.voice.tick_interrupt()
        if self.hub is not None:
            self.hub.tick(now)
        if self.listener is not None:
            phase=getattr(self.voice,"interruption_phase","")
            blocked=((self.mic is not None and self.mic.active)
                    or (self.hub is not None and self.hub.m.capturing) or bool(self.inside)
                    or now < self._hf_resume_at
                    or now < getattr(self, "reading_hold_until", 0.0))     # 阅读窗在录音 (reading_dock.mic)
            barge=not blocked and bool(getattr(self.voice,"can_barge_monitor",False))
            self.listener.set_playback_mode(barge,self.voice.filter_microphone if barge else None)
            busy=blocked or phase in ("ack","checking","verifying") or (
                self.voice_state in ("thinking","speaking") and not barge and phase!="waiting")
            self.listener.pause(busy and not self._hf_listening)

    def toggle_talk(self):
        if self.mic is not None and self.mic.active:
            self.end_talk()
        else:
            self.start_talk(auto_stop=True)

    def _tick_talk(self):
        if self.mic is not None and self.mic.active and self.mic.should_stop():
            self.end_talk()
        key = ((self.cfg.get("voice") or {}).get("hotkey") or "")
        if not key or self.offscreen:
            return
        from .voice.mic import key_down
        down = key_down(key)
        if down and not self._talk_key:           # press = flip, same as the mic button
            self.hub_listen()
        self._talk_key = down

    def voice_cmd(self, body):
        action = body.get("action")
        if action == "status":
            status = dict(self.voice.status())
            status["lastFailureError"] = getattr(self, "last_failure_error", None)
            return True, "ok", None, status
        if action == "listen":
            if body.get("mic"):
                return (True, "在听。", None) if self.start_talk(auto_stop=True) else (False, "麦克风没打开。", None)
            self._prewarm()
            self.voice.listen()
            return True, "在听。", None
        if action == "interrupt":
            if self.mic is not None:
                self.mic.cancel()
            self.voice.interrupt()
            return True, "停了。", None
        if action == "speak":
            text = str(body.get("text") or "").strip()
            if not text:
                return False, "speak 需要 text。", None
            threading.Thread(target=self.voice.speak, args=(text,), daemon=True).start()
            return True, "念了。", None
        if action == "ask":
            text = str(body.get("text") or "").strip()
            if not text:
                return False, "ask 需要 text。", None
            self._prewarm()
            threading.Thread(target=self.voice.ask_text, args=(text,), daemon=True).start()
            return True, "问了。", None
        return False, "voice 的 action：listen / ask / speak / interrupt / status。", None

    # ------------------------------------------------------------------ furniture
    def _primary_work(self):
        return self.mon(0, 0)[1]

    def _switch_character(self, folder):
        character = load_character(folder)
        if self.inside:
            self.leave_inside(animate=False)
        self.char = character
        self.cache.clear()
        self.clock = FrameClock()
        self.cur_state, self.frame_idx = "idle", 0
        self.gaze = self.look_hold = self.pose = self.mood = self.transient = None
        self.manual, self._manual_until = "idle", None
        self._draw_key = None

    def _reload_pack_characters(self, reg):
        dirs = PK.packed_characters(self.data_dir, reg)
        layers = {}
        for cid in dirs:
            pk = PK.resolve_one(self.pack_root, self.data_dir, "character", cid, dirs)
            if pk and pk["valid"]:
                layers[cid] = pk["base"]
        self._pack_character_layers = layers
        old_dirs = getattr(self, "_pack_character_dirs", {})
        self._pack_character_dirs = dirs
        cid = getattr(self, "char", None) and self.char.id
        if cid not in old_dirs:
            return
        pk = PK.resolve_one(self.pack_root, self.data_dir, "character", cid, dirs)
        fallback = cid not in dirs and (not pk or not pk["valid"])
        if not fallback and (not pk or not pk["valid"]):
            return  # Keep the last decoded character until the failed update is rolled back.
        pick = character_folder(self.pack_root, self.data_dir, "whale-girl") if fallback else pk["dir"]
        if os.path.normcase(pick) == os.path.normcase(self.char.folder):
            return
        self._switch_character(pick)
        if fallback:
            cfg = load_settings(self.data_dir)
            if cfg.get("character") == cid:
                cfg["character"] = "whale-girl"
                save_settings(self.data_dir, cfg)
                self.cfg["character"] = "whale-girl"
            self.bubble.show("换回鲸鱼娘了", 5)

    def _reload_packs(self):
        """重读拓展包注册表并重建家具定义（M1 热加载的核心）。

        失败时保留现有定义不动（旧家具照常），错误记进 furniture_errors['*']；
        成功后记录 registry 的 mtime 与 generation，作为 mtime 门控的基准。"""
        reg, err = PK.read_registry_lenient(self.data_dir)
        self._packs_reg_error = err
        self._packs_gen = (reg or {}).get("generation", 0)
        roots = PK.pack_furniture_roots(self.data_dir, reg)
        try:
            defs, errors = load_furniture(self.pack_root, user_root=self.data_dir, extra_roots=roots)
            self._reload_pack_characters(reg)
        except Exception as exc:  # noqa: BLE001
            self.furniture_errors = {"*": type(exc).__name__}
            return False
        self.furniture_defs, self.furniture_errors = defs, errors
        try:
            path = PK.registry_path(self.data_dir)
            self._packs_mtime = os.stat(path).st_mtime_ns if os.path.isfile(path) else None
        except OSError:
            self._packs_mtime = None
        return True

    def _packs_check(self):
        """registry.json 的 mtime 门控（仿 settings 的 _cfg_mtime）：安装器改了注册表而宿主没来得及
        发 reload 回执时（比如宿主崩溃重启），这里兜底自愈。"""
        path = PK.registry_path(self.data_dir)
        try:
            m = os.stat(path).st_mtime_ns if os.path.isfile(path) else None
        except OSError:
            m = None
        if m != self._packs_mtime:
            if self._reload_packs():
                self._fcfg_sig = None
                self.sync_furniture()

    def packs_command(self, body):
        """控制命令 packs：action = status（查激活代次）/ reload（重载并给回执）。"""
        action = str(body.get("action") or "")
        if action == "status":
            packs = sorted(fid for fid, d in self.furniture_defs.items() if d.get("_pack"))
            return True, "ok", None, {"ok": True, "generation": self._packs_gen,
                                      "registryError": self._packs_reg_error,
                                      "packFurniture": packs, "packCharacters": sorted(
                                          cid for cid, layer in self._pack_character_layers.items() if layer == "pack"),
                                      "errors": dict(self.furniture_errors)}
        if action == "reload":
            want = body.get("generation")
            ok = self._reload_packs()
            self._fcfg_sig = None
            self.sync_furniture()
            gen = self._packs_gen
            if want is not None and not isinstance(want, int):
                try:
                    want = int(want)
                except (TypeError, ValueError):
                    want = None
            if want is not None and gen < want:  # 宠物代次 >= 要求即算追上（中间可能有别的写入）
                return False, "激活代次不一致（要求 %s，当前 %s）" % (want, gen), None, \
                    {"ok": False, "generation": gen, "reason": "generation-mismatch"}
            loaded = {
                "furniture": sorted(fid for fid, d in self.furniture_defs.items() if d.get("_pack")),
                "characters": sorted(cid for cid, layer in getattr(self, "_pack_character_layers", {}).items()
                                     if layer == "pack"),
            }
            errors = dict(self.furniture_errors)
            if not ok:
                return False, "拓展包重载失败，保留原家具。", None, \
                    {"ok": False, "generation": gen, "loaded": {"furniture": [], "characters": []}, "errors": errors}
            # all：各层最终胜出的家具 id → 层（user / pack / builtin），宿主据此识别"被用户层同名覆盖"
            layers = {fid: ("pack" if d.get("_pack") else "user" if d.get("_user") else "builtin")
                      for fid, d in self.furniture_defs.items()}
            return True, "ok", None, {"ok": True, "generation": gen, "loaded": loaded, "errors": errors,
                                      "all": {"furniture": layers, "characters": self._pack_character_layers}}
        return False, "packs 的 action：status / reload。", None

    def sync_furniture(self):
        fcfg = self.cfg["furniture"]
        sig = sync_sig(fcfg, self.cfg)          # + feature gates (书架 follows settings.reading.enabled)
        if sig == self._fcfg_sig:
            return
        self._fcfg_sig = sig
        # M1：定义表里已消失的家具先撤窗（卸载/禁用包后不留陈旧窗口）——旧实现只遍历 defs，漏了这一步
        for fid in [fid for fid in self.furniture if fid not in self.furniture_defs]:
            w = self.furniture.pop(fid)
            if self.inside and self.inside[0] == fid:
                self.leave_inside(animate=False)
            try:
                w.destroy()
            except Exception:  # noqa: BLE001
                pass
        work, taken = self._primary_work(), {}
        for fid, d in self.furniture_defs.items():
            w = self.furniture.get(fid)
            if not is_enabled(d, fcfg, self.cfg):
                if w is not None:
                    if self.inside and self.inside[0] == fid:
                        self.leave_inside(animate=False)
                    w.destroy()
                    del self.furniture[fid]
                continue
            fresh = w is None
            if fresh:
                w = FurnitureWindow(self, d)
                self.furniture[fid] = w
            fw, fh = w.size()
            left, bottom = default_spot(d.get("anchor", "bottom-right"), fw, fh, work, taken)
            item = fcfg.get(fid, {})
            if "x" in item and not self.offscreen:
                left, bottom = item["x"], item["y"]
            left, bottom = clamp_spot(left, bottom, fw, fh, self.mon(left + fw // 2, bottom - fh // 2)[1])
            if fresh or (left, bottom) != (w.left, w.bottom):
                w.place(left, bottom)
            if fresh:
                w.tick(time.monotonic(), self._reduced)
            w.below(self.hwnd)

    def _tick_furniture(self, now):
        for w in self.furniture.values():
            if w.visible:
                w.tick(now, self._reduced)
        self._restack_furniture()

    def _restack_furniture(self):
        # Independent Tk windows can rise when mapped, dragged or repaired. Furniture is scenery;
        # keep it behind the pet within the same band, without repeatedly raising the whole group.
        for f in getattr(self, "furniture", {}).values():
            W.ensure_below(f.win, self.root)

    def on_furniture_moved(self, fid, left, bottom):
        self.cfg = load_settings(self.data_dir)
        self.cfg["furniture"].setdefault(fid, {}).update({"x": int(left), "y": int(bottom)})
        self._fcfg_sig = sync_sig(self.cfg["furniture"], self.cfg)
        save_settings(self.data_dir, self.cfg)

    def on_furniture_click(self, fid):
        if self.inside and self.inside[0] == fid:
            self.leave_inside(animate=True)
            return
        d = self.furniture_defs.get(fid) or {}
        if d.get("feature") == "mailbox":
            self.open_mailbox(fid)
        elif d.get("feature") == "reading":
            self.open_reading(fid)
        elif d.get("feature") == "calendar":
            self.open_calendar(fid)

    def open_reading(self, fid):
        """书架 click: book slides out, then the reading pack's host opens the window (in-process, see bookshelf.py)."""
        w = self.furniture.get(fid)
        if w is not None:
            w.set_temp(BS.options(w.defn)["openState"], 2.5)
        if self.offscreen:
            return
        ok, msg = BS.open_reading(getattr(self, "reading", None))
        if not ok and msg:
            self.bubble.show(msg, 4)

    def open_calendar(self, fid):
        """台历 click: 动一下，然后请宿主开日历窗（日历窗住在宿主侧，见 calendardock.py）。"""
        w = self.furniture.get(fid)
        if w is not None and CD.options(w.defn)["openState"] in w.defn.get("states", {}):
            w.set_temp(CD.options(w.defn)["openState"], 2.0)
        if self.offscreen:
            return
        ok, msg = CD.open_calendar()
        if not ok and msg:
            self.bubble.show(msg, 4)

    # ------------------------------------------------------------------ mailbox
    def _mailboxes(self):
        return [(fid, w) for fid, w in self.furniture.items() if self.furniture_defs[fid].get("feature") == "mailbox"]

    def tick_mail(self):
        """state.json -> flag up / down; a fresh letter sends the pet over to wave (once per letter)."""
        r = self.mail.poll()
        unread = self.mail.unread
        boxes = self._mailboxes()
        if unread is not None:
            for fid, w in boxes:
                o = MB.options(w.defn)
                target = o["flagState"] if unread > 0 and o["flagState"] in w.defn["states"] else w.defn["idle"]
                if self.inside and self.inside[0] == fid:
                    self.inside = (fid, self.inside[1], target)
                elif w.base_state != target:
                    w.base_state = target
                    w.clock.state = None
        if r and r[2] and self.autonomy is not None and any(MB.options(w.defn)["autoWave"] for _, w in boxes):
            self.autonomy.note_mail()          # 「来信去信箱」: autonomy.py decides when (or whether) to go
        return r

    def _auto_check(self, fid):
        if self._closed or self.inside or self.motion or self.drag or fid not in self.furniture or self.cfg.get("stayPut"):
            return
        verb = MB.options(self.furniture_defs[fid])["verb"]
        self.command({"cmd": "use", "id": fid, "verb": verb})

    def open_mailbox(self, fid):
        w = self.furniture.get(fid)
        if w is not None:
            o = MB.options(w.defn)
            w.set_temp(o["openState"], 2.5)
        if not self.offscreen:
            MB.open_window(MB.mailbox_url())

    def use(self, body):
        fid, verb = str(body.get("id") or ""), str(body.get("verb") or "")
        d = self.furniture_defs.get(fid)
        if d is None or fid not in self.furniture:
            return False, "没摆这件家具。", None
        inter = next((i for i in d.get("interactions", []) if i["verb"] == verb), None)
        if inter is None:
            return False, "%s没有这个互动，可用：%s。" % (d["name"], " / ".join(i["verb"] for i in d.get("interactions", [])) or "无"), None
        mode = inter.get("mode", "beside")
        if mode == "exit":
            if not (self.inside and self.inside[0] == fid):
                return False, "没在%s里。" % d["name"], None
            self.leave_inside(animate=True)
            return True, fill_name(inter.get("done"), self.char.name) or "出来了。", None
        if self.inside and self.inside[0] == fid and mode == "inside":
            return True, "已经在%s里了。" % d["name"], None
        now = time.monotonic()
        refusal = self.move_guard(now)
        if refusal:
            return False, refusal, None
        if self.inside:
            self.leave_inside(animate=False)
        w = self.furniture[fid]
        box = self.body_box()
        fw, fh = w.size()
        work = self.mon(w.left + fw // 2, w.bottom - fh // 2)[1]
        side = pick_side(self._x + (box[0] + box[2]) / 2, w.left, fw)
        x, y, clamped = self.clamp(*stand_spot(d, w.left, w.bottom, w.factor(), box, side), work)
        if clamped:
            other = "right" if side == "left" else "left"
            xo, yo, c2 = self.clamp(*stand_spot(d, w.left, w.bottom, w.factor(), box, other), work)
            if not c2:
                side, x, y = other, xo, yo
        self._move_times.append(now)
        motion = self.start_motion(x, y, fill_name(inter.get("done"), self.char.name) or "到了。")
        motion["on_arrive"] = lambda: self._interact(fid, inter, side)
        return True, "出发了。", motion

    def _interact(self, fid, inter, side):
        if fid not in self.furniture:
            return
        if inter.get("mode", "beside") == "inside":
            pose = inter.get("enterPose")
            delay = 0
            if pose in self.char.states:
                delay = min(600, int(self.char.total_ms(pose)))
                self.transient = (pose, time.time() + delay / 1000)
            self.root.after(delay, lambda: (not self.motion and not self.drag and not self.inside
                                            and self.enter_inside(fid, inter.get("state"), side, inter)))
            return
        state = self.char.resolve(inter.get("pose")) if inter.get("pose") else None
        if state:
            hold = inter.get("holdMs")
            self.pose = (state, None if not hold else time.time() + hold / 1000)
            self._use_pose = True
        if inter.get("furnitureState"):
            self.furniture[fid].set_temp(inter["furnitureState"], (inter.get("holdMs") or 3000) / 1000)

    def enter_inside(self, fid, state, side, inter=None):
        w = self.furniture[fid]
        self.inside = (fid, side, w.base_state)
        self.pose = self.transient = None
        occ = make_occupant(self.char, w.defn, inter)   # empty furniture + this character's own sleep frames
        w.set_occupant(occ)
        w.base_state = occ["under"] if occ else (state if state in w.defn["states"] else w.defn["idle"])
        w.clock.state = None
        self.root.withdraw()
        if self.hub is not None:
            self.hub.set_visible(False)
        return True

    def leave_inside(self, animate=True):
        if not self.inside:
            return
        fid, side, prev = self.inside
        self.inside = None
        w = self.furniture.get(fid)
        d = self.furniture_defs.get(fid) or {}
        if w is not None:
            w.set_occupant(None)
            w.base_state = prev or d.get("idle")
            w.clock.state = None
            fw, fh = w.size()
            x, y, _ = self.clamp(*stand_spot(d, w.left, w.bottom, w.factor(), self.body_box(), side),
                                 self.mon(w.left + fw // 2, w.bottom - fh // 2)[1])
            self.place(x, y, clamp=False)
        self.root.deiconify()
        self.apply_topmost()
        W.native_flags(self.root)
        if w is not None:
            w.below(self.hwnd)
        if animate and "jumping" in self.char.states:
            self.transient = ("jumping", time.time() + self.char.total_ms("jumping") / 1000)
        if self.hub is not None:
            self.hub.set_visible(True)

    # ------------------------------------------------------------------ 主动一点 (autonomy.py)
    def _auto_memory(self):
        try:
            with open(os.path.join(self.data_dir, "autonomy.json"), encoding="utf-8") as f:
                m = json.load(f)
            return {"hello": m["hello"]} if isinstance(m, dict) and isinstance(m.get("hello"), str) else {}
        except (OSError, ValueError, KeyError):
            return {}

    def _auto_memory_save(self, memory):
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            path = os.path.join(self.data_dir, "autonomy.json")
            tmp = path + ".%d.tmp" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"hello": memory.get("hello")}, f)
            os.replace(tmp, path)
        except OSError:
            pass

    def _autonomy_view(self):
        t = time.time()

        def live(lease):
            return bool(lease) and (lease[1] is None or lease[1] > t)
        voice = self.voice_state
        if voice in ("idle", "listening") and self.listener is not None:
            try:
                if self.listener.vad.active:
                    voice = "hearing"
            except Exception:  # noqa: BLE001
                pass
        sleep_spot = None
        for fid in self.furniture:
            inters = [i for i in self.furniture_defs[fid].get("interactions", []) if i.get("mode") == "inside"]
            if inters:
                pick = next((i for i in inters if i["verb"] == "sleep"), inters[0])
                sleep_spot = (fid, pick["verb"])
                if pick["verb"] == "sleep":
                    break
        boxes = self._mailboxes()
        manual_busy = self.manual != "idle" and (self._manual_until is None or self._manual_until > t)
        return {"voice": voice, "dragging": bool(self.drag), "inside": self.inside[0] if self.inside else None,
                "pose": self.pose[0] if live(self.pose) else None, "moving": bool(self.motion),
                "held": bool((self.transient and self.transient[1] > t) or manual_busy or live(self.mood)
                             or live(self.look_hold)),
                "stay_put": bool(self.cfg.get("stayPut")), "sleep_spot": sleep_spot,
                "mailbox": (boxes[0][0], MB.options(boxes[0][1].defn)["verb"]) if boxes else None,
                "can_look": bool(self.char.look_frames), "states": set(self.char.states)}

    def _monitor_snapshot(self):
        """「活动与额度」页签的状态分类只看这些可见位；不包含任何对话内容。"""
        try:
            withdrawn = self.root.state() == "withdrawn"
        except Exception:  # noqa: BLE001
            withdrawn = False
        return {"withdrawn": withdrawn, "inside": bool(self.inside), "voice": self.voice_state,
                "motion": bool(self.motion), "manual": self.manual, "manual_until": self._manual_until}

    def tick_autonomy(self):
        acts = self.autonomy.tick(self.cfg, self._autonomy_view())
        for act in acts:
            self._auto_do(act)
        return acts

    def _auto_do(self, act):
        kind, t = act[0], time.time()
        if kind == "mood":
            st = self.char.moods.get(act[1]) or self.char.resolve(MOOD_FALLBACK.get(act[1]))
            if st:
                self.mood = (st, t + act[2])
        elif kind == "transient":
            st = self.char.resolve(act[1])
            if st:
                self.transient = (st, t + self.char.total_ms(st) / 1000)
        elif kind == "pose":
            st = self.char.resolve(act[1])
            if st:
                self.pose = (st, None if act[2] is None else t + act[2])
                au = self.autonomy
                if au is not None and au.media_pose == act[1]:
                    au.media_pose = st                # take back exactly what is showing
        elif kind == "say":
            self.bubble.show(act[1], act[2])
        elif kind == "use":
            ok = self.command({"cmd": "use", "id": act[1], "verb": act[2]})[0]
            s = self.autonomy.sleeping if self.autonomy is not None else None
            if not ok and s and s[1] == act[1]:
                self.autonomy.sleeping = None        # refused (rate limit...): nothing of ours to undo later
        elif kind == "wake":
            if act[1] == "furniture":
                if self.inside and self.inside[0] == act[2]:
                    self.leave_inside(animate=False)
            elif self.pose and self.pose[0] == act[2]:
                self.pose = None
        elif kind == "look":
            self.command({"cmd": "look", "target": "cursor", "holdMs": 2500})
        elif kind == "look_center":
            l, tp, r, b = self.body_box()
            mon = self.mon(self._x + (l + r) / 2, self._y + b)[0]
            self.command({"cmd": "look", "target": {"x": (mon[0] + mon[2]) // 2, "y": (mon[1] + mon[3]) // 2},
                          "holdMs": 2500})
        elif kind == "walk":
            self.command({"cmd": "walk", "dx": act[1]})
        elif kind == "aside":
            self._go_aside()
        elif kind == "back":
            self._come_back()

    def _go_aside(self):
        """Fullscreen in front: hop (no walk across the film) to the bottom-right corner of this monitor."""
        if self.motion or self.drag or self.inside or self.cfg.get("stayPut"):
            return
        l, t, r, b = self.body_box()
        mon = self.mon(self._x + (l + r) / 2, self._y + b)[0]
        x, y, _ = self.clamp(mon[2], mon[3], mon)
        if abs(x - self._x) < 2 and abs(y - self._y) < 2:
            return
        self._aside_from = (self._x, self._y, int(round(x)), int(round(y)))
        self.place(x, y, clamp=False)

    def _come_back(self):
        a, self._aside_from = self._aside_from, None
        if not a or self.motion or self.drag or self.inside or (self._x, self._y) != (a[2], a[3]):
            return                                   # moved meanwhile: stay where the user put it
        self.place(a[0], a[1])

    # ------------------------------------------------------------------ mouse
    def on_press(self, e):
        if self.motion:
            self.finish_motion(False, "走到一半被拖住了。")
        self.drag = (e.x_root, e.y_root, self._x, self._y, False, e.x_root)

    def on_drag(self, e):
        if not self.drag:
            return
        x0, y0, wx, wy, moved, lastx = self.drag
        if not moved and abs(e.x_root - x0) <= 4 and abs(e.y_root - y0) <= 4:
            return
        self.place(wx + e.x_root - x0, wy + e.y_root - y0)
        self.pose = None
        if self._click_job:
            self.root.after_cancel(self._click_job)
            self._click_job = None
        dx = e.x_root - lastx
        if dx:
            side = "right" if dx > 0 else "left"
            self.drag_dir = "drag-" + side if "drag-" + side in self.char.states else "walk-" + side
        self.drag = (x0, y0, wx, wy, True, e.x_root)

    def on_release(self, e):
        drag, self.drag, self.drag_dir = self.drag, None, None
        if drag and drag[4]:
            self.cfg["position"] = {"x": self._x, "y": self._y}
            save_settings(self.data_dir, self.cfg)
            return
        if self._use_pose:
            self._use_pose, self.pose = False, None
        if self._click_job:
            self.root.after_cancel(self._click_job)
        self._click_job = self.root.after(230, self._wave)

    def _wave(self):
        self._click_job = None
        self.transient = ("waving", time.time() + self.char.total_ms("waving") / 1000)

    def on_double(self, e):
        if self._click_job:
            self.root.after_cancel(self._click_job)
            self._click_job = None
        self.transient = ("jumping", time.time() + self.char.total_ms("jumping") / 1000)

    def on_menu(self, e):
        try:
            self.menu.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu.grab_release()

    def visible(self):
        """For card_dock: the pet is on screen (not inside furniture, not withdrawn)."""
        try:
            return not self.inside and self.root.state() != "withdrawn"
        except Exception:  # noqa: BLE001
            return False

    def apply_topmost(self, on=None):
        """Keep every pet overlay in the requested native Z-order band, including late-created windows."""
        if on is not None:
            self.topmost = bool(on)
        wins = [self.root]
        if getattr(self, "hub", None) is not None:
            wins += [getattr(self.hub, n, None) for n in ("win", "chip")]
            wins.append(getattr(getattr(self.hub, "tip", None), "win", None))
        wins += [f.win for f in getattr(self, "furniture", {}).values()]
        wins += list(getattr(getattr(self, "bubble", None), "windows", []))
        for w in wins:
            try:
                if w is not None:
                    W.sync_topmost(w, self.topmost)
            except Exception:  # noqa: BLE001 - a window may be gone
                pass
        self._restack_furniture()

    def toggle_topmost(self):
        self.apply_topmost(not self.topmost)
        self.cfg["topmost"] = self.topmost
        save_settings(self.data_dir, self.cfg)

    def toggle_stay(self):
        self.cfg["stayPut"] = not self.cfg.get("stayPut")
        save_settings(self.data_dir, self.cfg)

    # ------------------------------------------------------------------ shutdown
    def quit(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._state_log.write_offline()  # 「活动与额度」状态带：从这行起算没在运行
        except Exception:  # noqa: BLE001
            pass
        if self._prewarm_job is not None:
            try:
                self.root.after_cancel(self._prewarm_job)
            except Exception:  # noqa: BLE001
                pass
            self._prewarm_job = None
        if self.motion:
            self.finish_motion(False, "桌宠退出了。")
        if self.control:
            self.control.close()
        if self.mic is not None:
            self.mic.cancel()
        if self.listener is not None:
            self.listener.stop()
        self._close_voiceprint()
        try:
            self.voice.close()
        except Exception:  # noqa: BLE001
            pass
        for w in list(self.furniture.values()):
            w.destroy()
        if self.hub is not None:
            self.hub.destroy()
        if self.card is not None:
            self.card.stop()
        if self.reading is not None:
            self.reading.stop()
        self.bubble.destroy()
        try:
            self.root.after_cancel(self._loop_job)
        except Exception:  # noqa: BLE001
            pass
        self.root.destroy()
