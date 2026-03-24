#!/usr/bin/env bash
# check-bootstrap-deps.sh - Identify packages required by debootstrap that
# are missing from the local debthin dist_output Packages.gz.
#
# Resolves the full debootstrap dependency tree against the UPSTREAM mirror,
# then diffs the resulting package list against the local dist_output/
# Packages.gz to find what's missing from the curation.
#
# Usage:
#   bash scripts/images/check-bootstrap-deps.sh debian trixie amd64
#   bash scripts/images/check-bootstrap-deps.sh ubuntu noble arm64
#
# The script does NOT install anything. It only resolves the dependency
# tree and reports gaps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DIST_OUTPUT="${REPO_ROOT}/dist_output"

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <distro> <suite> <arch>"
    echo "Example: $0 ubuntu noble arm64"
    exit 1
fi

DISTRO="$1"
SUITE="$2"
ARCH="$3"

# Resolve upstream mirror for debootstrap --print-debs
case "$DISTRO" in
    debian)
        UPSTREAM="http://deb.debian.org/debian"
        LOCAL_DISTRO="debian"
        ;;
    ubuntu)
        case "$ARCH" in
            amd64|i386) UPSTREAM="http://archive.ubuntu.com/ubuntu" ;;
            *)          UPSTREAM="http://ports.ubuntu.com/ubuntu-ports" ;;
        esac
        LOCAL_DISTRO="ubuntu"
        ;;
    raspbian)
        UPSTREAM="http://archive.raspbian.org/raspbian"
        LOCAL_DISTRO="debian"
        ;;
    *)
        echo "Unknown distro: $DISTRO"; exit 1
        ;;
esac

# Local Packages.gz path in dist_output
LOCAL_PKG="${DIST_OUTPUT}/dists/${LOCAL_DISTRO}/${SUITE}/main/binary-${ARCH}/Packages.gz"

if [ ! -f "$LOCAL_PKG" ]; then
    echo "ERROR: Local Packages.gz not found at: $LOCAL_PKG"
    echo "Run the debthin build pipeline first."
    exit 1
fi

echo "=== Bootstrap dependency check: $DISTRO $SUITE $ARCH ==="
echo "Upstream:    $UPSTREAM"
echo "Local index: $LOCAL_PKG"
echo ""

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Step 1: Resolve the package list against the upstream mirror
echo "--- Resolving debootstrap dependency tree (upstream) ---"
NEEDED=$(debootstrap --print-debs --arch="$ARCH" "$SUITE" "$WORK/target" "$UPSTREAM" 2>/dev/null || true)

if [ -z "$NEEDED" ]; then
    echo "ERROR: debootstrap --print-debs returned nothing."
    echo ""
    echo "Verbose output:"
    rm -rf "$WORK/target"
    debootstrap --print-debs --arch="$ARCH" "$SUITE" "$WORK/target" "$UPSTREAM" 2>&1 || true
    exit 1
fi

NEEDED_SORTED=$(echo "$NEEDED" | tr ' ' '\n' | sort -u)
NEEDED_COUNT=$(echo "$NEEDED_SORTED" | wc -l | tr -d ' ')
echo "Debootstrap requires $NEEDED_COUNT packages for $DISTRO/$SUITE/$ARCH"
echo ""

# Step 2: Read the local dist_output Packages.gz
echo "--- Checking availability in local dist_output ---"
AVAILABLE=$(gunzip -c "$LOCAL_PKG" | grep "^Package: " | sed 's/^Package: //' | sort -u)

AVAILABLE_COUNT=$(echo "$AVAILABLE" | wc -l | tr -d ' ')
echo "Local Packages.gz has $AVAILABLE_COUNT packages for $SUITE/binary-$ARCH"
echo ""

# Step 3: Also check which packages exist upstream (to filter ghosts)
echo "--- Checking which packages exist in upstream main ---"
UPSTREAM_PKG_URL="${UPSTREAM}/dists/${SUITE}/main/binary-${ARCH}/Packages.gz"
UPSTREAM_AVAILABLE=$(curl -sL "$UPSTREAM_PKG_URL" 2>/dev/null | gunzip 2>/dev/null | grep "^Package: " | sed 's/^Package: //' | sort -u)

# Step 4: Find the gap
echo "--- Missing from debthin ---"
MISSING=$(comm -23 <(echo "$NEEDED_SORTED") <(echo "$AVAILABLE"))

if [ -z "$MISSING" ]; then
    echo "All debootstrap packages are present in local Packages.gz."
else
    # Split into packages that exist upstream vs packages that don't
    MISSING_AND_EXISTS=$(comm -12 <(echo "$MISSING") <(echo "$UPSTREAM_AVAILABLE"))
    MISSING_AND_GHOST=$(comm -23 <(echo "$MISSING") <(echo "$UPSTREAM_AVAILABLE"))

    if [ -n "$MISSING_AND_EXISTS" ]; then
        REAL_COUNT=$(echo "$MISSING_AND_EXISTS" | wc -l | tr -d ' ')
        echo "$REAL_COUNT packages MISSING (exist upstream, need curation):"
        echo ""
        echo "$MISSING_AND_EXISTS"
        echo ""
    fi

    if [ -n "$MISSING_AND_GHOST" ]; then
        GHOST_COUNT=$(echo "$MISSING_AND_GHOST" | wc -l | tr -d ' ')
        echo "$GHOST_COUNT packages MISSING but NOT in upstream main (virtual/transitional, skip):"
        echo ""
        echo "$MISSING_AND_GHOST"
    fi
fi
