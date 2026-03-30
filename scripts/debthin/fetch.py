#!/usr/bin/env python3
"""
fetch.py - Concurrently fetch Packages.gz and InRelease files from upstream mirrors.

Reads config.json dynamically, computes target architectures and components,
and natively orchestrates high-throughput parallel downloads.

Optimized: Implements native TLS/TCP `Keep-Alive` Connection Pooling across threads
to entirely bypass repeated expensive SSL handshakes over hundreds of small packets.
"""

import argparse
import concurrent.futures
import gzip
import json
import lzma
import os
import sys
import threading
import time
import http.client
import urllib.parse
from email.utils import formatdate
from typing import List, Tuple

tls_local = threading.local()

def log(level: str, msg: str):
    if level == "ERROR":
        print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    else:
        print(f"  {msg}", file=sys.stderr, flush=True)

def get_connection(netloc: str) -> http.client.HTTPSConnection:
    if not hasattr(tls_local, "conns"):
        tls_local.conns = {}
    if netloc not in tls_local.conns:
        tls_local.conns[netloc] = http.client.HTTPSConnection(netloc, timeout=15)
    return tls_local.conns[netloc]

def fetch_url(url: str, output_path: str, use_ims: bool = True, retries: int = 3) -> bool:
    """Fetch URL with HTTP Keep-Alive connection pooling, IMS cache comparison, and retries."""
    parsed = urllib.parse.urlparse(url)
    headers = {"User-Agent": "debthin-build/1.0", "Connection": "keep-alive"}
    
    if use_ims and os.path.exists(output_path):
        mtime = os.path.getmtime(output_path)
        ims = formatdate(mtime, usegmt=True)
        headers["If-Modified-Since"] = ims

    for attempt in range(retries):
        try:
            conn = get_connection(parsed.netloc)
            conn.request("GET", parsed.path, headers=headers)
            response = conn.getresponse()
            
            status = response.status
            
            if status == 304:
                response.read() # Drain precisely to preserve socket buffer
                return True
            if status == 404:
                response.read()
                return False
                
            if status == 200:
                with open(output_path, "wb") as f:
                    while chunk := response.read(65536):
                        f.write(chunk)
                return True
                
            # If server dropped random error, drain body fully
            response.read()
            if attempt < retries - 1:
                time.sleep(1)
            else:
                return False
                
        except Exception:
            # Ensure corrupted/dead TLS sockets are fully expunged prior to retry sequence
            if hasattr(tls_local, "conns") and parsed.netloc in tls_local.conns:
                try:
                    tls_local.conns[parsed.netloc].close()
                except Exception:
                    pass
                del tls_local.conns[parsed.netloc]
                
            if attempt < retries - 1:
                time.sleep(1)
            else:
                return False
                
    return False

def handle_packages(distro: str, upstream: str, suite: str, comp: str, arch: str):
    log("INFO", f"Fetch: {distro}/{suite}/{comp}/binary-{arch}")
    
    cache_dir = f".tmp_cache/{distro}/{suite}/{comp}/binary-{arch}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "Packages.gz")
    
    url_gz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.gz"
    
    success = fetch_url(url_gz, cache_file)
    if success:
        return
        
    log("WARN", f"WARNING: {url_gz} not available, falling back to xz...")
    
    url_xz = f"{upstream}/dists/{suite}/{comp}/binary-{arch}/Packages.xz"
    cache_xz = f"{cache_file}.xz"
    
    success_xz = fetch_url(url_xz, cache_xz, use_ims=False)
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

def handle_inrelease(distro: str, upstream: str, suite: str):
    log("INFO", f"Fetch: {distro}/{suite}/InRelease")
    
    cache_dir = f".tmp_cache/{distro}/{suite}"
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, "InRelease")
    
    url = f"{upstream}/dists/{suite}/InRelease"
    fetch_url(url, cache_file)

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

def main():
    parser = argparse.ArgumentParser("Concurrently fetch packages natively.")
    parser.add_argument("config_file", nargs="?", default="config.json")
    parser.add_argument("--parallel", type=int, default=8, help="Number of concurrent download threads")
    
    args = parser.parse_args()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    os.chdir(repo_root)
    
    if not os.path.exists(args.config_file):
        log("ERROR", f"config.json not found: {args.config_file}")
        sys.exit(1)
        
    pkg_jobs, inr_jobs = parse_config(args.config_file)
    
    print(f"Phase 1: fetching upstream indexes natively (parallel={args.parallel})...", file=sys.stderr)
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as executor:
        futures = []
        for j in pkg_jobs:
            f = executor.submit(handle_packages, j["distro"], j["upstream"], j["suite"], j["comp"], j["arch"])
            futures.append(f)
            
        for j in inr_jobs:
            f = executor.submit(handle_inrelease, j["distro"], j["upstream"], j["suite"])
            futures.append(f)
            
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as e:
                log("ERROR", f"Fetch exception: {e}")

if __name__ == "__main__":
    main()
