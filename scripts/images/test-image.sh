#!/usr/bin/env bash
# test-container.sh - Automated unit tests for debthin LXC builds

if [ "$1" == "" ]; then
    echo "Usage: $0 <distro/suite> [arch]"
    exit 1
fi

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

# Set limits based on distribution
if [ "$DISTRO" == "ubuntu" ]; then
    MAX_EXTRACTED_MB=300
    MAX_ARCHIVE_MB=50
    SECURITY_URL="security.ubuntu.com"
else
    MAX_EXTRACTED_MB=150
    MAX_ARCHIVE_MB=35
    SECURITY_URL="deb.debian.org/debian-security"
fi

# Releases without a security repo yet
case "$SUITE" in
    plucky|questing) HAS_SECURITY=0 ;;
    *)               HAS_SECURITY=1 ;;
esac

MAX_INSTALLED_PKGS=250
MAX_AVAILABLE_PKGS=15000

BASEDIR="/home/remco/build/debthin/images_output/images"
DIR="$BASEDIR/$RELEASE/$ARCH/default"

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

# Set the deterministic container name requested
NAME="debthin-${SAFE_RELEASE}-${VERSION}-${ARCH}"

cleanup() {
    log_info "Tearing down test container $NAME..."
    lxc-stop "$NAME" 2>/dev/null || true
    lxc-destroy "$NAME" 2>/dev/null || true
    
    if [ $FAILURES -gt 0 ]; then
        echo -e "\n\e[31m❌ Container validation FAILED with $FAILURES error(s).\e[0m"
        exit 1
    else
        echo -e "\n\e[32m✅ Container validation PASSED.\e[0m"
        exit 0
    fi
}

trap cleanup EXIT

ROOTFS_PATH="$DIR/$VERSION/rootfs.tar.xz"
META_PATH="$DIR/$VERSION/meta.tar.xz"

log_info "Testing build: $RELEASE ($ARCH) - $VERSION"
log_info "Container Name: $NAME"

# ==============================================================================
# TEST SUITE
# ==============================================================================

# 1. Artifact Integrity & Archive Size
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

# 2. Container Creation & Boot
if lxc-create -q -t local -n "$NAME" -- -m "$META_PATH" -f "$ROOTFS_PATH" >/dev/null 2>&1 && lxc-start "$NAME"; then
    log_pass "Container successfully created and started"
else
    log_fail "Container failed to initialize or boot"
    exit 1
fi

# 3. DHCP & Network Routing
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

# 4. Disk Footprint Verification (Extracted)
SIZE_MB=$(lxc-attach "$NAME" -- du -sm / 2>/dev/null | cut -f1)
if [ -n "$SIZE_MB" ] && [ "$SIZE_MB" -le "$MAX_EXTRACTED_MB" ]; then
    log_pass "Extracted disk footprint is within limits (${SIZE_MB}MB <= ${MAX_EXTRACTED_MB}MB)"
else
    log_fail "Extracted disk footprint exceeded limit (Got: ${SIZE_MB}MB, Limit: ${MAX_EXTRACTED_MB}MB)"
fi

# 5. External DNS & Connectivity
if lxc-attach "$NAME" -- ping -c 1 -W 5 debthin.org >/dev/null 2>&1; then
    log_pass "DNS resolution and external ICMP connectivity functional"
else
    log_fail "DNS resolution or external connectivity failed"
fi

# 6. APT Sources & Configuration Validation
SOURCES_OUT=$(lxc-attach "$NAME" -- cat /etc/apt/sources.list 2>/dev/null)
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

APT_CONF=$(lxc-attach "$NAME" -- apt-config dump 2>/dev/null)

# Relaxed grep to catch Acquire::GzipIndexes:: "true" or Acquire::GzipIndexes "true"
if echo "$APT_CONF" | grep -q 'Acquire::GzipIndexes.*"true"'; then
    log_pass "APT configured to retain GzipIndexes"
else
    log_fail "APT configuration missing GzipIndexes directive"
fi

# Relaxed grep to catch Acquire::Languages:: "none" or Acquire::Languages "none"
if echo "$APT_CONF" | grep -q 'Acquire::Languages.*"none"'; then
    log_pass "APT configured to strip translation files (Languages none)"
else
    log_fail "APT configuration missing Languages none directive"
fi

# 7. APT Update Execution
APT_LOG="/tmp/${NAME}_apt.log"
if lxc-attach "$NAME" -- apt-get update > "$APT_LOG" 2>&1; then
    log_pass "apt-get update completed successfully"
else
    log_fail "apt-get update failed"
    cat "$APT_LOG"
fi
rm -f "$APT_LOG"

# 8. Packages Configuration (The Debthin Test)
INSTALLED_PKGS=$(lxc-attach "$NAME" -- dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | wc -l)
if [ "$INSTALLED_PKGS" -le "$MAX_INSTALLED_PKGS" ]; then
    log_pass "Installed packages count is minimal ($INSTALLED_PKGS <= $MAX_INSTALLED_PKGS)"
else
    log_fail "Too many installed packages ($INSTALLED_PKGS > $MAX_INSTALLED_PKGS)"
fi

AVAILABLE_PKGS=$(lxc-attach "$NAME" -- apt-cache pkgnames 2>/dev/null | wc -l)
if [ "$AVAILABLE_PKGS" -le "$MAX_AVAILABLE_PKGS" ]; then
    log_pass "APT cache footprint verified: Index is truncated ($AVAILABLE_PKGS available pkgs)"
else
    log_fail "APT cache footprint too large! Debthin curation failed ($AVAILABLE_PKGS > $MAX_AVAILABLE_PKGS available pkgs)"
fi