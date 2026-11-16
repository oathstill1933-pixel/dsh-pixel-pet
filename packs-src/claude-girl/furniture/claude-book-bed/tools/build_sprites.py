"""Sample the bed and the approved sleeping sprite onto the furniture grid."""
import argparse
import json
from pathlib import Path
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont


PACK = Path(__file__).resolve().parents[1]
SOURCE = PACK / "tools" / "source"
NEAREST = Image.Resampling.NEAREST
LOGICAL = (180, 150)
NATIVE = (360, 300)


def read_art(name):
    with Image.open(SOURCE / name) as image:
        rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    if alpha.getbbox() is None:
        raise ValueError(f"Empty source: {name}")
    out = Image.new("RGBA", rgba.size)
    out.paste(rgba, mask=alpha)
    out.putalpha(alpha)
    return out


def scaled(crop, width):
    height = round(crop.height * width / crop.width)
    return crop.resize((width, height), NEAREST)


def preview(empty, occupied):
    board = Image.new("RGBA", (1440, 660), "#f2eae4")
    for index, (label, image) in enumerate((("空床", empty), ("抱书睡觉", occupied[0]))):
        x = index * 720
        board.alpha_composite(image.resize((720, 600), NEAREST), (x, 0))
        draw = ImageDraw.Draw(board)
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 23)
        draw.text((x + 24, 616), label, font=font, fill="#574040")
    board.convert("RGB").save(PACK / "preview.png")
    images = []
    for frame in occupied:
        matte = Image.new("RGBA", (720, 600), "#f2eae4")
        matte.alpha_composite(frame.resize(matte.size, NEAREST))
        images.append(matte.convert("RGB"))
    images[0].save(PACK / "sleep.gif", save_all=True, append_images=images[1:],
                   duration=[900, 700], loop=0, disposal=2, optimize=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True, help="Plugin runtime folder")
    args = parser.parse_args()
    sys.path.insert(0, str(args.runtime.resolve()))
    from pixelpet.furniture import compose_occupied

    manifest = json.loads((PACK / "furniture.json").read_text(encoding="utf-8"))
    art = read_art("empty_00.png")
    crop_box = art.getchannel("A").getbbox()
    bed = scaled(art.crop(crop_box), 168)
    floor = manifest["floorY"] // 2
    empty = Image.new("RGBA", LOGICAL)
    empty.paste(bed, ((LOGICAL[0] - bed.width) // 2, floor - bed.height))

    occupant = manifest["interactions"][0]["occupant"]
    sleep = [read_art(f"curl-sleep_{index:02d}.png") for index in range(2)]
    boxes = [image.getchannel("A").getbbox() for image in sleep]
    shared = (min(b[0] for b in boxes), min(b[1] for b in boxes),
              max(b[2] for b in boxes), max(b[3] for b in boxes))
    width = (occupant["area"][2] - occupant["area"][0]) // 2
    poses = [scaled(image.crop(shared), width) for image in sleep]
    anchor = tuple(value // 2 for value in occupant["anchor"])
    box = (0, 0, *poses[0].size)
    occupied = [compose_occupied(empty, pose, anchor, box=box,
                                 clip_y=occupant["clipY"] // 2) for pose in poses]
    assert ImageChops.difference(occupied[0], occupied[1]).getbbox(alpha_only=False)
    sprites = PACK / "sprites"
    sprites.mkdir(exist_ok=True)
    outputs = [empty, *occupied]
    names = [name for state in manifest["states"].values() for name in state["frames"]]
    assert len(outputs) == len(names)
    native = []
    for frame, name in zip(outputs, names):
        assert frame.getchannel("A").getbbox()[3] == floor
        assert not any(frame.getchannel("A").histogram()[1:255])
        image = frame.resize(NATIVE, NEAREST)
        image.save(PACK / name)
        native.append(image)
    preview(native[0], native[1:])
    report = {"canvas": list(NATIVE), "logicalGrid": list(LOGICAL), "floorY": floor * 2,
              "alphaValues": [0, 255], "frames": names, "sourceCrop": list(crop_box),
              "sleepCrop": list(shared)}
    (PACK / "conversion.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                         encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
