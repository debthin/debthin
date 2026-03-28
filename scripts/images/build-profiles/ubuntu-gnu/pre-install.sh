#!/bin/sh
# Pre-install hook for ubuntu-gnu profile.
# Runs in the setup hook before --include packages are installed.
#
# Handles the coreutils-from-uutils → coreutils-from-gnu swap on releases
# where Rust coreutils is the default (questing+).
# Purges (not just removes) uutils so dpkg forgets about it entirely —
# otherwise mmdebstrap's required-package filter tries to reinstall it.

ROOTFS="$1"

if chroot "$ROOTFS" dpkg -l coreutils-from-uutils 2>/dev/null | grep -q '^ii'; then
    echo ">>> [pre-install] Purging coreutils-from-uutils (replacing with gnu)"
    chroot "$ROOTFS" dpkg --purge --force-depends coreutils-from-uutils rust-coreutils 2>/dev/null || true
fi
