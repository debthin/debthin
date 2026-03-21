/**
 * @fileoverview HTTP Edge formatting and streaming operations.
 * Isolates request condition evaluation and Edge caching stream pipes from the bucket fetcher.
 * 
 * Exports:
 * - isNotModified: Conditional client caching validation headers matching ETags natively (304).
 * - serveR2: Formats finalized HTTP response streams dynamically orchestrating gzip logic.
 */

import { r2Head, r2Get } from './r2.js';
import { getContentType } from './utils.js';
import { inReleaseToRelease } from '../debthin/utils.js';
import { H_CACHED, H_IMMUTABLE } from '../debthin/constants.js';

const _textDecoder = new TextDecoder();

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
 * Generates an HTTP response representing an R2 payload or local cache hit.
 * Manages 304 conditionals, transformations, and caching headers cleanly.
 *
 * @param {Object} env - The Cloudflare worker bindings.
 * @param {Request} request - The original inbound HTTP request object.
 * @param {string} key - The bucket path to fetch.
 * @param {Object} [options] - Optional configurations.
 * @param {string} [options.transform] - e.g., 'decompress' or 'strip-pgp'.
 * @param {string} [options.fetchKey] - Allows falling back to a different bucket key if `key` is not correct.
 * @param {Object} [options.ctx] - Execution context for background tasks.
 * @param {boolean} [options.immutable=false] - Flags caching headers as immutable.
 * @param {Function} [options.onDiskMiss] - Callback (buffer, forceReindex) triggered strictly on network fetch.
 * @returns {Promise<Response>} A fully formed HTTP Response ready for the client socket.
 */
export async function serveR2(env, request, key, cache, { transform, fetchKey, ctx, immutable, onDiskMiss } = {}) {
  const isHead = request.method === "HEAD";
  
  const obj = isHead && !transform 
    ? await r2Head(env, fetchKey ?? key, cache) 
    : await r2Get(env, fetchKey ?? key, cache, ctx, { onDiskMiss });
    
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
