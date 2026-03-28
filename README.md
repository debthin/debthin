# debthin

Lean Debian, Ubuntu, and Raspbian package indexes and container images at [debthin.org](https://debthin.org).

## What this is

debthin serves curated `Packages.gz` indexes filtered to ~6,700-7,500 server-relevant packages — 90-93% smaller than upstream. Actual `.deb` files redirect transparently to official mirrors. Nothing is rehosted.

This repo contains:

1. **Package index pipeline** — fetches, filters, signs, and uploads curated indexes to Cloudflare R2
2. **Container image pipeline** — builds minimal LXC/Incus/OCI rootfs images using distrobuilder
3. **Cloudflare Workers** — three edge workers that serve the indexes, images, and upstream proxy

## Repository Layout

```
config.json                  Central configuration for all distros, suites, arches
curated/                     Curated package lists (auto-generated from popcon)
required_packages/           Manual package overrides

scripts/
  debthin/                   Package index pipeline (Makefile-orchestrated)
  images/                    Container image pipeline

workers/
  core/                      Shared worker primitives (HTTP, R2, caching, utils)
  debthin/                   Package index worker (debthin.org)
  images/                    Container image registry worker
  proxy/                     Upstream proxy worker (pkg redirects)
  tests/                     Unit tests for workers
  wrangler.toml              Worker config: debthin
  wrangler-images.toml       Worker config: images
  wrangler-proxy.toml        Worker config: proxy

static/                      Static assets (index.html, GPG keyrings)
```

## Documentation

| Document | Scope |
|---|---|
| [README-DEBTHIN.md](README-DEBTHIN.md) | Package indexes: suites, setup, configuration, running locally |
| [README-IMAGES.md](README-IMAGES.md) | Container images: targets, building, output format |
| [scripts/debthin/architecture.md](scripts/debthin/architecture.md) | Pipeline phases, directory layout, parallelism |
| [scripts/images/architecture.md](scripts/images/architecture.md) | Image build flow, cross-compilation, caching |
| [build-dependencies.md](build-dependencies.md) | External tools and libraries |

### Workers

Each worker has its own architecture doc:

| Worker | Doc | Wrangler config |
|---|---|---|
| debthin (package indexes) | [workers/debthin.md](workers/debthin.md) | `workers/wrangler.toml` |
| images (container registry) | [workers/images.md](workers/images.md) | `workers/wrangler-images.toml` |
| proxy (upstream redirect) | [workers/proxy.md](workers/proxy.md) | `workers/wrangler-proxy.toml` |
| shared primitives | [workers/index.md](workers/index.md) | — |

## Quick Start

### Use debthin indexes

See [README-DEBTHIN.md](README-DEBTHIN.md) for full setup. Short version:

```bash
curl -fsSL http://debthin.org/debthin-keyring-binary.gpg \
  -o /etc/apt/trusted.gpg.d/debthin.gpg
```

Then point your `sources.list` at `http://debthin.org`.

### Build package indexes locally

```bash
make -C scripts/debthin -j8 NO_UPLOAD=1
```

### Build container images locally

```bash
make -C scripts/images debian/bookworm/amd64
```

### Deploy a worker

```bash
cd workers
npx wrangler deploy -c wrangler.toml            # debthin
npx wrangler deploy -c wrangler-images.toml      # images
npx wrangler deploy -c wrangler-proxy.toml       # proxy
```

### Run tests

```bash
node --test workers/tests/unit/
```

## Pipeline

Runs daily at 04:00 UTC via GitHub Actions. Re-curates from popcon on Sundays.

## Trademark notice

Debian is a registered trademark of [Software in the Public Interest, Inc](https://www.spi-inc.org/). Ubuntu is a registered trademark of Canonical Ltd. debthin is an independent project and is not affiliated with, endorsed by, or sponsored by the Debian Project or Canonical. Use of the names "deb" and "ubuntu" refers to the respective package formats and ecosystems, consistent with their trademark policies for software that works with these systems. debthin does not redistribute packages - all package files are served directly from official mirrors.
