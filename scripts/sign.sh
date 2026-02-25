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

CHECKSUMS_SHA256=""
CHECKSUMS_SHA512=""
while IFS= read -r -d '' f; do
    rel="${f#$DIST_DIR/}"
    size=$(stat -c%s "$f")
    CHECKSUMS_SHA256+=" $(sha256sum "$f" | cut -d' ' -f1) $size $rel\n"
    CHECKSUMS_SHA512+=" $(sha512sum "$f" | cut -d' ' -f1) $size $rel\n"
done < <(find "$DIST_DIR" -type f -name "Packages*" -print0)

cat > "$DIST_DIR/Release" <<EOF
Origin: debthin
Label: debthin
Suite: $SUITE
Codename: $SUITE
Date: $DATE
Acquire-By-Hash: no
Architectures: amd64 arm64 armhf i386 riscv64
Components: main
Description: Curated Debian server package index - debthin.org
SHA256:
$(printf "$CHECKSUMS_SHA256")
SHA512:
$(printf "$CHECKSUMS_SHA512")
EOF

echo "Signing $SUITE/InRelease..." >&2

GPG_ARGS=(--batch --yes --armor --clearsign --default-key "$GPG_KEY_ID")
[[ -n "${GPG_HOMEDIR:-}" ]] && GPG_ARGS+=(--homedir "$GPG_HOMEDIR")

gpg "${GPG_ARGS[@]}" --output "$DIST_DIR/InRelease" "$DIST_DIR/Release"

echo "Done: $DIST_DIR/InRelease" >&2
