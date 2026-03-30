/**
 * Shared type definitions for the debthin Cloudflare Workers codebase.
 * Consumed by tsc --noEmit via tsconfig.json. Never imported at runtime.
 */

// ── Environment Bindings ─────────────────────────────────────────────────────

/**
 * Environment bindings for the main debthin worker.
 * Matches workers/wrangler.toml r2_buckets and vars.
 */
interface DebthinEnv {
    DEBTHIN_BUCKET: R2Bucket;
    ADMIN_SECRET?: string;
}

/**
 * Environment bindings for the images worker.
 * Matches workers/wrangler-images.toml r2_buckets and vars.
 */
interface ImagesEnv {
    IMAGES_BUCKET: R2Bucket;
    PUBLIC_R2_URL?: string;
    ADMIN_SECRET?: string;
}

/**
 * Environment bindings for the proxy worker.
 * Matches workers/wrangler-proxy.toml r2_buckets and vars.
 */
interface ProxyEnv {
    DEBTHIN_BUCKET: R2Bucket;
    ADMIN_SECRET?: string;
}

/**
 * Union type for shared core code that accepts any worker's env.
 * Functions in core/ that access env should use this or a more specific interface.
 */
type Env = DebthinEnv | ImagesEnv | ProxyEnv;

/**
 * Subset interface for core modules (r2.js, http.js) that access DEBTHIN_BUCKET.
 * The images worker uses its own R2 access pattern and never calls these.
 */
interface HasDebthinBucket {
    DEBTHIN_BUCKET: R2Bucket;
    ADMIN_SECRET?: string;
}

// ── LRU Cache Types ──────────────────────────────────────────────────────────

/**
 * A single entry returned by LocalCache.get().
 */
interface CacheEntry {
    buf: ArrayBuffer;
    meta: Record<string, any>;
    hits: number;
    addedAt: number;
}

/**
 * The object returned by the LRUCache() factory function (core/cache.js).
 */
interface LocalCache {
    ttl: number;
    pending: Map<string, Promise<any>>;
    add(key: string, buf: ArrayBuffer, meta: Record<string, any>, now: number, pinned?: boolean): void;
    get(key: string): CacheEntry | null;
    has(key: string): boolean;
    updateTTL(key: string, now: number): void;
    purge(key?: string): void;
    getStats(): { items: number; bytes: number; limit: number };
}

// ── R2 Wrapper Types ─────────────────────────────────────────────────────────

/**
 * The unified object shape returned by wrapCachedObject() and used by
 * serveR2(), r2Head(), and r2Get(). Mirrors a subset of the R2ObjectBody
 * interface with added cache tracking fields.
 */
interface WrappedR2Object {
    readonly body: ArrayBuffer | ReadableStream | null;
    httpMetadata: Record<string, any>;
    etag: string;
    lastModified: number | null;
    contentLength: number;
    isCached: boolean;
    hits: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
}

// ── Proxy Route Types ────────────────────────────────────────────────────────

/**
 * Parsed proxy route object returned by parseProxySuitePath() in proxy/utils.js.
 */
interface ParsedProxyRoute {
    host: string;
    suite: string;
    component: string;
    type: string;
    pin?: string | null;
    arch?: string;
    gz?: boolean;
}

// ── JSON Module Declaration ──────────────────────────────────────────────────

declare module "../../config.json" {
    const value: Record<string, any>;
    export default value;
}
