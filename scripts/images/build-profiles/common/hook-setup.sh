#!/bin/sh
# hook-setup.sh — mmdebstrap setup hook
#
# Runs BEFORE package installation. Applies rootfs overlays, injects GPG
# keyrings, configures apt sources, and runs profile-specific pre-install
# hooks if present.
#
# Required environment variables (exported by build-image-v2.sh):
#   COMMON_DIR    — path to build-profiles/common
#   PROFILE_DIR   — resolved path to active build profile
#   PROFILE_NAME  — profile basename (e.g. debian-networkd)
#   WORK_DIR      — build working directory
#   HOST_APT      — host apt cache directory to bind-mount
#   BOOTSTRAP_SOURCES — sources.list content for bootstrap phase

set -e
ROOTFS="$1"

echo ">>> [setup] Applying common rootfs overlay"
cp -a "${COMMON_DIR}/rootfs/." "$ROOTFS/"

echo ">>> [setup] Applying ${PROFILE_NAME} rootfs overlay"
if [ -d "${PROFILE_DIR}/rootfs" ]; then
    cp -a "${PROFILE_DIR}/rootfs/." "$ROOTFS/"
fi

echo ">>> [setup] Injecting GPG keyrings"
mkdir -p "$ROOTFS/etc/apt/keyrings"
cp "${WORK_DIR}/debthin-keyring-binary.gpg" "$ROOTFS/etc/apt/keyrings/debthin.gpg"

echo ">>> [setup] Bind-mounting host apt cache"
mkdir -p "$ROOTFS/var/cache/apt/archives" "$ROOTFS/var/lib/apt/lists/partial"
mount --bind "${HOST_APT}" "$ROOTFS/var/cache/apt/archives"

echo ">>> [setup] Writing bootstrap sources.list (--keyring handles authentication)"
cat > "$ROOTFS/etc/apt/sources.list" <<SRCEOF
${BOOTSTRAP_SOURCES}
SRCEOF

# Run profile-specific pre-install hook if it exists.
# This runs after rootfs overlay and sources.list, before --include packages.
if [ -x "${PROFILE_DIR}/pre-install.sh" ]; then
    echo ">>> [setup] Running ${PROFILE_NAME} pre-install hook"
    "${PROFILE_DIR}/pre-install.sh" "$ROOTFS"
fi
