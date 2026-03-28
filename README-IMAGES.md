# Container Images

debthin builds minimal root filesystem images for Debian, Ubuntu, and Raspbian using [distrobuilder](https://github.com/lxc/distrobuilder).

## Targets

Images are built for every distro/suite/arch combination defined in `config.json` that has a matching build profile in `scripts/images/build-profiles/`.

### Debian

| Suite    | Architectures                  |
|----------|--------------------------------|
| forky    | amd64 arm64 armhf i386 riscv64 |
| trixie   | amd64 arm64 armhf i386 riscv64 |
| bookworm | amd64 arm64 armhf i386         |
| bullseye | amd64 arm64 armhf i386         |

### Ubuntu

| Suite    | Architectures              |
|----------|----------------------------|
| questing | amd64 i386 arm64 riscv64   |
| plucky   | amd64 i386 arm64 riscv64   |
| noble    | amd64 i386 arm64 riscv64   |
| jammy    | amd64 i386 arm64 riscv64   |

### Raspbian

| Suite    | Architectures |
|----------|---------------|
| bookworm | armhf         |
| bullseye | armhf         |

## Output Formats

Each build produces:

| File | Format |
|---|---|
| `rootfs.tar.xz` | Compressed root filesystem |
| `lxd.tar.xz` | LXC/Incus metadata + rootfs |
| `incus.tar.xz` | Incus-native image |
| `oci/` | OCI image layout (requires `buildah`) |
| `hashes.txt` | SHA256 checksums |

## Building

### All targets

```bash
make -C scripts/images -j4
```

### Single target

```bash
make -C scripts/images debian/bookworm/amd64
```

### Cross-architecture

Cross-arch builds require QEMU user emulation:

```bash
sudo apt install qemu-user-static binfmt-support
make -C scripts/images debian/bookworm/arm64
```

## Build Profiles

Profiles live at `scripts/images/build-profiles/<distro>/<suite>`. Each profile directory contains:

- `packages.list` - minimal package list to install (replaces post-install bloat removal)
- `services.list` - systemd services to enable
- `mirror` - upstream mirror URL
- `security` - security repo configuration
- `rootfs/` - files copied directly into the image

### Ubuntu-specific optimisations

Ubuntu images are generated without bloat by installing exactly what is required using `packages.list`, removing the need for `apt-get remove` hacks.

## Dependencies

See [build-dependencies.md](build-dependencies.md) for a full list. Key requirements:

- `distrobuilder` — rootfs construction
- `buildah` — OCI image packing (optional)
- `qemu-user-static` — cross-arch builds only

## Architecture

See [scripts/images/architecture.md](scripts/images/architecture.md) for the build flow, caching strategy, and directory layout.
