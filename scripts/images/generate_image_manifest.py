#!/usr/bin/env python3
"""
generate_image_manifest.py - Build registry-state.json from images_output.

Walks the images_output/images/ tree and produces a single JSON file that
the images worker hydrates at runtime. The output contains all index data
pre-computed, eliminating any need for dynamic bucket listing.

Expected tree structure:
  images_output/images/{os}/{release}/{arch}/{variant}/{version}/
    hashes.txt      (sha256sum output, consumed but not included)
    incus.tar.xz
    meta.tar.xz
    rootfs.tar.xz
    rootfs.squashfs
    oci/
      oci-layout
      index.json
      blobs/sha256/...

Output format (registry-state.json):
  {
    "lxc_csv":       "os;release;arch;variant;version;/images/...\n...",
    "incus_json":    { ... simplestreams products tree ... },
    "oci_blobs":     { "sha256:<hex>": "images/.../blobs/sha256/<hex>", ... },
    "oci_manifests": { "<repo>:<tag>": "images/.../oci/index.json", ... },
    "file_sizes":    { "images/.../incus.tar.xz": 696, ... }
  }

Usage:
  python3 scripts/generate_image_manifest.py --dir images_output
  python3 scripts/generate_image_manifest.py --dir images_output --output registry-state.json
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
            name = parts[1].lstrip("./").strip()
            hashes[name] = sha256
    return hashes


def walk_images(images_dir):
    """
    Walks the images/ tree under the given directory and collects file
    entries grouped by version directory.

    Args:
        images_dir: Path to the images_output/ root directory.

    Returns:
        List of dicts with keys: os, release, arch, variant, version,
        filename, key, size, sha256.
    """
    base = images_dir / "images"
    if not base.is_dir():
        print(f"ERROR: {base} does not exist or is not a directory", file=sys.stderr)
        sys.exit(1)

    entries = []

    for root, _dirs, files in sorted(os.walk(base)):
        root_path = Path(root)
        rel = root_path.relative_to(images_dir)
        parts = rel.parts

        if len(parts) < 6:
            continue

        _, img_os, release, arch, variant, version = parts[:6]

        if any(p.startswith(".") for p in parts):
            continue

        # Resolve hashes only for version-level directories
        hashes = {}
        if len(parts) == 6:
            hashes_path = root_path / "hashes.txt"
            if hashes_path.is_file():
                hashes = parse_hashes_file(hashes_path)

        for filename in sorted(files):
            if filename in ("hashes.txt", "oci-layout"):
                continue

            filepath = root_path / filename
            size = filepath.stat().st_size
            key = str(rel / filename)

            entries.append({
                "os": img_os,
                "release": release,
                "arch": arch,
                "variant": variant,
                "version": version,
                "filename": filename,
                "key": key,
                "size": size,
                "sha256": hashes.get(filename),
                "depth": len(parts),
                "subpath": "/".join(parts[6:]) if len(parts) > 6 else "",
            })

    return entries


def build_lxc_csv(entries):
    """
    Builds the semicolon-delimited LXC index from version-level entries.
    Each version directory produces one CSV line. Only version-level entries
    (depth 6) with incus.tar.xz are included since that signals a valid image.

    Returns:
        str: Newline-separated CSV string.
    """
    seen = set()
    lines = []
    for e in entries:
        if e["depth"] != 6 or e["filename"] != "incus.tar.xz":
            continue

        key = (e["os"], e["release"], e["arch"], e["variant"], e["version"])
        if key in seen:
            continue
        seen.add(key)

        path = f'/images/{e["os"]}/{e["release"]}/{e["arch"]}/{e["variant"]}/{e["version"]}/'
        lines.append(f'{e["os"]};{e["release"]};{e["arch"]};{e["variant"]};{e["version"]};{path}')

    return "\n".join(sorted(lines))


def build_incus_json(entries):
    """
    Builds the Simplestreams products tree consumed by Incus/LXD clients.
    Only includes version-level files (depth 6) with valid sha256 hashes.

    Returns:
        dict: The complete Simplestreams JSON structure.
    """
    products = {}

    for e in entries:
        if e["depth"] != 6 or not e["sha256"]:
            continue

        product_key = f'{e["os"]}:{e["release"]}:{e["arch"]}:{e["variant"]}'

        if product_key not in products:
            products[product_key] = {
                "aliases": f'{e["os"]}/{e["release"]}',
                "arch": e["arch"],
                "os": e["os"].capitalize(),
                "release": e["release"],
                "variant": e["variant"],
                "versions": {},
            }

        product = products[product_key]
        versions = product["versions"]

        if e["version"] not in versions:
            versions[e["version"]] = {"items": {}}

        versions[e["version"]]["items"][e["filename"]] = {
            "ftype": e["filename"],
            "size": e["size"],
            "sha256": e["sha256"],
        }

    return {
        "content_id": "images",
        "datatype": "image-downloads",
        "format": "products:1.0",
        "products": products,
    }


def build_oci_maps(entries):
    """
    Builds OCI blob and manifest lookup dictionaries from OCI subdirectory
    entries. Blobs are identified by their sha256 filename under blobs/sha256/.
    Manifests are keyed by repo:tag derived from the image path.

    Returns:
        tuple: (oci_blobs dict, oci_manifests dict)
    """
    blobs = {}
    manifests = {}

    for e in entries:
        if e["depth"] == 6:
            continue

        subpath = e["subpath"]

        # OCI blob: oci/blobs/sha256/<hex>
        if subpath.startswith("oci/blobs/sha256"):
            digest = f"sha256:{e['filename']}"
            blobs[digest] = e["key"]

        # OCI image index: oci/index.json
        elif subpath == "oci" and e["filename"] == "index.json":
            repo = f'{e["os"]}/{e["release"]}'
            tag = e["version"]
            manifests[f"{repo}:{tag}"] = e["key"]

    return blobs, manifests


def build_file_sizes(entries):
    """
    Builds a flat key-to-size dictionary from all entries.

    Returns:
        dict: R2 key to file size in bytes.
    """
    return {e["key"]: e["size"] for e in entries}


def build_registry_state(images_dir):
    """
    Produces the complete registry-state.json structure from the image tree.

    Args:
        images_dir: Path to the images_output/ root directory.

    Returns:
        dict: The registry state ready for JSON serialisation.
    """
    entries = walk_images(images_dir)
    oci_blobs, oci_manifests = build_oci_maps(entries)

    return {
        "lxc_csv": build_lxc_csv(entries),
        "incus_json": build_incus_json(entries),
        "oci_blobs": oci_blobs,
        "oci_manifests": oci_manifests,
        "file_sizes": build_file_sizes(entries),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Generate registry-state.json from built image output"
    )
    parser.add_argument(
        "--dir",
        required=True,
        help="Root images_output directory containing images/ tree",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output path (default: <dir>/registry-state.json)",
    )
    args = parser.parse_args()

    images_dir = Path(args.dir)
    output_path = Path(args.output) if args.output else images_dir / "registry-state.json"

    state = build_registry_state(images_dir)

    with open(output_path, "w") as f:
        json.dump(state, f, separators=(",", ":"))

    # Summary stats
    n_files = len(state["file_sizes"])
    n_products = len(state["incus_json"]["products"])
    n_blobs = len(state["oci_blobs"])
    n_manifests = len(state["oci_manifests"])
    lxc_lines = state["lxc_csv"].count("\n") + (1 if state["lxc_csv"] else 0)

    print(
        f"Wrote registry-state.json: {n_files} files, {lxc_lines} LXC entries, "
        f"{n_products} Incus products, {n_blobs} OCI blobs, {n_manifests} OCI manifests",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
