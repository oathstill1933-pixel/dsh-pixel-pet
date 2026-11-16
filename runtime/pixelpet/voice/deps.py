"""Voice components: the built-in TTS engine, its model and its Python packages.

The catalog (catalog.json, shared with the host) pins every file by URL, size and sha256. Components
marked `auto` are installed when the plugin is first enabled (the host runs `voice_cli.py install
--auto` in the background); the settings page shows progress and offers a retry.

Layout under the data dir:
    models/<component>/...        files of a `files` component, `.installed` once complete
    runtime/python/...            a `files` component with its own "dest" (the portable interpreter)
    models/progress.json          live progress for the settings page
    pylibs/py<maj><min>/          `pip install --target` of the `pip` component for this Python
Nothing is ever written into the plugin directory.
"""
import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
import time

from .fetch import DownloadError, extract, extract_tar, fetch_file

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "catalog.json"), encoding="utf-8") as _f:
    CATALOG = json.load(_f)


class NotConfigured(Exception):
    pass


def py_tag(version=None):
    v = version or sys.version_info
    return "py%d%d" % (v[0], v[1])


def component_rev(comp, platform=None):
    """Changes whenever the pinned file set changes, so a catalog update triggers a reinstall."""
    h = hashlib.sha256()
    for f in comp.get("files", []):
        h.update(("%s|%s|%s\n" % (f["path"], f["sha256"], f["size"])).encode())
    effective = for_platform(comp, platform)
    for p in effective.get("packages", []):
        h.update((p + "\n").encode())
    if effective.get("kind") == "pip":
        h.update(json.dumps({"installerSchema": 2, "conflicts": effective.get("conflicts", []),
                             "want_ep": effective.get("want_ep", "")}, sort_keys=True).encode())
    return h.hexdigest()[:16]


def for_platform(comp, platform=None):
    """Component with `platforms[<sys.platform>]` merged over the top-level keys.

    The built-in TTS needs onnxruntime with a DML provider on Windows (else CPU decode is 2x slower);
    every other platform keeps the plain onnxruntime wheel.
    """
    out = dict(comp)
    per = (comp.get("platforms") or {}).get(platform or sys.platform)
    if isinstance(per, dict):
        for k, v in per.items():
            if k in ("platforms", "id") or str(k).startswith("_"):
                continue
            out[k] = v
    return out


def default_cache_dirs():
    raw = os.environ.get("PIXELPET_MODEL_CACHE", "")
    return [d for d in raw.split(os.pathsep) if d and os.path.isdir(d)]


class Dependencies:
    def __init__(self, data_dir, catalog=None, cache_dirs=None, pip_runner=None, opener=None, platform=None):
        self.data_dir = data_dir
        self.root = os.path.join(data_dir, "models")
        cat = catalog if catalog is not None else CATALOG
        comps = cat["components"] if isinstance(cat, dict) else cat
        self.catalog = {c["id"]: dict(c) for c in comps}
        self.cache_dirs = default_cache_dirs() if cache_dirs is None else list(cache_dirs)
        self.pip_runner = pip_runner or _run_pip
        self.opener = opener
        self.platform = platform or sys.platform
        self.progress_file = os.path.join(self.root, "progress.json")

    # ------------------------------------------------------------------ paths / state
    def path(self, dep_id):
        """Where a component lives: `models/<id>`, or the component's own "dest" for the Python runtime."""
        dest = self.catalog[dep_id].get("dest")
        if dest:
            parts = [p for p in str(dest).replace("\\", "/").split("/") if p not in ("", ".")]
            if not parts or ".." in parts or ":" in parts[0]:
                raise NotConfigured("%s 的 dest 不合法：%s" % (dep_id, dest))
            return os.path.join(self.data_dir, *parts)
        return os.path.join(self.root, dep_id)

    def pylibs(self):
        return os.path.join(self.data_dir, "pylibs", py_tag())

    def _marker(self, dep_id):
        c = self.catalog[dep_id]
        if c.get("kind") == "pip":
            return os.path.join(self.pylibs(), ".installed-" + dep_id)
        return os.path.join(self.path(dep_id), ".installed")

    def installed(self, dep_id):
        try:
            with open(self._marker(dep_id), encoding="utf-8") as f:
                return json.load(f).get("rev") == component_rev(self.catalog[dep_id], self.platform)
        except (OSError, ValueError, KeyError):
            return False

    def files_for(self, dep_id):
        return [f for f in self.catalog[dep_id].get("files", []) if f.get("platform") in (None, self.platform)]

    def status(self):
        out = []
        for i, c in self.catalog.items():
            size = sum(f["size"] for f in self.files_for(i)) if c.get("kind") == "files" else c.get("size")
            out.append({"id": i, "kind": c.get("kind"), "title": c.get("title", i), "auto": bool(c.get("auto")),
                        "size": size, "installed": self.installed(i)})
        return out

    def require(self, dep_id):
        from . import DependencyMissing
        if not self.installed(dep_id):
            raise DependencyMissing(dep_id)
        return self.pylibs() if self.catalog[dep_id].get("kind") == "pip" else self.path(dep_id)

    def ready(self, ids=None):
        return all(self.installed(i) for i in (ids or [i for i, c in self.catalog.items() if c.get("auto")]))

    # ------------------------------------------------------------------ progress
    def _progress(self, **kw):
        os.makedirs(self.root, exist_ok=True)
        kw.setdefault("pid", os.getpid())
        kw["at"] = int(time.time() * 1000)
        tmp = self.progress_file + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(kw, f, ensure_ascii=False)
        os.replace(tmp, self.progress_file)

    def read_progress(self):
        try:
            with open(self.progress_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    # ------------------------------------------------------------------ install
    def install(self, dep_id, progress=None):
        if dep_id not in self.catalog:
            raise KeyError(dep_id)
        c = for_platform(self.catalog[dep_id], self.platform)
        if c.get("kind") == "pip":
            return self._install_pip(dep_id, c, progress)
        files = self.files_for(dep_id)
        if not files:
            raise NotConfigured("%s 还没有配置下载源" % dep_id)
        return self._install_files(dep_id, files, progress)

    def install_all(self, ids=None, progress=None):
        ids = ids or [i for i, c in self.catalog.items() if c.get("auto")]
        total = sum(sum(f["size"] for f in self.files_for(i)) for i in ids if self.catalog[i].get("kind") == "files")
        base = [0]
        done_ids = []
        try:
            for i in ids:
                if self.installed(i):
                    base[0] += sum(f["size"] for f in self.files_for(i))
                    done_ids.append(i)
                    continue

                def cb(**kw):
                    kw["overall"] = {"done": base[0] + kw.get("componentDone", 0), "total": total}
                    if progress:
                        progress(**kw)
                    self._progress(**kw)
                self.install(i, progress=cb)
                base[0] += sum(f["size"] for f in self.files_for(i))
                done_ids.append(i)
        except Exception as exc:
            self._progress(phase="failed", id=i, message=_short(exc), overall={"done": base[0], "total": total})
            raise
        self._progress(phase="done", ids=done_ids, overall={"done": total, "total": total})
        return done_ids

    def _install_files(self, dep_id, files, progress):
        dest_root = self.path(dep_id)
        os.makedirs(dest_root, exist_ok=True)
        report = progress or (lambda **kw: None)
        total = sum(f["size"] for f in files)
        base = 0
        for f in files:
            rel = f["path"].replace("\\", "/")
            if rel.startswith("/") or ".." in rel.split("/") or ":" in rel:
                raise DownloadError("清单里的路径不合法：%s" % rel)
            ex = f.get("extract") or {}
            kind = _archive_kind(ex)
            if kind == "tar":                       # a whole tree (portable Python): unpack it, then drop the archive
                target_dir = os.path.join(dest_root, *_parts(ex.get("to")))
                dest = os.path.join(self.downloads(dep_id), os.path.basename(rel))
            else:
                dest = os.path.join(dest_root, *rel.split("/"))

            def cb(done, size, _b=base, _rel=rel):
                report(phase="downloading", id=dep_id, file=_rel, done=done, total=size,
                       componentDone=_b + done, componentTotal=total)
            fetch_file(f, dest, cache_dirs=self.cache_dirs, progress=cb, opener=self.opener)
            if ex:
                report(phase="extracting", id=dep_id, file=rel, componentDone=base + f["size"], componentTotal=total)
                if kind == "tar":
                    extract_tar(dest, target_dir, strip=int(ex.get("strip", 0)), include=ex.get("include", ["*"]))
                    try:
                        os.remove(dest)
                    except OSError:
                        pass
                else:
                    target_dir = os.path.join(dest_root, *_parts(ex.get("to")))
                    extract(dest, target_dir, ex.get("include", ["*"]))
            base += f["size"]
        with open(os.path.join(dest_root, ".installed"), "w", encoding="utf-8") as fh:
            json.dump({"id": dep_id, "rev": component_rev(self.catalog[dep_id]), "at": int(time.time())}, fh)
        return dest_root

    def downloads(self, dep_id):
        """Scratch dir for archives that only exist to be unpacked (kept out of the installed tree)."""
        d = os.path.join(self.root, ".downloads", dep_id)
        os.makedirs(d, exist_ok=True)
        return d

    def missing_modules(self, comp):
        # Never import native packages into the installer: a cached CPU DLL would hide a new DML
        # install. An environment-global copy also cannot satisfy the plugin's isolated dependency.
        probe = probe_target(self.pylibs(), for_platform(comp, self.platform))
        return list(dict.fromkeys(probe["missing"] + probe["outside"]))

    def _install_pip(self, dep_id, comp, progress):
        """pip into an isolated staging copy, verify it in a *fresh* interpreter, then swap it in.

        Two Windows-flavoured traps this avoids:
          * importing the target's packages in this (installer) process poisons sys.modules and the
            native DLL search order, so a CPU onnxruntime keeps being reported after the wheel changed;
          * the running worker holds the old DLLs, so the old tree cannot be deleted — it is renamed
            away first, and a locked leftover is left alone instead of breaking the working install.
        """
        report = progress or (lambda **kw: None)
        target = self.pylibs()
        os.makedirs(target, exist_ok=True)
        packages = comp.get("packages", [])
        want_ep = comp.get("want_ep") or ""
        probe = probe_target(target, comp)
        missing = set(probe["missing"] + probe["outside"])
        # A CPU wheel imports perfectly but still needs replacing on Windows. Check distribution
        # metadata too: both wheels export the same module; they must never coexist in staging.
        provider_mismatch = bool(want_ep and want_ep not in probe["eps"])
        conflict = bool(_conflict_entries(target, comp, packages))
        if missing or provider_mismatch or conflict:
            wanted = [p for p in packages if _pkg_module(p) in missing
                      or ((provider_mismatch or conflict) and _pkg_module(p) == "onnxruntime")]
            wanted = wanted or list(packages)
            import tempfile
            staging = tempfile.mkdtemp(prefix=os.path.basename(target) + ".new-", dir=os.path.dirname(target))
            report(phase="pip", id=dep_id, file="stage " + " ".join(wanted), componentDone=0, componentTotal=0)
            try:
                _copytree(target, staging)
                dropped = _drop_conflicts(staging, comp, packages, replacing=wanted)
                if dropped:
                    report(phase="pip", id=dep_id, file="remove " + " ".join(dropped), componentDone=0, componentTotal=0)
                report(phase="pip", id=dep_id, file=" ".join(wanted), componentDone=0, componentTotal=0)
                self.pip_runner(sys.executable, staging, wanted)
                check = probe_target(staging, comp)
                if check["missing"]:
                    raise DownloadError("装完仍然导入不了：%s" % ", ".join(check["missing"]))
                if check["outside"]:
                    raise DownloadError("%s 不是从插件自己的目录加载的，安装被环境里的同名包挡住" % ", ".join(check["outside"]))
                if want_ep and check["eps"] and want_ep not in check["eps"]:
                    report(phase="pip", id=dep_id, file="no %s, CPU decode" % want_ep, componentDone=0, componentTotal=0)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
            _swap_in(target, staging)
            probe = probe_target(target, comp)
            if probe["missing"] or probe["outside"]:
                raise DownloadError("切换后校验失败：%s" % (", ".join(probe["missing"] + probe["outside"]) or "未知"))
        with open(self._marker(dep_id), "w", encoding="utf-8") as fh:
            json.dump({"id": dep_id, "rev": component_rev(comp, self.platform), "python": sys.version.split()[0],
                       "eps": probe["eps"], "at": int(time.time())}, fh)
        return target

    def execution_providers(self, comp):
        """ONNX Runtime execution providers of the installed wheel, asked in a fresh interpreter."""
        if "onnxruntime" not in comp.get("modules", []):
            return []
        return probe_target(self.pylibs(), comp)["eps"]

    def remove(self, dep_id):
        if self.catalog.get(dep_id, {}).get("kind") == "pip":
            try:
                os.remove(self._marker(dep_id))
            except OSError:
                pass
            return
        shutil.rmtree(self.path(dep_id), ignore_errors=True)


def _archive_kind(ex):
    """'tar' | 'zip' | '' — how an "extract" block should be unpacked."""
    kind = str(ex.get("archive") or "").lower()
    if kind in ("tar", "tar.gz", "tgz", "tar.xz", "tar.bz2"):
        return "tar"
    if kind == "zip":
        return "zip"
    return "zip" if ex else ""


def _dist_name(spec):
    import re
    return re.split(r"[\[><=!~;]", str(spec), maxsplit=1)[0].strip().lower().replace("-", "_").replace(".", "_")


def _pkg_module(spec):
    name = _dist_name(spec)
    return {"onnxruntime_directml": "onnxruntime", "onnxruntime_gpu": "onnxruntime"}.get(name, name)


def _parts(rel):
    """Catalog "to": a/b/c -> ['a', 'b', 'c'] (empty or '.' -> []), rejecting escapes."""
    parts = [p for p in str(rel or "").replace("\\", "/").split("/") if p not in ("", ".")]
    if ".." in parts or (parts and ":" in parts[0]):
        raise NotConfigured("清单里的路径不合法：%s" % rel)
    return parts


def _copytree(src, dst):
    """Copy a pylibs tree (best effort: a file that is locked is copied from its sibling, never fatal)."""
    shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.new-*", "*.old-*"))


def _swap_in(target, staging):
    """target -> target.old-<ts>, staging -> target; roll back on failure, keep a locked leftover."""
    import uuid
    old = target + ".old-" + uuid.uuid4().hex
    try:
        os.rename(target, old)
    except OSError as exc:
        raise DownloadError("旧依赖目录挪不开（可能有进程正占用）：%s" % exc)
    try:
        os.rename(staging, target)
    except OSError as exc:
        try:
            os.rename(old, target)
        except OSError:
            pass
        raise DownloadError("新依赖目录接管失败，已回滚：%s" % exc)
    # Keep the old tree intact: another running pet may still lazily load one of its DLLs or data
    # files. Do not recursively "clean" old/new sibling trees: they may belong to another installer.
    # Explicit maintenance after all consumers stop may remove these rollback trees.


def _conflict_entries(target, comp, packages):
    """Names of conflicting distributions and their shared import tree (staging-only deletion)."""
    keep = {_dist_name(p) for p in packages}
    conflicts = {_dist_name(p) for p in comp.get("conflicts") or []} - keep
    try:
        entries = os.listdir(target)
    except OSError:
        return []
    found = []
    for entry in entries:
        normalized = entry.lower().replace("-", "_").replace(".", "_")
        for dist in conflicts:
            if normalized.startswith(dist + "_") and normalized.endswith(("_dist_info", "_egg_info")):
                # Prefix alone would match onnxruntime_directml when checking onnxruntime. Extract
                # the distribution name before the version boundary instead.
                import re
                prefix = re.split(r"[-_]\d", entry.lower(), maxsplit=1)[0]
                if _dist_name(prefix) == dist:
                    found.append(entry)
                    break
    if found:
        modules = {_pkg_module(p) for p in conflicts}
        found += [e for e in entries if e in modules or e in {m + ".py" for m in modules}]
    return list(dict.fromkeys(found))


def _drop_conflicts(target, comp, packages, replacing=()):
    """Only called on our private staging copy; never uninstall from the live shared target."""
    dropped = _conflict_entries(target, comp, packages)
    # Also replace an unversioned shared module if its old dist-info is damaged/missing.
    if any(_pkg_module(p) == "onnxruntime" for p in replacing):
        dropped += [e for e in ("onnxruntime", "onnxruntime.py") if os.path.exists(os.path.join(target, e))]
    for entry in set(dropped):
        path = os.path.join(target, entry)
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    return sorted(set(dropped))


PROBE_CODE = r"""
import json, os, sys
target, spec = sys.argv[1], json.loads(sys.argv[2])
sys.path.insert(0, target)
base = os.path.normcase(os.path.realpath(target)) + os.sep
stdlib = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
out = {"modules": {}, "missing": [], "outside": [], "eps": [], "file": "", "python": sys.version.split()[0]}
for name in spec.get("modules") or []:
    try:
        mod = __import__(name)
        path = str(getattr(mod, "__file__", "") or "")
        out["modules"][name] = path
        if name in (spec.get("strict") or []) and name not in stdlib:
            if not os.path.normcase(os.path.realpath(path)).startswith(base):
                out["outside"].append(name)
    except Exception as exc:
        out["missing"].append(name)
        out["modules"][name] = "ERROR: %s: %s" % (type(exc).__name__, str(exc)[:120])
try:
    import onnxruntime as ort
    out["file"] = str(getattr(ort, "__file__", "") or "")
    out["eps"] = list(ort.get_available_providers())
except Exception as exc:
    out["ort_error"] = "%s: %s" % (type(exc).__name__, str(exc)[:120])
print(json.dumps(out))
"""


def probe_target(target, comp, strict=None, timeout=120):
    """Ask a fresh interpreter what `target` really provides.

    Same-process imports are useless here: this process may already hold the previous onnxruntime,
    and its DLLs are searched first. The child is isolated (-I) and only gets `target` prepended;
    `__file__` outside the target therefore proves the environment's own copy answered instead of ours.
    """
    modules = list(comp.get("modules") or [])
    spec = {"modules": modules, "strict": list(strict) if strict is not None else modules}
    empty = {"modules": {}, "missing": list(modules), "outside": [], "eps": [], "file": "", "python": ""}
    if not os.path.isdir(target):
        return empty
    try:
        r = subprocess.run([sys.executable, "-I", "-c", PROBE_CODE, target, json.dumps(spec)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        return empty
    if r.returncode != 0:
        return empty
    for line in reversed(r.stdout.decode("utf-8", "replace").strip().splitlines()):
        try:
            got = json.loads(line)
        except ValueError:
            continue
        if isinstance(got, dict) and "missing" in got:
            return got
    return empty


def _short(exc):
    return ("%s" % exc)[:200] if isinstance(exc, (DownloadError, NotConfigured)) else "%s: %s" % (type(exc).__name__, str(exc)[:180])


def _run_pip(python, target, packages):
    cmd = [python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
           "--target", target, "--upgrade"] + list(packages)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        tail = r.stdout.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise DownloadError("pip 安装失败：%s" % " | ".join(tail)[:300])


def runtime_paths(data_dir):
    """Where the worker finds the engine package, the model files and the extra Python packages."""
    return {"engine": os.path.join(data_dir, "models", "qwen3-tts-engine"),
            "model": os.path.join(data_dir, "models", "qwen3-tts-model"),
            "pylibs": os.path.join(data_dir, "pylibs", py_tag())}
