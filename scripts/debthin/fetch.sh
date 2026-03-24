#!/usr/bin/env bash
# fetch.sh - Fetch a single Packages.gz or InRelease from upstream.
#
# Usage:
#   bash fetch.sh packages <distro> <upstream> <suite> <component> <arch>
#   bash fetch.sh inrelease <distro> <upstream> <suite>
#
# Downloads into .tmp_cache/<distro>/<suite>/... using IMS headers
# to skip re-download when the local copy is still current.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

MODE="$1"
shift

case "$MODE" in
    packages)
        DISTRO="$1" UPSTREAM="$2" SUITE="$3" COMP="$4" ARCH="$5"
        CACHEDIR=".tmp_cache/$DISTRO/$SUITE/$COMP/binary-$ARCH"
        CACHEFILE="$CACHEDIR/Packages.gz"

        echo "  Fetch: $DISTRO/$SUITE/$COMP/binary-$ARCH" >&2
        mkdir -p "$CACHEDIR"

        if curl -sf --retry 3 --retry-delay 5 -z "$CACHEFILE" -o "$CACHEFILE" \
            "$UPSTREAM/dists/$SUITE/$COMP/binary-$ARCH/Packages.gz" 2>/dev/null; then
            :
        elif [[ ! -s "$CACHEFILE" ]]; then
            if curl -sf --retry 3 --retry-delay 5 -o "${CACHEFILE}.xz" \
                "$UPSTREAM/dists/$SUITE/$COMP/binary-$ARCH/Packages.xz" 2>/dev/null; then
                xzcat "${CACHEFILE}.xz" | gzip -1 > "$CACHEFILE" && rm -f "${CACHEFILE}.xz"
            else
                echo "WARNING: $DISTRO/$SUITE/$COMP/$ARCH not available" >&2
            fi
        fi
        ;;

    inrelease)
        DISTRO="$1" UPSTREAM="$2" SUITE="$3"
        CACHEFILE=".tmp_cache/$DISTRO/$SUITE/InRelease"

        echo "  Fetch: $DISTRO/$SUITE/InRelease" >&2
        mkdir -p ".tmp_cache/$DISTRO/$SUITE"
        curl -sf --retry 3 -z "$CACHEFILE" -o "$CACHEFILE" \
            "$UPSTREAM/dists/$SUITE/InRelease" 2>/dev/null || true
        ;;

    *)
        echo "Usage: $0 {packages|inrelease} ..." >&2
        exit 1
        ;;
esac
