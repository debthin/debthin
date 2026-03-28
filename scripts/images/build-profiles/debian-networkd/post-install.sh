#!/bin/sh
# Post-install hook for debian-networkd profile.
# Runs in the customize hook after standard cleanup.
#
# Strips usrmerge (job done once usr is merged) and full perl
# (keeping perl-base) to save ~30MB on bookworm and earlier.

ROOTFS="$1"

# usrmerge depends on perl but has already done its job by this point.
# Remove it first so perl can be cleanly stripped.
if chroot "$ROOTFS" dpkg -l usrmerge 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Removing usrmerge (usr already merged)"
    chroot "$ROOTFS" dpkg --remove --force-depends usrmerge 2>/dev/null || true
fi

if chroot "$ROOTFS" dpkg -l perl 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Removing full perl (debconf only needs perl-base)"
    chroot "$ROOTFS" dpkg --remove --force-depends \
        perl perl-modules-5.36 libperl5.36 \
        libfile-find-rule-perl libnumber-compare-perl libtext-glob-perl \
        libgdbm6 libgdbm-compat4 2>/dev/null || true
fi
