/**
 * @fileoverview Route handlers for the image distribution CDN worker.
 */

import { isNotModified } from '../../core/http.js';
import { H_CACHED } from '../../core/constants.js';
import { indexCache } from '../cache.js';

const _textEncoder = new TextEncoder();

// ── R2 Listing Cache ─────────────────────────────────────────────────────────

const LISTING_CACHE_KEY = "_r2_listing";

/**
 * Fetches and caches the parsed R2 bucket listing.
 * Returns a structured array of image entries derived from object keys and metadata.
 * Respects the indexCache TTL and pending coalescing to avoid redundant list() calls.
 *
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @returns {Promise<Array<Object>>} Parsed image entries.
 */
async function getImageListing(bucket) {
    const now = Date.now();
    let cached = indexCache.get(LISTING_CACHE_KEY);
    if (cached && (now - cached.addedAt <= indexCache.ttl)) {
        return JSON.parse(new TextDecoder().decode(cached.buf));
    }

    if (indexCache.pending.has(LISTING_CACHE_KEY)) {
        try { await indexCache.pending.get(LISTING_CACHE_KEY); } catch (e) { console.error(e.stack || e); }
        cached = indexCache.get(LISTING_CACHE_KEY);
        if (cached && (now - cached.addedAt <= indexCache.ttl)) {
            return JSON.parse(new TextDecoder().decode(cached.buf));
        }
    }

    const fetchPromise = (async () => {
        const entries = [];
        let cursor = undefined;
        let pages = 0;

        do {
            if (pages++ > 100) break;
            let listed;
            try {
                listed = await bucket.list({
                    prefix: 'images/debian/',
                    include: ['customMetadata'],
                    cursor: cursor
                });
            } catch (err) {
                throw new Error("R2_LIST_ERROR: Failed to paginate bucket sequence. " + err.message);
            }

            for (const object of listed.objects) {
                const parts = object.key.split('/');
                if (parts.length !== 7 || parts.some(p => p.startsWith('.') || p === '')) continue;

                const [, os, release, arch, variant, version, filename] = parts;
                entries.push({
                    os, release, arch, variant, version, filename,
                    key: object.key,
                    size: object.size,
                    sha256: object.customMetadata?.sha256 || null
                });
            }
            cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        const buf = _textEncoder.encode(JSON.stringify(entries)).buffer;
        indexCache.add(LISTING_CACHE_KEY, buf, { etag: `W/"${buf.byteLength}"`, lastModified: Date.now() }, Date.now());
        return entries;
    })();

    indexCache.pending.set(LISTING_CACHE_KEY, fetchPromise);
    try { return await fetchPromise; }
    finally { if (indexCache.pending.get(LISTING_CACHE_KEY) === fetchPromise) indexCache.pending.delete(LISTING_CACHE_KEY); }
}

// ── Index Generators ─────────────────────────────────────────────────────────

/**
 * Generates Classic LXC index-system CSV from cached listing.
 *
 * @param {Array<Object>} entries - Parsed image entries.
 * @returns {string} Semicolon-delimited index text.
 */
function generateLxcIndex(entries) {
    const seen = new Set();
    const lines = [];
    for (const { os, release, arch, variant, version } of entries) {
        const key = `${os}-${release}-${arch}-${variant}-${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`${os};${release};${arch};${variant};${version};/images/${os}/${release}/${arch}/${variant}/${version}/`);
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
}

/**
 * Generates Incus simplestreams JSON tree from cached listing.
 *
 * @param {Array<Object>} entries - Parsed image entries.
 * @returns {string} Serialized JSON manifest.
 */
function generateIncusIndex(entries) {
    const products = {};
    for (const { os, release, arch, variant, version, filename, key, size, sha256 } of entries) {
        if (!sha256) continue;

        let itemName;
        if (filename === "incus.tar.xz") itemName = "incus_meta";
        else if (filename === "rootfs.tar.xz") itemName = "rootfs";
        else continue;

        const productName = `${os}:${release}:${arch}:${variant}`;
        if (!products[productName]) {
            products[productName] = {
                aliases: `${release}, ${os}/${release}, ${os}/${release}/${variant}, default`,
                architecture: arch,
                os,
                release,
                release_title: `Debian ${release.charAt(0).toUpperCase() + release.slice(1)} (debthin.org)`,
                versions: {}
            };
        }
        if (!products[productName].versions[version]) {
            products[productName].versions[version] = { items: {} };
        }
        products[productName].versions[version].items[itemName] = { ftype: filename, path: key, size, sha256 };
    }

    return JSON.stringify({ format: "products:1.0", datatype: "image-downloads", products });
}

// ── Cached Response Builder ──────────────────────────────────────────────────

/**
 * Serves a derived index from the shared listing cache.
 * Caches the formatted output separately so serialization only runs once per TTL.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @param {string} cacheKey - Logical cache key for the formatted output.
 * @param {string} contentType - Response Content-Type header.
 * @param {Function} formatFn - Synchronous function(entries) => string.
 * @param {Object} ctx - Worker execution context for waitUntil jobs.
 * @returns {Promise<Response>} The HTTP response.
 */
async function serveDerivedIndex(request, bucket, cacheKey, contentType, formatFn, ctx) {
    const now = Date.now();
    let cached = indexCache.get(cacheKey);
    
    if (cached) {
        if (now - cached.addedAt > indexCache.ttl) {
            if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(warmAllIndexes(bucket).catch(e => console.error(e)));
            }
        }
        return buildResponse(request, cached.meta, request.method === "HEAD" ? null : cached.buf, true, cached.hits, contentType);
    }

    if (indexCache.pending.has(cacheKey)) {
        try { await indexCache.pending.get(cacheKey); } catch (e) { console.error(e.stack || e); }
        cached = indexCache.get(cacheKey);
        if (cached) {
            return buildResponse(request, cached.meta, request.method === "HEAD" ? null : cached.buf, true, cached.hits, contentType);
        }
    }

    const fetchPromise = (async () => {
        const entries = await getImageListing(bucket);
        const textData = formatFn(entries);
        const buf = _textEncoder.encode(textData).buffer;
        const meta = { etag: `W/"${buf.byteLength}"`, lastModified: Date.now() };
        indexCache.add(cacheKey, buf, meta, Date.now());
        return { buf, meta };
    })();

    indexCache.pending.set(cacheKey, fetchPromise);
    try {
        const result = await fetchPromise;
        return buildResponse(request, result.meta, request.method === "HEAD" ? null : result.buf, false, 0, contentType);
    } finally {
        if (indexCache.pending.get(cacheKey) === fetchPromise) indexCache.pending.delete(cacheKey);
    }
}

function buildResponse(request, meta, buf, isCached, hits, contentType) {
    const headers = {
        ...H_CACHED,
        "Content-Type": contentType,
        "ETag": meta.etag,
        "Last-Modified": new Date(meta.lastModified).toUTCString(),
        "X-Debthin": isCached ? "hit-isolate-cache" : "hit-generated",
        "X-Cache": isCached ? "HIT" : "MISS",
        "X-Cache-Hits": (hits || 0).toString()
    };

    if (isNotModified(request.headers, meta)) {
        return new Response(null, { status: 304, headers });
    }
    return new Response(buf, { headers });
}

// ── Exported Handlers ────────────────────────────────────────────────────────

export async function handleLxcIndex(request, bucket, ctx) {
    return serveDerivedIndex(request, bucket, "meta/1.0/index-system", "text/plain; charset=utf-8", generateLxcIndex, ctx);
}

export async function handleIncusPointer(request, bucket, ctx) {
    const now = Date.now();
    const cacheKey = "streams/v1/index.json";
    let cached = indexCache.get(cacheKey);
    
    if (cached) {
        if (now - cached.addedAt > indexCache.ttl) {
            if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(warmAllIndexes(bucket).catch(e => console.error(e)));
            }
        }
        return buildResponse(request, cached.meta, request.method === "HEAD" ? null : cached.buf, true, cached.hits, "application/json; charset=utf-8");
    }
    
    const text = JSON.stringify({
        format: "index:1.0",
        index: { images: { datatype: "image-downloads", path: "streams/v1/images.json" } }
    });
    const buf = _textEncoder.encode(text).buffer;
    const meta = { etag: `W/"${buf.byteLength}"`, lastModified: now };
    indexCache.add(cacheKey, buf, meta, now);
    
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(warmAllIndexes(bucket).catch(e => console.error(e)));
    }
    
    return buildResponse(request, meta, request.method === "HEAD" ? null : buf, false, 0, "application/json; charset=utf-8");
}

export async function handleIncusIndex(request, bucket, ctx) {
    return serveDerivedIndex(request, bucket, "streams/v1/images.json", "application/json; charset=utf-8", generateIncusIndex, ctx);
}

export function handleImageRedirect(rawPath, env) {
    const fallbackHost = typeof env === 'object' && env.PUBLIC_R2_URL ? env.PUBLIC_R2_URL : 'https://r2-public.debthin.org';
    return Response.redirect(`${fallbackHost}${rawPath}`, 301);
}

/**
 * Pre-warms the R2 listing and all derived indexes if cold or expired.
 * Designed for ctx.waitUntil() — no-op if caches are fresh.
 *
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 */
export async function warmAllIndexes(bucket) {
    const entries = await getImageListing(bucket);
    const now = Date.now();

    const warmups = [
        { key: "meta/1.0/index-system", fn: () => generateLxcIndex(entries) },
        { key: "streams/v1/images.json", fn: () => generateIncusIndex(entries) },
    ];

    for (const { key, fn } of warmups) {
        const cached = indexCache.get(key);
        if (cached && (now - cached.addedAt <= indexCache.ttl)) continue;
        if (indexCache.pending.has(key)) continue;

        const textData = fn();
        const buf = _textEncoder.encode(textData).buffer;
        const meta = { etag: `W/"${buf.byteLength}"`, lastModified: now };
        indexCache.add(key, buf, meta, now);
    }
}