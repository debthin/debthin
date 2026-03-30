# Build Dependencies

External tools and libraries required to build, test, and deploy.

## Package Index Pipeline (`scripts/debthin/`)

The build pipeline is orchestrated by the Makefile, which calls helper scripts
for each phase. `build.sh` is a thin wrapper that invokes `make`.

### Python (3.8+)

| Script | External Deps | Purpose |
|---|---|---|
| `curate.py` | — | Popcon-based package curation |
| `fetch.py` | `httpx[http2]` | Asynchronously fetches Packages.gz over HTTP/2 |
| `filter.py` | — | Resolves allowlists iteratively and writes `.count` sidecars |
| `merge_packages.py` | — | Headless meta-suite merging |
| `sign_all.py` | — | Generates Release files and GPG-signs all suites |
| `validate.py` | — | Sanity-checks `dist_output/` before upload |
| `r2_upload.py` | `boto3` | S3-compatible upload to Cloudflare R2 |

Scripts internally route through a local virtual environment mapping `.venv`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Shell

| Tool | Used By | Notes |
|---|---|---|
| `bash` 4+ | `build.sh` | Process orchestration wrappers |
| `make` | `Makefile`, `build.sh` | Orchestrates the pipeline; `build.sh` calls `make -j` |
| `gpg` | `sign_all.py` | Signs Release files |
| `sha256sum` | — | Hash verification (falls back to `shasum -a 256` on macOS) |
| `find`, `sort`, `sed`, `awk`, `wc` | various | Standard coreutils |

### Scripts

| Script | Phase | Purpose |
|---|---|---|
| `build.sh` | — | Thin wrapper: validates R2 credentials, calls `make -j` |
| `fetch.py` | fetch | Asynchronously fetches all targets over HTTP/2 |
| `filter.py` | filter | Resolves allowlists and aggregates architectures natively |
| `merge_packages.py` | headless | Generates deduplicated headless meta-suites |
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
