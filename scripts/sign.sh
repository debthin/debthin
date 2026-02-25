#!/usr/bin/env bash
# sign.sh - Generate Release file and sign as InRelease
#
# Usage: GPG_KEY_ID=<fingerprint> bash sign.sh <dists/SUITE>

set -euo pipefail

DIST_DIR="${1:-}"

if [[ -z "$DIST_DIR" ]]; then
    echo "Usage: $0 <dists/SUITE>" >&2
    exit 1
fi

if [[ -z "${GPG_KEY_ID:-}" ]]; then
    echo "GPG_KEY_ID not set" >&2
    exit 1
fi

SUITE=$(basename "$DIST_DIR")
DATE=$(date -u +"%a, %d %b %Y %H:%M:%S UTC")

echo "Building Release for $SUITE..." >&2

SHA256_FILE=$(mktemp)
trap "rm -f $SHA256_FILE" EXIT

# Compressed Packages.gz
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    size=$(stat -c%s "$f")
    echo " $(sha256sum "$f" | cut -d' ' -f1) $size $rel" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# Uncompressed Packages - computed on the fly, not stored
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    relbase="${rel%.gz}"
    size=$(gunzip -c "$f" | wc -c)
    sha256=$(gunzip -c "$f" | sha256sum | cut -d' ' -f1)
    echo " $sha256 $size $relbase" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

# Per-arch Release files - generated on the fly by worker, but checksums needed
while IFS= read -r -d '' f; do
    arch=$(basename "$(dirname "$f")" | sed 's/binary-//')
    content="Archive: $SUITE"$'\n'"Component: main"$'\n'"Architecture: $arch"$'\n'
    rel="${f#$DIST_DIR/}"
    reldir=$(dirname "$rel")
    size=${#content}
    sha256=$(echo -n "$content" | sha256sum | cut -d' ' -f1)
    echo " $sha256 $size $reldir/Release" >> "$SHA256_FILE"
done < <(find "$DIST_DIR" -type f -name "Packages.gz" -print0 | sort -z)

cat > "$DIST_DIR/Release" <<RELEASE
Origin: debthin
Label: debthin
Suite: $SUITE
Codename: $SUITE
Date: $DATE
Acquire-By-Hash: no
Architectures: all amd64 arm64 armhf i386 riscv64
Components: main
Description: Curated Debian server package index - debthin.org
SHA256:
$(cat "$SHA256_FILE")
RELEASE

echo "Signing $SUITE/InRelease..." >&2

GPG_ARGS=(--batch --yes --armor --clearsign --default-key "$GPG_KEY_ID")
[[ -n "${GPG_HOMEDIR:-}" ]] && GPG_ARGS+=(--homedir "$GPG_HOMEDIR")

gpg "${GPG_ARGS[@]}" --output "$DIST_DIR/InRelease" "$DIST_DIR/Release"

echo "Done: $DIST_DIR/InRelease" >&2
