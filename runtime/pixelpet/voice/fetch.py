"""Resumable, verified file transfer for the voice components.

fetch_file(entry, dest) gets one catalog file ({url, sha256, size}) to `dest`:
  * already there with the right size and sha256 -> nothing to do
  * a local cache dir holds a file with the same name, size and sha256 -> copied from there
  * otherwise HTTP download into `dest.part`, resumed with a Range request when a partial exists;
    a server that ignores Range (200) restarts the file
  * the finished file must match sha256, otherwise the partial is deleted and IntegrityError raised

Only https sources are accepted (http only for loopback, which the tests use). Redirects follow the same
rule: a GitHub release asset answers 302 to its CDN host, and that hop must be https too — a redirect to
plain http (or any other scheme) is refused, so the sha256 check is never the only thing between a
downgrade and the disk.
"""
import fnmatch
import hashlib
import os
import shutil
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from urllib.parse import urlparse

CHUNK = 1 << 20
UA = "dsh-pixel-pet-voice/1"


class DownloadError(Exception):
    pass


class IntegrityError(DownloadError):
    pass


class SizeMismatch(IntegrityError):
    """The finished file has the wrong length (as opposed to the right length and the wrong sha256)."""


def check_url(url):
    u = urlparse(str(url or ""))
    if u.scheme == "https" and u.hostname:
        return url
    if u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost"):
        return url
    raise DownloadError("下载源只接受 https：%s" % url)


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects (GitHub release URLs 302 to a signed CDN URL) but only to allowed sources."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _default_open(req, timeout=60):
    return urllib.request.build_opener(_SafeRedirect()).open(req, timeout=timeout)


def sha256_file(path, progress=None):
    h = hashlib.sha256()
    done = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
            done += len(chunk)
            if progress:
                progress(done)
    return h.hexdigest()


def _good(path, size, sha):
    try:
        return os.path.getsize(path) == size and sha256_file(path) == sha
    except OSError:
        return False


def find_cached(entry, cache_dirs):
    rel = entry["path"].replace("\\", "/")
    for d in cache_dirs or ():
        for cand in (os.path.join(d, *rel.split("/")), os.path.join(d, os.path.basename(rel))):
            if os.path.isfile(cand) and os.path.getsize(cand) == entry["size"] and sha256_file(cand) == entry["sha256"]:
                return cand
    return None


def fetch_file(entry, dest, cache_dirs=(), progress=None, opener=None, retries=4, timeout=60, sleep=time.sleep):
    """-> 'present' | 'cache' | 'download'. progress(done_bytes, total_bytes)."""
    size, sha = int(entry["size"]), str(entry["sha256"]).lower()
    report = progress or (lambda done, total: None)
    if os.path.isfile(dest) and _good(dest, size, sha):
        report(size, size)
        return "present"
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    part = dest + ".part"
    cached = find_cached(entry, cache_dirs)
    if cached:
        with open(cached, "rb") as src, open(part, "wb") as out:
            done = 0
            for chunk in iter(lambda: src.read(CHUNK), b""):
                out.write(chunk)
                done += len(chunk)
                report(done, size)
        return _finish(part, dest, size, sha, "cache")

    url = check_url(entry["url"])
    if size == 0:                       # empty upstream files (package __init__.py) need no transfer
        open(part, "wb").close()
        return _finish(part, dest, size, sha, "download")
    open_url = opener or _default_open
    attempt = 0
    while True:
        have = os.path.getsize(part) if os.path.isfile(part) else 0
        if have > size:
            os.remove(part)
            have = 0
        if have == size:
            break
        headers = {"User-Agent": UA}
        if have:
            headers["Range"] = "bytes=%d-" % have
        try:
            resp = open_url(urllib.request.Request(url, headers=headers), timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:          # partial is stale or already complete: start clean
                os.remove(part)
                continue
            if e.code in (408, 429, 500, 502, 503, 504) and attempt < retries:
                attempt += 1
                sleep(min(30, 2 ** attempt))
                continue
            raise DownloadError("HTTP %s：%s" % (e.code, os.path.basename(dest)))
        except (urllib.error.URLError, OSError) as e:
            if attempt < retries:
                attempt += 1
                sleep(min(30, 2 ** attempt))
                continue
            raise DownloadError("连不上下载源：%s" % (getattr(e, "reason", None) or e))
        status = getattr(resp, "status", None) or resp.getcode()
        mode = "ab"
        if have and status != 206:
            have, mode = 0, "wb"
        try:
            with resp, open(part, mode) as out:
                done = have
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    report(min(done, size), size)
        except (urllib.error.URLError, OSError) as e:
            if attempt < retries:
                attempt += 1
                sleep(min(30, 2 ** attempt))
                continue
            raise DownloadError("下载中断：%s" % e)
        got = os.path.getsize(part)
        if got < size:
            if attempt < retries:
                attempt += 1
                continue
            raise DownloadError("下载不完整：%s" % os.path.basename(dest))
        break
    return _finish(part, dest, size, sha, "download")


def _finish(part, dest, size, sha, how):
    if os.path.getsize(part) != size:
        os.remove(part)
        raise SizeMismatch("校验不符：%s" % os.path.basename(dest))
    if sha256_file(part) != sha:
        os.remove(part)
        raise IntegrityError("校验不符：%s" % os.path.basename(dest))
    os.replace(part, dest)
    return how


def extract(zip_path, to_dir, include=("*",)):
    """Flat extract of members whose base name matches `include` (no paths from the archive are trusted)."""
    os.makedirs(to_dir, exist_ok=True)
    out = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = os.path.basename(info.filename.replace("\\", "/"))
            if not name or not any(fnmatch.fnmatch(name, p) for p in include):
                continue
            target = os.path.join(to_dir, name)
            with z.open(info) as src, open(target + ".tmp", "wb") as dst:
                shutil.copyfileobj(src, dst, CHUNK)
            os.replace(target + ".tmp", target)
            out.append(name)
    return out


def _safe_parts(name, strip):
    """Archive member -> path parts below the destination; None when it would escape or is not wanted."""
    rel = name.replace("\\", "/")
    if rel.startswith("/") or ":" in rel.split("/")[0]:
        return None
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    parts = parts[strip:]
    return parts or None


def extract_tar(tar_path, to_dir, strip=0, include=("*",)):
    """Extract a .tar/.tar.gz keeping its directory tree, dropping `strip` leading path components.

    Used by the portable Python runtime (a ~40 MB archive with thousands of files); every member is
    checked against `to_dir` so a malicious archive cannot write outside it. Symlinks and devices are
    skipped: the pinned build is a plain Windows tree.
    """
    os.makedirs(to_dir, exist_ok=True)
    base = os.path.abspath(to_dir)
    written = 0
    with tarfile.open(tar_path, "r:*") as tf:
        for m in tf:
            if not (m.isfile() or m.isdir()):
                continue
            parts = _safe_parts(m.name, strip)
            if parts is None:
                continue
            if m.isdir():
                os.makedirs(os.path.join(base, *parts), exist_ok=True)
                continue
            name = parts[-1]
            if not any(fnmatch.fnmatch(name, p) for p in include):
                continue
            target = os.path.join(base, *parts)
            if os.path.commonpath([base, os.path.abspath(target)]) != base:
                raise DownloadError("压缩包里有越界路径：%s" % m.name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                continue
            with src, open(target + ".tmp", "wb") as dst:
                shutil.copyfileobj(src, dst, CHUNK)
            os.replace(target + ".tmp", target)
            written += 1
    return written
