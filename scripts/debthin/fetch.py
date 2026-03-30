#!/usr/bin/env python3
"""
fetch.py - Fetch a single Packages.gz or InRelease from upstream natively.

Replaces fetch.sh. Automatically supports If-Modified-Since caching, automatic
retries, and transparent fallbacks from .gz to .xz compression formats natively
without pulling system binaries.

Usage:
  python3 fetch.py packages <distro> <upstream> <suite> <component> <arch>
  python3 fetch.py inrelease <distro> <upstream> <suite>
"""

import gzip
import lzma
import os
import sys
import time
import urllib.error
import urllib.request
from email.utils import formatdate

def fetch_url(url: str, output_path: str, use_ims: bool = True, retries: int = 3) -> bool:
    """Fetch URL with Optional If-Modified-Since caching and retries."""
    headers = {"User-Agent": "debthin-build/1.0"}
    
    if use_ims and os.path.exists(output_path):
        mtime = os.path.getmtime(output_path)
        ims = formatdate(mtime, usegmt=True)
        headers["If-Modified-Since"] = ims

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                with open(output_path, "wb") as f:
                    # Write the chunk directly to disk
                    while chunk := response.read(65536):
                        f.write(chunk)
                return True
                
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return True # Cache hit (Not Modified)
            if e.code == 404:
                return False # Not found
            if attempt < retries - 1:
                time.sleep(5)
            else:
                return False
                
        except Exception:
            if attempt < retries - 1:
                time.sleep(5)
            else:
                return False
                
    return False

def handle_packages(distro: str, upstream: str, suite: str, comp: str, arch: str):
    print(f"  Fetch: {distro}/{suite}/{comp}/binary-{arch}", file=sys.stderr)
    
    cache_dir = f".tmp_cache/{distro}/{suite}/{comp}/binary-{arch}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "Packages.gz")
    
    url_gz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.gz"
    
    success = fetch_url(url_gz, cache_file)
    if success:
        return
        
    print(f"WARNING: {url_gz} not available, falling back to xz...", file=sys.stderr)
    
    # Fallback to xz
    url_xz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.xz"
    cache_xz = f"{cache_file}.xz"
    
    success_xz = fetch_url(url_xz, cache_xz, use_ims=False)
    if success_xz and os.path.exists(cache_xz):
        try:
            # Recompress from xz to gz
            with lzma.open(cache_xz, "rb") as xz_f:
                with gzip.open(cache_file, "wb", compresslevel=1) as gz_f:
                    while chunk := xz_f.read(65536):
                        gz_f.write(chunk)
            os.remove(cache_xz)
        except Exception as e:
            print(f"ERROR: Failed recompressing {cache_xz}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"WARNING: {distro}/{suite}/{comp}/{arch} purely unavailable", file=sys.stderr)

def handle_inrelease(distro: str, upstream: str, suite: str):
    print(f"  Fetch: {distro}/{suite}/InRelease", file=sys.stderr)
    
    cache_dir = f".tmp_cache/{distro}/{suite}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "InRelease")
    
    url = f"{upstream}/dists/{suite}/InRelease"
    fetch_url(url, cache_file)

def main():
    if len(sys.argv) < 2:
        print("Usage: fetch.py {packages|inrelease} ...", file=sys.stderr)
        sys.exit(1)
        
    mode = sys.argv[1]
    
    # Resolve CWD to repo root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    os.chdir(repo_root)
    
    if mode == "packages":
        if len(sys.argv) < 7:
            print("Usage: fetch.py packages <distro> <upstream> <suite> <component> <arch>", file=sys.stderr)
            sys.exit(1)
        handle_packages(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
    elif mode == "inrelease":
        if len(sys.argv) < 5:
            print("Usage: fetch.py inrelease <distro> <upstream> <suite>", file=sys.stderr)
            sys.exit(1)
        handle_inrelease(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(f"Unknown mode: {mode}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
