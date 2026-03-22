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

# Copy cached deb packages to working directory
HOST_APT="${REPO_ROOT}/.cache/apt/${DISTRO}_${SUITE}_${ARCH}"
mkdir -p "$HOST_APT"
mkdir -p "${WORK_DIR}/apt-cache"
cp -un "$HOST_APT/"*.deb "${WORK_DIR}/apt-cache/" 2>/dev/null || true

# Add apt cache directory to YAML
awk '/^files:/ {
    print
    print "  - path: /var/cache/apt/archives/"
    print "    generator: copy"
    print "    source: ./apt-cache/"
    next
}1' "$YAML_SRC" | \
sed "s/architecture: .*/architecture: \"${ARCH}\"/" | \
sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" > "$YAML_RUN"

# Create distrobuilder cache directory
CACHE_DIR="${REPO_ROOT}/.cache/distrobuilder"
mkdir -p "$CACHE_DIR"

SOURCES_DIR="${REPO_ROOT}/.cache/distrobuilder_sources"
mkdir -p "$SOURCES_DIR"

cd "$WORK_DIR" || exit 1

# Mount rootfs as tmpfs on Linux
ROOTFS_MNT="${OUT_DIR}/rootfs"
mkdir -p "$ROOTFS_MNT"
if [ "$(uname -s)" = "Linux" ]; then
    sudo mount -t tmpfs -o size=2G tmpfs "$ROOTFS_MNT"
fi

# Create a debootstrap wrapper to pre-inject cached packages before bootstrap network pulls 
mkdir -p "${WORK_DIR}/bin"
cat <<EOF > "${WORK_DIR}/bin/debootstrap"
#!/usr/bin/env bash
mkdir -p "${ROOTFS_MNT}/var/cache/apt/archives"
if ls "${HOST_APT}/"*.deb >/dev/null 2>&1; then
    cp -un "${HOST_APT}/"*.deb "${ROOTFS_MNT}/var/cache/apt/archives/"
fi
exec /usr/sbin/debootstrap "\$@"
EOF
chmod +x "${WORK_DIR}/bin/debootstrap"

# Build rootfs directory
if ! sudo env PATH="${WORK_DIR}/bin:$PATH" distrobuilder build-dir "$YAML_RUN" "$ROOTFS_MNT" --cache-dir="$CACHE_DIR" --sources-dir="$SOURCES_DIR"; then
     echo "ERROR: Distrobuilder failed to construct rootfs for $DISTRO $SUITE $ARCH"
fi

# Save downloaded deb packages to host cache
sudo cp -un "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb "$HOST_APT/" 2>/dev/null || true
# Clean apt cache from rootfs
sudo rm -f "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb 2>/dev/null || true

# Pack LXC and Incus formats
sudo distrobuilder pack-lxc "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"
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
