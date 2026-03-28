# Container Image Pipeline

Architecture documentation for the image build pipeline under `scripts/images/`.

## Overview

Builds minimal root filesystem images for Debian, Ubuntu, and Raspbian using
distrobuilder. Produces LXC, Incus, and OCI container images. The Makefile
generates targets dynamically from `config.json`, filtered by which YAML
templates physically exist.

## Components

### Makefile

Parses `config.json` via `jq` to generate `distro/suite/arch` target
combinations. Filters against `build-profiles/` to only build targets with
a matching profile. Each target calls `build-image.sh` with the target path.

```
make -C scripts/images -j4        # parallel builds
make -C scripts/images debian/bookworm/amd64   # single target
```

### build-image.sh

Single-target builder. Accepts `distro/suite/arch` as argument. Handles:

1. **Profile resolution** — reads profile from `build-profiles/<distro>/<suite>`,
   resolving shared configs and packages
2. **Cross-compilation** — detects host vs target arch mismatch, requires
   `qemu-user-static` + `binfmt-support`
3. **APT caching** — host directory mounted into `mmdebstrap`
4. **Rootfs build** — relies on `mmdebstrap` directly to a target `tmpfs`
5. **Packing** — minimal YAML dynamically generated for `distrobuilder pack-lxc`, `distrobuilder pack-incus`, and `buildah`
6. **Hashing** — SHA256 checksums for all output files

### generate_image_manifest.py

Generates `registry-state.json` from the built image tree. Used by the
Cloudflare Worker to serve the image registry API.

## Directory Layout

```
build-profiles/                    Data-driven build profiles
  <distro>/<suite>/

scripts/images/
  Makefile                         Build orchestration
  build-image.sh                   Single-target builder
  generate_image_manifest.py       Registry manifest generator

.build_tmp/                        Temporary build workspace (not committed)
  <distro>_<suite>_<arch>/

.cache/
  apt/<distro>_<suite>_<arch>/     Cached .deb files
  distrobuilder/                   distrobuilder cache

images_output/images/              Built images
  <distro>/<suite>/<arch>/default/<BUILD_DATE>/
    rootfs.tar.xz
    lxd.tar.xz
    incus.tar.xz
    oci/                           OCI image layout (if buildah available)
    hashes.txt
```

## Dependencies

- `distrobuilder` — rootfs construction
- `debootstrap` — bootstrap tool (wrapped for APT cache injection)
- `buildah` — OCI image packing (optional, skipped if not installed)
- `qemu-user-static` — cross-arch builds only
- `jq` — Makefile target generation from config.json
