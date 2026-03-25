/**
 * @fileoverview Utility functions for the image distribution worker.
 * Provides metadata classification, SWR cache patterns, and header resolution
 * that don't belong in the HTTP layer or the handler routing logic.
 */

import { indexCache } from './cache.js';
import { H_OCI_INDEX_JSON, H_TAR_XZ, H_CACHED, buildDerivedResponse } from './http.js';

/** Size threshold in bytes. Files at or below this are served from cache. */
export const METADATA_SIZE_LIMIT = 102400;

/**
 * Resolves frozen headers for a metadata file based on its extension.
 *
 * @param {string} filename - Basename of the file.
 * @returns {Object} Frozen header set with the appropriate Content-Type.
 */
export function headersForMetadata(filename) {
    if (filename.endsWith('.json')) return H_OCI_INDEX_JSON;
    if (filename.endsWith('.tar.xz')) return H_TAR_XZ;
    return H_CACHED;
}

/**
 * Serves a cached L1 target (LXC/Incus indexes). If the cache is empty,
 * hydrates from R2 first. If stale, serves existing data and triggers
 * a background refresh via ctx.waitUntil.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @param {Object} ctx - Worker execution context.
 * @param {string} cacheKey - The LRU cache key to look up.
 * @param {Object} baseHeaders - Frozen header set for the response.
 * @param {Function} hydrateFn - Async function to hydrate state from R2.
 * @returns {Promise<Response>} Cached or freshly-hydrated response.
 */
export async function serveL1Target(request, bucket, ctx, cacheKey, baseHeaders, hydrateFn) {
    let cached = indexCache.get(cacheKey);
    if (!cached) {
        await hydrateFn(bucket);
        cached = indexCache.get(cacheKey);
        if (!cached) return new Response("Not Found", { status: 404 });
    } else if (Date.now() - cached.addedAt > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(hydrateFn(bucket).catch(() => { }));
    }
    return buildDerivedResponse(request, cached.meta, request.method === "HEAD" ? null : cached.buf, true, cached.hits, baseHeaders);
}

/**
 * Fetches an R2 object and stores it in the LRU cache. Returns the cache
 * entry (buf + meta). Used by both serveR2Static and handleImageMetadata
 * to avoid duplicating the fetch-and-cache pattern.
 *
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @param {string} key - The R2 object key.
 * @returns {Promise<{buf: ArrayBuffer, meta: Object}|null>} Cache entry or null if not found.
 */
export async function fetchAndCache(bucket, key) {
    const obj = await bucket.get(key);
    if (!obj) return null;

    const buf = await obj.arrayBuffer();
    const now = Date.now();
    const meta = {
        etag: obj.etag || `W/"${buf.byteLength}"`,
        lastModified: now,
        lastModifiedStr: new Date(now).toUTCString()
    };
    indexCache.add(key, buf, meta, now);
    return { buf, meta };
}
