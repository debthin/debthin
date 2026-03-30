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
 * @param {Record<string, any>} meta - Etag and content limit parameters.
 * @param {boolean} [isCached=false] - Injects X-Cache tracking flag.
 * @param {number} [hits=0] - Cache hit iteration number.
 * @returns {WrappedR2Object} Interface supporting text and arrayBuffer endpoints.
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
 * @param {HasDebthinBucket} env - Cloudflare worker binding object.
 * @param {string} key - R2 destination file path limit.
 * @param {LocalCache} cache - The LRU cache instance.
 * @returns {Promise<WrappedR2Object|null>} Wrapper exposing ETag and lastModified data values.
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
    /** @type {Record<string, any>} */
    const meta = obj.httpMetadata || {};
    meta.etag = obj.etag;
    meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;
    return wrapCachedObject(new ArrayBuffer(0), meta, false, 0);
  }

  if (cached) return wrapCachedObject(new ArrayBuffer(0), cached.meta, true, cached.hits);

  const obj = await env.DEBTHIN_BUCKET.head(key);
  if (!obj) return null;
  /** @type {Record<string, any>} */
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag;
  meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;
  return wrapCachedObject(new ArrayBuffer(0), meta, false, 0);
}

/**
 * @typedef {Object} R2GetOptions
 * @property {Function} [onDiskMiss] - Hook to notify the orchestrator of cache updates.
 * @property {number} [ttl] - Override TTL in milliseconds.
 */

/**
 * Pulls objects from the R2 bucket.
 * Coalesces concurrent requests using _pendingGets.
 *
 * @param {HasDebthinBucket} env - The Cloudflare worker bindings granting access to DEBTHIN_BUCKET.
 * @param {string} key - The exact file path being requested from the upstream repository.
 * @param {LocalCache} cache - The LRU cache instance.
 * @param {ExecutionContext} [ctx] - The worker execution context used to push cache hydration into the background.
 * @param {R2GetOptions} [options] - Injectable callbacks.
 * @returns {Promise<WrappedR2Object|null>} An object matching the physical interface of an edge response payload.
 */
export async function r2Get(env, key, cache, ctx, { onDiskMiss, ttl } = /** @type {R2GetOptions} */ ({})) {
  const now = Date.now();
  const effectiveTtl = ttl ?? cache.ttl;
  let cached = cache.get(key);
  const expired = cached && (now - cached.addedAt > effectiveTtl);

  // 1. L1 Warm Path (In-Isolate RAM Cache)
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

  // 2. L2 Warm Path (Colo Solid-State Cache)
  // Synthesize a fast string URL to avoid 'new Request(url)' GC overhead
  const l2Key = `https://l2-internal.debthin.org/${key}`;
  // @ts-expect-error — caches.default is a CF Workers runtime global not in all type defs
  const l2Cache = /** @type {Cache} */ (caches.default);

  const l2Response = await l2Cache.match(l2Key);
  if (l2Response) {
    const buf = await l2Response.arrayBuffer();
    const meta = {
      etag: l2Response.headers.get("ETag"),
      lastModified: Date.parse(l2Response.headers.get("Last-Modified")) || null
    };

    cache.add(key, buf, meta, now);

    return wrapCachedObject(buf, meta, true, 0);
  }

  // 3. Cold Path (R2 Bucket Fetch)
  const fetchPromise = (async () => {
    const fetchOpts = expired ? { onlyIf: { etagDoesNotMatch: cached.meta.etag } } : {};
    const obj = await env.DEBTHIN_BUCKET.get(key, fetchOpts);

    if (!obj) return null;

    if (!obj.body) {
      cache.updateTTL(key, now);
      return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
    }

    /** @type {Record<string, any>} */
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

    // Populate L2 colo cache in the background so subsequent same-colo
    // requests can skip R2 entirely.
    if (ctx && ctx.waitUntil) {
      const l2Headers = new Headers({ "Content-Type": "application/octet-stream" });
      if (meta.etag) l2Headers.set("ETag", meta.etag);
      if (meta.lastModified) l2Headers.set("Last-Modified", new Date(meta.lastModified).toUTCString());
      // Cache-Control drives CF cache TTL; match the L1 TTL.
      l2Headers.set("Cache-Control", `public, max-age=${Math.round(effectiveTtl / 1000)}`);
      ctx.waitUntil(l2Cache.put(l2Key, new Response(buf, { headers: l2Headers })));
    }

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
