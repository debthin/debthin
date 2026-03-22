#!/usr/bin/env bash
set -e

# ==========================================
# 1. PATH RESOLUTION & SETUP
# ==========================================
# Always resolve paths relative to the script, allowing execution from anywhere
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_FILE="${REPO_ROOT}/config.json"
TEMPLATE_DIR="${REPO_ROOT}/images/yaml-templates"
OUTPUT_BASE="${REPO_ROOT}/images_output/images"
TMP_DIR="${REPO_ROOT}/.build_tmp"

# The version stamp matches the R2 worker layout (YYYYMMDD_HHMM)
BUILD_DATE="$(date +%Y%m%d_%H%M)"

# Ensure all parallel background processes are aggressively terminated if the script is cancelled
trap 'echo -e "\n[ABORT] Terminating all active background builds..."; kill 0 2>/dev/null; exit 1' INT TERM

# Ensure dependencies exist
for cmd in distrobuilder jq curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command '$cmd' is not installed."
        exit 1
    fi
done

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: config.json not found at $CONFIG_FILE"
    exit 1
fi

echo "==========================================="
echo " Starting debthin Image Builder"
echo " Build Version: $BUILD_DATE"
echo "==========================================="

# ==========================================
# 2. FLATTEN THE JSON MATRIX
# ==========================================
# This jq query normalizes the different distro structures into a flat list: 
# "distro suite arch" (e.g., "debian trixie amd64")
BUILD_MATRIX=$(jq -r '
  (
    .debian | .arches as $def | .suites | to_entries[] | 
    .key as $s | (.value.arches // $def)[] | "debian \($s) \(.)"
  ),
  (
    .ubuntu | (.archive_arches + .ports_arches) as $arch | .suites | to_entries[] | 
    .key as $s | $arch[] | "ubuntu \($s) \(.)"
  ),
  (
    .raspbian | .arches as $def | .suites | to_entries[] | 
    .key as $s | (.value.arches // $def)[] | "raspbian \($s) \(.)"
  )
' "$CONFIG_FILE")

# ==========================================
# 3. EXECUTE BUILD LOOP
# ==========================================
mkdir -p "$TMP_DIR"
cd "$REPO_ROOT" || exit 1

# Global thread pool limit
MAX_JOBS=4
ACTIVE_JOBS=0

echo "$BUILD_MATRIX" | while read -r DISTRO SUITE ARCH; do
    
    YAML_SRC="${TEMPLATE_DIR}/${DISTRO}/${SUITE}.yaml"
    
    if [ ! -f "$YAML_SRC" ]; then
        echo "[SKIP] $DISTRO:$SUITE ($ARCH) - No template found at $YAML_SRC"
        continue
    fi

    # Spawn isolated build process natively mapped to background execution
    (
        # Provide unique isolated configuration mounts safely out of parallel bounds!
        WORK_DIR="${TMP_DIR}/${DISTRO}_${SUITE}_${ARCH}"
        mkdir -p "$WORK_DIR"

        echo "[BUILD] Constructing $DISTRO $SUITE for $ARCH..."

        HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
        if [ "$ARCH" != "$HOST_ARCH" ]; then
            if ! ls /usr/bin/qemu-*-static >/dev/null 2>&1; then
                echo "ERROR: Cross-compiling $ARCH on $HOST_ARCH natively requires QEMU user emulation bounds."
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

        # Extract host deb packages natively dropping them efficiently into the runtime working bounds 
        HOST_APT="${REPO_ROOT}/.cache/apt"
        mkdir -p "$HOST_APT"
        mkdir -p "${WORK_DIR}/apt-cache"
        cp -un "$HOST_APT/"*.deb "${WORK_DIR}/apt-cache/" 2>/dev/null || true

        # Inject the apt cache loader cleanly under the 'files:' array in the YAML
        awk '/^files:/ {
            print
            print "  - path: /var/cache/apt/archives/"
            print "    generator: copy"
            print "    source: ./apt-cache/"
            next
        }1' "$YAML_SRC" | \
        sed "s/architecture: .*/architecture: \"${ARCH}\"/" | \
        sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" > "$YAML_RUN"

        # Explicitly persist deb downloads across execution cycles avoiding upstream throttling bounds!
        CACHE_DIR="${REPO_ROOT}/.cache/distrobuilder"
        mkdir -p "$CACHE_DIR"

        cd "$WORK_DIR" || exit 1

        # Evaluate ultra-fast tmpfs bindings dynamically allocating strictly on Linux host execution bounds natively mapping massive IO thresholds
        ROOTFS_MNT="${OUT_DIR}/rootfs"
        mkdir -p "$ROOTFS_MNT"
        if [ "$(uname -s)" = "Linux" ]; then
            sudo mount -t tmpfs -o size=2G tmpfs "$ROOTFS_MNT"
        fi

        # Build core directory first cutting redundant debootstrap downloads directly
        if ! sudo distrobuilder build-dir "$YAML_RUN" "$ROOTFS_MNT" --cache-dir="$CACHE_DIR" --sources-dir="$CACHE_DIR"; then
             echo "ERROR: Distrobuilder failed to construct rootfs for $DISTRO $SUITE $ARCH"
        fi
        
        # Save any newly resolved .deb packages organically out of the TMPFS and directly back into persistent arrays
        sudo cp -un "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb "$HOST_APT/" 2>/dev/null || true
        # Wipe the container archives natively protecting image size limits
        sudo rm -f "${ROOTFS_MNT}/var/cache/apt/archives/"*.deb 2>/dev/null || true

        # Pack the isolated formats from the single rootfs
        sudo distrobuilder pack-lxc "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"
        sudo distrobuilder pack-incus "$YAML_RUN" "$ROOTFS_MNT" "$OUT_DIR"

        if command -v buildah >/dev/null 2>&1; then
            CTR=$(sudo buildah from scratch)
            MNT=$(sudo buildah mount "$CTR")
            sudo cp -a "${ROOTFS_MNT}/." "$MNT/"
            sudo buildah config --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$CTR"
            sudo buildah commit "$CTR" "oci-archive:${OUT_DIR}/oci.tar" > /dev/null
            sudo buildah umount "$CTR" > /dev/null
            sudo buildah rm "$CTR" > /dev/null
            
            # Compress the massive uncompressed OCI archive natively conserving limits
            sudo xz -T1 "${OUT_DIR}/oci.tar"
        fi

        # Safely detach and purge the IO bound limits organically
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
        
        # Hash only physical bins organically protecting tests catching split builds safely
        EXISTING_BINS=$(ls -1 rootfs.tar.xz meta.tar.xz incus.tar.xz rootfs.squashfs oci.tar.xz 2>/dev/null || true)
        if [ -n "$EXISTING_BINS" ]; then
            # shellcheck disable=SC2086
            $SHA_CMD $EXISTING_BINS > hashes.txt
        fi
        
        echo "[DONE] Artefacts saved to: $OUT_DIR"
    ) &

    ACTIVE_JOBS=$((ACTIVE_JOBS + 1))
    if [ "$ACTIVE_JOBS" -ge "$MAX_JOBS" ]; then
        wait -n
        ACTIVE_JOBS=$((ACTIVE_JOBS - 1))
    fi

done

# Block script conclusion until all background worker targets officially land
wait

# Cleanup
echo ""
echo "==========================================="
echo " Build Run Complete!"
echo " Images generated in: $OUTPUT_BASE"
echo "==========================================="
