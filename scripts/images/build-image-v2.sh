#!/usr/bin/env bash
# build-image-v2.sh - Build debthin container images using mmdebstrap
#
# Data-driven build using build-profiles/ directory structure.
# Each suite symlinks to a profile containing:
#   rootfs/       - filesystem tree copied directly into the rootfs
#   packages.list - packages to install (one per line)
#   services.list - systemd services to enable (one per line)
#   mirror        - upstream mirror URL
#   security      - security repo line template (__SUITE__ is substituted)
#   no-security   - suites that lack a security repo (one per line)
#
# Profile resolution: ${SUITE}.${ARCH} symlink first, else ${SUITE}.
# Shared configs in build-profiles/common/rootfs/ are applied first.
#
# Usage:
#   ./build-image-v2.sh debian/trixie/amd64
#   ./build-image-v2.sh ubuntu noble arm64

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CONFIG_FILE="${REPO_ROOT}/config.json"
PROFILES_DIR="${SCRIPT_DIR}/build-profiles"
OUTPUT_BASE="${REPO_ROOT}/images_output/images"
TMP_DIR="${REPO_ROOT}/.build_tmp"

export XZ_OPT="-T1 -6"
BUILD_DATE="${BUILD_DATE:-$(date +%Y%m%d)}"

KEYRING_CACHE="${TMP_DIR}/keyrings"
mkdir -p "$KEYRING_CACHE"

# fetch_archive_keyring DISTRO
#   Downloads the latest archive keyring .deb from upstream and extracts the
#   GPG keyring files into $KEYRING_CACHE/. Cached for 7 days.
fetch_archive_keyring() {
    local distro="$1"
    local stamp="${KEYRING_CACHE}/${distro}-archive-keyring.stamp"
    local target="${KEYRING_CACHE}/${distro}-archive-keyring.gpg"

    # Re-fetch if cache is older than 7 days or missing
    if [ -f "$target" ] && [ -f "$stamp" ]; then
        local age=$(( $(date +%s) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) ))
        [ "$age" -lt 604800 ] && return 0
    fi

    echo "[KEYRING] Fetching ${distro}-archive-keyring from upstream..."
    local tmp_deb="${KEYRING_CACHE}/${distro}-archive-keyring.deb"
    local tmp_extract="${KEYRING_CACHE}/.extract-$$"

    case "$distro" in
        debian)
            wget -q -O "$tmp_deb" \
                "https://deb.debian.org/debian/pool/main/d/debian-archive-keyring/$(wget -q -O- https://deb.debian.org/debian/pool/main/d/debian-archive-keyring/ | grep -oP 'debian-archive-keyring_[0-9.]+_all\.deb' | sort -V | tail -1)" \
                || { echo "WARN: Failed to fetch debian-archive-keyring"; return 1; }
            ;;
        ubuntu)
            wget -q -O "$tmp_deb" \
                "http://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/$(wget -q -O- http://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/ | grep -oP 'ubuntu-keyring_[0-9.]+_all\.deb' | sort -V | tail -1)" \
                || { echo "WARN: Failed to fetch ubuntu-keyring"; return 1; }
            ;;
        *) return 1 ;;
    esac

    rm -rf "$tmp_extract"
    mkdir -p "$tmp_extract"
    dpkg-deb -x "$tmp_deb" "$tmp_extract"
    cp "$tmp_extract"/usr/share/keyrings/${distro}-archive-keyring.gpg "$target" 2>/dev/null || \
    cp "$tmp_extract"/usr/share/keyrings/ubuntu-archive-keyring.gpg "$target" 2>/dev/null || true
    rm -rf "$tmp_extract" "$tmp_deb"

    if [ -f "$target" ]; then
        touch "$stamp"
        echo "[KEYRING] Cached ${distro} archive keyring at $target"
    else
        echo "WARN: Could not extract ${distro} archive keyring"
        return 1
    fi
}

if [ "$#" -eq 1 ] && [[ "$1" == */*/* ]]; then
    IFS='/' read -r DISTRO SUITE ARCH <<< "$1"
elif [ "$#" -eq 3 ]; then
    DISTRO="$1"
    SUITE="$2"
    ARCH="$3"
else
    echo "Usage: $0 <distro/suite/arch> OR $0 <distro> <suite> <arch>"
    exit 1
fi

# --- Resolve profile: distro/suite.arch first, then distro/suite ---
if [ -e "${PROFILES_DIR}/${DISTRO}/${SUITE}.${ARCH}" ]; then
    PROFILE_LINK="${PROFILES_DIR}/${DISTRO}/${SUITE}.${ARCH}"
elif [ -e "${PROFILES_DIR}/${DISTRO}/${SUITE}" ]; then
    PROFILE_LINK="${PROFILES_DIR}/${DISTRO}/${SUITE}"
else
    echo "ERROR: No profile for '${DISTRO}/${SUITE}' (or ${SUITE}.${ARCH}) in ${PROFILES_DIR}/${DISTRO}/"
    exit 1
fi

PROFILE_DIR=$(readlink -f "$PROFILE_LINK")
PROFILE_NAME=$(basename "$PROFILE_DIR")
COMMON_DIR="${PROFILES_DIR}/common"

# --- Read build parameters from profile metadata ---
MIRROR=$(tr -d '\n' < "${PROFILE_DIR}/mirror")
INCLUDE_PKGS=$(grep -v '^#' "${PROFILE_DIR}/packages.list" | grep -v '^$' | paste -sd, -)

SERVICES=""
if [ -f "${PROFILE_DIR}/services.list" ]; then
    SERVICES=$(grep -v '^#' "${PROFILE_DIR}/services.list" | grep -v '^$')
fi

SECURITY_LINE=""
if [ -s "${PROFILE_DIR}/security" ]; then
    SECURITY_LINE=$(sed "s/__SUITE__/${SUITE}/g" "${PROFILE_DIR}/security" | tr -d '\n')
fi

echo "[BUILD] ${DISTRO}/${SUITE}/${ARCH} -> profile: ${PROFILE_NAME}"
echo "[BUILD] Mirror: ${MIRROR}"
echo "[BUILD] Packages: ${INCLUDE_PKGS}"

# Fetch the distro's archive keyring for security repo verification
fetch_archive_keyring "$DISTRO" || true
ARCHIVE_KEYRING="${KEYRING_CACHE}/${DISTRO}-archive-keyring.gpg"

# --- Cleanup trap ---
cleanup() {
    if [ -n "${ROOTFS_MNT:-}" ] && [ "$(uname -s)" = "Linux" ]; then
        sudo umount -l "$ROOTFS_MNT" 2>/dev/null || true
    fi
    sudo rm -rf "${ROOTFS_MNT:-}" "${WORK_DIR:-}" 2>/dev/null || true
}
trap cleanup EXIT

# --- Dependency checks ---
MISSING=0
for cmd in git jq mmdebstrap make buildah lxc-create podman; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command '$cmd' is not installed."
        MISSING=1
    fi
done

if ! ls /usr/bin/qemu-*-static >/dev/null 2>&1; then
    echo "WARNING: qemu-user-static not found (cross-arch builds will fail)"
fi

[ ! -d /usr/share/lxc/config ] && echo "ERROR: lxc-templates missing" && MISSING=1
command -v apparmor_parser >/dev/null 2>&1 || { echo "ERROR: apparmor missing"; MISSING=1; }

if [ "$MISSING" -eq 1 ]; then
    echo "  apt-get install git jq mmdebstrap make buildah qemu-user-static lxc podman lxc-templates apparmor"
    exit 1
fi

[ ! -f "$CONFIG_FILE" ] && echo "ERROR: config.json not found" && exit 1

HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
if [ "$ARCH" != "$HOST_ARCH" ] && ! ls /usr/bin/qemu-*-static >/dev/null 2>&1; then
    echo "ERROR: Cross-compiling $ARCH on $HOST_ARCH requires qemu-user-static"
    exit 1
fi

# --- Output directory & skip check ---
OUT_DIR="${OUTPUT_BASE}/${DISTRO}/${SUITE}/${ARCH}/default/${BUILD_DATE}"
if [ -f "${OUT_DIR}/hashes.txt" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "[SKIP] ${DISTRO}/${SUITE}/${ARCH} already built for ${BUILD_DATE}"
    exit 0
fi

mkdir -p "$OUT_DIR"
BUILD_LOG="${OUT_DIR}/build.log"
exec 3>&1 4>&2
exec >"$BUILD_LOG" 2>&1

WORK_DIR="${TMP_DIR}/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR" || exit 1

GPG_KEY="${REPO_ROOT}/static/debthin-keyring-binary.gpg"
COMBINED_KEYRING="${WORK_DIR}/build-keyring.gpg"
: > "$COMBINED_KEYRING"

if echo "$MIRROR" | grep -q "debthin.org"; then
    if [ ! -f "$GPG_KEY" ]; then
        echo "ERROR: debthin GPG keyring not found at $GPG_KEY"
        echo "Cannot bootstrap from debthin.org without the signing key."
        exit 1
    fi
    cat "$GPG_KEY" >> "$COMBINED_KEYRING"
    cp "$GPG_KEY" "${WORK_DIR}/debthin-keyring-binary.gpg"
elif [ -f "$GPG_KEY" ]; then
    cp "$GPG_KEY" "${WORK_DIR}/debthin-keyring-binary.gpg"
fi

# Append cached distro archive keyring so mmdebstrap can verify security repos
if [ -f "$ARCHIVE_KEYRING" ]; then
    cat "$ARCHIVE_KEYRING" >> "$COMBINED_KEYRING"
fi

KEYRING_OPT=""
[ -s "$COMBINED_KEYRING" ] && KEYRING_OPT="--keyring=${COMBINED_KEYRING}"

# --- Mount rootfs as tmpfs ---
TMPFS_SIZE="${TMPFS_SIZE:-288M}"
ROOTFS_MNT="${TMP_DIR}/rootfs_${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$ROOTFS_MNT"
if [ "$(uname -s)" = "Linux" ]; then
    sudo mount -t tmpfs -o size=${TMPFS_SIZE} tmpfs "$ROOTFS_MNT"
fi

# --- Build sources.list content ---
# Bootstrap version: no signed-by (mmdebstrap uses --keyring for authentication)
BOOTSTRAP_SOURCES="deb ${MIRROR} ${SUITE} main"
[ -n "$SECURITY_LINE" ] && BOOTSTRAP_SOURCES="${BOOTSTRAP_SOURCES}
${SECURITY_LINE}"

# Final version: signed-by scopes the debthin key to only the debthin repo
FINAL_SOURCES="deb [signed-by=/etc/apt/keyrings/debthin.gpg] ${MIRROR} ${SUITE} main"
[ -n "$SECURITY_LINE" ] && FINAL_SOURCES="${FINAL_SOURCES}
${SECURITY_LINE}"

HOST_APT="${REPO_ROOT}/.cache/apt/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$HOST_APT"

# Hook scripts — standalone scripts in build-profiles/common/ read context
# from exported environment variables.
# ==============================================================================

PROFILE_DIR="$(readlink -f "${PROFILE_DIR}")"
export COMMON_DIR PROFILE_DIR PROFILE_NAME WORK_DIR HOST_APT
export BOOTSTRAP_SOURCES FINAL_SOURCES

# Write services list to a file the customize hook can read.
SERVICES_FILE="${WORK_DIR}/services.list"
if [ -n "$SERVICES" ]; then
    echo "$SERVICES" > "$SERVICES_FILE"
else
    : > "$SERVICES_FILE"
fi
export SERVICES_FILE

# ==============================================================================
# Run mmdebstrap
# ==============================================================================

echo "[BUILD] Running mmdebstrap..."

# Use the invoking user for apt sandbox instead of _apt (which can't access
# the bind-mounted host cache). Falls back to root if SUDO_USER is unset.
APT_SANDBOX_USER="${SUDO_USER:-root}"

HOOK_SETUP="${COMMON_DIR}/hook-setup.sh"
HOOK_CUSTOMIZE="${COMMON_DIR}/hook-customize.sh"

sudo --preserve-env=COMMON_DIR,PROFILE_DIR,PROFILE_NAME,WORK_DIR,HOST_APT,BOOTSTRAP_SOURCES,FINAL_SOURCES,SERVICES_FILE \
    mmdebstrap \
    --variant=minbase \
    --arch="$ARCH" \
    --include="$INCLUDE_PKGS" \
    --aptopt="APT::Sandbox::User \"${APT_SANDBOX_USER}\"" \
    $KEYRING_OPT \
    --setup-hook="${HOOK_SETUP} \"\$1\"" \
    --customize-hook="${HOOK_CUSTOMIZE} \"\$1\"" \
    "$SUITE" "$ROOTFS_MNT" "$MIRROR"

echo "[INFO] Rootfs bootstrapped at $ROOTFS_MNT"

sudo chroot "$ROOTFS_MNT" dpkg-query -W -f '${Package}\n' 2>/dev/null | sort > "${OUT_DIR}/bootstrap-packages.txt" || true
echo "[INFO] Package manifest: ${OUT_DIR}/bootstrap-packages.txt ($(wc -l < "${OUT_DIR}/bootstrap-packages.txt") packages)"

# ==============================================================================
# Packing - generate minimal YAML for distrobuilder pack-lxc/pack-incus
# ==============================================================================

# Determine LXC config template name (debian or ubuntu)
case "$DISTRO" in
    debian|raspbian) LXC_DISTRO="debian" ;;
    ubuntu)          LXC_DISTRO="ubuntu" ;;
    *)               LXC_DISTRO="common" ;;
esac

YAML_RUN="${WORK_DIR}/pack.yaml"
cat > "$YAML_RUN" <<YAMLEOF
image:
  distribution: "${DISTRO}"
  release: "${SUITE}"
  architecture: "${ARCH}"
  description: "${DISTRO} ${SUITE} (debthin.org minimal)"

source:
  downloader: debootstrap
  url: "${MIRROR}"

packages:
  manager: apt

targets:
  lxc:
    config:
      - type: all
        content: |-
          lxc.include = LXC_TEMPLATE_CONFIG/${LXC_DISTRO}.common.conf
          lxc.arch = ${ARCH}
      - type: user
        content: |-
          lxc.include = LXC_TEMPLATE_CONFIG/${LXC_DISTRO}.userns.conf
YAMLEOF

sudo distrobuilder pack-lxc   "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"
sudo distrobuilder pack-incus "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"

if command -v buildah >/dev/null 2>&1; then
    mkdir -p "${OUT_DIR}/oci"
    sudo bash -c '
        set -e
        CTR=$(buildah from scratch)
        buildah copy "$CTR" "'"$ROOTFS_MNT"'" /
        buildah config --os linux --arch "'"$ARCH"'" \
            --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$CTR"
        buildah commit --disable-compression=false --format oci "$CTR" "oci:'"${OUT_DIR}"'/oci" > /dev/null
        buildah rm "$CTR" > /dev/null
    '
fi

# --- Teardown ---
if [ "$(uname -s)" = "Linux" ]; then
    sudo umount -l "$ROOTFS_MNT" 2>/dev/null || true
fi
sudo rm -rf "$ROOTFS_MNT" 2>/dev/null || true
sudo chown -R "$(id -u):$(id -g)" "$OUT_DIR"

# Restore stdout/stderr for final summary
exec 1>&3 2>&4 3>&- 4>&-

echo "Calculating SHA256 hashes..."
cd "$OUT_DIR" || exit 1
SHA_CMD="sha256sum"
command -v sha256sum >/dev/null 2>&1 || SHA_CMD="shasum -a 256"
find . -type f ! -name "hashes.txt" | sort | xargs $SHA_CMD > hashes.txt

echo "[TEST] Running container validation for ${DISTRO}/${SUITE} (${ARCH})..."
sudo "${SCRIPT_DIR}/test-image.sh" "${DISTRO}/${SUITE}" "${ARCH}" 2>&1 | tee -a build.log
TEST_RC=${PIPESTATUS[0]}

if [ $TEST_RC -eq 0 ]; then
    echo "[DONE] ${DISTRO}/${SUITE}/${ARCH} -> $OUT_DIR"
else
    echo "[FAIL] ${DISTRO}/${SUITE}/${ARCH} — see ${BUILD_LOG}"
    exit $TEST_RC
fi
