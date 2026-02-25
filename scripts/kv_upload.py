#!/usr/bin/env python3
"""
kv_upload.py - Upload dist_output directory to Cloudflare KV.

Uses bulk write API (max 10,000 key-value pairs per request).
Keys mirror the directory structure: dists/trixie/main/binary-amd64/Packages.gz
"""

import argparse
import base64
import json
import sys
import urllib.request
from pathlib import Path

CF_API = "https://api.cloudflare.com/client/v4"
BULK_LIMIT = 100  # CF KV bulk write limit per request (value size aware)


def cf_put_bulk(account: str, namespace: str, token: str, pairs: list[dict]):
    url = f"{CF_API}/accounts/{account}/storage/kv/namespaces/{namespace}/bulk"
    data = json.dumps(pairs).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
    if not result.get("success"):
        raise RuntimeError(f"KV upload failed: {result}")


def upload_dir(directory: Path, account: str, namespace: str, token: str):
    files = list(directory.rglob("*"))
    files = [f for f in files if f.is_file()]

    print(f"Uploading {len(files)} files to KV namespace {namespace}...", file=sys.stderr)

    batch = []
    for f in files:
        key = str(f.relative_to(directory))
        content = f.read_bytes()

        # KV values must be strings; base64-encode binary files
        if f.suffix in (".gz", ".lz4"):
            value = base64.b64encode(content).decode("ascii")
            metadata = {"encoding": "base64", "content-type": "application/x-gzip"}
        else:
            value = content.decode("utf-8", errors="replace")
            metadata = {"encoding": "utf-8", "content-type": "text/plain"}

        batch.append({
            "key": key,
            "value": value,
            "metadata": metadata,
        })

        if len(batch) >= BULK_LIMIT:
            cf_put_bulk(account, namespace, token, batch)
            print(f"  Uploaded batch of {len(batch)}", file=sys.stderr)
            batch = []

    if batch:
        cf_put_bulk(account, namespace, token, batch)
        print(f"  Uploaded final batch of {len(batch)}", file=sys.stderr)

    print("Done.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="dist_output directory")
    parser.add_argument("--account", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    upload_dir(Path(args.dir), args.account, args.namespace, args.token)


if __name__ == "__main__":
    main()
