# debthin Worker Architecture

The Cloudflare Worker codebase is logically structured into separated domains to enforce strict boundaries between network primitives and application specific routing.

## 1. Core Primitives (`workers/core/`)
The foundation layer of the worker. Contains generic, highly-optimized components that have zero knowledge of Debian repositories or the "debthin" application domain.

- **`cache.js`**: LRU array cache implementing purely fast typed arrays. Exposes distinct tiers (e.g., `metaCache` and `dataCache`) for memory allocation but enforces no application-specific routing.
- **`r2.js`**: Pure Cloudflare Bucket interactions (`r2Get`, `r2Head`). It orchestrates background network queues and memory caching layers, but executes no payload evaluation.
- **`http.js`**: Standard HTTP formatting structures. Calculates `304 Not Modified` states, executes GZIP streaming (`DecompressionStream`), and applies generic HTTP headers.
- **`utils.js`**: Shared zero-allocation utility functions for parsing URLs mapping generic string logic.
- **`config.js`**: Parses and enforces the runtime boundaries defined in `config.json`.

## 2. Standard Application Domain (`workers/debthin/`)
The primary traffic controller executing logic tailored specifically for the Debian package ecosystem (debthin).

- **`indexes.js`**: Debthin-specific. Scans textual `InRelease` payloads and populates the global `_hashIndexes` structures in RAM, creating translation layers for `by-hash` endpoints.
- **`index.js`**: Top-level routers filtering requests for standard static assets, alias evaluations, directory traversal blocks, and executing distribution route targets.
- **`packages.js` / `release.js`** (as utilized): Component layers managing specific payload transformations (like discarding PGP wrappers or dispatching empty files locally).

## 3. Proxy Domain (`workers/proxy/`)
Virtual vendor sandboxing routes mapped to remote Upstreams (like Grafana and Redis).

- **`handlers/index.js`**: Dispatches proxy calls across metadata (`Release`), and packaging targets. Identifies caching staleness natively.
- **`packages.js`**: Executes deep Debian stream parsing. Evaluates exact `Depends: ` chains, drops conflicting payload stanzas, bounds to mapped library versions, and recompiles dynamic gzip proxy binaries. 
- **`utils.js` / `version.js`**: Proxies cryptography evaluation hashes and calculates exact Debian epoch/upstream character weights.

## 4. Container Image Domain (`workers/images/`)
Serves container image metadata and binary downloads for Classic LXC, Incus/LXD, and OCI clients.

**Pipeline Architecture:**

Unlike the proxy layer which evaluates streams at the edge, the images worker consumes a pre-compiled `registry-state.json` built by `scripts/generate_image_manifest.py` during CI. This eliminates runtime R2 `list()` calls entirely.

1. **Pre-compiled State (`registry-state.json`):**
   - Built by the CI pipeline, containing all index payloads (`lxc_csv`, `incus_json`), OCI lookup dictionaries (`oci_blobs`, `oci_manifests`), and a `file_sizes` map for routing classification.
   - Hydrated into the L1 LRU cache on first request via `hydrateRegistryState()`, with stale-while-revalidate refresh on subsequent requests.
2. **Size-Based Metadata Caching:**
   - Files ≤100KB (metadata like `incus.tar.xz`, `meta.tar.xz`, OCI index) are served from the LRU cache, fetched from R2 on miss.
   - Files >100KB (rootfs binaries, large OCI blobs) are 301-redirected to the unmetered R2 public domain.
   - `oci-layout` is hardwired as a static immutable response.
3. **Module Structure:**
   - `index.js` — Request validation and top-level dispatch.
   - `handlers/index.js` — Route handlers, `routeImagePath` classifier, SWR cache serving.
   - `indexes.js` — State hydration and OCI/file-size map accessors.
   - `http.js` — Pre-encoded static payloads, frozen header sets, conditional response builder.
   - `cache.js` — Shared LRU cache instance (256 slots, 20MB).

