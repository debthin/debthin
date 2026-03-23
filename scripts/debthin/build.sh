#!/usr/bin/env bash
# Thin wrapper for CI compatibility.
# Delegates to the Makefile which handles dependency ordering and parallelism.
#
# Usage: bash scripts/debthin/build.sh
#
# All environment variables (R2_*, GPG_KEY_ID, PARALLEL, NO_UPLOAD)
# are forwarded to Make as overrides.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# Validate R2 credentials before invoking Make (fast-fail for CI)
NO_UPLOAD="${NO_UPLOAD:-0}"
if [[ "$NO_UPLOAD" != "1" ]]; then
    if [[ -z "${R2_ACCOUNT_ID:-}" || -z "${R2_ACCESS_KEY:-}" || -z "${R2_SECRET_KEY:-}" ]]; then
        echo "ERROR: R2_ACCOUNT_ID, R2_ACCESS_KEY and R2_SECRET_KEY must be set (or set NO_UPLOAD=1 to skip upload)" >&2
        exit 1
    fi
fi

JOBS="${PARALLEL:-8}"

exec make -C "$SCRIPT_DIR" -j "$JOBS" \
    PARALLEL="$JOBS" \
    GPG_KEY_ID="${GPG_KEY_ID:-C2564E8797299A499FCABFE052BBA2F43AEC90C5}" \
    NO_UPLOAD="$NO_UPLOAD" \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY="${R2_ACCESS_KEY:-}" \
    R2_SECRET_KEY="${R2_SECRET_KEY:-}" \
    R2_BUCKET="${R2_BUCKET:-debthin}"
