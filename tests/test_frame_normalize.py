"""runtime/frame_normalize.py: 只把「新生成 / 新导入」的帧搬进原包的帧格子。

全部用临时目录 + PIL 现画的合成图，不读用户素材、不跑网络。
"""
import json
import os
import shutil
import tempfile
import unittest

from helpers import png

from frame_normalize import (ConvertError, alpha_bbox, brief_near, geometry_from_ref, is_canonical,
                            normalize_frame, run_brief)


def green_frame(path, size=(1024, 1024), box=None, color=(70, 90, 160, 255)):
    """绿底大图：整张 #00FF00 + 中间一块角色色（默认贴到画面底边，模拟「脚踩底线」的生成图）。"""
    from PIL import Image, ImageDraw
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im = Image.new("RGB", size, (0, 255, 0))
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = box or (size[0] // 4, size[1] // 5, size[0] * 3 // 4, size[1] - 1)
    d.rectangle((x0, y0, x1, y1), fill=color[:3])
    im.save(path)


class FrameNormalizeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pp-frame-norm-")
        self.job = os.path.join(self.tmp, "job")
        self.src = os.path.join(self.job, "raw")
        self.out = os.path.join(self.tmp, "build", "demo")
        os.makedirs(self.src)
        os.makedirs(self.out)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def brief(self, **kw):
        b = {"kind": "character", "frames": [], "canvas": [192, 208], "grid": 2,
             "ref": "raw/idle_00.png"}
        b.update(kw)
        return b

    # ---------------------------------------------------------------- 参考帧几何
    def test_geometry_comes_from_the_reference_frame(self):
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))                 # 默认贴 (48,52)-(144,156) 的块
        foot, center = geometry_from_ref(ref, (192, 208))
        self.assertEqual((foot, center), (156, 96))

    def test_geometry_falls_back_when_the_reference_is_unusable(self):
        self.assertEqual(geometry_from_ref(None, (192, 208)), (204, 96))
        empty = os.path.join(self.src, "idle_00.png")
        png(empty, empty=True)
        self.assertEqual(geometry_from_ref(empty, (192, 208)), (204, 96))

    # ---------------------------------------------------------------- 新帧归一化
    def test_green_big_frame_lands_on_the_pack_grid(self):
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        big = os.path.join(self.src, "waving_01.png")
        green_frame(big)
        info = run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        self.assertEqual(info["frames"], {"waving_01": "converted"})
        self.assertEqual((info["footY"], info["centerX"]), (156, 96))
        from PIL import Image
        dst = os.path.join(self.out, "sprites", "waving_01.png")
        with Image.open(dst) as im:
            self.assertEqual(im.size, (192, 208))
            self.assertEqual(im.mode, "RGBA")
            box = alpha_bbox(im)
            self.assertIsNotNone(box)
            self.assertEqual(box[3], 156)                       # 站在参考帧同一条落脚线上（不吸附，差一格就错位）
            self.assertLessEqual((box[0] + box[2]) / 2.0, 96 + 2)   # 水平仍以参考帧中心为准
            self.assertGreaterEqual((box[0] + box[2]) / 2.0, 96 - 2)
            self.assertEqual(im.getpixel((1, 1))[3], 0)         # 绿底抠干净
            hist = im.getchannel("A").histogram()
            self.assertTrue(all(v == 0 for v in hist[1:255]), "alpha 必须是硬边（只有 0 / 255）")

    def test_placement_does_not_depend_on_the_source_pixel_size(self):
        """同一张画出成 1024 或 512，落到的脚底/中心一致：位置来自原包，不来自新图尺寸。"""
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        a = os.path.join(self.src, "waving_01.png")
        b = os.path.join(self.src, "waving_02.png")
        green_frame(a, size=(1024, 1024))
        green_frame(b, size=(512, 512))
        info = run_brief(self.src, self.out, self.brief(frames=["waving_01", "waving_02"]))
        self.assertEqual(info["converted"], 2)
        from PIL import Image
        with Image.open(os.path.join(self.out, "sprites", "waving_01.png")) as i1, \
                Image.open(os.path.join(self.out, "sprites", "waving_02.png")) as i2:
            self.assertEqual(alpha_bbox(i1)[3], 156)
            self.assertEqual(alpha_bbox(i2)[3], 156)
            self.assertLessEqual(abs((alpha_bbox(i1)[0] + alpha_bbox(i1)[2]) - (alpha_bbox(i2)[0] + alpha_bbox(i2)[2])), 2)

    def test_horizontal_offset_sits_on_the_logical_grid(self):
        """横向偏移吸附到 logicalScale 网格（角色 2px）：整宽内容时左右边都该落在偶数上。"""
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        new = os.path.join(self.src, "waving_01.png")
        green_frame(new, size=(512, 512), box=(0, 100, 511, 511))
        run_brief(self.src, self.out, self.brief(frames=["waving_01"]))   # grid=2
        from PIL import Image
        with Image.open(os.path.join(self.out, "sprites", "waving_01.png")) as im:
            box = alpha_bbox(im)
            self.assertEqual((box[0] % 2, box[2] % 2), (0, 0))
            self.assertEqual(box[3], 156)

    def test_canonical_rgba_frame_is_copied_byte_for_byte(self):
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        new = os.path.join(self.src, "waving_01.png")
        png(new, color=(200, 30, 60, 255))
        with open(new, "rb") as f:
            before = f.read()
        self.assertTrue(is_canonical(new, (192, 208)))
        info = run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        self.assertEqual(info["frames"], {"waving_01": "copied"})
        with open(os.path.join(self.out, "sprites", "waving_01.png"), "rb") as f:
            self.assertEqual(f.read(), before)

    def test_frame_with_its_own_alpha_keeps_that_alpha(self):
        """已经是 RGBA（自带透明）的图不再按绿底处理，只缩放定位。"""
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        new = os.path.join(self.src, "waving_01.png")
        from PIL import Image as I, ImageDraw
        im = I.new("RGBA", (512, 512), (0, 0, 0, 0))
        ImageDraw.Draw(im).rectangle((100, 60, 400, 511), fill=(90, 120, 200, 255))
        im.save(new)
        run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        with I.open(os.path.join(self.out, "sprites", "waving_01.png")) as out:
            box = alpha_bbox(out)
            self.assertEqual(box[3], 156)
            self.assertEqual(out.size, (192, 208))

    def test_green_only_picture_is_an_error_not_an_empty_frame(self):
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        blank = os.path.join(self.src, "waving_01.png")
        from PIL import Image
        Image.new("RGB", (512, 512), (0, 255, 0)).save(blank)
        with self.assertRaises(ConvertError):
            run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        self.assertFalse(os.path.exists(os.path.join(self.out, "sprites", "waving_01.png")))

    def test_missing_or_bad_frame_names_are_rejected(self):
        with self.assertRaises(ConvertError):
            run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        self.assertFalse(os.path.exists(os.path.join(self.out, "sprites", "waving_01.png")))
        with self.assertRaises(ConvertError):
            run_brief(self.src, self.out, self.brief(frames=["../../escape"]))

    def test_existing_frames_never_enter_the_normalizer(self):
        """brief 只列新帧：同一目录里的原有帧不会被写出去。"""
        ref = os.path.join(self.src, "idle_00.png")
        png(ref, color=(10, 20, 30, 255))
        with open(ref, "rb") as f:
            before = f.read()
        new = os.path.join(self.src, "waving_01.png")
        green_frame(new)
        run_brief(self.src, self.out, self.brief(frames=["waving_01"]))
        with open(ref, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertFalse(os.path.exists(os.path.join(self.out, "sprites", "idle_00.png")))
        self.assertEqual(os.listdir(os.path.join(self.out, "sprites")), ["waving_01.png"])

    # ---------------------------------------------------------------- 家具
    def test_furniture_frames_use_the_card_size_and_floor(self):
        ref = os.path.join(self.src, "empty_00.png")
        png(ref, size=(160, 160), color=(90, 60, 40, 255))
        new = os.path.join(self.src, "empty_01.png")
        green_frame(new, size=(900, 900))
        info = run_brief(self.src, self.out, {"kind": "furniture", "frames": ["empty_01"], "size": [160, 160],
                                              "grid": 1, "ref": "raw/empty_00.png"}, size=(160, 160))
        self.assertEqual(info["canvas"], [160, 160])
        from PIL import Image
        with Image.open(os.path.join(self.out, "sprites", "empty_01.png")) as im:
            self.assertEqual(im.size, (160, 160))
            self.assertEqual(im.mode, "RGBA")
            box = alpha_bbox(im)
            self.assertIsNotNone(box)
            self.assertEqual(box[3], 120)                       # 参考帧（块贴 40..119）的底边
            self.assertEqual(im.getpixel((0, 0))[3], 0)

    # ---------------------------------------------------------------- brief
    def test_brief_near_only_looks_next_to_the_raw_dir(self):
        self.assertIsNone(brief_near(self.src))
        with open(os.path.join(self.job, "normalize.json"), "w", encoding="utf-8") as f:
            json.dump({"kind": "character", "frames": ["waving_01"]}, f)
        self.assertEqual(brief_near(self.src)["frames"], ["waving_01"])
        with open(os.path.join(self.job, "normalize.json"), "w", encoding="utf-8") as f:
            f.write("{oops")
        with self.assertRaises(ConvertError):
            brief_near(self.src)


if __name__ == "__main__":
    unittest.main()
