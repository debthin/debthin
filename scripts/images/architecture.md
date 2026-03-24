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
combinations. Filters against `yaml-templates/` to only build targets with
a matching YAML template. Each target calls `build.sh` with the target path.

```
make -C scripts/images -j4        # parallel builds
make -C scripts/images debian/bookworm/amd64   # single target
```

### build.sh

Single-target builder. Accepts `distro/suite/arch` as argument. Handles:

1. **YAML resolution** — reads template from `yaml-templates/<distro>/<suite>.yaml`,
   patches architecture field
2. **Cross-compilation** — detects host vs target arch mismatch, requires
   `qemu-user-static` + `binfmt-support`
3. **APT caching** — pre-seeds debootstrap with cached `.deb` files from
   `.cache/apt/` and syncs new packages back after build
4. **Rootfs build** — `distrobuilder build-dir` with tmpfs mount on Linux
5. **Packing** — `distrobuilder pack-lxc`, `distrobuilder pack-incus`,
   and `buildah` OCI commit (optional)
6. **Hashing** — SHA256 checksums for all output files

### generate_image_manifest.py

Generates `registry-state.json` from the built image tree. Used by the
Cloudflare Worker to serve the image registry API.

## Directory Layout

```
yaml-templates/                    YAML definitions (repo root)
  <distro>/<suite>.yaml

scripts/images/
  Makefile                         Build orchestration
  build.sh                        Single-target builder
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
