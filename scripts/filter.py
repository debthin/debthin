#!/usr/bin/env python3
"""
filter.py - Filter a Debian Packages index to a curated set.

Usage:
    python3 filter.py --input Packages.gz --allowed curated/all.txt --output Packages.gz
    python3 filter.py --input Packages.xz --allowed curated/all.txt --output Packages.gz
    python3 filter.py --input Packages    --allowed curated/all.txt --output Packages.gz
    curl .../Packages.gz | python3 filter.py --allowed curated/all.txt > Packages.gz
"""

import argparse
import gzip
import lzma
import sys
from pathlib import Path


def decompress(data: bytes, filename: str = "") -> str:
    """Decompress gzip, xz, or plain data."""
    if filename.endswith(".gz") or data[:2] == b"\x1f\x8b":
        return gzip.decompress(data).decode("utf-8", errors="replace")
    if filename.endswith(".xz") or data[:6] == b"\xfd7zXZ\x00":
        return lzma.decompress(data).decode("utf-8", errors="replace")
    return data.decode("utf-8", errors="replace")


def filter_packages(text: str, allowed: set[str]) -> bytes:
    out_blocks = []
    current_lines: list[str] = []
    current_pkg: str | None = None

    for line in text.splitlines(keepends=True):
        if line in ("\n", "\r\n"):
            if current_pkg and current_pkg in allowed:
                out_blocks.append("".join(current_lines) + "\n")
            current_lines = []
            current_pkg = None
        else:
            current_lines.append(line)
            if line.startswith("Package: "):
                current_pkg = line[9:].strip()

    # Handle final block with no trailing newline
    if current_pkg and current_pkg in allowed:
        out_blocks.append("".join(current_lines) + "\n")

    return gzip.compress("".join(out_blocks).encode("utf-8"), compresslevel=9)


def main():
    parser = argparse.ArgumentParser(description="Filter Debian Packages index")
    parser.add_argument("--input", "-i", help="Input Packages.gz/.xz/plain (default: stdin)")
    parser.add_argument("--allowed", "-a", required=True, help="File with allowed package names, one per line")
    parser.add_argument("--output", "-o", help="Output Packages.gz (default: stdout)")
    parser.add_argument("--stats", action="store_true", help="Print stats to stderr")
    args = parser.parse_args()

    allowed = {p for p in Path(args.allowed).read_text().splitlines() if p}

    input_data = Path(args.input).read_bytes() if args.input else sys.stdin.buffer.read()
    filename = args.input or ""
    text = decompress(input_data, filename)

    if args.stats:
        total_in = text.count("\nPackage: ") + 1
        print(f"Input packages:   {total_in}", file=sys.stderr)
        print(f"Allowed list:     {len(allowed)}", file=sys.stderr)

    filtered = filter_packages(text, allowed)

    if args.stats:
        total_out = gzip.decompress(filtered).decode("utf-8", errors="replace").count("\nPackage: ") + 1
        print(f"Output packages:  {total_out}", file=sys.stderr)
        print(f"Reduction:        {(1 - total_out/total_in)*100:.1f}%", file=sys.stderr)

    if args.output:
        Path(args.output).write_bytes(filtered)
    else:
        sys.stdout.buffer.write(filtered)


if __name__ == "__main__":
    main()
