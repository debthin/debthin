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
TEMPLATE_DIR="${REPO_ROOT}/yaml-templates"
PROFILES_DIR="${SCRIPT_DIR}/build-profiles"
OUTPUT_BASE="${REPO_ROOT}/images_output/images"
TMP_DIR="${REPO_ROOT}/.build_tmp"

export XZ_OPT="-T1 -6"
BUILD_DATE="${BUILD_DATE:-$(date +%Y%m%d)}"

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

# --- Resolve profile: arch-specific first, then default ---
if [ -e "${PROFILES_DIR}/${SUITE}.${ARCH}" ]; then
    PROFILE_LINK="${PROFILES_DIR}/${SUITE}.${ARCH}"
elif [ -e "${PROFILES_DIR}/${SUITE}" ]; then
    PROFILE_LINK="${PROFILES_DIR}/${SUITE}"
else
    echo "ERROR: No profile for '${SUITE}' (or ${SUITE}.${ARCH}) in ${PROFILES_DIR}"
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
exec > >(tee "${OUT_DIR}/build.log") 2>&1

WORK_DIR="${TMP_DIR}/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR" || exit 1

[ -f "${REPO_ROOT}/static/debthin-keyring-binary.gpg" ] && \
    cp "${REPO_ROOT}/static/debthin-keyring-binary.gpg" "${WORK_DIR}/debthin-keyring-binary.gpg"

# --- Mount rootfs as tmpfs ---
TMPFS_SIZE="${TMPFS_SIZE:-768M}"
ROOTFS_MNT="${TMP_DIR}/rootfs_${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$ROOTFS_MNT"
if [ "$(uname -s)" = "Linux" ]; then
    sudo mount -t tmpfs -o size=${TMPFS_SIZE} tmpfs "$ROOTFS_MNT"
fi

# --- Build sources.list ---
SOURCES_CONTENT="deb [signed-by=/etc/apt/keyrings/debthin.gpg] ${MIRROR} ${SUITE} main"
[ -n "$SECURITY_LINE" ] && SOURCES_CONTENT="${SOURCES_CONTENT}
${SECURITY_LINE}"

KEYRING_OPT=""
[ -f "${WORK_DIR}/debthin-keyring-binary.gpg" ] && \
    KEYRING_OPT="--keyring=${WORK_DIR}/debthin-keyring-binary.gpg"

HOST_APT="${REPO_ROOT}/.cache/apt/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$HOST_APT"

# ==============================================================================
# Hook scripts
# ==============================================================================

# Setup hook: inject common + profile rootfs trees BEFORE package installation.
# The rootfs/ subtree mirrors the target filesystem, so cp -a does the right thing.
cat > "${WORK_DIR}/hook-setup.sh" <<SETUP_EOF
#!/bin/sh
set -e
ROOTFS="\$1"

echo ">>> [setup] Applying common rootfs overlay"
cp -a "${COMMON_DIR}/rootfs/." "\$ROOTFS/"

echo ">>> [setup] Applying ${PROFILE_NAME} rootfs overlay"
if [ -d "$(readlink -f "${PROFILE_DIR}/rootfs")" ]; then
    cp -a "$(readlink -f "${PROFILE_DIR}/rootfs")/." "\$ROOTFS/"
fi

echo ">>> [setup] Injecting GPG keyring"
mkdir -p "\$ROOTFS/etc/apt/keyrings"
cp "${WORK_DIR}/debthin-keyring-binary.gpg" "\$ROOTFS/etc/apt/keyrings/debthin.gpg"

echo ">>> [setup] Writing sources.list"
cat > "\$ROOTFS/etc/apt/sources.list" <<'SRCEOF'
${SOURCES_CONTENT}
SRCEOF
SETUP_EOF

# Customize hook: clean up, remove udev, enable services.
cat > "${WORK_DIR}/hook-customize.sh" <<CUSTOM_EOF
#!/bin/sh
set -e
ROOTFS="\$1"

echo ">>> [customize] Cleaning docs, man pages, locale data"
rm -rf "\$ROOTFS/usr/share/doc/"* "\$ROOTFS/usr/share/man/"* "\$ROOTFS/usr/share/locale/"*
rm -rf "\$ROOTFS/usr/lib/udev/hwdb.d/"* "\$ROOTFS/usr/lib/systemd/hwdb/"*
rm -f "\$ROOTFS/usr/lib/udev/hwdb.bin" "\$ROOTFS/etc/udev/hwdb.bin"
rm -f "\$ROOTFS/var/cache/apt/"*.bin

echo ">>> [customize] Removing udev"
chroot "\$ROOTFS" dpkg --remove --force-depends udev 2>/dev/null || true
CUSTOM_EOF

# Enable services listed in the profile
if [ -n "$SERVICES" ]; then
    cat >> "${WORK_DIR}/hook-customize.sh" <<'DIVIDER'

echo ">>> [customize] Enabling services"
DIVIDER
    echo "$SERVICES" | while read -r svc; do
        [ -z "$svc" ] && continue
        cat >> "${WORK_DIR}/hook-customize.sh" <<CUSTOM_EOF
chroot "\$ROOTFS" systemctl enable ${svc}
CUSTOM_EOF
    done
fi

cat >> "${WORK_DIR}/hook-customize.sh" <<'CUSTOM_EOF'

echo ">>> [customize] Final apt cleanup"
rm -rf "$ROOTFS/var/lib/apt/lists/"*
rm -f "$ROOTFS/var/cache/apt/archives/"*.deb
CUSTOM_EOF

chmod +x "${WORK_DIR}/hook-setup.sh" "${WORK_DIR}/hook-customize.sh"

# ==============================================================================
# Run mmdebstrap
# ==============================================================================

echo "[BUILD] Running mmdebstrap..."

sudo mmdebstrap \
    --variant=minbase \
    --arch="$ARCH" \
    --include="$INCLUDE_PKGS" \
    $KEYRING_OPT \
    --aptopt="Dir::Cache::archives \"${HOST_APT}\"" \
    --setup-hook="${WORK_DIR}/hook-setup.sh \"\$1\"" \
    --customize-hook="${WORK_DIR}/hook-customize.sh \"\$1\"" \
    "$SUITE" "$ROOTFS_MNT" "$MIRROR"

echo "[INFO] Rootfs bootstrapped at $ROOTFS_MNT"

sudo chroot "$ROOTFS_MNT" dpkg-query -W -f '${Package}\n' 2>/dev/null | sort > "${OUT_DIR}/bootstrap-packages.txt" || true
echo "[INFO] Package manifest: ${OUT_DIR}/bootstrap-packages.txt ($(wc -l < "${OUT_DIR}/bootstrap-packages.txt") packages)"

# ==============================================================================
# Packing
# ==============================================================================

YAML_SRC="${TEMPLATE_DIR}/${DISTRO}/${SUITE}.yaml"
YAML_RUN="${WORK_DIR}/current_build.yaml"

sed "s/architecture: .*/architecture: \"${ARCH}\"/" "$YAML_SRC" | \
sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" > "$YAML_RUN"

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

echo "Calculating SHA256 hashes..."
cd "$OUT_DIR" || exit 1
SHA_CMD="sha256sum"
command -v sha256sum >/dev/null 2>&1 || SHA_CMD="shasum -a 256"
find . -type f ! -name "hashes.txt" | sort | xargs $SHA_CMD > hashes.txt

echo "[TEST] Running container validation for ${DISTRO}/${SUITE} (${ARCH})..."
sudo "${SCRIPT_DIR}/test-image.sh" "${DISTRO}/${SUITE}" "${ARCH}"

echo "[DONE] Artefacts saved to: $OUT_DIR"
