#!/bin/sh
# Post-install hook for debian-ifupdown profile.
# Runs in the customize hook after standard cleanup.
#
# Strips usrmerge (job done once usr is merged) and full perl
# (keeping perl-base) to save ~30MB on bullseye and earlier.

ROOTFS="$1"

# usrmerge depends on perl but has already done its job by this point.
if chroot "$ROOTFS" dpkg -l usrmerge 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Removing usrmerge (usr already merged)"
    chroot "$ROOTFS" dpkg --remove --force-depends usrmerge 2>/dev/null || true
fi

# Remove full perl — version varies by release, use wildcard matching
for pkg in perl perl-modules-* libperl5.* \
           libfile-find-rule-perl libnumber-compare-perl libtext-glob-perl \
           libgdbm6 libgdbm-compat4; do
    if chroot "$ROOTFS" dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
        echo ">>> [post-install] Removing $pkg"
        chroot "$ROOTFS" dpkg --remove --force-depends "$pkg" 2>/dev/null || true
    fi
done
