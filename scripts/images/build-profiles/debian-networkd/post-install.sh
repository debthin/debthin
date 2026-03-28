#!/bin/sh
# Post-install hook for debian-networkd profile.
# Runs in the customize hook after standard cleanup.
#
# Removes full perl (keeping perl-base) to save ~30MB on releases
# where debconf pulls in the full perl stack (bookworm and earlier).

ROOTFS="$1"

if chroot "$ROOTFS" dpkg -l perl 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Removing full perl (debconf only needs perl-base)"
    chroot "$ROOTFS" dpkg --remove --force-depends \
        perl perl-modules-5.36 libperl5.36 \
        libfile-find-rule-perl libnumber-compare-perl libtext-glob-perl \
        libgdbm6 libgdbm-compat4 2>/dev/null || true
fi
