"""「主动一点」: the local rule engine (pure, injected clock / idle / fullscreen) and its wiring into PetApp."""
import datetime
import os
import random
import shutil
import unittest

from helpers import ROOT, make_character, make_furniture, tmpdir

from pixelpet import autonomy as AU
from test_mailbox import write_state

STATES = {"idle", "attentive", "waving", "jumping", "lie", "curl-sleep", "mood-sleepy", "mood-happy", "mood-thinking"}


class Rig:
    """Fake clock + idle + fullscreen around one Autonomy engine."""

    def __init__(self, start=datetime.datetime(2026, 11, 10, 14, 0, 0), memory=None):
        self.now, self.idle, self.fs = start, 0.0, False
        self.saved = []
        self.fg, self.procs, self.learned = None, frozenset(), {}
        self.fg_calls = self.proc_calls = 0
        self.logged = []

        def fg():
            self.fg_calls += 1
            return self.fg

        def procs():
            self.proc_calls += 1
            return self.procs
        log = type("L", (), {"write": lambda _s, state, app, dur=0: self.logged.append((state, app, int(dur)))})()
        self.eng = AU.Autonomy(clock=lambda: self.now, idle=lambda: self.idle, fullscreen=lambda: self.fs,
                               rng=random.Random(7), memory=memory if memory is not None else {"hello": "2026-11-10"},
                               on_memory=self.saved.append, foreground=fg, processes=procs,
                               learned=lambda: self.learned, log=log)
        self.cfg = {}
        self.pet = {"voice": "idle", "dragging": False, "inside": None, "pose": None, "held": False,
                    "moving": False, "stay_put": False, "sleep_spot": None, "mailbox": None, "can_look": True,
                    "states": set(STATES)}

    def tick(self, **pet):
        self.pet.update(pet)
        return self.eng.tick(self.cfg, dict(self.pet))

    def step(self, seconds, idle_grows=True):
        self.now += datetime.timedelta(seconds=seconds)
        if idle_grows:
            self.idle += seconds

    def away(self):
        """Idle 10 min -> yawn, 4 s later -> sleep. Returns (yawn, sleep) action lists."""
        self.step(AU.AWAY_S)
        yawn = self.tick()
        self.step(4)
        return yawn, self.tick()


class Config(unittest.TestCase):
    def test_defaults_and_quiet_hours(self):
        c = AU.autonomy_cfg(None)
        self.assertTrue(c["enabled"])
        self.assertTrue(all(c["rules"].values()))
        self.assertEqual(set(c["rules"]), set(AU.RULES))
        self.assertIsNone(c["quiet"])
        c = AU.autonomy_cfg({"enabled": False, "rules": {"lateNight": False}, "quietHours": {"start": "23:00", "end": "07:30"}})
        self.assertFalse(c["enabled"])
        self.assertFalse(c["rules"]["lateNight"])
        self.assertTrue(c["rules"]["idleSleep"])
        self.assertEqual(c["quiet"], (23 * 60, 7 * 60 + 30))
        for bad in ({"start": "7:00", "end": "08:00"}, {"start": "08:00", "end": "08:00"}, {"start": "", "end": "08:00"},
                    {"start": "25:00", "end": "08:00"}):
            self.assertIsNone(AU.autonomy_cfg({"quietHours": bad})["quiet"], bad)
        self.assertTrue(AU.in_window(30, 23 * 60, 8 * 60))
        self.assertFalse(AU.in_window(12 * 60, 23 * 60, 8 * 60))
        self.assertTrue(AU.in_window(60, 0, 8 * 60))

    def test_idle_seconds_is_a_number(self):
        self.assertGreaterEqual(AU.idle_seconds(), 0.0)


class Rules(unittest.TestCase):
    def test_idle_sleep_furniture_then_welcome_back(self):
        r = Rig()
        r.pet["sleep_spot"] = ("nest", "sleep")
        self.assertEqual(r.tick(), [])
        yawn, sleep = r.away()
        self.assertEqual(yawn, [("mood", "困", AU.YAWN_S + 0.5)])
        self.assertEqual(sleep, [("use", "nest", "sleep")])
        r.step(5)
        self.assertEqual(r.tick(inside="nest"), [])             # asleep: nothing else happens
        r.step(600)
        self.assertEqual(r.tick(), [])                          # no second sleep in the same absence
        r.idle = 1                                              # mouse moved
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(), [("wake", "furniture", "nest"), ("transient", "waving")])

    def test_idle_sleep_without_furniture_lies_down(self):
        r = Rig()
        _, sleep = r.away()
        self.assertEqual(sleep, [("pose", "curl-sleep", None)])
        r.pet["states"] = {"idle", "lie"}
        r2 = Rig()
        r2.pet["states"] = {"idle", "lie"}
        self.assertEqual(r2.away()[1], [("pose", "lie", None)])
        r.idle = 0
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(pose="curl-sleep")[0], ("wake", "pose", "curl-sleep"))

    def test_someone_else_woke_it(self):
        r = Rig()
        r.pet["sleep_spot"] = ("nest", "sleep")
        r.away()
        r.step(40)
        r.tick(inside="nest")
        r.step(5)
        r.tick(inside=None)                                     # the AI / user took it out
        r.idle = 0
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(), [("transient", "waving")])  # just a wave, no stale wake

    def test_welcome_back_off_still_wakes(self):
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"welcomeBack": False}}}
        r.away()
        r.idle = 0
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(pose="curl-sleep"), [("wake", "pose", "curl-sleep")])

    def test_idle_sleep_off(self):
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"idleSleep": False}}}
        yawn, sleep = r.away()
        self.assertEqual((yawn, sleep), ([], []))
        r.idle = 0
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(), [("transient", "waving")])

    def test_break_reminder_after_90_min(self):
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"idleFidget": False}}}
        r.tick()
        for _ in range(89):
            r.step(60, idle_grows=False)
            self.assertEqual(r.tick(), [])
        r.step(60, idle_grows=False)
        self.assertEqual(r.tick(), [("say", "歇会儿吧", 6), ("transient", "jumping")])
        r.step(60, idle_grows=False)
        self.assertEqual(r.tick(), [])                          # next one only after another 90 min

    def test_break_resets_the_stretch(self):
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"idleFidget": False}}}
        r.tick()
        r.step(60 * 60, idle_grows=False)
        r.tick()
        r.idle = AU.BREAK_S                                     # a 5-min pause
        r.tick()
        r.idle = 0
        r.tick()                                                # back: a new stretch starts now
        r.step(60 * 60, idle_grows=False)
        self.assertEqual(r.tick(), [])
        r.step(31 * 60, idle_grows=False)
        self.assertEqual(r.tick()[0], ("say", "歇会儿吧", 6))

    def test_break_reminder_yields_to_care(self):
        # 「主动关心」(autonomy.care) 开着：本地「歇会儿吧」让位给宿主侧叫醒流程（lib/proactive.js），
        # 到点也一句不说；关掉 care 即恢复。
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"idleFidget": False}, "care": True}}
        r.tick()
        for _ in range(91):
            r.step(60, idle_grows=False)
            self.assertEqual(r.tick(), [])
        r.cfg = {"autonomy": {"rules": {"idleFidget": False}, "care": False}}
        r.step(60, idle_grows=False)
        self.assertEqual(r.tick()[0], ("say", "歇会儿吧", 6))    # care 关掉即恢复（这一段还在计时）

    def test_late_night_sleepy_occasionally(self):
        r = Rig(start=datetime.datetime(2026, 11, 10, 23, 31))
        r.cfg = {"autonomy": {"rules": {"idleFidget": False, "breakReminder": False}}}
        self.assertEqual(r.tick(), [("mood", "困", 8)])
        r.step(60, idle_grows=False)
        self.assertEqual(r.tick(), [])
        r.step(AU.LATE_EVERY, idle_grows=False)
        self.assertEqual(r.tick(), [("mood", "困", 8)])
        r2 = Rig(start=datetime.datetime(2026, 11, 10, 23, 0))
        r2.cfg = r.cfg
        self.assertEqual(r2.tick(), [])
        r3 = Rig(start=datetime.datetime(2026, 11, 10, 23, 40))
        r3.cfg = {"autonomy": {"rules": {"lateNight": False, "idleFidget": False}}}
        self.assertEqual(r3.tick(), [])

    def test_morning_hello_once_a_day(self):
        r = Rig(start=datetime.datetime(2026, 11, 11, 8, 0), memory={"hello": "2026-11-10"})
        self.assertEqual(r.tick(), [("transient", "waving")])
        self.assertEqual(r.saved[-1], {"hello": "2026-11-11"})
        r.step(30, idle_grows=False)
        self.assertNotIn(("transient", "waving"), r.tick())
        r2 = Rig(start=datetime.datetime(2026, 11, 11, 4, 30), memory={})
        r2.cfg = {"autonomy": {"rules": {"lateNight": False}}}
        self.assertEqual(r2.tick(), [])                          # before 05:00 is still last night
        r3 = Rig(start=datetime.datetime(2026, 11, 11, 8, 0), memory={"hello": "2026-11-11"})
        self.assertEqual(r3.tick(), [])                          # restart: already greeted today
        r4 = Rig(start=datetime.datetime(2026, 11, 11, 8, 0), memory={})
        r4.cfg = {"autonomy": {"rules": {"morningHello": False}}}
        self.assertEqual(r4.tick(), [])

    def test_new_mail_goes_to_mailbox(self):
        r = Rig()
        r.pet["mailbox"] = ("mailbox", "check")
        r.eng.note_mail()
        self.assertEqual(r.tick(), [("use", "mailbox", "check"), ("say", "有信", 5)])
        r.eng.note_mail()
        self.assertEqual(r.tick(stay_put=True), [("say", "有信", 5)])   # 别乱走: bubble only
        r.eng.note_mail()
        r.tick(held=True)                                        # busy: waits
        r.step(AU.MAIL_TTL + 1, idle_grows=False)
        self.assertEqual(r.tick(held=False, stay_put=False), [])  # too old: dropped
        r.cfg = {"autonomy": {"rules": {"newMail": False}}}
        r.eng.note_mail()
        self.assertEqual(r.tick(), [])

    def test_fullscreen_aside_silence_and_back(self):
        r = Rig()
        r.pet["mailbox"] = ("mailbox", "check")
        r.fs = True
        self.assertEqual(r.tick(), [("aside",)])
        r.step(AU.AWAY_S + 60)                                  # a long film without input is not "away"
        self.assertEqual(r.tick(), [])
        r.eng.note_mail()
        r.step(AU.FULLSCREEN_EVERY)
        self.assertEqual(r.tick(), [])                          # no bubbles, no moves
        r.fs = False
        r.idle = 0
        r.step(AU.FULLSCREEN_EVERY, idle_grows=False)
        self.assertEqual(r.tick(), [("back",)])
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(), [("use", "mailbox", "check"), ("say", "有信", 5)])

    def test_fullscreen_hide_off_or_stay_put_still_silent(self):
        for cfg, pet in (({"autonomy": {"rules": {"fullscreenHide": False}}}, {}), ({}, {"stay_put": True})):
            r = Rig()
            r.cfg = cfg
            r.fs = True
            r.eng.note_mail()
            self.assertEqual(r.tick(**pet), [])

    def test_idle_fidget(self):
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"breakReminder": False}}}
        self.assertEqual(r.tick(), [])                          # schedules the first one
        seen = []
        for _ in range(40):
            r.step(AU.FIDGET_GAP[1], idle_grows=False)
            acts = r.tick()
            if acts:
                self.assertEqual(len(acts), 1)
                seen.append(acts[0][0])
        self.assertTrue(seen)
        self.assertTrue(set(seen) <= {"look", "walk", "pose", "mood"})
        r = Rig()
        r.cfg = {"autonomy": {"rules": {"breakReminder": False}}}
        r.pet.update(stay_put=True, can_look=False, states={"idle"})
        r.tick()
        for _ in range(20):
            r.step(AU.FIDGET_GAP[1], idle_grows=False)
            for a in r.tick():
                self.assertEqual(a[0], "mood")                  # 别乱走: no walking
        r = Rig()
        r.idle = 120                                             # user not at the computer: no fidget
        r.tick()
        for _ in range(5):
            r.step(AU.FIDGET_GAP[1], idle_grows=False)
            self.assertEqual(r.tick(), [])


class Guards(unittest.TestCase):
    def test_cap_three_per_ten_minutes(self):
        r = Rig()
        r.pet["mailbox"] = ("mailbox", "check")
        fired = 0
        for _ in range(6):
            r.eng.note_mail()
            if r.tick():
                fired += 1
            r.step(10, idle_grows=False)
        self.assertEqual(fired, 3)
        r.step(AU.CAP_WINDOW, idle_grows=False)
        self.assertTrue(r.tick())                                # the pending letter goes once the window frees

    def test_yield_while_busy(self):
        for pet in ({"voice": "speaking"}, {"voice": "listening"}, {"voice": "hearing"}, {"voice": "thinking"},
                    {"dragging": True}, {"inside": "bed"}, {"held": True}, {"pose": "lie"}, {"moving": True}):
            r = Rig(start=datetime.datetime(2026, 11, 11, 8, 0), memory={})
            r.pet["mailbox"] = ("mailbox", "check")
            r.eng.note_mail()
            self.assertEqual(r.tick(**pet), [], pet)
            r.step(AU.AWAY_S)
            self.assertEqual(r.tick(**pet), [], pet)             # no yawn either

    def test_disabled_switch_stops_everything(self):
        r = Rig(start=datetime.datetime(2026, 11, 11, 8, 0), memory={})
        r.cfg = {"autonomy": {"enabled": False}}
        r.pet["mailbox"] = ("mailbox", "check")
        r.eng.note_mail()
        self.assertEqual(r.tick(), [])
        r.fs = True
        r.step(AU.AWAY_S)
        self.assertEqual(r.tick(), [])
        # turned off while the pet sleeps on our account -> it gets up, then nothing more
        r = Rig()
        r.away()
        r.cfg = {"autonomy": {"enabled": False}}
        self.assertEqual(r.tick(pose="curl-sleep"), [("wake", "pose", "curl-sleep")])
        self.assertEqual(r.tick(pose=None), [])

    def test_quiet_hours_only_sleep(self):
        r = Rig(start=datetime.datetime(2026, 11, 11, 0, 30), memory={})
        r.cfg = {"autonomy": {"quietHours": {"start": "00:00", "end": "08:00"}}}
        r.pet.update(mailbox=("mailbox", "check"), sleep_spot=("nest", "sleep"))
        r.eng.note_mail()
        self.assertEqual(r.tick(), [("use", "nest", "sleep")])  # goes to bed at once, user active or not
        r.step(5, idle_grows=False)
        self.assertEqual(r.tick(inside="nest"), [])              # no mail walk, no late-night yawns
        r.step(AU.AWAY_S)
        r.tick(inside="nest")
        r.idle = 0
        r.step(1, idle_grows=False)
        self.assertEqual(r.tick(inside="nest"), [])              # back at 1 am: keeps sleeping, no wave
        r.now = datetime.datetime(2026, 11, 11, 8, 0, 5)
        self.assertEqual(r.tick(inside="nest"), [("wake", "furniture", "nest")])
        self.assertEqual(r.tick(inside=None), [("transient", "waving")])   # then the morning hello

    def test_stay_put_sleeps_in_place(self):
        r = Rig()
        r.pet.update(sleep_spot=("nest", "sleep"), stay_put=True)
        self.assertEqual(r.away()[1], [("pose", "curl-sleep", None)])


CHROME_VIDEO = {"process": "chrome.exe", "class": "Chrome_WidgetWin_1", "video_hint": True}
CODE = {"process": "code.exe", "class": "Chrome_WidgetWin_1", "video_hint": False}
GAME = {"process": "genshinimpact.exe", "class": "UnityWndClass", "video_hint": False}
ZOOM = {"process": "zoom.exe", "class": "ZPContentViewWndClass", "video_hint": False}


def aware(**rules):
    return {"autonomy": {"aware": True, "rules": dict({"idleFidget": False}, **rules)}}


def settle(r, fg, ticks=12, **pet):
    """switch the foreground and tick past the debounce; -> all actions seen"""
    r.fg = fg
    seen = []
    for _ in range(ticks):
        r.step(AU.ACTIVITY_EVERY, idle_grows=False)
        seen += r.tick(**pet)
    return seen


class Awareness(unittest.TestCase):
    """「允许感知在做什么」: the privacy switch, debounce, per-activity reactions, our own watching pose."""

    def test_switch_off_never_touches_window_or_processes(self):
        r = Rig()
        r.fg = CHROME_VIDEO
        r.fs = True
        for _ in range(40):
            r.step(AU.ACTIVITY_EVERY)
            r.tick()
        r.cfg = {"autonomy": {"aware": False}}
        for _ in range(10):
            r.step(AU.ACTIVITY_EVERY)
            r.tick()
        self.assertEqual((r.fg_calls, r.proc_calls, r.logged), (0, 0, []))
        self.assertFalse(AU.autonomy_cfg({})["aware"])            # default off

    def test_turning_it_off_stops_probing_and_logging(self):
        r = Rig()
        r.cfg = aware()
        settle(r, CODE, ticks=3)
        calls, logged = r.fg_calls, list(r.logged)
        self.assertGreater(calls, 0)
        r.cfg = {"autonomy": {"aware": False}}
        settle(r, GAME, ticks=20)
        self.assertEqual((r.fg_calls, r.logged), (calls, logged))
        self.assertIsNone(r.eng.state)

    def test_process_scan_is_low_frequency(self):
        r = Rig()
        r.cfg = aware()
        settle(r, CODE, ticks=20)                                  # 60 s
        self.assertLessEqual(r.proc_calls, 60 // AU.PROCESS_EVERY + 1)
        self.assertGreaterEqual(r.fg_calls, 15)

    def test_debounce(self):
        r = Rig()
        r.cfg = aware()
        settle(r, CODE, ticks=1)
        self.assertEqual(r.eng.state, "work")
        self.assertEqual(r.logged, [("work", "code.exe", 0)])
        r.fg = GAME                                               # a quick look at the game ...
        for _ in range(3):
            r.step(AU.ACTIVITY_EVERY, idle_grows=False)
            r.tick()
        self.assertEqual(r.eng.state, "work")
        settle(r, CODE, ticks=3)                                  # ... and back: nothing changed
        self.assertEqual(len(r.logged), 1)
        settle(r, GAME, ticks=int(AU.DEBOUNCE_S // AU.ACTIVITY_EVERY) + 2)
        self.assertEqual(r.eng.state, "gaming")
        self.assertEqual(r.logged[-1][:2], ("gaming", "genshinimpact.exe"))
        self.assertGreaterEqual(r.logged[-1][2], AU.DEBOUNCE_S)
        self.assertEqual(len(r.logged), 2)

    def test_learned_override_wins(self):
        r = Rig()
        r.cfg = aware()
        r.learned = {"code.exe": "gaming"}
        settle(r, CODE, ticks=1)
        self.assertEqual(r.eng.state, "gaming")
        self.assertEqual(r.eng.snapshot()["app"], "code.exe")

    def test_video_pose_is_ours_and_comes_back(self):
        r = Rig()
        r.cfg = aware()
        r.idle = 30
        self.assertIn(("pose", "attentive", None), settle(r, CHROME_VIDEO, ticks=1))
        self.assertEqual(r.eng.media_pose, "attentive")
        r.pet["pose"] = "attentive"
        r.step(3, idle_grows=False)
        self.assertNotIn("pose", [a[0] for a in r.tick()])
        # A1: the rule switched off while watching -> our pose goes, other rules work again
        r.cfg = aware(videoCompany=False)
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [("wake", "pose", "attentive")])
        r.pet["pose"] = None
        r.eng.note_mail()
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [("say", "有信", 5)])

    def test_video_pose_dropped_by_master_switch(self):
        r = Rig()
        r.cfg = aware()
        r.idle = 30
        settle(r, CHROME_VIDEO, ticks=1)
        r.pet["pose"] = "attentive"
        r.cfg = {"autonomy": {"enabled": False, "aware": True}}
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [("wake", "pose", "attentive")])
        self.assertIsNone(r.eng.media_pose)

    def test_video_pose_retried_when_busy_and_only_ours_is_taken_back(self):
        r = Rig()
        r.cfg = aware()
        r.idle = 30
        self.assertEqual(settle(r, CHROME_VIDEO, ticks=1, held=True), [])
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(held=False), [("pose", "attentive", None)])
        r.pet["pose"] = "lie"                                     # the AI put it in another pose meanwhile
        r.idle = 0
        acts = settle(r, CODE)
        self.assertNotIn("wake", [a[0] for a in acts])           # not ours: left alone
        self.assertIsNone(r.eng.media_pose)
        # and the plain case: leaving the video takes our pose back
        r2 = Rig()
        r2.cfg = aware()
        r2.idle = 30
        settle(r2, CHROME_VIDEO, ticks=1)
        r2.pet["pose"] = "attentive"
        r2.idle = 0
        self.assertIn(("wake", "pose", "attentive"), settle(r2, CODE))

    def test_video_glances_at_the_screen(self):
        r = Rig()
        r.cfg = aware()
        r.idle = 30
        settle(r, CHROME_VIDEO, ticks=1)
        r.pet["pose"] = "attentive"
        seen = []
        for _ in range(4):
            r.step(AU.GLANCE_GAP[1] + 1, idle_grows=False)
            seen += r.tick()
        self.assertIn(("look_center",), seen)
        self.assertTrue(all(a == ("look_center",) for a in seen))

    def test_fullscreen_video_corner_vs_game_aside(self):
        r = Rig()
        r.cfg = aware()
        r.fs = True
        acts = settle(r, CHROME_VIDEO, ticks=1)
        self.assertEqual(acts, [("pose", "attentive", None), ("aside",)])
        r = Rig()
        r.cfg = aware(videoCorner=False)
        r.fs = True
        self.assertEqual(settle(r, CHROME_VIDEO, ticks=1), [("pose", "attentive", None)])
        r = Rig()
        r.cfg = aware(fullscreenHide=False)
        r.fs = True
        self.assertEqual(settle(r, CHROME_VIDEO, ticks=1)[-1], ("aside",))   # video corner is its own switch
        r = Rig()
        r.cfg = aware()
        r.fs = True
        self.assertEqual(settle(r, {"process": "somegame.exe", "class": "X", "video_hint": False}, ticks=1), [("aside",)])
        r = Rig()
        r.cfg = aware(fullscreenHide=False)
        r.fs = True
        self.assertEqual(settle(r, GAME, ticks=3), [])

    def test_game_quiet_and_wave_when_back(self):
        r = Rig()
        r.cfg = aware()
        settle(r, GAME, ticks=1)
        r.eng.note_mail()
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [])                           # gaming: nothing at all
        r.procs = frozenset({"genshinimpact.exe"})
        acts = settle(r, CODE, ticks=15)                          # alt-tab, game still running
        self.assertEqual(r.eng.state, "work")                    # code.exe is work, not a break
        self.assertIn(("transient", "waving"), acts)
        r2 = Rig()
        r2.cfg = aware()
        r2.procs = frozenset({"genshinimpact.exe"})
        settle(r2, GAME, ticks=1)
        acts = settle(r2, {"process": "wechat.exe", "class": "X", "video_hint": False}, ticks=15)
        self.assertEqual(r2.eng.state, "gaming_break")
        self.assertEqual(r2.logged[-1][:2], ("gaming_break", "genshinimpact.exe"))
        self.assertEqual(acts, [])                               # still quiet, no wave yet
        r2.procs = frozenset()
        r2.step(AU.PROCESS_EVERY, idle_grows=False)
        acts = settle(r2, {"process": "wechat.exe", "class": "X", "video_hint": False}, ticks=15)
        self.assertEqual(r2.eng.state, "browsing")
        self.assertIn(("transient", "waving"), acts)

    def test_meeting_is_quiet(self):
        r = Rig()
        r.cfg = aware()
        settle(r, ZOOM, ticks=1)
        self.assertEqual(r.eng.state, "meeting")
        r.eng.note_mail()
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [])
        r.cfg = aware(meetingQuiet=False)
        r.step(3, idle_grows=False)
        self.assertEqual(r.tick(), [("say", "有信", 5)])

    def test_work_no_fidget_but_break_reminder(self):
        r = Rig()
        r.cfg = aware(idleFidget=True, breakReminder=False)
        settle(r, CODE, ticks=1)
        for _ in range(20):
            r.step(AU.FIDGET_GAP[1], idle_grows=False)
            self.assertEqual(r.tick(), [])
        r = Rig()
        r.cfg = aware()
        settle(r, CODE, ticks=1)
        seen = []
        for _ in range(95):
            r.step(60, idle_grows=False)
            seen += r.tick()
        self.assertIn(("say", "歇会儿吧", 6), seen)

    def test_probe_errors_are_swallowed(self):
        r = Rig()
        r.cfg = aware()

        def boom():
            raise OSError("秘密窗口标题")
        r.eng.foreground = boom
        r.step(3)
        self.assertEqual(r.tick(), [])
        self.assertIsNone(r.eng.state)


class LiveWiring(unittest.TestCase):
    """Real PetApp off-screen with an injected idle probe: actions land on the pet."""

    def _app(self, extra_furniture=True):
        import tkinter as tk
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester", extra=lambda d: d["moods"].update({"困": "lie"}))
        if extra_furniture:
            make_furniture(root_dir, "nest")
            shutil.copytree(os.path.join(ROOT, "furniture", "mailbox"), os.path.join(root_dir, "furniture", "mailbox"))
        data = tmpdir()
        self.idle = 0.0
        root = tk.Tk()
        app = PetApp(root, root_dir, data_dir=data, character="tester", offscreen=True, speed=4000.0,
                     idle_probe=lambda: self.idle, fullscreen_probe=lambda: False)
        return app, data

    def test_offscreen_without_probe_has_no_rules(self):
        import tkinter as tk
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        root = tk.Tk()
        app = PetApp(root, root_dir, data_dir=tmpdir(), character="tester", offscreen=True)
        try:
            self.assertIsNone(app.autonomy)
        finally:
            app.quit()

    def test_view_sleep_wake_and_mail(self):
        app, data = self._app()
        try:
            v = app._autonomy_view()
            self.assertEqual(v["sleep_spot"], ("nest", "sleep"))
            self.assertEqual(v["mailbox"], ("mailbox", "check"))
            self.assertFalse(v["held"])
            clock = [datetime.datetime(2026, 11, 10, 14, 0)]
            app.autonomy.clock = lambda: clock[0]
            app.autonomy.memory["hello"] = "2026-11-10"
            self.idle = AU.AWAY_S
            self.assertEqual(app.tick_autonomy(), [("mood", "困", AU.YAWN_S + 0.5)])
            self.assertEqual(app.mood[0], "lie")                # character's own 困 mapping
            clock[0] += datetime.timedelta(seconds=4)
            app.mood = None
            self.assertEqual(app.tick_autonomy(), [("use", "nest", "sleep")])
            self.assertIsNotNone(app.motion)
            app.enter_inside("nest", "full", "left")
            app.motion = None
            self.idle = 0
            clock[0] += datetime.timedelta(seconds=1)
            self.assertEqual(app.tick_autonomy(), [("wake", "furniture", "nest"), ("transient", "waving")])
            self.assertIsNone(app.inside)
            self.assertEqual(app.transient[0], "waving")
            app.transient = None
            # a fresh letter: tick_mail tells the engine, the engine sends the pet over
            write_state(data, 0)
            app.tick_mail()
            write_state(data, 1, "2026-11-10T05:00:00Z")
            app.tick_mail()
            self.assertIsNotNone(app.autonomy._mail_at)
            acts = app.tick_autonomy()
            self.assertEqual(acts, [("use", "mailbox", "check"), ("say", "有信", 5)])
        finally:
            app.quit()

    def test_fullscreen_hop_and_back(self):
        app, _ = self._app(extra_furniture=False)
        try:
            x0, y0 = app.pos()
            app._auto_do(("aside",))
            self.assertNotEqual(app.pos(), (x0, y0))
            app._auto_do(("back",))
            self.assertEqual(app.pos(), (x0, y0))
            app._auto_do(("aside",))
            app.place(x0 + 300, y0)                              # dragged meanwhile
            app._auto_do(("back",))
            self.assertEqual(app.pos()[0], x0 + 300)
        finally:
            app.quit()

    def test_offscreen_probes_never_read_the_desktop(self):
        app, data = self._app(extra_furniture=False)
        try:
            self.assertIsNone(app._foreground_probe())
            self.assertEqual(app._process_probe(), frozenset())
            self.assertIs(app.autonomy.foreground, app._foreground_probe)
        finally:
            app.quit()

    def test_injected_probe_switch_log_and_status(self):
        import json
        import tkinter as tk
        from pixelpet.app import PetApp
        root_dir = tmpdir()
        make_character(root_dir, "tester")
        data = tmpdir()
        calls = []

        def fg():
            calls.append(1)
            return {"process": "code.exe", "class": "X", "video_hint": False}
        app = PetApp(tk.Tk(), root_dir, data_dir=data, character="tester", offscreen=True,
                     idle_probe=lambda: 0.0, fullscreen_probe=lambda: False, foreground_probe=fg,
                     process_probe=lambda: frozenset())
        try:
            clock = [datetime.datetime(2026, 11, 10, 14, 0)]
            app.autonomy.clock = lambda: clock[0]
            for _ in range(3):
                clock[0] += datetime.timedelta(seconds=4)
                app.tick_autonomy()
            self.assertEqual(calls, [])                          # switch off by default: zero calls
            self.assertFalse(os.path.exists(os.path.join(data, "activity-log.jsonl")))
            self.assertEqual(app.command({"cmd": "awareness"})[3], {"aware": False})
            app.cfg["autonomy"] = {"aware": True}
            for _ in range(3):
                clock[0] += datetime.timedelta(seconds=4)
                app.tick_autonomy()
            self.assertTrue(calls)
            with open(os.path.join(data, "activity-log.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(x) for x in f if x.strip()]
            self.assertEqual([(x["state"], x["app"]) for x in rows], [("work", "code.exe")])
            self.assertEqual(set(rows[0]), {"t", "state", "app", "dur"})
            st = app.command({"cmd": "awareness"})[3]
            self.assertEqual((st["aware"], st["state"], st["app"]), (True, "work", "code.exe"))
            self.assertNotIn("title", st)
            app._auto_do(("look_center",))                      # glance action is wired
        finally:
            app.quit()

    def test_media_pose_resolved_name_is_tracked(self):
        app, _ = self._app(extra_furniture=False)
        try:
            app.autonomy.media_pose = "attentive"
            app._auto_do(("pose", "attentive", None))
            if app.pose:
                self.assertEqual(app.autonomy.media_pose, app.pose[0])
        finally:
            app.quit()

    def test_disabled_in_settings_file(self):
        app, data = self._app(extra_furniture=False)
        try:
            app.cfg["autonomy"] = {"enabled": False}
            self.idle = AU.AWAY_S
            self.assertEqual(app.tick_autonomy(), [])
        finally:
            app.quit()


if __name__ == "__main__":
    unittest.main()
