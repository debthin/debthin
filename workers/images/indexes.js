/**
 * @fileoverview Registry state hydration and index caching.
 * Fetches the pre-compiled registry-state.json from R2 and populates
 * the L1 LRU cache with binary-encoded index payloads.
 */

import { indexCache } from './cache.js';

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();
const STATE_KEY = "registry-state.json";

// Module-level state populated during hydration
let _ociBlobsMap = null;
let _ociManifestsMap = null;
let _fileSizesMap = null;
let _stateTimestamp = 0;

/**
 * Fetches registry-state.json from R2 and populates the L1 cache
 * with binary-encoded LXC CSV and Incus JSON index payloads.
 * Also stores OCI blob/manifest dictionaries in module-level state.
 *
 * @param {R2Bucket} bucket - The Cloudflare R2 bucket binding.
 * @returns {Promise<void>}
 */
export async function hydrateRegistryState(bucket) {
    if (indexCache.pending.has(STATE_KEY)) return indexCache.pending.get(STATE_KEY);

    const fetchPromise = (async () => {
        const obj = await bucket.get(STATE_KEY);
        if (!obj) throw new Error("Registry state missing from R2");

        const buf = await obj.arrayBuffer();
        const state = JSON.parse(_textDecoder.decode(buf));
        const now = Date.now();
        const dateStr = new Date(now).toUTCString();

        // Fracture text components directly into binary buffers in the LRU
        const lxcBuf = _textEncoder.encode(state.lxc_csv).buffer;
        indexCache.add("meta/1.0/index-system", lxcBuf, { etag: `W/"${lxcBuf.byteLength}"`, lastModified: now, lastModifiedStr: dateStr }, now);

        const incusBuf = _textEncoder.encode(JSON.stringify(state.incus_json)).buffer;
        indexCache.add("streams/v1/images.json", incusBuf, { etag: `W/"${incusBuf.byteLength}"`, lastModified: now, lastModifiedStr: dateStr }, now);

        // Build dynamic Incus pointer with products list (required by Incus client)
        const productKeys = Object.keys(state.incus_json.products || {});
        const pointer = {
            format: "index:1.0",
            index: {
                images: {
                    datatype: "image-downloads",
                    path: "streams/v1/images.json",
                    products: productKeys,
                }
            }
        };
        const pointerBuf = _textEncoder.encode(JSON.stringify(pointer)).buffer;
        indexCache.add("streams/v1/index.json", pointerBuf, { etag: `W/"${pointerBuf.byteLength}"`, lastModified: now, lastModifiedStr: dateStr }, now);

        // Store OCI dictionaries and file size map in module-level state
        _ociBlobsMap = state.oci_blobs || {};
        _ociManifestsMap = state.oci_manifests || {};
        _fileSizesMap = state.file_sizes || {};
        _stateTimestamp = now;
    })();

    indexCache.pending.set(STATE_KEY, fetchPromise);
    try { await fetchPromise; }
    finally { indexCache.pending.delete(STATE_KEY); }
}

/**
 * Returns OCI blob and manifest dictionaries, hydrating from R2 if needed.
 * Uses stale-while-revalidate: serves existing data while refreshing in background.
 *
 * @param {R2Bucket} bucket - The Cloudflare R2 bucket binding.
 * @param {ExecutionContext} ctx - Worker execution context for background revalidation.
 * @returns {Promise<{blobs: Object, manifests: Object}>} OCI lookup maps.
 */
export async function getOciState(bucket, ctx) {
    const now = Date.now();
    if (!_ociBlobsMap) {
        await hydrateRegistryState(bucket);
    } else if (now - _stateTimestamp > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(hydrateRegistryState(bucket).catch(() => { }));
    }
    return { blobs: _ociBlobsMap, manifests: _ociManifestsMap };
}

/**
 * Returns the file size lookup map, hydrating from R2 if needed.
 * Maps R2 keys (e.g. 'images/debian/.../incus.tar.xz') to byte sizes.
 *
 * @param {R2Bucket} bucket - The Cloudflare R2 bucket binding.
 * @param {ExecutionContext} ctx - Worker execution context for background revalidation.
 * @returns {Promise<Object>} Map of R2 keys to file sizes in bytes.
 */
export async function getFileSizes(bucket, ctx) {
    const now = Date.now();
    if (!_fileSizesMap) {
        await hydrateRegistryState(bucket);
    } else if (now - _stateTimestamp > indexCache.ttl && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(hydrateRegistryState(bucket).catch(() => { }));
    }
    return _fileSizesMap;
}