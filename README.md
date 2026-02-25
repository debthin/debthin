# debthin

Curated Debian package index mirror. Serves slim `Packages.gz` indexes from
Cloudflare KV. All actual `.deb` fetches redirect 301 to `deb.debian.org`.

**Result:** apt index files ~95% smaller. Package downloads unaffected.

## Architecture

```
apt client
  │
  ├── GET dists/trixie/InRelease          → Cloudflare KV (slim, signed)
  ├── GET dists/trixie/main/binary-amd64/Packages.gz  → Cloudflare KV (~5k pkgs)
  └── GET pool/main/a/apt/apt_2.x_amd64.deb  → 301 → deb.debian.org
```

## Suites

| Alias        | Codename  |
|--------------|-----------|
| testing      | forky     |
| stable       | trixie    |
| oldstable    | bookworm  |
| oldoldstable | bullseye  |

Aliases are resolved in the worker - `sources.list` can use either form.

## Architectures

`amd64`, `arm64`, `armhf`, `i386`, `riscv64`  
Note: `riscv64` only available for trixie and forky.

## Setup

### 1. Cloudflare

```bash
npm install -g wrangler
wrangler login

# Create KV namespace
wrangler kv:namespace create MIRROR_KV
wrangler kv:namespace create MIRROR_KV --preview
# Paste the IDs into wrangler.toml

# Deploy worker
wrangler deploy
```

### 2. GPG signing key

Generate a dedicated signing key (no expiry, no passphrase for CI use):

```bash
gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Debian Slim Mirror
Name-Email: mirror@example.com
Expire-Date: 0
%no-protection
EOF

gpg --list-keys mirror@example.com
# Note the fingerprint

# Export for GitHub secret
gpg --armor --export-secret-keys FINGERPRINT
```

Add to GitHub secrets:
- `GPG_PRIVATE_KEY` - output of above
- `GPG_KEY_ID` - fingerprint
- `CF_ACCOUNT_ID` - Cloudflare account ID
- `CF_API_TOKEN` - CF API token with KV write permission
- `CF_KV_NAMESPACE_ID` - from wrangler output above

### 3. Distribute public key to containers

```bash
gpg --armor --export FINGERPRINT > mirror-keyring.gpg
# Add to container images or LXC template:
cp mirror-keyring.gpg /etc/apt/trusted.gpg.d/slim-mirror.gpg
```

### 4. sources.list

```
deb [signed-by=/etc/apt/trusted.gpg.d/slim-mirror.gpg] https://YOUR_WORKER.workers.dev/ stable main
deb [signed-by=/etc/apt/trusted.gpg.d/slim-mirror.gpg] https://YOUR_WORKER.workers.dev/ stable-updates main
deb [signed-by=/etc/apt/trusted.gpg.d/slim-mirror.gpg] https://security.debian.org/debian-security stable-security main
```

Note: security.debian.org goes direct - its package set is small and
index filtering is less valuable there.

## Curation

`curated/packages.txt` - ~4000 server-relevant packages  
`curated/deps.txt` - ~1000 dependency packages  
`curated/all.txt` - combined, used by filter.py  

To add packages: edit `packages.txt`, commit, push. Next pipeline run picks it up.

To rebuild from popcon:
```bash
python3 scripts/curate.py --suite trixie --arch amd64
```

Or trigger manually via GitHub Actions with `force_recurate: true`.

## Pipeline

Runs daily at 04:00 UTC. Re-curates from popcon weekly (Sundays).

Secrets required in GitHub repository settings - see Setup above.
