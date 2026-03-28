#!/bin/sh
# Post-install hook for debian-networkd profile.
# Runs in the customize hook after standard cleanup.
#
# Replaces usrmerge with the usr-is-merged marker (tiny, no deps),
# then strips full perl (keeping perl-base) to save ~30MB on
# bookworm and earlier.

ROOTFS="$1"

# Replace usrmerge (which depends on perl) with the usr-is-merged marker.
# usr is already merged at this point; we just need to satisfy
# init-system-helpers' dependency.
if chroot "$ROOTFS" dpkg -l usrmerge 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Replacing usrmerge with usr-is-merged marker"
    chroot "$ROOTFS" apt-get install -y --no-install-recommends usr-is-merged 2>/dev/null || true
    chroot "$ROOTFS" dpkg --remove --force-depends usrmerge 2>/dev/null || true
fi

if chroot "$ROOTFS" dpkg -l perl 2>/dev/null | grep -q '^ii'; then
    echo ">>> [post-install] Removing full perl (debconf only needs perl-base)"
    chroot "$ROOTFS" dpkg --remove --force-depends \
        perl perl-modules-5.36 libperl5.36 \
        libfile-find-rule-perl libnumber-compare-perl libtext-glob-perl \
        libgdbm6 libgdbm-compat4 2>/dev/null || true
fi
