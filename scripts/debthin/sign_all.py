#!/usr/bin/env python3
"""
sign_all.py - Generate Release files and sign all suites in one GPG session.

Replaces sign_all.sh. It parses config.json without invoking jq, fetches
metadata, builds Release files in parallel via ProcessPoolExecutor,
and utilizes native python subprocess calls to batch sign artifacts via gpg.
"""

import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
from typing import Dict, List, Optional, Set, Tuple

print_lock = threading.Lock()

def log(level: str, msg: str):
    with print_lock:
        if level == "ERROR":
            print(f"ERROR: {msg}", file=sys.stderr, flush=True)
        else:
            print(f"  {msg}", flush=True)

def parse_config(config_path: str) -> List[Tuple[str, str, str, str, str]]:
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    jobs = []
    
    for distro, c in config.items():
        if not isinstance(c, dict):
            continue
            
        up = c.get("upstream") or c.get("upstream_archive") or c.get("upstream_ports")
        if not up:
            continue
            
        suites = c.get("suites", {})
        for suite, smeta in suites.items():
            # Components
            comps = smeta.get("components") or c.get("components") or []
            comps_csv = ",".join(comps)
            
            # Arches (flatten, deduplicate)
            arches: Set[str] = set()
            for alist in [smeta.get("arches"), c.get("arches"), c.get("archive_arches"), c.get("ports_arches")]:
                if isinstance(alist, list):
                    arches.update(alist)
            
            arches_csv = ",".join(sorted(list(arches)))
            
            # Upstream
            suite_up = smeta.get("upstream") or up
            
            jobs.append((distro, suite_up, suite, comps_csv, arches_csv))
            
    return jobs

def format_date_rfc2822(dt_val: Optional[datetime.datetime] = None) -> str:
    if not dt_val:
        dt_val = datetime.datetime.now(datetime.timezone.utc)
    # Output e.g., "Mon, 30 Mar 2026 12:00:00 UTC"
    return dt_val.strftime("%a, %d %b %Y %H:%M:%S UTC")

def fetch_upstream_inrelease(url: str, cache_path: str) -> bool:
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "debthin-build/1.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            content = response.read()
            with open(cache_path, "wb") as f:
                f.write(content)
            return True
    except Exception as e:
        # Fails silently as some upstream suites don't exist yet/any longer
        log("DEBUG", f"Failed fetching {url}: {e}")
        return False

def parse_inrelease_data(content: str) -> Dict[str, str]:
    fields = {}
    for line in content.splitlines():
        if line.startswith(" ") or not line:
            continue
        if ":" in line:
            parts = line.split(":", 1)
            key = parts[0].strip()
            val = parts[1].strip()
            if key not in fields:
                fields[key] = val
    return fields

def compute_hash_and_size(filepath: str, is_gzip: bool = False) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    if is_gzip:
        with gzip.open(filepath, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
                size += len(chunk)
    else:
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
                size += len(chunk)
    return h.hexdigest(), size

def compute_string_hash_and_size(data: str) -> Tuple[str, int]:
    bdata = data.encode("utf-8")
    h = hashlib.sha256(bdata).hexdigest()
    return h, len(bdata)

def generate_release(distro: str, upstream_base: str, suite: str, components_csv: str, arches_csv: str, repo_root: str, dist_output: str) -> None:
    dist_dir = os.path.join(dist_output, "dists", distro, suite)
    
    if not os.path.isdir(dist_dir):
        log("INFO", f"Skipping {distro}/{suite} (no output dir)")
        return
        
    # Append headless component if directory exists
    comps = set(components_csv.split(",")) if components_csv else set()
    if os.path.isdir(os.path.join(dist_dir, "headless")):
        comps.add("headless")
    components_csv = ",".join(sorted(list(comps)))
    
    inrelease_cache = os.path.join(repo_root, ".tmp_cache", distro, suite, "InRelease")
    release_output = os.path.join(dist_dir, "Release")
    
    # Needs Release generation check (cache vs latest packages)
    needs_release = False
    if not os.path.exists(release_output):
        needs_release = True
    elif os.path.exists(inrelease_cache) and os.path.getmtime(inrelease_cache) > os.path.getmtime(release_output):
        needs_release = True
    else:
        # Check all Packages.gz in the tree
        for root, _, files in os.walk(dist_dir):
            for file in files:
                if file == "Packages.gz":
                    pkg_path = os.path.join(root, file)
                    if os.path.getmtime(pkg_path) > os.path.getmtime(release_output):
                        needs_release = True
                        break
            if needs_release:
                break
                
    # Also check script time vs release
    script_path = os.path.abspath(__file__)
    if os.path.exists(script_path) and os.path.exists(release_output):
        if os.path.getmtime(script_path) > os.path.getmtime(release_output):
            needs_release = True
            
    if not needs_release:
        log("INFO", f"Skipping Release generation for {distro}/{suite} (unchanged)")
        return
        
    url = f"{upstream_base}/dists/{suite}/InRelease".rstrip("/")
    if not os.path.exists(inrelease_cache):
        fetch_upstream_inrelease(url, inrelease_cache)
        
    upstream_content = ""
    if os.path.exists(inrelease_cache):
        try:
            with open(inrelease_cache, "r", encoding="utf-8", errors="ignore") as f:
                upstream_content = f.read()
        except:
            pass

    fields = parse_inrelease_data(upstream_content)
    upstream_suite = fields.get("Suite", suite)
    upstream_version = fields.get("Version", "")
    upstream_date = fields.get("Date", "")
    upstream_changelogs = fields.get("Changelogs", "")
    
    date_out = upstream_date if upstream_date else format_date_rfc2822()
    
    if upstream_version:
        desc = f"Curated server package index for {distro.capitalize()} {upstream_version} ({suite}) - debthin.org"
    else:
        desc = f"Curated server package index for {distro.capitalize()} {suite} - debthin.org"
        
    # Process Packages
    sha256_lines = []
    
    packages_files = []
    for root, _, files in os.walk(dist_dir):
        for file in files:
            if file == "Packages.gz":
                packages_files.append(os.path.join(root, file))
                
    for pf in sorted(packages_files):
        rel_path = os.path.relpath(pf, dist_dir)
        rel_base = rel_path[:-3] # remove .gz
        reldir = os.path.dirname(rel_path)
        
        sha256_gz, size_gz = compute_hash_and_size(pf, is_gzip=False)
        sha256_raw, size_raw = compute_hash_and_size(pf, is_gzip=True)
        
        sha256_lines.append(f" {sha256_gz} {size_gz} {rel_path}")
        sha256_lines.append(f" {sha256_raw} {size_raw} {rel_base}")
        
        # Arch Release File Emulation
        arch_dir = os.path.basename(os.path.dirname(pf))
        arch = arch_dir.replace("binary-", "") if arch_dir.startswith("binary-") else arch_dir
        comp = os.path.basename(os.path.dirname(os.path.dirname(pf)))
        
        arch_release_content = f"Archive: {suite}\nComponent: {comp}\nArchitecture: {arch}\n"
        sha256_ar, size_ar = compute_string_hash_and_size(arch_release_content)
        
        sha256_lines.append(f" {sha256_ar} {size_ar} {reldir}/Release")

    # Pass-through i18n Translation hashes if available
    if upstream_content:
        for line in upstream_content.splitlines():
            if re.match(r"^ [a-f0-9]{64} +[0-9]+ +[^/]+/i18n/Translation-[a-zA-Z0-9_-]+(\.(gz|bz2))?$", line):
                sha256_lines.append(line)
        
    release_contents = [
        "Origin: debthin",
        "Label: debthin",
        f"Suite: {upstream_suite}",
    ]
    if upstream_version:
        release_contents.append(f"Version: {upstream_version}")
    
    release_contents.append(f"Codename: {suite}")
    
    if upstream_changelogs:
        release_contents.append(f"Changelogs: {upstream_changelogs}")
        
    release_contents.extend([
        f"Date: {date_out}",
        "Acquire-By-Hash: yes",
        f"Architectures: {arches_csv.replace(',', ' ')}",
        f"Components: {components_csv.replace(',', ' ')}",
        f"Description: {desc}",
        "SHA256:"
    ])
    
    release_contents.extend(sha256_lines)
    
    with open(release_output, "w", encoding="utf-8") as f:
        f.write("\n".join(release_contents) + "\n")
        
    log("INFO", f"Release: {distro}/{suite}")

def sign_releases(dist_output: str, gpg_key_id: str, gpg_homedir: Optional[str] = None):
    releases_to_sign = []
    
    for root, _, files in os.walk(dist_output):
        for file in files:
            if file == "Release" and not file.endswith(".gpg"):
                release_path = os.path.join(root, file)
                
                inrelease_path = os.path.join(root, "InRelease")
                release_gpg_path = os.path.join(root, "Release.gpg")
                
                # Verify freshness
                should_sign = False
                if not os.path.exists(inrelease_path) or not os.path.exists(release_gpg_path):
                    should_sign = True
                else:
                    rel_time = os.path.getmtime(release_path)
                    if rel_time > os.path.getmtime(inrelease_path) or rel_time > os.path.getmtime(release_gpg_path):
                        should_sign = True
                        
                if should_sign:
                    releases_to_sign.append(release_path)
                else:
                    parent = os.path.basename(os.path.dirname(release_path))
                    log("INFO", f"Skipping signing: {parent}/Release (unchanged)")
                    
    if not releases_to_sign:
        print("Done: all suites signed.")
        return
        
    gpg_args = ["gpg", "--batch", "--yes", "--armor", "--clearsign", "--default-key", gpg_key_id]
    if gpg_homedir:
        gpg_args.extend(["--homedir", gpg_homedir])
        
    # Prime agent
    try:
        tmp_args = list(gpg_args)
        tmp_args.extend(["--output", os.devnull, "-"])
        subprocess.run(tmp_args, input=b"", stderr=subprocess.DEVNULL)
    except:
        pass
        
    for release_file in sorted(releases_to_sign):
        inrelease = os.path.join(os.path.dirname(release_file), "InRelease")
        release_gpg = os.path.join(os.path.dirname(release_file), "Release.gpg")
        
        # clearsign for InRelease
        args_inrelease = list(gpg_args)
        args_inrelease.extend(["--output", inrelease, release_file])
        
        # detach sign for Release.gpg
        args_gpg = ["gpg", "--batch", "--yes", "--armor", "--detach-sign", "--default-key", gpg_key_id]
        if gpg_homedir:
            args_gpg.extend(["--homedir", gpg_homedir])
        args_gpg.extend(["--output", release_gpg, release_file])
        
        try:
            subprocess.run(args_inrelease, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            subprocess.run(args_gpg, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            log("ERROR", f"GPG Exception on {release_file}:\n{e.stderr.decode('utf-8', errors='ignore')}")
            sys.exit(1)
            
        if not os.path.exists(inrelease) or os.path.getsize(inrelease) == 0:
            log("ERROR", f"{inrelease} empty after signing")
            sys.exit(1)
            
        if not os.path.exists(release_gpg) or os.path.getsize(release_gpg) == 0:
            log("ERROR", f"{release_gpg} empty after signing")
            sys.exit(1)
            
        parent = os.path.basename(os.path.dirname(inrelease))
        log("INFO", f"Signed: {parent}/InRelease")
        
    print("Done: all suites signed.")

def main():
    parser = argparse.ArgumentParser("Generate Release files and sign all suites in one GPG session.")
    parser.add_argument("dist_output", nargs="?", default="dist_output")
    parser.add_argument("config_file", nargs="?", default="config.json")
    
    args = parser.parse_args()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    
    # Needs modifying CWD to match script expectations
    os.chdir(repo_root)
    
    gpg_key_id = os.environ.get("GPG_KEY_ID")
    if not gpg_key_id:
        log("ERROR", "GPG_KEY_ID not set")
        sys.exit(1)
        
    if not os.path.exists(args.config_file):
        log("ERROR", f"config.json not found: {args.config_file}")
        sys.exit(1)
        
    parallel = int(os.environ.get("PARALLEL", "8"))
    
    print(f"Signing phase A: generating Release files (parallel={parallel})...")
    
    jobs = parse_config(args.config_file)
    
    with concurrent.futures.ProcessPoolExecutor(max_workers=parallel) as executor:
        futures = []
        for distro, suite_up, suite, comps_csv, arches_csv in jobs:
            f = executor.submit(generate_release, distro, suite_up, suite, comps_csv, arches_csv, repo_root, args.dist_output)
            futures.append(f)
            
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as e:
                log("ERROR", f"Parallel generator exception: {e}")
                
    print("Signing phase B: signing all Release files...")
    sign_releases(args.dist_output, gpg_key_id, os.environ.get("GPG_HOMEDIR"))

if __name__ == "__main__":
    main()
