/**
 * @fileoverview Route handlers for the image distribution CDN worker.
 */

import { isNotModified } from '../../core/http.js';
import { H_CACHED } from '../../core/constants.js';
import { indexCache } from '../cache.js';

const _textEncoder = new TextEncoder();

/**
 * Executes or fetches the generated content adhering strictly to V8 isolate limits and concurrent HTTP coalescing.
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @param {string} cacheKey - The logical path string identifying the payload.
 * @param {string} contentType - The resulting HTTP content type header.
 * @param {Function} generatorFn - The asynchronous lambda extracting R2 properties.
 * @returns {Promise<Response>} The HTTP response (complete payload or 304).
 */
async function serveCachedOrGenerate(request, bucket, cacheKey, contentType, generatorFn) {
    const now = Date.now();
    let cached = indexCache.get(cacheKey);
    const expired = cached && (now - cached.addedAt > indexCache.ttl);

    if (cached && !expired) {
        return buildResponse(request, cached.meta, cached.buf, true, cached.hits, contentType);
    }

    if (indexCache.pending.has(cacheKey)) {
        try { await indexCache.pending.get(cacheKey); } catch(e) { console.error(e.stack || e); }
        cached = indexCache.get(cacheKey);
        if (cached && (now - cached.addedAt <= indexCache.ttl)) {
            return buildResponse(request, cached.meta, cached.buf, true, cached.hits, contentType);
        }
    }

    const fetchPromise = (async () => {
        const textData = await generatorFn(bucket);
        const buf = _textEncoder.encode(textData).buffer;
        
        const meta = {
            etag: `W/"${buf.byteLength}-${now}"`,
            lastModified: now
        };
        
        indexCache.add(cacheKey, buf, meta, Date.now());
        return { buf, meta };
    })();

    indexCache.pending.set(cacheKey, fetchPromise);

    try {
        const result = await fetchPromise;
        return buildResponse(request, result.meta, result.buf, false, 0, contentType);
    } finally {
        if (indexCache.pending.get(cacheKey) === fetchPromise) {
            indexCache.pending.delete(cacheKey);
        }
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

/**
 * Handles generating the Classic LXC index mapping (index-system).
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @returns {Promise<Response>} The HTTP response containing the CSV index.
 */
export async function handleLxcIndex(request, bucket) {
    return serveCachedOrGenerate(request, bucket, "meta/1.0/index-system", "text/plain; charset=utf-8", async (b) => {
        let indexData = "";
        let processedVersions = new Set();
        let cursor = undefined;

        do {
            const listed = await b.list({ prefix: 'images/debian/', cursor: cursor });
            for (const object of listed.objects) {
                const parts = object.key.split('/');
                if (parts.length !== 7) continue;

                const [, os, release, arch, variant, version,] = parts;
                const versionKey = `${os}-${release}-${arch}-${version}`;

                if (!processedVersions.has(versionKey)) {
                    indexData += `${os};${release};${arch};${variant};${version};/images/${os}/${release}/${arch}/${variant}/${version}/\n`;
                    processedVersions.add(versionKey);
                }
            }
            cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
        return indexData;
    });
}

/**
 * Serves the static Incus/LXD pointer file. Caches indefinitely in RAM.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleIncusPointer(request) {
    return serveCachedOrGenerate(request, null, "streams/v1/index.json", "application/json; charset=utf-8", async () => {
        return JSON.stringify({
            format: "index:1.0",
            index: { images: { datatype: "image-downloads", path: "streams/v1/images.json" } }
        }, null, 2);
    });
}

/**
 * Translates the physical R2 bucket state into an Incus simplestreams JSON tree.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @returns {Promise<Response>} The HTTP response comprising the Simplestreams JSON manifest.
 */
export async function handleIncusIndex(request, bucket) {
    return serveCachedOrGenerate(request, bucket, "streams/v1/images.json", "application/json; charset=utf-8", async (b) => {
        let products = {};
        let cursor = undefined;

        do {
            const listed = await b.list({
                prefix: 'images/debian/',
                include: ['customMetadata'],
                cursor: cursor
            });

            for (const object of listed.objects) {
                const parts = object.key.split('/');
                if (parts.length !== 7) continue;

                const [, os, release, arch, variant, version, filename] = parts;
                const productName = `${os}:${release}:${arch}:${variant}`;

                if (!products[productName]) {
                    products[productName] = {
                        aliases: `${release}, ${os}/${release}, ${os}/${release}/${variant}, default`,
                        architecture: arch,
                        os: os,
                        release: release,
                        release_title: `Debian ${release.charAt(0).toUpperCase() + release.slice(1)} (debthin.org)`,
                        versions: {}
                    };
                }

                if (!products[productName].versions[version]) {
                    products[productName].versions[version] = { items: {} };
                }

                let itemName = "";
                if (filename === "incus.tar.xz") itemName = "incus_meta";
                else if (filename === "rootfs.tar.xz") itemName = "rootfs";
                else continue;

                products[productName].versions[version].items[itemName] = {
                    ftype: filename,
                    path: object.key,
                    size: object.size,
                    sha256: object.customMetadata?.sha256 || "HASH_MISSING"
                };
            }
            cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        return JSON.stringify({
            format: "products:1.0",
            datatype: "image-downloads",
            products: products
        }, null, 2);
    });
}

/**
 * Redirects binary container downloads to the unmetered R2 public zone.
 *
 * @param {string} rawPath - The intercepted request path starting with `/images/`.
 * @returns {Response} An HTTP 301 redirection payload.
 */
export function handleImageRedirect(rawPath) {
    const publicR2Url = `https://r2-public.debthin.org${rawPath}`;
    return Response.redirect(publicR2Url, 301);
}
