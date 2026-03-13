#!/usr/bin/env python3
"""
filter.py - Filter Debian Packages indexes to a curated set.

Single-file mode (original):
    python3 filter.py --input Packages.gz --allowed all.txt --output Packages.gz

Batch mode (fast - one process, many files):
    python3 filter.py --allowed all.txt --batch jobs.tsv

jobs.tsv is tab-separated: input_path<TAB>output_path, one job per line.
Allowed list is loaded once and reused across all jobs.

If the input has fewer than 100 packages it is passed through unchanged.
"""

import argparse
import gzip
import lzma
import re
import sys
from pathlib import Path

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
    # Strip major/minor versions for known language/compiler stacks
    name = re.sub(b'(python3)\\.[0-9]+', b'\\1.', name)
    name = re.sub(b'(php)[0-9]+\\.[0-9]+', b'\\1.', name)
    name = re.sub(b'(ruby)[0-9]+\\.[0-9]+', b'\\1.', name)
    name = re.sub(b'(gcc|g\\+\\+|cpp|libgcc|libstdc\\+\\+|libgfortran|llvm|clang|libclang|liblldb|lldb)-[0-9]+', b'\\1-', name)
    return name


def filter_packages(raw: bytes, allowed: set, gen_allowed: set) -> bytes:
    # Keyed by generalize_name(pkg_name): (version_str, stanza_bytes)
    kept: dict[bytes, tuple[str, bytes]] = {}
    
    VER_PREFIX = b"Version: "
    
    for stanza in raw.split(b"\n\n"):
        if not stanza:
            continue
            
        pkg_name = b""
        version = b""
        
        # Extract Package and Version lines efficiently
        lines = stanza.split(b"\n")
        for line in lines:
            if line.startswith(PKG_PREFIX):
                pkg_name = line[len(PKG_PREFIX):]
            elif line.startswith(VER_PREFIX):
                version = line[len(VER_PREFIX):]
            
            if pkg_name and version: # Found both, no need to parse more lines for this stanza
                break
                
        if pkg_name:
            gen_name = generalize_name(pkg_name)
            
            # Check if the specific package name or its generalized form is allowed
            if pkg_name in allowed or gen_name in gen_allowed:
                v_str = version.decode('utf-8', errors='ignore')
                
                if gen_name in kept:
                    old_v_str, _ = kept[gen_name]
                    if compare_debian_versions(v_str, old_v_str) > 0:
                        kept[gen_name] = (v_str, stanza)
                else:
                    kept[gen_name] = (v_str, stanza)

    out = [stanza for _, stanza in kept.values()]
    result = b"\n\n".join(out)
    if result:
        result += b"\n"
    return gzip.compress(result, compresslevel=1)


def process_one(input_path: str, output_path: str, allowed: set, gen_allowed: set, stats: bool) -> None:
    raw_input = Path(input_path).read_bytes() if input_path else sys.stdin.buffer.read()
    raw = decompress(raw_input, input_path or "")
    total_in = count_packages(raw)

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

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(filtered)
    else:
        sys.stdout.buffer.write(filtered)


def main():
    parser = argparse.ArgumentParser(description="Filter Debian Packages indexes")
    parser.add_argument("--allowed", "-a", required=True, help="Allowed package names, one per line")
    parser.add_argument("--stats",   action="store_true", help="Print stats to stderr")
    # Single-file mode
    parser.add_argument("--input",  "-i", help="Input file (single mode)")
    parser.add_argument("--output", "-o", help="Output file (single mode)")
    # Batch mode
    parser.add_argument("--batch",  "-b", help="TSV file: input<TAB>output per line")
    args = parser.parse_args()

    allowed = {p.encode() for p in Path(args.allowed).read_text().splitlines() if p}
    gen_allowed = {generalize_name(p) for p in allowed}

    if args.batch:
        jobs = []
        for line in Path(args.batch).read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t", 1)
            if len(parts) != 2:
                print(f"WARNING: bad batch line: {line!r}", file=sys.stderr)
                continue
            jobs.append((parts[0], parts[1]))

        if args.stats:
            print(f"Batch: {len(jobs)} jobs, allowed list: {len(allowed)}", file=sys.stderr)

        for input_path, output_path in jobs:
            process_one(input_path, output_path, allowed, gen_allowed, args.stats)
    else:
        if args.stats:
            print(f"Allowed list: {len(allowed)}", file=sys.stderr)
        process_one(args.input or "", args.output or "", allowed, gen_allowed, args.stats)


if __name__ == "__main__":
    main()
