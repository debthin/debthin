#!/usr/bin/env bash
# check-bootstrap-deps.sh - Identify packages required by debootstrap that
# are missing from the debthin curated mirror.
#
# Runs debootstrap --print-debs against the debthin mirror for each
# distro/suite/arch, then compares the required package list against
# the Packages file available on the mirror and the required_packages
# curation lists.
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

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <distro> <suite> <arch>"
    echo "Example: $0 ubuntu noble arm64"
    exit 1
fi

DISTRO="$1"
SUITE="$2"
ARCH="$3"

# Resolve the debthin mirror URL (matches YAML templates)
case "$DISTRO" in
    debian|raspbian) MIRROR="http://debthin.org/debian" ;;
    ubuntu)          MIRROR="http://debthin.org/ubuntu" ;;
    *)               echo "Unknown distro: $DISTRO"; exit 1 ;;
esac

echo "=== Bootstrap dependency check: $DISTRO $SUITE $ARCH ==="
echo "Mirror: $MIRROR"
echo ""

# Use a temporary directory for debootstrap's working files
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Step 1: Get the list of packages debootstrap needs for a minimal system
echo "--- Step 1: Resolving debootstrap dependency tree ---"
NEEDED=$(debootstrap --print-debs --arch="$ARCH" "$SUITE" "$WORK" "$MIRROR" 2>/dev/null || true)

if [ -z "$NEEDED" ]; then
    echo "ERROR: debootstrap --print-debs returned nothing."
    echo "This usually means debootstrap can't reach the mirror or the suite is unknown."
    echo ""
    echo "Trying with verbose output to identify the error:"
    debootstrap --print-debs --arch="$ARCH" "$SUITE" "$WORK" "$MIRROR" 2>&1 || true
    exit 1
fi

NEEDED_SORTED=$(echo "$NEEDED" | tr ' ' '\n' | sort -u)
NEEDED_COUNT=$(echo "$NEEDED_SORTED" | wc -l | tr -d ' ')
echo "Debootstrap requires $NEEDED_COUNT packages for $DISTRO/$SUITE/$ARCH"
echo ""

# Step 2: Fetch the Packages index from debthin to see what's available
echo "--- Step 2: Checking package availability on debthin mirror ---"
PACKAGES_URL="${MIRROR}/dists/${SUITE}/main/binary-${ARCH}/Packages.gz"
AVAILABLE=$(curl -sL "$PACKAGES_URL" 2>/dev/null | gunzip 2>/dev/null | grep "^Package: " | sed 's/^Package: //' | sort -u)

if [ -z "$AVAILABLE" ]; then
    echo "WARNING: Could not fetch Packages index from $PACKAGES_URL"
    echo "The mirror may not serve $SUITE/main/binary-$ARCH"
    exit 1
fi

AVAILABLE_COUNT=$(echo "$AVAILABLE" | wc -l | tr -d ' ')
echo "Debthin mirror has $AVAILABLE_COUNT packages for $SUITE/binary-$ARCH"
echo ""

# Step 3: Find the gap
echo "--- Step 3: Missing packages ---"
MISSING=$(comm -23 <(echo "$NEEDED_SORTED") <(echo "$AVAILABLE"))

if [ -z "$MISSING" ]; then
    echo "All debootstrap packages are available on the debthin mirror."
else
    MISSING_COUNT=$(echo "$MISSING" | wc -l | tr -d ' ')
    echo "$MISSING_COUNT packages required by debootstrap are MISSING from debthin:"
    echo ""
    echo "$MISSING"
    echo ""

    # Step 4: Check which of the missing packages are in required_packages
    echo "--- Step 4: Curation status ---"

    # Build combined required_packages list
    REQUIRED=""
    if [ -f "${REPO_ROOT}/required_packages/${DISTRO}.txt" ]; then
        REQUIRED=$(cat "${REPO_ROOT}/required_packages/${DISTRO}.txt")
    fi
    if [ -f "${REPO_ROOT}/required_packages/${DISTRO}/${SUITE}.txt" ]; then
        SUITE_REQ=$(cat "${REPO_ROOT}/required_packages/${DISTRO}/${SUITE}.txt")
        REQUIRED=$(printf '%s\n%s' "$REQUIRED" "$SUITE_REQ")
    fi
    REQUIRED_SORTED=$(echo "$REQUIRED" | grep -v '^#' | grep -v '^$' | sort -u)

    NOT_CURATED=$(comm -23 <(echo "$MISSING") <(echo "$REQUIRED_SORTED"))
    CURATED_BUT_MISSING=$(comm -12 <(echo "$MISSING") <(echo "$REQUIRED_SORTED"))

    if [ -n "$CURATED_BUT_MISSING" ]; then
        echo "In required_packages but still missing from mirror (filter issue?):"
        echo "$CURATED_BUT_MISSING" | sed 's/^/  /'
        echo ""
    fi

    if [ -n "$NOT_CURATED" ]; then
        echo "NOT in required_packages (need to be added to curation):"
        echo "$NOT_CURATED" | sed 's/^/  /'
        echo ""
        echo "Add these to required_packages/${DISTRO}.txt or required_packages/${DISTRO}/${SUITE}.txt"
    fi
fi
