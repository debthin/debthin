#!/usr/bin/env bash
# filter.sh - Run allowlist filtering for a single distro/suite.
#
# Usage: bash filter.sh <distro> <suite>
#
# Resolves the curated allowlist (with required_packages merge),
# identifies stale Packages.gz files, and runs filter.py in batch mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-config.json}"

cd "$REPO_ROOT"

DISTRO="$1"
SUITE="$2"

# ── Resolve allowlist ─────────────────────────────────────────────────────────

curated_base=$(jq -r ".\"$DISTRO\".suites.\"$SUITE\".curated_base // \"\"" "$CONFIG_FILE")

stable_suite=$(jq -r '.debian.suites | to_entries[] | select(.value.aliases and (.value.aliases | index("stable"))) | .key' "$CONFIG_FILE")

allowed=""
if [[ -n "$curated_base" && -f "curated/$curated_base/all.txt" ]]; then
    allowed="curated/$curated_base/all.txt"
elif [[ -f "curated/$DISTRO/$SUITE/all.txt" ]]; then
    allowed="curated/$DISTRO/$SUITE/all.txt"
elif [[ -f "curated/$DISTRO/$stable_suite/all.txt" ]]; then
    allowed="curated/$DISTRO/$stable_suite/all.txt"
elif [[ -f "curated/debian/$stable_suite/all.txt" ]]; then
    allowed="curated/debian/$stable_suite/all.txt"
else
    echo "ERROR: no allowed list found for $DISTRO/$SUITE and fallback to $stable_suite failed" >&2
    exit 1
fi

echo "  Allowed list for $DISTRO/$SUITE: $allowed" >&2

# ── Merge required_packages overrides ─────────────────────────────────────────

req_pkg=""
if [[ -f "required_packages/$DISTRO/$SUITE.txt" ]]; then
    req_pkg="required_packages/$DISTRO/$SUITE.txt"
elif [[ -f "required_packages/$DISTRO.txt" ]]; then
    req_pkg="required_packages/$DISTRO.txt"
elif [[ -f "required_packages/debian.txt" ]]; then
    req_pkg="required_packages/debian.txt"
fi

if [[ -n "$req_pkg" ]]; then
    echo "  Required packages: $req_pkg" >&2
    merged=$(mktemp)
    cat "$allowed" "$req_pkg" | sort -u > "$merged"
    allowed="$merged"
fi

# ── Build batch job file ──────────────────────────────────────────────────────

filter_script="scripts/debthin/filter.py"
jobfile=$(mktemp)

while IFS= read -r -d "" cachefile; do
    outfile="${cachefile/.tmp_cache\/$DISTRO\//dist_output\/dists\/$DISTRO\/}"

    needs_filter=0
    if [[ ! -f "$outfile" ]]; then
        needs_filter=1
    elif [[ "$cachefile" -nt "$outfile" ]]; then
        needs_filter=1
    elif [[ "$allowed" -nt "$outfile" ]]; then
        needs_filter=1
    elif [[ "$filter_script" -nt "$outfile" ]]; then
        needs_filter=1
    fi

    if [[ $needs_filter -eq 1 ]]; then
        mkdir -p "$(dirname "$outfile")"
        printf "%s\t%s\n" "$cachefile" "$outfile"
    fi
done < <(find ".tmp_cache/$DISTRO/$SUITE" -name "Packages.gz" -print0 2>/dev/null | sort -z) > "$jobfile"

n=$(wc -l < "$jobfile")
if [[ $n -eq 0 ]]; then
    echo "  Skipping filtering for $DISTRO/$SUITE (unchanged)" >&2
    rm -f "$jobfile"
    [[ "$allowed" == /tmp/* ]] && rm -f "$allowed"
    exit 0
fi

echo "  Filtering $DISTRO/$SUITE: $n jobs..." >&2
python3 "$filter_script" --allowed "$allowed" --batch "$jobfile" --stats
rm -f "$jobfile"
[[ "$allowed" == /tmp/* ]] && rm -f "$allowed" || true
