"""pack_cli — 拓展包安装器（M1）：宿主拉起的 CLI，注册表的唯一写者。

    python pack_cli.py install --data-dir <dir> --plugin-root <root> --pack <file> [--enable 1]
    python pack_cli.py install --data-dir <dir> --plugin-root <root> --url <https> --sha256 <hex> --size <n> --pack-id <id> [--enable 1] [--retries 4]
        （--url 可以是 GitHub Release 附件地址：302 到 CDN 的跳转只许 https，见 voice/fetch.py）
    python pack_cli.py uninstall  --data-dir <dir> --plugin-root <root> --pack-id <id>
    python pack_cli.py rollback   --data-dir <dir> --pack-id <id>
    python pack_cli.py receipt    --data-dir <dir> --pack-id <id> --generation <n> --pet-running 1|0 --ok-flag 1|0 --loaded <json> [--errors <json>] [--overridden <json>]
    python pack_cli.py grant      --data-dir <dir> --pack-id <id>      （确认权限并启用）
    python pack_cli.py disable    --data-dir <dir> --pack-id <id>
    python pack_cli.py sweep      --data-dir <dir>                     （只做崩溃恢复清扫）
    python pack_cli.py prune-previous --data-dir <dir> [--pack-id <id>] [--force 1]
                                                                       （清掉过了保留期的旧版本；--force 1 = 用户点「清理旧版本」，不等保留期）

 stdout 永远只有一行 JSON 判决 {ok, ...}；失败 {ok:false, code, message}，退出码 0 仅当 ok。
 进度写 <data>/packs/progress.json（原子写，宿主只读）。

 并发：每个子命令先拿 <data>/packs/.lock（O_EXCL；持锁 pid 已死或锁过老视为过期），拿到后先做崩溃恢复清扫。
 状态：registry v2 的 entry.state 存契约 installStates，每次迁移都过 packkit.transition()；
       active / previous / failed 只是版本指针。权限门在 packkit.load_pointer（未授权 / 未启用的包不加载）。
 事务：下载/校验/解包/深度校验都在暂存目录；全部通过才原子换入版本库 store/<ns>/<name>/<version>/
 并原子替换 registry.json（generation++）。失败只清理本次暂存，绝不动被任何指针引用的目录与用户覆盖。
 安装落地 installed-disabled（需确认权限时 waiting-authorization）；--enable 1 且无需确认才记启用意图。
"""
import argparse
import errno
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unicodedata
import uuid
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from pixelpet import packkit  # noqa: E402
from pixelpet.packkit import PackKitError  # noqa: E402
from pixelpet.validate import check_character, check_furniture  # noqa: E402
from pixelpet.voice import fetch as fetch_mod  # noqa: E402
from pixelpet.voice.fetch import DownloadError, IntegrityError, fetch_file  # noqa: E402

# 解包硬上限（实现期冻结常量，表在 docs/PACK_SPEC.md；改值要同步文档）
MEMBER_LIMIT = 512                     # zip 成员数
FILE_LIMIT = 32 * 1024 * 1024          # 单成员解压后字节数
TOTAL_LIMIT = 256 * 1024 * 1024        # 全部成员解压后总字节
PIXEL_BUDGET = 64_000_000              # 包内全部图片的宽×高总预算
PACK_FILE_LIMIT = 64 * 1024 * 1024     # petpack 容器本身的大小上限
REGISTRY_VERSION = packkit.REGISTRY_VERSION
LOCK_TIMEOUT_S = 30.0                  # 等别的 pack_cli 实例放锁的上限
LOCK_STALE_S = 2 * 60 * 60             # 持锁进程还活着但锁超过这么久也视为过期
INCOMING_GRACE_S = 120                 # .incoming 里比这新的文件可能是宿主刚落盘的，不清扫
PREVIOUS_KEEP_S = 7 * 24 * 3600        # 新版本收到运行时回执（加载成功）后，旧版本（previous）再保留 7 天
_clock = time.time                     # 测试可换成假时钟


class CliError(Exception):
    """带稳定错误码的安装失败；code 必须是契约 errorCodes 之一（INTERNAL 除外）。"""

    def __init__(self, code, message):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _short(exc):
    return str(exc)[:200]


# --------------------------------------------------------------------------- 包空间与安全删除

def packs_root(data_dir):
    return os.path.abspath(os.path.join(data_dir, "packs"))


def _assert_in_packs(data_dir, path):
    """递归删除前的硬断言：目标必须在 <data>/packs 之下（不能等于它），否则抛错。"""
    root = os.path.normcase(packs_root(data_dir))
    full = os.path.normcase(os.path.abspath(path))
    try:
        inside = os.path.commonpath([root, full]) == root
    except ValueError:  # 不同盘符
        inside = False
    if not inside or full == root:
        raise CliError("INTERNAL", "拒绝删除包空间以外的路径：%s" % path)
    return os.path.abspath(path)


def _rm(data_dir, path):
    """删一个包空间内的文件或目录；返回删不掉时的残留路径（None = 删干净或本来不存在）。"""
    full = _assert_in_packs(data_dir, path)
    if not os.path.lexists(full):
        return None
    sys.stderr.write("[pack_cli] remove %s\n" % full)
    try:
        if os.path.isdir(full) and not os.path.islink(full):
            def _onerr(func, p, _exc):
                try:
                    os.chmod(p, stat.S_IWRITE)
                    func(p)
                except OSError:
                    pass
            shutil.rmtree(full, onerror=_onerr)
        else:
            os.remove(full)
    except OSError:
        pass
    return full if os.path.lexists(full) else None


# --------------------------------------------------------------------------- 进程锁（packs/.lock）

def _pid_alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        # 注意：Windows 上 os.kill(pid, 0) 会 TerminateProcess，绝不能用来探活
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class PackLock:
    """O_EXCL 独占锁文件；拿不到就等，持锁 pid 已死或锁过老 → 视为过期抢占；超时 → 失败判决。"""

    def __init__(self, data_dir, timeout=None):
        self.path = os.path.join(packs_root(data_dir), ".lock")
        self.timeout = LOCK_TIMEOUT_S if timeout is None else timeout
        self.held = False

    def _stale(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                info = json.load(f)
        except (OSError, ValueError):
            try:  # 半写的锁文件：看 mtime，太老就当过期
                return time.time() - os.path.getmtime(self.path) > 10
            except OSError:
                return True
        pid = info.get("pid") if isinstance(info, dict) else None
        at = info.get("at") if isinstance(info, dict) else None
        if not _pid_alive(pid):
            return True
        return isinstance(at, (int, float)) and time.time() - at > LOCK_STALE_S

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        deadline = time.time() + self.timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except OSError as exc:
                if exc.errno not in (errno.EEXIST, errno.EACCES):
                    raise
                if self._stale():
                    try:
                        os.remove(self.path)
                    except OSError:
                        pass
                    continue
                if time.time() >= deadline:
                    raise CliError("INTERNAL", "另一个拓展包操作还在进行（packs/.lock）")
                time.sleep(0.1)
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "at": time.time()}, f)
            self.held = True
            return self

    def __exit__(self, *_exc):
        if self.held:
            try:
                os.remove(self.path)
            except OSError:
                pass
            self.held = False
        return False


# --------------------------------------------------------------------------- 进度与注册表

def _progress(data_dir, **kw):
    path = os.path.join(data_dir, "packs", "progress.json")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = "%s.%d.tmp" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(kw, pid=os.getpid(), at=int(time.time() * 1000)), f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass  # 进度只是给设置页看的，写不进去不影响安装


def registry_path(data_dir):
    return os.path.join(data_dir, "packs", "registry.json")


def _fresh_registry():
    return {"v": REGISTRY_VERSION, "generation": 0, "packs": {}}


def load_registry_strict(data_dir):
    """写者用的严格读取：损坏或格式不符一律拒写（E_REGISTRY_INVALID），绝不盲目重建。v1 兼容迁移成 v2。"""
    path = registry_path(data_dir)
    if not os.path.isfile(path):
        return _fresh_registry()
    try:
        with open(path, encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError) as exc:
        raise CliError("E_REGISTRY_INVALID", "注册表读不了：%s" % _short(exc)) from exc
    if not packkit.registry_shape_ok(reg):
        raise CliError("E_REGISTRY_INVALID", "注册表格式不是 v1/v%d" % REGISTRY_VERSION)
    for pid, entry in reg["packs"].items():
        if not isinstance(entry, dict):
            raise CliError("E_REGISTRY_INVALID", "注册表条目 %r 不是对象" % str(pid)[:40])
    reg = packkit.migrate_registry(reg)
    states = packkit.install_states()
    for pid, entry in reg["packs"].items():
        if entry.get("state") not in states:
            raise CliError("E_REGISTRY_INVALID", "条目 %r 的状态 %r 不在契约 installStates 里"
                           % (str(pid)[:40], entry.get("state")))
    return reg


def save_registry(data_dir, reg):
    path = registry_path(data_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    reg["v"] = REGISTRY_VERSION
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), uuid.uuid4().hex[:6])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _go(entry, *events):
    """按契约状态机逐个事件迁移 entry["state"]；任何非法组合抛 E_STATE_INVALID。"""
    for ev in events:
        try:
            entry["state"] = packkit.transition(entry.get("state") or "not-downloaded", ev)
        except PackKitError as exc:
            raise CliError("E_STATE_INVALID", exc.message or exc.code) from exc
    return entry["state"]


def _can(entry, event):
    table = packkit.load_contract()["stateTransitions"].get(entry.get("state") or "not-downloaded") or {}
    return event in table


def _pointers(entry):
    return [entry.get(k) for k in ("active", "previous", "failed") if isinstance(entry.get(k), dict)]


def _referenced_dirs(reg):
    out = set()
    for entry in reg["packs"].values():
        for ptr in _pointers(entry):
            if isinstance(ptr.get("dir"), str):
                out.add(ptr["dir"].replace("\\", "/"))
    return out


def store_rel(pack_id, version):
    """命名空间 id → 存储相对路径（正斜杠）：petdev.m1-demo@1.0.0 → petdev/m1-demo/1.0.0。"""
    if not (isinstance(pack_id, str) and pack_id.count(".") == 1):
        raise CliError("E_ID_INVALID", "命名空间 id 要是 命名空间.包名")
    parts = pack_id.split(".")
    if not all(parts) or any(p.strip(".") != p for p in parts):
        raise CliError("E_ID_INVALID", "命名空间 id 段不合法")
    try:
        packkit.parse_version(version)
    except PackKitError as exc:
        raise CliError("E_VERSION_MALFORMED", exc.message or exc.code) from exc
    rel = "/".join(parts + [version])
    if not packkit.safe_store_rel(rel):
        raise CliError("E_ID_INVALID", "存储路径不安全")
    return rel


def store_abs(data_dir, rel):
    root = os.path.abspath(os.path.join(data_dir, "packs", "store"))
    if not packkit.safe_store_rel(rel):
        raise CliError("E_ID_INVALID", "存储路径不安全：%r" % str(rel)[:80])
    full = os.path.abspath(os.path.join(root, *rel.replace("\\", "/").split("/")))
    if os.path.commonpath([root, full]) != root or full == root:
        raise CliError("E_ID_INVALID", "存储路径越界")
    return full


# --------------------------------------------------------------------------- 崩溃恢复清扫

def _sweep(data_dir, keep=(), reg=None):
    """每个子命令拿锁后先跑：清上次崩溃留下的暂存 / 下载 / 导入 / 临时注册表，以及未被注册表引用的 store 版本目录。

    全部删除都过 _assert_in_packs；注册表读不了时不碰 store（宁可留垃圾也不误删）。返回删不掉的残留。"""
    root = packs_root(data_dir)
    if not os.path.isdir(root):
        return []
    keep = {os.path.normcase(os.path.abspath(k)) for k in keep if k}
    left = []
    now = time.time()

    def rm(path):
        if os.path.normcase(os.path.abspath(path)) in keep:
            return
        r = _rm(data_dir, path)
        if r:
            left.append(r)

    for name in os.listdir(root):
        if name.startswith("pack-stage-") or (name.startswith(("registry.json.", "progress.json.")) and name.endswith(".tmp")):
            rm(os.path.join(root, name))
    for sub, grace in ((".downloads", 0), (".incoming", INCOMING_GRACE_S)):
        d = os.path.join(root, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            full = os.path.join(d, name)
            try:
                young = now - os.path.getmtime(full) < grace
            except OSError:
                young = False
            if not young:
                rm(full)
    if reg is None:
        try:
            reg = load_registry_strict(data_dir)
        except CliError:
            return left
    store = os.path.join(root, "store")
    refs = {os.path.normcase(os.path.abspath(os.path.join(store, *r.split("/")))) for r in _referenced_dirs(reg)}
    if os.path.isdir(store):
        for ns in os.listdir(store):
            nsd = os.path.join(store, ns)
            if not os.path.isdir(nsd) or os.path.islink(nsd):
                rm(nsd)
                continue
            for name in os.listdir(nsd):
                nd = os.path.join(nsd, name)
                if not os.path.isdir(nd) or os.path.islink(nd):
                    rm(nd)
                    continue
                for ver in os.listdir(nd):
                    vd = os.path.join(nd, ver)
                    if os.path.normcase(os.path.abspath(vd)) not in refs:
                        rm(vd)
                if os.path.isdir(nd) and not os.listdir(nd):
                    rm(nd)
            if os.path.isdir(nsd) and not os.listdir(nsd):
                rm(nsd)
    return left


def _gc_dirs(data_dir, reg, rels):
    """回收不再被任何指针引用的版本目录（被引用的一律不动）；返回删不掉的残留。"""
    refs = _referenced_dirs(reg)
    left = []
    for rel in rels:
        if not rel or rel.replace("\\", "/") in refs or not packkit.safe_store_rel(rel):
            continue
        full = store_abs(data_dir, rel)
        r = _rm(data_dir, full)
        if r:
            left.append(r)
            continue
        store = os.path.abspath(os.path.join(data_dir, "packs", "store"))
        parent = os.path.dirname(full)
        while parent != store and os.path.commonpath([store, parent]) == store:  # 空的 <ns>/<name> 一并收掉
            try:
                os.rmdir(_assert_in_packs(data_dir, parent))  # rmdir 只删空目录
            except OSError:
                break
            parent = os.path.dirname(parent)
    return left


# --------------------------------------------------------------------------- zip 防御

_WIN_RESERVED = {"con", "prn", "aux", "nul"} | {"com%d" % i for i in range(1, 10)} | {"lpt%d" % i for i in range(1, 10)}


def _seg_bad(seg):
    """Windows 上不安全的路径段：契约 DIR_SEG_RE 不通过（含 ':' 即 ADS、控制字符、保留字符）、
    以 '.' 或空格结尾、保留设备名（含带扩展名，如 con.txt / COM1.png）。"""
    if not packkit.DIR_SEG_RE.match(seg):
        return True
    if seg != seg.rstrip(". "):
        return True
    return seg.split(".")[0].rstrip(" ").lower() in _WIN_RESERVED


def _collide_key(parts):
    """碰撞比较键：NFC → rstrip('. ') → lower（Windows 视为同一路径的写法归一）。"""
    return "/".join(unicodedata.normalize("NFC", p).rstrip(". ").lower() for p in parts)


def _scan_zip(path):
    """中央目录预扫描：成员数/单文件/总量上限、穿越、盘符、链接/特殊成员、Windows 非法段、重名与大小写/NFC 碰撞。"""
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise CliError("E_ZIP_INVALID", "不是可读的 ZIP 容器：%s" % _short(exc)) from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > MEMBER_LIMIT:
            raise CliError("E_ZIP_LIMIT", "成员数 %d 超过上限 %d" % (len(infos), MEMBER_LIMIT))
        seen = {}
        total = 0
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if not parts or name.startswith("/") or (len(name) > 1 and name[1] == ":") or any(p == ".." for p in parts):
                raise CliError("E_ZIP_INVALID", "成员路径越界：%r" % info.filename[:80])
            bad = [p for p in parts if _seg_bad(p)]
            if bad:
                raise CliError("E_ZIP_INVALID", "成员路径段在 Windows 上不安全：%r" % bad[0][:40])
            if info.file_size > FILE_LIMIT:
                raise CliError("E_ZIP_LIMIT", "成员 %r 解压后 %d 字节，超过单文件上限" % (name[:80], info.file_size))
            total += info.file_size
            if total > TOTAL_LIMIT:
                raise CliError("E_ZIP_LIMIT", "总解压量超过 %d 字节" % TOTAL_LIMIT)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise CliError("E_ZIP_INVALID", "成员是符号链接：%r" % name[:80])
            if mode and mode not in (stat.S_IFREG, stat.S_IFDIR):
                raise CliError("E_ZIP_INVALID", "成员是特殊文件：%r" % name[:80])
            ext = os.path.splitext(parts[-1])[1].lower()
            data_file = ext in {".json", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md"} \
                        or parts[-1].upper() in {"LICENSE", "CREDITS", "NOTICE"}
            voice_audio = (len(parts) == 4 and parts[0] == "characters"
                           and packkit.PACK_ID_RE.fullmatch(parts[1]) and parts[2] == "voice"
                           and ext in {".wav", ".mp3"})
            if not name.endswith("/") and not (data_file or voice_audio):
                raise CliError("E_FIELD_INVALID", "拓展包只接受数据文件：%r" % name[:80])
            key = _collide_key(parts)
            if key in seen:
                raise CliError("E_ZIP_INVALID", "重名（含大小写/Unicode 碰撞）成员：%r" % name[:80])
            seen[key] = name
        return infos


def _extract_zip(path, staging, infos):
    with zipfile.ZipFile(path) as zf:
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            target = os.path.join(staging, *parts)
            if name.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


# --------------------------------------------------------------------------- 深度校验

def _pixel_budget(staging):
    """包内全部图片 open+verify 一遍，宽×高总和 ≤ PIXEL_BUDGET；坏图直接拒。"""
    try:
        from PIL import Image
    except ImportError:
        raise CliError("E_FIELD_INVALID", "安装校验需要 Pillow（便携运行时自带），找不到它")
    total = 0
    for base, _dirs, files in os.walk(staging):
        for fn in files:
            if not fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            full = os.path.join(base, fn)
            try:
                with Image.open(full) as im:
                    w, h = im.size
                    im.verify()
            except Exception as exc:  # noqa: BLE001
                raise CliError("E_ZIP_INVALID", "图片读不了 %s：%s" % (os.path.relpath(full, staging), _short(exc))) from exc
            total += w * h
            if total > PIXEL_BUDGET:
                raise CliError("E_ZIP_LIMIT", "图片像素总量超过预算 %d" % PIXEL_BUDGET)
    return total


def _character_assets(staging, manifest):
    dirs = {}
    for ch in manifest.get("characters", ()):
        cid = ch["id"]
        rel = ch.get("dir", "characters/" + cid)
        folder = os.path.join(staging, rel)
        check = check_character(folder)
        if not check.ok(strict=True):
            raise CliError("E_FIELD_INVALID", "包内角色 %s 校验没过：%s" %
                           (cid, "; ".join(str(i) for i in check.errors)[:240] or "骨架包"))
        dirs[cid] = rel
    return dirs


def _deep_validate(staging):
    """校验清单、角色、家具、适配器和资源。"""
    mpath = os.path.join(staging, "manifest.json")
    if not os.path.isfile(mpath):
        raise CliError("E_MANIFEST_MISSING", "包根目录没有 manifest.json")
    try:
        with open(mpath, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as exc:
        raise CliError("E_MANIFEST_JSON_INVALID", "manifest.json：%s" % _short(exc)) from exc
    rep = packkit.check_pack_manifest(manifest)
    if not rep["ok"]:
        codes = "; ".join("%s@%s" % (e["code"], e["path"]) for e in rep["errors"])
        raise CliError(rep["errors"][0]["code"], "清单校验没过：%s" % codes)

    furniture_ids = []
    for folder in packkit.enumerate_packs(staging, "furniture"):
        fid = os.path.basename(folder)
        check = check_furniture(folder)
        if not check.ok(strict=True):
            raise CliError("E_FIELD_INVALID", "包内家具 %s 校验没过：%s" % (fid, "; ".join(str(i) for i in check.errors)[:200]))
        furniture_ids.append(fid)
    ef = manifest.get("entryFurniture") if isinstance(manifest.get("entryFurniture"), dict) else None
    if ef and ef.get("id") not in furniture_ids:
        raise CliError("E_FIELD_INVALID", "entryFurniture.id %r 不在包内家具里" % ef.get("id"))

    adapters = os.path.join(staging, "character-adapters")
    if os.path.isdir(adapters):
        for name in os.listdir(adapters):
            if not packkit.PACK_ID_RE.match(name):
                raise CliError("E_FIELD_INVALID", "character-adapters 下的目录名不是角色 id：%r" % name[:40])

    for rel in (manifest.get("resources") or {}).values():
        full = os.path.abspath(os.path.join(staging, rel))
        if os.path.commonpath([os.path.abspath(staging), full]) != os.path.abspath(staging) or not os.path.isfile(full):
            raise CliError("E_FIELD_INVALID", "resources 里的文件缺失或越界：%r" % str(rel)[:80])

    _pixel_budget(staging)
    return manifest, furniture_ids, _character_assets(staging, manifest)


# --------------------------------------------------------------------------- 冲突检查

def _builtin_and_user_furniture_ids(plugin_root, data_dir):
    ids = set()
    for base in (plugin_root, data_dir):
        if base:
            for folder in packkit.enumerate_packs(base, "furniture"):
                ids.add(os.path.basename(folder))
    return ids


def _check_conflicts(reg, plugin_root, data_dir, pack_id, version, sha, furniture_ids, character_ids):
    """返回 (same_ptr, idempotent)：same_ptr 是同版本同哈希、目录完好的既有指针（复用其目录，不重写）。

    同版本不同哈希：active / previous / failed 一视同仁拒绝（E_ID_CONFLICT），绝不覆盖被引用的目录。"""
    entry = reg["packs"].get(pack_id)
    same = None
    if entry:
        for ptr in _pointers(entry):
            if ptr.get("version") != version:
                continue
            if ptr.get("sha256") != sha:
                raise CliError("E_ID_CONFLICT", "同版本 %s 已存在但哈希不同（已登记 %s…，这次 %s…）"
                               % (version, str(ptr.get("sha256"))[:12], sha[:12]))
            if packkit.safe_store_rel(ptr.get("dir")) and os.path.isdir(store_abs(data_dir, ptr["dir"])):
                same = ptr
    idempotent = bool(entry and same is not None and same is entry.get("active")
                      and entry.get("state") in ("installed-disabled", "enabled", "waiting-authorization"))
    taken = _builtin_and_user_furniture_ids(plugin_root, data_dir)
    for other_id, other in reg["packs"].items():
        if other_id == pack_id:
            continue
        for ptr in _pointers(other):
            taken.update(ptr.get("furnitureIds") or [])
    clash = sorted(set(furniture_ids) & taken)
    if clash:
        raise CliError("E_ID_CONFLICT", "家具 id 撞名：%s" % ", ".join(clash[:6]))
    taken_chars = {os.path.basename(p) for p in packkit.enumerate_packs(plugin_root, "character")}
    for other_id, other in reg["packs"].items():
        if other_id != pack_id:
            for ptr in _pointers(other):
                taken_chars.update(ptr.get("characterIds") or [])
    clash = sorted(set(character_ids) & taken_chars)
    if clash:
        raise CliError("E_ID_CONFLICT", "角色 id 撞名：%s" % ", ".join(clash[:6]))
    return same, idempotent


# --------------------------------------------------------------------------- 子命令

def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _place(data_dir, staging, rel):
    """原子入库：staging → <ver>.new-<rand> → 既有同名目录（只可能是未被引用的残留）改名 .old-<rand> → .new 换入。

    返回 .old 目录（注册表写成功后才删）。换入失败时把旧目录换回去。"""
    full = store_abs(data_dir, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    new = "%s.new-%s" % (full, tag)
    old = "%s.old-%s" % (full, tag)
    os.replace(staging, new)
    moved_old = False
    try:
        if os.path.lexists(full):
            os.replace(full, old)
            moved_old = True
        os.replace(new, full)
    except OSError:
        if moved_old and not os.path.lexists(full):
            os.replace(old, full)
        raise
    return old if moved_old else None


def _entry_view(pack_id, entry, generation, **extra):
    lp = packkit.load_pointer(entry)
    out = {"ok": True, "id": pack_id, "state": entry.get("state"), "generation": generation,
           "version": (entry.get("active") or {}).get("version"),
           "furnitureIds": list((lp or {}).get("furnitureIds") or []),
           "characterIds": list((lp or {}).get("characterIds") or []),
           "load": lp is not None, "loadVersion": (lp or {}).get("version"),
           "wantEnabled": entry.get("wantEnabled") is True,
           "pendingPermissions": list(entry.get("pendingPermissions") or []),
           "grantedPermissions": list(entry.get("grantedPermissions") or [])}
    out.update(extra)
    return out


def _is_incoming(data_dir, path):
    inc = os.path.normcase(os.path.join(packs_root(data_dir), ".incoming"))
    full = os.path.normcase(os.path.abspath(path))
    try:
        return os.path.commonpath([inc, full]) == inc and full != inc
    except ValueError:
        return False


def cmd_install(args):
    data_dir = os.path.abspath(args.data_dir)
    plugin_root = os.path.abspath(args.plugin_root)
    os.makedirs(os.path.join(data_dir, "packs"), exist_ok=True)
    try:
        with PackLock(data_dir):
            _sweep(data_dir, keep=[args.pack] if args.pack else ())
            return _install_locked(args, data_dir, plugin_root)
    finally:
        if args.pack and os.path.isfile(args.pack) and _is_incoming(data_dir, args.pack):
            _rm(data_dir, args.pack)  # 导入暂存文件用完即删（只限 packs/.incoming 下）


def _install_locked(args, data_dir, plugin_root):
    _progress(data_dir, phase="preparing", message="准备安装")
    staging = tempfile.mkdtemp(prefix="pack-stage-", dir=os.path.join(data_dir, "packs"))
    archive = None
    try:
        # 1. 取包：下载（fetch_file 自带断点续传 + sha 校验）或本地导入
        if args.url:
            if not args.sha256 or not args.size:
                raise CliError("E_REQUIRED_MISSING", "--url 安装要同时给 --sha256 和 --size")
            archive = os.path.join(data_dir, "packs", ".downloads", "%s.petpack" % re_slash(args.pack_id or "pack"))
            os.makedirs(os.path.dirname(archive), exist_ok=True)
            _progress(data_dir, phase="downloading", id=args.pack_id, done=0, total=args.size, message="下载")
            try:
                fetch_file({"url": args.url, "sha256": args.sha256, "size": args.size,
                            "path": re_slash(args.pack_id) + ".petpack"}, archive,
                           progress=lambda done, total: _progress(data_dir, phase="downloading", id=args.pack_id,
                                                                  done=done, total=total, message="下载"),
                           retries=max(0, int(getattr(args, "retries", 4))))
            except fetch_mod.SizeMismatch as exc:
                raise CliError("E_SIZE_MISMATCH", "下载内容的大小与目录声明不符") from exc
            except IntegrityError as exc:
                raise CliError("E_HASH_MISMATCH", "下载内容的 SHA-256 与目录声明不符") from exc
            except DownloadError as exc:
                # 连不上 / HTTP 错误 / 跳转被拒 / 中断：契约里没有单独的下载失败码，沿用 E_SIZE_MISMATCH
                raise CliError("E_SIZE_MISMATCH", "下载失败：%s" % _short(exc)) from exc
            if os.path.getsize(archive) != args.size:
                raise CliError("E_SIZE_MISMATCH", "大小与目录声明不符")
        elif args.pack:
            if not os.path.isfile(args.pack):
                raise CliError("E_MANIFEST_MISSING", "找不到包文件：%s" % args.pack[:120])
            if os.path.getsize(args.pack) > PACK_FILE_LIMIT:
                raise CliError("E_ZIP_LIMIT", "包文件超过 %d 字节上限" % PACK_FILE_LIMIT)
            archive = args.pack
        else:
            raise CliError("E_REQUIRED_MISSING", "install 要给 --pack 或 --url")

        # 2. 校验容器（导入路径在这里补 sha/大小判定）
        _progress(data_dir, phase="verifying", message="校验")
        if args.size is not None and os.path.getsize(archive) != args.size:
            raise CliError("E_SIZE_MISMATCH", "大小与目录声明不符")
        sha = _sha256_file(archive)
        if args.sha256 and sha != args.sha256.lower():
            raise CliError("E_HASH_MISMATCH", "SHA-256 与声明不符")

        # 3. 安全解包到暂存
        _progress(data_dir, phase="extracting", message="解包")
        infos = _scan_zip(archive)
        _extract_zip(archive, staging, infos)

        # 4. 深度校验
        _progress(data_dir, phase="validating", message="校验清单与资源")
        manifest, furniture_ids, character_dirs = _deep_validate(staging)
        pack_id = manifest["id"]
        version = manifest["version"]
        if args.pack_version and args.pack_version != version:
            raise CliError("E_FIELD_INVALID", "目录版本与包清单不一致")
        if args.pack_id and args.pack_id != pack_id:
            raise CliError("E_FIELD_INVALID", "目录声明 id %r 与清单 %r 不一致" % (args.pack_id, pack_id))
        perms = [p for p in (manifest.get("permissions") or []) if isinstance(p, str)]

        # 5. 冲突与幂等
        reg = load_registry_strict(data_dir)
        same, idempotent = _check_conflicts(reg, plugin_root, data_dir, pack_id, version, sha, furniture_ids, character_dirs)
        if idempotent:
            return _entry_view(pack_id, reg["packs"][pack_id], reg["generation"], idempotent=True, leftovers=[])

        # 6. 状态机：已装可更新走 update-install；否则（新装 / load-failed / 等待中 / 不兼容）从 not-downloaded 重走
        prev = reg["packs"].get(pack_id)
        entry = json.loads(json.dumps(prev)) if prev else {
            "state": "not-downloaded", "wantEnabled": False, "grantedPermissions": [], "pendingPermissions": [],
            "active": None, "previous": None, "failed": None, "receipt": None}
        if prev and _can(entry, "update-install"):
            _go(entry, "update-install")
        else:
            entry["state"] = "not-downloaded"
            _go(entry, "download-start")
        _go(entry, "download-done", "dependency-resolved")  # → waiting-authorization
        confirm = packkit.confirm_permission_ids()
        granted = [p for p in (entry.get("grantedPermissions") or []) if isinstance(p, str)]
        granted += [p for p in perms if p not in confirm and p not in granted]  # 无需确认的权限随装随记
        pending = [p for p in perms if p in confirm and p not in granted]
        entry["grantedPermissions"] = granted
        entry["pendingPermissions"] = pending
        if not pending:
            _go(entry, "authorization-granted", "adaptation-resolved")  # → installed-disabled
            if args.enable:
                entry["wantEnabled"] = True  # 「安装并启用」且无需确认：一次完成（仍以回执为准）
            if entry.get("wantEnabled"):
                _go(entry, "enable-request")
        # pending 非空：停在 waiting-authorization；wantEnabled 原为真时 previous 继续加载（新增能力暂停等再授权）

        # 7. 入版本库（原子换入）→ 指针 → 原子替换注册表（generation++）→ 最后才删旧
        _progress(data_dir, phase="storing", id=pack_id, message="入库")
        rel = store_rel(pack_id, version)
        old_dir = None
        if same is None:
            if rel in _referenced_dirs(reg):
                raise CliError("E_ID_CONFLICT", "版本目录 %s 仍被注册表引用，拒绝覆盖" % rel)
            old_dir = _place(data_dir, staging, rel)
        ptr = {"id": pack_id, "version": version, "dir": rel, "sha256": sha, "permissions": perms,
               "furnitureIds": furniture_ids, "characterIds": sorted(character_dirs),
               "characterDirs": character_dirs, "addedAt": int(time.time() * 1000)}
        old_ptrs = _pointers(prev) if prev else []
        old_active = (prev or {}).get("active")
        if isinstance(old_active, dict) and old_active.get("version") != version \
                and (prev or {}).get("state") in packkit.LOADABLE_STATES:
            entry["previous"] = old_active        # 旧在役版本成为可回退的上一份
            entry.pop("previousExpiresAt", None)  # 保留期从「新版本收到回执」那一刻才开始算
        elif isinstance(entry.get("previous"), dict) and entry["previous"].get("version") == version:
            entry["previous"] = None              # 不让 previous 与 active 指向同一份
            entry.pop("previousExpiresAt", None)
        entry["active"] = ptr
        entry["failed"] = None
        entry["receipt"] = None
        reg["packs"][pack_id] = entry
        reg["generation"] = reg.get("generation", 0) + 1
        save_registry(data_dir, reg)
        leftovers = []
        if old_dir:
            r = _rm(data_dir, old_dir)
            if r:
                leftovers.append(r)
        leftovers += _gc_dirs(data_dir, reg, [p.get("dir") for p in old_ptrs])  # 被挤出的旧 previous / failed
        _progress(data_dir, phase="done", id=pack_id,
                  message="等待确认权限" if pending else ("已登记，等待桌宠回执" if packkit.load_pointer(entry) else "已安装，未启用"))
        return _entry_view(pack_id, entry, reg["generation"], leftovers=leftovers)
    except CliError as exc:
        _progress(data_dir, phase="failed", message=exc.message, code=exc.code)
        return {"ok": False, "code": exc.code, "message": exc.message}
    except Exception as exc:  # noqa: BLE001
        _progress(data_dir, phase="failed", message=_short(exc))
        return {"ok": False, "code": "INTERNAL", "message": "%s: %s" % (type(exc).__name__, _short(exc))}
    finally:
        if os.path.isdir(staging):
            _rm(data_dir, staging)
        if archive and args.url and os.path.isfile(archive):
            _rm(data_dir, archive)


def cmd_uninstall(args):
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg = load_registry_strict(data_dir)
        _sweep(data_dir, reg=reg)
        entry = reg["packs"].get(args.pack_id)
        if entry is None:
            return {"ok": True, "idempotent": True, "id": args.pack_id, "furnitureIds": [], "leftovers": []}
        _go(entry, "uninstall")
        removed = sorted({f for p in _pointers(entry) for f in (p.get("furnitureIds") or [])})
        rels = [p.get("dir") for p in _pointers(entry)]
        del reg["packs"][args.pack_id]
        reg["generation"] = reg.get("generation", 0) + 1
        save_registry(data_dir, reg)
        leftovers = _gc_dirs(data_dir, reg, rels)
        _progress(data_dir, phase="done", id=args.pack_id, message="已卸载" if not leftovers else "已卸载，有文件没删掉")
        return {"ok": True, "id": args.pack_id, "generation": reg["generation"], "furnitureIds": removed,
                "state": "not-downloaded", "leftovers": leftovers}


def _locked_entry(data_dir, pack_id):
    reg = load_registry_strict(data_dir)
    _sweep(data_dir, reg=reg)
    entry = reg["packs"].get(pack_id)
    if not entry or not isinstance(entry.get("active"), dict):
        raise CliError("E_PACK_NOT_FOUND", "注册表里没有 %s" % pack_id)
    return reg, entry


def cmd_rollback(args):
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg, entry = _locked_entry(data_dir, args.pack_id)
        if entry.get("state") != "load-failed":
            _go(entry, "load-receipt-fail")
        previous = entry.get("previous")
        if isinstance(previous, dict):
            entry["failed"] = entry["active"]
            entry["active"] = previous
            entry["previous"] = None
            entry.pop("previousExpiresAt", None)
            _go(entry, "rollback-ok")  # → installed-disabled；wantEnabled 不变，旧版重载回执后 → enabled
        reg["generation"] = reg.get("generation", 0) + 1
        save_registry(data_dir, reg)
        _progress(data_dir, phase="done", id=args.pack_id, message="已回退" if isinstance(previous, dict) else "加载失败，无旧版可退")
        return _entry_view(args.pack_id, entry, reg["generation"], active=entry["active"].get("version"),
                           failedVersion=(entry.get("failed") or entry["active"]).get("version"),
                           rolledBack=isinstance(previous, dict))


def cmd_receipt(args):
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg, entry = _locked_entry(data_dir, args.pack_id)
        ok = bool(args.pet_running and args.ok_flag)
        loaded = _json_arg(args.loaded)
        if isinstance(loaded, list):
            loaded = {"furniture": loaded, "characters": []}
        entry["receipt"] = {
            "generation": args.generation, "ok": ok, "petRunning": bool(args.pet_running),
            "loaded": loaded, "errors": _json_arg(args.errors),
            "overriddenBy": _json_arg(args.overridden) or {}, "at": int(time.time() * 1000),
        }
        st = entry.get("state")
        if args.pet_running and ((st in packkit.LOADABLE_STATES and packkit.load_pointer(entry) is entry.get("active"))
                                 or st == "load-failed"):
            _go(entry, "load-receipt-ok" if ok else "load-receipt-fail")
        # 新版本加载成功并收到回执：旧版本从现在起再保留 7 天。回执没成功 / 桌宠没在跑 → 不开始计时，旧版本原样留着。
        if ok and entry.get("state") == "enabled" and isinstance(entry.get("previous"), dict) \
                and not entry.get("previousExpiresAt"):
            entry["previousExpiresAt"] = int((_clock() + PREVIOUS_KEEP_S) * 1000)
        save_registry(data_dir, reg)  # 回执不改 generation（激活代次只随指针变）
        return _entry_view(args.pack_id, entry, reg["generation"], receiptOk=ok)


def cmd_grant(args):
    """确认权限并启用：授权 active 声明的全部权限，waiting-authorization → installed-disabled，记启用意图。"""
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg, entry = _locked_entry(data_dir, args.pack_id)
        granted = list(entry.get("grantedPermissions") or [])
        granted += [p for p in (entry["active"].get("permissions") or []) if p not in granted]
        entry["grantedPermissions"] = granted
        entry["pendingPermissions"] = []
        if entry.get("state") == "waiting-authorization":
            _go(entry, "authorization-granted", "adaptation-resolved")
        if entry.get("state") not in packkit.LOADABLE_STATES:
            raise CliError("E_STATE_INVALID", "当前状态 %s 不能启用" % entry.get("state"))
        entry["wantEnabled"] = True
        if entry["state"] == "installed-disabled":
            _go(entry, "enable-request")
        reg["generation"] = reg.get("generation", 0) + 1
        save_registry(data_dir, reg)
        _progress(data_dir, phase="done", id=args.pack_id, message="已授权，等待桌宠回执")
        return _entry_view(args.pack_id, entry, reg["generation"])


def cmd_disable(args):
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg, entry = _locked_entry(data_dir, args.pack_id)
        entry["wantEnabled"] = False
        if entry.get("state") == "enabled":
            _go(entry, "disable-request")
        reg["generation"] = reg.get("generation", 0) + 1
        save_registry(data_dir, reg)
        _progress(data_dir, phase="done", id=args.pack_id, message="已停用")
        return _entry_view(args.pack_id, entry, reg["generation"])


def cmd_prune_previous(args):
    """清掉旧版本（previous）。默认只清过了保留期的；--force 1（设置页「清理旧版本」）不等保留期。

    新版本没起来（load-failed / 有 failed 指针）时旧版本是唯一退路，一律不清；显式指定包时给出原因。
    先写注册表，最后才删目录（同安装事务）；不改 generation——在役指针没变，桌宠不用重载。"""
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        reg = load_registry_strict(data_dir)
        _sweep(data_dir, reg=reg)
        now_ms = _clock() * 1000
        pruned, rels, kept = [], [], []
        for pid, entry in list(reg["packs"].items()):
            if args.pack_id and pid != args.pack_id:
                continue
            prev = entry.get("previous")
            if not isinstance(prev, dict):
                continue
            if entry.get("state") == "load-failed" or isinstance(entry.get("failed"), dict):
                if args.pack_id:
                    raise CliError("E_STATE_INVALID", "新版本还没加载成功，旧版本是回退的唯一退路")
                kept.append(pid)
                continue
            due = entry.get("previousExpiresAt")
            if not args.force and not (isinstance(due, (int, float)) and not isinstance(due, bool) and now_ms >= due):
                continue
            rels.append(prev.get("dir"))
            entry["previous"] = None
            entry.pop("previousExpiresAt", None)
            pruned.append(pid)
        if pruned:
            save_registry(data_dir, reg)
        leftovers = _gc_dirs(data_dir, reg, rels)
        return {"ok": True, "pruned": pruned, "kept": kept, "leftovers": leftovers, "generation": reg.get("generation", 0)}


def cmd_sweep(args):
    data_dir = os.path.abspath(args.data_dir)
    with PackLock(data_dir):
        return {"ok": True, "leftovers": _sweep(data_dir)}


def _json_arg(text):
    if not text:
        return []
    try:
        v = json.loads(text)
        return v if isinstance(v, (list, dict)) else []
    except ValueError:
        return []


def re_slash(s):
    return "".join(ch if ch.isalnum() or ch in ".-" else "_" for ch in str(s or "pack"))[:60]


def main(argv=None):
    ap = argparse.ArgumentParser(description="拓展包安装器（注册表唯一写者）")
    sub = ap.add_subparsers(dest="cmd_name", required=True)

    p = sub.add_parser("install")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--plugin-root", required=True)
    p.add_argument("--pack")
    p.add_argument("--url")
    p.add_argument("--sha256")
    p.add_argument("--size", type=int)
    p.add_argument("--pack-id")
    p.add_argument("--pack-version")
    p.add_argument("--enable", type=int, default=0)
    p.add_argument("--retries", type=int, default=4)   # 下载失败后的重试次数（启动迁移用 1：断网时别让桌宠等一分钟）
    p.set_defaults(fn=cmd_install)

    p = sub.add_parser("uninstall")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--plugin-root", required=True)
    p.add_argument("--pack-id", required=True)
    p.set_defaults(fn=cmd_uninstall)

    p = sub.add_parser("receipt")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--pack-id", required=True)
    p.add_argument("--generation", type=int, required=True)
    p.add_argument("--pet-running", type=int, default=0)
    p.add_argument("--ok-flag", type=int, default=0)
    p.add_argument("--loaded", default="")
    p.add_argument("--errors", default="")
    p.add_argument("--overridden", default="")
    p.set_defaults(fn=cmd_receipt)

    for name, fn in (("rollback", cmd_rollback), ("grant", cmd_grant), ("disable", cmd_disable)):
        p = sub.add_parser(name)
        p.add_argument("--data-dir", required=True)
        p.add_argument("--pack-id", required=True)
        p.set_defaults(fn=fn)

    p = sub.add_parser("sweep")
    p.add_argument("--data-dir", required=True)
    p.set_defaults(fn=cmd_sweep)

    p = sub.add_parser("prune-previous")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--pack-id")
    p.add_argument("--force", type=int, default=0)
    p.set_defaults(fn=cmd_prune_previous)

    args = ap.parse_args(argv)
    try:
        out = args.fn(args)
    except CliError as exc:
        out = {"ok": False, "code": exc.code, "message": exc.message}
    except Exception as exc:  # noqa: BLE001
        out = {"ok": False, "code": "INTERNAL", "message": "%s: %s" % (type(exc).__name__, _short(exc))}
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
