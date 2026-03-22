#!/usr/bin/env python3
"""
generate_image_manifest.py - Build a static images-manifest.json from images_output.

Walks the images_output/images/ tree, reads hashes.txt in each version directory,
and writes a JSON manifest suitable for the images worker to serve LXC and Incus
indexes without dynamic bucket listing.

Intended to run as part of the Makefile build chain after all images are built,
before uploading to R2.

Expected tree structure:
  images_output/images/{os}/{release}/{arch}/{variant}/{version}/
    hashes.txt      (sha256sum output)
    incus.tar.xz
    rootfs.tar.xz
    ...

Output format (images-manifest.json):
  [
    {
      "os": "debian",
      "release": "bookworm",
      "arch": "amd64",
      "variant": "default",
      "version": "20231010_0123",
      "filename": "rootfs.tar.xz",
      "key": "images/debian/bookworm/amd64/default/20231010_0123/rootfs.tar.xz",
      "size": 30000000,
      "sha256": "abc123..."
    },
    ...
  ]

Usage:
  python3 scripts/generate_image_manifest.py --dir images_output
"""

import argparse
import json
import os
import sys
from pathlib import Path


def parse_hashes_file(hashes_path):
    """
    Reads a hashes.txt file (sha256sum format) and returns a dict mapping
    filename to sha256 hash.

    Each line is expected to be: <hash>  ./<filename>

    Args:
        hashes_path: Path to the hashes.txt file.

    Returns:
        dict mapping bare filenames to hex digest strings.
    """
    hashes = {}
    with open(hashes_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            sha256 = parts[0]
            # sha256sum output uses  ./<filename>
            name = parts[1].lstrip("./").strip()
            hashes[name] = sha256
    return hashes


def build_manifest(images_dir):
    """
    Walks the images/ tree under the given directory and builds the manifest
    entries list. Reads hashes.txt from each version directory to resolve
    sha256 checksums for each file.

    Args:
        images_dir: Path to the images_output/ root directory.

    Returns:
        list of entry dicts suitable for JSON serialisation.
    """
    base = images_dir / "images"
    if not base.is_dir():
        print(f"ERROR: {base} does not exist or is not a directory", file=sys.stderr)
        sys.exit(1)

    entries = []

    for root, _dirs, files in sorted(os.walk(base)):
        root_path = Path(root)
        rel = root_path.relative_to(images_dir)
        parts = rel.parts  # ('images', os, release, arch, variant, version)

        if len(parts) != 6:
            continue

        _, img_os, release, arch, variant, version = parts

        # Skip hidden directories
        if any(p.startswith(".") for p in parts):
            continue

        hashes_path = root_path / "hashes.txt"
        hashes = parse_hashes_file(hashes_path) if hashes_path.is_file() else {}

        for filename in sorted(files):
            if filename == "hashes.txt":
                continue

            filepath = root_path / filename
            size = filepath.stat().st_size
            key = str(rel / filename)
            sha256 = hashes.get(filename)

            entries.append({
                "os": img_os,
                "release": release,
                "arch": arch,
                "variant": variant,
                "version": version,
                "filename": filename,
                "key": key,
                "size": size,
                "sha256": sha256,
            })

    return entries


def main():
    parser = argparse.ArgumentParser(
        description="Generate images-manifest.json from built image output"
    )
    parser.add_argument(
        "--dir",
        required=True,
        help="Root images_output directory containing images/ tree",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output path for manifest JSON (default: <dir>/images-manifest.json)",
    )
    args = parser.parse_args()

    images_dir = Path(args.dir)
    output_path = Path(args.output) if args.output else images_dir / "images-manifest.json"

    entries = build_manifest(images_dir)

    with open(output_path, "w") as f:
        json.dump(entries, f, separators=(",", ":"))

    print(f"Wrote {len(entries)} entries to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
