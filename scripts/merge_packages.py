#!/usr/bin/env python3
import gzip
import os
import argparse
from pathlib import Path

def parse_version(v):
    epoch = 0
    if ":" in v:
        parts = v.split(":", 1)
        epoch = int(parts[0])
        v = parts[1]
    if "-" in v:
        upstream, revision = v.rsplit("-", 1)
    else:
        upstream, revision = v, "0"
    return epoch, upstream, revision

def char_order(c):
    if not c:
        return 0
    if c == "~":
        return -1
    code = ord(c)
    if (code >= 65 and code <= 90) or (code >= 97 and code <= 122):
        return code
    return code + 256

def compare_version_part(a, b):
    i = 0
    j = 0
    while i < len(a) or j < len(b):
        na = ""
        while i < len(a) and not a[i].isdigit():
            na += a[i]
            i += 1
        nb = ""
        while j < len(b) and not b[j].isdigit():
            nb += b[j]
            j += 1
            
        for k in range(max(len(na), len(nb))):
            ca = na[k] if k < len(na) else None
            cb = nb[k] if k < len(nb) else None
            diff = char_order(ca) - char_order(cb)
            if diff != 0:
                return diff
                
        da = ""
        while i < len(a) and a[i].isdigit():
            da += a[i]
            i += 1
        db = ""
        while j < len(b) and b[j].isdigit():
            db += b[j]
            j += 1
            
        diff = int(da or "0") - int(db or "0")
        if diff != 0:
            return diff
    return 0

def compare_versions(a, b):
    pa = parse_version(a)
    pb = parse_version(b)
    if pa[0] != pb[0]:
        return pa[0] - pb[0]
    up = compare_version_part(pa[1], pb[1])
    if up != 0:
        return up
    return compare_version_part(pa[2], pb[2])

def parse_stanzas(raw_bytes):
    stanzas = raw_bytes.split(b"\n\n")
    for stanza in stanzas:
        if not stanza.strip():
            continue
        pkg_name = None
        version = None
        for line in stanza.split(b"\n"):
            if line.startswith(b"Package: "):
                pkg_name = line[9:]
            elif line.startswith(b"Version: "):
                version = line[9:]
        if pkg_name and version:
            yield pkg_name, version, stanza

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="*", help="Input Packages.gz files")
    parser.add_argument("-o", "--output", required=True, help="Output Packages.gz file")
    args = parser.parse_args()
    
    best = {}
    
    for inp in args.inputs:
        if not os.path.exists(inp):
            continue
        with gzip.open(inp, "rb") as f:
            for pkg, ver, stanza in parse_stanzas(f.read()):
                if pkg not in best:
                    best[pkg] = (ver, stanza)
                else:
                    ver_str = ver.decode('utf-8', errors='replace')
                    best_ver_str = best[pkg][0].decode('utf-8', errors='replace')
                    if compare_versions(ver_str, best_ver_str) > 0:
                        best[pkg] = (ver, stanza)
                        
    out_stanzas = [item[1] for item in best.values()]
    result = b"\n\n".join(out_stanzas)
    if result:
        result += b"\n"
        
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.output, "wb", compresslevel=1) as f:
        f.write(result)

if __name__ == "__main__":
    main()
