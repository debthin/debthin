# Architecture: `debthin` Edge Image Server

## 1. System Overview

The `debthin` image distribution network utilizes a "Dumb Factory / Smart Edge" architecture. Rather than relying on a fragile Continuous Integration (CI) pipeline to maintain state and generate static indexes, the heavy lifting of state management is deferred entirely to a **Cloudflare Worker** at the edge.

The Worker acts as an intelligent API gateway sitting in front of a raw Cloudflare R2 object storage bucket. It dynamically maps the bucket's contents on the fly to serve the required metadata formats for different container hypervisors (Classic LXC and Incus/LXD).

## 2. Request Flow Diagram

```mermaid
sequenceDiagram
    participant Client as LXC / Incus Client
    participant Edge as Cloudflare Worker (Edge)
    participant R2 as R2 Bucket (Storage)
    participant Public as R2 Public Domain

    Client->>Edge: Request Metadata (e.g., /streams/v1/images.json)
    Edge->>Edge: Consult Local LRU Isolate
    alt Cache Fresh
        Edge-->>Client: Instantly Return JSON/CSV (HIT)
    else Cache Stale / Miss
        Edge-->>Client: Serve Stale Content (SWR) OR Block (MISS)
        Edge-xR2: Background Worker: list(prefix="images/debian/")
        R2--xEdge: Return Paginated Array (Paths, Sizes, SHA256)
        Edge-xEdge: Compute JSON/CSV & Cache Natively in RAM
    end
    
    Client->>Edge: Request Binary (e.g., /images/.../rootfs.tar.xz)
    Edge-->>Client: HTTP 301 Redirect -> PUBLIC_R2_URL
    Client->>Public: Download File directly
```

## 3. Core Responsibilities

The Worker is designed to be stateless and fast, adhering to four primary responsibilities:

### A. Dynamic Protocol Translation
Different hypervisors expect different protocols. The Worker reads the raw directory structure of the R2 bucket (`/images/{os}/{release}/{arch}/{variant}/{version}/`) and translates it into:
* **Classic LXC:** A flat semicolon-separated CSV (`index-system`).
* **Incus / LXD:** A nested JSON metadata tree (`simplestreams`).

### B. Resolving the CI Race Condition
When GitHub Actions build multiple architectures simultaneously (e.g., `amd64` and `arm64`), they upload files concurrently. If the CI pipeline attempted to write the `images.json` index, they would overwrite each other. 
By generating the index dynamically at the edge via an S3 `list` operation, the Worker guarantees a perfectly accurate, real-time reflection of the bucket with zero risk of file corruption.

### C. Background Generative Caching (SWR)
To circumvent V8 isolate cold-starts and strict CPU limits on 100k+ object buckets, the Worker leverages the `ctx.waitUntil` primitive. Inbound requests immediately serve available data from RAM utilizing a **Stale-While-Revalidate (SWR)** philosophy. Concurrently, the Worker spins up a background thread that executes an asynchronous R2 pagination loop, refreshing all internal indexes (`images.json`, `index-system`) natively for future traffic.

### D. Bandwidth Optimization (The 301 Pattern)
Cloudflare Workers have execution time limits and charge for CPU time. R2 public buckets offer free, unmetered egress. 
To optimize costs, the Worker **never** proxies the actual 32MB container binaries. If a client requests a binary file, the Worker instantly returns an `HTTP 301 Moved Permanently`, redirecting the client to download directly from the unmetered `env.PUBLIC_R2_URL` payload binding environment setting.

## 4. State & Hashing Strategy

Incus requires a `sha256` hash for every binary in its `images.json` manifest. Because a Worker cannot download and hash a 32MB file on the fly without timing out, the system uses **S3 Custom Metadata**.

1.  **The CI Phase:** The GitHub Action calculates the `sha256` hash of the tarball locally.
2.  **The Upload Phase:** The hash is attached to the R2 upload as a custom HTTP header (`--metadata "sha256=..."`).
3.  **The Edge Phase:** When the Worker queries the bucket, it requests the `customMetadata` payload. Cloudflare returns the pre-calculated hashes alongside the file paths instantly.

## 5. Routing Table

| Route | Client | Action | Cache Strategy |
| :--- | :--- | :--- | :--- |
| `/meta/1.0/index-system` | Classic LXC (`lxc-create`) | Generates flat CSV index mapping. | V8 Isolate SWR Engine |
| `/streams/v1/index.json` | Incus (`incus remote add`) | Serves static JSON pointer file. | V8 Isolate SWR Trigger |
| `/streams/v1/images.json` | Incus (`incus launch`) | Generates Simplestreams JSON tree. | V8 Isolate SWR Engine |
| `/images/*` | All Clients | `HTTP 301` to public runtime R2 endpoint. | Fast Lambda Redirect |
| `/`, `/robots.txt` | Spiders / Viewers | Active generic edge termination bounds. | V8 Isolate Memory |

## 6. Safety, Limits, and Fault Tolerances

* **Circuit Breakers:** A runaway R2 loop is strictly capped at `100` pages dynamically to prevent CPU time threshold terminations scaling linearly.
* **Corrupt Metadata Handlers:** Extracted nodes uploaded without requisite `.customMetadata.sha256` signatures are surgically bypassed by the iterator rather than manifesting as fatal literal gaps preventing client segmentation panics.
* **Domain Isolation:** The worker executes clean encapsulation. It imports generic configurations internally from `core/` to inherently bypass cross-contamination risks across the core upstream `debthin` proxy sequence logic.
* **HEAD Optimizations:** `HEAD` bandwidth dynamically exercises the full caching sequence but correctly evaluates memory allocations natively stripping stream outputs (`null`) conserving aggressive RAM bindings.

## 7. Performance & Scaling

* **Cost:** Because the R2 bucket handles the heavy binary egress for free, and the generative index cache drops native load loops asynchronously via the Stale-While-Revalidate sequence, millions of concurrent downloads compute natively on standard Cloudflare Free Tiers.
* **Maintenance:** The generative tier mandates zero active maintenance overhead. Integrating a new Linux iteration to the storage layer natively triggers edge manifestation upon the subsequent background SWR trigger block globally.