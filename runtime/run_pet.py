"""Start the pixel pet.

    python runtime/run_pet.py [--character ID] [--data-dir DIR]
    python runtime/run_pet.py --character whale-girl --selftest --offscreen --exit-after 20 --report out.json

--selftest drives the real control endpoint over HTTP (status / pose / look / mood / say / furniture /
use / walk / voice / stop), writes a JSON report and exits. --offscreen keeps every window off the
visible desktop. --exit-after is a hard stop so nothing stays resident.
"""
import argparse
import json
import os
import sys
import threading
import time

# The pet's only numeric work is a small echo-guard FFT. OpenBLAS reserves a thread buffer pool per
# core and numpy is loaded lazily, so this has to be set before the first numpy import — doing it here
# means a hand-started `python runtime/run_pet.py` gets the same low-commit behaviour as the plugin's
# start (which also passes it in the environment). An explicit user value wins.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)


def selftest(app, report, done):
    from pixelpet.control import send
    info = os.path.join(app.data_dir, "control.json")
    steps = []

    def step(name, body, check=lambda r: r.get("ok")):
        try:
            r = send(info, body)
        except Exception as exc:  # noqa: BLE001
            r = {"ok": False, "message": "%s: %s" % (type(exc).__name__, exc)}
        steps.append({"name": name, "ok": bool(check(r)), "reply": r})
        return r

    for _ in range(100):
        if os.path.isfile(info):
            break
        time.sleep(.05)
    step("status", {"cmd": "status"}, lambda r: r.get("ok") and r["data"]["character"] == app.char.id)
    step("pose-lie", {"cmd": "pose", "name": "lie", "holdMs": 700})
    time.sleep(.4)
    step("look-up", {"cmd": "look", "target": "up", "holdMs": 600}, lambda r: r.get("ok") or not app.char.look_frames)
    if app.char.moods:
        step("mood", {"cmd": "mood", "tag": next(iter(app.char.moods)), "seconds": 1})
    step("say", {"cmd": "say", "text": "selftest", "seconds": 1})
    step("bad-cmd-refused", {"cmd": "nope"}, lambda r: r.get("ok") is False)
    fr = step("furniture", {"cmd": "furniture"}, lambda r: r.get("ok") and isinstance(r.get("data"), list))
    for item in (fr.get("data") or [])[:1]:
        verbs = [i["verb"] for i in item["interactions"]]
        if "sleep" in verbs:
            step("use-sleep", {"cmd": "use", "id": item["id"], "verb": "sleep", "timeoutS": 10},
                 lambda r: r.get("ok"))
            time.sleep(1.0)
            step("inside", {"cmd": "status"}, lambda r: r["data"]["inside"] == item["id"])
        if "wake" in verbs:
            step("use-wake", {"cmd": "use", "id": item["id"], "verb": "wake"})
    step("walk", {"cmd": "walk", "dx": -120, "timeoutS": 10})
    step("voice-status", {"cmd": "voice", "action": "status"}, lambda r: r.get("ok") and r["data"]["state"] in
         ("idle", "listening", "thinking", "speaking"))
    step("hub-expand", {"cmd": "hub", "action": "expand"}, lambda r: r.get("ok") and r["data"]["collapsed"] is False)
    step("hub-collapse", {"cmd": "hub", "action": "collapse"}, lambda r: r.get("ok") and r["data"]["collapsed"] is True)
    step("stop", {"cmd": "stop"})
    report["steps"] = steps
    done.set()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--character")
    ap.add_argument("--data-dir")
    ap.add_argument("--pack-root", default=ROOT)
    ap.add_argument("--offscreen", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--exit-after", type=float, default=0)
    ap.add_argument("--speed", type=float, default=120.0)
    ap.add_argument("--report")
    a = ap.parse_args(argv)

    import tkinter as tk
    from pixelpet.app import PetApp
    from pixelpet.character import PackError

    root = tk.Tk()
    try:
        app = PetApp(root, a.pack_root, data_dir=a.data_dir, character=a.character, offscreen=a.offscreen,
                     speed=4000.0 if a.selftest else a.speed)
    except PackError as exc:
        root.destroy()
        print(exc, file=sys.stderr)
        return 3
    report = {"character": app.char.id, "furniture": list(app.furniture_defs), "furnitureErrors": app.furniture_errors}
    done = threading.Event()
    started = time.time()
    if a.selftest:
        threading.Thread(target=selftest, args=(app, report, done), daemon=True).start()

    def watchdog():
        if app._closed:
            return
        if (a.selftest and done.is_set()) or (a.exit_after and time.time() - started > a.exit_after):
            report["timedOut"] = a.selftest and not done.is_set()
            report["seenStates"] = sorted(app.seen_states)
            report["framesDrawn"] = app.frames_drawn
            app.quit()
            return
        root.after(100, watchdog)
    root.after(100, watchdog)
    root.mainloop()
    report["elapsedS"] = round(time.time() - started, 2)
    if a.report:
        with open(a.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    if a.selftest:
        ok = not report.get("timedOut") and all(s["ok"] for s in report.get("steps", []))
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
