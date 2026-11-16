# -*- coding: utf-8 -*-
"""声纹录入窗口（本地 Tk）：用户自己点按钮录 5 句，音频只在内存里。

为什么是一个原生窗口而不是设置页里的表单
----------------------------------------
方案第三节要求「录入全程不经过会话、不经过 agent、音频不写盘」：
设置页只发一条 `voiceprint.enroll.open`（不带任何音频），真正录音发生在这个进程里，
每句算完 embedding 就把 PCM 丢掉，最后只回 `{ok, name, n}`。

质量线（和 sv.MIN_SEG_S / MIN_RMS 保持一致）
--------------------------------------------
* 有声部分 ≥2 s（低于这个数统计不会稳）；
* RMS ≥ sv.MIN_RMS；
* 不削波：触顶样本（|x| ≥ 32700）占比 < 0.5%；
* 和已经录好的句子相似度 ≥0.5（同一个人），否则要重录这一句。

录音由用户按按钮开始/结束（`auto_stop=False`），电平条只是显示。
没有窗口系统时（CI/无桌面）构造会抛 TkError，测试只跑纯函数部分。
"""

import array
import math
import threading
import time

RATE = 16000
MIN_VOICED_S = 2.0
CLIP_RATIO = 0.005
CLIP_LEVEL = 32700
MIN_PAIR_SIM = 0.5


# ────────────────────────────── 纯函数（好测，不依赖 Tk） ──────────────────────────────

def pcm_stats(pcm):
    """-> (秒数, rms, 削波占比)。空数据返回 (0, 0, 0)。"""
    a = array.array("h")
    a.frombytes(bytes(pcm)[: len(pcm) - (len(pcm) % 2)])
    if not a:
        return 0.0, 0.0, 0.0
    n = len(a)
    total = 0.0
    clipped = 0
    for v in a:
        total += float(v) * float(v)
        if v >= CLIP_LEVEL or v <= -CLIP_LEVEL:
            clipped += 1
    rms = math.sqrt(total / n)
    return n / float(RATE), rms, clipped / float(n)


def voiced_seconds(pcm, threshold=300.0, frame=1600):
    """按 100 ms 帧统计「有声」的秒数（比整段 RMS 更接近真实说话时长）。"""
    a = array.array("h")
    a.frombytes(bytes(pcm)[: len(pcm) - (len(pcm) % 2)])
    frames = len(a) // frame
    voiced = 0
    for i in range(frames):
        chunk = a[i * frame:(i + 1) * frame]
        s = sum(float(v) * v for v in chunk) / frame
        if math.sqrt(s) >= threshold:
            voiced += 1
    return voiced * frame / float(RATE)


def check_quality(pcm, min_voiced_s=MIN_VOICED_S):
    """-> (ok, message)。给窗口和测试共用。"""
    seconds, rms, clip = pcm_stats(pcm)
    if seconds <= 0:
        return False, "没录到声音"
    if clip >= CLIP_RATIO:
        return False, "声音太大了，有点爆，离麦克风远一点"
    if rms < 120.0:
        return False, "太轻了，凑近一点或者大声一点"
    voiced = voiced_seconds(pcm)
    if voiced < min_voiced_s:
        return False, "这一句只说了 %.1f 秒，多说一会儿（≥%.0f 秒）" % (voiced, min_voiced_s)
    return True, "ok"


# ────────────────────────────── 窗口 ──────────────────────────────

class EnrollWindow:
    """录入窗口。`root` 是桌宠的 Tk 根，所有 UI 操作都走 root.after 回到主线程。"""

    def __init__(self, root, data_dir, engine, sentences, max_people=5, names=None,
                 on_done=None, on_close=None, post=None, recorder_factory=None, test_only=False):
        self.root = root
        self.data_dir = data_dir
        self.engine = engine
        self.sentences = list(sentences or [])
        self.max_people = max_people
        self.on_done, self.on_close, self.post = on_done, on_close, post or (lambda fn: fn())
        self._names = names or (lambda: [])
        self._recorder_factory = recorder_factory
        self.test_only = test_only
        self.context = None
        self.busy = False
        self.test_history = []  # 本地窗口内最近十次分数，关闭即丢
        self.vecs = []
        self.index = 0
        self.rec = None
        self.level = 0.0
        self.closed = False
        self.result = None
        self._build()

    # -- UI ------------------------------------------------------------
    def _build(self):
        import tkinter as tk
        from tkinter import ttk
        self.tk = tk
        self.win = tk.Toplevel(self.root)
        self.win.title("试一下声纹" if self.test_only else "录入声纹")
        self.win.attributes("-topmost", True)
        self.win.resizable(False, False)
        self.win.protocol("WM_DELETE_WINDOW", self.close)
        pad = {"padx": 12, "pady": 6}

        tk.Label(self.win, text="只在这台电脑上保存；录音只用于本机识别。",
                 fg="#666", anchor="w").pack(fill="x", **pad)

        row = tk.Frame(self.win)
        row.pack(fill="x", **pad)
        tk.Label(row, text="名字").pack(side="left")
        self.name_var = tk.StringVar()
        self.name_entry = tk.Entry(row, textvariable=self.name_var, width=18)
        self.name_entry.pack(side="left", padx=8)
        if self.test_only:
            self.name_entry.configure(state="disabled")
        tk.Label(row, text="（最多 %d 人）" % self.max_people, fg="#666").pack(side="left")

        self.sentence_var = tk.StringVar(value=self._sentence_text())
        tk.Label(self.win, textvariable=self.sentence_var, wraplength=420, justify="left",
                 font=("Segoe UI", 12)).pack(fill="x", **pad)

        self.bar = tk.Canvas(self.win, height=14, bg="#eee", highlightthickness=0, width=420)
        self.bar.pack(fill="x", **pad)
        self._bar_fill = self.bar.create_rectangle(0, 0, 0, 14, fill="#4a9")

        self.progress = tk.StringVar(value="第 1 / %d 句" % len(self.sentences))
        tk.Label(self.win, textvariable=self.progress, anchor="w").pack(fill="x", **pad)

        self.msg = tk.StringVar(value="")
        tk.Label(self.win, textvariable=self.msg, fg="#a33", wraplength=420,
                 justify="left").pack(fill="x", **pad)

        btns = tk.Frame(self.win)
        btns.pack(fill="x", **pad)
        self.rec_btn = ttk.Button(btns, text="开始说这一句", command=self.toggle_record)
        self.rec_btn.pack(side="left")
        self.done_btn = ttk.Button(btns, text="完成", command=self.finish, state="disabled")
        self.done_btn.pack(side="right")
        ttk.Button(btns, text="取消", command=self.close).pack(side="right", padx=8)

        self.win.update_idletasks()
        self.win.geometry("+%d+%d" % (self.root.winfo_x() + 60, self.root.winfo_y() + 60))
        self._tick()

    def _sentence_text(self):
        if self.test_only:
            return "点按钮后说一句完整的话；结果只显示在这个窗口，不发给会话。"
        if self.index >= len(self.sentences):
            return "全部录完了，点「完成」。"
        return "请朗读：%s" % self.sentences[self.index]

    def _tick(self):
        if self.closed:
            return
        if self.rec is not None:
            self.level = getattr(self.rec, "level", 0.0) or 0.0
            if self.rec.should_stop():
                self.toggle_record()  # hard cap prevents an unattended unlimited recording
        frac = min(1.0, self.level / 6000.0)
        self.bar.coords(self._bar_fill, 0, 0, 420 * frac, 14)
        try:
            self.win.after(80, self._tick)
        except Exception:  # noqa: BLE001 - 窗口已销毁
            pass

    # -- 录音 ----------------------------------------------------------
    def _make_recorder(self):
        if self._recorder_factory is not None:
            return self._recorder_factory()
        from .voice.mic import Recorder
        return Recorder(self.data_dir, max_s=10.0)

    def toggle_record(self):
        """用户点按钮：开始 / 结束这一句（录音永远是用户手点的）。"""
        if self.busy or self.closed:
            return
        if self.rec is None:
            try:
                if not self.test_only and self.context is None:
                    self.context = self.engine.enrollment_context()
                self.rec = self._make_recorder()
                self.rec.start(auto_stop=False)
            except Exception as exc:  # noqa: BLE001
                self.rec = None
                self.msg.set("打不开麦克风：%s" % str(exc)[:100])
                return
            self.rec_btn.configure(text="说完了")
            self.msg.set("")
            return
        pcm = self.rec.stop()
        self.rec = None
        self.rec_btn.configure(text="再说这一句")
        self.busy = True
        self.rec_btn.configure(state="disabled")
        def work():
            try:
                self._accept(pcm)
            finally:
                self.busy = False
                self.post(lambda: not self.closed and self.rec_btn.configure(state="normal" if self.test_only or self.index < len(self.sentences) else "disabled"))
        threading.Thread(target=work, daemon=True).start()

    def _accept(self, pcm):
        if self.test_only:
            out = self.engine.test_embedding(pcm, RATE)
            self.test_history.append((out.get("ok") is True, out.get("sim")))
            self.test_history = self.test_history[-10:]
            text = "\n".join(("通过" if ok else "不通过") + (" · %.3f" % sim if isinstance(sim, (int, float)) and math.isfinite(sim) else "") for ok, sim in self.test_history)
            self.post(lambda: not self.closed and self.msg.set(text))
            return
        ok, why = check_quality(pcm)
        if not ok:
            self.post(lambda: not self.closed and self.msg.set(why))
            return
        try:
            vec = self.engine.embed(pcm, RATE)
        except Exception as exc:  # noqa: BLE001
            self.post(lambda: not self.closed and self.msg.set("这一段算不出声纹，请检查模型"))
            return
        if self.vecs:
            worst = None
            for v in self.vecs:
                c = self.engine_module_cos(vec, v)
                worst = c if worst is None else min(worst, c)
            if worst is not None and worst < MIN_PAIR_SIM:
                self.post(lambda: not self.closed and self.msg.set("这句和前面几句不太像同一个人（%.2f），再说一遍" % worst))
                return
        if self.closed:
            return
        self.vecs.append(vec)  # 不保留 PCM；此函数返回后丢掉该句音频引用
        self.index += 1
        def update():
            if self.closed:
                return
            self.msg.set("")
            self.sentence_var.set(self._sentence_text())
            self.progress.set("第 %d / %d 句" % (min(self.index + 1, len(self.sentences)), len(self.sentences)))
            if self.index >= len(self.sentences):
                self.done_btn.configure(state="normal")
                self.rec_btn.configure(state="disabled")
        self.post(update)

    @staticmethod
    def engine_module_cos(a, b):
        from .voice import sv
        return sv.cosine(a, b)

    # -- 收尾 ----------------------------------------------------------
    def finish(self):
        name = (self.name_var.get() or "").strip()
        if not name:
            self.msg.set("先填个名字")
            return
        if self.busy or len(self.vecs) != 5:
            self.msg.set("请完整录入五句")
            return
        if name not in self._names() and len(self._names()) >= self.max_people:
            self.msg.set("已经有 %d 个人了，先删一个" % self.max_people)
            return
        try:
            out = self.engine.enroll_vectors(name, self.vecs, context=self.context)
        except Exception as exc:  # noqa: BLE001
            out = {"ok": False, "message": "录入失败：%s" % type(exc).__name__}
        if not out.get("ok"):
            self.msg.set(out.get("message") or "录入失败")
            return  # 保留向量供保存失败后重试；音频早已丢弃
        self.vecs = []
        self.result = {"ok": True, "name": out.get("name", name), "n": out.get("n", 0)}
        self._emit(self.on_done, dict(self.result))
        self._destroy()

    def close(self):
        if self.closed:
            return
        if self.rec is not None:
            try:
                self.rec.cancel()
            except Exception:  # noqa: BLE001
                pass
            self.rec = None
        self.vecs = []
        self.test_history = []
        self._destroy()

    def _destroy(self):
        self.closed = True
        try:
            self.win.destroy()
        except Exception:  # noqa: BLE001
            pass
        self._emit(self.on_close)

    @staticmethod
    def _emit(fn, *args):
        if fn:
            try:
                fn(*args)
            except Exception:  # noqa: BLE001
                pass
