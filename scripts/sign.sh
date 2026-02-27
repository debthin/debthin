#!/usr/bin/env bash
# sign.sh - Generate Release file and sign as InRelease
#
# Usage: GPG_KEY_ID=<fingerprint> bash sign.sh <dist_output/DISTRO/dists/SUITE> <upstream_base>
#
# Example:
#   GPG_KEY_ID=... bash sign.sh dist_output/debian/dists/trixie https://deb.debian.org/debian
#   GPG_KEY_ID=... bash sign.sh dist_output/ubuntu/dists/noble  https://archive.ubuntu.com/ubuntu

set -euo pipefail

DIST_DIR="${1:-}"
UPSTREAM_BASE="${2:-https://deb.debian.org/debian}"

if [[ -z "$DIST_DIR" ]]; then
    echo "Usage: $0 <dist_output/DISTRO/dists/SUITE> [upstream_base]" >&2
    exit 1
fi

if [[ -z "${GPG_KEY_ID:-}" ]]; then
    echo "GPG_KEY_ID not set" >&2
    exit 1
fi

SUITE=$(basename "$DIST_DIR")

echo "Fetching upstream InRelease for $SUITE from $UPSTREAM_BASE..." >&2
UPSTREAM_INRELEASE=$(curl -sf --retry 3 --max-time 15 \
    "$UPSTREAM_BASE/dists/$SUITE/InRelease" 2>/dev/null) || UPSTREAM_INRELEASE=""

extract_field() {
    grep -m1 "^$1:" <<< "$UPSTREAM_INRELEASE" | sed "s/^$1: *//" || true
}

UPSTREAM_SUITE=$(extract_field "Suite")
UPSTREAM_VERSION=$(extract_field "Version")
UPSTREAM_DATE=$(extract_field "Date")
UPSTREAM_CHANGELOGS=$(extract_field "Changelogs")

DATE="${UPSTREAM_DATE:-$(date -u +"%a, %d %b %Y %H:%M:%S UTC")}"
SUITE_LINE="Suite: ${UPSTREAM_SUITE:-$SUITE}"
VERSION_LINE=""
[[ -n "$UPSTREAM_VERSION" ]] && VERSION_LINE="Version: $UPSTREAM_VERSION"
CHANGELOGS_LINE=""
[[ -n "$UPSTREAM_CHANGELOGS" ]] && CHANGELOGS_LINE="Changelogs: $UPSTREAM_CHANGELOGS"

DISTRO=$(basename "$(dirname "$(dirname "$DIST_DIR")")")
if [[ -n "$UPSTREAM_VERSION" ]]; then
    DESCRIPTION="Curated server package index for ${DISTRO^} $UPSTREAM_VERSION (${SUITE}) - debthin.org"
else
    DESCRIPTION="Curated server package index for ${DISTRO^} ${SUITE} - debthin.org"
fi

echo "Building Release for $SUITE (Date: $DATE)..." >&2

SHA256_FILE=$(mktemp)
trap "rm -f $SHA256_FILE" EXIT

# Compressed Packages.gz
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    size=$(stat -c%s "$f")
    echo " $(sha256sum "$f" | cut -d' ' -f1) $size $rel" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# By-hash entries for Packages.gz
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    size=$(stat -c%s "$f")
    sha256=$(sha256sum "$f" | cut -d' ' -f1)
    reldir=$(dirname "$rel")
    echo " $sha256 $size $reldir/by-hash/SHA256/$sha256" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# Uncompressed Packages - computed on the fly, not stored
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    relbase="${rel%.gz}"
    size=$(gunzip -c "$f" | wc -c)
    sha256=$(gunzip -c "$f" | sha256sum | cut -d' ' -f1)
    echo " $sha256 $size $relbase" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# Per-arch Release files - generated on the fly by worker
while IFS= read -r -d '' f; do
    arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
    content="Archive: $SUITE"$'\n'"Component: main"$'\n'"Architecture: $arch"$'\n'
    rel="${f#$DIST_DIR/}"
    reldir=$(dirname "$rel")
    size=${#content}
    sha256=$(echo -n "$content" | sha256sum | cut -d' ' -f1)
    echo " $sha256 $size $reldir/Release" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# Build Release
{
echo "Origin: debthin"
echo "Label: debthin"
echo "$SUITE_LINE"
[[ -n "$VERSION_LINE" ]] && echo "$VERSION_LINE"
echo "Codename: $SUITE"
[[ -n "$CHANGELOGS_LINE" ]] && echo "$CHANGELOGS_LINE"
echo "Date: $DATE"
echo "Acquire-By-Hash: yes"
if [[ "$DISTRO" == "ubuntu" ]]; then
    echo "Architectures: amd64 arm64 i386 riscv64"
elif [[ "$SUITE" == "forky" || "$SUITE" == "trixie" || "$SUITE" == "trixie-updates" ]]; then
    echo "Architectures: all amd64 arm64 armhf i386 riscv64"
else
    echo "Architectures: all amd64 arm64 armhf i386"
fi
if [[ "$DISTRO" == "ubuntu" ]]; then
    echo "Components: main restricted universe multiverse"
elif [[ "$SUITE" == "bullseye" || "$SUITE" == "bullseye-updates" ]]; then
    echo "Components: main contrib non-free"
else
    echo "Components: main contrib non-free non-free-firmware"
fi
echo "Description: $DESCRIPTION"
echo "SHA256:"
cat "$SHA256_FILE"
} > "$DIST_DIR/Release"

echo "Signing $SUITE/InRelease..." >&2

GPG_ARGS=(--batch --yes --armor --clearsign --default-key "$GPG_KEY_ID")
[[ -n "${GPG_HOMEDIR:-}" ]] && GPG_ARGS+=(--homedir "$GPG_HOMEDIR")

gpg "${GPG_ARGS[@]}" --output "$DIST_DIR/InRelease" "$DIST_DIR/Release"

echo "Done: $DIST_DIR/InRelease" >&2
