#!/usr/bin/env bash
# Full rebuild - fetch, filter, sign, upload to R2
# Run from the debthin repo root

set -euo pipefail

CONFIG_FILE="config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: config.json not found" >&2
    exit 1
fi

GPG_KEY_ID=C2564E8797299A499FCABFE052BBA2F43AEC90C5

PARALLEL=${PARALLEL:-8}   # concurrent curl jobs

R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY="${R2_ACCESS_KEY:-}"
R2_SECRET_KEY="${R2_SECRET_KEY:-}"
R2_BUCKET="${R2_BUCKET:-debthin}"

if [[ -z "$R2_ACCOUNT_ID" || -z "$R2_ACCESS_KEY" || -z "$R2_SECRET_KEY" ]]; then
    echo "ERROR: R2_ACCOUNT_ID, R2_ACCESS_KEY and R2_SECRET_KEY must be set" >&2
    exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

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
    # No warning if missing - upstream may not have it yet for testing suites
}
export -f do_fetch_inrelease

run_filter_batch() {
    local distro=$1
    local suite=$2
    local jobfile
    jobfile=$(mktemp)
    
    # Resolve the correct allowed.txt file
    local allowed=""
    if [[ -f "curated/$distro/$suite/all.txt" ]]; then
        allowed="curated/$distro/$suite/all.txt"
    elif [[ -f "curated/$distro/all.txt" ]]; then
        allowed="curated/$distro/all.txt"
    elif [[ -f "curated/debian/all.txt" ]]; then
        allowed="curated/debian/all.txt"
    else
        echo "ERROR: Could not find allowed list for $distro/$suite" >&2
        return 1
    fi
    
    echo "  Resolved allowed list for $distro/$suite: $allowed" >&2

    while IFS= read -r -d "" cachefile; do
        local outfile="${cachefile/.tmp_cache\/$distro\//dist_output\/$distro\/dists\/}"
        mkdir -p "$(dirname "$outfile")"
        printf "%s\t%s\n" "$cachefile" "$outfile"
    done < <(find ".tmp_cache/$distro/$suite" -name "Packages.gz" -print0 2>/dev/null | sort -z) > "$jobfile"
    
    local n; n=$(wc -l < "$jobfile")
    if [[ $n -eq 0 ]]; then
        rm -f "$jobfile"
        return 0
    fi
    
    echo "  Filtering $distro/$suite: $n jobs..." >&2
    python3 scripts/filter.py \
        --allowed "$allowed" \
        --batch "$jobfile" \
        --stats
    rm -f "$jobfile"
}


# ── Phase 1: Fetch in parallel ───────────────────────────────────────────────

echo "Phase 1: fetching upstream indexes (parallel=$PARALLEL)..." >&2

{
    # Debian
    jq -r '
      .debian as $d | 
      .debian.suites | to_entries[] | 
      .key as $suite | 
      (.value.components // $d.components) as $comps |
      (.value.arches // $d.arches) as $arches |
      $comps[] | . as $comp |
      "debian \($d.upstream) \($suite) \($comp) all",
      ( $arches[] | "debian \($d.upstream) \($suite) \($comp) \(.)" )
    ' "$CONFIG_FILE"

    # Ubuntu
    jq -r '
      .ubuntu as $u | 
      .ubuntu.suites | to_entries[] | 
      .key as $suite | 
      $u.components[] | . as $comp |
      ( $u.archive_arches[] | "ubuntu \($u.upstream_archive) \($suite) \($comp) \(.)" ),
      ( $u.ports_arches[] | "ubuntu \($u.upstream_ports) \($suite) \($comp) \(.)" )
    ' "$CONFIG_FILE"
} | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch "$@"' _

# InRelease - once per suite, same parallel pool
{
    jq -r '.debian as $d | .debian.suites | keys[] | "debian \($d.upstream) \(.)"' "$CONFIG_FILE"
    jq -r '.ubuntu as $u | .ubuntu.suites | keys[] | "ubuntu \($u.upstream_archive) \(.)"' "$CONFIG_FILE"
} | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch_inrelease "$@"' _

# ── Phase 2: Batch filter ────────────────────────────────────────────────────

echo "Phase 2: filtering..." >&2

# Debian filter jobs
while read -r suite; do
    run_filter_batch debian "$suite"
done < <(jq -r '.debian.suites | keys[]' "$CONFIG_FILE")

# Ubuntu filter jobs
while read -r suite; do
    run_filter_batch ubuntu "$suite"
done < <(jq -r '.ubuntu.suites | keys[]' "$CONFIG_FILE")

# ── Phase 3: Sign (all suites, one GPG session) ──────────────────────────────

echo "Phase 3: signing..." >&2

GPG_KEY_ID=$GPG_KEY_ID bash scripts/sign_all.sh     dist_output     "https://deb.debian.org/debian"     "$UBUNTU_ARCHIVE"

# ── Upload ───────────────────────────────────────────────────────────────────

cp index.html dist_output/
cp config.json dist_output/
cp debthin-keyring.gpg dist_output/
cp debthin-keyring-binary.gpg dist_output/

# Remove any uncompressed Packages files - only .gz is served
find dist_output -name "Packages" -not -name "*.gz" -delete

echo "Validating dist_output/..." >&2
bash scripts/validate.sh dist_output

echo "Uploading to Cloudflare R2..." >&2
python3 scripts/r2_upload.py \
    --dir dist_output \
    --account "$R2_ACCOUNT_ID" \
    --access-key "$R2_ACCESS_KEY" \
    --secret-key "$R2_SECRET_KEY" \
    --bucket "$R2_BUCKET"

echo "Done."
