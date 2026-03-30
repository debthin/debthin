# Build Dependencies

External tools and libraries required to build, test, and deploy.

## Package Index Pipeline (`scripts/debthin/`)

The build pipeline is orchestrated by the Makefile, which calls helper scripts
for each phase. `build.sh` is a thin wrapper that invokes `make`.

### Python (3.8+)

| Script | External Deps | Purpose |
|---|---|---|
| `curate.py` | — | Popcon-based package curation |
| `filter.py` | — | Packages.gz allowlist filtering, writes `.count` sidecars |
| `merge_packages.py` | — | Headless meta-suite merging |
| `r2_upload.py` | `boto3` | S3-compatible upload to Cloudflare R2 |
| `validate.py` | — | Sanity-checks `dist_output/` before upload |

All scripts except `r2_upload.py` use Python stdlib only.

```
pip install boto3
```

### Shell

| Tool | Used By | Notes |
|---|---|---|
| `bash` 4+ | all `.sh` scripts | Requires associative arrays, process substitution |
| `make` | `Makefile`, `build.sh` | Orchestrates the pipeline; `build.sh` calls `make -j` |
| `jq` | `Makefile` | Parses `config.json` for dynamic target generation |
| `curl` | `fetch.sh` | Fetches upstream Packages.gz and InRelease |
| `gpg` | `sign_all.py` | Signs Release files |
| `xz` / `xzcat` | `fetch.sh` | Fallback decompress when `.gz` unavailable |
| `gzip` | `filter.sh` | Compress/validate Packages files |
| `sha256sum` | — | Hash verification (falls back to `shasum -a 256` on macOS) |
| `xargs` | `Makefile` | Parallel fetch via `-P` flag |
| `find`, `sort`, `sed`, `awk`, `wc` | various | Standard coreutils |

### Scripts

| Script | Phase | Purpose |
|---|---|---|
| `build.sh` | — | Thin wrapper: validates R2 credentials, calls `make -j` |
| `fetch.sh` | fetch | Downloads one Packages.gz or InRelease from upstream |
| `filter.sh` | filter | Resolves allowlist and runs `filter.py` for one distro/suite |
| `headless.sh` | headless | Generates deduplicated headless meta-suite for one distro/suite |
| `sign_all.py` | sign | Generates Release files and GPG-signs all suites |
| `validate.py` | validate | Sanity-checks `dist_output/` before upload (parallel per distro) |

---

## Container Images (`scripts/images/`)

| Tool | Required | Purpose |
|---|---|---|
| `distrobuilder` | yes | Builds rootfs and packs LXC/Incus tarballs |
| `curl` | yes | Checked at startup |
| `jq` | yes | Makefile parses `config.json` for target matrix |
| `sha256sum` / `shasum` | yes | Generates `hashes.txt` per build |
| `make` | yes | Build orchestration |
| `qemu-user-static` + `binfmt-support` | cross-arch only | Required when `$ARCH != $HOST_ARCH` |
| `buildah` | optional | OCI image packing, skipped if not installed |

Image YAML templates are at `yaml-templates/` (repo root), not inside `scripts/images/`.

| Script | Purpose |
|---|---|
| `build.sh` | Builds a single distro/suite/arch rootfs and packs LXC/Incus/OCI |
| `generate_image_manifest.py` | Generates `registry-state.json` for the worker |

---

## Workers (`workers/`)

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
| `GPG_KEY_ID` | `sign_all.sh`, `Makefile` (default hardcoded in both) |
| `NO_UPLOAD` | `Makefile`, `build.sh` (set to `1` to skip R2 upload) |
| `PARALLEL` | `build.sh`, `Makefile` (default: `8`) |
