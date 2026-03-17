# debthin — Architecture

debthin is a Cloudflare Worker that acts as a curated, caching apt repository proxy. It serves Debian and Ubuntu package indices from an R2 bucket, handling the full range of requests an apt client makes during `apt update`: release files, package indices, by-hash lookups, and `.deb` redirects.

---

## Request lifecycle

```
apt client
    │
    ▼
CF edge (HTTP/1.1 termination, TLS)
    │
    ▼
fetch() handler
    │  adds X-Timer, X-Served-By
    ▼
handleRequest()
    │
    ├── method/query/path guard → 400/405 (bare, no headers)
    ├── robots.txt / config.json → synthetic response
    ├── pool/ → 301 to upstream (Location only)
    ├── unknown distro → 404 (bare)
    │
    └── dists/{distro}/...
            │
            ├── suite alias resolution (e.g. stable → bookworm)
            ├── InRelease / Release.gpg → serveR2()
            ├── Release → serveR2(fetchKey=InRelease, transform=strip-pgp)
            ├── binary-{arch}/Release → generated inline
            ├── Packages → serveR2(fetchKey=Packages.gz, transform=decompress)
            ├── Packages.{gz,lz4,xz} → serveR2()
            ├── by-hash/SHA256/{hash}
            │       ├── known empty hash → synthetic
            │       └── lookup in _hashIndexes → serveR2(immutable)
            └── unmatched → 301 to upstream
```

---

## Isolate cache

The primary performance mechanism. All R2 objects are cached in isolate RAM for the lifetime of the isolate, avoiding repeated R2 round-trips within a warm isolate.

### Structure

Fixed 256-slot cache using parallel arrays. Slot state lives entirely in typed arrays to avoid GC pressure on the hot path:

| Array | Type | Purpose |
|---|---|---|
| `_cacheIndex` | `Map<string, uint8>` | key → slot number |
| `_cacheBuf` | `Array[256]` | `ArrayBuffer` payload |
| `_cacheMeta` | `Array[256]` | metadata object (`etag`, `lastModified`, `contentType`) |
| `_cacheKey` | `Array[256]` | key string (needed for eviction) |
| `_cacheHits` | `Int32Array[256]` | per-slot hit counter |
| `_cacheLastUsed` | `Uint32Array[256]` | logical clock value at last access |
| `_cacheBytes` | `Int32Array[256]` | `buf.byteLength` (avoids re-reading `ArrayBuffer`) |

Plain arrays (`_cacheBuf`, `_cacheMeta`, `_cacheKey`) are pre-filled with `null` at module load to ensure V8 allocates a dense `PACKED_ELEMENTS` backing store immediately, avoiding hole-check overhead.

### Hot path

A cache read is: one `Map.get` on `_cacheIndex`, two `Uint32Array` writes (`_cacheHits`, `_cacheLastUsed`). No object allocation, no GC pressure, no delete/re-insert.

### LRU eviction

Two eviction triggers:

1. **Slot limit** (primary): when all 256 slots are occupied, `_evictLRU()` scans `_cacheLastUsed` for the minimum value — O(256) over a contiguous typed array. Runs only when the cache is full.
2. **Byte ceiling** (secondary, 96 MB): guards against a small number of very large objects exhausting RAM before the slot limit is reached.

### Logical clock

`_cacheClock` is a `Uint32` incremented on every cache access via `(_cacheClock + 1) >>> 0`. Integer arithmetic, no syscall. Wraps safely at 2³² — evicted slots are zeroed, so the minimum value in `_cacheLastUsed` remains the LRU slot across a wrap.

### `lastModified` storage

Stored as a Unix ms timestamp (`Date.getTime()`), not a UTC string. `isNotModified` compares the integer directly against `Date.parse(If-Modified-Since)`, avoiding a second `Date.parse` on every conditional request. Converted to UTC string only at response time when writing the `Last-Modified` header.

---

## Cache warming

When `r2Get` fetches an `InRelease` or `Release` file, it fires `warmRamCacheFromRelease` as a background task via `ctx.waitUntil`. This parses the SHA256 section of the release file and:

1. **Pre-populates empty files**: entries whose hash matches the known SHA256 of an empty file or empty gzip are inserted into the isolate cache immediately as synthetic buffers, so subsequent by-hash requests for these never hit R2.

2. **Builds the hash index**: for each `.gz` entry, maps `sha256 → relative path` in `_hashIndexes[distro]`. This allows by-hash requests to resolve to the correct R2 key without an R2 HEAD lookup.

The warm check in `r2Get` is a single `_hashIndexes.get(distro)` — skipped entirely if the index is already populated.

---

## Hash index (`_hashIndexes`)

A `Map<distro, Object>` mapping SHA256 hashes to relative R2 paths. Populated in two ways:

- **Background**: from `warmRamCacheFromRelease` when a Release file is fetched.
- **On demand**: the first by-hash request for an uncached distro triggers a fetch of `dists/{distro}/by-hash-index.json` from R2, which is a pre-built index of all known hashes. This fetch is raced safely using a Promise stored in `_hashIndexes` — concurrent requests await the same Promise and the resolved plain object is written back on resolution, so subsequent requests find a plain object rather than a settled Promise.

Hashes populated by `warmRamCacheFromRelease` take precedence over the JSON index via `Object.assign` ordering.

---

## Request dispatch (`handleRequest`)

Path parsing avoids `URL` construction and `String.split`. `parseURL` locates the path start with a single `indexOf`. `tokenizePath` extracts up to five path segments (`p0`–`p4`) using `indexOf` boundaries, producing no array allocation.

Dispatch order:

1. Method and query string rejection (bare 400/405).
2. Path traversal guard (`..` check → 400).
3. No-slash paths: `robots.txt`, `config.json`, R2 static assets.
4. First segment validated against `DERIVED_CONFIG` — unknown distros get a bare 404.
5. `pool/` prefix → immediate 301 to upstream (Location header only).
6. Suite alias resolution: if `p1` is not a known suite name, `aliasMap` is checked for a canonical name (e.g. `stable` → `bookworm`).
7. Structured dispatch on `p2`–`p4` for release files, package indices, and by-hash lookups.
8. Unmatched paths → 301 to upstream.

---

## `serveR2`

The hot-path response builder. Accepts a key, optional `fetchKey` override, optional `transform`, and an `immutable` flag.

- **HEAD without transform**: calls `r2Head` (metadata only, no body fetch).
- **GET or HEAD with transform**: calls `r2Get` (full buffer required).
- **304 check**: `isNotModified` checks ETag first (string equality), then `If-Modified-Since` (integer compare).
- **Response headers**: built as a plain object spread from `H_CACHED` or `H_IMMUTABLE` — no `Headers` construction or cloning on the hot path. Per-request fields (ETag, Last-Modified, Content-Type, hit counts) set as direct property assignments.

### Transforms

| Value | Effect |
|---|---|
| `strip-pgp` | Strips PGP armour from `InRelease` to produce a plain `Release`. Fetches `InRelease` from R2 regardless of the requested key. |
| `decompress` | Gunzips a `Packages.gz` on the fly via `DecompressionStream`. Feeds the buffer directly into the stream writer rather than piping through a `Response` body. |

---

## Config (`DERIVED_CONFIG`)

Loaded once at module load from `../config.json`. Each distro entry is pre-processed into:

- `upstream` — hostname only (protocol stripped)
- `components` — `Set<string>` for O(1) lookup
- `arches` — `Set<string>` including `"all"`, merged from all arch arrays
- `suites` — `Set<string>` of canonical suite names
- `aliasMap` — `Map<alias, canonical>` for suite name resolution

`CONFIG_JSON_STRING` is the serialised config served at `/config.json`.

---

## Header policy

Three frozen plain objects defined at module load:

- `H_BASE` — security headers only (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-Xss-Protection`, `Permissions-Policy`, `X-Clacks-Overhead`)
- `H_CACHED` — `H_BASE` + `Cache-Control: public, max-age=3600, no-transform`
- `H_IMMUTABLE` — `H_BASE` + `Cache-Control: public, max-age=31536000, immutable, no-transform`

`no-transform` is present on all cached responses to prevent intermediate proxies from re-encoding compressed content that apt clients expect to receive verbatim.

Error and redirect responses carry the minimum headers required by spec:
- 400 — bare
- 404 (unknown distro/hash) — bare
- 405 — `Allow: GET, HEAD` only (RFC 7231 requirement)
- 301 — `Location` only

The outer `fetch` handler appends `X-Timer` and `X-Served-By` via a single `Headers` clone after `handleRequest` returns. This is the only unavoidable header clone in the entire request path.

---

## Bindings

| Binding | Type | Purpose |
|---|---|---|
| `DEBTHIN_BUCKET` | R2 | Source of truth for all package index files |