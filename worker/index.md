# debthin — Architecture

debthin is a Cloudflare Worker that acts as a curated, caching apt repository proxy. It serves Debian and Ubuntu package indices from an R2 bucket, handling the full range of requests an apt client makes during `apt update`: release files, package indices, by-hash lookups, and `.deb` redirects.

The core logic is divided into library components under `worker/core/` and isolated route handlers under `worker/handlers/` to keep the main edge router (`worker/index.js`) as robust and lean as possible.

---

## Request lifecycle

```
apt client
    │
    ▼
CF edge (HTTP/1.1 termination, TLS)
    │
    ▼
worker/index.js: fetch() handler
    │  adds X-Timer, X-Served-By
    ▼
worker/index.js: handleRequest()
    │
    ├── method/query/path guard → 400/405 (bare, no headers)
    ├── robots.txt / config.json → handlers: handleStaticAssets
    ├── pool/ → handlers: handleUpstreamRedirect (301 Location only)
    ├── unknown distro → 404 (bare)
    │
    └── dists/{distro}/...
            │
            ├── suite alias resolution (e.g. stable → bookworm)
            ├── InRelease / Release.gpg → handlers: handleDistributionHashIndex -> serveR2()
            ├── binary-{arch}/Release → handlers: handleDistributionHashIndex (generated inline)
            ├── Packages / Packages.gz → handlers: handleDistributionHashIndex -> serveR2()
            ├── by-hash/SHA256/{hash}
            │       └── handlers: handleByHash -> mapped to _hashIndexes -> serveR2(immutable)
            └── unmatched → handlers: handleUpstreamRedirect
```

---

## Route Handlers (`handlers/index.js`)

Decoupled endpoint logic isolating the complexity of distinct edge paths away from the main CF worker orchestrator:

- `handleStaticAssets`: rapidly returns synthetic objects for configurations unreliant on R2 bounds.
- `handleUpstreamRedirect`: blindly diverts unknown requests exactly to standard Debian/Ubuntu pools without invoking the isolate cache subsystem.
- `handleDistributionHashIndex`: resolves canonical suite identifiers mapping requests linearly against native metadata chunking formats.
- `handleByHash`: leverages the warmed hash table to proxy requests natively for exact SHA-verifiable payloads.

---

## Isolate cache (`core/cache.js`)

The primary performance footprint proxy. All R2 objects are cached identically inside the active isolate RAM pipeline for the lifetime of the thread context, bypassing R2 REST bandwidth entirely for heavily-warm node architectures.

### Structure

Fixed 256-slot bounds executing entirely in low-level typed array arrays to bypass JS memory and GC limits:

| Array | Type | Purpose |
|---|---|---|
| `_cacheIndex` | `Map<string, uint8>` | key → slot number |
| `_cacheBuf` | `Array[256]` | `ArrayBuffer` payload |
| `_cacheMeta` | `Array[256]` | metadata object (`etag`, `lastModified`, `contentType`) |
| `_cacheKey` | `Array[256]` | key string (needed for eviction) |
| `_cacheHits` | `Int32Array[256]` | per-slot hit counter |
| `_cacheLastUsed` | `Uint32Array[256]` | logical clock value at last access |
| `_cacheBytes` | `Int32Array[256]` | `buf.byteLength` (avoids re-reading `ArrayBuffer`) |

### LRU eviction

Two eviction triggers:

1. **Slot limit** (primary): when all slots are occupied, `_evictLRU()` scans `_cacheLastUsed` natively against a uint array.
2. **Byte ceiling** (secondary, 96 MB): guards dynamically against heavily scaled artifacts choking identical bounds.

The timestamp clock (`_now`) is globally synchronized natively exactly once per request across the isolate layout to ensure absolute eviction evaluation accuracy scaling cleanly.

---

## Cache warming and Hash Index (`core/r2.js`)

When `r2Get` fetches an `InRelease` file, it actively pipelines a `warmRamCacheFromRelease` `ctx.waitUntil` job evaluating directly without halting standard execution chains. This maps the native `sha256 → path` directly back against the globally available `_hashIndexes` object securely mapping subsequent incoming request payloads instantly on resolution!

---

## Transformers (`core/utils.js`)

Extracts string operations natively resolving distinct logic:
- Parses parameters out against simple `indexOf` loops bounding memory sizes
- Isolates `isHex64` verification rules guaranteeing hash integrities natively

---

## Constants (`core/constants.js`)

Native static parameters:

- `H_BASE` — strictly defines secure XSS boundary headers natively
- `H_CACHED` — appends aggressive native CDN TTL directives to payloads smoothly 

`no-transform` heavily populates most CDN bounds actively preventing intermediate architectures breaking compression formats APT natively anticipates executing correctly dynamically.

---

## Configuration (`core/config.js`)

Loaded once at module load from `../config.json`. Each distro entry is natively pre-processed dynamically extracting `aliases`, `arches`, and stripping protocol domains for rapid O(1) validations natively in edge environments.