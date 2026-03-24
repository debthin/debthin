#!/usr/bin/env bash
# check-bootstrap-deps.sh - Identify packages required by debootstrap that
# are missing from the debthin Packages.gz index.
#
# Resolves the full debootstrap dependency tree against the UPSTREAM mirror,
# then diffs the resulting package list against debthin's Packages.gz to
# find what's missing from the curation.
#
# Usage:
#   bash scripts/images/check-bootstrap-deps.sh debian trixie amd64
#   bash scripts/images/check-bootstrap-deps.sh ubuntu noble arm64
#
# The script does NOT install anything. It only resolves the dependency
# tree and reports gaps.

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <distro> <suite> <arch>"
    echo "Example: $0 ubuntu noble arm64"
    exit 1
fi

DISTRO="$1"
SUITE="$2"
ARCH="$3"

# Resolve mirrors
case "$DISTRO" in
    debian)
        UPSTREAM="http://deb.debian.org/debian"
        DEBTHIN="http://debthin.org/debian"
        ;;
    ubuntu)
        case "$ARCH" in
            amd64|i386) UPSTREAM="http://archive.ubuntu.com/ubuntu" ;;
            *)          UPSTREAM="http://ports.ubuntu.com/ubuntu-ports" ;;
        esac
        DEBTHIN="http://debthin.org/ubuntu"
        ;;
    raspbian)
        UPSTREAM="http://archive.raspbian.org/raspbian"
        DEBTHIN="http://debthin.org/debian"
        ;;
    *)
        echo "Unknown distro: $DISTRO"; exit 1
        ;;
esac

echo "=== Bootstrap dependency check: $DISTRO $SUITE $ARCH ==="
echo "Upstream: $UPSTREAM"
echo "Debthin:  $DEBTHIN"
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

# Step 2: Fetch the Packages index from debthin
echo "--- Checking availability in debthin Packages.gz ---"
PACKAGES_URL="${DEBTHIN}/dists/${SUITE}/main/binary-${ARCH}/Packages.gz"
AVAILABLE=$(curl -sL "$PACKAGES_URL" 2>/dev/null | gunzip 2>/dev/null | grep "^Package: " | sed 's/^Package: //' | sort -u)

if [ -z "$AVAILABLE" ]; then
    echo "WARNING: Could not fetch Packages index from $PACKAGES_URL"
    exit 1
fi

AVAILABLE_COUNT=$(echo "$AVAILABLE" | wc -l | tr -d ' ')
echo "Debthin Packages.gz has $AVAILABLE_COUNT packages for $SUITE/binary-$ARCH"
echo ""

# Step 3: Find the gap
echo "--- Missing from debthin ---"
MISSING=$(comm -23 <(echo "$NEEDED_SORTED") <(echo "$AVAILABLE"))

if [ -z "$MISSING" ]; then
    echo "All debootstrap packages are present in debthin Packages.gz."
else
    MISSING_COUNT=$(echo "$MISSING" | wc -l | tr -d ' ')
    echo "$MISSING_COUNT packages required by debootstrap are MISSING from debthin:"
    echo ""
    echo "$MISSING"
fi
