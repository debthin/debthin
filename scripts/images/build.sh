#!/usr/bin/env bash
# Thin wrapper for the images build pipeline.
# Validates environment, then delegates to the Makefile which handles
# target resolution, parallelism, manifest generation, and R2 upload.
#
# Usage: bash scripts/images/build.sh
#
# Environment variables:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY  - required unless NO_UPLOAD=1
#   NO_UPLOAD=1   - skip R2 upload (local build only)
#   PARALLEL=N    - max parallel build jobs (default: 4)
#   TMPFS_SIZE=288M - tmpfs mount size per build (default: 288M)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# Validate R2 credentials before invoking Make (fast-fail)
NO_UPLOAD="${NO_UPLOAD:-0}"
if [[ "$NO_UPLOAD" != "1" ]]; then
    if [[ -z "${R2_ACCOUNT_ID:-}" || -z "${R2_ACCESS_KEY:-}" || -z "${R2_SECRET_KEY:-}" ]]; then
        echo "ERROR: R2_ACCOUNT_ID, R2_ACCESS_KEY and R2_SECRET_KEY must be set (or set NO_UPLOAD=1 to skip upload)" >&2
        exit 1
    fi
fi

# Validate build dependencies
for cmd in distrobuilder debootstrap buildah jq python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command '$cmd' is not installed." >&2
        exit 1
    fi
done

JOBS="${PARALLEL:-4}"

exec make -C "$SCRIPT_DIR" -j "$JOBS" \
    NO_UPLOAD="$NO_UPLOAD" \
    FORCE="${FORCE:-0}" \
    TMPFS_SIZE="${TMPFS_SIZE:-288M}" \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY="${R2_ACCESS_KEY:-}" \
    R2_SECRET_KEY="${R2_SECRET_KEY:-}"
