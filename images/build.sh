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

echo "$BUILD_MATRIX" | while read -r DISTRO SUITE ARCH; do
    
    # 3a. The Guardrail: Check if a template actually exists
    # This prevents the script from trying to build "-updates" or "-backports" 
    # suites unless you explicitly created a yaml template for them.
    YAML_SRC="${TEMPLATE_DIR}/${DISTRO}/${SUITE}.yaml"
    
    if [ ! -f "$YAML_SRC" ]; then
        echo "[SKIP] $DISTRO:$SUITE ($ARCH) - No template found at $YAML_SRC"
        continue
    fi

    echo ""
    echo "[BUILD] Constructing $DISTRO $SUITE for $ARCH..."

    # Check cross-compilation dependencies natively protecting debootstrap routines
    HOST_ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
    if [ "$ARCH" != "$HOST_ARCH" ]; then
        if ! ls /usr/bin/qemu-*-static >/dev/null 2>&1; then
            echo "ERROR: Cross-compiling $ARCH on $HOST_ARCH natively requires QEMU user emulation bounds."
            echo "Please run: sudo apt install qemu-user-static binfmt-support"
            exit 1
        fi
    fi
    
    # Define the output directory based on our R2 edge architecture
    OUT_DIR="${OUTPUT_BASE}/${DISTRO}/${SUITE}/${ARCH}/default/${BUILD_DATE}"
    mkdir -p "$OUT_DIR"

    # 3b. Dynamically Patch the YAML
    # Inject the ASCII keyring natively as an in-memory YAML dump to bypass isolated 'sudo' host filesystem mount drops failing the copy generator
    YAML_RUN="${TMP_DIR}/current_build.yaml"
    
    KEY_DUMP="${TMP_DIR}/key_dump"
    echo "      content: |-" > "$KEY_DUMP"
    sed "s/^/        /" "${REPO_ROOT}/static/debthin-keyring.gpg" >> "$KEY_DUMP"
    
    sed "s/architecture: .*/architecture: \"${ARCH}\"/" "$YAML_SRC" | \
    sed "s/lxc.arch = .*/lxc.arch = ${ARCH}/" | \
    sed "s|generator: copy|generator: dump|g" | \
    sed -e "/source: .*debthin-keyring/{r ${KEY_DUMP}" -e "d;}" | \
    sed "s|/etc/apt/keyrings/debthin.gpg|/etc/apt/keyrings/debthin.asc|g" > "$YAML_RUN"

    CACHE_DIR="${REPO_ROOT}/.cache/distrobuilder"
    mkdir -p "$CACHE_DIR"

    # Lock execution context to the isolate accommodating the local GPG file generator paths cleanly
    cd "$TMP_DIR" || exit 1

    # 3c. Run Distrobuilder
    # Build Classic LXC format
    sudo distrobuilder build-lxc "$YAML_RUN" "$OUT_DIR" --cache-dir="$CACHE_DIR"
    
    # Build Incus format
    sudo distrobuilder build-incus "$YAML_RUN" "$OUT_DIR" --cache-dir="$CACHE_DIR"

    # 3d. Generate local hashes
    echo "Calculating SHA256 hashes..."
    cd "$OUT_DIR"
    
    SHA_CMD="sha256sum"
    if ! command -v sha256sum >/dev/null 2>&1; then
        SHA_CMD="shasum -a 256"
    fi
    
    # Hash only physical bins organically protecting tests catching split builds safely
    EXISTING_BINS=$(ls -1 rootfs.tar.xz meta.tar.xz incus.tar.xz rootfs.squashfs 2>/dev/null || true)
    if [ -n "$EXISTING_BINS" ]; then
        # shellcheck disable=SC2086
        $SHA_CMD $EXISTING_BINS > hashes.txt
    fi
    
    cd "$REPO_ROOT"

    echo "[DONE] Artefacts saved to: $OUT_DIR"
done

# Cleanup
rm -rf "$TMP_DIR"
echo ""
echo "==========================================="
echo " Build Run Complete!"
echo " Images generated in: $OUTPUT_BASE"
echo "==========================================="
