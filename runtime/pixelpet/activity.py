"""活动感知：前台窗口（此刻在看什么）+ 后台进程名（开着什么）+ 键鼠空闲（人在不在）→ 在干什么。

隐私：
  - 前台窗口只拿到 {process, class, video_hint}；标题在 window.foreground_app() 里比对完就丢，不出函数。
  - 后台只扫进程名（低频），不读命令行、不读窗口。
  - 日志 <dataDir>/activity-log.jsonl 只记分类和进程名，保留 7 天；绝不记标题。
  - 「认不准就学」：<dataDir>/activity.json {"learned": {"xxx.exe": "gaming"}}，按进程名覆盖判断。
这些都只在 settings.autonomy.aware 打开时运行（见 autonomy.py）。
"""
from __future__ import annotations

import datetime
import json
import os

STATES = ("gaming", "gaming_break", "video", "work", "meeting", "browsing", "other", "away")
LEARNABLE = ("gaming", "video", "work", "meeting", "browsing")

BROWSERS = frozenset((
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "360se.exe", "qqbrowser.exe",
    "sogouexplorer.exe",
))
# 专门的播放器 / 视频客户端：开在前台、全屏或人没动键鼠就算在看
PLAYERS = frozenset((
    "potplayermini64.exe", "potplayermini.exe", "potplayer.exe", "vlc.exe", "mpv.exe", "mpc-hc.exe", "mpc-hc64.exe",
    "mpc-be.exe", "mpc-be64.exe", "bilibili.exe", "哔哩哔哩.exe", "qqlive.exe", "qyclient.exe", "youkuclient.exe",
))
# 浏览器标题里出现这些词才可能在看视频（比对在 window.foreground_app 内完成）
VIDEO_TITLE_HINTS = (
    "bilibili", "哔哩哔哩", "youtube", "netflix", "腾讯视频", "爱奇艺", "优酷", "芒果tv", "番剧", "直播", "twitch",
)
WORK_PROCESSES = frozenset((
    "photoshop.exe", "illustrator.exe", "clipstudiopaint.exe", "sai2.exe", "krita.exe", "blender.exe", "obsidian.exe",
    "code.exe", "cursor.exe", "devenv.exe", "rider64.exe", "idea64.exe", "pycharm64.exe", "winword.exe", "excel.exe",
    "powerpnt.exe", "onenote.exe", "acrobat.exe", "acrord32.exe", "wps.exe", "et.exe", "wpp.exe", "notepad++.exe",
    "windowsterminal.exe", "deepseek harness.exe", "dsh.exe",
))
MEETING_PROCESSES = frozenset((
    "wemeetapp.exe", "ms-teams.exe", "teams.exe", "zoom.exe", "feishu.exe", "lark.exe", "dingtalk.exe",
    "welink.exe", "webex.exe", "ciscowebexstart.exe", "voovmeetingapp.exe", "tencentmeeting.exe",
))
# 具体游戏进程名（只放真实存在的游戏本体；启动器/商店界面不算在玩）
GAME_PROCESSES = frozenset((
    "genshinimpact.exe", "yuanshen.exe", "starrail.exe", "zenlesszonezero.exe", "league of legends.exe",
    "valorant-win64-shipping.exe", "cs2.exe", "dota2.exe", "eldenring.exe", "sekiro.exe", "hades.exe", "hades2.exe",
    "minecraft.windows.exe","overwatch.exe", "wutheringwaves.exe", "client-win64-shipping.exe",
    "naraka.exe", "pubg.exe", "tslgame.exe", "honkai3rd.exe", "baldursgate3.exe", "bg3.exe", "stardew valley.exe",
))
GAME_CLASSES = frozenset(("UnityWndClass", "UnrealWindow", "RiotWindowClass"))
DESKTOP = frozenset(("", "explorer.exe", "searchhost.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe"))

AWAY_IDLE_S = 600.0
WATCH_IDLE_S = 20.0           # 浏览器/播放器开着、标题像视频、且键鼠空闲 >20 秒 → 在看


def classify(fg, idle: float = 0.0, fullscreen: bool = False, running=(), learned=None) -> str:
    """-> one of STATES.

    fg       window.foreground_app() 的返回值 {process, class, video_hint}；None = 没有前台窗口/是桌宠自己
    running  后台进程名（小写）集合，用来认出「游戏开着但切出来了」
    learned  {进程名: 分类}，用户在设置页纠正过的，优先
    """
    fg = fg or {}
    process = str(fg.get("process") or "").lower()
    cls = str(fg.get("class") or "")
    hint = bool(fg.get("video_hint"))
    learned = learned or {}

    if idle >= AWAY_IDLE_S and not fullscreen:
        return "away"

    own = learned.get(process) if process else None
    if own in LEARNABLE:
        state = own
    elif process in MEETING_PROCESSES:
        state = "meeting"
    elif cls in GAME_CLASSES or process in GAME_PROCESSES:
        state = "gaming"
    elif process in PLAYERS and (fullscreen or idle >= WATCH_IDLE_S or hint):
        state = "video"
    elif process in BROWSERS and hint and (fullscreen or idle >= WATCH_IDLE_S):
        state = "video"
    elif process in WORK_PROCESSES:
        state = "work"
    elif fullscreen and process not in BROWSERS and process not in PLAYERS and process not in DESKTOP:
        state = "gaming"                      # 全屏、不认识、又不是浏览器/播放器 → 多半是游戏
    elif process in DESKTOP:
        state = "other"
    else:
        state = "browsing"

    if state in ("browsing", "other") and running_game(running, learned):
        return "gaming_break"
    return state


def running_game(running, learned=None):
    """后台在跑的第一个游戏进程名，或 None。"""
    learned = learned or {}
    for name in running or ():
        n = str(name).lower()
        if n in GAME_PROCESSES or learned.get(n) == "gaming":
            return n
    return None


LABELS = {
    "away": "不在电脑前",
    "gaming": "打游戏",
    "gaming_break": "打游戏中途切出来",
    "video": "看视频",
    "work": "干活",
    "meeting": "开会",
    "browsing": "浏览",
    "other": "在桌面上",
}


def label(state: str) -> str:
    return LABELS.get(state, state)


# ---------------------------------------------------------------------------------- 「认不准就学」
class Learned:
    """<dataDir>/activity.json 的 learned 表；按 mtime 热读（设置页由 host 写入）。"""

    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "activity.json") if data_dir else None
        self._mtime = None
        self.table = {}

    def get(self):
        if not self.path:
            return self.table
        try:
            m = os.stat(self.path).st_mtime_ns
        except OSError:
            self._mtime, self.table = None, {}
            return self.table
        if m != self._mtime:
            self._mtime = m
            try:
                with open(self.path, encoding="utf-8") as f:
                    raw = json.load(f)
                tab = raw.get("learned") if isinstance(raw, dict) else None
                self.table = {str(k).lower(): v for k, v in (tab or {}).items()
                              if isinstance(k, str) and v in LEARNABLE} if isinstance(tab, dict) else {}
            except (OSError, ValueError):
                self.table = {}
        return self.table


# ---------------------------------------------------------------------------------- 活动日志
LOG_NAME = "activity-log.jsonl"
KEEP_DAYS = 7
PRUNE_EVERY = 3600.0


def iso(dt):
    """aware ISO-8601 with the local offset, seconds precision."""
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.replace(microsecond=0).isoformat()


class ActivityLog:
    """一行一个状态切换：{"t","state","app","dur"}。dur = 写入时这个状态已持续的秒数（去抖延迟）。
    只保留最近 7 天：写入时最多每小时把更旧的行剔掉（只动这一个文件）。"""

    def __init__(self, data_dir, clock=None):
        self.path = os.path.join(data_dir, LOG_NAME) if data_dir else None
        self.clock = clock or datetime.datetime.now
        self._pruned_at = None

    def write(self, state, app, dur=0):
        if not self.path or state not in STATES:
            return False
        now = self.clock()
        row = {"t": iso(now), "state": state, "app": _safe_app(app), "dur": int(max(0, dur))}
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            return False
        t = now.timestamp()
        if self._pruned_at is None or t - self._pruned_at >= PRUNE_EVERY:
            self._pruned_at = t
            self.prune(now)
        return True

    def prune(self, now=None):
        if not self.path or not os.path.isfile(self.path):
            return 0
        now = now or self.clock()
        if now.tzinfo is None:
            now = now.astimezone()
        cutoff = now - datetime.timedelta(days=KEEP_DAYS)
        keep, dropped = [], 0
        try:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        when = datetime.datetime.fromisoformat(json.loads(line)["t"])
                        if when.tzinfo is None:
                            when = when.astimezone()
                    except (ValueError, KeyError, TypeError):
                        dropped += 1
                        continue
                    if when >= cutoff:
                        keep.append(line)
                    else:
                        dropped += 1
            if dropped:
                tmp = self.path + ".%d.tmp" % os.getpid()
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write("".join(x + "\n" for x in keep))
                os.replace(tmp, self.path)
        except OSError:
            return 0
        return dropped


def _safe_app(app):
    """进程名而已：去路径、截断、去控制字符。"""
    s = str(app or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return "".join(ch for ch in s if ch.isprintable())[:64]
