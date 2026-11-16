"""Builds every bookshelf frame, preview.png and the settings-page pack avatar (web/packs/reading.png) from
code (no source image). Deterministic: re-running gives byte-identical files.

    python -X utf8 furniture/bookshelf/tools/build_sprites.py [--out DIR] [--avatar FILE]

Placeholder art (superseded by the imported art, see import_art_v2.py). Grid: drawn at 92x136 logical px (the shelf body on rows 8..133, a
potted plant above it), then K=2 nearest-neighbour -> 184x272 (same 2-px step as the 192x208 character
cells, same palette family as the mailbox). Feet end on logical row 133 -> floorY 268.

States: idle (all books in) / read (one book on the middle shelf slides up and bobs, 2 frames).
"""
import argparse
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PACK))

K = 2
W, H = 92, 136
TOP = 8           # rows above the shelf body (plant leaves)
BODY_H = H - TOP

T = (0, 0, 0, 0)
LINE = (35, 38, 47, 255)
WOOD, WOOD_L, WOOD_D = (156, 107, 69, 255), (188, 140, 98, 255), (115, 73, 45, 255)
BACK, BACK_D = (88, 58, 44, 255), (66, 43, 34, 255)
GOLD = (250, 214, 120, 255)
PAPER = (247, 241, 226, 255)
TERRA, TERRA_D = (205, 110, 70, 255), (160, 78, 50, 255)
LEAF, LEAF_D = (116, 179, 107, 255), (79, 138, 85, 255)

# book colours: (fill, light, dark)
CORAL = ((238, 108, 77, 255), (245, 154, 127, 255), (194, 78, 53, 255))
TEAL = ((62, 142, 140, 255), (103, 181, 174, 255), (44, 101, 103, 255))
MUSTARD = ((232, 180, 82, 255), (243, 211, 138, 255), (190, 138, 52, 255))
CREAM = ((243, 235, 216, 255), (252, 249, 238, 255), (217, 205, 176, 255))
PLUM = ((142, 92, 140, 255), (180, 132, 176, 255), (104, 64, 104, 255))
SAGE = ((130, 170, 120, 255), (168, 202, 156, 255), (92, 132, 90, 255))
NAVY = ((72, 98, 150, 255), (110, 138, 188, 255), (50, 70, 112, 255))
ROSE = ((226, 150, 160, 255), (240, 186, 192, 255), (186, 110, 124, 255))


# ------------------------------------------------------------------ primitives
def box(d, l, t, r, b, fill, light=None, dark=None):
    """Outlined rectangle (outline inclusive); light = top row + left col inside, dark = bottom row + right col."""
    d.rectangle((l, t, r, b), fill=LINE)
    if r - l < 2 or b - t < 2:
        return
    d.rectangle((l + 1, t + 1, r - 1, b - 1), fill=fill)
    if dark:
        d.line([(l + 1, b - 1), (r - 1, b - 1)], fill=dark)
        d.line([(r - 1, t + 1), (r - 1, b - 1)], fill=dark)
    if light:
        d.line([(l + 1, t + 1), (r - 1, t + 1)], fill=light)
        d.line([(l + 1, t + 1), (l + 1, b - 1)], fill=light)


def paint(im, m, c):
    im.paste(Image.new("RGBA", im.size, c), (0, 0), m)


def mask(size, fn):
    m = Image.new("L", size, 0)
    fn(ImageDraw.Draw(m))
    return m


def outlined(im, m, fill):
    paint(im, m.filter(ImageFilter.MaxFilter(3)), LINE)
    paint(im, m, fill)


# ------------------------------------------------------------------ books
def upright(d, x, bottom, w, h, col, deco=None):
    """Book standing on `bottom` (its outline row), left outline at x. Returns the x of its right outline."""
    fill, light, dark = col
    r, t = x + w - 1, bottom - h + 1
    d.rectangle((x, t, r, bottom), fill=LINE)
    d.rectangle((x + 1, t + 1, r - 1, bottom - 1), fill=fill)
    if r - x >= 4:
        d.line([(x + 1, t + 1), (x + 1, bottom - 1)], fill=light)
    if r - x >= 3:
        d.line([(r - 1, t + 1), (r - 1, bottom - 1)], fill=dark)
    if deco == "bands":
        for y in (t + 3, bottom - 3):
            d.line([(x + 1, y), (r - 1, y)], fill=GOLD)
    elif deco == "label":
        ly = t + max(3, h // 4)
        d.rectangle((x + 1, ly, r - 1, ly + 3), fill=PAPER)
        d.line([(x + 1, ly + 3), (r - 1, ly + 3)], fill=CREAM[2])
    elif deco == "stripe":
        my = t + h // 2
        d.rectangle((x + 1, my - 1, r - 1, my), fill=dark)
    elif deco == "dot":
        d.point((x + (w - 1) // 2, t + 4), fill=GOLD)
    return r


def leaning(im, x, bottom, w, h, col, lean, deco="bands"):
    """Book leaning left against whatever stands at x-1: its top is shifted `lean` px left of its bottom."""
    fill, light, dark = col
    t = bottom - h + 1

    def poly(d, dx=0, inset=0):
        d.polygon([(x + dx + inset, t + inset), (x + dx + w - 1 - inset, t + inset),
                   (x + dx + w - 1 - inset + lean, bottom - inset), (x + dx + inset + lean, bottom - inset)], fill=255)

    outer = mask(im.size, poly)
    inner = mask(im.size, lambda d: poly(d, inset=1))
    paint(im, outer, LINE)
    paint(im, inner, fill)
    edge = ImageChops.subtract(inner, mask(im.size, lambda d: poly(d, dx=1, inset=1)))
    paint(im, edge, light)
    if deco == "bands":
        for y in (t + 3, bottom - 3):
            paint(im, ImageChops.multiply(inner, mask(im.size, lambda d, y=y: d.line([(0, y), (W, y)], fill=255))), GOLD)
    return x + w - 1 + lean


def flat_stack(d, right, bottom, items):
    """Books lying flat, stacked from the bottom up, right-aligned at `right` with small offsets."""
    y = bottom
    for w, h, off, col in items:
        fill, light, dark = col
        r = right - off
        box(d, r - w + 1, y - h + 1, r, y, fill, light=light, dark=dark)
        d.line([(r - 2, y - h + 2), (r - 2, y - 1)], fill=PAPER)        # page edge on the open side
        y -= h - 1
    return y


def plant(im, d, cx, bottom):
    """Small potted plant, pot base on `bottom`."""
    box(d, cx - 4, bottom - 6, cx + 4, bottom, TERRA, dark=TERRA_D)
    box(d, cx - 5, bottom - 8, cx + 5, bottom - 6, TERRA, light=(226, 146, 108, 255))
    leaves = [[(cx, bottom - 8), (cx - 6, bottom - 13), (cx - 7, bottom - 17), (cx - 2, bottom - 12)],
              [(cx, bottom - 8), (cx + 1, bottom - 16), (cx + 3, bottom - 19), (cx + 2, bottom - 11)],
              [(cx, bottom - 8), (cx + 5, bottom - 12), (cx + 8, bottom - 14), (cx + 4, bottom - 9)]]
    m = mask(im.size, lambda dd: [dd.polygon(p, fill=255) for p in leaves])
    outlined(im, m, LEAF)
    paint(im, ImageChops.multiply(m, mask(im.size, lambda dd: dd.line([(cx, bottom - 9), (cx + 1, bottom - 15)], fill=255))), LEAF_D)
    paint(im, ImageChops.multiply(m, mask(im.size, lambda dd: dd.line([(cx - 2, bottom - 12), (cx - 5, bottom - 15)], fill=255))), LEAF_D)



# ------------------------------------------------------------------ shelf body
def carcass(d):
    box(d, 13, 20, 78, 112, BACK)                                   # back panel
    for x in (35, 57):                                              # plank seams
        d.line([(x, 21), (x, 111)], fill=BACK_D)
    for y0 in (21, 51, 84):                                         # shadow under each board / left wall
        d.rectangle((14, y0, 77, y0 + 1), fill=BACK_D)
    d.rectangle((14, 21, 15, 111), fill=BACK_D)
    box(d, 7, 20, 13, 118, WOOD, light=WOOD_L, dark=WOOD_D)         # side posts
    box(d, 78, 20, 84, 118, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 3, 11, 88, 17, WOOD, light=WOOD_L, dark=WOOD_D)          # crown
    box(d, 6, 17, 85, 20, WOOD_D)                                   # moulding under the crown
    for y in (46, 79):                                              # shelves
        box(d, 12, y, 79, y + 4, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 5, 112, 86, 121, WOOD, light=WOOD_L, dark=WOOD_D)        # plinth
    d.line([(9, 116), (82, 116)], fill=WOOD_D)
    for l in (9, 76):                                               # feet
        box(d, l, 120, l + 6, 125, WOOD_D)


SHELF_1 = [(6, 22, CORAL, "bands"), (5, 24, NAVY, "label"), (4, 19, MUSTARD, None), (6, 23, TEAL, "stripe"),
           (5, 20, CREAM, "dot"), (5, 24, PLUM, "bands")]
SHELF_2 = [(5, 24, SAGE, "bands"), (6, 27, ROSE, "label"), (5, 18, CORAL, "dot"), (6, 25, NAVY, "bands"),
           (5, 22, MUSTARD, "stripe")]
SHELF_3 = [(7, 26, PLUM, "label"), (5, 22, TEAL, "bands"), (6, 25, CREAM, "stripe"), (4, 21, CORAL, None),
           (6, 24, SAGE, "bands"), (5, 27, NAVY, "dot"), (4, 20, MUSTARD, None)]
PULL = 2          # index in SHELF_2 of the book that slides up in the "read" state


def frame(pull=0):
    im = Image.new("RGBA", (W, BODY_H), T)
    d = ImageDraw.Draw(im)
    carcass(d)

    # top shelf: row of books, one leaning, small flat stack on the right
    x = 13
    for w, h, col, deco in SHELF_1:
        x = upright(d, x, 46, w, h, col, deco)
    leaning(im, x + 1, 46, 6, 20, SAGE, lean=5)
    flat_stack(d, 77, 46, [(16, 5, 0, TEAL), (14, 4, 2, MUSTARD), (12, 4, 1, ROSE)])

    # middle shelf: plant, books; one of them is the one "being read"
    plant(im, d, 22, 79)
    x = 31
    pulled_at = None
    for i, (w, h, col, deco) in enumerate(SHELF_2):
        if i == PULL:
            pulled_at = (x, w, h, col, deco)
            x += w - 1
            continue
        x = upright(d, x, 79, w, h, col, deco)
    leaning(im, x + 1, 79, 6, 21, TEAL, lean=5, deco="bands")
    if pulled_at:
        px, pw, ph, pcol, pdeco = pulled_at
        if pull:
            d.rectangle((px + 1, 79 - ph + 1, px + pw - 2, 78), fill=BACK_D)   # the empty slot
        upright(d, px, 79 - pull, pw, ph, pcol, pdeco)
        if pull:   # redraw the neighbours' shared outline columns so the slot reads as a slot
            d.line([(px, 79 - ph + 1), (px, 79)], fill=LINE)
            d.line([(px + pw - 1, 79 - ph + 1), (px + pw - 1, 79)], fill=LINE)
            d.line([(px, 79 - pull - ph + 1), (px, 79 - pull)], fill=LINE)
            d.line([(px + pw - 1, 79 - pull - ph + 1), (px + pw - 1, 79 - pull)], fill=LINE)

    # bottom shelf: full row + a big flat book
    x = 13
    for w, h, col, deco in SHELF_3:
        x = upright(d, x, 112, w, h, col, deco)
    flat_stack(d, 77, 112, [(22, 6, 0, NAVY), (18, 5, 2, CORAL)])

    # on top: two books, and a plant whose leaves reach into the TOP rows
    flat_stack(d, 80, 11, [(18, 5, 0, PLUM), (15, 4, 1, CREAM)])
    full = Image.new("RGBA", (W, H), T)
    full.alpha_composite(im, (0, TOP))
    plant(full, ImageDraw.Draw(full), 16, 11 + TOP)
    return full.resize((W * K, H * K), Image.NEAREST)



FRAMES = {
    "idle_00": dict(),
    "read_00": dict(pull=8),
    "read_01": dict(pull=11),
}


def _frames():
    return {name: frame(**kw) for name, kw in FRAMES.items()}


# ------------------------------------------------------------------ pack avatar (112x112)
AW = 56


def avatar():
    im = Image.new("RGBA", (AW, AW), T)
    d = ImageDraw.Draw(im)
    box(d, 10, 12, 45, 50, BACK)
    d.rectangle((11, 13, 44, 14), fill=BACK_D)
    d.rectangle((11, 33, 44, 34), fill=BACK_D)
    box(d, 5, 12, 10, 52, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 45, 12, 50, 52, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 2, 6, 53, 12, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 9, 29, 46, 32, WOOD, light=WOOD_L, dark=WOOD_D)
    box(d, 3, 49, 52, 54, WOOD, light=WOOD_L, dark=WOOD_D)
    x = 10
    for w, h, col, deco in [(5, 15, CORAL, "bands"), (5, 13, NAVY, "label"), (4, 12, MUSTARD, None),
                            (5, 15, TEAL, "bands"), (5, 12, PLUM, "dot")]:
        x = upright(d, x, 29, w, h, col, deco)
    leaning(im, x + 1, 29, 4, 12, SAGE, lean=4, deco=None)
    x = 10
    for i, (w, h, col, deco) in enumerate([(5, 14, SAGE, "bands"), (5, 12, ROSE, "label"), (4, 11, CORAL, "dot"),
                                           (5, 14, NAVY, "bands"), (4, 10, CREAM, None), (5, 13, MUSTARD, "stripe")]):
        lift = 4 if i == 2 else 0
        x = upright(d, x, 49 - lift, w, h, col, deco)
    flat_stack(d, 44, 49, [(9, 4, 0, PLUM), (7, 3, 1, TEAL)])
    out = Image.new("RGBA", (AW, AW), T)
    out.alpha_composite(im, (0, -2))                 # 4 px clear above the crown, 3 below the plinth
    return out.resize((AW * K, AW * K), Image.NEAREST)


# ------------------------------------------------------------------ build
def build(out, avatar_path=None):
    sprites = os.path.join(out, "sprites")
    os.makedirs(sprites, exist_ok=True)
    imgs = _frames()
    for name, im in imgs.items():
        im.save(os.path.join(sprites, name + ".png"), optimize=False)
    cw, ch = W * K, H * K
    sheet = Image.new("RGBA", (cw * len(imgs) + 8 * (len(imgs) + 1), (ch + 8) * 2 + 8), T)
    sd = ImageDraw.Draw(sheet)
    sd.rectangle((0, 0, sheet.width, ch + 12), fill=(246, 244, 239, 255))
    sd.rectangle((0, ch + 12, sheet.width, sheet.height), fill=(24, 27, 33, 255))
    for i, im in enumerate(imgs.values()):
        x = 8 + i * (cw + 8)
        sheet.alpha_composite(im, (x, 6))
        sheet.alpha_composite(im, (x, ch + 18))
    sheet.save(os.path.join(out, "preview.png"), optimize=False)
    written = sorted(os.path.join(sprites, n + ".png") for n in imgs)
    if avatar_path:
        os.makedirs(os.path.dirname(avatar_path), exist_ok=True)
        avatar().save(avatar_path, optimize=False)
        written.append(avatar_path)
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=PACK)
    ap.add_argument("--avatar", default=os.path.join(ROOT, "web", "packs", "reading.png"),
                    help="pack avatar for the settings page ('' to skip)")
    a = ap.parse_args()
    for p in build(a.out, a.avatar or None):
        try:
            print(os.path.relpath(p, ROOT))
        except ValueError:          # --out on another drive
            print(p)
