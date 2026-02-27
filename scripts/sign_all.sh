#!/usr/bin/env bash
# sign_all.sh - Generate Release files and sign all suites in one GPG session.
#
# Usage: GPG_KEY_ID=<fp> bash sign_all.sh <dist_output> <upstream_debian> <upstream_ubuntu>
#
# Generates Release files in parallel (curl + sha256 work), then signs all
# in a single loop so gpg-agent is loaded exactly once.

set -euo pipefail

DIST_OUTPUT="${1:-dist_output}"
UPSTREAM_DEBIAN="${2:-https://deb.debian.org/debian}"
UPSTREAM_UBUNTU="${3:-https://archive.ubuntu.com/ubuntu}"

[[ -z "${GPG_KEY_ID:-}" ]] && { echo "GPG_KEY_ID not set" >&2; exit 1; }

PARALLEL=${PARALLEL:-8}

# ── Generate one Release file (no signing) ───────────────────────────────────

gen_release() {
    local dist_dir=$1 upstream_base=$2
    local suite distro

    suite=$(basename "$dist_dir")
    distro=$(basename "$(dirname "$(dirname "$dist_dir")")")

    local inrelease_cache="cached/$distro/$suite/InRelease"
    if [[ ! -f "$inrelease_cache" ]]; then
        curl -sf --retry 3 --max-time 15 \
            -o "$inrelease_cache" \
            "$upstream_base/dists/$suite/InRelease" 2>/dev/null || true
    fi
    local upstream_inrelease=""
    [[ -s "$inrelease_cache" ]] && upstream_inrelease=$(< "$inrelease_cache")

    extract_field() {
        grep -m1 "^$1:" <<< "$upstream_inrelease" | sed "s/^$1: *//" || true
    }

    local upstream_suite upstream_version upstream_date upstream_changelogs
    upstream_suite=$(extract_field "Suite")
    upstream_version=$(extract_field "Version")
    upstream_date=$(extract_field "Date")
    upstream_changelogs=$(extract_field "Changelogs")

    local date suite_line version_line changelogs_line description
    date="${upstream_date:-$(date -u +"%a, %d %b %Y %H:%M:%S UTC")}"
    suite_line="Suite: ${upstream_suite:-$suite}"
    version_line=""; [[ -n "$upstream_version" ]] && version_line="Version: $upstream_version"
    changelogs_line=""; [[ -n "$upstream_changelogs" ]] && changelogs_line="Changelogs: $upstream_changelogs"

    if [[ -n "$upstream_version" ]]; then
        description="Curated server package index for ${distro^} $upstream_version (${suite}) - debthin.org"
    else
        description="Curated server package index for ${distro^} ${suite} - debthin.org"
    fi

    local sha256_file
    sha256_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f $sha256_file" RETURN

    while IFS= read -r -d '' f; do
        local rel relbase reldir size_gz sha256_gz raw sha256_raw size_raw
        rel="${f#$dist_dir/}"
        relbase="${rel%.gz}"
        reldir=$(dirname "$rel")
        size_gz=$(stat -c%s "$f")
        sha256_gz=$(sha256sum "$f" | cut -d' ' -f1)
        raw=$(gunzip -c "$f")
        sha256_raw=$(printf '%s' "$raw" | sha256sum | cut -d' ' -f1)
        size_raw=$(printf '%s' "$raw" | wc -c | tr -d ' ')

        printf " %s %s %s\n" "$sha256_gz"  "$size_gz"  "$rel"                              >> "$sha256_file"
        printf " %s %s %s\n" "$sha256_gz"  "$size_gz"  "$reldir/by-hash/SHA256/$sha256_gz" >> "$sha256_file"
        printf " %s %s %s\n" "$sha256_raw" "$size_raw" "$relbase"                          >> "$sha256_file"

        local arch component arch_release sha256_ar size_ar
        arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
        component=$(basename "$(dirname "$(dirname "$f")")")
        arch_release="Archive: $suite"$'\n'"Component: $component"$'\n'"Architecture: $arch"$'\n'
        sha256_ar=$(printf '%s' "$arch_release" | sha256sum | cut -d' ' -f1)
        size_ar=${#arch_release}
        printf " %s %s %s\n" "$sha256_ar" "$size_ar" "$reldir/Release"                    >> "$sha256_file"
    done < <(find "$dist_dir" -type f -name "Packages.gz" -print0 | sort -z)

    {
        echo "Origin: debthin"
        echo "Label: debthin"
        echo "$suite_line"
        [[ -n "$version_line" ]]    && echo "$version_line"
        echo "Codename: $suite"
        [[ -n "$changelogs_line" ]] && echo "$changelogs_line"
        echo "Date: $date"
        echo "Acquire-By-Hash: yes"
        if [[ "$distro" == "ubuntu" ]]; then
            echo "Architectures: amd64 arm64 i386 riscv64"
        elif [[ "$suite" == "forky" || "$suite" == "trixie" || "$suite" == "trixie-updates" ]]; then
            echo "Architectures: all amd64 arm64 armhf i386 riscv64"
        else
            echo "Architectures: all amd64 arm64 armhf i386"
        fi
        if [[ "$distro" == "ubuntu" ]]; then
            echo "Components: main restricted universe multiverse"
        elif [[ "$suite" == "bullseye" || "$suite" == "bullseye-updates" ]]; then
            echo "Components: main contrib non-free"
        else
            echo "Components: main contrib non-free non-free-firmware"
        fi
        echo "Description: $description"
        echo "SHA256:"
        cat "$sha256_file"
    } > "$dist_dir/Release"

    echo "  Release: $distro/$suite" >&2
}
export -f gen_release

# ── Phase A: Generate all Release files in parallel ──────────────────────────

echo "Signing phase A: generating Release files (parallel=$PARALLEL)..." >&2

{
    find "$DIST_OUTPUT/debian/dists" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | \
        while read -r d; do echo "$d $UPSTREAM_DEBIAN"; done
    find "$DIST_OUTPUT/ubuntu/dists" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | \
        while read -r d; do echo "$d $UPSTREAM_UBUNTU"; done
} | xargs -P "$PARALLEL" -L1 bash -c 'gen_release $@' _

# ── Phase B: Sign all Release files in one GPG session ───────────────────────

echo "Signing phase B: signing all Release files..." >&2

GPG_ARGS=(--batch --yes --armor --clearsign --default-key "$GPG_KEY_ID")
[[ -n "${GPG_HOMEDIR:-}" ]] && GPG_ARGS+=(--homedir "$GPG_HOMEDIR")

# Warm the agent before the loop
gpg "${GPG_ARGS[@]}" --output /dev/null - <<< "" 2>/dev/null || true

while IFS= read -r release_file; do
    inrelease="${release_file%Release}InRelease"
    gpg "${GPG_ARGS[@]}" --output "$inrelease" "$release_file"
    [[ -s "$inrelease" ]] || { echo "ERROR: $inrelease empty after signing" >&2; exit 1; }
    echo "  Signed: $inrelease" >&2
done < <(find "$DIST_OUTPUT" -name "Release" -not -name "InRelease" | sort)

echo "Done: all suites signed." >&2
