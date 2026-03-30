# The "Forbidden JavaScript" Guide (Anti-Patterns)

This codebase does not run in a standard browser or a persistent Node.js server. It runs inside high-concurrency Cloudflare Worker V8 Isolates. Our architectural mandate is **Zero-Allocation on the Hot Path**.

Standard "clean" or "functional" JavaScript conventions often trigger V8 Garbage Collection (GC) pauses or de-optimize the compiler. In this repository, standard JavaScript can be a catastrophic performance bug.

Before submitting a PR, ensure your code avoids the following forbidden patterns.

---

### 1. URL Parsing
The native `URL` constructor is a massive object allocation sink. Creating one per request will destroy our P99 latency.

*  **Forbidden:** `const url = new URL(request.url);`
*  **Use:** `const { protocol, rawPath } = parseURL(request);` (from `core/utils.js`)

### 2. Path Segmentation
Dynamic arrays created by `.split()` trigger heap allocations. We use hardwired hidden classes to keep V8 ICs (Inline Caches) hitting 100% of the time.

*  **Forbidden:** `const parts = request.url.split('/');`
*  **Use:** `const tokens = tokenizePath(rawPath);` (from `core/utils.js`)
*  *Note:* `tokenizePath` guarantees a stable object shape (`p0` through `p4`). Do not add dynamic keys to this object.

### 3. Regular Expressions on the Hot Path
Regex execution paths are unpredictable and subject to ReDoS attacks. On the hot routing path (L1 lookup → response), we use O(N) linear string sweeps instead.

*  **Forbidden on route handlers:** `if (/^[a-f0-9]{64}$/.test(hash))`
*  **Use:** `if (isHex64(hash))` (from `core/utils.js`) or manual `indexOf` checks.
*  *Exception:* Regex is acceptable in cold-boot config parsing (`core/config.js`) and in decompressed payload processing (`proxy/packages.js`), where the cost is amortized over many requests.

### 4. Functional Array Methods & Spread Syntax on the Hot Path
Creating intermediate arrays via `.map()`, `.filter()`, or spreading `[...a, ...b]` forces the V8 GC to clean up dead wrappers.

*  **Forbidden in route handlers:** `const active = items.filter(i => i.valid).map(i => i.id);`
*  **Use:** Standard, imperative `for` loops pushing to a pre-allocated array or a `TypedArray`.
*  *Exception:* `.filter(Boolean)` on short, fixed-length arrays during cold-boot config derivation (e.g. `core/config.js`) is acceptable.

### 5. Dynamic Object Keys (Dictionary Mode)
Adding random keys to an object at runtime forces V8 to abandon its optimized C++ struct representation (Hidden Classes) and fall back to a slow hash map (Dictionary mode).

*  **Forbidden:** `const cache = {}; cache[dynamicUserString] = data;`
*  **Use:** `Map` objects (`new Map()`) for arbitrary key-value storage, or strictly pre-define all keys if using standard objects.

### 6. Dynamic JSON Parsing on the Hot Path
Calling `JSON.parse` or `JSON.stringify` on inbound request properties blocks the main thread.

*  **Forbidden:** Parsing complex payloads inside the router:
   ```js
   async function handleRequest(request) {
     const config = JSON.parse(await request.text()); // Blocks the hot path
   }
   ```
*  **Use:** Pre-compute JSON payloads during the global cold-boot phase and serve the raw string from RAM:
   ```js
   // core/config.js — runs once at isolate startup
   export const { CONFIG_JSON_STRING } = (() => {
     return { CONFIG_JSON_STRING: JSON.stringify(configData) };
   })();
   ```

### 7. Unnecessary `async` on Synchronous Cache Reads
The L1 cache lookup (`cache.get(key)`) is synchronous. Wrapping it in an `async` function adds an unnecessary microtask round-trip on every cache hit.

*  **Forbidden:**
   ```js
   async function lookup(key) {
     return cache.get(key); // Returns a Promise wrapping a synchronous value
   }
   ```
*  **Use:** Keep the L1 read path synchronous. Only introduce `async` at the point where you actually need to `await` an R2/upstream fetch.