#!/usr/bin/env bash
# Full rebuild - fetch, filter, sign, upload to R2
# Run from the debthin repo root

set -euo pipefail

DEBIAN_SUITES=(forky trixie trixie-updates bookworm bookworm-updates bullseye bullseye-updates)
UBUNTU_SUITES=(
    jammy jammy-updates jammy-backports
    noble noble-updates noble-backports
    plucky plucky-updates plucky-backports
    questing questing-updates questing-backports
)
DEBIAN_ARCHES=(amd64 arm64 armhf i386 riscv64)
DEBIAN_RISCV_SUITES=(forky trixie trixie-updates)
DEBIAN_COMPONENTS=(main contrib non-free non-free-firmware)

UBUNTU_ARCHIVE_ARCHES=(amd64 i386)
UBUNTU_PORTS_ARCHES=(arm64 riscv64)
UBUNTU_COMPONENTS=(main restricted universe multiverse)
UBUNTU_ARCHIVE="https://archive.ubuntu.com/ubuntu"
UBUNTU_PORTS="https://ports.ubuntu.com/ubuntu-ports"

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
    local cachedir="cached/$distro/$suite/$component/binary-$arch"
    local cachefile="$cachedir/Packages.gz"

    mkdir -p "$cachedir"

    if curl -sf --retry 3 -z "$cachefile" -o "$cachefile" \
        "$upstream_base/dists/$suite/$component/binary-$arch/Packages.gz" 2>/dev/null; then
        :
    elif [[ ! -s "$cachefile" ]]; then
        if curl -sf --retry 3 -o "${cachefile}.xz" \
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
    local cachefile="cached/$distro/$suite/InRelease"

    mkdir -p "cached/$distro/$suite"
    curl -sf --retry 3 -z "$cachefile" -o "$cachefile" \
        "$upstream_base/dists/$suite/InRelease" 2>/dev/null || true
    # No warning if missing - upstream may not have it yet for testing suites
}
export -f do_fetch_inrelease

run_filter_batch() {
    local distro=$1
    local jobfile
    jobfile=$(mktemp)
    while IFS= read -r -d "" cachefile; do
        local outfile="${cachefile/cached\/$distro\//dist_output\/$distro\/dists\/}"
        mkdir -p "$(dirname "$outfile")"
        printf "%s\t%s\n" "$cachefile" "$outfile"
    done < <(find "cached/$distro" -name "Packages.gz" -print0 2>/dev/null | sort -z) > "$jobfile"
    local n; n=$(wc -l < "$jobfile")
    echo "  Filtering $distro: $n jobs..." >&2
    python3 scripts/filter.py \
        --allowed "curated/$distro/all.txt" \
        --batch "$jobfile" \
        --stats
    rm -f "$jobfile"
}


# ── Phase 1: Fetch in parallel ───────────────────────────────────────────────

echo "Phase 1: fetching upstream indexes (parallel=$PARALLEL)..." >&2

{
  for suite in "${DEBIAN_SUITES[@]}"; do
      if [[ "$suite" == "bullseye" || "$suite" == "bullseye-updates" ]]; then
          components=(main contrib non-free)
      else
          components=("${DEBIAN_COMPONENTS[@]}")
      fi
      for component in "${components[@]}"; do
          echo "debian https://deb.debian.org/debian $suite $component all"
          for arch in "${DEBIAN_ARCHES[@]}"; do
              [[ "$arch" == "riscv64" && ! " ${DEBIAN_RISCV_SUITES[*]} " =~ " $suite " ]] && continue
              echo "debian https://deb.debian.org/debian $suite $component $arch"
          done
      done
  done

  for suite in "${UBUNTU_SUITES[@]}"; do
      for component in "${UBUNTU_COMPONENTS[@]}"; do
          for arch in "${UBUNTU_ARCHIVE_ARCHES[@]}"; do
              echo "ubuntu $UBUNTU_ARCHIVE $suite $component $arch"
          done
          for arch in "${UBUNTU_PORTS_ARCHES[@]}"; do
              echo "ubuntu $UBUNTU_PORTS $suite $component $arch"
          done
      done
  done
} | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch $@' _

# InRelease - once per suite, same parallel pool
{
  for suite in "${DEBIAN_SUITES[@]}"; do
      echo "debian https://deb.debian.org/debian $suite"
  done
  for suite in "${UBUNTU_SUITES[@]}"; do
      echo "ubuntu $UBUNTU_ARCHIVE $suite"
  done
} | xargs -P "$PARALLEL" -L1 bash -c 'do_fetch_inrelease $@' _

# ── Phase 2: Batch filter ────────────────────────────────────────────────────

echo "Phase 2: filtering..." >&2
run_filter_batch debian
run_filter_batch ubuntu

# ── Phase 3: Sign (all suites, one GPG session) ──────────────────────────────

echo "Phase 3: signing..." >&2

GPG_KEY_ID=$GPG_KEY_ID bash scripts/sign_all.sh     dist_output     "https://deb.debian.org/debian"     "$UBUNTU_ARCHIVE"

# ── Upload ───────────────────────────────────────────────────────────────────

cp index.html dist_output/
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
