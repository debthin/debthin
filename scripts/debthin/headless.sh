#!/usr/bin/env bash
# headless.sh - Generate headless meta-suite for a single distro/suite.
#
# Usage: bash headless.sh <distro> <suite>
#
# Merges all component Packages.gz files (including -updates) into a single
# deduplicated headless/binary-<arch>/Packages.gz per architecture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

DISTRO="$1"
SUITE="$2"

# Skip -updates suites (they're inputs, not targets)
if [[ "$SUITE" == *-updates ]]; then
    exit 0
fi

echo "  Headless: $DISTRO/$SUITE..." >&2

# Collect source directories: the base suite and its -updates companion
dirs=( "dist_output/dists/$DISTRO/$SUITE" )
if [[ "$SUITE" != *-backports ]]; then
    dirs+=( "dist_output/dists/$DISTRO/$SUITE-updates" )
fi

# Discover all architectures present across source directories
local_arches=()
for d in "${dirs[@]}"; do
    if [[ -d "$d" ]]; then
        for arch_dir in "$d"/*/binary-*/; do
            if [[ -d "$arch_dir" ]]; then
                arch_dir="${arch_dir%/}"
                local_arches+=("$(basename "$arch_dir")")
            fi
        done
    fi
done
local_arches=$(printf "%s\n" "${local_arches[@]}" | sort -u || true)

# Merge per architecture
for bin_arch in $local_arches; do
    if [[ -z "$bin_arch" || "$bin_arch" == "binary-*" ]]; then continue; fi

    inputs=()
    for comp_dir in dist_output/dists/"$DISTRO"/"$SUITE"/*/; do
        if [[ -d "$comp_dir" && "$(basename "$comp_dir")" != "headless" ]]; then
            pkg_gz="${comp_dir}${bin_arch}/Packages.gz"
            if [[ -f "$pkg_gz" ]]; then inputs+=("$pkg_gz"); fi
        fi
    done

    if [[ "$SUITE" != *-backports ]]; then
        for comp_dir in dist_output/dists/"$DISTRO"/"$SUITE-updates"/*/; do
            if [[ -d "$comp_dir" && "$(basename "$comp_dir")" != "headless" ]]; then
                pkg_gz="${comp_dir}${bin_arch}/Packages.gz"
                if [[ -f "$pkg_gz" ]]; then inputs+=("$pkg_gz"); fi
            fi
        done
    fi

    if [[ ${#inputs[@]} -gt 0 ]]; then
        out_file="dist_output/dists/$DISTRO/$SUITE/headless/$bin_arch/Packages.gz"

        needs_head=0
        if [[ ! -f "$out_file" ]]; then
            needs_head=1
        elif [[ "scripts/debthin/merge_packages.py" -nt "$out_file" ]]; then
            needs_head=1
        else
            for in_f in "${inputs[@]}"; do
                if [[ "$in_f" -nt "$out_file" ]]; then
                    needs_head=1
                    break
                fi
            done
        fi

        if [[ $needs_head -eq 1 ]]; then
            mkdir -p "$(dirname "$out_file")"
            python3 scripts/debthin/merge_packages.py "${inputs[@]}" -o "$out_file"
        fi
    fi
done
