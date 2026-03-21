# debthin Worker Architecture

The Cloudflare Worker codebase is logically structured into separated domains to enforce strict boundaries between network primitives and application specific routing.

## 1. Core Primitives (`worker/core/`)
The foundation layer of the worker. Contains generic, highly-optimized components that have zero knowledge of Debian repositories or the "debthin" application domain.

- **`cache.js`**: LRU array cache implementing purely fast typed arrays. Exposes distinct tiers (e.g., `metaCache` and `dataCache`) for memory allocation but enforces no application-specific routing.
- **`r2.js`**: Pure Cloudflare Bucket interactions (`r2Get`, `r2Head`). It orchestrates background network queues and memory caching layers, but executes no payload evaluation.
- **`http.js`**: Standard HTTP formatting structures. Calculates `304 Not Modified` states, executes GZIP streaming (`DecompressionStream`), and applies generic HTTP headers.
- **`utils.js`**: Shared zero-allocation utility functions for parsing URLs mapping generic string logic.
- **`config.js`**: Parses and enforces the runtime boundaries defined in `config.json`.

## 2. Standard Application Domain (`worker/debthin/`)
The primary traffic controller executing logic tailored specifically for the Debian package ecosystem (debthin).

- **`indexes.js`**: Debthin-specific. Scans textual `InRelease` payloads and populates the global `_hashIndexes` structures in RAM, creating translation layers for `by-hash` endpoints.
- **`index.js`**: Top-level routers filtering requests for standard static assets, alias evaluations, directory traversal blocks, and executing distribution route targets.
- **`packages.js` / `release.js`** (as utilized): Component layers managing specific payload transformations (like discarding PGP wrappers or dispatching empty files locally).

## 3. Proxy Domain (`worker/proxy/`)
Virtual vendor sandboxing routes mapped to remote Upstreams (like Grafana and Redis).

- **`handlers/index.js`**: Dispatches proxy calls across metadata (`Release`), and packaging targets. Identifies caching staleness natively.
- **`packages.js`**: Executes deep Debian stream parsing. Evaluates exact `Depends: ` chains, drops conflicting payload stanzas, bounds to mapped library versions, and recompiles dynamic gzip proxy binaries. 
- **`utils.js` / `version.js`**: Proxies cryptography evaluation hashes and calculates exact Debian epoch/upstream character weights.

## 4. Container Image Domain (`worker/images/`)
Generates metadata index structures mapping raw R2 objects to Classic LXC and Incus hypervisor manifest protocols.

**Architectural Flow Comparison (`images` vs `proxy` Critical Path):**

While the Proxy layer evaluates deep streaming algorithms, the Container Image index generators expose severe systemic architectural constraints when evaluating millions of R2 bucket objects under load:

1. **Absence of Background Stale-While-Revalidate (SWR):**
   - **Proxy**: Utilizes `ctx.waitUntil(env.DEBTHIN_BUCKET.put(...))` to fetch upstream dependencies exclusively in the background without natively blocking the client sockets.
   - **Images**: Traps the inbound socket synchronously during LRUCache TTL expiries, sequentially executing slow origin `Class 1` R2 `list({cursor})` pagination calls spanning thousands of objects before returning headers.
2. **Missing Persistent Tier-2 Architecture:**
   - **Proxy**: Fully persists generated metadata objects backing into the physical R2 bucket. Edge regions fetch this Tier 2 object statically if their RAM is bare.
   - **Images**: Relies completely on volatile memory. A Cloudflare Edge data-center reboot flushes the `indexCache`. The next hit natively forces an exhaustive, expensive physical scan of the storage bucket from scratch just to yield the index.
3. **Hazardous Edge Memory Bounds:**
   - **Proxy**: Pipes heavy textual artifacts sequentially through Web Streams (`new Response(gz).pipeThrough(new TextDecoderStream()).getReader()`), discarding useless nodes sequentially to preserve the strict 128MB V8 worker RAM limits natively.
   - **Images**: Aggregates all discovered bucket objects concurrently into a solitary massive structured JSON object and textual CSV schema in RAM prior to encoding them. This structure inherently risks an `Out of Memory` abort trajectory when the catalog scales upwards.
