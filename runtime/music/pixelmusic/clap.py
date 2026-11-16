"""「听得更细」（可选组件，默认关）：LAION CLAP 听出情绪 / 风格 / 乐器。

边界：输出一律是「模型听着像」的猜测标签（每组取前 2 名、第一名概率 ≥ 0.35 才报），
不当成事实说，不推断歌词内容。组件没装 / 没开时调用方拿到的 heard 里没有 tags，不报错。

模型：laion/clap-htsat-unfused（Apache-2.0，614.5 MB，HF API 核实 2026-11-15；本机可直连 huggingface.co）。
- 标签文本端只在构建时跑一次 → <model_dir>/label_emb.npy（附模型 id 与标签表哈希；标签表改了就重算）。
- 运行时只加载音频端：优先 onnxruntime（model.onnx），没导出就用 torch + transformers（CPU）。
- 模型目录 <dataDir 同盘>: LOCALAPPDATA/pye-music/models/clap/（可用 CLAP_DIR 环境变量覆盖）。
  音频端 + 文本端 + 权重都只在构建时装；运行时内存里只驻留音频端。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from pathlib import Path
from typing import Any

import numpy as np

LABELS_FILE = Path(__file__).with_name("clap_labels.json")
# 2026-11-15 二轮核实：首选 laion/larger_clap_music（Apache-2.0）在 HF 转换版下文本塔近乎坍缩
# （不同文本余弦 ~0.999、文本-音频 ~0.004，logit_scale 0.027 也不对）→ 不可用。
# 改用 laion/clap-htsat-unfused（Apache-2.0，614.5 MB，同一套标签表）：实测文本-音频余弦有区分度
# （噪声→white noise 0.458、和弦→piano chord 0.19），logit_scale 2.93。
MODEL_ID = "laion/clap-htsat-unfused"
MODEL_SR = 48000          # CLAP 音频端输入采样率
SEGMENT_S = 10.0          # 每次喂 10 秒
SR = 48000

_lock = threading.Lock()


def _features_tensor(out):
    """transformers 4.x: get_*_features 直接返回张量；5.x: 返回 BaseModelOutputWithPooling，
    投影 + 归一化后的嵌入在 pooler_output 里（已核实 2026-11-15，transformers 5.23）。"""
    if hasattr(out, "pooler_output"):
        return out.pooler_output
    if isinstance(out, (tuple, list)):
        return out[0]
    return out


def resample_for_clap(y, rate: int) -> np.ndarray | None:
    """任意采样率 float32 音频 → 恰好的 10 秒 @48k（480000 点，不足补零、超出截断）。

    review 修复（2026-11-15）：回环设备可能是 44.1k，本地解码是 22.05k；原实现直接按 48k 切段，
    段长其实约 22 秒却当成 10 秒喂给模型。所有入口先过这里。"""
    if y is None:
        return None
    a = np.asarray(y, dtype=np.float32).reshape(-1)
    if a.size == 0:
        return None
    if rate and int(rate) != SR:
        try:
            import librosa  # 可选依赖：venv 里必有

            a = librosa.resample(a, orig_sr=int(rate), target_sr=SR).astype(np.float32)
        except Exception:
            # 线性插值兜底（不追求音质，只保证长度正确、别把时长算错）
            idx = np.linspace(0.0, float(a.size - 1), int(round(a.size * SR / float(rate))), dtype=float)
            a = np.interp(idx, np.arange(a.size, dtype=float), a).astype(np.float32)
    want = int(SEGMENT_S * SR)
    if a.size >= want:
        return a[:want]
    return np.pad(a, (0, want - a.size))


def model_dir() -> Path:
    root = os.environ.get("CLAP_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "pye-music", "models", "clap")
    return Path(root)


def labels() -> dict:
    try:
        j = json.loads(LABELS_FILE.read_text(encoding="utf-8"))
        return j if isinstance(j, dict) and isinstance(j.get("groups"), dict) else {}
    except Exception:
        return {}


def labels_hash(groups: dict | None = None) -> str:
    g = groups if groups is not None else labels().get("groups") or {}
    return hashlib.sha256(json.dumps(g, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


_MUSIC_GROUPS = ("mood", "genre", "inst")
_FILE_GROUPS = (*_MUSIC_GROUPS, "kind")


def _groups_for_hash(groups, digest):
    if digest == labels_hash(groups):
        return _FILE_GROUPS
    # Keep existing installations working for realtime music. The extra group is computed on the file-analysis thread.
    legacy = {g: groups[g] for g in _MUSIC_GROUPS if g in groups}
    return _MUSIC_GROUPS if digest == labels_hash(legacy) else ()


def _group_names(groups: dict) -> dict:
    """group -> (zh 列表, en 提示句列表)"""
    out = {}
    for g, items in groups.items():
        out[g] = ([str(x.get("zh") or "").strip() for x in items],
                  [str(x.get("en") or "").strip() for x in items])
    return out


# ---------------------------------------------------------------- 状态 / 构建产物
def status(mdir: Path | None = None, enabled: bool = False) -> dict:
    d = Path(mdir) if mdir else model_dir()
    emb = d / "label_emb.npy"
    meta = {}
    try:
        meta = json.loads((d / "labels_meta.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    hf = d / "hf"
    has_weights = bool(hf.exists() and any(hf.iterdir())) if hf.exists() else False
    onnx = (d / "audio.onnx").is_file()
    hash_ok = bool(meta and meta.get("model_id") == MODEL_ID and _groups_for_hash(labels().get("groups") or {}, meta.get("labels_hash")))
    ready = emb.is_file() and hash_ok and (onnx or has_weights)
    return {
        "model_id": MODEL_ID,
        "dir": str(d),
        "enabled": enabled,
        "state": "ready" if ready else "not_installed",
        "backend": "torch" if ready else "",
        "onnx": onnx,
        "labels_hash_ok": hash_ok if bool(meta) else None,
        "emb_bytes": emb.stat().st_size if emb.is_file() else 0,
        "weights_bytes": sum(f.stat().st_size for f in hf.iterdir() if f.is_file()) if has_weights else 0,
        "disk_mb": round(((emb.stat().st_size if emb.is_file() else 0) +
                          (sum(f.stat().st_size for f in hf.iterdir() if f.is_file()) if has_weights else 0)) / 1e6, 1),
    }


class Tagger:
    """懒加载音频端 + 标签向量。线程安全（加载一次）。classify() 给 10 秒 float32 @SR。"""

    def __init__(self, mdir: Path | None = None) -> None:
        # 参数别叫 model_dir：会盖住同名模块函数，不传参时 None() → TypeError
        self.dir = Path(mdir) if mdir else model_dir()
        self._ready = False
        self._error = ""
        self._emb = None          # (n_labels, 512)
        self._zh = []             # 展开后的标签顺序（与 emb 行一一对应）
        self._group_of = []       # 每行属于哪一组
        self._group_sizes: dict[str, int] = {}
        self._backend = ""        # 'onnx' | 'torch'
        self._sess = None
        self._model = None
        self._proc = None         # transformers ClapProcessor
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        with _lock:
            if self._ready:
                return True
        return self._load()

    def _load(self) -> bool:
        with _lock:
            if self._ready:
                return True
            d = self.dir
            emb_f = d / "label_emb.npy"
            meta_f = d / "labels_meta.json"
            if not emb_f.is_file():
                self._error = "标签向量还没构建"
                return False
            try:
                meta = json.loads(meta_f.read_text(encoding="utf-8"))
                groups = labels().get("groups") or {}
                order = _groups_for_hash(groups, meta.get("labels_hash"))
                if not order or meta.get("model_id") != MODEL_ID:
                    self._error = "标签表或模型变了，需要重建"
                    return False
                names = _group_names(groups)
                emb = np.load(emb_f)
                zh: list[str] = []
                group_of: list[str] = []
                sizes: dict[str, int] = {}
                rows: list[int] = []
                i = 0
                for g in order:
                    if g not in names or g not in meta.get("groups", {}):
                        raise ValueError("标签表组不全")
                    zs, _ens = names[g]
                    if len(zs) != int(meta["groups"][g]):
                        raise ValueError("标签数对不上，需要重建")
                    sizes[g] = len(zs)
                    for z in zs:
                        zh.append(z)
                        group_of.append(g)
                        rows.append(i)
                        i += 1
                emb = np.asarray(emb)
                if emb.ndim != 2 or emb.shape[0] != len(zh):
                    raise ValueError("标签向量形状不对")
                self._emb = emb / np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-9)
                self._zh = zh
                self._group_of = group_of
                self._group_sizes = sizes
                self._rows = rows
                # 只走 torch CPU：CLAP 的 input_features 是梅尔特征（不是原始音频），
                # 原先那条 onnx 分支把音频直接喂给 input_features，结果不可信，已删除（review 修复 5）。
                from transformers import ClapModel, ClapProcessor  # type: ignore

                hf = d / "hf"
                self._model = ClapModel.from_pretrained(str(hf), local_files_only=True)
                self._proc = ClapProcessor.from_pretrained(str(hf), local_files_only=True)
                self._model.eval()
                self._backend = "torch"
                self._ready = True
                self._error = ""
                return True
            except Exception as exc:
                self._error = type(exc).__name__ + (": " + str(exc)[:120])
                return False

    def error(self) -> str:
        return self._error

    def backend(self) -> str:
        return self._backend

    # ---------------- 推理 ----------------
    def _audio_embed(self, y: np.ndarray) -> np.ndarray:
        """10 秒 float32 @48k → 归一化嵌入。CPU、单线程。调用方负责重采样（resample_for_clap）。"""
        y = resample_for_clap(y, SR)
        if y is None:
            raise ValueError("空音频")
        import torch  # type: ignore

        # 传一维数组：transformers 5 把二维当成「N 个单点样本」，会 tile 出 1.68 TiB（实测 2026-11-15）
        inputs = self._proc(audio=y, sampling_rate=SR, return_tensors="pt")
        with torch.no_grad():
            feats = self._model.get_audio_features(**inputs)
        out = _features_tensor(feats).reshape(-1).cpu().numpy()
        return out / max(1e-9, float(np.linalg.norm(out)))

    def _extend_file_labels(self):
        if "kind" in self._group_sizes:
            return
        zh, en = _group_names(labels()["groups"])["kind"]
        emb = _text_vectors(self._model, self._proc, en)
        self._emb = np.concatenate((self._emb, emb), axis=0)
        self._zh.extend(zh)
        self._group_of.extend(["kind"] * len(zh))
        self._group_sizes["kind"] = len(zh)

    def tag(self, y: np.ndarray, *, include_kind: bool = False) -> dict[str, list[tuple[str, float]]]:
        """一段音频（≈10 秒）→ 每组 [(中文标签, softmax 概率)] 全量按概率降序（累计要完整向量）。"""
        if not self.ready:
            return {}
        with _lock:
            if include_kind:
                self._extend_file_labels()
            emb = self._audio_embed(np.asarray(y, dtype=np.float32))
            scores = self._emb @ emb
            group_of = self._group_of.copy()
            zh = self._zh.copy()
        out: dict[str, list[tuple[str, float]]] = {}
        for g in (_FILE_GROUPS if include_kind else _MUSIC_GROUPS):
            idxs = [i for i, gname in enumerate(group_of) if gname == g]
            if not idxs:
                continue
            # 温度 16（2026-11-15 实测校准）：CLAP 余弦多在 0.1–0.5，×4/×8 时第一名概率只有 0.15–0.25，
            # 0.35 门槛永远不达标；×16 时「较明确」的组 top1 ≈0.36–0.47，模棱两可的组仍 <0.35 不报。
            gscore = np.asarray([scores[i] * 16.0 for i in idxs])
            e = np.exp(gscore - gscore.max())
            probs = e / e.sum()
            order = np.argsort(-probs)
            out[g] = [(zh[idxs[i]], round(float(probs[i]), 3)) for i in order]
        return out


def _text_vectors(model, processor, prompts):
    import torch  # type: ignore

    inputs = processor(text=prompts, return_tensors="pt", padding=True)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
    emb = _features_tensor(feats).detach().cpu().numpy()
    return emb / np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-9)


def build_label_emb(mdir: Path | None = None, force: bool = False) -> dict:
    """构建标签文本向量（安装时跑一次）。-> {ok, backend?, message}"""
    d = Path(mdir) if mdir else model_dir()
    emb_f = d / "label_emb.npy"
    meta_f = d / "labels_meta.json"
    if not force and emb_f.is_file():
        try:
            meta = json.loads(meta_f.read_text(encoding="utf-8"))
            if meta.get("labels_hash") == labels_hash() and meta.get("model_id") == MODEL_ID:
                return {"ok": True, "cached": True}
        except Exception:
            pass
    groups = labels().get("groups") or {}
    names = _group_names(groups)
    if not names.get("mood"):
        return {"ok": False, "message": "标签表为空"}
    from transformers import ClapModel, ClapProcessor  # type: ignore

    hf = d / "hf"
    model = ClapModel.from_pretrained(str(hf), local_files_only=True)
    proc = ClapProcessor.from_pretrained(str(hf), local_files_only=True)
    model.eval()
    rows: list[np.ndarray] = []
    meta_groups: dict[str, int] = {}
    for g in _FILE_GROUPS:
        zs, ens = names[g]
        rows.append(_text_vectors(model, proc, ens))
        meta_groups[g] = len(zs)
    all_emb = np.concatenate(rows, axis=0).astype(np.float32)
    d.mkdir(parents=True, exist_ok=True)
    np.save(str(emb_f), all_emb)
    (d / "labels_meta.json").write_text(json.dumps({
        "model_id": MODEL_ID, "labels_hash": labels_hash(), "groups": meta_groups,
    }, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "cached": False, "labels": int(all_emb.shape[0])}


# ---------------- 纯数学：累计 + 汇总（可独立测试） ----------------
def softmax_top(scores: list[float], top: int = 2) -> list[tuple[int, float]]:
    a = np.asarray([s * 4.0 for s in scores], dtype=float)
    e = np.exp(a - a.max())
    p = e / e.sum()
    order = np.argsort(-p)
    return [(int(i), round(float(p[i]), 3)) for i in order[:top]]


def accumulate(acc: dict, tag: dict[str, list[tuple[str, float]]], *, alpha: float = 0.3) -> dict:
    """按歌累计：每组对完整 softmax 向量做指数平均（按标签名对位，新样本权重 alpha）。切歌时 acc.clear()。"""
    for g, pairs in (tag or {}).items():
        if not pairs:
            continue
        gacc = acc.setdefault(g, {"ema": {}, "count": 0})
        ema = gacc["ema"]
        for zh, prob in pairs:
            ema[zh] = round(ema.get(zh, 0.0) * (1 - alpha) + float(prob) * alpha, 4)
        gacc["count"] += 1
    return acc


def summarize(acc: dict, *, min_count: int = 3, min_top: float = 0.35, include_kind: bool = False) -> dict | None:
    """每组只报前 2 名且第一名概率 ≥ 0.35；累计不足 3 次不报这组。全不达标 → None。"""
    out: dict[str, list] = {}
    for g, gacc in (acc or {}).items():
        if (g == "kind" and not include_kind) or gacc.get("count", 0) < min_count:
            continue
        ema = gacc.get("ema") or {}
        if not ema:
            continue
        total = float(sum(ema.values())) or 1.0
        ranked = sorted(ema.items(), key=lambda kv: -kv[1])[:2]
        top1 = float(ranked[0][1]) / total
        if top1 < min_top:
            continue
        out[g] = [[zh, round(p / total, 3)] for zh, p in ranked]
    return out if out else None


def tag_file(path, tagger: "Tagger", chunk_s: float = 10.0, *, include_kind: bool = False) -> dict | None:
    """本地文件：整曲每 chunk_s 秒跑一遍音频端 → 汇总标签（进 analysis/*.json 缓存，只存标签和分数）。"""
    try:
        from . import songmap
    except Exception:
        return None
    try:
        y = songmap.decode(Path(path))  # 22.05k 单声道
    except Exception:
        return None
    # review 修复 3：原实现按 48k 切 22.05k 的数据 → 每段约 22 秒却被当成 10 秒。
    # 先整曲重采样到 48k，再按 10 秒切。
    try:
        y = resample_all(y, songmap.SR)
    except Exception:
        return None
    per = int(chunk_s * SR)
    if y.size < per * 0.9:
        return None
    acc: dict = {}
    n = 0
    for i in range(0, y.size - per // 2, per):
        c = y[i:i + per]
        if c.size < per * 0.9:
            continue
        tag = tagger.tag(c, include_kind=True) if include_kind else tagger.tag(c)
        if tag:
            accumulate(acc, tag, alpha=0.5)
            n += 1
    min_count = 1 if include_kind else 3
    if n < min_count:
        return None
    return summarize(acc, min_count=min_count, include_kind=include_kind)


def resample_all(y: np.ndarray, rate: int) -> np.ndarray:
    """整曲任意采样率 → 48k（长度保留，不补不截）。"""
    a = np.asarray(y, dtype=np.float32).reshape(-1)
    if not rate or int(rate) == SR or a.size == 0:
        return a
    try:
        import librosa  # type: ignore

        return librosa.resample(a, orig_sr=int(rate), target_sr=SR).astype(np.float32)
    except Exception:
        idx = np.linspace(0.0, float(a.size - 1), int(round(a.size * SR / float(rate))), dtype=float)
        return np.interp(idx, np.arange(a.size, dtype=float), a).astype(np.float32)


def tags_sentence(tags: dict | None, *, include_kind: bool = False) -> str:
    """tags → 一短句；没有就空串。口径写死「模型听着像」。"""
    if not tags:
        return ""
    parts: list[str] = []
    for g in (_FILE_GROUPS if include_kind else _MUSIC_GROUPS):
        pairs = tags.get(g) or []
        if pairs:
            parts.append("、".join(str(p[0]) for p in pairs))
    return "；模型听着像：" + "，".join(parts) if parts else ""


def with_tags(sentence: str, tags: dict | None, *, include_kind: bool = False) -> str:
    """把标签短句插到句号之前（review 修复 7：原先直接拼在后面，出现「）。；…。」）。
    -> 「…（系统回环实时测得…）；模型听着像：伤感、民谣，吉他和女声。」"""
    clause = tags_sentence(tags, include_kind=include_kind)
    if not clause:
        return sentence
    base = sentence.rstrip()
    if base.endswith("。"):
        return base[:-1] + clause + "。"
    return base + clause + "。"
