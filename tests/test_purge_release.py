# -*- coding: utf-8 -*-
"""16 号（真正的清除与腾空间）的 Python 侧：

1. 拓展包旧版本（previous）保留期：新版本收到成功回执后才开始计 7 天；未到期不删、到期删、回执没成功不删；
   「清理旧版本」（--force）不等保留期，但新版本没起来时旧版本是唯一退路，拒绝。
2. TTS worker 释放后，语音模型目录能删（Windows 上 worker 开着模型文件时目录删不掉）。

全部程序生成的夹具 + 临时目录，不碰真实数据目录。
"""
import contextlib
import io
import json
import os
import shutil
import sys
import time
import unittest
import zipfile

from helpers import ROOT, tmpdir

sys.path.insert(0, os.path.join(ROOT, "runtime"))

import pack_cli  # noqa: E402
from PIL import Image  # noqa: E402
from pixelpet.voice import VoiceError  # noqa: E402
from pixelpet.voice.deps import Dependencies, runtime_paths  # noqa: E402
from pixelpet.voice.tts import QwenTts, VoiceStore  # noqa: E402

PACK_ID = "petdev.prune-demo"
DAY = 24 * 3600


def png_bytes(size=(48, 32)):
    buf = io.BytesIO()
    Image.new("RGBA", size, (90, 140, 200, 255)).save(buf, "PNG")
    return buf.getvalue()


def build_pack(path, version):
    manifest = {"id": PACK_ID, "version": version, "name": "保留期测试包", "manifestVersion": 1, "packApi": 1, "license": "MIT",
                "permissions": [], "entryFurniture": {"id": "demo-desk", "dir": "furniture/demo-desk"}, "characterAdapters": []}
    furniture = {"id": "demo-desk", "name": "测试桌", "version": 1, "size": [48, 32], "anchor": "bottom-right", "defaultEnabled": True,
                 "idle": "idle", "states": {"idle": {"frames": ["sprites/idle_00.png"], "durationsMs": [800]}},
                 "interactions": [{"verb": "坐", "mode": "beside"}]}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        zf.writestr("furniture/demo-desk/furniture.json", json.dumps(furniture, ensure_ascii=False))
        zf.writestr("furniture/demo-desk/sprites/idle_00.png", png_bytes())
    return path


def cli(*argv):
    """进程内跑 pack_cli.main，返回最后一行 JSON 判决（便于换假时钟）。"""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        pack_cli.main(list(argv))
    lines = [x for x in out.getvalue().splitlines() if x.strip()]
    return json.loads(lines[-1])


class Prune(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir()
        self.clock = 1_800_000_000.0
        self._old_clock = pack_cli._clock
        pack_cli._clock = lambda: self.clock
        self.addCleanup(lambda: setattr(pack_cli, "_clock", self._old_clock))

    # ---- helpers
    def registry(self):
        with open(os.path.join(self.data, "packs", "registry.json"), encoding="utf-8") as f:
            return json.load(f)

    def entry(self):
        return self.registry()["packs"][PACK_ID]

    def store(self, version):
        return os.path.join(self.data, "packs", "store", "petdev", "prune-demo", version)

    def install(self, version):
        path = build_pack(os.path.join(self.data, "in-%s.petpack" % version), version)
        r = cli("install", "--data-dir", self.data, "--plugin-root", ROOT, "--pack", path, "--enable", "1")
        self.assertTrue(r["ok"], r)
        return r

    def receipt(self, ok=True, running=True):
        gen = self.registry()["generation"]
        return cli("receipt", "--data-dir", self.data, "--pack-id", PACK_ID, "--generation", str(gen),
                   "--pet-running", "1" if running else "0", "--ok-flag", "1" if ok else "0",
                   "--loaded", json.dumps({"furniture": ["demo-desk"] if ok else [], "characters": []}))

    def two_versions(self, receipt_ok=True, running=True):
        self.install("1.0.0")
        self.assertTrue(self.receipt()["ok"])
        self.assertEqual(self.entry()["state"], "enabled")
        self.install("1.1.0")
        self.assertEqual(self.entry()["previous"]["version"], "1.0.0")
        self.receipt(ok=receipt_ok, running=running)

    def prune(self, *extra):
        r = cli("prune-previous", "--data-dir", self.data, *extra)
        return r

    # ---- 保留期
    def test_clock_starts_only_after_a_successful_receipt(self):
        self.install("1.0.0")
        self.receipt()
        self.install("1.1.0")
        self.assertNotIn("previousExpiresAt", self.entry(), "新版本还没回执：不开始计时")
        self.assertEqual(self.prune()["pruned"], [])                       # 没有保留期记录 -> 不清
        self.receipt()
        self.assertEqual(self.entry()["previousExpiresAt"], int((self.clock + 7 * DAY) * 1000))
        self.clock += 3 * DAY
        self.receipt()                                                     # 再收一次回执不能把计时往后拖
        self.assertEqual(self.entry()["previousExpiresAt"], int((1_800_000_000.0 + 7 * DAY) * 1000))

    def test_not_expired_is_kept_then_expired_is_removed(self):
        self.two_versions()
        self.clock += 7 * DAY - 60
        r = self.prune()
        self.assertTrue(r["ok"]); self.assertEqual(r["pruned"], [])
        self.assertTrue(os.path.isdir(self.store("1.0.0")), "未到期：旧版本目录还在")
        self.assertEqual(self.entry()["previous"]["version"], "1.0.0")
        self.clock += 120
        before_gen = self.registry()["generation"]
        r = self.prune()
        self.assertEqual(r["pruned"], [PACK_ID]); self.assertEqual(r["leftovers"], [])
        self.assertFalse(os.path.exists(self.store("1.0.0")), "到期：旧版本目录删了")
        self.assertTrue(os.path.isdir(self.store("1.1.0")), "在役版本不动")
        e = self.entry()
        self.assertIsNone(e["previous"]); self.assertNotIn("previousExpiresAt", e)
        self.assertEqual(e["active"]["version"], "1.1.0"); self.assertEqual(e["state"], "enabled")
        self.assertEqual(self.registry()["generation"], before_gen, "在役指针没变，不改 generation")

    def test_failed_or_missing_receipt_never_starts_the_clock_so_nothing_is_removed(self):
        self.two_versions(receipt_ok=False)                                # 新版本加载失败（回执 ok=0）
        self.assertNotIn("previousExpiresAt", self.entry())
        self.assertEqual(self.entry()["state"], "load-failed")
        self.clock += 365 * DAY
        self.assertEqual(self.prune()["pruned"], [])
        self.assertTrue(os.path.isdir(self.store("1.0.0")))

    def test_pet_not_running_receipt_does_not_start_the_clock(self):
        self.two_versions(running=False)
        self.assertNotIn("previousExpiresAt", self.entry())
        self.clock += 365 * DAY
        self.assertEqual(self.prune()["pruned"], [])
        self.assertTrue(os.path.isdir(self.store("1.0.0")))

    def test_expired_but_new_version_failed_keeps_previous_as_the_only_way_back(self):
        self.two_versions()
        e = self.registry()
        e["packs"][PACK_ID]["previousExpiresAt"] = 1
        e["packs"][PACK_ID]["state"] = "load-failed"
        with open(os.path.join(self.data, "packs", "registry.json"), "w", encoding="utf-8") as f:
            json.dump(e, f)
        self.assertEqual(self.prune()["pruned"], [])
        self.assertEqual(self.prune()["kept"], [PACK_ID])
        self.assertTrue(os.path.isdir(self.store("1.0.0")))

    # ---- 用户点「清理旧版本」
    def test_force_prunes_right_away_for_one_pack(self):
        self.two_versions()
        self.assertTrue(os.path.isdir(self.store("1.0.0")))
        r = self.prune("--pack-id", PACK_ID, "--force", "1")
        self.assertEqual(r["pruned"], [PACK_ID])
        self.assertFalse(os.path.exists(self.store("1.0.0")))
        self.assertEqual(sorted(os.listdir(os.path.join(self.data, "packs", "store", "petdev", "prune-demo"))), ["1.1.0"])
        again = self.prune("--pack-id", PACK_ID, "--force", "1")           # 没有旧版本：幂等，不报错
        self.assertTrue(again["ok"]); self.assertEqual(again["pruned"], [])

    def test_force_is_refused_while_the_new_version_has_not_loaded(self):
        self.two_versions(receipt_ok=False)
        r = self.prune("--pack-id", PACK_ID, "--force", "1")
        self.assertFalse(r["ok"]); self.assertEqual(r["code"], "E_STATE_INVALID")
        self.assertTrue(os.path.isdir(self.store("1.0.0")))

    def test_a_new_update_restarts_the_clock_and_rollback_clears_it(self):
        self.two_versions()
        self.assertIn("previousExpiresAt", self.entry())
        self.install("1.2.0")                                              # 1.1.0 成为新的 previous
        self.assertEqual(self.entry()["previous"]["version"], "1.1.0")
        self.assertNotIn("previousExpiresAt", self.entry(), "新的 previous：计时重新开始，等新版本回执")
        self.assertFalse(os.path.exists(self.store("1.0.0")), "被挤出的更老版本照旧立刻回收")
        r = cli("rollback", "--data-dir", self.data, "--pack-id", PACK_ID)
        self.assertTrue(r["ok"])
        self.assertNotIn("previousExpiresAt", self.entry()); self.assertIsNone(self.entry()["previous"])

    def test_prune_only_touches_the_pack_store(self):
        self.two_versions()
        sentinel = os.path.join(self.data, "sentinel.txt")
        with open(sentinel, "w") as f:
            f.write("x")
        self.clock += 8 * DAY
        self.prune()
        self.assertTrue(os.path.isfile(sentinel))
        self.assertTrue(os.path.isfile(os.path.join(self.data, "packs", "registry.json")))


# ------------------------------------------------------------------------------------------ TTS worker 释放
HOLDING_WORKER = r'''
import json, os, sys
MARK = "@@pp "
model = sys.argv[sys.argv.index("--model-dir") + 1]
engine = sys.argv[sys.argv.index("--engine-dir") + 1]
held = [open(os.path.join(model, "weights.bin"), "rb"), open(os.path.join(engine, "engine.bin"), "rb")]   # 像真实 worker 一样一直开着模型文件
print(MARK + json.dumps({"event": "ready", "loadS": 0.01}), flush=True)
for line in sys.stdin:
    if json.loads(line).get("op") == "quit":
        break
'''


class WorkerRelease(unittest.TestCase):
    def test_model_dir_is_deletable_once_the_worker_is_released(self):
        data = tmpdir()
        script = os.path.join(data, "holding_worker.py")
        with open(script, "w", encoding="utf-8") as f:
            f.write(HOLDING_WORKER)
        paths = runtime_paths(data)
        for key in ("model", "engine"):
            os.makedirs(paths[key], exist_ok=True)
        for key, name in (("model", "weights.bin"), ("engine", "engine.bin")):
            with open(os.path.join(paths[key], name), "wb") as f:
                f.write(b"x" * 1024)
        deps = Dependencies(data, catalog={"components": []}, cache_dirs=[])
        tts = QwenTts(data, deps, VoiceStore(data, ROOT), worker=script, provider="ok", idle_s=0, load_timeout=20)
        try:
            tts.warm()
            self.assertIsNotNone(tts._proc, "worker 起来了（并且开着模型文件）")
            if os.name == "nt":
                with self.assertRaises(OSError):                           # 占着的时候删不掉：这正是 16 号要先停 worker 的原因
                    shutil.rmtree(paths["model"])
                self.assertTrue(os.path.isfile(os.path.join(paths["model"], "weights.bin")))
        finally:
            tts.close()
        self.assertIsNone(tts._proc)
        time.sleep(0.2)
        shutil.rmtree(paths["model"])
        shutil.rmtree(paths["engine"])
        self.assertFalse(os.path.exists(paths["model"])); self.assertFalse(os.path.exists(paths["engine"]))
        with self.assertRaises(VoiceError):                                # 关掉之后不会被唤醒回来
            tts._start()


if __name__ == "__main__":
    unittest.main()
