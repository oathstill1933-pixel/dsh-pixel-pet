"""Opt-in isolated real TTS benchmark; never reads settings, user voices or voiceprints.

Use an existing interpreter, public model/engine files and dependency directory READ-ONLY:
  python -X faulthandler tests/perf_voice.py --python PY --engine-dir ENGINE --model-dir MODEL --pylibs LIBS
Optional --dml-pylibs ISOLATED_LIBS adds a separate DirectML comparison. This script installs nothing,
starts only its own sequential workers, uses ONLY the licensed shipped whale-girl preset, and writes
its WAVs/state/logs/results to a fresh temporary directory. It does not play any audio or bind a port.
No production restarts. Provider/session verification, real memory and bit-exact cache A/B are recorded.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from pixelpet.voice.tts import QwenTts, VoiceStore  # noqa: E402
from pixelpet.voice.deps import CATALOG  # noqa: E402


class PublicDeps:
    catalog = {c["id"]: c for c in CATALOG["components"]}
    def ready(self): return True
    def installed(self, name): return True


def snapshot(pid):
    """Windows Toolhelp tree + GetProcessMemoryInfo (pointer-width-safe, no extra dependency)."""
    import ctypes as C
    from ctypes import wintypes as W
    class Entry(C.Structure):
        _fields_ = [("dwSize", W.DWORD), ("cntUsage", W.DWORD), ("pid", W.DWORD),
                    ("heap", C.c_size_t), ("module", W.DWORD), ("threads", W.DWORD),
                    ("parent", W.DWORD), ("priority", W.LONG), ("flags", W.DWORD), ("exe", C.c_char * 260)]
    class Counters(C.Structure):
        _fields_ = [("cb", W.DWORD), ("faults", W.DWORD)] + [(n, C.c_size_t) for n in
                    ("peak_ws", "ws", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "commit", "peak_commit")]
    k, p = C.windll.kernel32, C.windll.psapi
    k.CreateToolhelp32Snapshot.restype = W.HANDLE
    k.OpenProcess.restype = W.HANDLE
    k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    k.CloseHandle.argtypes = [W.HANDLE]
    k.GetProcessTimes.argtypes = [W.HANDLE] + [C.POINTER(W.FILETIME)] * 4
    def created(handle):
        times = [W.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(handle, *(C.byref(t) for t in times)): return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    k.Process32First.argtypes = [W.HANDLE, C.POINTER(Entry)]
    k.Process32Next.argtypes = [W.HANDLE, C.POINTER(Entry)]
    p.GetProcessMemoryInfo.argtypes = [W.HANDLE, C.POINTER(Counters), W.DWORD]
    parents = {}
    h = k.CreateToolhelp32Snapshot(2, 0)
    try:
        e = Entry(); e.dwSize = C.sizeof(e)
        more = k.Process32First(h, C.byref(e))
        while more:
            parents.setdefault(e.parent, []).append(int(e.pid))
            more = k.Process32Next(h, C.byref(e))
    finally:
        k.CloseHandle(h)
    rows, seen = [], set()
    def walk(n, parent_created=0):
        if n in seen: return
        seen.add(n)
        h = k.OpenProcess(0x410, False, n)
        if not h: return
        try:
            born = created(h)
            # ParentProcessId outlives the parent. A new worker can reuse an old ancestor's PID;
            # never count or later report those unrelated older processes as our worker's children.
            if born is None or born < parent_created: return
            c = Counters(); c.cb = C.sizeof(c)
            if p.GetProcessMemoryInfo(h, C.byref(c), c.cb):
                rows.append({"pid": n, "createdTicks": born, "workingSetMiB": round(c.ws / 1048576, 2),
                             "commitMiB": round(c.commit / 1048576, 2)})
        finally:
            k.CloseHandle(h)
        for child in parents.get(n, []): walk(child, born)
    walk(pid)
    return {"processes": rows, "workingSetMiB": round(sum(r["workingSetMiB"] for r in rows), 2),
            "commitMiB": round(sum(r["commitMiB"] for r in rows), 2)}


def mem_of(pid):
    """Compatibility API: (working set, commit) MiB for this exact process, or None."""
    rows = snapshot(pid)["processes"]
    own = next((r for r in rows if r["pid"] == pid), None)
    return (own["workingSetMiB"], own["commitMiB"]) if own else None


def tree_mem(pid):
    """Compatibility API; creation-time filtering prevents PID-reuse contamination."""
    data = snapshot(pid)
    return {"ws": data["workingSetMiB"], "commit": data["commitMiB"], "procs": len(data["processes"])}


def pcm_digest(path):
    with wave.open(path, "rb") as w:
        pcm = w.readframes(w.getnframes())
        return {"sha256": hashlib.sha256(pcm).hexdigest(), "frames": w.getnframes(),
                "rate": w.getframerate(), "seconds": round(w.getnframes() / w.getframerate(), 3)}


def bench(a, work, provider, pylibs):
    result = {"providerRequested": provider, "runs": []}
    shared = os.path.join(work, provider)
    os.makedirs(shared)
    for index in range(2):
        t = QwenTts(shared, PublicDeps(), VoiceStore(shared, ROOT), python=a.python,
                    provider=provider, idle_s=0, env={"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
                    "PYTHONPATH": os.pathsep.join([pylibs, a.pylibs])})
        t.paths = {"engine": a.engine_dir, "model": a.model_dir, "pylibs": pylibs}
        row = {"cacheExpected": bool(index), "sentences": []}
        owned = []
        try:
            start = time.perf_counter(); t.warm()
            row.update(loadWallS=round(time.perf_counter() - start, 3), ready=t._ready, pid=t._proc.pid)
            row["afterLoad"] = snapshot(t._proc.pid)
            owned = row["afterLoad"]["processes"]
            for text in ("你好呀，我在这儿呢。", "今天的天气挺不错的，要不要出去走走？",
                         "我把你说的事情记下来了，等你有空的时候我们再慢慢聊这个事儿。"):
                start = time.perf_counter(); wav = t.synthesize(text, "whale-girl", seed=42)
                elapsed = time.perf_counter() - start
                audio = pcm_digest(wav)
                row["sentences"].append({"text": text, "wallS": round(elapsed, 3),
                    "worker": t.last_stats, "pcm": audio, "rtf": round(elapsed / audio["seconds"], 3)})
            row["afterSynth"] = snapshot(t._proc.pid)
        except Exception as exc:
            row["error"] = "%s: %s" % (type(exc).__name__, exc)
        finally:
            t.close()
            # Only inspect PIDs owned by our worker; report failures, never kill foreign processes.
            row["ownedPids"] = [p["pid"] for p in owned]
            row["workerReaped"] = t._proc is None
            row["ownedStillAlive"] = []
            for child in owned:
                check = snapshot(child["pid"])["processes"]
                if check and check[0]["createdTicks"] == child["createdTicks"]:
                    row["ownedStillAlive"].append(child["pid"])
        result["runs"].append(row)
        print(json.dumps({"provider": provider, "run": index, **row}, ensure_ascii=False), flush=True)
    runs = result["runs"]
    if all(len(r["sentences"]) == 3 for r in runs):
        result["sameSeedPcmEqual"] = [x["pcm"] == y["pcm"] for x, y in zip(runs[0]["sentences"], runs[1]["sentences"])]
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--engine-dir", required=True)
    p.add_argument("--model-dir", required=True)
    p.add_argument("--pylibs", required=True)
    p.add_argument("--dml-pylibs")
    a = p.parse_args()
    for path in (a.engine_dir, a.model_dir, a.pylibs):
        if not os.path.isdir(path): p.error("missing directory: " + path)
    work = tempfile.mkdtemp(prefix="pixelpet-public-perf-")
    print("isolated output: " + work, flush=True)
    results = [bench(a, work, "cpu", a.pylibs)]
    if a.dml_pylibs:
        results.append(bench(a, work, "dml", a.dml_pylibs))
    out = os.path.join(work, "results.json")
    with open(out, "w", encoding="utf-8") as f: json.dump(results, f, ensure_ascii=False, indent=2)
    print("RESULTS: " + out, flush=True)
    return int(any("error" in r for c in results for r in c["runs"]))


if __name__ == "__main__":
    raise SystemExit(main())
