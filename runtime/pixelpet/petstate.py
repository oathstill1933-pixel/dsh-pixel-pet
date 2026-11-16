"""桌宠状态监测（「活动与额度」页签 v2）：只记类别，去抖 10 秒写 <dataDir>/pet-state.jsonl。

分类只来自桌宠自己的可见状态（隐藏 / 家具 / 语音 / 会话忙碌 / 走动），不涉及任何对话内容、
文字、路径。宿主读这份文件画 288 个 5 分钟格的状态带；没被任何行覆盖的时段 = offline
（桌宠没在运行）。文件 30 天滚动删除（写时顺带整枝，每小时至多一次）。

类别（STATES）：
    idle 待机 / walk 走动 / speaking 说话 / thinking 思考（含听写收音）/
    working 工作中（绑定会话在跑）/ inside 在家具里 / hidden 隐藏（窗口 withdraw）
"""
import datetime
import json
import os
import time

STATES = ("idle", "walk", "speaking", "thinking", "working", "inside", "hidden", "offline")
DEBOUNCE_S = 10.0
DEBOUNCE_QUICK_S = 3.0     # 「说话」「思考」大多不到 10 秒，短去抖才上得了状态带
HEARTBEAT_S = 300.0        # 状态没变也每 5 分钟写一行当前状态（hb: true），宿主据此判「没在运行」
KEEP_DAYS = 30
PRUNE_EVERY = 3600.0
LOG_NAME = "pet-state.jsonl"
# 本地时区只在启动时定一次；Windows 上对 epoch 附近的 naive 时间调 astimezone() 会 EINVAL，
# 所以写日志统一走 fromtimestamp(t, tz)（时区已知的转换不走那条路径）。
_LOCAL_TZ = datetime.datetime.now().astimezone().tzinfo


def _iso(t):
    return datetime.datetime.fromtimestamp(t, _LOCAL_TZ).isoformat(timespec="seconds")


def classify(snap, now=None):
    """snap = {withdrawn, inside, voice, motion, manual, manual_until} -> STATES 之一。优先级从高到低。"""
    now = time.time() if now is None else now
    if snap.get("withdrawn"):
        return "hidden"
    if snap.get("inside"):
        return "inside"
    voice = str(snap.get("voice") or "")
    if voice == "speaking":
        return "speaking"
    if voice in ("thinking", "hearing", "listening"):
        return "thinking"
    until = snap.get("manual_until")
    if str(snap.get("manual") or "") in ("running", "waiting") and (not until or until > now):
        return "working"
    if snap.get("motion"):
        return "walk"
    return "idle"


class PetStateLog:
    """每秒 observe(snap) 一次：新类别持续去抖秒数才算切换并落盘（「说话」「思考」3 秒，其余 10 秒）；
    每 5 分钟 heartbeat() 落一行当前状态（hb: true），桌宠关掉后宿主据此判 offline；返回落盘的类别或 None。"""

    def __init__(self, data_dir, clock=None, debounce=DEBOUNCE_S, append=None):
        self.path = os.path.join(data_dir, LOG_NAME) if data_dir else None
        self.clock = clock or time.time
        self.debounce = debounce
        self._append = append  # 测试注入；默认写文件
        self.current = None
        self.pending = None
        self._hb_at = None
        self._pruned_at = None

    @staticmethod
    def debounce_of(cat):
        return DEBOUNCE_QUICK_S if cat in ("speaking", "thinking") else DEBOUNCE_S

    def observe(self, snap):
        cat = classify(snap, self.clock())
        t = self.clock()
        if cat != self.current:
            if self.pending and self.pending[0] == cat:
                if t - self.pending[1] >= self.debounce_of(cat):
                    self.current = cat
                    self.pending = None
                    self._write(cat, t)
                    return cat
            else:
                self.pending = (cat, t)
        else:
            self.pending = None
        return None

    def heartbeat(self, snap):
        """状态没变时的定时心跳（带 hb: true，只记类别）。满 5 分钟才写一行。"""
        cat = classify(snap, self.clock())
        t = self.clock()
        if self.current is None or cat != self.current:
            return None
        if self._hb_at is not None and t - self._hb_at < HEARTBEAT_S:
            return None
        self._hb_at = t
        self._write(cat, t, hb=True)
        return cat

    def write_offline(self):
        """桌宠退出（quit）时写一行 offline，宿主的状态带由此知道后面是没在运行。"""
        self.current = "offline"
        self.pending = None
        self._write("offline", self.clock())

    def _write(self, state, t, hb=False):
        if self._append is not None:
            self._append(state, t, hb)
            return
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            row = {"t": _iso(t), "state": state}
            if hb:
                row["hb"] = True
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            return
        if self._pruned_at is None or t - self._pruned_at >= PRUNE_EVERY:
            self._pruned_at = t
            self._prune(t)

    def _prune(self, t=None):
        """只保留最近 KEEP_DAYS 天（只动这一个文件）。"""
        if not self.path or not os.path.isfile(self.path):
            return 0
        t = self.clock() if t is None else t
        cutoff = t - KEEP_DAYS * 86400.0
        keep, dropped = [], 0
        try:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        when = datetime.datetime.fromisoformat(json.loads(line)["t"]).timestamp()
                        if when >= cutoff:
                            keep.append(line)
                        else:
                            dropped += 1
                    except (ValueError, KeyError, TypeError):
                        dropped += 1
            if dropped:
                tmp = self.path + ".%d.tmp" % os.getpid()
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write("".join(x + "\n" for x in keep))
                os.replace(tmp, self.path)
        except OSError:
            return 0
        return dropped
