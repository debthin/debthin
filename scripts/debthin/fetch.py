#!/usr/bin/env python3
"""
fetch.py - Concurrently fetch Packages.gz and InRelease files from upstream mirrors.

Reads config.json dynamically, computes target architectures and components,
and natively orchestrates high-throughput parallel downloads.

Optimized: Implements native TLS/TCP `Keep-Alive` Connection Pooling and overlapping
HTTP/2 multiplexing pipelines through `httpx.AsyncClient`, radically shrinking
underlying system latencies.
"""

import argparse
import asyncio
import gzip
import json
import lzma
import os
import sys
import httpx
from email.utils import formatdate
from typing import List, Tuple

def log(level: str, msg: str):
    if level == "ERROR":
        print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    else:
        print(f"  {msg}", file=sys.stderr, flush=True)

async def fetch_url(client: httpx.AsyncClient, sem: asyncio.Semaphore, url: str, output_path: str, use_ims: bool = True, retries: int = 3) -> bool:
    """Fetch URL asynchronously over potentially concurrent HTTP/2 pipes utilizing httpx."""
    headers = {"User-Agent": "debthin-build/1.0"}
    
    if use_ims and os.path.exists(output_path):
        mtime = os.path.getmtime(output_path)
        ims = formatdate(mtime, usegmt=True)
        headers["If-Modified-Since"] = ims

    for attempt in range(retries):
        try:
            async with sem:
                async with client.stream("GET", url, headers=headers) as response:
                    status = response.status_code
                    
                    if status == 304:
                        return True
                    if status == 404:
                        return False
                        
                    if status == 200:
                        # Write asynchronously arriving stream bytes natively
                        with open(output_path, "wb") as f:
                            async for chunk in response.aiter_bytes(chunk_size=65536):
                                f.write(chunk)
                        return True
                        
            # Soft retry penalty unhandled server dropouts gracefully
            if attempt < retries - 1:
                await asyncio.sleep(1)
            else:
                return False
                
        except Exception:
            if attempt < retries - 1:
                await asyncio.sleep(1)
            else:
                return False
                
    return False

async def handle_packages(client: httpx.AsyncClient, sem: asyncio.Semaphore, distro: str, upstream: str, suite: str, comp: str, arch: str):
    log("INFO", f"Fetch: {distro}/{suite}/{comp}/binary-{arch}")
    
    cache_dir = f".tmp_cache/{distro}/{suite}/{comp}/binary-{arch}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "Packages.gz")
    
    url_gz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.gz"
    
    success = await fetch_url(client, sem, url_gz, cache_file)
    if success:
        return
        
    log("WARN", f"WARNING: {url_gz} not available, falling back to xz...")
    
    url_xz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.xz"
    cache_xz = f"{cache_file}.xz"
    
    success_xz = await fetch_url(client, sem, url_xz, cache_xz, use_ims=False)
    if success_xz and os.path.exists(cache_xz):
        try:
            with lzma.open(cache_xz, "rb") as xz_f:
                with gzip.open(cache_file, "wb", compresslevel=1) as gz_f:
                    while chunk := xz_f.read(65536):
                        gz_f.write(chunk)
            os.remove(cache_xz)
        except Exception as e:
            log("ERROR", f"Failed recompressing {cache_xz}: {e}")
            sys.exit(1)
    else:
        log("WARN", f"WARNING: {distro}/{suite}/{comp}/{arch} purely unavailable")

async def handle_inrelease(client: httpx.AsyncClient, sem: asyncio.Semaphore, distro: str, upstream: str, suite: str):
    log("INFO", f"Fetch: {distro}/{suite}/InRelease")
    
    cache_dir = f".tmp_cache/{distro}/{suite}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "InRelease")
    
    url = f"{upstream}/dists/{suite}/InRelease"
    await fetch_url(client, sem, url, cache_file)

def parse_config(config_path: str) -> Tuple[List[dict], List[dict]]:
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    pkg_jobs = []
    inr_jobs = []
    
    for distro, c in config.items():
        if not isinstance(c, dict):
            continue
            
        up = c.get("upstream") or c.get("upstream_archive") or c.get("upstream_ports")
        if not up:
            continue
            
        suites = c.get("suites", {})
        for suite, smeta in suites.items():
            suite_up = smeta.get("upstream") or up
            inr_jobs.append({"distro": distro, "upstream": suite_up, "suite": suite})
            
            comps = smeta.get("components") or c.get("components") or []
            
            arches_map = []
            
            suite_arches = smeta.get("arches") or c.get("arches") or []
            for a in suite_arches:
                arches_map.append({"arch": a, "up": suite_up})
                
            archive_arches = c.get("archive_arches") or []
            for a in archive_arches:
                arches_map.append({"arch": a, "up": c.get("upstream_archive") or up})
                
            ports_arches = c.get("ports_arches") or []
            for a in ports_arches:
                arches_map.append({"arch": a, "up": c.get("upstream_ports") or up})
                
            for comp in comps:
                for am in arches_map:
                    pkg_jobs.append({
                        "distro": distro,
                        "upstream": am["up"],
                        "suite": suite,
                        "comp": comp,
                        "arch": am["arch"]
                    })
                    
    return pkg_jobs, inr_jobs

async def a_main():
    parser = argparse.ArgumentParser("Concurrently fetch packages natively via HTTP/2 asyncio.")
    parser.add_argument("config_file", nargs="?", default="config.json")
    parser.add_argument("--parallel", type=int, default=8, help="Max overlapping active connection pipes allowed")
    
    args = parser.parse_args()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    os.chdir(repo_root)
    
    if not os.path.exists(args.config_file):
        log("ERROR", f"config.json not found: {args.config_file}")
        sys.exit(1)
        
    pkg_jobs, inr_jobs = parse_config(args.config_file)
    
    print(f"Phase 1: fetching dynamically over HTTP/2 (multiplex_limit={args.parallel})...", file=sys.stderr)
    
    sem = asyncio.Semaphore(args.parallel)
    
    limits = httpx.Limits(max_keepalive_connections=8, max_connections=args.parallel)
    async with httpx.AsyncClient(http2=True, limits=limits, timeout=15.0) as client:
        tasks = []
        for j in pkg_jobs:
            tasks.append(handle_packages(client, sem, j["distro"], j["upstream"], j["suite"], j["comp"], j["arch"]))
        for j in inr_jobs:
            tasks.append(handle_inrelease(client, sem, j["distro"], j["upstream"], j["suite"]))
            
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, Exception):
                log("ERROR", f"Fetch exception: {r}")

def main():
    try:
        asyncio.run(a_main())
    except KeyboardInterrupt:
        print("\nInterrupt: 2")
        sys.exit(130)

if __name__ == "__main__":
    main()
