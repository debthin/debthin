#!/usr/bin/env python3
"""
kv_upload.py - Upload dist_output directory to Cloudflare KV.

Uses bulk write API (max 100 key-value pairs per request).
Keys mirror the directory structure: dists/trixie/main/binary-amd64/Packages.gz

For Packages.gz files, also stores a by-hash copy at:
  dists/SUITE/main/binary-ARCH/by-hash/SHA256/<sha256>
to support Acquire-By-Hash.

Stale keys (present in KV but not in the current upload) are deleted.
"""

import argparse
import base64
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

CF_API = "https://api.cloudflare.com/client/v4"
BULK_LIMIT = 100


def cf_request(method: str, url: str, token: str, data=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8") if data is not None else None,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
    if not result.get("success"):
        raise RuntimeError(f"KV API error: {result}")
    return result


def list_kv_keys(account: str, namespace: str, token: str) -> set[str]:
    keys = set()
    cursor = None
    while True:
        url = f"{CF_API}/accounts/{account}/storage/kv/namespaces/{namespace}/keys?limit=1000"
        if cursor:
            url += f"&cursor={cursor}"
        result = cf_request("GET", url, token)
        for item in result.get("result", []):
            keys.add(item["name"])
        cursor = result.get("result_info", {}).get("cursor")
        if not cursor:
            break
    return keys


def cf_put_bulk(account: str, namespace: str, token: str, pairs: list[dict]):
    url = f"{CF_API}/accounts/{account}/storage/kv/namespaces/{namespace}/bulk"
    cf_request("PUT", url, token, pairs)


def cf_delete_bulk(account: str, namespace: str, token: str, keys: list[str]):
    url = f"{CF_API}/accounts/{account}/storage/kv/namespaces/{namespace}/bulk"
    req = urllib.request.Request(
        url,
        data=json.dumps(keys).encode("utf-8"),
        method="DELETE",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
    if not result.get("success"):
        raise RuntimeError(f"KV delete failed: {result}")


def make_entry(key: str, content: bytes, content_type: str) -> dict:
    if content_type in ("application/x-gzip", "application/x-lz4",
                        "application/x-xz", "application/octet-stream"):
        value = base64.b64encode(content).decode("ascii")
        metadata = {"encoding": "base64", "content-type": content_type}
    else:
        value = content.decode("utf-8", errors="replace")
        metadata = {"encoding": "utf-8", "content-type": content_type}
    return {"key": key, "value": value, "metadata": metadata}


def content_type_for(path: str) -> str:
    if path.endswith(".gz"):   return "application/x-gzip"
    if path.endswith(".lz4"):  return "application/x-lz4"
    if path.endswith(".xz"):   return "application/x-xz"
    if path.endswith(".gpg"):  return "application/octet-stream"
    if path.endswith(".html"): return "text/html; charset=utf-8"
    return "text/plain; charset=utf-8"


def upload_dir(directory: Path, account: str, namespace: str, token: str):
    # Build entries from disk
    entries: list[dict] = []
    new_keys: set[str] = set()

    for f in sorted(directory.rglob("*")):
        if not f.is_file():
            continue
        key = str(f.relative_to(directory))
        content = f.read_bytes()
        ct = content_type_for(key)
        entries.append(make_entry(key, content, ct))
        new_keys.add(key)

        # By-hash copy for Packages.gz
        if f.name == "Packages.gz":
            sha256 = hashlib.sha256(content).hexdigest()
            hash_key = str(f.parent.relative_to(directory)) + f"/by-hash/SHA256/{sha256}"
            entries.append(make_entry(hash_key, content, ct))
            new_keys.add(hash_key)

    print(f"Uploading {len(entries)} entries to KV namespace {namespace}...", file=sys.stderr)

    for i in range(0, len(entries), BULK_LIMIT):
        batch = entries[i:i + BULK_LIMIT]
        cf_put_bulk(account, namespace, token, batch)
        print(f"  Uploaded entries {i+1}-{i+len(batch)}", file=sys.stderr)

    # Delete stale keys
    print("Checking for stale keys...", file=sys.stderr)
    existing_keys = list_kv_keys(account, namespace, token)
    stale = [k for k in existing_keys if k not in new_keys]

    if stale:
        print(f"Deleting {len(stale)} stale keys...", file=sys.stderr)
        for i in range(0, len(stale), BULK_LIMIT):
            batch = stale[i:i + BULK_LIMIT]
            cf_delete_bulk(account, namespace, token, batch)
            print(f"  Deleted {len(batch)} keys", file=sys.stderr)
    else:
        print("No stale keys.", file=sys.stderr)

    print("Done.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Upload dist directory to Cloudflare KV")
    parser.add_argument("--dir", required=True, help="dist_output directory")
    parser.add_argument("--account", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    upload_dir(Path(args.dir), args.account, args.namespace, args.token)


if __name__ == "__main__":
    main()
