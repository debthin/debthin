/**
 * @fileoverview HTTP response utilities for the image distribution worker.
 * Frozen header sets, pre-encoded static payloads, and conditional response builder.
 */

import { isNotModified } from '../core/http.js';
import { H_CACHED, H_IMMUTABLE } from '../core/constants.js';

// ── Prebuilt Frozen Headers ──────────────────────────────────────────────────
/** @type {Readonly<Record<string, string>>} */
export const H_LXC_CSV = Object.freeze({ ...H_CACHED, "Content-Type": "text/plain; charset=utf-8" });
/** @type {Readonly<Record<string, string>>} */
export const H_INCUS_JSON = Object.freeze({ ...H_CACHED, "Content-Type": "application/json; charset=utf-8" });
/** @type {Readonly<Record<string, string>>} */
export const H_V2_ROOT = Object.freeze({ ...H_CACHED, "Content-Type": "application/json", "Docker-Distribution-Api-Version": "registry/2.0" });
/** @type {Readonly<Record<string, string>>} */
export const H_TAR_XZ = Object.freeze({ ...H_CACHED, "Content-Type": "application/x-xz" });
/** @type {Readonly<Record<string, string>>} */
export const H_OCI_INDEX_JSON = Object.freeze({ ...H_CACHED, "Content-Type": "application/vnd.oci.image.index.v1+json" });
/** @type {Readonly<Record<string, string>>} */
export const H_OCI_LAYOUT = Object.freeze({ ...H_IMMUTABLE, "Content-Type": "application/json" });
/** @type {Readonly<Record<string, string>>} */
export const H_HTML = Object.freeze({ ...H_CACHED, "Content-Type": "text/html; charset=utf-8" });
/** @type {Readonly<Record<string, string>>} */
export const H_ICON = Object.freeze({ ...H_CACHED, "Content-Type": "image/x-icon" });

// Export the core header sets for handlers
export { H_IMMUTABLE, H_CACHED };

const _encoder = new TextEncoder();

/**
 * Pre-encoded static pointer payload avoiding hot-path string allocation.
 * @type {ArrayBuffer}
 */
export const STATIC_INCUS_POINTER = _encoder.encode(JSON.stringify({
    format: "index:1.0",
    index: { images: { datatype: "image-downloads", path: "streams/v1/images.json" } }
})).buffer;

export const ERR_BLOB = _encoder.encode('{"errors":[{"code":"BLOB_UNKNOWN"}]}').buffer;
export const ERR_MANIFEST = _encoder.encode('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}').buffer;

/**
 * Pre-encoded OCI layout file. This is always the same 30-byte payload.
 * @type {ArrayBuffer}
 */
export const STATIC_OCI_LAYOUT = _encoder.encode('{"imageLayoutVersion":"1.0.0"}\n').buffer;

const OCI_LAYOUT_META = Object.freeze({
    etag: `W/"${30}"`,
    lastModified: 0,
    lastModifiedStr: 'Thu, 01 Jan 1970 00:00:00 GMT'
});
export { OCI_LAYOUT_META };

/**
 * Builds a response from cached metadata and buffer, handling 304 conditionals.
 * Evaluates If-None-Match/If-Modified-Since against the provided metadata.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Record<string, any>} meta - Cache metadata containing etag and lastModifiedStr.
 * @param {ArrayBuffer|null} buf - Response body buffer (null for HEAD requests).
 * @param {boolean} isCached - Whether this response was served from cache.
 * @param {number} hits - Cache hit count for this entry.
 * @param {Record<string, string>} baseHeaders - Frozen base header set to include.
 * @param {Record<string, string>} [extraHeaders] - Additional headers to merge.
 * @returns {Response} The constructed HTTP response.
 */
export function buildDerivedResponse(request, meta, buf, isCached, hits, baseHeaders, extraHeaders) {
    if (isNotModified(request.headers, meta)) {
        const h = new Headers(baseHeaders);
        h.set("ETag", meta.etag);
        if (extraHeaders) { for (const k in extraHeaders) h.set(k, extraHeaders[k]); }
        return new Response(null, { status: 304, headers: h });
    }

    const h = new Headers(baseHeaders);
    if (extraHeaders) { for (const k in extraHeaders) h.set(k, extraHeaders[k]); }
    h.set("ETag", meta.etag);
    h.set("Last-Modified", meta.lastModifiedStr);
    h.set("X-Debthin", isCached ? "hit-isolate-cache" : "hit-generated");
    h.set("X-Cache", isCached ? "HIT" : "MISS");
    h.set("X-Cache-Hits", hits.toString());

    return new Response(buf, { headers: h });
}