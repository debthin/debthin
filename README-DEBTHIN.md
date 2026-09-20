# debthin

Lean Debian and Ubuntu package indexes at [debthin.org](https://debthin.org).

A minimal container image is around 90MB. The first thing you do is `apt update` - and apt downloads another 90-210MB of index files describing 60,000-90,000 packages, the overwhelming majority of which will never be installed on a headless server. They sit in `/var/lib/apt/lists`, consuming space and bandwidth on every container, on every host, on every update cycle, indefinitely.

debthin serves curated `Packages.gz` indexes filtered to ~6,700-7,500 server-relevant packages - admin, database, devel, networking, interpreters, libs, web and related sections. Desktop, GUI, games, fonts and hardware-specific packages are excluded. The result is an index 90-93% smaller than upstream. Everything else - the actual `.deb` files - redirects transparently to the official mirrors. Nothing is rehosted.

The list is rebuilt daily from upstream Packages files, ranked by popcon install counts with a minimum threshold of 2,500 reported installations. Obscure but legitimate packages can be added via pull request.

## Architecture

```
apt client
  │
  ├── GET dists/trixie/InRelease                      → Cloudflare R2 (signed)
  ├── GET dists/trixie/main/binary-amd64/Packages.gz → Cloudflare R2 (~6700 pkgs)
  └── GET pool/main/a/apt/apt_2.x_amd64.deb          → 301 → deb.debian.org
```

## Suites & Architectures

### Debian

| Suite                | Architectures                  |
|----------------------|--------------------------------|
| forky                | amd64 arm64 armhf i386 riscv64 |
| trixie, trixie-updates | amd64 arm64 armhf i386 riscv64 |
| bookworm, bookworm-updates | amd64 arm64 armhf i386   |
| bullseye, bullseye-updates | amd64 arm64 armhf i386   |

Components: `main contrib non-free non-free-firmware` (bullseye: no `non-free-firmware`)

### Ubuntu

| Suite                          | Architectures         |
|--------------------------------|-----------------------|
| jammy (22.04 LTS), noble (24.04 LTS), plucky (25.04), questing (25.10), resolute (26.04 LTS) | amd64 i386 arm64 riscv64 |
| \*-updates, \*-backports       | same as base suite    |

Components: `main restricted universe multiverse`

### Raspbian

| Suite    | Architectures |
|----------|---------------|
| bookworm | armhf         |
| bullseye | armhf         |

Components: `main rpi` (bullseye: `main` only)

Security goes direct for all distros - keep it independent of debthin.

## Setup

### Install key

The same GPG key covers both Debian and Ubuntu.

If `gpg` is available:

```bash
curl -fsSL http://debthin.org/debthin-keyring.gpg \
  | gpg --dearmor \
  | tee /etc/apt/trusted.gpg.d/debthin.gpg > /dev/null
```

Without `gpg` (binary key, works on bare containers):

```bash
curl -fsSL http://debthin.org/debthin-keyring-binary.gpg \
  -o /etc/apt/trusted.gpg.d/debthin.gpg
```

### Debian - /etc/apt/sources.list.d/debthin.sources

```
Types: deb
URIs: http://debthin.org
Suites: trixie
Components: main contrib non-free non-free-firmware
Signed-By: /etc/apt/trusted.gpg.d/debthin.gpg

Types: deb
URIs: https://security.debian.org/debian-security
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

### Ubuntu - /etc/apt/sources.list.d/debthin.sources

```
Types: deb
URIs: http://debthin.org
Suites: noble
Components: main restricted universe multiverse
Signed-By: /etc/apt/trusted.gpg.d/debthin.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
```

### /etc/apt/apt.conf.d/99thin

apt fetches package indexes uncompressed by default. This config tells apt to request `.gz` indexes and store them compressed on disk - cutting index storage from ~80-210MB to ~5-15MB. Translation files add another ~30MB for languages you'll never use on a headless server; stripping those is free.

```
// Strip translation files and use compressed indexes
Acquire::Languages "none";
Acquire::GzipIndexes "true";
Acquire::CompressionTypes::Order:: "gz";
```

## Configuration & Curation

Distributions, aliases, and architectures are centrally defined in `config.json`.

Curated package lists are organized by distribution and suite:
```
curated/<distro>/<suite>/all.txt     ~6,700-7,500 server packages + dependencies
required_packages/                   manual dependency overrides
```

To ensure a specific package is always included, add it to the appropriate override file, commit, and push. Overrides apply automatically in this order of precedence falling back to general defaults:
1. `required_packages/<distro>/<suite>.txt`
2. `required_packages/<distro>.txt`
3. `required_packages/debian.txt`

To rebuild lists dynamically from Debian popcon:
```bash
python3 scripts/debthin/curate.py --distro debian --suite trixie --arch amd64
```

Or trigger via GitHub Actions with `force_recurate: true`.

## Running locally

The build pipeline is orchestrated by a Makefile at `scripts/debthin/Makefile`.

```bash
export GPG_KEY_ID=<fingerprint>
export R2_ACCOUNT_ID=<id>
export R2_ACCESS_KEY=<key>
export R2_SECRET_KEY=<secret>
export R2_BUCKET=debthin

# Full pipeline via wrapper (CI-compatible)
bash scripts/debthin/build.sh

# Or call Make directly for more control
make -C scripts/debthin -j8
```

To build without uploading:
```bash
make -C scripts/debthin -j8 NO_UPLOAD=1
```

To run a single phase or target:
```bash
make -C scripts/debthin fetch                  # fetch upstream indexes
make -C scripts/debthin filter-debian/bookworm  # filter one suite
make -C scripts/debthin validate                # validate without upload
```

## Pipeline

Runs daily at 04:00 UTC. Re-curates from popcon on Sundays.

GitHub secrets required:

| Secret | Value |
|--------|-------|
| `GPG_PRIVATE_KEY` | `gpg --armor --export-secret-keys mirror@debthin.org` |
| `GPG_KEY_ID` | key fingerprint |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY` | R2 access key ID |
| `R2_SECRET_KEY` | R2 secret access key |
| `R2_BUCKET` | R2 bucket name |
| `HEARTBEAT_URL` | Optional. Dead-man's-switch ping URL (see Monitoring) |

Set secrets with `printf %s`, not `echo` - a trailing newline in any R2 value
breaks the upload recipe's shell quoting:

```bash
printf %s 'VALUE' | gh secret set R2_SECRET_KEY
```

`build.sh` rejects whitespace in these values up front and names the offending
variable, rather than letting it reach `/bin/sh`.

## Monitoring

After upload, the pipeline fetches the published `status.json` and fails if the
`built_at` it finds is not recent - verifying what users are actually served,
not just what the build produced.

Use `status.json`, not the `Date` field in `InRelease`, for freshness. debthin
copies `Date` from upstream, so a base suite such as `ubuntu/noble` reports its
2024 release date indefinitely and is not a staleness signal.

```bash
python3 scripts/debthin/check_freshness.py --max-age-hours 48
```

That check only runs when the workflow runs. GitHub disables `schedule:`
workflows after 60 days of repo inactivity, which in 2026 froze the indexes for
~3.5 months with no alert. To catch that, set `HEARTBEAT_URL` to a dead-man's
-switch endpoint (healthchecks.io, Better Stack, or similar) configured to
alert when a daily ping stops arriving. The workflow pings it on success and
skips silently when the secret is unset.

## Trademark notice

Debian is a registered trademark of [Software in the Public Interest, Inc](https://www.spi-inc.org/). Ubuntu is a registered trademark of Canonical Ltd. debthin is an independent project and is not affiliated with, endorsed by, or sponsored by the Debian Project or Canonical. Use of the names "deb" and "ubuntu" refers to the respective package formats and ecosystems, consistent with their trademark policies for software that works with these systems. debthin does not redistribute packages - all package files are served directly from official mirrors.
