#!/usr/bin/env bash
# test-image.sh - Automated validation for debthin LXC container builds
#
# Two test modes:
#   STATIC  - Extracts rootfs.tar.xz to a temp dir and inspects file contents.
#             Runs for ALL architectures (no container boot required).
#   RUNTIME - Boots the container via lxc-start and tests networking, DNS,
#             apt-get update, and running services.
#             Runs for NATIVE architecture only.
#
# Writes results to test-results.log in the build output directory.
# Exits non-zero on any failure.

if [ "$1" == "" ]; then
    echo "Usage: $0 <distro/suite> [arch]"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RELEASE="$1"
DISTRO=$(echo "$RELEASE" | cut -d'/' -f1)
SUITE=$(echo "$RELEASE" | cut -d'/' -f2)
SAFE_RELEASE=$(echo "$RELEASE" | tr '/' '-')

# Default to native architecture if second argument is omitted
if [ -z "$2" ]; then
    ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
else
    ARCH="$2"
fi

HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
IS_NATIVE=0
[ "$ARCH" = "$HOST_ARCH" ] && IS_NATIVE=1

# Set limits based on distribution
if [ "$DISTRO" == "ubuntu" ]; then
    MAX_EXTRACTED_MB=300
    MAX_ARCHIVE_MB=50
    if [ "$ARCH" = "arm64" ]; then
        SECURITY_URL="ports.ubuntu.com"
    else
        SECURITY_URL="security.ubuntu.com"
    fi
else
    MAX_EXTRACTED_MB=175
    MAX_ARCHIVE_MB=35
    SECURITY_URL="deb.debian.org/debian-security"
fi

# Check if this suite has a security repo by looking at the build profile
PROFILES_DIR="${SCRIPTS}/build-profiles"
if [ -e "${PROFILES_DIR}/${SUITE}.${ARCH}" ]; then
    _PROFILE=$(readlink -f "${PROFILES_DIR}/${SUITE}.${ARCH}")
elif [ -e "${PROFILES_DIR}/${SUITE}" ]; then
    _PROFILE=$(readlink -f "${PROFILES_DIR}/${SUITE}")
else
    _PROFILE=""
fi

HAS_SECURITY=0
if [ -n "$_PROFILE" ] && [ -s "${_PROFILE}/security" ]; then
    HAS_SECURITY=1
fi

MAX_INSTALLED_PKGS=250
MAX_AVAILABLE_PKGS=15000

OUTPUT_BASE="${REPO_ROOT}/images_output/images"
DIR="$OUTPUT_BASE/$RELEASE/$ARCH/default"

# --- Test Framework Utilities ---
FAILURES=0

log_pass() { echo -e "\e[32m[PASS]\e[0m $1"; }
log_fail() { echo -e "\e[31m[FAIL]\e[0m $1"; FAILURES=$((FAILURES + 1)); }
log_info() { echo -e "\e[34m[INFO]\e[0m $1"; }

# --- Find Build Artifacts & Determine Version ---
VERSION=$(ls -1t "$DIR" 2>/dev/null | head -1)
if [ -z "$VERSION" ]; then
    log_fail "No version found in $DIR"
    exit 1
fi

# Tee all subsequent output to a log file (strip ANSI codes for the file copy)
LOG_FILE="$DIR/$VERSION/test-results.log"
exec > >(tee >(sed 's/\x1b\[[0-9;]*m//g' > "$LOG_FILE")) 2>&1

ROOTFS_PATH="$DIR/$VERSION/rootfs.tar.xz"
META_PATH="$DIR/$VERSION/meta.tar.xz"

# Set the deterministic container name (used by runtime tests)
NAME="debthin-${SAFE_RELEASE}-${VERSION}-${ARCH}"

# Temp dir for static rootfs extraction
STATIC_ROOT=""

cleanup() {
    # Tear down runtime container if it was started
    if [ "$IS_NATIVE" = "1" ]; then
        log_info "Tearing down test container $NAME..."
        lxc-stop "$NAME" 2>/dev/null || true
        lxc-destroy "$NAME" 2>/dev/null || true
    fi

    # Clean up static extraction
    if [ -n "$STATIC_ROOT" ] && [ -d "$STATIC_ROOT" ]; then
        rm -rf "$STATIC_ROOT"
    fi

    if [ $FAILURES -gt 0 ]; then
        echo -e "\n\e[31m❌ Container validation FAILED with $FAILURES error(s).\e[0m"
        exit 1
    else
        echo -e "\n\e[32m✅ Container validation PASSED.\e[0m"
        exit 0
    fi
}

trap cleanup EXIT

log_info "Testing build: $RELEASE ($ARCH) - $VERSION"
if [ "$IS_NATIVE" = "1" ]; then
    log_info "Mode: STATIC + RUNTIME (native arch)"
else
    log_info "Mode: STATIC only (cross-arch, no container boot)"
fi

# ==============================================================================
# STATIC TESTS - run for all architectures
# Inspect the rootfs.tar.xz contents without booting a container
# ==============================================================================

# S1. Artifact Integrity & Archive Size
if [ -f "$ROOTFS_PATH" ] && [ -f "$META_PATH" ]; then
    log_pass "Build artifacts exist"
    ARCHIVE_SIZE_MB=$(du -sm "$ROOTFS_PATH" | cut -f1)
    if [ -n "$ARCHIVE_SIZE_MB" ] && [ "$ARCHIVE_SIZE_MB" -le "$MAX_ARCHIVE_MB" ]; then
        log_pass "Compressed archive size is within limits (${ARCHIVE_SIZE_MB}MB <= ${MAX_ARCHIVE_MB}MB)"
    else
        log_fail "Compressed archive size exceeded limit (Got: ${ARCHIVE_SIZE_MB}MB, Limit: ${MAX_ARCHIVE_MB}MB)"
    fi
else
    log_fail "Build artifacts missing at $DIR/$VERSION"
    exit 1
fi

# Extract only the files we need for static inspection
STATIC_ROOT=$(mktemp -d "/tmp/debthin-test-${SAFE_RELEASE}-XXXXXX")
log_info "Extracting select files from rootfs..."

# Files to extract for content inspection
# Use --wildcards with both ./path and path to handle either tar prefix style
EXTRACT_PATTERNS=(
    --wildcards
    '*/etc/apt/keyrings/debthin.gpg'
    '*/etc/apt/sources.list'
    '*/etc/apt/apt.conf.d/99thin'
    '*/etc/systemd/journald.conf.d/00-container-limits.conf'
    '*/etc/systemd/system/thin-resolv.path'
    '*/etc/systemd/system/thin-resolv.service'
    '*/var/lib/dpkg/status'
)
# Extract with --strip-components=1 to normalise ./ prefix away
tar xf "$ROOTFS_PATH" -C "$STATIC_ROOT" --strip-components=1 "${EXTRACT_PATTERNS[@]}" 2>/dev/null || true

# S2. Extracted Disk Footprint (from archive listing, no full extraction needed)
# Use xz --list to get uncompressed size without extracting
UNCOMPRESSED_BYTES=$(xz --list --robot "$ROOTFS_PATH" 2>/dev/null | awk '/^totals/{print $5}')
if [ -n "$UNCOMPRESSED_BYTES" ]; then
    SIZE_MB=$((UNCOMPRESSED_BYTES / 1048576))
    if [ "$SIZE_MB" -le "$MAX_EXTRACTED_MB" ]; then
        log_pass "Uncompressed rootfs is within limits (${SIZE_MB}MB <= ${MAX_EXTRACTED_MB}MB)"
    else
        log_fail "Uncompressed rootfs exceeded limit (Got: ${SIZE_MB}MB, Limit: ${MAX_EXTRACTED_MB}MB)"
    fi
else
    log_fail "Could not determine uncompressed rootfs size"
fi

# S3. GPG Key Integrity
if [ -s "$STATIC_ROOT/etc/apt/keyrings/debthin.gpg" ]; then
    log_pass "Debthin GPG keyring present and non-empty"
else
    log_fail "Debthin GPG keyring missing or empty"
fi

# S4. APT Sources Validation
SOURCES_OUT=$(cat "$STATIC_ROOT/etc/apt/sources.list" 2>/dev/null)
if echo "$SOURCES_OUT" | grep -q "debthin.org"; then
    log_pass "sources.list contains debthin.org repository"
else
    log_fail "sources.list does not contain debthin.org"
fi

if [ "$HAS_SECURITY" -eq 1 ]; then
    if echo "$SOURCES_OUT" | grep -q "$SECURITY_URL"; then
        log_pass "sources.list contains direct security upstream ($SECURITY_URL)"
    else
        log_fail "sources.list missing direct security upstream ($SECURITY_URL)"
    fi
else
    log_info "Skipping security repo check (not available for $SUITE)"
fi

# S5. APT Configuration (all debthin optimizations live in 99thin)
APT_CONF_FILE="$STATIC_ROOT/etc/apt/apt.conf.d/99thin"
if [ -f "$APT_CONF_FILE" ]; then
    if grep -q 'GzipIndexes.*"true"' "$APT_CONF_FILE"; then
        log_pass "APT configured to retain GzipIndexes"
    else
        log_fail "99thin missing GzipIndexes directive"
    fi

    if grep -q 'Languages.*"none"' "$APT_CONF_FILE"; then
        log_pass "APT configured to strip translation files (Languages none)"
    else
        log_fail "99thin missing Languages none directive"
    fi
else
    log_fail "APT configuration file 99thin missing"
fi

# S6. Init System (check via archive listing)
if tar tf "$ROOTFS_PATH" 2>/dev/null | grep -qE '(^|/)sbin/init$'; then
    log_pass "/sbin/init exists in rootfs (systemd-sysv installed)"
else
    log_fail "/sbin/init missing from rootfs"
fi

# S7. Documentation Stripping (count via archive listing)
DOC_COUNT=$(tar tf "$ROOTFS_PATH" 2>/dev/null | grep -E '(^|\./?)usr/share/doc/' | grep -v '/$' | grep -v 'copyright' | wc -l)
if [ "$DOC_COUNT" -le 5 ]; then
    log_pass "/usr/share/doc stripped ($DOC_COUNT non-copyright files remain)"
else
    log_fail "/usr/share/doc not stripped ($DOC_COUNT non-copyright files)"
fi

MAN_COUNT=$(tar tf "$ROOTFS_PATH" 2>/dev/null | grep -E '(^|\./?)usr/share/man/' | grep -v '/$' | wc -l)
if [ "$MAN_COUNT" -eq 0 ]; then
    log_pass "/usr/share/man is empty"
else
    log_fail "/usr/share/man not stripped ($MAN_COUNT files remain)"
fi

# S8. No Stale APT Cache
DEB_COUNT=$(tar tf "$ROOTFS_PATH" 2>/dev/null | grep '\.deb$' | wc -l)
if [ "$DEB_COUNT" -eq 0 ]; then
    log_pass "No stale .deb files in apt cache"
else
    log_fail "$DEB_COUNT stale .deb files in rootfs"
fi

# S9. Journald Limits
JOURNALD_CONF="$STATIC_ROOT/etc/systemd/journald.conf.d/00-container-limits.conf"
if [ -f "$JOURNALD_CONF" ] && grep -q 'SystemMaxUse=50M' "$JOURNALD_CONF"; then
    log_pass "Journald SystemMaxUse=50M configured"
else
    log_fail "Journald limits config missing or incorrect"
fi

# S10. Systemd Unit Files (skip for bullseye which uses ifupdown)
if [ "$SUITE" != "bullseye" ]; then
    if [ -f "$STATIC_ROOT/etc/systemd/system/thin-resolv.path" ]; then
        log_pass "thin-resolv.path unit file present"
    else
        log_fail "thin-resolv.path unit file missing"
    fi

    if [ -f "$STATIC_ROOT/etc/systemd/system/thin-resolv.service" ]; then
        log_pass "thin-resolv.service unit file present"
    else
        log_fail "thin-resolv.service unit file missing"
    fi
else
    log_info "Skipping thin-resolv checks (bullseye uses ifupdown)"
fi

# S11. Package Count (from dpkg status in rootfs)
INSTALLED_PKGS=$(grep -c '^Package:' "$STATIC_ROOT/var/lib/dpkg/status" 2>/dev/null || echo 0)
if [ "$INSTALLED_PKGS" -le "$MAX_INSTALLED_PKGS" ]; then
    log_pass "Installed packages count is minimal ($INSTALLED_PKGS <= $MAX_INSTALLED_PKGS)"
else
    log_fail "Too many installed packages ($INSTALLED_PKGS > $MAX_INSTALLED_PKGS)"
fi

# ==============================================================================
# RUNTIME TESTS - native architecture only
# Boot the container and test networking, DNS, APT, and running services
# ==============================================================================

if [ "$IS_NATIVE" = "0" ]; then
    log_info "Skipping runtime tests (cross-arch build)"
    exit 0
fi

log_info "--- Runtime tests ---"

# R1. Container Creation & Boot
if lxc-create -q -t local -n "$NAME" -- -m "$META_PATH" -f "$ROOTFS_PATH" >/dev/null 2>&1 && lxc-start "$NAME"; then
    log_pass "Container successfully created and started"
else
    log_fail "Container failed to initialize or boot"
    exit 1
fi

# R2. DHCP & Network Routing
TIMEOUT=30
ELAPSED=0
NETWORK_UP=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    if lxc-attach "$NAME" -- ip route show default 2>/dev/null | grep -q "default via"; then
        NETWORK_UP=1
        break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if [ $NETWORK_UP -eq 1 ]; then
    log_pass "Network acquired DHCP lease & default route in ${ELAPSED}s"
else
    log_fail "Network failed to acquire route within ${TIMEOUT}s"
fi

# R3. DNS Resolution (getent is always available, ping requires iputils-ping)
if lxc-attach "$NAME" -- getent hosts debthin.org >/dev/null 2>&1; then
    log_pass "DNS resolution functional"
else
    log_fail "DNS resolution failed (getent hosts debthin.org)"
fi

# R4. APT Update Execution
APT_LOG="/tmp/${NAME}_apt.log"
if lxc-attach "$NAME" -- apt-get update > "$APT_LOG" 2>&1; then
    log_pass "apt-get update completed successfully"
else
    log_fail "apt-get update failed"
    cat "$APT_LOG"
fi
rm -f "$APT_LOG"

# R5. PID 1 is systemd
PID1_COMM=$(lxc-attach "$NAME" -- cat /proc/1/comm 2>/dev/null)
if [ "$PID1_COMM" = "systemd" ]; then
    log_pass "PID 1 is systemd"
else
    log_fail "PID 1 is '$PID1_COMM', expected 'systemd'"
fi

# R6. Package Integrity
AUDIT_OUT=$(lxc-attach "$NAME" -- dpkg --audit 2>&1)
if [ -z "$AUDIT_OUT" ]; then
    log_pass "dpkg --audit clean (no broken/half-configured packages)"
else
    log_fail "dpkg --audit found issues: $AUDIT_OUT"
fi

# R7. Systemd Services Running (skip for bullseye)
if [ "$SUITE" != "bullseye" ]; then
    if lxc-attach "$NAME" -- systemctl is-enabled systemd-networkd.service >/dev/null 2>&1; then
        log_pass "systemd-networkd.service enabled"
    else
        log_fail "systemd-networkd.service not enabled"
    fi
fi

# R8. No systemd-resolved Running
if lxc-attach "$NAME" -- systemctl is-active systemd-resolved.service >/dev/null 2>&1; then
    log_fail "systemd-resolved is running (should not be in minimal containers)"
else
    log_pass "systemd-resolved is not running"
fi

# Extract installed package list for reference
PKG_LIST="$DIR/$VERSION/installed-packages.txt"
lxc-attach "$NAME" -- dpkg-query -W -f '${Package}\t${Version}\n' 2>/dev/null | sort > "$PKG_LIST"
log_info "Package list written to $PKG_LIST ($(wc -l < "$PKG_LIST") packages)"