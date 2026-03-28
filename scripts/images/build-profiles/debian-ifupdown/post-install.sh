#!/bin/sh
# Post-install hook for debian-ifupdown profile.
# Runs in the customize hook after standard cleanup.
#
# Strips full perl (keeping perl-base) to save ~30MB on bullseye
# where debconf pulls in the full perl stack.

ROOTFS="$1"

# Remove full perl — version varies by release, use wildcard matching
for pkg in perl perl-modules-* libperl5.* \
           libfile-find-rule-perl libnumber-compare-perl libtext-glob-perl \
           libgdbm6 libgdbm-compat4; do
    if chroot "$ROOTFS" dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
        echo ">>> [post-install] Removing $pkg"
        chroot "$ROOTFS" dpkg --remove --force-depends "$pkg" 2>/dev/null || true
    fi
done
