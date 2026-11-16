"""Voice actions the host runs (one JSON line on stdout at the end).

    python runtime/voice_cli.py deps
    python runtime/voice_cli.py install [--auto | ID ...]      (progress -> <data>/models/progress.json)
    python runtime/voice_cli.py download ID                    (same as install ID)
    python runtime/voice_cli.py clone REF [--name NAME] [--text TEXT]
    python runtime/voice_cli.py say TEXT [--voice ID] [--out FILE]
    python runtime/voice_cli.py voices
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _settings(data):
    try:
        with open(os.path.join(data, "settings.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main(argv=None):
    from pixelpet.app import default_data_dir
    from pixelpet.voice import VoiceError
    from pixelpet.voice.deps import Dependencies, NotConfigured
    from pixelpet.voice.fetch import DownloadError
    from pixelpet.voice.tts import VoiceStore, concat_wavs, make_tts, split_sentences
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("deps")
    sub.add_parser("voices")
    i = sub.add_parser("install")
    i.add_argument("ids", nargs="*")
    i.add_argument("--auto", action="store_true")
    d = sub.add_parser("download")
    d.add_argument("dep")
    c = sub.add_parser("clone")
    c.add_argument("ref")
    c.add_argument("--name")
    c.add_argument("--text", default="")
    s = sub.add_parser("say")
    s.add_argument("text")
    s.add_argument("--voice", default=None)
    s.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    data = a.data_dir or default_data_dir()
    deps = Dependencies(data)
    pack_root = os.path.dirname(HERE)
    try:
        if a.cmd == "deps":
            out = {"ok": True, "deps": deps.status(), "progress": deps.read_progress()}
        elif a.cmd == "voices":
            out = {"ok": True, "voices": VoiceStore(data, pack_root).list()}
        elif a.cmd in ("install", "download"):
            ids = [a.dep] if a.cmd == "download" else (a.ids or None)
            for x in ids or []:
                if x not in deps.catalog:
                    raise KeyError(x)
            t0 = time.time()
            done = deps.install_all(ids)
            out = {"ok": True, "installed": done, "seconds": round(time.time() - t0, 1)}
        elif a.cmd == "clone":
            vid = VoiceStore(data, pack_root).add(a.ref, a.name, a.text)
            if os.path.dirname(os.path.abspath(a.ref)) == os.path.join(os.path.abspath(data), "tmp"):
                try:                                     # the host's upload temp copy
                    os.remove(a.ref)
                except OSError:
                    pass
            out = {"ok": True, "voice": vid}
        else:
            tcfg = dict((_settings(data).get("voice") or {}).get("tts") or {})
            voice = a.voice or tcfg.get("voice") or "whale-girl"
            tts = make_tts(tcfg, data, deps, pack_root=pack_root, idle_s=0)
            t0 = time.time()
            try:
                wavs = [tts.synthesize(p, voice) for p in split_sentences(a.text)]
            finally:
                tts.close()
            if not wavs:
                raise ValueError("没有要念的文字")
            target = a.out or os.path.join(data, "tts-cache", "say-%d.wav" % int(time.time() * 1000))
            os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
            concat_wavs(wavs, target)
            out = {"ok": True, "wav": os.path.basename(target), "path": target, "seconds": round(time.time() - t0, 2)}
    except NotConfigured as exc:
        out = {"ok": False, "code": "not-configured", "message": str(exc)}
    except (DownloadError, VoiceError) as exc:
        out = {"ok": False, "message": str(exc)}
    except (KeyError, ValueError, FileNotFoundError, OSError) as exc:
        out = {"ok": False, "message": "%s: %s" % (type(exc).__name__, exc)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
