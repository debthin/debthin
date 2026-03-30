/**
 * @fileoverview Route handlers for the image distribution worker.
 * Maps incoming paths to LXC/Incus index lookups, OCI registry operations,
 * and R2 redirect responses.
 */

import { indexCache } from '../cache.js';
import {
    buildDerivedResponse, H_LXC_CSV, H_INCUS_JSON, H_V2_ROOT, H_IMMUTABLE,
    H_CACHED, H_OCI_LAYOUT,
    STATIC_OCI_LAYOUT, OCI_LAYOUT_META,
    ERR_BLOB, ERR_MANIFEST
} from '../http.js';
import { hydrateRegistryState, getOciState, getFileSizes } from '../indexes.js';
import { serveL1Target, fetchAndCache, headersForMetadata, METADATA_SIZE_LIMIT } from '../utils.js';

/**
 * Serves a static file from R2 using the LRU cache and standard response
 * builder. Follows the same cache-then-R2 pattern as handleImageMetadata:
 * returns from cache on hit (with SWR background refresh), fetches from R2
 * on miss, and uses buildDerivedResponse for conditional 304 handling.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {R2Bucket} bucket - The Cloudflare R2 bucket binding.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} key - The R2 object key to fetch.
 * @param {Record<string, string>} baseHeaders - Frozen header set (e.g. H_HTML, H_ICON).
 * @returns {Promise<Response>} Cached or freshly-fetched response.
 */
export async function serveR2Static(request, bucket, ctx, key, baseHeaders) {
    let cached = indexCache.get(key);
    if (cached) {
        if (Date.now() - cached.addedAt > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(fetchAndCache(bucket, key).catch(() => { }));
        }
        return buildDerivedResponse(
            request, cached.meta,
            request.method === "HEAD" ? null : cached.buf,
            true, cached.hits, baseHeaders
        );
    }

    const entry = await fetchAndCache(bucket, key);
    if (!entry) return new Response("Not Found\n", { status: 404 });

    return buildDerivedResponse(
        request, entry.meta,
        request.method === "HEAD" ? null : entry.buf,
        false, 0, baseHeaders
    );
}

export async function handleLxcIndex(request, bucket, ctx) {
    return serveL1Target(request, bucket, ctx, "meta/1.0/index-system", H_LXC_CSV, hydrateRegistryState);
}

export async function handleIncusIndex(request, bucket, ctx) {
    return serveL1Target(request, bucket, ctx, "streams/v1/images.json", H_INCUS_JSON, hydrateRegistryState);
}

export async function handleIncusPointer(request, bucket, ctx) {
    return serveL1Target(request, bucket, ctx, "streams/v1/index.json", H_INCUS_JSON, hydrateRegistryState);
}

export async function handleOciRegistry(request, bucket, ctx, rawPath, env) {
    if (rawPath === "v2" || rawPath === "v2/") {
        return new Response("{}", { headers: H_V2_ROOT });
    }

    // Zero-allocation string isolation (No RegEx)
    const typeIdx = Math.max(rawPath.lastIndexOf("/manifests/"), rawPath.lastIndexOf("/blobs/"));
    if (typeIdx === -1) return new Response("Not Found", { status: 404 });

    const typeStart = rawPath.indexOf("/", typeIdx + 1);
    const type = rawPath.slice(typeIdx + 1, typeStart); // "manifests" or "blobs"
    const repo = rawPath.slice(3, typeIdx); // extract repo name
    const ref = rawPath.slice(typeStart + 1);

    const { blobs, manifests } = await getOciState(bucket, ctx);

    if (type === "blobs") {
        const blobPath = blobs[ref];
        if (!blobPath) return new Response(ERR_BLOB, { status: 404, headers: H_V2_ROOT });
        // Blobs are content-addressable hashes. OCI clients follow redirects.
        return handleImageRedirect('/' + blobPath, env);
    }

    if (type === "manifests") {
        const isInner = ref.startsWith("sha256:");
        const r2Key = isInner ? blobs[ref] : manifests[`${repo}:${ref}`];

        if (!r2Key) return new Response(ERR_MANIFEST, { status: 404, headers: H_V2_ROOT });

        // SWR: serve stale manifest but refresh in background if TTL exceeded
        let cachedManifest = indexCache.get(r2Key);
        if (!cachedManifest) {
            const r2Res = await bucket.get(r2Key);
            if (!r2Res) return new Response(ERR_MANIFEST, { status: 404, headers: H_V2_ROOT });
            const buf = await r2Res.arrayBuffer();
            const now = Date.now();
            const meta = { etag: r2Res.etag, lastModified: now, lastModifiedStr: new Date(now).toUTCString() };
            indexCache.add(r2Key, buf, meta, now);
            cachedManifest = { buf, meta, hits: 0, addedAt: now };
        } else if (Date.now() - cachedManifest.addedAt > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil((async () => {
                const r2Res = await bucket.get(r2Key);
                if (r2Res) {
                    const buf = await r2Res.arrayBuffer();
                    const now = Date.now();
                    indexCache.add(r2Key, buf, {
                        etag: r2Res.etag,
                        lastModified: now,
                        lastModifiedStr: new Date(now).toUTCString()
                    }, now);
                }
            })().catch(() => { }));
        }

        const cType = isInner ? "application/vnd.oci.image.manifest.v1+json" : "application/vnd.oci.image.index.v1+json";
        const extra = { "Content-Type": cType, "Docker-Distribution-Api-Version": "registry/2.0" };
        if (isInner) extra["Docker-Content-Digest"] = ref;

        return buildDerivedResponse(request, cachedManifest.meta, request.method === "HEAD" ? null : cachedManifest.buf, true, cachedManifest.hits, H_CACHED, extra);
    }

    return new Response("Not Found", { status: 404 });
}

/**
 * Redirects large binary download requests to the unmetered R2 public domain.
 * Returns a 301 with 1-year immutable cache headers.
 *
 * @param {string} rawPath - The path to redirect (e.g. '/images/debian/...').
 * @param {ImagesEnv} env - Cloudflare environment bindings containing PUBLIC_R2_URL.
 * @returns {Response} A 301 redirect response.
 */
export function handleImageRedirect(rawPath, env) {
    const fallbackHost = typeof env === 'object' && env.PUBLIC_R2_URL ? env.PUBLIC_R2_URL : 'https://images-repo.debthin.org';
    return new Response(null, {
        status: 301,
        headers: {
            ...H_IMMUTABLE,
            "Location": `${fallbackHost}${rawPath}`
        }
    });
}

/**
 * Streams a large image file directly from R2 through the worker.
 * Simplestreams clients (Incus/LXD) don't follow 301 redirects for file
 * downloads, so we stream through the worker with aggressive cache headers
 * to leverage Cloudflare's CDN edge caching.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {R2Bucket} bucket - The Cloudflare R2 bucket binding.
 * @param {string} r2Key - The R2 object key (no leading slash).
 * @returns {Promise<Response>} Streamed R2 response with cache headers.
 */
export async function handleImageStream(request, bucket, r2Key) {
    if (request.method === "HEAD") {
        const head = await bucket.head(r2Key);
        if (!head) return new Response("Not Found\n", { status: 404 });
        return new Response(null, {
            status: 200,
            headers: {
                ...H_IMMUTABLE,
                "Content-Type": "application/octet-stream",
                "Content-Length": String(head.size),
                "ETag": head.etag,
            }
        });
    }

    const obj = await bucket.get(r2Key);
    if (!obj) return new Response("Not Found\n", { status: 404 });

    return new Response(obj.body, {
        status: 200,
        headers: {
            ...H_IMMUTABLE,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(obj.size),
            "ETag": obj.etag,
        }
    });
}

/**
 * Returns the hardwired oci-layout file with immutable cache headers.
 * The content is always {"imageLayoutVersion":"1.0.0"} and never changes.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {Response} Static oci-layout JSON response.
 */
export function handleOciLayout(request) {
    return buildDerivedResponse(
        request, OCI_LAYOUT_META,
        request.method === "HEAD" ? null : STATIC_OCI_LAYOUT,
        false, 0, H_OCI_LAYOUT
    );
}

export async function handleImageMetadata(request, bucket, ctx, r2Key, filename) {
    let cached = indexCache.get(r2Key);
    if (cached) {
        if (Date.now() - cached.addedAt > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(fetchAndCache(bucket, r2Key).catch(() => { }));
        }
        return buildDerivedResponse(
            request, cached.meta,
            request.method === "HEAD" ? null : cached.buf,
            true, cached.hits, headersForMetadata(filename)
        );
    }

    const entry = await fetchAndCache(bucket, r2Key);
    if (!entry) return new Response("Not Found\n", { status: 404 });

    return buildDerivedResponse(
        request, entry.meta,
        request.method === "HEAD" ? null : entry.buf,
        false, 0, headersForMetadata(filename)
    );
}

/**
 * Routes an `/images/` path to the metadata cache, the hardwired oci-layout
 * response, or a 301 redirect based on the manifest file_sizes map.
 * Files under 100KB are served from cache; everything else is redirected.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {ImagesEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} rawPath - URL path without leading slash.
 * @returns {Promise<Response>} The response.
 */
export async function routeImagePath(request, env, ctx, rawPath) {
    const lastSlash = rawPath.lastIndexOf('/');
    const filename = lastSlash !== -1 ? rawPath.slice(lastSlash + 1) : rawPath;

    // Hardwired static response for oci-layout (immutable, 30 bytes)
    if (filename === 'oci-layout') {
        return handleOciLayout(request);
    }

    // Look up file size from the hydrated manifest
    const sizes = await getFileSizes(env.IMAGES_BUCKET, ctx);
    const fileSize = sizes[rawPath];

    if (fileSize !== undefined && fileSize <= METADATA_SIZE_LIMIT) {
        return handleImageMetadata(request, env.IMAGES_BUCKET, ctx, rawPath, filename);
    }

    // Incus simplestreams doesn't follow 301s; stream squashfs directly
    //if (filename === 'rootfs.squashfs') {
    //    return handleImageStream(request, env.IMAGES_BUCKET, rawPath);
    //}

    // Everything else → 301 redirect to public R2
    return handleImageRedirect('/' + rawPath, env);
}