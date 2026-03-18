/**
 * @fileoverview Cloudflare R2 bucket orchestrator.
 * Interfaces with the Bucket API bindings while managing the local metadata hydration flows and streaming transforms.
 */

import { addToCache, getFromCache, hasInCache, updateCacheTTL, INDEX_TTL } from './cache.js';
import { tokenizePath, getContentType, inReleaseToRelease } from './utils.js';
import { H_CACHED, H_IMMUTABLE, EMPTY_GZ_HASH, EMPTY_GZ, EMPTY_HASH } from './constants.js';

const _textDecoder = new TextDecoder();

/**
 * Lazily populated index map caching upstream file architectures. 
 * Enables the worker to selectively bypass R2 lookups for by-hash target queries.
 * @type {Map<string, Object|Promise>}
 */
export const _hashIndexes = new Map();

/**
 * Global flight tracker for active network block pulls masking internal parallel cache misses.
 * @type {Map<string, Promise>}
 */
const _pendingGets = new Map();

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
export async function r2Head(env, key) {
  const now = Date.now();
  let cached = getFromCache(key);
  if (cached && (now - cached.addedAt > INDEX_TTL)) {
    const obj = await env.DEBTHIN_BUCKET.head(key);
    if (!obj) return null;
    if (obj.etag === cached.meta.etag) {
      updateCacheTTL(key, now);
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
 * @param {Object} ctx - The worker execution context used to push cache hydration into the background.
 * @returns {Promise<Object|null>} An object matching the physical interface of an edge response payload.
 */
export async function r2Get(env, key, ctx) {
  const now = Date.now();
  let cached = getFromCache(key);
  const expired = cached && (now - cached.addedAt > INDEX_TTL);

  if (cached && !expired) {
    return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
  }

  if (_pendingGets.has(key)) {
    try { await _pendingGets.get(key); } catch (e) { }
    cached = getFromCache(key);
    if (cached && (now - cached.addedAt <= INDEX_TTL)) {
      return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
    }
  }

  const fetchPromise = (async () => {
    const fetchOpts = expired ? { onlyIf: { etagDoesNotMatch: cached.meta.etag } } : {};
    const obj = await env.DEBTHIN_BUCKET.get(key, fetchOpts);

    if (!obj) return null;

    if (!obj.body) {
      updateCacheTTL(key, now);
      return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
    }

    const forceReindex = expired;
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
    addToCache(key, buf, meta, now);

    const isRelease = key.endsWith("InRelease") || key.endsWith("Release") || key.endsWith("Release.gpg");
    if (isRelease) {
      const { p0, p1, p2 } = tokenizePath(key);
      if (p0 === "dists" && p1 && p2) {
        const distroIndex = _hashIndexes.get(p1);
        if (!distroIndex || forceReindex) {
          const text = _textDecoder.decode(buf);
          const suiteRoot = `${p0}/${p1}/${p2}`;
          if (ctx) {
            ctx.waitUntil(new Promise(resolve => setTimeout(() => {
              try { warmRamCacheFromRelease(text, suiteRoot, forceReindex); } catch (e) { console.error(e.stack || e); }
              resolve();
            }, 0)));
          } else {
            warmRamCacheFromRelease(text, suiteRoot, forceReindex);
          }
        }
      }
    }
    return wrapCachedObject(buf, meta, false, 0);
  })();

  _pendingGets.set(key, fetchPromise);

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    if (_pendingGets.get(key) === fetchPromise) {
      _pendingGets.delete(key);
    }
  }
}

/**
 * Parses a textual Debian Release manifest to locate the SHA256 checksum segment.
 * Iterates over each line block building memory map references correlating checksum signatures to target filenames.
 *
 * @param {string} text - Raw Release manifest payload text values.
 * @param {string} suiteRoot - Active directory base reference limit bindings.
 * @param {boolean} [forceReindex=false] - Triggers deletion of the directory mapping values.
 */
export function warmRamCacheFromRelease(text, suiteRoot, forceReindex = false) {
  const sectionIdx = text.indexOf("\nSHA256:");
  if (sectionIdx === -1) return;

  const distro = suiteRoot.split("/")[1];
  const prefixLen = 6 + distro.length + 1;

  if (forceReindex) {
    _hashIndexes.delete(distro);
  }

  let distroIndex = _hashIndexes.get(distro);
  if (!distroIndex) {
    distroIndex = {};
    _hashIndexes.set(distro, distroIndex);
  }

  let pos = text.indexOf("\n", sectionIdx + 1) + 1;
  while (pos > 0 && pos < text.length && text.charCodeAt(pos) === 32) {
    const lineEnd = text.indexOf("\n", pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
    const s1 = line.indexOf(" ", 1);
    const s2 = line.indexOf(" ", s1 + 1);
    const hash = line.slice(1, s1);
    const name = line.slice(s2 + 1);

    if (hash === EMPTY_GZ_HASH) {
      if (!hasInCache(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, EMPTY_GZ, { contentType: "application/x-gzip" }, Date.now());
    } else if (hash === EMPTY_HASH) {
      if (!hasInCache(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, new ArrayBuffer(0), { contentType: "text/plain; charset=utf-8" }, Date.now());
    }

    if (hash.length === 64 && name.endsWith(".gz")) {
      if (!(distroIndex instanceof Promise)) {
        distroIndex[hash] = suiteRoot.slice(prefixLen) + "/" + name;
      }
    }

    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
}

/**
 * Compares the HTTP `If-None-Match` and `If-Modified-Since` client headers against the currently valid source cache parameters.
 * Permits the worker API to yield 304 results for existing client caches immediately.
 *
 * @param {Headers} requestHeaders - Inbound HTTP request headers containing If-None-Match or If-Modified-Since.
 * @param {Object} obj - The hydrated metadata representation pulled from the bucket or local memory.
 * @returns {boolean} Returns true if the client cache dictates skipping a full payload transfer.
 */
export function isNotModified(requestHeaders, obj) {
  const reqEtag = requestHeaders.get("if-none-match");
  if (reqEtag) {
    const cleanReq = reqEtag.replace(/^W\//, '').replace(/"/g, '');
    const cleanObj = obj.etag ? obj.etag.replace(/^W\//, '').replace(/"/g, '') : "";
    return reqEtag === "*" || cleanReq === cleanObj;
  }

  const reqIms = requestHeaders.get("if-modified-since");
  if (reqIms && obj.lastModified) {
    const clientDate = Date.parse(reqIms);
    return !isNaN(clientDate) && obj.lastModified <= clientDate;
  }
  return false;
}

/**
 * Serves an R2 object over HTTP.
 *
 * @param {Object} env - The Cloudflare worker bindings granting access to DEBTHIN_BUCKET.
 * @param {Request} request - The original inbound HTTP request object.
 * @param {string} key - The bucket path to fetch.
 * @param {Object} [options] - Optional transform configurations like 'decompress' or 'strip-pgp'.
 * @returns {Promise<Response>} A fully formed HTTP Response ready for the client socket.
 */
export async function serveR2(env, request, key, { transform, fetchKey, ctx, immutable } = {}) {
  const isHead = request.method === "HEAD";
  const obj = isHead && !transform ? await r2Head(env, fetchKey ?? key) : await r2Get(env, fetchKey ?? key, ctx);
  if (!obj) return new Response("Not found\n", { status: 404, headers: { ...H_CACHED, "X-Cache": "MISS" } });

  const base = immutable ? H_IMMUTABLE : H_CACHED;
  const h = {
    ...base,
    "X-Debthin": obj.isCached ? "hit-isolate-cache" : "hit",
    "X-Cache": obj.isCached ? "HIT" : "MISS",
    "X-Cache-Hits": obj.hits.toString(),
  };
  if (obj.etag) h["ETag"] = obj.etag;
  if (obj.lastModified) h["Last-Modified"] = new Date(obj.lastModified).toUTCString();
  if (isHead && obj.isCached) h["Content-Length"] = obj.contentLength.toString();

  h["Content-Type"] = (transform === "strip-pgp" || transform === "decompress") 
    ? "text/plain; charset=utf-8" 
    : (obj.httpMetadata?.contentType || getContentType(key));

  if (isNotModified(request.headers, obj)) {
    return new Response(null, { status: 304, headers: h });
  }

  if (transform === "strip-pgp") {
    h["X-Debthin"] = "hit-derived";
    delete h["ETag"];
    return new Response(inReleaseToRelease(await obj.text()), { headers: h });
  }

  if (transform === "decompress") {
    const acceptsGzip = request.headers.get("accept-encoding")?.includes("gzip");
    if (acceptsGzip) {
      h["X-Debthin"] = "hit-decomp-bypassed";
      h["Content-Encoding"] = "gzip";
      return new Response(obj.body, { headers: h });
    }

    h["X-Debthin"] = "hit-decomp";
    if (!obj.body) return new Response("", { headers: h });

    const ds = new DecompressionStream("gzip");
    const stream = obj.body instanceof ReadableStream ? obj.body : new Response(obj.body).body;
    const decompressed = stream.pipeThrough(ds);
    return new Response(decompressed, { headers: h });
  }

  return new Response(obj.body, { headers: h });
}
