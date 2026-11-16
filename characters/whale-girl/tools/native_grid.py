"""原生格子取色：把 Codex / GPT 出的像素风原图按它自身的像素格子逐格取色，一格对一像素。

    python native_grid.py                         # 批量跑 source/codex/*.png，结果写 <repo>/.tmp/native/ 预览
    python native_grid.py source/reference.png    # 单张试跑（文件名不是 <状态>_NN.png 时只出帧和对比图）
    python native_grid.py --apply                 # 确认无误后写进 sprites/ 和 character.json（先自动备份）

不缩放、不减色、不重画，只做清理：
  1. 格子检测：分别沿 x / y 求边缘强度剖面 → 傅里叶梳估计周期（可非整数）和相位
     → 动态规划逐条找边界（允许局部 ±30% 伸缩，对「近似但不完全整齐」的格子稳健）。
  2. 取色：每格中心 k×k 采样点，取「容差内邻居最多」的那一簇的中位色（众数思路，不取平均）。
  3. 去背景：透明 / #00FF00 绿底 / 边框上占多数的浅色底，只从画布边缘做 4 连通洪水填充，
     角色内部的白色（围裙、头饰）不会被挖掉。
  4. 去杂点：脱离主体的 ≤3 格小块；四邻一致时与之仅差一点点的单格噪色；被四邻包住的单格透明洞。
  5. 装进 192x208 画布（logicalScale=1）：同一状态按第 0 帧的脚底与水平中心对齐，
     其余帧按原图坐标换算位置（原图里跳起来的帧仍然是跳起来的），播放时不跳。超出画布直接报错，不缩小。

结果完全确定（无随机），重复运行逐字节一致。
"""
import argparse
import json
import os
import re
import shutil
import sys
from collections import deque

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PACK))
CODEX_DIR = os.path.join(HERE, "source", "codex")
DEFAULT_OUT = os.path.join(ROOT, ".tmp", "native")

CANVAS = (192, 208)
FOOT_Y = 204                 # 脚底所在行的下一行（脚底像素落在第 203 行，与 demo-cat 相近）
CENTER_X = 96
PERIOD_RANGE = (3.0, 24.0)
LAM_GAP = 0.10               # 边界间距偏离周期的惩罚
LAM_LAT = 0.02               # 边界偏离全局格点的惩罚（防止空白区漂移）
COLOR_TOL = 20               # 取色「同一簇」的通道最大差
BG_TOL = 24                  # 浅色底容差
GREEN = np.array([0, 255, 0])
SPECK_MAX = 3                # 脱离主体、≤ 这么多格的小块视为杂点
NOISE_SPREAD, NOISE_DELTA = 8, 16
WARN_PERIOD_DEV = 0.03       # 同批周期偏离中位数超过 3% 就警告

DEMO_CAT = os.path.join(ROOT, "characters", "demo-cat")
DEFAULT_SIZE = 0.65          # 设置里的默认 size（runtime/pixelpet/app.py DEFAULT_SETTINGS）

FPS = {"idle": 4, "walk-left": 8, "walk-right": 8, "waving": 8, "jumping": 8, "failed": 3, "waiting": 4,
       "running": 6, "review": 6, "lie": 2, "listening": 6, "attentive": 2, "curl-sleep": 2}
NO_LOOP = {"jumping", "review"}
NAME_RE = re.compile(r"^([a-z0-9][a-z0-9-]*)_(\d{2})\.png$")


class NativeGridError(Exception):
    pass


# --------------------------------------------------------------------------- 格子检测
def load_rgba(path):
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA")).astype(np.int16)


def edge_profile(img, axis):
    """长度 N+1：E[x] = 第 x-1 与第 x 个像素（沿 axis）之间的边缘强度。axis=1 找列边界，0 找行边界。"""
    if axis == 0:
        img = img.transpose(1, 0, 2)
    rgb, al = img[..., :3], img[..., 3]
    d = np.abs(np.diff(rgb, axis=1)).max(-1)
    d = np.maximum(d, np.abs(np.diff(al, axis=1)))
    d = np.clip(d - 6, 0, 80).astype(np.float64)
    vis = al >= 128
    valid = vis[:, 1:] | vis[:, :-1]
    e = np.zeros(img.shape[1] + 1)
    e[1:-1] = (d * valid).sum(0)
    return e


def estimate_period(e, pmin=PERIOD_RANGE[0], pmax=PERIOD_RANGE[1], step=0.005):
    """傅里叶梳：返回 (周期, 相位, 置信度)。周期的 1/2、1/3 也会同样相干，取得分接近最高的最大周期。"""
    total = e.sum()
    if total <= 0:
        raise NativeGridError("图里没有任何边缘，找不到格子")
    x = np.arange(len(e))
    ps = np.arange(pmin, pmax, step)
    s = np.concatenate([np.exp(-2j * np.pi * np.outer(1.0 / c, x)) @ e for c in np.array_split(ps, 16)])
    score = np.abs(s) / total
    best = score.max()
    peaks = [i for i in range(1, len(ps) - 1) if score[i] >= score[i - 1] and score[i] >= score[i + 1]
             and score[i] >= 0.8 * best]
    i = max(peaks) if peaks else int(score.argmax())
    p = ps[i]
    if 0 < i < len(ps) - 1:                                   # 抛物线细化
        a, b, c = score[i - 1], score[i], score[i + 1]
        den = a - 2 * b + c
        if den < 0:
            p += step * 0.5 * (a - c) / den
    sp = np.exp(-2j * np.pi * x / p) @ e
    phase = (-np.angle(sp) / (2 * np.pi) * p) % p
    return float(p), float(phase), float(np.abs(sp) / total)


def fit_boundaries(e, p, phase):
    """动态规划：在全局格点附近逐条选边界，最大化 Σ边缘强度 − 间距偏差 − 偏离格点。返回升序整数边界。"""
    n = len(e) - 1
    pos = e[e > 0]
    en = np.minimum(e / (np.percentile(pos, 90) if len(pos) else 1.0), 2.0)
    xs = np.arange(n + 1)
    dev = ((xs - phase + p / 2) % p) - p / 2
    node = en - LAM_LAT * dev ** 2
    gmin, gmax = max(2, int(np.floor(p * 0.7))), int(np.ceil(p * 1.3))
    gaps = np.arange(gmin, gmax + 1)
    gap_cost = LAM_GAP * (gaps - p) ** 2
    f = np.full(n + 1, -np.inf)
    back = np.full(n + 1, -1)
    for x in range(n + 1):
        if x < gmax:
            f[x] = node[x]
        prev = x - gaps
        ok = prev >= 0
        if ok.any():
            cand = f[prev[ok]] - gap_cost[ok]
            j = int(cand.argmax())
            if cand[j] + node[x] > f[x]:
                f[x] = cand[j] + node[x]
                back[x] = prev[ok][j]
    tail = np.arange(max(0, n - gmax + 1), n + 1)
    x = int(tail[f[tail].argmax()])
    out = []
    while x >= 0:
        out.append(x)
        x = back[x]
    b = out[::-1]
    if b[0] >= 0.5 * p:                                       # 画布边缘不足一格但过半的也收进来
        b.insert(0, 0)
    if n - b[-1] >= 0.5 * p:
        b.append(n)
    return np.array(b)


def detect_grid(img):
    """→ dict(xb, yb, px, py, ox, oy, conf_x, conf_y)。x / y 分别独立检测。"""
    out = {}
    for axis, k in ((1, "x"), (0, "y")):
        e = edge_profile(img, axis)
        p, ph, conf = estimate_period(e)
        out[k + "b"] = fit_boundaries(e, p, ph)
        out["p" + k], out["o" + k], out["conf_" + k] = p, ph, conf
    return out


# --------------------------------------------------------------------------- 取色
def sample_cells(img, xb, yb, k):
    """每格中心 k×k 个采样点 → (ny, nx, 4) uint8。颜色取容差内最大簇的中位色，alpha 取中位数。"""
    h, w = img.shape[:2]

    def idx(b, lim):
        c = (b[:-1] + b[1:]) / 2.0
        i = np.floor(c - k / 2.0).astype(int)[:, None] + np.arange(k)[None, :]
        lo, hi = b[:-1, None], b[1:, None] - 1                # 不越出本格
        return np.clip(np.clip(i, lo, np.maximum(lo, hi)), 0, lim - 1)

    yi, xi = idx(yb, h), idx(xb, w)
    s = img[yi[:, None, :, None], xi[None, :, None, :]]       # ny, nx, k, k, 4
    ny, nx = s.shape[:2]
    s = s.reshape(ny, nx, k * k, 4)
    rgb, al = s[..., :3], s[..., 3]
    vis = al >= 128
    d = np.abs(rgb[:, :, :, None, :] - rgb[:, :, None, :, :]).max(-1)
    close = (d <= COLOR_TOL) & vis[:, :, :, None] & vis[:, :, None, :]
    best = close.sum(-1).argmax(-1)                           # 平局取第一个，结果确定
    members = np.take_along_axis(close, best[:, :, None, None], 2)[:, :, 0, :]
    vals = np.where(members[..., None], rgb, np.nan)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            col = np.nanmedian(vals, axis=2)
    col = np.nan_to_num(col)
    alpha = np.median(al, axis=2)
    out = np.zeros((ny, nx, 4), np.uint8)
    opaque = alpha >= 128
    out[..., :3] = np.where(opaque[..., None], np.clip(np.round(col), 0, 255), 0)
    out[..., 3] = np.where(opaque, 255, 0)
    return out


# --------------------------------------------------------------------------- 清理
def _flood(cand, seeds):
    """4 连通洪水填充：从 seeds 出发，只走 cand 为真的格。"""
    h, w = cand.shape
    hit = np.zeros_like(cand)
    q = deque()
    for y, x in zip(*np.nonzero(seeds & cand)):
        hit[y, x] = True
        q.append((y, x))
    while q:
        y, x = q.popleft()
        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= yy < h and 0 <= xx < w and cand[yy, xx] and not hit[yy, xx]:
                hit[yy, xx] = True
                q.append((yy, xx))
    return hit


def _components(mask):
    """8 连通分量 → [(size, [(y, x)...])]。"""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    comps = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        seen[y0, x0] = True
        q, cells = deque([(y0, x0)]), []
        while q:
            y, x = q.popleft()
            cells.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        q.append((yy, xx))
        comps.append((len(cells), cells))
    return comps


def remove_background(cells):
    """只去掉与画布边缘连通的背景。→ (cells, 统计)"""
    c = cells.copy()
    rgb, opaque = c[..., :3].astype(int), c[..., 3] >= 128
    border = np.zeros(opaque.shape, bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    green = opaque & (np.abs(rgb - GREEN).max(-1) <= 90) & (rgb[..., 1] >= rgb[..., [0, 2]].max(-1) + 80)
    cand = ~opaque | green
    mode, bg = "transparent", None
    if green[border].mean() > 0.25:
        mode = "green"
    else:
        rest = opaque & ~green & border
        if rest[border].mean() > 0.25:
            vals = rgb[rest]
            keys = [tuple(v) for v in (vals // 8)]
            top = max(set(keys), key=lambda kk: (keys.count(kk), kk))
            bg = np.median(vals[[kk == top for kk in keys]], axis=0)
            cand |= opaque & (np.abs(rgb - bg).max(-1) <= BG_TOL)
            mode = "light #%02X%02X%02X" % tuple(int(v) for v in bg)
    hit = _flood(cand, border)
    removed = int((hit & opaque).sum())
    if mode == "green":                                       # 绿边溢色：紧贴已去背景的偏绿格再剥两层
        for _ in range(2):
            near = np.zeros_like(hit)
            near[1:] |= hit[:-1]; near[:-1] |= hit[1:]; near[:, 1:] |= hit[:, :-1]; near[:, :-1] |= hit[:, 1:]
            spill = near & ~hit & opaque & (rgb[..., 1] > rgb[..., [0, 2]].max(-1) + 40)
            hit |= spill
            removed += int(spill.sum())
    c[hit] = 0
    return c, {"bg": mode, "bgCells": removed}


def clean_specks(cells):
    """去掉脱离主体的小块、四邻一致时的单格噪色、被包住的单格透明洞。→ (cells, 统计)"""
    c = cells.copy()
    opaque = c[..., 3] >= 128
    comps = _components(opaque)
    specks = 0
    if comps:
        biggest = max(s for s, _ in comps)
        for size, pts in comps:
            if size <= SPECK_MAX and size < biggest:
                for y, x in pts:
                    c[y, x] = 0
                specks += 1
    h, w = c.shape[:2]
    rgb = c[..., :3].astype(int)
    opaque = c[..., 3] >= 128
    noise = holes = 0
    src = c.copy()
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            nb = [(y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)]
            if not all(opaque[p] for p in nb):
                continue
            ncol = np.array([rgb[p] for p in nb])
            if (ncol.max(0) - ncol.min(0)).max() > NOISE_SPREAD:
                continue
            med = np.median(ncol, axis=0)
            if not opaque[y, x]:
                src[y, x, :3], src[y, x, 3] = np.round(med), 255
                holes += 1
            elif 0 < np.abs(rgb[y, x] - med).max() <= NOISE_DELTA:
                src[y, x, :3] = np.round(med)
                noise += 1
    return src, {"specks": specks, "noise": noise, "holes": holes}


# --------------------------------------------------------------------------- 单帧
def process_image(img):
    """原图 RGBA 数组 → dict(cells, grid, stats)。cells 是一格一像素的 RGBA。"""
    g = detect_grid(img)
    k = int(np.clip(round(min(g["px"], g["py"]) / 2), 1, 5))
    cells = sample_cells(img, g["xb"], g["yb"], k)
    cells, st_bg = remove_background(cells)
    cells, st_sp = clean_specks(cells)
    if not (cells[..., 3] >= 128).any():
        raise NativeGridError("去背景后什么也没剩下")
    stats = dict(st_bg, **st_sp, k=k, fidelity=fidelity(img, cells, g))
    return {"cells": cells, "grid": g, "stats": stats}


def reconstruct(cells, g, shape):
    """把每格颜色画回它在原图里的矩形，用于 1:1 对比和保真度。"""
    ys = np.searchsorted(g["yb"], np.arange(shape[0]), side="right") - 1
    xs = np.searchsorted(g["xb"], np.arange(shape[1]), side="right") - 1
    ys = np.clip(ys, 0, cells.shape[0] - 1)
    xs = np.clip(xs, 0, cells.shape[1] - 1)
    return cells[ys[:, None], xs[None, :]]


def fidelity(img, cells, g):
    """原图不透明区里，重建图与原图的平均通道差（越小越忠实）。"""
    rec = reconstruct(cells, g, img.shape).astype(int)
    m = (img[..., 3] >= 128) & (rec[..., 3] >= 128)
    if not m.any():
        return 0.0
    return round(float(np.abs(rec[..., :3] - img[..., :3])[m].mean()), 2)


def bbox(cells):
    ys, xs = np.nonzero(cells[..., 3] >= 128)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# --------------------------------------------------------------------------- 落画布
def place_state(frames, align="source", canvas=CANVAS, foot_y=FOOT_Y, center_x=CENTER_X):
    """同一状态的帧 → [RGBA 画布数组]。
    align="source"：第 0 帧的脚底 / 水平中心落到 (center_x, foot_y)，其余帧按原图坐标换算，保留原图里的相对位移。
    align="feet"：每帧各自的脚底和水平中心都对齐（原图位置不一致时用）。"""
    cw, ch = canvas
    x0, y0, x1, y1 = bbox(frames[0]["cells"])
    g0 = frames[0]["grid"]
    ref_sx = float(np.interp((x0 + x1) / 2.0, np.arange(len(g0["xb"])), g0["xb"]))
    ref_sy = float(g0["yb"][y1])
    offs = []
    for f in frames:
        if align == "feet":
            a, b, c, d = bbox(f["cells"])
            cx, cy = (a + c) / 2.0, float(d)
        else:
            g = f["grid"]
            cx = float(np.interp(ref_sx, g["xb"], np.arange(len(g["xb"]))))
            cy = float(np.interp(ref_sy, g["yb"], np.arange(len(g["yb"]))))
        offs.append([int(round(center_x - cx)), int(round(foot_y - cy))])
    boxes = [bbox(f["cells"]) for f in frames]
    ux0 = min(b[0] + o[0] for b, o in zip(boxes, offs)); ux1 = max(b[2] + o[0] for b, o in zip(boxes, offs))
    uy0 = min(b[1] + o[1] for b, o in zip(boxes, offs)); uy1 = max(b[3] + o[1] for b, o in zip(boxes, offs))
    if ux1 - ux0 > cw or uy1 - uy0 > ch:
        raise NativeGridError("角色 %dx%d 像素（整组帧合计）放不进 %dx%d 画布；不会自动缩小，请让原图里的角色小一些"
                              % (ux1 - ux0, uy1 - uy0, cw, ch))
    sx = -ux0 if ux0 < 0 else (cw - ux1 if ux1 > cw else 0)   # 整组平移（不破坏帧间对齐）
    sy = -uy0 if uy0 < 0 else (ch - uy1 if uy1 > ch else 0)
    out = []
    for f, (ox, oy), b in zip(frames, offs, boxes):
        cv = np.zeros((ch, cw, 4), np.uint8)
        a0, b0_, a1, b1 = b
        ox += sx; oy += sy
        cv[b0_ + oy:b1 + oy, a0 + ox:a1 + ox] = f["cells"][b0_:b1, a0:a1]
        out.append(cv)
    return out, (sx, sy)


# --------------------------------------------------------------------------- 批处理
def collect_inputs(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += sorted(os.path.join(p, n) for n in os.listdir(p) if n.lower().endswith(".png"))
        else:
            files.append(p)
    groups = {}
    for f in files:
        m = NAME_RE.match(os.path.basename(f))
        state, idx = (m.group(1), int(m.group(2))) if m else (os.path.splitext(os.path.basename(f))[0], 0)
        groups.setdefault(state, []).append((idx, f, bool(m)))
    return {s: sorted(v) for s, v in sorted(groups.items())}


def run_batch(paths, align="source", log=print):
    groups = collect_inputs(paths)
    if not groups:
        raise NativeGridError("没有找到输入图（%s）" % ", ".join(paths))
    results, warnings = {}, []
    for state, items in groups.items():
        frames = []
        for idx, path, named in items:
            img = load_rgba(path)
            r = process_image(img)
            r.update(path=path, idx=idx, named=named, shape=img.shape, source=img)
            frames.append(r)
        canv, shift = place_state(frames, align)
        for r, cv in zip(frames, canv):
            r["canvas"] = cv
        results[state] = {"frames": frames, "shift": shift}
    warnings += consistency_warnings(results)
    for state, s in results.items():
        if s["shift"] != (0, 0):
            warnings.append("%s：整组帧平移了 %r 才放进画布" % (state, s["shift"]))
    return results, warnings


def consistency_warnings(results):
    allf = [(s, f) for s, v in results.items() for f in v["frames"]]
    px = np.median([f["grid"]["px"] for _, f in allf])
    py = np.median([f["grid"]["py"] for _, f in allf])
    out = []
    for s, f in allf:
        g, name = f["grid"], os.path.basename(f["path"])
        for k, med in (("px", px), ("py", py)):
            if abs(g[k] - med) / med > WARN_PERIOD_DEV:
                out.append("%s：格子周期 %s=%.3f 与本批中位数 %.3f 差 %.1f%%"
                           % (name, k, g[k], med, abs(g[k] - med) / med * 100))
        if abs(g["px"] - g["py"]) / max(g["px"], g["py"]) > WARN_PERIOD_DEV:
            out.append("%s：横竖周期不一致（%.3f vs %.3f），格子可能不是正方形" % (name, g["px"], g["py"]))
        if min(g["conf_x"], g["conf_y"]) < 0.25:
            out.append("%s：格子置信度低（x %.2f / y %.2f），可能不是规整像素图" % (name, g["conf_x"], g["conf_y"]))
    return out


# --------------------------------------------------------------------------- 预览图
def _checker(size, a=(236, 236, 240), b=(214, 214, 222), n=16):
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    m = ((yy // n + xx // n) % 2).astype(bool)
    arr = np.where(m[..., None], np.array(b, np.uint8), np.array(a, np.uint8))
    return Image.fromarray(arr.astype(np.uint8), "RGB").convert("RGBA")


def _on_checker(rgba_img):
    bg = _checker(rgba_img.size)
    bg.alpha_composite(rgba_img)
    return bg.convert("RGB")


def make_compare(frame, path):
    """左原图，右取色结果 4 倍最近邻放大，两块同等大小并排。另出 1:1 重建对比（每格画回原位置）。"""
    cells = Image.fromarray(frame["cells"], "RGBA")
    right = cells.resize((cells.width * 4, cells.height * 4), Image.Resampling.NEAREST)
    src = Image.fromarray(frame["source"].astype(np.uint8), "RGBA")
    left = src.resize(right.size, Image.Resampling.BOX)
    gap = 16
    out = Image.new("RGB", (right.width * 2 + gap, right.height), (255, 255, 255))
    out.paste(_on_checker(left), (0, 0))
    out.paste(_on_checker(right), (right.width + gap, 0))
    out.save(path)
    rec = Image.fromarray(reconstruct(frame["cells"], frame["grid"], frame["shape"]), "RGBA")
    full = Image.new("RGB", (src.width * 2 + gap, src.height), (255, 255, 255))
    full.paste(_on_checker(src), (0, 0))
    full.paste(_on_checker(rec), (src.width + gap, 0))
    full.save(os.path.splitext(path)[0] + "_1to1.png")


def demo_cat_ref():
    """(demo-cat 可见高度, displayScale)；包不在时用已知值。"""
    try:
        with open(os.path.join(DEMO_CAT, "character.json"), encoding="utf-8") as f:
            data = json.load(f)
        rel = data["states"]["idle"]["frames"][0]
        with Image.open(os.path.join(DEMO_CAT, rel)) as im:
            a = np.asarray(im.convert("RGBA"))[..., 3]
        ys = np.nonzero(a.max(1) >= 128)[0]
        return int(ys.max() - ys.min() + 1), float(data.get("displayScale", 1.0)), im_path(DEMO_CAT, rel)
    except (OSError, KeyError, ValueError):
        return 148, 1.35, None


def im_path(folder, rel):
    return os.path.join(folder, rel)


def suggest_display_scale(height):
    cat_h, cat_ds, _ = demo_cat_ref()
    return round(cat_h * cat_ds / height / 0.05) * 0.05


def _desktop(im, factor):
    """与 runtime/pixelpet/window.flatten 相同：最近邻缩放 + alpha≥128 二值。"""
    w, h = max(8, round(im.width * factor)), max(8, round(im.height * factor))
    im = im.resize((w, h), Image.Resampling.NEAREST)
    a = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    im.putalpha(a)
    return im


def make_desktop_preview(canvas_arr, display_scale, path, size=DEFAULT_SIZE):
    """实际桌面大小：鲸鱼娘（建议 displayScale）与 demo-cat 并排放在桌面色背景上。"""
    pets = [_desktop(Image.fromarray(canvas_arr, "RGBA"), size * display_scale)]
    _, cat_ds, cat_path = demo_cat_ref()
    if cat_path:
        with Image.open(cat_path) as im:
            pets.append(_desktop(im.convert("RGBA"), size * cat_ds))
    pad = 24
    w = sum(p.width for p in pets) + pad * (len(pets) + 1)
    h = max(p.height for p in pets) + pad * 2
    out = Image.new("RGBA", (w, h), (58, 96, 138, 255))
    x = pad
    for p in pets:
        out.alpha_composite(p, (x, h - pad - p.height))
        x += p.width + pad
    out.convert("RGB").save(path)


def make_sheet(results, path):
    rows = [[Image.fromarray(f["canvas"], "RGBA") for f in v["frames"]] for v in results.values()]
    cols = max(len(r) for r in rows)
    w, h = CANVAS
    out = Image.new("RGB", (cols * (w + 4) + 4, len(rows) * (h + 4) + 4), (255, 255, 255))
    for j, row in enumerate(rows):
        for i, im in enumerate(row):
            out.paste(_on_checker(im), (4 + i * (w + 4), 4 + j * (h + 4)))
    out.save(path)


# --------------------------------------------------------------------------- 写包
def write_pack(results, pack_dir, base_manifest, display_scale):
    """把有 <状态>_NN 命名的帧写进 pack_dir/sprites/，合并 character.json。其他状态原样保留。"""
    data = json.loads(json.dumps(base_manifest))
    data["logicalScale"] = 1
    if display_scale:
        data["displayScale"] = display_scale
    os.makedirs(os.path.join(pack_dir, "sprites"), exist_ok=True)
    written = []
    for state, v in results.items():
        named = [f for f in v["frames"] if f["named"]]
        if not named:
            continue
        rels = []
        for i, f in enumerate(named):
            rel = "sprites/%s_%02d.png" % (state, i)
            Image.fromarray(f["canvas"], "RGBA").save(os.path.join(pack_dir, rel), optimize=False)
            rels.append(rel)
            written.append(rel)
        old = data["states"].get(state, {})
        if len(old.get("durationsMs", [])) == len(rels):
            durs = old["durationsMs"]
        else:
            durs = [int(round(1000 / FPS.get(state, 4 if state.startswith("mood-") else 6)))] * len(rels)
        data["states"][state] = {"label": old.get("label", state), "frames": rels, "durationsMs": durs,
                                 "loop": old.get("loop", state not in NO_LOOP)}
        for k, val in old.items():
            if k not in data["states"][state]:
                data["states"][state][k] = val
    with open(os.path.join(pack_dir, "character.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return written


def _validate(pack_dir):
    sys.path.insert(0, os.path.join(ROOT, "runtime"))
    from pixelpet.validate import check_character
    return check_character(pack_dir)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("inputs", nargs="*", help="PNG 或目录；默认 source/codex/")
    ap.add_argument("--out", default=DEFAULT_OUT, help="预览输出目录（默认 <repo>/.tmp/native）")
    ap.add_argument("--apply", action="store_true", help="写进 characters/whale-girl/sprites 和 character.json（会先备份）")
    ap.add_argument("--align", choices=("source", "feet"), default="source",
                    help="source=按原图坐标保留帧间位移（默认）；feet=每帧各自脚底对齐")
    ap.add_argument("--stamp", default="20261110", help="--apply 备份后缀里的日期")
    args = ap.parse_args(argv)
    inputs = args.inputs or [CODEX_DIR]
    try:
        results, warns = run_batch(inputs, args.align)
    except NativeGridError as e:
        print("错误：%s" % e, file=sys.stderr)
        return 2
    os.makedirs(args.out, exist_ok=True)
    report = {"frames": [], "warnings": warns}
    print("%-22s %8s %8s %7s %7s %5s %9s %6s %s" % ("frame", "px", "py", "ox", "oy", "k", "cells", "fid", "bbox / cleanup"))
    for state, v in results.items():
        for f in v["frames"]:
            g, st = f["grid"], f["stats"]
            x0, y0, x1, y1 = bbox(f["canvas"])
            name = os.path.basename(f["path"])
            print("%-22s %8.3f %8.3f %7.2f %7.2f %5d %4dx%-4d %6.2f %dx%d @(%d,%d)-(%d,%d)  bg=%s(-%d) speck=%d noise=%d hole=%d"
                  % (name, g["px"], g["py"], g["ox"], g["oy"], st["k"], len(g["xb"]) - 1, len(g["yb"]) - 1,
                     st["fidelity"], x1 - x0, y1 - y0, x0, y0, x1, y1, st["bg"], st["bgCells"], st["specks"],
                     st["noise"], st["holes"]))
            report["frames"].append({"file": name, "state": state, "px": round(g["px"], 4), "py": round(g["py"], 4),
                                     "ox": round(g["ox"], 3), "oy": round(g["oy"], 3),
                                     "cells": [len(g["xb"]) - 1, len(g["yb"]) - 1], "bbox": [x0, y0, x1, y1],
                                     **st})
            Image.fromarray(f["canvas"], "RGBA").save(os.path.join(args.out, "%s_%02d.png" % (state, f["idx"])))
    for w in warns:
        print("警告：" + w)
    first_state = "idle" if "idle" in results else next(iter(results))
    first = results[first_state]["frames"][0]
    x0, y0, x1, y1 = bbox(first["canvas"])
    ds = suggest_display_scale(y1 - y0)
    report["displayScaleSuggested"] = ds
    make_compare(first, os.path.join(args.out, "compare.png"))
    make_desktop_preview(first["canvas"], ds, os.path.join(args.out, "preview_desktop.png"))
    make_sheet(results, os.path.join(args.out, "sheet.png"))
    print("建议 displayScale = %.2f（%s 高 %d px；与 demo-cat 在桌面上同高）" % (ds, first_state, y1 - y0))

    with open(os.path.join(PACK, "character.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    named = any(f["named"] for v in results.values() for f in v["frames"])
    if named:
        prev = os.path.join(args.out, "whale-girl")
        if os.path.isdir(prev):
            shutil.rmtree(prev)
        os.makedirs(os.path.join(prev, "sprites"))
        write_pack(results, prev, manifest, ds)
        with open(os.path.join(prev, "character.json"), encoding="utf-8") as fh:
            merged = json.load(fh)
        for st in merged["states"].values():                 # 预览包里补上未替换状态的旧帧，好跑校验
            for rel in st.get("frames", []):
                dst = os.path.join(prev, rel)
                if not os.path.exists(dst) and os.path.exists(os.path.join(PACK, rel)):
                    shutil.copyfile(os.path.join(PACK, rel), dst)
        rep = _validate(prev)
        print("预览包校验：%s（%d 个错误）" % ("OK" if rep.ok() else "FAIL", len(rep.errors)))
        for i in rep.issues:
            print("  ", i)
    if args.apply:
        if not named:
            print("错误：--apply 只接受 <状态>_NN.png 命名的帧", file=sys.stderr)
            return 2
        bak = os.path.join(PACK, "sprites.bak-%s-native" % args.stamp)
        if not os.path.exists(bak):
            shutil.copytree(os.path.join(PACK, "sprites"), bak)
            shutil.copyfile(os.path.join(PACK, "character.json"),
                            os.path.join(PACK, "character.json.bak-%s-native" % args.stamp))
        for state, v in results.items():                      # 清掉被替换状态多出来的旧帧（备份里还在）
            n = sum(1 for f in v["frames"] if f["named"])
            for fn in os.listdir(os.path.join(PACK, "sprites")):
                m = NAME_RE.match(fn)
                if m and m.group(1) == state and int(m.group(2)) >= n:
                    os.remove(os.path.join(PACK, "sprites", fn))
        written = write_pack(results, PACK, manifest, ds)
        rep = _validate(PACK)
        print("已写入 %d 帧；包校验：%s" % (len(written), "OK" if rep.ok() else "FAIL"))
        for i in rep.issues:
            print("  ", i)
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    print("输出：%s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
