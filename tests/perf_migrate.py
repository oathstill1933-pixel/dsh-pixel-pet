"""Opt-in *native* CPU->DML migration probe in a fresh temporary dataDir.

python -X faulthandler tests/perf_migrate.py --cpu-site READ_ONLY_CPU_PYLIBS
Copies ONLY the public onnxruntime module/dist-info, not settings/voices/models. Pip writes solely to
our staging dataDir, no --user/uninstall. Fresh -I subprocesses verify real native imports and __file__.
The old rollback tree is retained intact. This does not migrate the running installation.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
from pixelpet.voice.deps import Dependencies, probe_target  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cpu-site", required=True)
    a = ap.parse_args()
    work = tempfile.mkdtemp(prefix="pixelpet-native-migration-")
    comp = {"id": "py-deps", "kind": "pip", "packages": ["onnxruntime-directml==1.24.4"],
            "modules": ["onnxruntime"], "want_ep": "DmlExecutionProvider",
            "conflicts": ["onnxruntime", "onnxruntime-directml", "onnxruntime-gpu"]}
    def pip(py, target, packages):
        subprocess.run([py, "-X", "faulthandler", "-m", "pip", "install", "--disable-pip-version-check",
                        "--no-input", "--only-binary=:all:", "--no-deps", "--target", target, "--upgrade"] + packages,
                       check=True)
    d = Dependencies(work, catalog=[comp], pip_runner=pip)
    target = d.pylibs(); os.makedirs(target)
    shutil.copytree(os.path.join(a.cpu_site, "onnxruntime"), os.path.join(target, "onnxruntime"))
    for n in os.listdir(a.cpu_site):
        if n.lower().startswith("onnxruntime-") and n.lower().endswith(".dist-info"):
            shutil.copytree(os.path.join(a.cpu_site, n), os.path.join(target, n))
    before = probe_target(target, comp)
    if before["missing"] or before["outside"] or "DmlExecutionProvider" in before["eps"]:
        raise RuntimeError("CPU source was not a usable CPU-only isolated module: " + str(before))
    d.install("py-deps")
    after = probe_target(target, comp)
    old = [n for n in os.listdir(os.path.dirname(target)) if ".old-" in n]
    result = {"dataDir": work, "before": before, "after": after, "installed": d.installed("py-deps"),
              "targetDistInfo": [n for n in os.listdir(target) if n.endswith(".dist-info")],
              "rollbackTrees": old, "oldPreserved": all(os.path.isdir(os.path.join(os.path.dirname(target), n, "onnxruntime")) for n in old)}
    out = os.path.join(work, "native-migration.json")
    with open(out, "w", encoding="utf8") as f: json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2)); print("RESULTS: " + out)
    assert not after["missing"] and not after["outside"] and "DmlExecutionProvider" in after["eps"]
    assert result["installed"] and len(old) == 1 and result["oldPreserved"]
    assert not any(n.lower().startswith("onnxruntime-") for n in result["targetDistInfo"])


if __name__ == "__main__": main()
