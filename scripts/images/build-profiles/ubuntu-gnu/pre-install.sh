#!/bin/sh
# Pre-install hook for ubuntu-gnu profile.
# Runs in the setup hook before --include packages are installed.
#
# Handles the coreutils-from-uutils → coreutils-from-gnu swap on releases
# where Rust coreutils is the default (questing+).

ROOTFS="$1"

echo ">>> [pre-install] Pinning coreutils-from-uutils to never-install"
mkdir -p "$ROOTFS/etc/apt/preferences.d"
cat > "$ROOTFS/etc/apt/preferences.d/no-uutils" <<'PINEOF'
Package: coreutils-from-uutils rust-coreutils
Pin: release *
Pin-Priority: -1
PINEOF

dpkg --root="$ROOTFS" --remove --force-depends coreutils-from-uutils rust-coreutils 2>/dev/null || true
