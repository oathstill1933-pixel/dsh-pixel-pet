"""Pre-publish privacy scan.

    python tools/privacy_scan.py [--private-dir DIR ...] [--json]

Scope = every file in the repo that .gitignore does not exclude (a superset of package.json `files`).
Checks:
  * absolute local paths (drive-letter paths, /Users/<name>, /home/<name>)
  * secrets: key/token/password literals, well-known key prefixes, long Bearer literals
  * e-mail addresses, mainland mobile numbers
  * private terms from tools/privacy_terms.local.txt (gitignored, one term per line; kept out of the
    published repo so the scanner itself does not leak them)
  * images byte-identical to anything under --private-dir (private art must not slip in)
  * package.json `files` must not reach any gitignored demo pack

Exit 0 when every hit is on the allowlist below (each with a reason), 1 otherwise.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERMS_FILE = os.path.join(ROOT, "tools", "privacy_terms.local.txt")
TEXT_EXT = {".py", ".js", ".mjs", ".ts", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ".cmd", ".ps1", ""}
BINARY_EXT = {".png", ".gif", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".flac", ".ogg"}

# Metadata-only exclusion: NEVER open a biometric/template/recording/clone path, even
# if someone accidentally copied one into the checkout. No hashing its bytes either.
PRIVATE_DIRS = {"voiceprint", "recordings", "voiceprints", "voices"}
PRIVATE_FILES = {"templates.bin", "ortho.bin", "entropy.bin", "secret.txt", "up-16k.pcm"}


def forbidden_path(path):
    parts = str(path).replace("\\", "/").lower().split("/")
    return any(p in PRIVATE_DIRS for p in parts) or parts[-1] in PRIVATE_FILES


RULES = [
    ("abs-path", re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[^\s\"'`<>|*?]+")),
    ("abs-path", re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+")),
    ("secret", re.compile(r"(?i)\b(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)\b\s*[:=]\s*[\"'][^\"'\s]{8,}[\"']")),
    ("secret", re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,})")),
    ("secret", re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}")),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
    ("phone", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
]

# (path glob, rule, exact match text or None = any text of that rule in those files, reason)
# Every entry is a reviewed false positive: synthetic fixtures that assert "this kind of string never leaks",
# third-party library data, or standard Windows locations.
ALLOW = [
    ("contracts/fixtures/packkit/*.json", "abs-path", None, "synthetic path in a cross-language conformance fixture"),
    ("packs-src/claude-girl/furniture/claude-book-bed/tools/build_sprites.py", "abs-path", None, "standard Windows system font path (C:/Windows/Fonts), not a user path"),
    ("scripts/audio-listen.test.mjs", "abs-path", None, "synthetic directories used to assert the audio-folder guard rejects roots, user dirs and UNC paths"),
    ("scripts/balance.test.mjs", "email", None, "fake credentials-in-URL string used to assert it is never logged"),
    ("scripts/claude-pack.test.mjs", "abs-path", None, "fake absolute bundled-pack path asserting the catalog rejects it"),
    ("scripts/follow.test.mjs", "abs-path", None, "fake path used to assert pointer-file validation"),
    ("scripts/music-tools.test.mjs", "abs-path", None, "fake track path asserting it never reaches the AI tool result"),
    ("scripts/music.test.mjs", "abs-path", None, "fake local-file path asserting paths are not leaked in snapshots"),
    ("scripts/proactive.test.mjs", "abs-path", None, "drive-letter prefix asserting wake-up texts and logs contain no paths"),
    ("scripts/purge.test.mjs", "abs-path", None, "fixture song path inside a temporary data directory"),
    ("scripts/reading.test.mjs", "abs-path", None, "fake document paths asserting ids / logs do not contain them"),
    ("scripts/session-guard.test.mjs", "abs-path", None, "fake session working directory"),
    ("tests/test_activity.py", "abs-path", None, "fake executable paths asserting only categories are recorded"),
    ("tests/test_card_dock.py", "abs-path", None, "fake executable path for the dock tests"),
    ("tests/test_long_route.py", "secret", None, "synthetic launch key asserting it is never echoed"),
    ("tests/test_reading_win.py", "abs-path", None, "fake path for the reading-window tests"),
    ("vendor/lunar-javascript/lunar.js", "phone", None, "third-party calendar data table: eleven-digit numbers are lunar/solar-term constants, not phone numbers"),
    ("web/reading/vendor/pdfjs/build/*.mjs", "abs-path", None, "third-party minified PDF.js: Emscripten virtual path /home/web_user"),
    ("web/reading/vendor/pdfjs/build/*.mjs", "email", None, "third-party minified PDF.js: string constant that looks like an e-mail"),
    ("web/reading/vendor/pdfjs/wasm/*.js", "abs-path", None, "third-party Emscripten glue: virtual path /home/web_user"),
    ("tools/privacy_scan.py", "abs-path", None, "the allowlist entries above quote the paths they excuse"),
    ("scripts/mail.test.mjs", "abs-path", "d:\\d\\d:\\d\\d\\.\\d{3}Z$/)", "regex for an ISO timestamp (\\d:\\d\\d) that only looks like a drive path"),
    # private-term matches are case-insensitive substrings: third-party identifiers that merely contain the letters
    ("vendor/ical.js/ical.es5.cjs", "private-term", None, "third-party identifier isLeapYear contains the letters, not a name"),
    ("vendor/lunar-javascript/lunar.js", "private-term", None, "third-party identifier isLeapYear contains the letters, not a name"),
    ("web/reading/vendor/pdfjs/web/pdf_viewer.mjs", "private-term", None, "third-party identifier hiddenCopyElement contains the letters, not a name"),
    ("web/reading/vendor/pdfjs/build/pdf.worker.min.mjs", "private-term", None, "third-party data: Korean glyph names (kapyeoun...) and a float constant (.8777)"),
    # the CLAP model folder %LOCALAPPDATA%\pye-music is a real on-disk location; renaming it needs a data migration (kept on purpose)
    ("lib/music.js", "private-term", "pye", "CLAP model folder name pye-music (real on-disk location, kept on purpose)"),
    ("lib/purge.js", "private-term", "pye", "CLAP model folder name pye-music (real on-disk location, kept on purpose)"),
    ("runtime/music/pixelmusic/clap.py", "private-term", "pye", "CLAP model folder name pye-music (real on-disk location, kept on purpose)"),
    ("README.md", "private-term", "pye", "documents the CLAP model folder pye-music"),
    ("docs/MUSIC_CONTRACT.md", "private-term", "pye", "documents the CLAP model folder pye-music"),
    ("PUBLISH-EXCLUDE.md", "private-term", "pye", "documents the CLAP model folder pye-music"),
    ("scripts/purge.test.mjs", "private-term", "pye", "fixture mirroring the CLAP model folder pye-music"),
    ("tests/test_music_hear.py", "private-term", "pye", "docstring naming the CLAP folder's venv pye-music"),
    ("tools/privacy_scan.py", "private-term", None, "the allowlist entries above quote the strings they excuse"),
]


def gitignore_patterns():
    pats = []
    try:
        with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    pats.append(line)
    except OSError:
        pass
    return pats


def ignored(rel, pats):
    parts = rel.split("/")
    for p in pats:
        dir_only = p.endswith("/")
        pat = p.rstrip("/")
        for i in range(len(parts)):
            sub = "/".join(parts[:i + 1])
            is_dir = i < len(parts) - 1
            if dir_only and not is_dir:
                continue
            if fnmatch.fnmatch(sub, pat) or ("/" not in pat and fnmatch.fnmatch(parts[i], pat)):
                return True
    return False


def scope(pats):
    out = []
    for dp, dns, fns in os.walk(ROOT):
        rel_dir = os.path.relpath(dp, ROOT).replace("\\", "/")
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        # Report forbidden directory metadata, but never descend or read a member.
        for d in dns:
            if forbidden_path(rel_dir + d) and not ignored(rel_dir + d + "/x", pats):
                out.append(rel_dir + d + "/")
        dns[:] = [d for d in dns if d != ".git" and not forbidden_path(rel_dir + d) and not ignored(rel_dir + d + "/x", pats)]
        for fn in fns:
            rel = rel_dir + fn
            if not ignored(rel, pats):
                out.append(rel)
    return sorted(out)


def load_terms():
    try:
        with open(TERMS_FILE, encoding="utf-8") as f:
            return [t.strip() for t in f if t.strip() and not t.startswith("#")]
    except OSError:
        return []


def private_hashes(dirs):
    hs = {}
    for d in dirs:
        if forbidden_path(d):
            raise ValueError("refusing private voiceprint/recording/voice content")
        for dp, dns, fns in os.walk(d):
            dns[:] = [n for n in dns if not forbidden_path(os.path.join(dp, n))]
            for fn in fns:
                if forbidden_path(os.path.join(dp, fn)):
                    continue
                if os.path.splitext(fn)[1].lower() in BINARY_EXT:
                    p = os.path.join(dp, fn)
                    with open(p, "rb") as f:
                        hs[hashlib.sha256(f.read()).hexdigest()] = fn
    return hs


def allowed(rel, rule, text):
    for glob, r, exact, reason in ALLOW:
        if r == rule and (exact is None or text == exact) and fnmatch.fnmatch(rel, glob):
            return reason
    return None


def scan(private_dirs=(), public_only=False):
    pats = gitignore_patterns()
    files = scope(pats)
    terms = [] if public_only else load_terms()
    term_res = [("private-term", re.compile(re.escape(t), re.I)) for t in terms]
    phash = {} if public_only else private_hashes(private_dirs)
    hits = []
    for rel in files:
        if forbidden_path(rel):
            hits.append({"file": rel, "line": 0, "rule": "private-voice-path", "text": "metadata only; contents not opened", "allowed": None})
            continue
        if rel == "tools/privacy_terms.local.txt":
            continue
        path = os.path.join(ROOT, rel)
        ext = os.path.splitext(rel)[1].lower()
        if os.path.islink(path):
            hits.append({"file": rel, "line": 0, "rule": "private-link", "text": "symlink content not opened", "allowed": None})
            continue
        if ext in BINARY_EXT:
            with open(path, "rb") as f:
                h = hashlib.sha256(f.read()).hexdigest()
            if h in phash:
                hits.append({"file": rel, "line": 0, "rule": "private-asset", "text": phash[h], "allowed": None})
            continue
        if ext not in TEXT_EXT:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except UnicodeDecodeError:
            continue
        for n, line in enumerate(lines, 1):
            for rule, rx in RULES + term_res:
                for m in rx.finditer(line):
                    hits.append({"file": rel, "line": n, "rule": rule, "text": m.group(0)[:80],
                                 "allowed": allowed(rel, rule, m.group(0))})
    # package.json `files` must not reach ignored content
    try:
        with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
            pkg_files = json.load(f).get("files", [])
    except (OSError, ValueError):
        pkg_files = []
    for entry in pkg_files:
        e = entry.rstrip("/")
        for base in ("characters", "furniture"):
            if e in (base, base + "/*", base + "/**"):
                hits.append({"file": "package.json", "line": 0, "rule": "publish-scope",
                             "text": entry + " 会把 demo 包带进发布", "allowed": None})
    return files, terms, hits


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-dir", action="append", default=[])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--public-only", action="store_true", help="do not read private terms or hash private directories")
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    files, terms, hits = scan(a.private_dir, public_only=a.public_only)
    bad = [h for h in hits if not h["allowed"]]
    if a.json:
        print(json.dumps({"files": len(files), "terms": len(terms), "hits": hits}, ensure_ascii=False, indent=2))
    else:
        print("扫描 %d 个发布范围内文件；私有词表 %d 条；私有素材比对目录 %d 个" % (len(files), len(terms), len(a.private_dir)))
        for h in hits:
            tag = "允许" if h["allowed"] else "命中"
            print("  [%s] %s:%s  %s  %s%s" % (tag, h["file"], h["line"], h["rule"], h["text"],
                                             ("  — " + h["allowed"]) if h["allowed"] else ""))
        print("结果：%d 命中，%d 条已说明允许" % (len(bad), len(hits) - len(bad)))
    if not terms:
        print("注意：没有私有词表 tools/privacy_terms.local.txt，私有字样未检查", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
