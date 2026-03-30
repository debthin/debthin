# debthin Worker Architecture & Onboarding

Welcome to the `debthin` Edge architecture. This system operates at bare-metal speeds (P50 <1ms, P999 <3ms). To maintain this, you must understand how V8 Isolates behave under extreme concurrency.

Read this document and [`ANTI_PATTERNS.md`](./ANTI_PATTERNS.md) before modifying any routing handlers or core utilities.

---

## 1. Project Layout

This repository contains **three independent Cloudflare Workers**, each with its own `wrangler.toml`, R2 bucket binding, and env type:

| Worker | Directory | Env Type | Purpose |
|---|---|---|---|
| debthin | `workers/debthin/` | `DebthinEnv` | APT mirror — InRelease, Packages, by-hash |
| images | `workers/images/` | `ImagesEnv` | OCI/LXC container image registry |
| proxy | `workers/proxy/` | `ProxyEnv` | Filtered APT proxy (Grafana, Redis, etc.) |

All three share `workers/core/` — the generic cache, R2, HTTP, and routing library with no domain knowledge. Type contracts for all env interfaces live in `workers/types.d.ts`.

For a detailed per-file breakdown of each domain, see [`index.md`](./index.md).

**Entry point:** Every worker's `index.js` exports `wrapHandler(handler, serviceName)` (from `core/admin.js`). This is the function Cloudflare calls, the error boundary, and the source of `X-Timer`/`X-Served-By` headers. The env type flows end-to-end via a `@template E` generic — if your handler declares `@param {DebthinEnv} env`, tsc enforces that at the module boundary.

---

## 2. The V8 Isolate Lifecycle

Cloudflare Workers do not behave like traditional Node.js servers. They spin up instantly (Cold Boot) and stay alive (Warm) as long as traffic dictates, before being silently evicted.

* **Global Scope (Cold Boot):** Code executed *outside* the `fetch()` handler runs exactly once per Isolate lifecycle. This is where we allocate memory, parse static configuration files, and instantiate our RAM caches.
* **Request Scope (Hot Path):** Code executed *inside* `handleRequest`. This must be tightly optimized. Every CPU cycle spent here delays the socket response.
* **Time:** `Date.now()` does not advance in the global scope to prevent side-channel attacks. It only advances inside the request handler.

## 3. Concurrency & The Cache Stampede

A single V8 Isolate handles hundreds of concurrent requests on the *same thread*.

If 50 requests ask for the same upstream file simultaneously, and you do not coordinate them, you will trigger 50 outbound R2/Upstream fetches.
**This is why `cache.pending` exists.**

Before fetching any remote asset, the system checks `cache.pending.has(key)`. If true, it `await`s the shared Promise. **Never bypass this coalescence lock.**

## 4. The L1 Memory Architecture

Our `LRUCache` (`core/cache.js`) bypasses traditional doubly-linked list implementations. Wrapper objects cause GC pauses. Instead, we use contiguous C-style memory blocks: `Uint32Array`, `Float64Array`, and `Int32Array`.

If you modify the cache layer, you must pass primitive numbers or pre-allocated `ArrayBuffers`. Injecting a standard JS Object into these TypedArrays will instantly crash the cache logic.

## 5. The `ctx.waitUntil()` Illusion

We rely heavily on Stale-While-Revalidate (SWR). We serve stale data from the L1 RAM cache instantly, and use `ctx.waitUntil(promise)` to fetch fresh data and update the cache in the background.

**Danger:** `waitUntil` executes *after* the client socket closes. Do not reference short-lived request objects (like reading a request stream) inside a `waitUntil` closure, as they will be destroyed before the closure executes.

## 6. Request Flow Decision Tree

Every data fetch follows this strict hierarchy (see `core/r2.js` → `r2Get`):

1. **L1 Warm (RAM):** Is it in the `LRUCache` TypedArrays and not expired? → *Serve instantly (<1ms).*
2. **Flight Check:** Is the same key currently in `cache.pending`? → *Await the in-flight promise, then re-check L1.*
3. **L2 Warm (Colo Cache):** Is it in the Cloudflare Datacenter Cache API (`caches.default`)? → *Fetch, hydrate L1 RAM, serve.*
4. **Cold Path (R2):** Fetch from the R2 bucket. Stream to client immediately.
5. **Background:** Use `waitUntil` to write the result to L2 and L1 for the next request.

## 7. Type Safety (The `tsc` Harness)

Because standard JavaScript allows too much runtime ambiguity (which causes V8 de-opts), we strictly enforce types using JSDoc and TypeScript's compiler.

* **Zero-Build Step:** We use `tsc --noEmit` via `checkJs`. We get full Language Server (LSP) autocomplete and CI compile-time safety, but the code shipped to the edge is 100% vanilla JavaScript. No polyfills, no Babel bloat.
* **Global Contracts:** All environment bindings (`R2Bucket`, `ADMIN_SECRET`) are strictly defined in `workers/types.d.ts`.
* **Validation:** Run `npx tsc --noEmit` (or `npm run typecheck`). If the compiler throws an error, your code will fail CI. Do not suppress null checks wildly or inject `any` types into the hot path; map your data structures to satisfy the compiler.

## 8. Unit Testing

Our custom zero-allocation routing logic (`tokenizePath`, `parseURL`, etc.) is extremely delicate. A single off-by-one error in a manual `indexOf` sweep will break the router.

* **The Test Suite:** Located in `workers/tests/unit/`.
* **Execution:** `node --test tests/unit/*.test.js` (from the `workers/` directory).
* **The Testing Trap:** *Unit tests only verify correctness, not performance.* Passing the unit tests means your code returns the right string. It does **not** mean your code is safe to deploy. You must combine unit testing with local heap snapshot profiling to ensure you haven't introduced stealth memory allocations.

## 9. Local Profiling & Regression

If you introduce a memory allocation on the hot path, production performance will drop. Prove your code is safe before opening a PR.

1. **Run Locally:** `npx wrangler dev --local`
2. **Inspect:** Open Chrome and navigate to `chrome://inspect`. Connect to the dedicated DevTools for the Worker.
3. **Snapshot:** Take a Memory Heap Snapshot. Send 10,000 requests using `k6` or `autocannon`. Take another snapshot. If your code is leaking wrapper objects or triggering heavy GC sweeps, rewrite it.