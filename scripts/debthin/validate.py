#!/usr/bin/env python3
"""
validate.py - Sanity-check dist_output/ before upload

This script iterates through debian repository structures to validate file presence,
JSON configurations, GPG signatures within InRelease, SHA256 hashes, and count packages
within gzip files across distributions. It is designed to be a robust, parallelized
alternative.
"""

import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import json
import os
import sys
import threading
from typing import Dict, List, Tuple

# Minimum total packages across all suites in a release family
RELEASE_MIN_PACKAGES = 1000
CRITICAL_COMPONENTS = {"main", "universe"}

# Log counts for main thread
global_errors = 0
global_warnings = 0
print_lock = threading.Lock()

def pass_msg(msg: str):
    with print_lock:
        print(f"  OK   {msg}", flush=True)

def info_msg(msg: str):
    with print_lock:
        print(f"  INFO {msg}", flush=True)

def warn_msg(msg: str):
    global global_warnings
    with print_lock:
        print(f"  WARN {msg}", flush=True)
        global_warnings += 1

def fail_msg(msg: str):
    global global_errors
    with print_lock:
        print(f"  FAIL {msg}", file=sys.stderr, flush=True)
        global_errors += 1

def is_critical_component(component: str) -> bool:
    return component in CRITICAL_COMPONENTS

def check_file(f: str, min_size: int = 1):
    if not os.path.exists(f):
        fail_msg(f"missing: {f}")
    elif os.path.getsize(f) == 0:
        fail_msg(f"empty: {f}")
    elif os.path.getsize(f) < min_size:
        fail_msg(f"too small ({os.path.getsize(f)} bytes): {f}")
    else:
        pass_msg(f)

def check_config_json(f: str):
    if not os.path.exists(f):
        fail_msg(f"missing: {f}")
        return
    try:
        with open(f, "r") as json_file:
            data = json.load(json_file)
    except json.JSONDecodeError:
        fail_msg(f"invalid JSON: {f}")
        return
        
    if "debian" not in data or "suites" not in data["debian"]:
        fail_msg(f"missing .debian.suites: {f}")
        return
        
    stable_suite = None
    for key, value in data["debian"]["suites"].items():
        if "aliases" in value and "stable" in value["aliases"]:
            stable_suite = key
            break
            
    if not stable_suite:
        fail_msg(f"no debian suite has 'stable' in aliases: {f}")
        return
        
    pass_msg(f"{f} (JSON valid, stable suite: {stable_suite})")

def compute_sha256(filepath: str) -> str:
    sha256_hash = hashlib.sha256()
    with open(filepath, "rb") as f:
        # Read in blocks to avoid memory issues with huge files
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

def count_packages_gzip(filepath: str) -> int:
    try:
        count = 0
        with gzip.open(filepath, "rt", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.startswith("Package:"):
                    count += 1
        return count
    except Exception:
        return -1  # Indicates error computing count

def parse_inrelease(filepath: str) -> Dict[str, str]:
    fields = {}
    if not os.path.exists(filepath):
        return fields
        
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(" "):
                continue
            if ":" in line:
                key, val = line.split(":", 1)
                fields[key.strip()] = val.strip()
    return fields

def parse_inrelease_hashes(filepath: str) -> List[Tuple[str, int, str]]:
    hashes = []
    if not os.path.exists(filepath):
        return hashes
        
    in_sha256 = False
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.startswith("SHA256:"):
                in_sha256 = True
                continue
            if in_sha256:
                if line.startswith(" "):
                    parts = line.strip().split()
                    if len(parts) >= 3:
                        expect_hash = parts[0]
                        expect_size = int(parts[1])
                        rel_path = " ".join(parts[2:])
                        hashes.append((expect_hash, expect_size, rel_path))
                elif line.strip() and not line.startswith(" "):
                    in_sha256 = False
    return hashes

class DistroResult:
    def __init__(self, name: str):
        self.name = name
        self.errors = 0
        self.warnings = 0
        self.output_lines = []
        self.json_data = {}

    def _log(self, level: str, msg: str):
        self.output_lines.append(f"  {level:<4} {msg}")

    def pass_msg(self, msg: str):
        self._log("OK", msg)

    def info_msg(self, msg: str):
        self._log("INFO", msg)

    def warn_msg(self, msg: str):
        self._log("WARN", msg)
        self.warnings += 1

    def fail_msg(self, msg: str):
        self._log("FAIL", msg)
        self.errors += 1

def validate_distro(distro_dir: str, cache_dir: str = None) -> DistroResult:
    distro = os.path.basename(distro_dir.rstrip("/"))
    result = DistroResult(distro)
    result.output_lines.append("")
    result.output_lines.append(f"=== {distro} ===")
    
    suite_count = 0
    pkg_counts = {}  # Cache per-file package counts
    
    suites = []
    if os.path.isdir(distro_dir):
        for entry in os.listdir(distro_dir):
            if os.path.isdir(os.path.join(distro_dir, entry)):
                suites.append(entry)
                
    for suite in sorted(suites):
        suite_dir = os.path.join(distro_dir, suite)
        suite_count += 1
        result.output_lines.append(f"  -- {suite} --")
        
        inrelease = os.path.join(suite_dir, "InRelease")
        
        # InRelease checks
        if not os.path.exists(inrelease):
            result.fail_msg(f"missing: {inrelease}")
        else:
            with open(inrelease, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
                if "-----BEGIN PGP SIGNED MESSAGE-----" not in content:
                    result.fail_msg(f"not GPG signed: {inrelease}")
            
            ok = True
            fields = parse_inrelease(inrelease)
            for req_field in ["Origin", "Label", "Suite", "Codename", "Date", "Architectures", "Components"]:
                if req_field not in fields:
                    result.fail_msg(f"missing field {req_field}: {inrelease}")
                    ok = False
                    
            hashes = parse_inrelease_hashes(inrelease)
            if not hashes:
                result.fail_msg(f"empty SHA256 section: {inrelease}")
                ok = False
                
            if ok:
                result.pass_msg(f"{inrelease} ({len(hashes)} hashes)")
                
        # InRelease hash verification
        if os.path.exists(inrelease):
            for expect_hash, expect_size, rel_path in hashes:
                if "/by-hash/" in rel_path or "/i18n/" in rel_path or not rel_path.endswith(".gz"):
                    continue
                    
                full_path = os.path.join(suite_dir, rel_path)
                if not os.path.exists(full_path):
                    result.fail_msg(f"InRelease references missing file: {rel_path}")
                    continue
                    
                actual_size = os.path.getsize(full_path)
                actual_hash = compute_sha256(full_path)
                
                if actual_hash != expect_hash:
                    result.fail_msg(f"SHA256 mismatch: {rel_path}")
                elif actual_size != expect_size:
                    result.fail_msg(f"size mismatch: {rel_path} (expected {expect_size} got {actual_size})")

        # Packages.gz checks
        packages_gz_files = []
        for root, _, files in os.walk(suite_dir):
            for file in files:
                if file == "Packages.gz":
                    packages_gz_files.append(os.path.join(root, file))
                    
        pkg_count = 0
        for pf in sorted(packages_gz_files):
            pkg_count += 1
            if not os.path.exists(pf):
                result.fail_msg(f"missing: {pf}")
                continue
                
            count = count_packages_gzip(pf)
            if count == -1:
                result.fail_msg(f"corrupt gzip: {pf}")
                continue
                
            pkg_counts[pf] = count
            
            parts = pf.split(os.sep)
            # pf path typically: dist_output/dists/<distro>/<suite>/<component>/binary-<arch>/Packages.gz
            component = parts[-3] if len(parts) >= 3 else ""
            s = parts[-4] if len(parts) >= 4 else ""
            
            is_backports = any(s.endswith(suffix) for suffix in ["-backports", "-proposed", "-security"])
            
            if count == 0:
                if not is_backports and is_critical_component(component):
                    result.fail_msg(f"zero packages in critical component: {pf}")
                else:
                    result.info_msg(f"zero packages (expected for {s}/{component}): {pf}")
            else:
                result.pass_msg(f"{pf} ({count} packages)")
                
        if pkg_count == 0:
            result.fail_msg(f"no Packages.gz files found under {suite}")
            
    if suite_count == 0:
        result.fail_msg(f"no suites found under {distro_dir}")
    else:
        result.output_lines.append(f"  {suite_count} suite(s) checked")
        
    # Release family totals
    result.output_lines.append("")
    result.output_lines.append("  Package counts by release family:")
    
    family_arch = {}
    family_total = {}
    arches_set = set()
    
    for pf, count in pkg_counts.items():
        if "/headless/" in pf:
            continue
            
        parts = pf.split(os.sep)
        # Find suite name from path
        idx = parts.index(distro) if distro in parts else -1
        if idx != -1 and len(parts) > idx + 1:
            suite = parts[idx + 1]
            family = suite.split("-")[0]
            
            arch_dir = parts[-2]
            arch = arch_dir.replace("binary-", "") if arch_dir.startswith("binary-") else arch_dir
            
            arches_set.add(arch)
            
            fam_arch_key = f"{family}/{arch}"
            family_arch[fam_arch_key] = family_arch.get(fam_arch_key, 0) + count
            family_total[family] = family_total.get(family, 0) + count

    arches = sorted(list(arches_set))
    max_family = max([len(f) for f in family_total.keys()] + [0])
    
    if arches:
        header = f"           {'':<{max_family}}"
        for arch in arches:
            header += f"  {arch:>8}"
        header += f"  {'TOTAL':>8}"
        result.output_lines.append(header)
        
        for family in sorted(family_total.keys()):
            row = f"    {family:<{max_family}}"
            arch_fail = False
            for arch in arches:
                val = family_arch.get(f"{family}/{arch}", 0)
                row += f"  {val:>8}"
                if f"{family}/{arch}" in family_arch and val < RELEASE_MIN_PACKAGES:
                    arch_fail = True
            
            total = family_total[family]
            row += f"  {total:>8}"
            
            if arch_fail:
                result.fail_msg(f"{row}  (an arch is below threshold of {RELEASE_MIN_PACKAGES})")
            else:
                result.pass_msg(row)

    # JSON prep
    upstream_suite_arch = {}
    if cache_dir and os.path.exists(os.path.join(cache_dir, distro)):
        cache_distro_dir = os.path.join(cache_dir, distro)
        for root, _, files in os.walk(cache_distro_dir):
            for file in files:
                if file == "Packages.gz":
                    pf = os.path.join(root, file)
                    rel_path = os.path.relpath(pf, cache_distro_dir)
                    parts = rel_path.split(os.sep)
                    if len(parts) >= 1:
                        suite = parts[0]
                        arch_dir = os.path.basename(os.path.dirname(pf))
                        arch = arch_dir.replace("binary-", "") if arch_dir.startswith("binary-") else arch_dir
                        
                        count_file = pf.replace(".gz", ".count")
                        ucount = 0
                        if os.path.exists(count_file):
                            try:
                                with open(count_file, "r") as cf:
                                    ucount = int(cf.read().strip())
                            except Exception:
                                pass
                        else:
                            ucount = count_packages_gzip(pf)
                            if ucount == -1:
                                ucount = 0
                                
                        key = f"{suite}/{arch}"
                        upstream_suite_arch[key] = upstream_suite_arch.get(key, 0) + ucount

    suite_arch_json = {}
    for pf, count in pkg_counts.items():
        if "/headless/" in pf:
            continue
        parts = pf.split(os.sep)
        idx = parts.index(distro) if distro in parts else -1
        if idx != -1 and len(parts) > idx + 1:
            suite = parts[idx + 1]
            arch_dir = parts[-2]
            arch = arch_dir.replace("binary-", "") if arch_dir.startswith("binary-") else arch_dir
            key = f"{suite}/{arch}"
            suite_arch_json[key] = suite_arch_json.get(key, 0) + count

    result.json_data = {}
    for suite in sorted(suites):
        suite_dir = os.path.join(distro_dir, suite)
        inrelease = os.path.join(suite_dir, "InRelease")
        
        suite_meta = {}
        if os.path.exists(inrelease):
            fields = parse_inrelease(inrelease)
            if "Date" in fields:
                suite_meta["date"] = fields["Date"]
            if "Version" in fields:
                suite_meta["version"] = fields["Version"]
                
        suite_meta["packages"] = {}
        
        for arch in arches:
            key = f"{suite}/{arch}"
            if key in suite_arch_json:
                count = suite_arch_json[key]
                pkg_info = {"count": count}
                if key in upstream_suite_arch and upstream_suite_arch[key] > 0:
                    pkg_info["upstream_count"] = upstream_suite_arch[key]
                suite_meta["packages"][arch] = pkg_info
                
        result.json_data[suite] = suite_meta

    return result

def main():
    global global_errors, global_warnings
    
    parser = argparse.ArgumentParser(description="Sanity-check dist_output/ before upload")
    parser.add_argument("dist_output", nargs="?", default="dist_output", help="Path to dist_output directory")
    parser.add_argument("--json", dest="json_out", help="Path to write JSON status output")
    parser.add_argument("--cache-dir", dest="cache_dir", help="Path to cache directory")
    parser.add_argument("--built-at", dest="built_at", help="ISO8601 built at timestamp")
    parser.add_argument("--duration-seconds", dest="duration_seconds", type=int, help="Build duration in seconds")
    
    args = parser.parse_args()
    
    built_at = args.built_at
    if not built_at:
        built_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print("=== Static files ===")
    check_file(os.path.join(args.dist_output, "index.html"), 1000)
    check_file(os.path.join(args.dist_output, "debthin-keyring.gpg"), 100)
    check_file(os.path.join(args.dist_output, "debthin-keyring-binary.gpg"), 100)
    check_config_json(os.path.join(args.dist_output, "config.json"))
    
    distros_dir = os.path.join(args.dist_output, "dists")
    distro_dirs = []
    if os.path.exists(distros_dir) and os.path.isdir(distros_dir):
        for entry in os.listdir(distros_dir):
            full_path = os.path.join(distros_dir, entry)
            if os.path.isdir(full_path):
                distro_dirs.append(full_path)
    
    distro_results = []
    all_json_data = {}
    
    # Process distributions in parallel
    if distro_dirs:
        with concurrent.futures.ProcessPoolExecutor() as executor:
            futures = [executor.submit(validate_distro, d, args.cache_dir) for d in distro_dirs]
            for future in concurrent.futures.as_completed(futures):
                try:
                    result = future.result()
                    distro_results.append(result)
                except Exception as e:
                    fail_msg(f"Parallel verification failed: {str(e)}")

    # Sort results to have stable output based on distro name
    distro_results.sort(key=lambda x: x.name)
    
    for result in distro_results:
        for line in result.output_lines:
            print(line)
        global_errors += result.errors
        global_warnings += result.warnings
        all_json_data[result.name] = {"suites": result.json_data}
        
    # JSON Assembly
    if args.json_out:
        final_json = {
            "built_at": built_at,
            "valid": global_errors == 0,
            "errors": global_errors,
            "warnings": global_warnings,
            "distros": all_json_data
        }
        if args.duration_seconds is not None:
            final_json["duration_seconds"] = args.duration_seconds
            
        try:
            with open(args.json_out, "w") as f:
                json.dump(final_json, f, indent=2)
            print(f"  Wrote {args.json_out}")
        except Exception as e:
            fail_msg(f"Failed to write JSON output: {str(e)}")
            
    # Summary
    print("")
    print("=== Summary ===")
    print(f"  Errors:   {global_errors}")
    print(f"  Warnings: {global_warnings}")
    
    if global_errors > 0:
        print("FAILED")
        sys.exit(1)
    else:
        print("PASSED")
        sys.exit(0)

if __name__ == "__main__":
    main()
