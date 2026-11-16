"""「活动与额度」页签 v2：桌宠状态分类与 10 秒去抖（runtime/pixelpet/petstate.py）。纯逻辑，不跑 UI。"""
import json
import os
import unittest

from helpers import tmpdir

from pixelpet.petstate import PetStateLog, classify


def snap(**kw):
    base = {"withdrawn": False, "inside": None, "voice": "idle", "motion": False, "manual": "idle", "manual_until": None}
    base.update(kw)
    return base


class Classify(unittest.TestCase):
    def test_priority_hidden_inside_speaking(self):
        self.assertEqual(classify(snap(withdrawn=True)), "hidden")
        self.assertEqual(classify(snap(inside=("bed", "sleep"))), "inside")
        self.assertEqual(classify(snap(voice="speaking")), "speaking")
        self.assertEqual(classify(snap(voice="speaking", motion=True)), "speaking")  # 说话优先于走动

    def test_thinking_covers_voice_busy(self):
        for v in ("thinking", "hearing", "listening"):
            self.assertEqual(classify(snap(voice=v)), "thinking")

    def test_working_only_while_hold_valid(self):
        self.assertEqual(classify(snap(manual="running", manual_until=10_000.0), now=9_000.0), "working")
        self.assertEqual(classify(snap(manual="waiting", manual_until=10_000.0), now=9_000.0), "working")
        # 过期的 hold 不算工作
        self.assertEqual(classify(snap(manual="running", manual_until=10_000.0), now=11_000.0), "idle")
        self.assertEqual(classify(snap(manual="failed", manual_until=10_000.0), now=9_000.0), "idle")

    def test_walk_then_idle(self):
        self.assertEqual(classify(snap(motion=True)), "walk")
        self.assertEqual(classify(snap()), "idle")


class Debounce(unittest.TestCase):
    def test_new_state_settles_after_10s(self):
        writes = []
        m = PetStateLog(None, clock=lambda: 0.0, append=lambda state, t, hb=False: writes.append((state, t)))
        self.assertIsNone(m.observe(snap(motion=True)))          # idle -> walk：开始等
        m.clock = lambda: 5.0
        self.assertIsNone(m.observe(snap(motion=True)))          # 还没满 10 s
        m.clock = lambda: 9.9
        self.assertIsNone(m.observe(snap(motion=True)))
        m.clock = lambda: 10.1
        self.assertEqual(m.observe(snap(motion=True)), "walk")   # 满 10 s 落盘
        self.assertEqual(writes, [("walk", 10.1)])
        # 稳定期间不再写
        m.clock = lambda: 60.0
        self.assertIsNone(m.observe(snap(motion=True)))
        self.assertEqual(writes, [("walk", 10.1)])

    def test_flap_back_before_debounce_writes_nothing(self):
        writes = []
        m = PetStateLog(None, clock=lambda: 0.0, append=lambda state, t, hb=False: writes.append(state))
        m.observe(snap(motion=True))                             # pending: walk
        m.clock = lambda: 5.0
        m.observe(snap(motion=True))
        m.clock = lambda: 8.0
        m.observe(snap())                                        # 缩回 idle：pending 清掉
        m.clock = lambda: 9.0
        m.observe(snap(motion=True))                             # 重新计 10 s
        m.clock = lambda: 15.0
        self.assertIsNone(m.observe(snap(motion=True)))          # 才 6 s，不写
        m.clock = lambda: 19.1
        self.assertEqual(m.observe(snap(motion=True)), "walk")
        self.assertEqual(writes, ["walk"])

    def test_file_lines_and_prune(self):
        d = tmpdir()
        path = os.path.join(d, "pet-state.jsonl")
        base = 1_800_000_000.0                                   # 2027-01-15 前后，真实量级
        m = PetStateLog(d, clock=lambda: base)
        m.observe(snap(motion=True))
        m.clock = lambda: base + 11.0
        self.assertEqual(m.observe(snap(motion=True)), "walk")   # walk 停满 10 s 落盘
        m.clock = lambda: base + 12.0
        m.observe(snap())                                        # idle：开始等
        m.clock = lambda: base + 23.0
        self.assertEqual(m.observe(snap()), "idle")              # idle 落盘
        rows = [json.loads(l) for l in open(path, encoding="utf-8")]
        self.assertEqual([r["state"] for r in rows], ["walk", "idle"])
        self.assertTrue(all("T" in r["t"] for r in rows))        # 带时区的 ISO
        # 31 天前的行被整枝
        rows[0]["t"] = "2026-01-01T00:00:00+08:00"
        with open(path, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        m._pruned_at = None
        m._write("idle", base + 60.0)
        kept = [json.loads(l) for l in open(path, encoding="utf-8")]
        self.assertEqual(len(kept), 2)                           # 旧行没了，只剩 idle 两行
        self.assertTrue(all(r["state"] == "idle" for r in kept))


class HeartbeatOffline(unittest.TestCase):
    """review10/20：说话/思考 3 秒去抖；心跳每 5 分钟；quit 写 offline。"""

    def test_speaking_and_thinking_use_3s_debounce(self):
        writes = []
        m = PetStateLog(None, clock=lambda: 0.0, append=lambda state, t, hb=False: writes.append((state, t)))
        m.observe(snap(voice="speaking"))
        m.clock = lambda: 3.1
        self.assertEqual(m.observe(snap(voice="speaking")), "speaking")   # 3 秒即可上带
        m.clock = lambda: 10.0
        m.observe(snap(voice="thinking"))
        m.clock = lambda: 13.1
        self.assertEqual(m.observe(snap(voice="thinking")), "thinking")
        # 其余状态仍 10 秒
        m.clock = lambda: 20.0
        m.observe(snap(motion=True))
        m.clock = lambda: 25.0
        self.assertIsNone(m.observe(snap(motion=True)))
        m.clock = lambda: 30.1
        self.assertEqual(m.observe(snap(motion=True)), "walk")

    def test_heartbeat_only_when_unchanged_and_every_5_min(self):
        writes = []
        m = PetStateLog(None, clock=lambda: 0.0, append=lambda state, t, hb=False: writes.append((state, t, hb)))
        m.observe(snap(motion=True))                                # 0 s：pending
        m.clock = lambda: 11.0
        self.assertEqual(m.observe(snap(motion=True)), "walk")     # 11 s：落盘，current = walk
        self.assertEqual(m.heartbeat(snap(motion=True)), "walk")   # 首次心跳（_hb_at 为空）立刻写一行
        m.clock = lambda: 311.0
        self.assertEqual(m.heartbeat(snap(motion=True)), "walk")   # 5 分钟后一跳
        m.clock = lambda: 400.0
        self.assertIsNone(m.heartbeat(snap(motion=True)))          # 不到 5 分钟不写
        # 状态变了不心跳（等 observe 去抖）
        m.clock = lambda: 900.0
        self.assertIsNone(m.heartbeat(snap()))
        self.assertTrue(all(hb for (_, _, hb) in writes if _ == "walk"))

    def test_quit_writes_offline_line(self):
        d = tmpdir()
        path = os.path.join(d, "pet-state.jsonl")
        m = PetStateLog(d, clock=lambda: 0.0)
        m.observe(snap(motion=True))                               # 0 s：pending
        m.clock = lambda: 11.0
        self.assertEqual(m.observe(snap(motion=True)), "walk")     # 11 s：落盘
        m.write_offline()
        rows = [json.loads(l) for l in open(path, encoding="utf-8")]
        self.assertEqual([r["state"] for r in rows], ["walk", "offline"])

    def test_heartbeat_flag_in_file(self):
        d = tmpdir()
        path = os.path.join(d, "pet-state.jsonl")
        m = PetStateLog(d, clock=lambda: 0.0)
        m.observe(snap(motion=True))                               # 0 s：pending
        m.clock = lambda: 11.0
        self.assertEqual(m.observe(snap(motion=True)), "walk")     # 11 s：落盘
        m.clock = lambda: 311.0
        m.heartbeat(snap(motion=True))
        rows = [json.loads(l) for l in open(path, encoding="utf-8")]
        self.assertEqual(len(rows), 2)
        self.assertNotIn("hb", rows[0])                            # 普通行不带 hb
        self.assertIs(rows[1].get("hb"), True)                     # 心跳行带 hb:true


if __name__ == "__main__":
    unittest.main()
