#!/usr/bin/env python3
"""
Fetch Debian popcon data + Packages index, filter to server-relevant packages,
output curated list split into primary (~10,000) and dependency (~1000) slots.

Usage:
    python3 curate.py [--suite trixie] [--arch amd64] [--output curated/packages.txt]
"""

import argparse
import gzip
import io
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

UPSTREAM = "https://deb.debian.org/debian"
POPCON_URL = "https://popcon.debian.org/main/by_inst.gz"
#POPCON_URL = "file:///root/by_inst.gz"

# Sections that are relevant for server containers
SERVER_SECTIONS = {
    "admin", "database", "devel", "editors", "interpreters",
    "java", "libs", "libdevel", "net", "perl", "python",
    "ruby", "rust", "shells", "text", "utils", "vcs",
    "web", "golang", "javascript", "httpd","video","sound"
}

# Sections explicitly excluded
EXCLUDED_SECTIONS = {
    "x11", "gnome", "kde", "xfce", "lxde", "mate", "cinnamon",
    "games", "graphics", "fonts", "doc",
    "debug", "oldlibs", "science", "math", "hamradio",
    "electronics", "embedded", "otherosfs", "news",
}

def get_required_packages(distro: str, suite: str) -> set[str]:
    """
    Read required packages resolving in order:
    1. required_packages/distro/suite.txt
    2. required_packages/distro.txt
    3. required_packages/debian.txt
    """
    candidates = [
        Path(f"required_packages/{distro}/{suite}.txt"),
        Path(f"required_packages/{distro}.txt"),
        Path(f"required_packages/debian.txt")
    ]
    
    for candidate in candidates:
        if candidate.is_file():
            print(f"  Loaded required packages from {candidate}", file=sys.stderr)
            content = candidate.read_text()
            # Return non-empty lines, ignoring comments
            return {
                line.split('#')[0].strip()
                for line in content.splitlines()
                if line.split('#')[0].strip()
            }
            
    print(f"  WARNING: No required packages lists found. Base packages may be omitted.", file=sys.stderr)
    return set()

def fetch_url(url: str) -> bytes:
    print(f"  Fetching {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "debian-slim-mirror/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch_popcon() -> dict[str, int]:
    """Returns {package: install_count}"""
    data = fetch_url(POPCON_URL)
    text = gzip.decompress(data).decode("utf-8", errors="replace")
    result = {}
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split()
        if len(parts) >= 2:
            try:
                # Format: rank, package, inst, vote, old, recent, no-files
                pkg = parts[1]
                inst = int(parts[2])
                result[pkg] = inst
            except (ValueError, IndexError):
                continue
    print(f"  Loaded {len(result)} packages from popcon", file=sys.stderr)
    return result


def fetch_packages_index(suite: str, arch: str) -> dict[str, dict]:
    """Returns {package_name: {section, depends, version, ...}}"""
    url = f"{UPSTREAM}/dists/{suite}/main/binary-{arch}/Packages.gz"
    data = fetch_url(url)
    text = gzip.decompress(data).decode("utf-8", errors="replace")

    packages = {}
    current = {}
    for line in text.splitlines():
        if line == "":
            if "Package" in current:
                packages[current["Package"]] = current
            current = {}
        elif line.startswith(" "):
            # Continuation line, skip for our purposes
            pass
        elif ": " in line:
            key, _, val = line.partition(": ")
            current[key] = val

    if "Package" in current:
        packages[current["Package"]] = current

    print(f"  Loaded {len(packages)} packages from {suite}/{arch}", file=sys.stderr)
    return packages


def parse_depends(dep_str: str) -> list[str]:
    """Extract package names from a Depends/Recommends string."""
    pkgs = []
    for group in dep_str.split(","):
        group = group.strip()
        # Take first alternative only
        alt = group.split("|")[0].strip()
        # Strip version constraints
        name = re.split(r"[\s(]", alt)[0].strip()
        if name:
            pkgs.append(name)
    return pkgs


def resolve_dependencies(
    primary: set[str],
    packages: dict[str, dict],
    dep_budget: int = 1000,
) -> set[str]:
    """
    BFS over Depends of primary set.
    Returns set of dependency packages not already in primary, up to dep_budget.
    """
    deps = set()
    queue = list(primary)
    seen = set(primary)

    while queue and len(deps) < dep_budget:
        pkg = queue.pop(0)
        info = packages.get(pkg, {})
        dep_str = info.get("Depends", "")
        if not dep_str:
            continue
        for dep in parse_depends(dep_str):
            # Add to resolve_dependencies() for debug
            if dep not in seen and dep in packages:
                seen.add(dep)
                deps.add(dep)
                queue.append(dep)
                if len(deps) >= dep_budget:
                    break

    return deps


DESKTOP_NAME_PREFIXES = (
    "gnome-", "kded", "kde-", "kf5-", "kf6-",
    "libkf5", "libkf6", "kwin-", "plasma-",
    "akonadi-", "kdenetwork-", "kdesdk-",
)

def is_server_relevant(info: dict) -> bool:
    pkg = info.get("Package", "")
    section = info.get("Section", "").lower().split("/")[-1]
    if any(pkg.startswith(p) for p in DESKTOP_NAME_PREFIXES):
        return False
    return section in SERVER_SECTIONS

def build_curated_list(
    distro: str,
    suite: str,
    arch: str,
    primary_budget: int = 10000,
    dep_budget: int = 1000,
) -> tuple[list[str], list[str]]:

    print(f"\nFetching popcon data...", file=sys.stderr)
    popcon = fetch_popcon()

    print(f"\nFetching Packages index for {suite}/{arch}...", file=sys.stderr)
    packages = fetch_packages_index(suite, arch)

    print(f"\nFiltering and ranking...", file=sys.stderr)


    scored = []
    for pkg, info in packages.items():
        if not is_server_relevant(info):
            continue
        score = popcon.get(pkg, 0)
        scored.append((score, pkg))

    scored.sort(reverse=True)

    primary = set()
    for score, pkg in scored:
        if score < 2500:
            break
        primary.add(pkg)

    # Force include critical packages regardless of popcon score
    required_packages = get_required_packages(distro, suite)
    for pkg in required_packages:
        if pkg in packages:
            primary.add(pkg)

    print(f"  Primary packages: {len(primary)}", file=sys.stderr)

    # Resolve dependencies within budget
    deps = resolve_dependencies(primary, packages, dep_budget)
    # Remove any that ended up in primary already
    deps -= primary

    print(f"  Dependency packages: {len(deps)}", file=sys.stderr)

    primary_sorted = sorted(primary)
    deps_sorted = sorted(deps)

    return primary_sorted, deps_sorted


def main():
    parser = argparse.ArgumentParser(description="Build curated Debian package list")
    parser.add_argument("--distro", default="debian")
    parser.add_argument("--suite", default="trixie")
    parser.add_argument("--arch", default="amd64")
    parser.add_argument("--primary-budget", type=int, default=10000)
    parser.add_argument("--dep-budget", type=int, default=1000)
    parser.add_argument("--output", default="curated/packages.txt")
    parser.add_argument("--deps-output", default="curated/deps.txt")
    args = parser.parse_args()

    primary, deps = build_curated_list(
        args.distro, args.suite, args.arch, args.primary_budget, args.dep_budget
    )

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(primary) + "\n")
    print(f"\nWrote {len(primary)} primary packages to {args.output}", file=sys.stderr)

    deps_out = Path(args.deps_output)
    deps_out.write_text("\n".join(deps) + "\n")
    print(f"Wrote {len(deps)} dependency packages to {args.deps_output}", file=sys.stderr)

    # Combined for filter.py consumption
    all_pkgs = sorted(set(primary) | set(deps))
    combined = Path(args.output).parent / "all.txt"
    combined.write_text("\n".join(all_pkgs) + "\n")
    print(f"Wrote {len(all_pkgs)} total packages to {combined}", file=sys.stderr)


if __name__ == "__main__":
    main()
