"""Builds every mailbox frame + preview.png from code (no source image). Deterministic: re-running gives
byte-identical files.

    python furniture/mailbox/tools/build_sprites.py [--out DIR]

Grid: drawn at 72x84 logical px, then K=2 nearest-neighbour -> 144x168 (same 2-px step as the 192x208
character cells). Ground line at logical y=82 (floorY 164).

States: idle (flag down) / flag (flag up, 2-frame flutter) / open (door down, letter out, 2-frame bob).
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)

K = 2
W, H = 72, 84
GROUND = 82

T = (0, 0, 0, 0)
LINE = (35, 38, 47, 255)
TEAL, TEAL_L, TEAL_D = (62, 142, 140, 255), (103, 181, 174, 255), (44, 101, 103, 255)
CREAM, CREAM_D = (243, 235, 216, 255), (217, 205, 176, 255)
CORAL, CORAL_L, CORAL_D = (238, 108, 77, 255), (245, 154, 127, 255), (194, 78, 53, 255)
WOOD, WOOD_L, WOOD_D = (156, 107, 69, 255), (188, 140, 98, 255), (115, 73, 45, 255)
STEEL = (168, 176, 186, 255)
GRASS, GRASS_D = (116, 179, 107, 255), (79, 138, 85, 255)
STONE, STONE_D = (149, 156, 168, 255), (110, 117, 129, 255)
DARK = (27, 43, 48, 255)

BOX = (20, 18, 63, 42)          # side of the tunnel box (l, t, r, b), inclusive
PIVOT = (56, 31)                # flag pivot on the box side


# ------------------------------------------------------------------ primitives
def mask(fn):
    m = Image.new("L", (W, H), 0)
    fn(ImageDraw.Draw(m))
    return m


def paint(im, m, c):
    im.paste(Image.new("RGBA", (W, H), c), (0, 0), m)


def outlined(im, m, fill):
    paint(im, m.filter(ImageFilter.MaxFilter(3)), LINE)
    paint(im, m, fill)


def rect(d, box, fill=255):
    d.rectangle(box, fill=fill)


# ------------------------------------------------------------------ parts
def ground(im):
    outlined(im, mask(lambda d: d.ellipse((28, 77, 52, 85), fill=255)), STONE)
    paint(im, mask(lambda d: rect(d, (30, 82, 50, 83))), STONE_D)
    for x, h in ((24, 4), (27, 6), (53, 5), (56, 3)):
        m = mask(lambda d, x=x, h=h: d.polygon([(x, GROUND), (x + 1, GROUND - h), (x + 2, GROUND)], fill=255))
        paint(im, m, GRASS)
        paint(im, mask(lambda d, x=x: d.point((x + 1, GROUND - 1), fill=255)), GRASS_D)


def post(im):
    outlined(im, mask(lambda d: rect(d, (37, 43, 44, 80))), WOOD)
    paint(im, mask(lambda d: rect(d, (37, 43, 38, 80))), WOOD_L)
    paint(im, mask(lambda d: rect(d, (43, 43, 44, 80))), WOOD_D)
    for y in (52, 63, 71):                     # grain
        paint(im, mask(lambda d, y=y: rect(d, (40, y, 41, y))), WOOD_D)
    outlined(im, mask(lambda d: rect(d, (30, 42, 52, 44))), WOOD_D)   # cradle plank


def box(im):
    l, t, r, b = BOX
    outlined(im, mask(lambda d: d.rounded_rectangle((l, t, r, b), radius=7, fill=255)), TEAL)
    # top light band / bottom shade, kept inside the rounded silhouette
    body = mask(lambda d: d.rounded_rectangle((l, t, r, b), radius=7, fill=255))
    top = mask(lambda d: rect(d, (l, t, r, t + 3)))
    bot = mask(lambda d: rect(d, (l, b - 3, r, b)))
    from PIL import ImageChops
    paint(im, ImageChops.multiply(body, top), TEAL_L)
    paint(im, ImageChops.multiply(body, bot), TEAL_D)
    # seam rings
    for x in (l + 9, r - 9):
        paint(im, ImageChops.multiply(body, mask(lambda d, x=x: rect(d, (x, t, x, b)))), TEAL_D)
    # embossed letter on the side
    outlined(im, mask(lambda d: rect(d, (26, 27, 37, 35))), CREAM)
    paint(im, mask(lambda d: d.line([(27, 28), (31, 32), (32, 32), (36, 28)], fill=255)), CREAM_D)
    paint(im, mask(lambda d: rect(d, (35, 28, 36, 29))), CORAL)


def door_closed(im):
    l, t, r, b = BOX
    outlined(im, mask(lambda d: d.rounded_rectangle((l - 3, t + 1, l + 1, b), radius=3, fill=255)), TEAL_D)
    paint(im, mask(lambda d: rect(d, (l - 2, t + 4, l - 2, b - 3))), TEAL)
    outlined(im, mask(lambda d: rect(d, (l - 5, 29, l - 4, 31))), STEEL)       # knob


def door_open(im, bob):
    l, t, r, b = BOX
    paint(im, mask(lambda d: d.rounded_rectangle((l, t + 2, l + 3, b - 1), radius=2, fill=255)), DARK)   # mouth
    # letter sliding out, resting on the lowered door
    y = 31 - bob
    outlined(im, mask(lambda d: rect(d, (l - 10, y, l + 3, y + 8))), CREAM)
    paint(im, mask(lambda d: d.line([(l - 9, y + 1), (l - 3, y + 5), (l + 2, y + 1)], fill=255)), CREAM_D)
    paint(im, mask(lambda d: rect(d, (l - 9, y + 1, l - 8, y + 2))), CORAL)   # stamp corner
    # door: hinged at the bottom front edge, dropped flat
    outlined(im, mask(lambda d: rect(d, (l - 16, b - 1, l, b + 2))), TEAL_D)
    paint(im, mask(lambda d: rect(d, (l - 15, b - 1, l - 1, b - 1))), TEAL)
    outlined(im, mask(lambda d: rect(d, (l - 18, b, l - 17, b + 1))), STEEL)


def flag_down(im):
    px, py = PIVOT
    outlined(im, mask(lambda d: rect(d, (px - 13, py - 1, px, py))), CORAL_D)          # arm along the side
    outlined(im, mask(lambda d: rect(d, (px - 13, py - 1, px - 9, py + 5))), CORAL)    # plate hanging
    outlined(im, mask(lambda d: rect(d, (px - 1, py - 1, px + 1, py + 1))), STEEL)     # pivot


def flag_up(im, flutter):
    px, py = PIVOT
    top = py - 26
    outlined(im, mask(lambda d: rect(d, (px - 1, top, px, py))), CORAL_D)              # arm, straight up
    if flutter == 0:
        pts = [(px + 1, top), (px + 9, top), (px + 9, top + 6), (px + 1, top + 6)]
    else:
        pts = [(px + 1, top + 1), (px + 9, top), (px + 10, top + 4), (px + 9, top + 7), (px + 1, top + 6)]
    plate = mask(lambda d: d.polygon(pts, fill=255))
    outlined(im, plate, CORAL)
    from PIL import ImageChops
    paint(im, ImageChops.multiply(plate, mask(lambda d: rect(d, (px + 1, top, px + 10, top + 1)))), CORAL_L)
    outlined(im, mask(lambda d: rect(d, (px - 1, py - 1, px + 1, py + 1))), STEEL)


# ------------------------------------------------------------------ frames
def frame(flag=None, flutter=0, open_bob=None):
    im = Image.new("RGBA", (W, H), T)
    ground(im)
    post(im)
    box(im)
    if open_bob is None:
        door_closed(im)
    else:
        door_open(im, open_bob)
    if flag == "up":
        flag_up(im, flutter)
    else:
        flag_down(im)
    return im.resize((W * K, H * K), Image.NEAREST)


FRAMES = {
    "idle_00": dict(),
    "flag_00": dict(flag="up", flutter=0),
    "flag_01": dict(flag="up", flutter=1),
    "open_00": dict(open_bob=0),
    "open_01": dict(open_bob=1),
}


def build(out):
    sprites = os.path.join(out, "sprites")
    os.makedirs(sprites, exist_ok=True)
    imgs = {}
    for name, kw in FRAMES.items():
        imgs[name] = frame(**kw)
        imgs[name].save(os.path.join(sprites, name + ".png"), optimize=False)
    # preview: every frame on a light and a dark strip
    cw, ch = W * K, H * K
    sheet = Image.new("RGBA", (cw * len(imgs) + 8 * (len(imgs) + 1), (ch + 8) * 2 + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(sheet)
    d.rectangle((0, 0, sheet.width, ch + 12), fill=(246, 244, 239, 255))
    d.rectangle((0, ch + 12, sheet.width, sheet.height), fill=(24, 27, 33, 255))
    for i, im in enumerate(imgs.values()):
        x = 8 + i * (cw + 8)
        sheet.alpha_composite(im, (x, 6))
        sheet.alpha_composite(im, (x, ch + 18))
    sheet.save(os.path.join(out, "preview.png"), optimize=False)
    return sorted(os.path.join(sprites, n + ".png") for n in imgs)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=PACK)
    a = ap.parse_args()
    for p in build(a.out):
        print(os.path.relpath(p, a.out))
