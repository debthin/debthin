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

# Validate R2 credentials before invoking Make (fast-fail for CI).
#
# These values are interpolated into the Makefile's upload recipe as
# --account "$(R2_ACCOUNT_ID)" etc. A newline anywhere in one of them splits
# the recipe mid-quote and the shell dies with "Unterminated quoted string"
# and exit 2 - before python ever starts, so there is no traceback and
# nothing naming the offending variable. The Cloudflare dashboard's copy
# button appends a newline, which makes this easy to hit when rotating keys.
# Reject stray whitespace here, where we can say which variable is at fault.
NO_UPLOAD="${NO_UPLOAD:-0}"
if [[ "$NO_UPLOAD" != "1" ]]; then
    missing=()
    for var in R2_ACCOUNT_ID R2_ACCESS_KEY R2_SECRET_KEY; do
        [[ -z "${!var:-}" ]] && missing+=("$var")
    done
    if (( ${#missing[@]} )); then
        echo "ERROR: ${missing[*]} must be set (or set NO_UPLOAD=1 to skip upload)" >&2
        exit 1
    fi

    for var in R2_ACCOUNT_ID R2_ACCESS_KEY R2_SECRET_KEY R2_BUCKET; do
        value="${!var:-}"
        [[ -z "$value" ]] && continue
        if [[ "$value" =~ [[:space:]] ]]; then
            case "$value" in
                *$'\n'*) kind="a newline" ;;
                *$'\r'*) kind="a carriage return" ;;
                *$'\t'*) kind="a tab" ;;
                *)        kind="whitespace" ;;
            esac
            echo "ERROR: $var contains $kind (${#value} chars)." >&2
            echo "       This breaks the upload recipe's shell quoting. Re-set it without" >&2
            echo "       the stray character, e.g.:  printf %s 'VALUE' | gh secret set $var" >&2
            exit 1
        fi
    done
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
