# -*- coding: utf-8 -*-
"""Lazy local-only SV facade. No audio/vector HTTP route and no agent enrollment tool.

Attach this facade itself to VoiceBridge.sv, NOT verifier()'s current engine: configuration
changes must affect the next utterance. Disabled path imports no numpy/ORT and accesses no
voiceprint files. Settings read failures are sticky fail-closed. Only the dedicated local,
authenticated settings endpoint may invoke command(); status tools use summary() only.
"""
import glob
import math
import os
import threading

SETTINGS_KEY = "voiceprint"
DEFAULT = {"enabled": False, "mode": "disk", "strictness": 0.5}
MAX_PEOPLE = 5
ENROLL_SENTENCES = (
    "今天天气不错，我想在窗边坐一会儿。",
    "桌宠听得见我说话，它才愿意回应。",
    "这个开关默认关着，打开之后要先录入声音。",
    "我说话的声音，请只在这台电脑上保存。",
    "最后一句，用平时的音量和语速就好。",
)


def sanitize(value):
    """Whitelist for valid saved settings; malformed input raises, never silently disables."""
    if value is None:
        return dict(DEFAULT)
    if not isinstance(value, dict):
        raise ValueError("voiceprint settings must be a dict")
    enabled = value.get("enabled", False)
    mode = value.get("mode", "disk")
    s = float(value.get("strictness", 0.5))
    if not isinstance(enabled, bool) or mode not in ("memory", "disk") or not math.isfinite(s):
        raise ValueError("invalid voiceprint settings")
    return {"enabled": enabled, "mode": mode, "strictness": max(0.0, min(1.0, s))}


def find_model(data_dir, deps=None, env_var="PIXELPET_SPEAKER_MODEL"):
    """Public model only; never search voiceprint/voices/recordings directories."""
    cands = []
    raw = os.environ.get(env_var)
    if raw:
        cands.append(raw)
    if deps is not None:
        try:
            cands.extend(sorted(glob.glob(os.path.join(deps.path("speaker-model"), "*.onnx"))))
        except Exception:
            pass
    cands.extend(sorted(glob.glob(os.path.join(data_dir, "models", "speaker-model", "*.onnx"))))
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


def voice_digest(tts=None, voice=None):
    """No clone/reference/anchor access. Negative-template generation is deliberately deferred.

    Unknown digest -> echoReady=False. A future preset-only adapter must hash the authorized
    public preset itself and regenerate on change; an id/mtime alone is not a content digest.
    """
    return None


class VoicePrintHost:
    def __init__(self, pet, deps=None):
        self.pet, self.deps = pet, deps
        self._engine = None
        self._lock = threading.RLock()
        self._window = None
        self._resume_listening = False
        self._cfg_good = None
        self._mode_invalidated = False
        self._last = None

    @property
    def settings(self):
        try:
            cfg = self.pet.cfg
            if not isinstance(cfg, dict):
                raise ValueError("settings unavailable")
            if cfg.get('_voiceprintConfigError') or (SETTINGS_KEY not in cfg and self._cfg_good and self._cfg_good['enabled']):
                raise ValueError('voiceprint configuration lost')
            out = sanitize(cfg.get(SETTINGS_KEY))
            if self._cfg_good is not None and self._cfg_good['mode'] != out['mode']:
                self._mode_invalidated = True
            self._cfg_good = dict(out)
            return out
        except Exception:
            out = dict(self._cfg_good or DEFAULT)
            out.update(enabled=True, error="config-error")
            return out

    @property
    def enabled(self):
        return self.settings["enabled"]

    def engine(self, create=True):
        with self._lock:
            if self._engine is None and create:
                from .voice import sv  # disabled path never imports heavy modules
                self._engine = sv.VoicePrint(
                    self.pet.data_dir, settings_getter=lambda: self.settings,
                    model_path=find_model(self.pet.data_dir, self.deps),
                    voice_digest_getter=lambda: None)
            elif self._engine is not None and create:
                # Installing a public model after enabling is supported without a pet restart.
                model = find_model(self.pet.data_dir, self.deps)
                if model != self._engine.model_path:
                    self._engine.close()
                    self._engine.model_path = model
            if create and self._engine is not None and self._mode_invalidated:
                self._engine._needs_reenroll = True
                self._engine._loaded = False
                self._mode_invalidated = False
            return self._engine

    def verifier(self):
        return self  # keep facade attached even while disabled, for dynamic settings/fail-closed

    def verify(self, pcm, rate=16000, mode="strict"):
        cfg = self.settings
        if cfg.get("error"):
            self._last = "reject"
            return {"ok": False, "reason": "config-error"}
        if not cfg["enabled"]:
            self.close()
            return {"ok": True, "reason": "disabled"}
        try:
            out = self.engine().verify(pcm, rate, mode)
            self._last = "pass" if out.get("ok") is True else "reject"
            return {"ok": out.get("ok") is True, "reason": out.get("reason", "model-error")}
        except Exception:
            self._last = "reject"
            return {"ok": False, "reason": "model-error"}

    def warm(self):
        cfg = self.settings
        return bool(cfg["enabled"] and not cfg.get("error") and self.engine().warm())

    def close(self):
        with self._lock:
            eng, self._engine = self._engine, None
        if eng is not None:
            if eng._needs_reenroll:
                self._mode_invalidated = True
            eng.close()

    def summary(self):
        cfg = self.settings
        eng = self.engine(create=False)
        n = eng.summary()["enrolled"] if cfg["enabled"] and eng is not None else 0
        return {"enabled": cfg["enabled"], "enrolled": n, "last": self._last}

    def status(self):
        cfg = self.settings
        if not cfg["enabled"] or cfg.get("error"):
            return {"enabled": cfg["enabled"], "mode": cfg["mode"], "enrolled": 0,
                    "ready": False, "reason": cfg.get("error", "disabled"),
                    "encrypted": os.name == "nt", "memory": cfg["mode"] == "memory",
                    "echoReady": False, "echo": "missing", "last": self._last,
                    "strictness": cfg["strictness"]}
        st = self.engine().status()
        st.update(strictness=cfg["strictness"], echoReady=False, echo="missing")
        return st

    def people(self):
        cfg = self.settings
        if not cfg["enabled"] or cfg.get("error"):
            return []
        return [{"name": p["name"], "n": p["n"]} for p in self.engine().people()]

    def open_enroll_window(self, test_only=False):
        cfg = self.settings
        if not cfg["enabled"] or cfg.get("error"):
            return False, "先检查声纹设置并打开开关"
        if self._window is not None:
            return True, "声纹窗口已经开着"
        if getattr(getattr(self.pet, 'mic', None), 'active', False):
            return False, "请先结束当前录音，再打开声纹窗口"
        from .voiceprint_window import EnrollWindow
        self._resume_listening = getattr(self.pet, 'listener', None) is not None
        if self._resume_listening:
            self.pet.set_listening(False)  # avoid two recorders competing; no recording starts here
        try:
            self._window = EnrollWindow(
                root=self.pet.root, data_dir=self.pet.data_dir, engine=self.engine(),
                sentences=ENROLL_SENTENCES, max_people=MAX_PEOPLE,
                names=lambda: [p["name"] for p in self.people()],
                on_done=self._enrolled, on_close=self._window_closed,
                post=self.pet.post_ui, test_only=test_only)
        except Exception:
            self._window_closed()
            return False, "本地声纹窗口打不开，请检查桌面和语音依赖"
        return True, "本地窗口打开了，录音还没开始"

    def _enrolled(self, result):
        self.pet.bubble.show("录好了" if result.get("ok") else "录入失败", 4)

    def _window_closed(self):
        self._window = None
        resume, self._resume_listening = self._resume_listening, False
        if resume and self.enabled and not getattr(self.pet, '_closed', False):
            self.pet.set_listening(True)

    def delete(self, name=None, all_people=False):
        cfg = self.settings
        if not cfg["enabled"] or cfg.get("error"):
            return {"ok": False, "message": "声纹设置不可用或未打开"}
        eng = self.engine()
        return eng.clear() if all_people else eng.remove(name)

    def rebuild_self_template(self):
        # Never synthesize arbitrary selected/cloned voices. Honest missing state is safer.
        return {"ok": False, "message": "预设音色回声负模板尚未实现；现有转写回声检测仍保留"}

    def command(self, body):
        """Dedicated settings UI only. Must not be exposed through an agent send-command tool."""
        action = str((body or {}).get("action") or "status")
        if action == "status":
            return True, "ok", None, self.status()
        if action == "people":
            return True, "ok", None, {"people": self.people(), "max": MAX_PEOPLE}
        if action in ("enroll", "test"):
            ok, msg = self.open_enroll_window(test_only=action == "test")
            return ok, msg, None, {"opened": ok}
        if action in ("delete", "clear"):
            out = self.delete((body or {}).get("name"),
                              all_people=action == "clear" or (body or {}).get("all") is True)
            return out.get("ok") is True, out.get("message", "ok"), None, {"ok": out.get("ok") is True}
        if action == "self":
            return False, self.rebuild_self_template()["message"], None
        return False, "不支持的声纹操作", None


def wav_to_pcm(data):
    """Reserved for a future explicitly authorized public-preset adapter; never user audio."""
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getcomptype()) != (16000, 1, 2, "NONE"):
                return None
            return w.readframes(w.getnframes())
    except Exception:
        return None
