"""Build the Claude-girl pack (.petpack) from packs-src/claude-girl and print its catalog metadata.

The archive is reproducible: members are stored (not compressed), in a fixed order, with a fixed timestamp,
so the same sources always give the same bytes and the same sha256. The catalog entry in
contracts/catalog.json carries that size/sha256; the file itself is a GitHub Release asset
(see docs/RELEASE.md), no longer shipped inside the plugin.

    python tools/build_claude_pack.py [--out-dir dist] [--version 1.1.2]
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
PACK_ID = "builtin.claude-girl"


def build(source_dir, out_dir, version):
    credits = (source_dir / "CREDITS").read_text(encoding="utf-8").strip()
    license_text = (source_dir / "LICENSE").read_text(encoding="utf-8")
    manifest = {
        "id": PACK_ID, "version": version, "name": "Claude娘", "manifestVersion": 1, "packApi": 1,
        "license": "LicenseRef-Fan-Art-Undeclared", "credits": credits, "characters": [{"id": "claude-girl"}],
    }
    manifest["entryFurniture"] = {"id": "claude-book-bed"}
    folder = source_dir / "characters/claude-girl"
    bed = source_dir / "furniture/claude-book-bed"
    char = json.loads((folder / "character.json").read_text(encoding="utf-8"))
    if char["id"] != "claude-girl" or len([s for s in char["states"].values() if s.get("role")]) != 3:
        raise ValueError("Expected Claude-girl with all three headphone roles")
    frames = sorted((folder / "sprites").glob("*.png"))
    if not frames:
        raise ValueError("No Claude-girl frames found")
    voice_files = ["voice/preset.json", "voice/ref.wav", "voice/anchor.json"]
    bed_files = ["furniture.json", "preview.png"]
    bed_files.extend(p.relative_to(bed).as_posix() for p in sorted((bed / "sprites").glob("*.png")))
    bed_readme = (bed / "README.md").read_text(encoding="utf-8")
    bed_readme = bed_readme.replace("角色 ID 为 `orange-book-girl` 时", "Claude 娘（`claude-girl` 或旧 ID `orange-book-girl`）")
    bed_readme = bed_readme.replace(" · [入睡动图](sleep.gif)", "")
    output = out_dir / f"{PACK_ID}-{version}.petpack"
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_suffix(".tmp")
    with ZipFile(staged, "w", compression=ZIP_STORED) as zf:
        for name, content in [
            ("manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()),
            ("CREDITS", (credits + "\n").encode()),
            ("LICENSE", license_text.encode()),
            ("characters/claude-girl/character.json", (folder / "character.json").read_bytes()),
            *((f"characters/claude-girl/sprites/{p.name}", p.read_bytes()) for p in frames),
            *((f"characters/claude-girl/{p}", (folder / p).read_bytes()) for p in voice_files),
            *((f"furniture/claude-book-bed/{p}", (bed / p).read_bytes()) for p in bed_files),
            ("furniture/claude-book-bed/README.md", bed_readme.encode()),
        ]:
            member = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            member.external_attr = 0o100644 << 16
            zf.writestr(member, content)
    staged.replace(output)
    return output


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-dir", type=Path, default=ROOT / "packs-src/claude-girl")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "dist")
    ap.add_argument("--version", default="1.1.2")
    args = ap.parse_args()
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", args.version):
        ap.error("version must be a stable SemVer")
    output = build(args.source_dir, args.out_dir, args.version)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(json.dumps({
        "id": PACK_ID, "version": args.version, "name": "Claude娘",
        "summary": "换成小克来陪你，她的书页床和声音也一起带来。",
        "file": output.name, "size": output.stat().st_size, "sha256": digest,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
