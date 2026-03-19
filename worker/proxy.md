# debthin Proxy — Architecture

The `proxy.js` worker sandboxes third-party APT repositories (e.g., Grafana, Docker) on the Cloudflare edge. It filters dependency graphs, enforces exact version pins, and redirects final binary `.deb` downloads back to the vendor.

## Client Configuration (sources.list)

Because the proxy generates unsigned index files organically to bypass the need for centralized edge key management, clients must explicitly permit trusted downloads.

```text
deb [trusted=yes] https://deb.debthin.org apt.grafana.com/stable/main grafana==1.10
```

---

## Request Lifecycle & Path Structure

### 1. `dists/` Interception
```
GET /dists/apt.grafana.com/stable/main/grafana==1.10/binary-amd64/Packages.gz
```
The independent proxy worker translates the requested URL into:
- **Host**: `apt.grafana.com`
- **Suite**: `stable`
- **Component**: `main`
- **Version Pin (Optional)**: `grafana==1.10`
- **Architecture**: `amd64`
- **Target**: `Packages.gz`

### 2. Upstream Hydration
Based on the parsed path parameters, the proxy:
1. Queries the vendor's upstream index: `https://apt.grafana.com/dists/stable/InRelease`
2. Extracts the expected `SHA256` hash of the target `Packages.gz` payload.
3. Downloads the actual archive: `https://apt.grafana.com/dists/stable/main/binary-amd64/Packages.gz`.
4. Executes a cryptographic verification (`WebCrypto`) matching the downloaded payload against the upstream SHA256 constraint.

### 3. Dependency Formatting (`proxy/packages.js`)
The payload is decompressed and parsed:
1. **Reduce**: Eliminates all versions of a package except the highest one that satisfies the optional version pin (`==1.10`).
2. **Filter**: Scans the dependency tree, purging any package stanzas that lack satisfiable `Depends` or `Pre-Depends` within the remaining namespace.
3. **Rewrite**: Modifies the `Filename:` fields to route clients through the local proxy passthrough system (`/pkg/`).

---

## Generated Release Files

Unlike standard debthin distributions, the proxy synthesizes target `Release` and `InRelease` manifests. 

When an APT client requests a proxy metadata endpoint:
```
GET /dists/apt.grafana.com/stable/main/grafana==1.10/InRelease
```
The worker generates a synthetic payload inline:

```text
Origin: debthin-proxy
Label: debthin-proxy/apt.grafana.com
Suite: stable
Codename: stable
Date: Thu, 01 Jan 2026 00:00:00 GMT
Acquire-By-Hash: no
Description: debthin filtered proxy index for apt.grafana.com
```
This payload is cached in the local memory layer and downstream R2 bucket to serve subsequent client requests identically and rapidly evaluate ETags.

---

## Binary Passthrough (`/pkg/`)

To prevent Cloudflare from serving large binary files, the proxy rewrites the `Filename:` parameters inside the stripped `Packages.gz` index to prefix the originating domain with `/pkg/`.

Example rewritten payload field:
```
Filename: pkg/apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb
```

When the client executes an install sequence, it requests the deb from the proxy edge node:
```
GET /pkg/apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb
```

The independent `worker/proxy.js` process intercepts any `pkg/` prefix. It immediately issues an HTTP 301 Location Redirect directly back to the upstream vendor's original domain:
```http
HTTP/1.1 301 Moved Permanently
Location: https://apt.grafana.com/pool/main/g/grafana/grafana_1.10.deb
```
The client follows the redirect and downloads the binary payload entirely out-of-band locally.

---

## Edge Caching

The proxy leverages the central `core/r2.js` architecture for cache execution. 
Target payloads (like the processed `Packages.gz` and synthetic `InRelease` files) are written to a dedicated hierarchy in the `DEBTHIN_BUCKET`.

```
DEBTHIN_BUCKET
 └── proxy/{host}/{suite}/{component}=={pin}/{arch}/
      ├── Packages.gz       
      └── InRelease          
```

Freshness is enforced by reading HTTP `lastModified` properties off the R2 objects. If the cache is older than 1 hour or the client provides an `If-Modified-Since` header requesting an update, the proxy evaluates the upstream index to decide if synchronous refreshing is required.
