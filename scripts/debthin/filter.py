#!/usr/bin/env python3
"""
filter.py - Filter Debian Packages indexes to a curated set.

Orchestrates allowlist resolution natively over config.json, scans filesystem
mtimes against dist_output, and merges required payloads inside sets avoiding
slow shell pipes.

Usage:
    python3 filter.py <distro> <suite> [--config config.json] [--stats]
"""

import argparse
import gzip
import json
import lzma
import os
import re
import sys
from pathlib import Path
from typing import Set, Tuple, List

PASSTHROUGH_THRESHOLD = 100
PKG_PREFIX = b"Package: "


def decompress(data: bytes, filename: str = "") -> bytes:
    if filename.endswith(".gz") or data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    if filename.endswith(".xz") or data[:6] == b"\xfd7zXZ\x00":
        return lzma.decompress(data)
    return data


def count_packages(raw: bytes) -> int:
    return raw.count(b"\nPackage: ") + (1 if raw.startswith(b"Package: ") else 0)


def generalize_name(pkg_name: bytes) -> bytes:
    """Safely strip volatile version/architecture suffixes from package names."""
    # Strip t64 suffix from base name (but preserve trailing components like -dbg)
    name = re.sub(b't64(-|$)', b'\\1', pkg_name)
    # Generic rule: strip hyphenated versions like -14, -3.12, etc anywhere in the name
    name = re.sub(b'-[0-9]+(?:\\.[0-9]+)*(?=-|$)', b'-', name)
    # Generic rule: strip dot versions directly attached to names like python3.12 or gir1.2
    name = re.sub(b'([a-z]+)[0-9]+\\.[0-9]+(?=-|$)', b'\\1.', name)
    return name


def filter_packages(raw: bytes, allowed: set, gen_allowed: set) -> bytes:
    out = []
    for stanza in raw.split(b"\n\n"):
        if not stanza:
            continue
        for line in stanza.split(b"\n", 3):
            if line.startswith(PKG_PREFIX):
                pkg_name = line[len(PKG_PREFIX):]
                if pkg_name in allowed or generalize_name(pkg_name) in gen_allowed:
                    out.append(stanza)
                break
    result = b"\n\n".join(out)
    if result:
        result += b"\n"
    return gzip.compress(result, compresslevel=1)


def process_one(input_path: str, output_path: str, allowed: set, gen_allowed: set, stats: bool) -> None:
    raw_input = Path(input_path).read_bytes()
    raw = decompress(raw_input, input_path)
    total_in = count_packages(raw)

    # Write upstream count sidecar so validate.py can skip decompression
    count_path = Path(input_path).with_suffix(".count")
    count_path.write_text(str(total_in))

    if stats:
        print(f"  {input_path}: {total_in} packages", file=sys.stderr)

    if total_in < PASSTHROUGH_THRESHOLD:
        filtered = gzip.compress(raw, compresslevel=1)
    else:
        filtered = filter_packages(raw, allowed, gen_allowed)
        if stats:
            total_out = count_packages(gzip.decompress(filtered))
            pct = (1 - total_out / total_in) * 100
            print(f"    → {total_out} ({pct:.0f}% reduction)", file=sys.stderr)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_bytes(filtered)


def resolve_allowlist(config_path: str, distro: str, suite: str) -> Tuple[str, List[str]]:
    """Resolves primary allowed list and dependencies following original bash loop."""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception as e:
        print(f"ERROR: failed loading {config_path}: {e}", file=sys.stderr)
        sys.exit(1)
        
    dist_config = config.get(distro, {})
    suites = dist_config.get("suites", {})
    suite_config = suites.get(suite, {})
    
    curated_base = suite_config.get("curated_base", "")
    
    # Resolve stable_suite
    stable_suite = ""
    debian_suites = config.get("debian", {}).get("suites", {})
    for k, v in debian_suites.items():
        if "stable" in v.get("aliases", []):
            stable_suite = k
            break
            
    allowed_path = None
    if curated_base and os.path.exists(f"curated/{curated_base}/all.txt"):
        allowed_path = f"curated/{curated_base}/all.txt"
    elif os.path.exists(f"curated/{distro}/{suite}/all.txt"):
        allowed_path = f"curated/{distro}/{suite}/all.txt"
    elif stable_suite and os.path.exists(f"curated/{distro}/{stable_suite}/all.txt"):
        allowed_path = f"curated/{distro}/{stable_suite}/all.txt"
    elif stable_suite and os.path.exists(f"curated/debian/{stable_suite}/all.txt"):
        allowed_path = f"curated/debian/{stable_suite}/all.txt"
    else:
        print(f"ERROR: no allowed list found for {distro}/{suite} and fallback failed", file=sys.stderr)
        sys.exit(1)
        
    req_path = None
    if os.path.exists(f"required_packages/{distro}/{suite}.txt"):
        req_path = f"required_packages/{distro}/{suite}.txt"
    elif os.path.exists(f"required_packages/{distro}.txt"):
        req_path = f"required_packages/{distro}.txt"
    elif os.path.exists(f"required_packages/debian.txt"):
        req_path = f"required_packages/debian.txt"
        
    mtimes = [os.path.getmtime(allowed_path)]
    if req_path:
        mtimes.append(os.path.getmtime(req_path))
        
    return allowed_path, req_path, mtimes


def main():
    parser = argparse.ArgumentParser(description="Filter Debian Packages natively by distro/suite")
    parser.add_argument("distro", help="Target distribution")
    parser.add_argument("suite", help="Target suite")
    parser.add_argument("--config", default="config.json", help="Config file")
    parser.add_argument("--stats", action="store_true", default=True, help="Print stats to stderr")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    os.chdir(repo_root)
    
    allowed_path, req_path, filter_mtimes = resolve_allowlist(args.config, args.distro, args.suite)
    
    print(f"  Allowed list for {args.distro}/{args.suite}: {allowed_path}", file=sys.stderr)
    
    # Merge lists natively
    allowed_set = set()
    for p in Path(allowed_path).read_text().splitlines():
        p = p.strip()
        if p:
            allowed_set.add(p.encode())
            
    if req_path:
        print(f"  Required packages: {req_path}", file=sys.stderr)
        for p in Path(req_path).read_text().splitlines():
            p = p.strip()
            if p:
                allowed_set.add(p.encode())
                
    gen_allowed = {generalize_name(p) for p in allowed_set}
    
    # Dynamically find jobs via fs traversal
    cache_dir = f".tmp_cache/{args.distro}/{args.suite}"
    jobs = []
    
    if os.path.exists(cache_dir):
        for root, _, files in os.walk(cache_dir):
            for file in files:
                if file == "Packages.gz":
                    cachefile = os.path.join(root, file)
                    outfile = cachefile.replace(f".tmp_cache/{args.distro}/", f"dist_output/dists/{args.distro}/", 1)
                    
                    needs_filter = False
                    if not os.path.exists(outfile):
                        needs_filter = True
                    else:
                        out_time = os.path.getmtime(outfile)
                        if os.path.getmtime(cachefile) > out_time:
                            needs_filter = True
                        elif max(filter_mtimes) > out_time:
                            needs_filter = True
                        elif os.path.getmtime(os.path.abspath(__file__)) > out_time:
                            needs_filter = True
                            
                    if needs_filter:
                        jobs.append((cachefile, outfile))
                        
    if not jobs:
        print(f"  Skipping filtering for {args.distro}/{args.suite} (unchanged)", file=sys.stderr)
        sys.exit(0)
        
    if args.stats:
        print(f"Batch: {len(jobs)} jobs, allowed list: {len(allowed_set)}", file=sys.stderr)

    for input_path, output_path in sorted(jobs, key=lambda x: x[0]):
        process_one(input_path, output_path, allowed_set, gen_allowed, args.stats)


if __name__ == "__main__":
    main()
