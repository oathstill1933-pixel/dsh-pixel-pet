# -*- coding: utf-8 -*-
"""M1 审查修复回归：权限门、同版异哈希（含 previous）、原子入库、崩溃恢复清扫、进程锁、
Windows 解包名、v1 注册表迁移、卸载残留/旧 previous 回收、.incoming 规范化前缀。"""
import json
import os
import sys
import time
import unicodedata
import unittest

from helpers import ROOT  # noqa: E402
from test_pack_store import Base, build_petpack, run_cli, sha  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "runtime"))

PID = "petdev.store-demo"


class M1Base(Base):
    def store(self, ver=None):
        base = os.path.join(self.data, "packs", "store", "petdev", "store-demo")
        return os.path.join(base, ver) if ver else base

    def pk(self):
        from pixelpet import packkit
        return packkit


class PermissionGate(M1Base):
    def test_confirm_permission_waits_then_grant_then_disable(self):
        pack = build_petpack(os.path.join(self.data, "p.petpack"), manifest={"permissions": ["docs.read", "playback.status"]})
        _code, v = self.install(pack, extra=("--enable", "1"))
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["state"], "waiting-authorization")
        self.assertFalse(v["load"])
        e = self.registry()["packs"][PID]
        self.assertEqual(e["grantedPermissions"], ["playback.status"])  # 无需确认的随装随记
        self.assertEqual(e["pendingPermissions"], ["docs.read"])
        self.assertEqual(self.pk().pack_furniture_roots(self.data), [])  # defaultEnabled:true 也不加载
        _c, g = run_cli("grant", "--data-dir", self.data, "--pack-id", PID)
        self.assertTrue(g["ok"], g)
        self.assertEqual(g["state"], "installed-disabled")
        self.assertTrue(g["load"])
        self.assertEqual(sorted(g["grantedPermissions"]), ["docs.read", "playback.status"])
        self.assertEqual(len(self.pk().pack_furniture_roots(self.data)), 1)
        _c, d = run_cli("disable", "--data-dir", self.data, "--pack-id", PID)
        self.assertTrue(d["ok"] and not d["load"])
        self.assertEqual(self.pk().pack_furniture_roots(self.data), [])

    def test_plain_install_lands_disabled(self):
        _c, v = self.install(build_petpack(os.path.join(self.data, "p.petpack")))
        self.assertEqual((v["state"], v["load"]), ("installed-disabled", False))
        self.assertEqual(self.pk().pack_furniture_roots(self.data), [])

    def test_enable_without_confirm_permission_loads_at_once(self):
        _c, v = self.install(build_petpack(os.path.join(self.data, "p.petpack")), extra=("--enable", "1"))
        self.assertEqual(v["state"], "installed-disabled")
        self.assertTrue(v["load"])
        self.assertEqual(v["furnitureIds"], ["demo-desk"])

    def test_update_adding_permission_pauses_new_keeps_old(self):
        self.install(build_petpack(os.path.join(self.data, "a.petpack")), extra=("--enable", "1"))
        _c, v = self.install(build_petpack(os.path.join(self.data, "b.petpack"),
                                           manifest={"version": "1.1.0", "permissions": ["screen.capture"]}))
        self.assertEqual(v["state"], "waiting-authorization")
        self.assertEqual(v["loadVersion"], "1.0.0")
        roots = self.pk().pack_furniture_roots(self.data)
        self.assertEqual([os.path.basename(r) for r in roots], ["1.0.0"])

    def test_v1_registry_is_migrated_without_auto_confirm(self):
        os.makedirs(self.store("1.0.0"))
        os.makedirs(os.path.join(self.data, "packs"), exist_ok=True)
        reg = {"v": 1, "generation": 3, "packs": {PID: {"active": {
            "id": PID, "version": "1.0.0", "dir": "petdev/store-demo/1.0.0", "sha256": "a" * 64,
            "permissions": ["docs.read"], "furnitureIds": ["demo-desk"], "status": "active", "receipt": None},
            "previous": None}}}
        with open(os.path.join(self.data, "packs", "registry.json"), "w", encoding="utf-8") as f:
            json.dump(reg, f)
        r, err = self.pk().read_registry_lenient(self.data)
        self.assertIsNone(err)
        self.assertEqual(r["packs"][PID]["state"], "waiting-authorization")
        self.assertEqual(self.pk().pack_furniture_roots(self.data), [])
        _c, g = run_cli("grant", "--data-dir", self.data, "--pack-id", PID)
        self.assertTrue(g["ok"], g)
        self.assertEqual(self.registry()["v"], 2)
        self.assertEqual(self.registry()["generation"], 4)
        self.assertTrue(os.path.isdir(self.store("1.0.0")))  # 迁移 + 清扫没动被引用目录

    def test_illegal_transition_is_refused(self):
        self.install(build_petpack(os.path.join(self.data, "p.petpack"), manifest={"permissions": ["docs.read"]}))
        # waiting-authorization 不接受 load-receipt-fail → rollback 报 E_STATE_INVALID
        _c, v = run_cli("rollback", "--data-dir", self.data, "--pack-id", PID)
        self.assertEqual(v.get("code"), "E_STATE_INVALID")

    def test_registry_unknown_state_refused_by_writer(self):
        os.makedirs(os.path.join(self.data, "packs"), exist_ok=True)
        with open(os.path.join(self.data, "packs", "registry.json"), "w", encoding="utf-8") as f:
            json.dump({"v": 2, "generation": 1, "packs": {PID: {"state": "active", "active": None}}}, f)
        _c, v = self.install(build_petpack(os.path.join(self.data, "p.petpack")))
        self.assertEqual(v.get("code"), "E_REGISTRY_INVALID")


class SameVersion(M1Base):
    def test_conflict_against_previous(self):
        self.install(build_petpack(os.path.join(self.data, "a.petpack")), extra=("--enable", "1"))
        self.install(build_petpack(os.path.join(self.data, "b.petpack"), manifest={"version": "1.1.0"}))
        self.assertEqual(self.registry()["packs"][PID]["previous"]["version"], "1.0.0")
        before = sha(os.path.join(self.store("1.0.0"), "manifest.json"))
        _c, v = self.install(build_petpack(os.path.join(self.data, "c.petpack"), manifest={"name": "改过的旧版"}))
        self.assertEqual(v.get("code"), "E_ID_CONFLICT")
        self.assertEqual(sha(os.path.join(self.store("1.0.0"), "manifest.json")), before)

    def test_orphan_same_version_dir_replaced(self):
        os.makedirs(os.path.join(self.store("1.0.0"), "junk"))
        _c, v = self.install(build_petpack(os.path.join(self.data, "a.petpack")))
        self.assertTrue(v["ok"], v)
        self.assertFalse(os.path.isdir(os.path.join(self.store("1.0.0"), "junk")))
        self.assertTrue(os.path.isfile(os.path.join(self.store("1.0.0"), "manifest.json")))

    def test_reinstall_same_hash_is_idempotent_repeatedly(self):
        pack = build_petpack(os.path.join(self.data, "a.petpack"))
        gens = [self.install(pack)[1]["generation"] for _ in range(3)]
        self.assertEqual(gens, [1, 1, 1])


class Recovery(M1Base):
    def test_sweep_cleans_leftovers_keeps_referenced(self):
        self.install(build_petpack(os.path.join(self.data, "a.petpack")))
        packs = os.path.join(self.data, "packs")
        junk = [os.path.join(packs, "pack-stage-dead"), self.store("9.9.9"), self.store("1.0.0.new-abcd"),
                os.path.join(packs, "store", "zz", "orphan", "1.0.0")]
        for d in junk:
            os.makedirs(d)
        files = [os.path.join(packs, "registry.json.123.tmp"), os.path.join(packs, ".downloads", "x.petpack"),
                 os.path.join(packs, ".incoming", "old.petpack")]
        for fn in files:
            os.makedirs(os.path.dirname(fn), exist_ok=True)
            open(fn, "w").close()
        os.utime(files[-1], (1, 1))
        young = os.path.join(packs, ".incoming", "young.petpack")
        open(young, "w").close()
        outside = os.path.join(self.data, "keep-me.txt")
        open(outside, "w").close()
        _c, v = run_cli("sweep", "--data-dir", self.data)
        self.assertTrue(v["ok"], v)
        for p in junk + files:
            self.assertFalse(os.path.exists(p), p)
        self.assertTrue(os.path.isfile(young))  # 宿主刚落盘的导入文件不动
        self.assertTrue(os.path.isfile(os.path.join(self.store("1.0.0"), "manifest.json")))
        self.assertTrue(os.path.isfile(outside))

    def test_corrupt_registry_never_sweeps_store(self):
        self.install(build_petpack(os.path.join(self.data, "a.petpack")))
        with open(os.path.join(self.data, "packs", "registry.json"), "w", encoding="utf-8") as f:
            f.write("{坏")
        run_cli("sweep", "--data-dir", self.data)
        self.assertTrue(os.path.isdir(self.store("1.0.0")))

    def test_rm_refuses_outside_pack_space(self):
        import pack_cli
        for bad in (self.data, os.path.join(self.data, "packs"), os.path.join(self.data, "x"),
                    os.path.dirname(self.data), os.path.join(self.data, "packs", "..", "x")):
            with self.assertRaises(pack_cli.CliError):
                pack_cli._rm(self.data, bad)
        self.assertTrue(os.path.isdir(self.data))

    def test_lock_stale_taken_live_times_out(self):
        import pack_cli
        packs = os.path.join(self.data, "packs")
        os.makedirs(packs, exist_ok=True)
        lock = os.path.join(packs, ".lock")
        with open(lock, "w") as f:
            json.dump({"pid": 999999, "at": 0}, f)  # 死进程
        _c, v = run_cli("sweep", "--data-dir", self.data)
        self.assertTrue(v["ok"], v)
        self.assertFalse(os.path.exists(lock))
        with open(lock, "w") as f:
            json.dump({"pid": os.getpid(), "at": time.time()}, f)  # 活进程持锁
        try:
            with self.assertRaises(pack_cli.CliError):
                with pack_cli.PackLock(self.data, timeout=0.3):
                    pass
        finally:
            os.remove(lock)
        with pack_cli.PackLock(self.data, timeout=0.3) as lk:
            self.assertTrue(os.path.exists(lock) and lk.held)
        self.assertFalse(os.path.exists(lock))

    def test_upgrade_gc_evicts_old_previous_uninstall_reports_leftovers(self):
        for i, ver in enumerate(("1.0.0", "1.1.0", "1.2.0")):
            self.install(build_petpack(os.path.join(self.data, "v%d.petpack" % i), manifest={"version": ver}), extra=("--enable", "1"))
        self.assertEqual(sorted(os.listdir(self.store())), ["1.1.0", "1.2.0"])
        _c, v = run_cli("uninstall", "--data-dir", self.data, "--plugin-root", self.plugin, "--pack-id", PID)
        self.assertTrue(v["ok"])
        self.assertEqual(v["leftovers"], [])
        self.assertFalse(os.path.exists(self.store()))

    def test_place_is_atomic_swap(self):
        import pack_cli
        stage = os.path.join(self.data, "packs", "pack-stage-x")
        os.makedirs(stage)
        open(os.path.join(stage, "new.txt"), "w").close()
        target = os.path.join(self.data, "packs", "store", "a", "b", "1.0.0")
        os.makedirs(target)
        open(os.path.join(target, "old.txt"), "w").close()
        old = pack_cli._place(self.data, stage, "a/b/1.0.0")
        self.assertTrue(os.path.isfile(os.path.join(target, "new.txt")))
        self.assertTrue(os.path.isfile(os.path.join(old, "old.txt")))
        self.assertIn(".old-", old)

    def test_incoming_prefix_is_normalized(self):
        import pack_cli
        packs = os.path.join(self.data, "packs")
        self.assertTrue(pack_cli._is_incoming(self.data, os.path.join(packs, ".incoming", "a.petpack")))
        self.assertTrue(pack_cli._is_incoming(self.data, os.path.join(packs, "x", "..", ".incoming", "a.petpack")))
        self.assertFalse(pack_cli._is_incoming(self.data, os.path.join(self.data, "fake", "packs", ".incoming", "a")))
        self.assertFalse(pack_cli._is_incoming(self.data, os.path.join(packs, ".incoming")))
        mine = build_petpack(os.path.join(self.data, "mine.petpack"))
        self.install(mine)
        self.assertTrue(os.path.isfile(mine))  # 用户自己的文件导入后不删


class WindowsNames(M1Base):
    def test_unsafe_segments_refused(self):
        for name in ("a.png:ads", "furniture/con.txt", "COM1.png", "lpt9", "trail./x.txt", "trail /x.txt", "nul", "Aux.json"):
            pack = build_petpack(os.path.join(self.data, "w.petpack"), extra_members={name: b"x"})
            _c, v = self.install(pack)
            self.assertEqual(v.get("code"), "E_ZIP_INVALID", name)

    def test_nfc_collision_refused(self):
        nfc = unicodedata.normalize("NFC", "café.txt")
        nfd = unicodedata.normalize("NFD", "café.txt")
        pack = build_petpack(os.path.join(self.data, "n.petpack"), extra_members={nfc: b"1", nfd: b"2"})
        _c, v = self.install(pack)
        self.assertEqual(v.get("code"), "E_ZIP_INVALID")

    def test_ordinary_names_still_pass(self):
        import pack_cli
        for seg in ("console.png", "com10.png", "a.b.png", "idle_00.png", "中文.png"):
            self.assertFalse(pack_cli._seg_bad(seg), seg)


if __name__ == "__main__":
    unittest.main()
