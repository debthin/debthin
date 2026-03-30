#!/usr/bin/env bash
# sign_all.sh - Generate Release files and sign all suites in one GPG session.
#
# Usage: GPG_KEY_ID=<fp> bash sign_all.sh <dist_output> [config.json]
#
# Reads all distro/suite/upstream metadata from config.json.
# Generates Release files in parallel, then signs all in one GPG session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

DIST_OUTPUT="${1:-dist_output}"
CONFIG_FILE="${2:-config.json}"

[[ -z "${GPG_KEY_ID:-}" ]] && { echo "GPG_KEY_ID not set" >&2; exit 1; }
[[ -f "$CONFIG_FILE" ]]    || { echo "config.json not found: $CONFIG_FILE" >&2; exit 1; }

PARALLEL=${PARALLEL:-8}

# ── Build distro metadata table from config ───────────────────────────────────
# Emit lines: <distro> <upstream> <suite> <components_csv> <arches_csv>
# Components and arches respect per-suite overrides if present in config.

distro_suite_lines() {
    jq -r '
      to_entries[]
      | .key as $distro
      | .value as $c
      | (.value.upstream // .value.upstream_archive // .value.upstream_ports // null) as $up
      | if $up == null then empty else
          ($c.suites // {} | to_entries[])
          | .key as $suite
          | .value as $smeta
          | ( $smeta.components // $c.components // [] | join(",") ) as $comps
          | ( [ $smeta.arches,
                $c.arches,
                $c.archive_arches,
                $c.ports_arches
              ] | map(select(. != null)) | flatten | unique | join(",") ) as $arches
          | ($smeta.upstream // $up) as $suite_up
          | "\($distro) \($suite_up) \($suite) \($comps) \($arches)"
        end
    ' "$CONFIG_FILE"
}
export CONFIG_FILE

# ── Generate one Release file ─────────────────────────────────────────────────

gen_release() {
    local distro=$1 upstream_base=$2 suite=$3 components_csv=$4 arches_csv=$5
    local dist_dir="$DIST_OUTPUT/dists/$distro/$suite"

    [[ -d "$dist_dir" ]] || { echo "  Skipping $distro/$suite (no output dir)" >&2; return 0; }

    if [[ -d "$dist_dir/headless" ]]; then
        if [[ -n "$components_csv" ]]; then
            components_csv="$components_csv,headless"
        else
            components_csv="headless"
        fi
    fi

    local inrelease_cache=".tmp_cache/$distro/$suite/InRelease"

    # Evaluate if Release generation natively needs execution depending on dependencies
    local needs_release=0
    if [[ ! -f "$dist_dir/Release" ]]; then
        needs_release=1
    elif [[ -f "$inrelease_cache" && "$inrelease_cache" -nt "$dist_dir/Release" ]]; then
        needs_release=1
    elif [[ "scripts/debthin/sign_all.sh" -nt "$dist_dir/Release" ]]; then
        needs_release=1
    else
        while IFS= read -r -d '' f; do
            if [[ "$f" -nt "$dist_dir/Release" ]]; then
                needs_release=1
                break
            fi
        done < <(find "$dist_dir" -type f -name "Packages.gz" -print0 2>/dev/null || true)
    fi

    if [[ $needs_release -eq 0 ]]; then
        echo "  Skipping Release generation for $distro/$suite (unchanged)" >&2
        return 0
    fi

    # Fetch upstream InRelease for metadata fields (Date, Version, Changelogs, Suite)
    local inrelease_cache=".tmp_cache/$distro/$suite/InRelease"
    if [[ ! -f "$inrelease_cache" ]]; then
        mkdir -p "$(dirname "$inrelease_cache")"
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

    local date
    date="${upstream_date:-$(date -u +"%a, %d %b %Y %H:%M:%S UTC")}"

    local description
    if [[ -n "$upstream_version" ]]; then
        description="Curated server package index for ${distro^} $upstream_version ($suite) - debthin.org"
    else
        description="Curated server package index for ${distro^} $suite - debthin.org"
    fi

    # Build SHA256 manifest for all Packages.gz files and their derived paths
    local sha256_file
    sha256_file=$(mktemp)
    trap "rm -f $sha256_file" RETURN

    while IFS= read -r -d '' f; do
        local rel relbase reldir size_gz sha256_gz tmp_raw sha256_raw size_raw
        rel="${f#$dist_dir/}"
        relbase="${rel%.gz}"
        reldir=$(dirname "$rel")

        size_gz=$(wc -c < "$f")
        sha256_gz=$(sha256sum "$f" | cut -d' ' -f1)

        tmp_raw=$(mktemp)
        gunzip -c "$f" > "$tmp_raw"
        sha256_raw=$(sha256sum "$tmp_raw" | cut -d' ' -f1)
        size_raw=$(wc -c < "$tmp_raw")
        rm -f "$tmp_raw"

        printf " %s %s %s\n" "$sha256_gz"  "$size_gz"  "$rel"                              >> "$sha256_file"
        printf " %s %s %s\n" "$sha256_raw" "$size_raw" "$relbase"                          >> "$sha256_file"

        # Per-arch Release entry (generated on the fly by the worker, but still hashed)
        local arch component arch_release sha256_ar size_ar
        arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
        component=$(basename "$(dirname "$(dirname "$f")")")
        arch_release="Archive: $suite"$'\n'"Component: $component"$'\n'"Architecture: $arch"$'\n'
        sha256_ar=$(printf '%s' "$arch_release" | sha256sum | cut -d' ' -f1)
        size_ar=${#arch_release}
        printf " %s %s %s\n" "$sha256_ar" "$size_ar" "$reldir/Release" >> "$sha256_file"
    done < <(find "$dist_dir" -type f -name "Packages.gz" -print0 | sort -z)

    {
        echo "Origin: debthin"
        echo "Label: debthin"
        echo "Suite: ${upstream_suite:-$suite}"
        [[ -n "$upstream_version" ]]    && echo "Version: $upstream_version"
        echo "Codename: $suite"
        [[ -n "$upstream_changelogs" ]] && echo "Changelogs: $upstream_changelogs"
        echo "Date: $date"
        echo "Acquire-By-Hash: yes"
        echo "Architectures: $(echo "$arches_csv" | tr ',' ' ')"
        echo "Components: $(echo "$components_csv" | tr ',' ' ')"
        echo "Description: $description"
        echo "SHA256:"
        cat "$sha256_file"
        if [[ -s "$inrelease_cache" ]]; then
            grep -E "^ [a-f0-9]{64} +[0-9]+ +[^/]+/i18n/Translation-[a-zA-Z0-9_-]+(\.(gz|bz2))?$" "$inrelease_cache" || true
        fi
    } > "$dist_dir/Release"

    echo "  Release: $distro/$suite" >&2
}
export -f gen_release
export DIST_OUTPUT

# ── Phase A: Generate all Release files in parallel ──────────────────────────

echo "Signing phase A: generating Release files (parallel=$PARALLEL)..." >&2

distro_suite_lines | xargs -P "$PARALLEL" -L1 bash -c 'gen_release "$@"' _

# ── Phase B: Sign all Release files in one GPG session ───────────────────────

echo "Signing phase B: signing all Release files..." >&2

GPG_ARGS=(--batch --yes --armor --clearsign --default-key "$GPG_KEY_ID")
[[ -n "${GPG_HOMEDIR:-}" ]] && GPG_ARGS+=(--homedir "$GPG_HOMEDIR")

gpg "${GPG_ARGS[@]}" --output /dev/null - <<< "" 2>/dev/null || true

while IFS= read -r release_file; do
    inrelease="${release_file%Release}InRelease"
    release_gpg="${release_file}.gpg"

    if [[ -f "$inrelease" && -f "$release_gpg" && ! "$release_file" -nt "$inrelease" && ! "$release_file" -nt "$release_gpg" ]]; then
        echo "  Skipping signing: $(basename "$(dirname "$release_file")")/Release (unchanged)" >&2
        continue
    fi

    gpg "${GPG_ARGS[@]}" --output "$inrelease" "$release_file"
    gpg "${GPG_ARGS[@]}" --detach-sign --output "$release_gpg" "$release_file"
    [[ -s "$inrelease" ]]  || { echo "ERROR: $inrelease empty after signing" >&2; exit 1; }
    [[ -s "$release_gpg" ]] || { echo "ERROR: $release_gpg empty after signing" >&2; exit 1; }
    echo "  Signed: $(basename "$(dirname "$inrelease")")/InRelease" >&2
done < <(find "$DIST_OUTPUT" -name "Release" -not -name "*.gpg" | sort)

echo "Done: all suites signed." >&2
