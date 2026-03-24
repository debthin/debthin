#!/usr/bin/env python3
"""
r2_upload_images.py - Upload built container images to Cloudflare R2.

Uploads only files that the images worker will reference:
  - Files listed in registry-state.json's file_sizes map
  - registry-state.json itself
  - Static assets: index.html (from static/index-images.html), favicon.ico

Uses MD5-based ETag comparison to skip unchanged files. Deletes stale
objects from R2 that are no longer in the upload set (pruned builds).

Required env vars (or pass as args):
  R2_ACCOUNT_ID   - Cloudflare account ID
  R2_ACCESS_KEY   - R2 API token access key ID
  R2_SECRET_KEY   - R2 API token secret access key

Requires: boto3 (pip install boto3)
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import boto3

BUCKET_NAME = "debthin-images"
UPLOAD_WORKERS = 16
MD5_CHUNK_SIZE = 64 * 1024  # 64KB chunks for MD5 calculation


def md5_file(file_path):
    """
    Calculates the MD5 hash of a file using chunked reads to avoid
    loading the entire file into memory.

    Args:
        file_path: Path to the file.

    Returns:
        Hex digest string.
    """
    h = hashlib.md5()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(MD5_CHUNK_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def content_type_for(path):
    """
    Maps file extension to Content-Type header value.

    Args:
        path: Filename or path string.

    Returns:
        Content-Type string appropriate for the file extension.
    """
    if path.endswith(".xz"):   return "application/x-xz"
    if path.endswith(".gz"):   return "application/x-gzip"
    if path.endswith(".json"): return "application/json"
    if path.endswith(".html"): return "text/html; charset=utf-8"
    if path.endswith(".ico"):  return "image/x-icon"
    if path.endswith(".squashfs"): return "application/octet-stream"
    return "application/octet-stream"


def make_client(account_id, access_key, secret_key):
    """
    Creates a boto3 S3 client configured for Cloudflare R2.

    Args:
        account_id: Cloudflare account ID.
        access_key: R2 API access key ID.
        secret_key: R2 API secret key.

    Returns:
        boto3 S3 client instance.
    """
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def list_r2_objects(client, bucket):
    """
    Lists all objects in an R2 bucket with their ETags.

    Args:
        client: boto3 S3 client.
        bucket: Bucket name.

    Returns:
        Dict mapping object key to ETag (MD5 hex digest).
    """
    objects = {}
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            objects[obj["Key"]] = obj.get("ETag", "").strip('"')
    return objects


def collect_uploads(images_dir, repo_root):
    """
    Builds the complete set of files to upload to R2.

    Reads registry-state.json to determine which image files the worker
    will reference (via the file_sizes map). Adds static assets (index.html,
    favicon.ico) and the manifest itself.

    Args:
        images_dir: Path to images_output/ directory.
        repo_root: Path to repository root.

    Returns:
        Dict mapping R2 key to local file Path.
    """
    state_path = images_dir / "registry-state.json"
    if not state_path.is_file():
        print("ERROR: registry-state.json not found. Run generate_image_manifest.py first.",
              file=sys.stderr)
        sys.exit(1)

    with open(state_path) as f:
        state = json.load(f)

    uploads = {}

    # Image files referenced by the worker (via file_sizes map)
    for key in state.get("file_sizes", {}):
        local_path = images_dir / key
        if local_path.is_file():
            uploads[key] = local_path

    # The manifest itself
    uploads["registry-state.json"] = state_path

    # Static assets
    index_src = repo_root / "static" / "index-images.html"
    if index_src.is_file():
        uploads["index.html"] = index_src

    favicon_src = repo_root / "static" / "favicon.ico"
    if favicon_src.is_file():
        uploads["favicon.ico"] = favicon_src

    return uploads


def _put_one(args):
    """
    Uploads a single file to R2 by streaming from disk. The file object
    is passed directly to boto3 so the entire payload is not buffered
    in memory.

    Args:
        args: Tuple of (client, bucket, key, file_path, dry_run).

    Returns:
        Tuple of (key, size, error_string_or_None).
    """
    client, bucket, key, file_path, dry_run = args
    size = file_path.stat().st_size
    ct = content_type_for(key)
    if dry_run:
        return key, size, None
    try:
        with open(file_path, "rb") as fh:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=fh,
                ContentType=ct,
                CacheControl="public, max-age=3600",
            )
        return key, size, None
    except Exception as e:
        return key, size, str(e)


def delete_keys(client, bucket, keys, dry_run=False):
    """
    Deletes a list of keys from R2 in batches of 1000.

    Args:
        client: boto3 S3 client.
        bucket: Bucket name.
        keys: List of key strings to delete.
        dry_run: If True, print but don't delete.
    """
    for i in range(0, len(keys), 1000):
        batch = [{"Key": k} for k in keys[i:i + 1000]]
        if dry_run:
            for k in batch:
                print(f"  [dry-run] DELETE {k['Key']}")
            continue
        client.delete_objects(Bucket=bucket, Delete={"Objects": batch})


def sync(images_dir, repo_root, account_id, access_key, secret_key,
         dry_run=False, workers=UPLOAD_WORKERS):
    """
    Synchronises the local image output to R2. Skips unchanged files
    (MD5 match), uploads new/modified files, and deletes stale objects.

    Args:
        images_dir: Path to images_output/ directory.
        repo_root: Path to repository root.
        account_id: Cloudflare account ID.
        access_key: R2 API access key.
        secret_key: R2 API secret key.
        dry_run: If True, print actions without executing.
        workers: Number of parallel upload threads.
    """
    client = make_client(account_id, access_key, secret_key)

    uploads = collect_uploads(images_dir, repo_root)
    print(f"Upload set: {len(uploads)} files", file=sys.stderr)

    # Compare against existing R2 contents
    print("Fetching existing R2 objects...", file=sys.stderr)
    existing = list_r2_objects(client, BUCKET_NAME)

    # Build upload jobs, skipping files with matching MD5
    jobs = []
    skipped = 0
    for key, file_path in sorted(uploads.items()):
        md5 = md5_file(file_path)
        if key in existing and existing[key] == md5:
            skipped += 1
            continue
        jobs.append((client, BUCKET_NAME, key, file_path, dry_run))

    if skipped:
        print(f"Skipped {skipped} unchanged objects.", file=sys.stderr)

    if jobs:
        print(f"Uploading {len(jobs)} objects ({workers} workers)...", file=sys.stderr)
        errors = []
        done = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for key, size, err in pool.map(_put_one, jobs):
                done += 1
                if err:
                    errors.append(f"{key}: {err}")
                    print(f"  ERROR {key}: {err}", file=sys.stderr)
                elif done % 50 == 0 or done == len(jobs):
                    print(f"  {done}/{len(jobs)} uploaded", file=sys.stderr)
        if errors:
            raise RuntimeError(f"{len(errors)} upload(s) failed:\n" + "\n".join(errors))
    else:
        print("Nothing to upload.", file=sys.stderr)

    # Delete stale objects (old pruned builds, etc.)
    stale = sorted(set(existing.keys()) - set(uploads.keys()))
    if stale:
        print(f"Deleting {len(stale)} stale objects...", file=sys.stderr)
        delete_keys(client, BUCKET_NAME, stale, dry_run)
    else:
        print("No stale objects.", file=sys.stderr)

    print("Done.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Upload built images to Cloudflare R2 (debthin-images bucket)"
    )
    parser.add_argument("--dir", required=True,
                        help="images_output directory containing images/ and registry-state.json")
    parser.add_argument("--account", default=os.environ.get("R2_ACCOUNT_ID"))
    parser.add_argument("--access-key", default=os.environ.get("R2_ACCESS_KEY"))
    parser.add_argument("--secret-key", default=os.environ.get("R2_SECRET_KEY"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for name, val in [("--account", args.account), ("--access-key", args.access_key),
                      ("--secret-key", args.secret_key)]:
        if not val:
            print(f"ERROR: {name} is required (or set env var)", file=sys.stderr)
            sys.exit(1)

    images_dir = Path(args.dir)
    repo_root = Path(__file__).resolve().parent.parent.parent

    sync(images_dir, repo_root, args.account, args.access_key,
         args.secret_key, args.dry_run)


if __name__ == "__main__":
    main()
