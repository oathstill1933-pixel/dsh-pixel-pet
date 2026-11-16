"""Import headphone sprites, verifying the original render against shipped sprites."""
import argparse
import importlib.util
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
CANVAS = (192, 208)
STATES = {
    "headphones-music": ("戴耳机听歌", "music-listening"),
    "headphones-idle": ("戴耳机待机", "music-idle"),
    "headphones-speaking": ("戴耳机说话", "music-speaking"),
}


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rgba(path):
    with Image.open(path) as im:
        return im.convert("RGBA")


def union(boxes):
    return tuple(f(col) for f, col in zip((min, min, max, max), zip(*boxes)))


def claude_renderer(normal, spec):
    names = {f for st in spec["states"].values() for f in st["frames"]}
    names.update(st["frame"] for st in spec["lookDirections"])
    names = sorted(names)
    crop = union(rgba(normal / f).getbbox() for f in names)
    w, h = crop[2] - crop[0], crop[3] - crop[1]
    scale = min(192 / w, 199 / h)
    size = round(w * scale), round(h * scale)
    insets = union(rgba(normal / f).crop(crop).resize(size, Image.Resampling.NEAREST).getbbox() for f in names)
    x = (192 - insets[2] + insets[0]) // 2
    y = 208 - insets[3] + insets[1]
    print(f"Claude scale={scale:.10f} crop={crop} size={size} inset={insets} paste={(x, y)}")

    def render(path, offset=(0, 0)):
        # Moving the sampling window preserves the original nearest-neighbor grid and alpha paste.
        dx, dy = offset
        box = crop[0] + dx, crop[1] + dy, crop[2] + dx, crop[3] + dy
        piece = rgba(path).crop(box).resize(size, Image.Resampling.NEAREST).crop(insets)
        out = Image.new("RGBA", CANVAS)
        out.paste(piece, (x, y), piece)
        return out

    return render


def whale_renderer():
    script = ROOT / "characters/whale-girl/tools/import_codex_v1.py"
    mod_spec = importlib.util.spec_from_file_location("import_codex_v1", script)
    mod = importlib.util.module_from_spec(mod_spec)
    mod_spec.loader.exec_module(mod)
    scale, x, y, box = mod.compute_transform()
    print(f"Whale scale={scale:.10f} offset={(x, y)} original_idle_bbox={box}")
    return lambda path, offset=(0, 0): mod.render(scale, x - offset[0] * scale, y - offset[1] * scale, path)


def verify(render, normal, base):
    for name in ("idle_00.png", "walk-left_00.png", "review_00.png", "speaking_00.png"):
        want = rgba(base / "sprites" / name)
        got = render(normal / name)
        expected, actual = want.tobytes(), got.tobytes()
        same = sum(expected[i:i+4] == actual[i:i+4] for i in range(0, len(expected), 4)) / (192 * 208)
        print(f"{name}: {same:.4%}")
        if same < 0.99:
            raise ValueError(f"{name} alignment below 99%")


def compare(path, frames):
    # Use a visible grid and a shared floor guide for side-by-side inspection.
    img = Image.new("RGB", (4 * 212, 246), "#24242c")
    draw = ImageDraw.Draw(img)
    floor = frames["idle_00"].getbbox()[3] - 1
    for i, (label, frame) in enumerate(frames.items()):
        x, y = i * 212 + 10, 28
        draw.text((x, 8), label, fill="#f0eff2")
        draw.rectangle((x, y, x + 191, y + 207), fill="#474752")
        draw.line((x, y + floor, x + 191, y + floor), fill="#817384")
        img.paste(frame, (x, y), frame)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("character", choices=["claude-girl", "whale-girl"])
    ap.add_argument("--assets", type=Path, required=True, help="Read-only animation-v1 directory")
    ap.add_argument("--character-dir", type=Path, required=True)
    ap.add_argument("--comparison", type=Path)
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--backup", type=Path, help="New directory for the original runtime sprites")
    args = ap.parse_args()
    normal, base = args.assets / "source", args.character_dir.resolve()
    source_root = args.assets.resolve()
    if base.is_relative_to(source_root) or any(p and p.resolve().is_relative_to(source_root)
                                               for p in (args.comparison, args.backup)):
        ap.error("the animation source directory is read-only")
    spec = load_json(normal / "animation.json")
    render = claude_renderer(normal, spec) if args.character == "claude-girl" else whale_renderer()
    verify(render, normal, base)
    if args.verify_only:
        return
    if args.backup:
        shutil.copytree(base / "sprites", args.backup / "sprites")
        shutil.copy2(base / "character.json", args.backup / "character.json")
    elif args.character == "whale-girl":
        ap.error("--backup is required when importing into the built-in whale-girl")
    extras = args.assets / "headphones-v1/source"
    anim = load_json(extras / "animation.json")
    ref = spec["referenceOffset"]
    extra_ref = anim.get("referenceOffset", ref)
    offset = tuple(new - old for new, old in zip(extra_ref, ref))
    print(f"referenceOffset {ref} -> {extra_ref}, delta={offset}")
    char_file = base / "character.json"
    meta = load_json(char_file)
    mosaic = {"idle_00": rgba(base / "sprites/idle_00.png")}
    for key, (label, role) in STATES.items():
        st = anim["states"][key]
        paths, boxes = [], []
        for i, name in enumerate(st["frames"]):
            im = render(extras / name, offset)
            box = im.getbbox()
            if box is None:
                raise ValueError(f"{name} rendered blank")
            boxes.append(box)
            if i == 0:
                mosaic[key] = im
            rel = f"sprites/{key}_{i:02d}.png"
            im.save(base / rel, optimize=True)
            paths.append(rel)
        print(f"{key}: {len(paths)} bbox={union(boxes)} floor={sorted({b[3]-1 for b in boxes})}")
        meta["states"][key] = {
            "label": label, "frames": paths, "durationsMs": st["durationsMs"],
            "loop": st.get("loop", True), "role": role, "requires": {"feature": "listen"},
        }
    char_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.comparison:
        compare(args.comparison, mosaic)


if __name__ == "__main__":
    main()
