#!/bin/sh
# hook-customize.sh — mmdebstrap customize hook
#
# Runs AFTER package installation. Cleans up docs/man/locale, removes udev
# and systemd-resolved, enables profile services, writes final sources.list,
# unmounts the host cache, and runs profile-specific post-install hooks.
#
# Required environment variables (exported by build-image.sh):
#   PROFILE_DIR       — resolved path to active build profile
#   PROFILE_NAME      — profile basename (e.g. debian-networkd)
#   SERVICES_FILE     — path to file containing service names to enable
#   FINAL_SOURCES     — final sources.list content with signed-by

set -e
ROOTFS="$1"

# --- Cleanup ---
echo ">>> [customize] Cleaning docs, man pages, locale data"
rm -rf "$ROOTFS/usr/share/doc/"* "$ROOTFS/usr/share/man/"* "$ROOTFS/usr/share/locale/"*
rm -rf "$ROOTFS/usr/lib/udev/hwdb.d/"* "$ROOTFS/usr/lib/systemd/hwdb/"*
rm -f "$ROOTFS/usr/lib/udev/hwdb.bin" "$ROOTFS/etc/udev/hwdb.bin"
rm -f "$ROOTFS/var/cache/apt/"*.bin

# --- Remove unnecessary services ---
echo ">>> [customize] Removing udev"
chroot "$ROOTFS" dpkg --remove --force-depends udev 2>/dev/null || true

echo ">>> [customize] Removing systemd-resolved"
chroot "$ROOTFS" dpkg --remove --force-depends systemd-resolved 2>/dev/null || true
chroot "$ROOTFS" systemctl disable --now systemd-resolved.service 2>/dev/null || true
chroot "$ROOTFS" systemctl mask systemd-resolved.service 2>/dev/null || true

# Ubuntu's /etc/resolv.conf is a symlink to resolved's stub. With resolved
# gone, replace the dead symlink with a regular file that thin-resolv can write.
if [ -L "$ROOTFS/etc/resolv.conf" ]; then
    rm -f "$ROOTFS/etc/resolv.conf"
    touch "$ROOTFS/etc/resolv.conf"
fi

# --- Enable services ---
if [ -f "$SERVICES_FILE" ] && [ -s "$SERVICES_FILE" ]; then
    echo ">>> [customize] Enabling services"
    while read -r svc; do
        [ -z "$svc" ] && continue
        chroot "$ROOTFS" systemctl enable "$svc"
    done < "$SERVICES_FILE"
fi

# --- Run profile-specific post-install hook ---
if [ -x "${PROFILE_DIR}/post-install.sh" ]; then
    echo ">>> [customize] Running ${PROFILE_NAME} post-install hook"
    "${PROFILE_DIR}/post-install.sh" "$ROOTFS"
fi

# --- Final sources.list ---
echo ">>> [customize] Writing final sources.list with signed-by"
cat > "$ROOTFS/etc/apt/sources.list" <<SRCEOF
${FINAL_SOURCES}
SRCEOF

# --- Cleanup apt state ---
echo ">>> [customize] Unmounting host apt cache"
umount "$ROOTFS/var/cache/apt/archives" 2>/dev/null || true

echo ">>> [customize] Final apt cleanup"
rm -rf "$ROOTFS/var/lib/apt/lists/"*
rm -f "$ROOTFS/var/cache/apt/archives/"*.deb
