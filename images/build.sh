#!/usr/bin/env bash
set -e

# PATH RESOLUTION & SETUP
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_FILE="${REPO_ROOT}/config.json"
TEMPLATE_DIR="${REPO_ROOT}/images/yaml-templates"
OUTPUT_BASE="${REPO_ROOT}/images_output/images"
TMP_DIR="${REPO_ROOT}/.build_tmp"

# Force all xz operations to use exactly 1 thread
export XZ_OPT="-T1"

# Inherit BUILD_DATE from Make or generate a standalone timestamp
BUILD_DATE="${BUILD_DATE:-$(date +%Y%m%d_%H%M)}"

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

# Ensure dependencies exist
for cmd in distrobuilder curl; do
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
mkdir -p "$OUT_DIR"

YAML_RUN="${WORK_DIR}/current_build.yaml"

if [ -f "${REPO_ROOT}/static/debthin-keyring-binary.gpg" ]; then
    cp "${REPO_ROOT}/static/debthin-keyring-binary.gpg" "${WORK_DIR}/debthin-keyring-binary.gpg"
fi

# Process YAML template converting architecture definitions natively
sed "s/architecture: .*/architecture: \"${ARCH}\"/" "$YAML_SRC" | \
sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" > "$YAML_RUN"

# Create distrobuilder cache directory preserving isolated source archives natively
CACHE_DIR="${REPO_ROOT}/.cache/distrobuilder"
mkdir -p "$CACHE_DIR"

SOURCES_DIR="${REPO_ROOT}/.cache/distrobuilder_sources"
mkdir -p "$SOURCES_DIR"

cd "$WORK_DIR" || exit 1

# Mount rootfs as tmpfs on Linux natively handling volatile file matrices
ROOTFS_MNT="${OUT_DIR}/rootfs"
mkdir -p "$ROOTFS_MNT"
if [ "$(uname -s)" = "Linux" ]; then
    sudo mount -t tmpfs -o size=2G tmpfs "$ROOTFS_MNT"
fi



# Build rootfs directory
if ! sudo distrobuilder build-dir "$YAML_RUN" "$ROOTFS_MNT" --cache-dir="$CACHE_DIR" --sources-dir="$SOURCES_DIR"; then
     echo "ERROR: Distrobuilder failed to construct rootfs for $DISTRO $SUITE $ARCH"
     exit 1
fi

# Pack LXC format natively allowing the initial post-files configuration iteration to execute successfully.
# Because the native yaml templates contain `apt-get clean`, no uncompressed deb blobs are archived within the tarball.
sudo distrobuilder pack-lxc "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"

# Strip the actions array from the runtime YAML stopping consecutive pack-incus frameworks from infinitely repeating network loops.
awk '
/^actions:/ { skip=1; next }
/^[a-z]+:/ { if (skip) skip=0 }
!skip { print }
' "$YAML_RUN" > "${YAML_RUN}.tmp" && sudo mv "${YAML_RUN}.tmp" "$YAML_RUN"

# Pack Incus format safely without repeating setup scripts
sudo distrobuilder pack-incus "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"

if command -v buildah >/dev/null 2>&1; then
    CTR=$(sudo buildah from scratch)
    sudo buildah add "$CTR" "${OUT_DIR}/rootfs.tar.xz" /
    sudo buildah config --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$CTR"
    # Create OCI layout directory
    sudo buildah commit --disable-compression=false --format oci "$CTR" "oci:${OUT_DIR}/oci" > /dev/null
    sudo buildah rm "$CTR" > /dev/null
fi

# Unmount and remove rootfs and working directories
if [ "$(uname -s)" = "Linux" ]; then
    sudo umount -l "$ROOTFS_MNT" || true
fi
sudo rm -rf "$ROOTFS_MNT"
sudo rm -rf "$WORK_DIR"

echo "Calculating SHA256 hashes..."
cd "$OUT_DIR" || exit 1

SHA_CMD="sha256sum"
if ! command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
fi

# Generate SHA256 hashes for all output files
find . -type f ! -name "hashes.txt" | sort | xargs $SHA_CMD > hashes.txt

echo "[DONE] Artefacts saved to: $OUT_DIR"
