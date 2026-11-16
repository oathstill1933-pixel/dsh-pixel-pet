"""runtime/create_convert.py: raw images (green background) -> 192x208 frames -> character.json -> validator CLI."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

from helpers import ROOT
from pixelpet.validate import REQUIRED_STATES

SCRIPT = os.path.join(ROOT, "runtime", "create_convert.py")
FRAMES = {"idle": 6, "walk-left": 4, "walk-right": 4, "waving": 4, "jumping": 6, "failed": 4, "waiting": 4,
          "running": 6, "review": 8, "lie": 4}


def raw(path, shade=0):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (256, 256), (0, 255, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((96, 80 + shade, 160, 230), fill=(87, 104, 155))
    d.rectangle((104, 40 + shade, 152, 88 + shade), fill=(253, 242, 243))
    im.save(path)


def spec_for(cid, have, looks=0):
    states = []
    for sid, n in FRAMES.items():
        states.append({"id": sid, "label": sid, "loop": True, "durationsMs": [150] * n, "single": False, "required": True,
                       "frames": ["%s_%02d" % (sid, i) for i in range(n) if sid in have], "expected": n})
    states.append({"id": "mood-happy", "label": "开心", "loop": True, "durationsMs": [200] * 4, "single": False, "required": False,
                   "frames": ["mood-happy_%02d" % i for i in range(4) if "mood-happy" in have], "expected": 4})
    states.append({"id": "look", "label": "视线", "loop": False, "durationsMs": [100] * 16, "single": True, "required": False,
                   "frames": ["look_%02d" % i for i in range(looks)], "expected": 16})
    return {"id": cid, "name": "测试角色", "states": states}


class CreateConvertTest(unittest.TestCase):
    def run_convert(self, have, looks=0):
        tmp = tempfile.mkdtemp(prefix="pp-conv-")
        src = os.path.join(tmp, "raw")
        out = os.path.join(tmp, "my-abc123")
        os.makedirs(src)
        spec = spec_for("my-abc123", have, looks)
        for st in spec["states"]:
            for i, k in enumerate(st["frames"]):
                raw(os.path.join(src, k + ".png"), shade=i % 2)
        sp = os.path.join(tmp, "spec.json")
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False)
        p = subprocess.run([sys.executable, SCRIPT, "--src", src, "--out", out, "--spec", sp], capture_output=True,
                           env={**os.environ, "PYTHONUTF8": "1"})
        res = json.loads(p.stdout.decode("utf-8").strip().splitlines()[-1])
        with open(os.path.join(out, "character.json"), encoding="utf-8") as f:
            data = json.load(f)
        return res, data, out

    def test_full_pack_validates(self):
        from PIL import Image
        res, data, out = self.run_convert(set(FRAMES) | {"mood-happy"}, looks=16)
        self.assertTrue(res["ok"], res)
        self.assertFalse(res["draft"])
        self.assertNotIn("draft", data)
        self.assertEqual(res["states"]["idle"], 6)
        self.assertEqual(len(data["lookDirections"]), 16)
        self.assertEqual(data["moods"], {"开心": "mood-happy"})
        with Image.open(os.path.join(out, data["states"]["idle"]["frames"][0])) as im:
            self.assertEqual(im.size, (192, 208))
            self.assertEqual(im.mode, "RGBA")
            self.assertEqual(im.getpixel((2, 2))[3], 0)            # green keyed out
            bbox = im.getchannel("A").getbbox()
            self.assertLessEqual(bbox[3], 204)                     # whole picture fitted above the foot line
        with Image.open(os.path.join(out, data["states"]["idle"]["frames"][1])) as im2:
            self.assertEqual(im2.getchannel("A").getbbox()[3], bbox[3])  # same placement for every frame
        for sid in REQUIRED_STATES:
            self.assertIn(sid, data["states"])

    def test_missing_required_is_draft_and_still_valid(self):
        res, data, _ = self.run_convert({"idle", "waving"}, looks=5)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["draft"])
        self.assertTrue(data["draft"])
        self.assertEqual(data["states"]["lie"]["frames"], [])
        self.assertEqual(data["lookDirections"], [])               # 5/16 looks: not enabled yet
        self.assertTrue(any("视线" in w for w in res["warnings"]))


if __name__ == "__main__":
    unittest.main()
