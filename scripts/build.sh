#!/usr/bin/env bash
# Full rebuild - fetch, filter, sign, upload to R2
# Run from the debthin repo root

set -euo pipefail

CONFIG_FILE="config.json"
[[ -f "$CONFIG_FILE" ]] || { echo "ERROR: config.json not found" >&2; exit 1; }

GPG_KEY_ID=C2564E8797299A499FCABFE052BBA2F43AEC90C5

PARALLEL=${PARALLEL:-8}

R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY="${R2_ACCESS_KEY:-}"
R2_SECRET_KEY="${R2_SECRET_KEY:-}"
R2_BUCKET="${R2_BUCKET:-debthin}"
NO_UPLOAD="${NO_UPLOAD:-0}"

if [[ "$NO_UPLOAD" != "1" ]]; then
    if [[ -z "$R2_ACCOUNT_ID" || -z "$R2_ACCESS_KEY" || -z "$R2_SECRET_KEY" ]]; then
        echo "ERROR: R2_ACCOUNT_ID, R2_ACCESS_KEY and R2_SECRET_KEY must be set (or set NO_UPLOAD=1 to skip upload)" >&2
        exit 1
    fi
fi

# ── Config helpers ────────────────────────────────────────────────────────────
# Emit one line per fetch job from all distros in config.json.
# Per-suite upstream/component/arch overrides are respected.

fetch_jobs() {
    jq -r '
      to_entries[]
      | .key as $distro
      | .value as $c
      | if (.value.upstream // .value.upstream_archive // .value.upstream_ports // null) == null
        then empty else
          $c.suites | to_entries[]
          | .key as $suite | .value as $smeta
          | ( $smeta.components // $c.components // [] ) as $comps
          | (
              # Collect all (upstream, arch) pairs for this suite
              (
                ( $smeta.arches // $c.arches // [] )
                | map({ up: ($smeta.upstream // $c.upstream), arch: . })
              ) +
              (
                ( $c.archive_arches // [] )
                | map({ up: ($c.upstream_archive // $c.upstream), arch: . })
              ) +
              (
                ( $c.ports_arches // [] )
                | map({ up: ($c.upstream_ports // $c.upstream), arch: . })
              )
            ) as $pairs
          | $comps[] as $comp
          | $pairs[]
          | "\($distro) \(.up) \($suite) \($comp) \(.arch)"
        end
    ' "$CONFIG_FILE"
}

inrelease_jobs() {
    jq -r '
      to_entries[]
      | .key as $distro
      | .value as $c
      | (.value.upstream // .value.upstream_archive // .value.upstream_ports // null) as $up
      | if $up == null then empty else
          $c.suites | keys[]
          | "\($distro) \($up) \(.)"
        end
    ' "$CONFIG_FILE"
}

distro_suites() {
    jq -r '
      to_entries[]
      | .key as $distro
      | (.value.upstream // .value.upstream_archive // .value.upstream_ports // null) as $up
      | if $up == null then empty else
          .value.suites | keys[] | "\($distro) \(.)"
        end
    ' "$CONFIG_FILE"
}

# ── Helpers ───────────────────────────────────────────────────────────────────

do_fetch() {
    local distro=$1 upstream_base=$2 suite=$3 component=$4 arch=$5
    local cachedir=".tmp_cache/$distro/$suite/$component/binary-$arch"
    local cachefile="$cachedir/Packages.gz"

    mkdir -p "$cachedir"

    if curl -sf --retry 3 --retry-delay 5 -z "$cachefile" -o "$cachefile" \
        "$upstream_base/dists/$suite/$component/binary-$arch/Packages.gz" 2>/dev/null; then
        :
    elif [[ ! -s "$cachefile" ]]; then
        if curl -sf --retry 3 --retry-delay 5 -o "${cachefile}.xz" \
            "$upstream_base/dists/$suite/$component/binary-$arch/Packages.xz" 2>/dev/null; then
            xzcat "${cachefile}.xz" | gzip -1 > "$cachefile" && rm -f "${cachefile}.xz"
        else
            echo "WARNING: $distro/$suite/$component/$arch not available" >&2
        fi
    fi
}
export -f do_fetch

do_fetch_inrelease() {
    local distro=$1 upstream_base=$2 suite=$3
    local cachefile=".tmp_cache/$distro/$suite/InRelease"

    mkdir -p ".tmp_cache/$distro/$suite"
    curl -sf --retry 3 -z "$cachefile" -o "$cachefile" \
        "$upstream_base/dists/$suite/InRelease" 2>/dev/null || true
}
export -f do_fetch_inrelease

run_filter_batch() {
    local distro=$1 suite=$2
    local jobfile
    jobfile=$(mktemp)

    local curated_base
    curated_base=$(jq -r ".\"$distro\".suites.\"$suite\".curated_base // \"\"" "$CONFIG_FILE")
    
    local stable_suite
    stable_suite=$(jq -r '.debian.suites | to_entries[] | select(.value.aliases and (.value.aliases | index("stable"))) | .key' "$CONFIG_FILE")

    local allowed=""
    if [[ -n "$curated_base" && -f "curated/$curated_base/all.txt" ]]; then
        allowed="curated/$curated_base/all.txt"
    elif [[ -f "curated/$distro/$suite/all.txt" ]]; then
        allowed="curated/$distro/$suite/all.txt"
    elif [[ -f "curated/$distro/$stable_suite/all.txt" ]]; then
        allowed="curated/$distro/$stable_suite/all.txt"
    elif [[ -f "curated/debian/$stable_suite/all.txt" ]]; then
        allowed="curated/debian/$stable_suite/all.txt"
    else
        echo "ERROR: no allowed list found for $distro/$suite and fallback to $stable_suite failed" >&2
        return 1
    fi

    echo "  Allowed list for $distro/$suite: $allowed" >&2

    while IFS= read -r -d "" cachefile; do
        local outfile="${cachefile/.tmp_cache\/$distro\//dist_output\/dists\/$distro\/}"
        mkdir -p "$(dirname "$outfile")"
        printf "%s\t%s\n" "$cachefile" "$outfile"
    done < <(find ".tmp_cache/$distro/$suite" -name "Packages.gz" -print0 2>/dev/null | sort -z) > "$jobfile"

    local n; n=$(wc -l < "$jobfile")
    if [[ $n -eq 0 ]]; then rm -f "$jobfile"; return 0; fi

    echo "  Filtering $distro/$suite: $n jobs..." >&2
    python3 scripts/filter.py --allowed "$allowed" --batch "$jobfile" --stats
    rm -f "$jobfile"
}

BUILD_START=$(date +%s)
BUILT_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Phase 1: Fetch in parallel ────────────────────────────────────────────────

echo "Phase 1: fetching upstream indexes (parallel=$PARALLEL)..." >&2

fetch_jobs      | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch "$@"' _
inrelease_jobs  | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch_inrelease "$@"' _

# ── Phase 2: Filter ───────────────────────────────────────────────────────────

echo "Phase 2: filtering..." >&2

while read -r distro suite; do
    run_filter_batch "$distro" "$suite"
done < <(distro_suites)

# ── Phase 3: Sign ─────────────────────────────────────────────────────────────

echo "Phase 3: signing..." >&2

GPG_KEY_ID=$GPG_KEY_ID bash scripts/sign_all.sh dist_output "$CONFIG_FILE"

# ── Upload ────────────────────────────────────────────────────────────────────

cp index.html           dist_output/
cp config.json          dist_output/
cp debthin-keyring.gpg  dist_output/
cp debthin-keyring-binary.gpg dist_output/

find dist_output -name "Packages" -not -name "*.gz" -delete

echo "Validating dist_output/..." >&2
DURATION=$(( $(date +%s) - BUILD_START ))
bash scripts/validate.sh dist_output \
    --json dist_output/status.json \
    --cache-dir .tmp_cache \
    --built-at "$BUILT_AT" \
    --duration-seconds "$DURATION"

if [[ "$NO_UPLOAD" != "1" ]]; then
    echo "Uploading to Cloudflare R2..." >&2
    python3 scripts/r2_upload.py \
        --dir dist_output \
        --account "$R2_ACCOUNT_ID" \
        --access-key "$R2_ACCESS_KEY" \
        --secret-key "$R2_SECRET_KEY" \
        --bucket "$R2_BUCKET"
else
    echo "Skipping Cloudflare R2 upload (NO_UPLOAD=1)." >&2
fi

echo "Done."
