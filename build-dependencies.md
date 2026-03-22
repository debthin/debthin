# Build Dependencies

External tools and libraries required to build, test, and deploy.

## Scripts (`scripts/`)

### Python (3.8+)

| Script | External Deps | Purpose |
|---|---|---|
| `curate.py` | — | Popcon-based package curation |
| `filter.py` | — | Packages.gz allowlist filtering |
| `merge_packages.py` | — | Headless meta-suite merging |
| `generate_image_manifest.py` | — | Build-time image manifest for R2 |
| `r2_upload.py` | `boto3` | S3-compatible upload to Cloudflare R2 |

All scripts except `r2_upload.py` use Python stdlib only.

```
pip install boto3
```

### Shell

| Tool | Used By | Notes |
|---|---|---|
| `bash` 4+ | `build.sh`, `sign_all.sh`, `validate.sh` | Requires `set -euo pipefail`, process substitution |
| `jq` | `build.sh`, `sign_all.sh`, `validate.sh` | Parses `config.json` |
| `curl` | `build.sh`, `sign_all.sh` | Fetches upstream Packages.gz and InRelease |
| `gpg` | `sign_all.sh` | Signs Release files |
| `xz` / `xzcat` | `build.sh` | Fallback decompress when `.gz` unavailable |
| `gzip` | `build.sh`, `validate.sh` | Compress/validate Packages files |
| `sha256sum` | `sign_all.sh`, `validate.sh` | Hash verification (falls back to `shasum -a 256` on macOS) |
| `xargs` | `build.sh` | Parallel fetch via `-P` flag |
| `find`, `sort`, `sed`, `awk`, `wc` | various | Standard coreutils |

---

## Container Images (`images/`)

| Tool | Required | Purpose |
|---|---|---|
| `distrobuilder` | yes | Builds rootfs and packs LXC/Incus tarballs |
| `curl` | yes | Checked at startup |
| `jq` | yes | Makefile parses `config.json` for target matrix |
| `sha256sum` / `shasum` | yes | Generates `hashes.txt` per build |
| `make` | yes | Build orchestration |
| `qemu-user-static` + `binfmt-support` | cross-arch only | Required when `$ARCH != $HOST_ARCH` |
| `buildah` | optional | OCI image packing, skipped if not installed |

---

## Worker (`worker/`)

| Tool | Purpose |
|---|---|
| `node` 18+ | Test runner (`node --test`) |
| `wrangler` | Cloudflare Worker deployment |

No `package.json` or npm dependencies — the worker uses native ES modules.

---

## Environment Variables

Required for upload/deploy (not needed for local build with `NO_UPLOAD=1`):

| Variable | Used By |
|---|---|
| `R2_ACCOUNT_ID` | `r2_upload.py`, `build.sh` |
| `R2_ACCESS_KEY` | `r2_upload.py`, `build.sh` |
| `R2_SECRET_KEY` | `r2_upload.py`, `build.sh` |
| `R2_BUCKET` | `r2_upload.py`, `build.sh` (default: `debthin`) |
| `GPG_KEY_ID` | `sign_all.sh` (hardcoded in `build.sh`) |
| `NO_UPLOAD` | `build.sh` (set to `1` to skip R2 upload) |
| `PARALLEL` | `build.sh` (default: `8`) |
