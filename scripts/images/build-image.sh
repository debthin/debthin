#!/usr/bin/env bash
set -e

# PATH RESOLUTION & SETUP
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CONFIG_FILE="${REPO_ROOT}/config.json"
TEMPLATE_DIR="${REPO_ROOT}/yaml-templates"
OUTPUT_BASE="${REPO_ROOT}/images_output/images"
TMP_DIR="${REPO_ROOT}/.build_tmp"

# Force all xz operations to use exactly 1 thread and compression level 6
export XZ_OPT="-T1 -6"

# Inherit BUILD_DATE from Make or generate a standalone timestamp
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

# Native trap guaranteeing orphaned tmpfs mounts gracefully abort on unexpected failures
cleanup() {
    if [ -n "${ROOTFS_MNT:-}" ]; then
        if [ "$(uname -s)" = "Linux" ]; then
            sudo umount -l "$ROOTFS_MNT" 2>/dev/null || true
        fi
        sudo rm -rf "$ROOTFS_MNT" 2>/dev/null || true
    fi
    if [ -n "${WORK_DIR:-}" ]; then
        sudo rm -rf "$WORK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Ensure dependencies exist
for cmd in distrobuilder curl buildah debootstrap; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command '$cmd' is not installed."
        exit 1
    fi
done

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: config.json not found at $CONFIG_FILE"
    exit 1
fi

YAML_SRC="${TEMPLATE_DIR}/${DISTRO}/${SUITE}.yaml"

mkdir -p "$TMP_DIR"
cd "$REPO_ROOT" || exit 1

# Create working directory for this build
WORK_DIR="${TMP_DIR}/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$WORK_DIR"

echo "[BUILD] Constructing $DISTRO $SUITE for $ARCH..."

# Check for cross-compilation dependencies
HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
if [ "$ARCH" != "$HOST_ARCH" ]; then
    if ! ls /usr/bin/qemu-*-static >/dev/null 2>&1; then
        echo "ERROR: Cross-compiling $ARCH on $HOST_ARCH requires QEMU user emulation."
        echo "Please run: sudo apt install qemu-user-static binfmt-support"
        exit 1
    fi
fi

OUT_DIR="${OUTPUT_BASE}/${DISTRO}/${SUITE}/${ARCH}/default/${BUILD_DATE}"

# Skip if this date's build already exists (hashes.txt marks a completed build)
if [ -f "${OUT_DIR}/hashes.txt" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "[SKIP] ${DISTRO}/${SUITE}/${ARCH} already built for ${BUILD_DATE} (use FORCE=1 to rebuild)"
    exit 0
fi

mkdir -p "$OUT_DIR"

YAML_RUN="${WORK_DIR}/current_build.yaml"

if [ -f "${REPO_ROOT}/static/debthin-keyring-binary.gpg" ]; then
    cp "${REPO_ROOT}/static/debthin-keyring-binary.gpg" "${WORK_DIR}/debthin-keyring-binary.gpg"
fi

# Resolve and secure explicit host package caching paths
HOST_APT="${REPO_ROOT}/.cache/apt/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$HOST_APT"

# Process YAML template: set architecture for the target build
sed "s/architecture: .*/architecture: \"${ARCH}\"/" "$YAML_SRC" | \
sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" > "$YAML_RUN"

# Create distrobuilder cache directory preserving isolated source archives
CACHE_DIR="${REPO_ROOT}/.cache/distrobuilder"
mkdir -p "$CACHE_DIR"

SOURCES_DIR="${REPO_ROOT}/.cache/distrobuilder_sources"
mkdir -p "$SOURCES_DIR"

cd "$WORK_DIR" || exit 1

# Mount rootfs as tmpfs on Linux (size controlled by TMPFS_SIZE, default 768M)
TMPFS_SIZE="${TMPFS_SIZE:-768M}"
ROOTFS_MNT="${TMP_DIR}/rootfs_${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$ROOTFS_MNT"
if [ "$(uname -s)" = "Linux" ]; then
    sudo mount -t tmpfs -o size=${TMPFS_SIZE} tmpfs "$ROOTFS_MNT"
fi

# Override the default keyring if the debthin key exists
KEYRING_OPT=""
if [ -f "${WORK_DIR}/debthin-keyring-binary.gpg" ]; then
    KEYRING_OPT="--keyring=${WORK_DIR}/debthin-keyring-binary.gpg"
fi

# Create a debootstrap wrapper to pre-inject cached packages before bootstrap network pulls
mkdir -p "${WORK_DIR}/bin"
cat <<EOF > "${WORK_DIR}/bin/debootstrap"
#!/usr/bin/env bash
mkdir -p "${ROOTFS_MNT}/var/cache/apt/archives"
if ls "${HOST_APT}/"*.deb >/dev/null 2>&1; then
    cp -u "${HOST_APT}/"*.deb "${ROOTFS_MNT}/var/cache/apt/archives/"
fi
exec /usr/sbin/debootstrap ${KEYRING_OPT} "\$@"
EOF
chmod +x "${WORK_DIR}/bin/debootstrap"

# Build rootfs directory - --with-post-files ensures post-files actions run
if ! sudo env PATH="${WORK_DIR}/bin:$PATH" distrobuilder build-dir \
        --with-post-files \
        --cache-dir="$CACHE_DIR" \
        --sources-dir="$SOURCES_DIR" \
        "$YAML_RUN" "$ROOTFS_MNT"; then
    # Rescue the debootstrap log before cleanup wipes the rootfs
    if [ -f "${ROOTFS_MNT}/debootstrap/debootstrap.log" ]; then
        cp "${ROOTFS_MNT}/debootstrap/debootstrap.log" "${OUT_DIR}/debootstrap-failure.log" 2>/dev/null || true
        echo "Debootstrap log saved to: ${OUT_DIR}/debootstrap-failure.log"
    fi
    echo "ERROR: Distrobuilder failed to construct rootfs for $DISTRO $SUITE $ARCH"
    exit 1
fi

# Capture the package manifest from the bootstrapped rootfs for curation review
sudo chroot "$ROOTFS_MNT" dpkg-query -W -f '${Package}\n' 2>/dev/null | sort > "${OUT_DIR}/bootstrap-packages.txt" || true
echo "[INFO] Package manifest: ${OUT_DIR}/bootstrap-packages.txt ($(wc -l < "${OUT_DIR}/bootstrap-packages.txt") packages)"

# Synchronize newly fetched debootstrap packages back into the persistent host cache
sudo cp -u "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb "$HOST_APT/" 2>/dev/null || true
sudo rm -f "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb 2>/dev/null || true

# Pack LXC and Incus images from the rootfs
sudo distrobuilder pack-lxc   "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"
sudo distrobuilder pack-incus "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"

# Build OCI image from rootfs under a single rootful context
if command -v buildah >/dev/null 2>&1; then
    mkdir -p "${OUT_DIR}/oci"
    sudo bash -c '
        set -e
        CTR=$(buildah from scratch)
        buildah copy "$CTR" "'"$ROOTFS_MNT"'" /
        buildah config \
            --os linux \
            --arch "'"$ARCH"'" \
            --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
            "$CTR"
        buildah commit --disable-compression=false --format oci "$CTR" "oci:'"${OUT_DIR}"'/oci" > /dev/null
        buildah rm "$CTR" > /dev/null
    '
fi

# Tear down the rootfs tmpfs before hashing
if [ "$(uname -s)" = "Linux" ]; then
    sudo umount -l "$ROOTFS_MNT" 2>/dev/null || true
fi
sudo rm -rf "$ROOTFS_MNT" 2>/dev/null || true

# Reclaim ownership from root
sudo chown -R "$(id -u):$(id -g)" "$OUT_DIR"

echo "Calculating SHA256 hashes..."
cd "$OUT_DIR" || exit 1

SHA_CMD="sha256sum"
if ! command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
fi

find . -type f ! -name "hashes.txt" | sort | xargs $SHA_CMD > hashes.txt

echo "[DONE] Artefacts saved to: $OUT_DIR"
