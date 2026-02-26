#!/usr/bin/env python3
"""
r2_upload.py - Sync dist_output directory to Cloudflare R2 via S3-compatible API.

Required env vars (or pass as args):
  R2_ACCOUNT_ID   - Cloudflare account ID
  R2_ACCESS_KEY   - R2 API token access key ID
  R2_SECRET_KEY   - R2 API token secret access key
  R2_BUCKET       - R2 bucket name

Usage:
  python3 r2_upload.py --dir dist_output

Uploads all files preserving relative paths as S3 keys.
Builds and uploads a by-hash-index JSON per distro/suite.
Deletes stale objects (present in R2 but not in current upload).

Requires: boto3 (pip install boto3)
"""

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


def content_type_for(path: str) -> str:
    if path.endswith(".gz"):   return "application/x-gzip"
    if path.endswith(".lz4"):  return "application/x-lz4"
    if path.endswith(".xz"):   return "application/x-xz"
    if path.endswith(".gpg"):  return "application/pgp-keys"
    if path.endswith(".html"): return "text/html; charset=utf-8"
    if path.endswith(".json"): return "application/json"
    return "text/plain; charset=utf-8"


def build_hash_indexes(directory: Path) -> dict:
    """
    Returns {key: bytes} for one by-hash-index JSON per distro/suite.
    JSON maps sha256 -> relative path from suite root e.g.:
      "abc123...": "main/binary-amd64/Packages.gz"
    """
    suite_hashes = defaultdict(dict)

    for f in sorted(directory.rglob("Packages.gz")):
        key = str(f.relative_to(directory))
        parts = key.split("/")
        if len(parts) < 3 or parts[1] != "dists":
            continue
        suite_prefix   = "/".join(parts[:3])   # debian/dists/trixie
        rel_from_suite = "/".join(parts[3:])   # main/binary-amd64/Packages.gz
        sha256 = hashlib.sha256(f.read_bytes()).hexdigest()
        suite_hashes[suite_prefix][sha256] = rel_from_suite

    return {
        f"{prefix}/by-hash-index": json.dumps(mapping, sort_keys=True).encode()
        for prefix, mapping in suite_hashes.items()
    }


def make_client(account_id: str, access_key: str, secret_key: str):
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def list_r2_keys(client, bucket: str) -> set:
    keys = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            keys.add(obj["Key"])
    return keys


def upload_file(client, bucket: str, key: str, data: bytes, dry_run: bool = False):
    ct = content_type_for(key)
    if dry_run:
        print(f"  [dry-run] PUT {key} ({len(data)} bytes)")
        return
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType=ct,
        CacheControl="public, max-age=3600",
    )


def delete_keys(client, bucket: str, keys: list, dry_run: bool = False):
    # S3 delete_objects supports up to 1000 keys per call
    for i in range(0, len(keys), 1000):
        batch = [{"Key": k} for k in keys[i:i + 1000]]
        if dry_run:
            for k in batch:
                print(f"  [dry-run] DELETE {k['Key']}")
            continue
        client.delete_objects(Bucket=bucket, Delete={"Objects": batch})


def sync(directory: Path, account_id: str, access_key: str,
         secret_key: str, bucket: str, dry_run: bool = False):

    client = make_client(account_id, access_key, secret_key)

    # Collect files to upload
    uploads: dict[str, bytes] = {}

    for f in sorted(directory.rglob("*")):
        if not f.is_file():
            continue
        key = str(f.relative_to(directory))
        uploads[key] = f.read_bytes()

    # Add by-hash indexes
    hash_indexes = build_hash_indexes(directory)
    for key, data in sorted(hash_indexes.items()):
        uploads[key] = data
        count = len(json.loads(data))
        print(f"  Hash index {key}: {count} entries", file=sys.stderr)

    print(f"Uploading {len(uploads)} objects to R2 bucket '{bucket}'...", file=sys.stderr)
    for key, data in sorted(uploads.items()):
        print(f"  PUT {key} ({len(data):,} bytes)", file=sys.stderr)
        upload_file(client, bucket, key, data, dry_run)

    # Delete stale objects
    print("Checking for stale objects...", file=sys.stderr)
    existing = list_r2_keys(client, bucket)
    stale = sorted(existing - set(uploads.keys()))

    if stale:
        print(f"Deleting {len(stale)} stale objects...", file=sys.stderr)
        for k in stale:
            print(f"  DELETE {k}", file=sys.stderr)
        delete_keys(client, bucket, stale, dry_run)
    else:
        print("No stale objects.", file=sys.stderr)

    print("Done.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Sync dist_output to Cloudflare R2")
    parser.add_argument("--dir",        required=True,  help="dist_output directory")
    parser.add_argument("--account",    default=os.environ.get("R2_ACCOUNT_ID"))
    parser.add_argument("--access-key", default=os.environ.get("R2_ACCESS_KEY"))
    parser.add_argument("--secret-key", default=os.environ.get("R2_SECRET_KEY"))
    parser.add_argument("--bucket",     default=os.environ.get("R2_BUCKET"))
    parser.add_argument("--dry-run",    action="store_true")
    args = parser.parse_args()

    for name, val in [("--account", args.account), ("--access-key", args.access_key),
                      ("--secret-key", args.secret_key), ("--bucket", args.bucket)]:
        if not val:
            print(f"ERROR: {name} is required (or set env var)", file=sys.stderr)
            sys.exit(1)

    sync(Path(args.dir), args.account, args.access_key,
         args.secret_key, args.bucket, args.dry_run)


if __name__ == "__main__":
    main()
