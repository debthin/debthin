/**
 * @fileoverview Cloudflare R2 bucket orchestrator.
 * Interfaces with the Bucket API bindings while managing the local metadata hydration flows.
 * 
 * Exports:
 * - wrapCachedObject: Adapts raw ArrayBuffers natively matching the CF Edge runtime object interface.
 * - r2Head: Lightweight upstream metadata validations mapped directly across runtime components.
 * - r2Get: Orchestrates bucket extraction seamlessly binding to concurrent memory coalescence locks.
 */


const _textDecoder = new TextDecoder();

/**
 * Extends an ArrayBuffer with a unified property surface matching the standard Cloudflare Edge Response format. 
 * This permits local memory cache retrievals to behave exactly like remote R2 fetch objects when passed to serveR2.
 *
 * @param {ArrayBuffer} arrayBuffer - Target physical memory buffer.
 * @param {Object} meta - Etag and content limit parameters.
 * @param {boolean} [isCached=false] - Injects X-Cache tracking flag.
 * @param {number} [hits=0] - Cache hit iteration number.
 * @returns {Object} Interface supporting text and arrayBuffer endpoints.
 */
export function wrapCachedObject(arrayBuffer, meta, isCached = false, hits = 0) {
  return {
    get body() { return arrayBuffer.byteLength ? arrayBuffer : null; },
    httpMetadata: meta,
    etag: meta.etag || `W/"${arrayBuffer.byteLength}"`,
    lastModified: meta.lastModified || null,
    contentLength: arrayBuffer.byteLength,
    isCached,
    hits,
    async arrayBuffer() { return arrayBuffer; },
    async text() { return _textDecoder.decode(arrayBuffer); }
  };
}

/**
 * Executes an HTTP HEAD request against the upstream bucket to validate metadata constraints.
 * Falls back to local memory validation first to prevent unnecessary network latency if the configured TTL bounds hold valid.
 *
 * @param {Object} env - Cloudflare worker binding object.
 * @param {string} key - R2 destination file path limit.
 * @returns {Promise<Object|null>} Wrapper exposing ETag and lastModified data values.
 */
export async function r2Head(env, key, cache) {
  const now = Date.now();
  let cached = cache.get(key);
  if (cached && (now - cached.addedAt > cache.ttl)) {
    const obj = await env.DEBTHIN_BUCKET.head(key);
    if (!obj) return null;
    if (obj.etag === cached.meta.etag) {
      cache.updateTTL(key, now);
      return wrapCachedObject(new ArrayBuffer(0), cached.meta, true, cached.hits);
    }
    const meta = obj.httpMetadata || {};
    meta.etag = obj.etag;
    meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;
    return wrapCachedObject(new ArrayBuffer(0), meta, false, 0);
  }

  if (cached) return wrapCachedObject(new ArrayBuffer(0), cached.meta, true, cached.hits);

  const obj = await env.DEBTHIN_BUCKET.head(key);
  if (!obj) return null;
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag;
  meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;
  return wrapCachedObject(new ArrayBuffer(0), meta, false, 0);
}

/**
 * Pulls objects from the R2 bucket.
 * Coalesces concurrent requests using _pendingGets.
 *
 * @param {Object} env - The Cloudflare worker bindings granting access to DEBTHIN_BUCKET.
 * @param {string} key - The exact file path being requested from the upstream repository.
 * @param {Object} [ctx] - The worker execution context used to push cache hydration into the background.
 * @param {Object} [options] - Injectable callbacks.
 * @param {Function} [options.onDiskMiss] - Hook to notify the orchestrator of cache updates.
 * @returns {Promise<Object|null>} An object matching the physical interface of an edge response payload.
 */
export async function r2Get(env, key, cache, ctx, { onDiskMiss, ttl } = {}) {
  const now = Date.now();
  const effectiveTtl = ttl ?? cache.ttl;
  let cached = cache.get(key);
  const expired = cached && (now - cached.addedAt > effectiveTtl);

  if (cached && !expired) {
    return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
  }

  if (cache.pending.has(key)) {
    try { await cache.pending.get(key); } catch (e) { console.error(e.stack || e); }
    cached = cache.get(key);
    if (cached && (now - cached.addedAt <= cache.ttl)) {
      return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
    }
  }

  const fetchPromise = (async () => {
    const fetchOpts = expired ? { onlyIf: { etagDoesNotMatch: cached.meta.etag } } : {};
    const obj = await env.DEBTHIN_BUCKET.get(key, fetchOpts);

    if (!obj) return null;

    if (!obj.body) {
      cache.updateTTL(key, now);
      return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
    }

    const meta = obj.httpMetadata || {};
    meta.etag = obj.etag;
    meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;

    if (obj.size > 4 * 1024 * 1024) {
      return {
        get body() { return obj.body; },
        httpMetadata: meta,
        etag: meta.etag,
        lastModified: meta.lastModified,
        contentLength: obj.size,
        isCached: false,
        hits: 0,
        async arrayBuffer() { return await new Response(obj.body).arrayBuffer(); },
        async text() { return await new Response(obj.body).text(); }
      };
    }

    const buf = await obj.arrayBuffer();
    cache.add(key, buf, meta, now);

    if (onDiskMiss) {
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(new Promise(resolve => setTimeout(() => {
          try { onDiskMiss(buf, expired); } catch (e) { console.error(e.stack || e); }
          resolve();
        }, 0)));
      } else {
        onDiskMiss(buf, expired);
      }
    }

    return wrapCachedObject(buf, meta, false, 0);
  })();

  cache.pending.set(key, fetchPromise);

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    if (cache.pending.get(key) === fetchPromise) {
      cache.pending.delete(key);
    }
  }
}
