# Package Index Pipeline

Architecture documentation for the debthin build pipeline under `scripts/debthin/`.

## Overview

The pipeline fetches upstream Debian/Ubuntu/Raspbian package indexes, filters
them to a curated subset of server-relevant packages, generates signed release
metadata, and uploads to Cloudflare R2. The Makefile orchestrates all phases
with dependency chains that enable parallel execution.

```
config.json
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Makefile                                                       │
│                                                                 │
│  fetch ──→ filter ──→ headless ──→ sign ──→ stage ──→ validate ──→ upload │
│  (xargs)   (make -j)  (make -j)   (all)    (all)    (parallel)   (all)   │
└─────────────────────────────────────────────────────────────────┘
```

## Phases

### 1. Fetch (`fetch.sh`)

Downloads `Packages.gz` and `InRelease` files from upstream mirrors into
`.tmp_cache/<distro>/<suite>/`. Uses IMS headers (`curl -z`) to skip
re-downloads when the local copy is current. Parallelised via `xargs -P`.

Inputs: upstream mirror URLs from `config.json`
Outputs: `.tmp_cache/<distro>/<suite>/<component>/binary-<arch>/Packages.gz`

### 2. Filter (`filter.sh` + `filter.py`)

Applies allowlist filtering per distro/suite. The shell script resolves the
correct curated list (with `required_packages/` merge), identifies stale
outputs, and calls `filter.py` in batch mode. Each distro/suite is an
independent Make target (`filter-debian/bookworm`), parallelised by `make -j`.

`filter.py` also writes a `.count` sidecar file next to each cached
`Packages.gz`, recording the upstream package count. This allows `validate.py`
to report upstream counts without re-decompressing.

Allowlist resolution order:
1. `curated/<curated_base>/all.txt` (if `curated_base` set in config)
2. `curated/<distro>/<suite>/all.txt`
3. `curated/<distro>/<stable_suite>/all.txt`
4. `curated/debian/<stable_suite>/all.txt`

Required packages merge order:
1. `required_packages/<distro>/<suite>.txt`
2. `required_packages/<distro>.txt`
3. `required_packages/debian.txt`

Inputs: `.tmp_cache/` Packages.gz files, curated lists
Outputs: `dist_output/dists/<distro>/<suite>/<component>/binary-<arch>/Packages.gz`

### 2.5. Headless (`headless.sh` + `merge_packages.py`)

Generates headless meta-suites by merging component Packages.gz files and
their `-updates` counterparts into a single deduplicated file per architecture.
The merge uses `merge_packages.py` to resolve version conflicts (highest wins).

Each distro/suite is a Make target (`headless-debian/bookworm`) that depends on
its own `filter-debian/bookworm`, so suites pipeline independently.

Inputs: filtered Packages.gz from `dist_output/`
Outputs: `dist_output/dists/<distro>/<suite>/headless/binary-<arch>/Packages.gz`

### 3. Sign (`sign_all.sh`)

Generates `Release` files with SHA256 hashes for every Packages.gz in each
suite, then GPG-signs them to produce `InRelease`. Runs after all headless
targets complete.

Inputs: `dist_output/dists/` tree
Outputs: `dist_output/dists/<distro>/<suite>/InRelease`

### 4. Stage

Copies static assets (`index.html`, `favicon.ico`, `config.json`, GPG keyrings)
into `dist_output/` and cleans up uncompressed Packages files.

### 5. Validate (`validate.py`)

Sanity-checks the entire `dist_output/` tree before upload. Runs per-distro in
parallel background jobs, buffering output and aggregating error counts. Checks
include:

- Static file presence and size
- InRelease GPG signature and required fields
- SHA256 hash verification of all files referenced in InRelease
- Package count thresholds per architecture
- JSON status file generation

This is a hard gate: any error prevents the upload from proceeding.

Inputs: `dist_output/`, `.tmp_cache/` (for upstream counts via `.count` files)
Outputs: `dist_output/status.json`, pass/fail exit code

### 6. Upload (`r2_upload.py`)

Uploads the validated `dist_output/` to Cloudflare R2 via boto3. Skipped when
`NO_UPLOAD=1`.

## Directory Layout

```
.tmp_cache/                    Fetch cache (IMS-aware, not committed)
  <distro>/<suite>/
    InRelease
    <component>/binary-<arch>/
      Packages.gz              Upstream package index
      Packages.count           Upstream package count (written by filter.py)

dist_output/                   Build output (uploaded to R2)
  index.html
  config.json
  status.json
  debthin-keyring.gpg
  dists/<distro>/<suite>/
    InRelease                  Signed release metadata
    <component>/binary-<arch>/
      Packages.gz              Filtered package index
    headless/binary-<arch>/
      Packages.gz              Merged meta-suite
```

## Parallelism

| Phase    | Mechanism          | Granularity     |
|----------|--------------------|-----------------|
| Fetch    | `xargs -P`         | per file        |
| Filter   | `make -j`          | per distro/suite |
| Headless | `make -j`          | per distro/suite |
| Sign     | sequential         | all suites      |
| Validate | bash `&` + `wait`  | per distro      |
