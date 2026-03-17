/**
 * debthin - Cloudflare Worker
 *
 * Serves curated apt indices from R2 for Debian and Ubuntu.
 * R2 bucket:  DEBTHIN_BUCKET
 */

// ── Constants ─────────────────────────────────────────────────────────────────

// Pre-built plain header objects — defined once at module load.
// Plain objects are spreadable in serveR2 (hot path) and accepted by the
// Headers constructor at cold-path call sites.
const H_BASE = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "sameorigin",
  "Referrer-Policy": "no-referrer",
  "X-Xss-Protection": "1",
  "Permissions-Policy": "interest-cohort=()",
  "X-Clacks-Overhead": "GNU Terry Pratchett"
});

const H_CACHED = Object.freeze({ ...H_BASE, "Cache-Control": "public, max-age=3600, no-transform" });
const H_IMMUTABLE = Object.freeze({ ...H_BASE, "Cache-Control": "public, max-age=31536000, immutable, no-transform" });


// Empty file hashes (e3b0c442... is an empty file, ac39ce29... is an empty gzip file)
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_GZ_HASH = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";
const EMPTY_GZ = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 4, 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// ── R2 helpers & Isolate Cache ────────────────────────────────────────────────
//
// Fixed-size cache: MAX_CACHE_SLOTS slots pre-allocated as parallel typed arrays.
// All hot-path state (hits, lastUsed, byteLength) lives in Uint32Array —
// no object allocation or GC pressure on reads. Payload (buf, meta, key) is stored in
// plain arrays indexed by slot number.
//
// Slot lookup:   _cacheIndex Map<key, slot>   — one Map.get on the hot path
// LRU eviction:  linear scan of _cacheLastUsed — O(n=256), runs only when full
//
// Layout:
//   _cacheIndex    Map<string, uint8>   key → slot index
//   _cacheBuf      Array[256]           ArrayBuffer payload
//   _cacheMeta     Array[256]           metadata object
//   _cacheKey      Array[256]           string key (needed for eviction)
//   _cacheHits     Int32Array[256]      hit counter
//   _cacheLastUsed Uint32Array[256]     serve counter snapshot at last access
//   _cacheBytes    Int32Array[256]      buf.byteLength (avoid re-reading ArrayBuffer)

const MAX_CACHE_SLOTS = 256;

const _textDecoder = new TextDecoder();
const _cacheIndex = new Map();                          // key → slot
const _cacheBuf = new Array(MAX_CACHE_SLOTS).fill(null); // ArrayBuffer per slot
const _cacheMeta = new Array(MAX_CACHE_SLOTS).fill(null); // metadata per slot
const _cacheKey = new Array(MAX_CACHE_SLOTS).fill(null); // key string per slot (for eviction)
const _cacheHits = new Int32Array(MAX_CACHE_SLOTS);    // hit counters
const _cacheLastUsed = new Uint32Array(MAX_CACHE_SLOTS);   // serve counter at last access
const _cacheBytes = new Int32Array(MAX_CACHE_SLOTS);    // buf.byteLength per slot
const _cacheAddedAt = new Float64Array(MAX_CACHE_SLOTS); // Date.now() timestamp when cached
let _cacheClock = 0;   // Uint32 serve counter; wraps at 2^32 (~4B hits) — safe for any isolate lifetime
let _cacheSize = 0;   // total bytes across all occupied slots
let _cacheFreeSlot = 0;   // next slot to use when cache is not yet full

const MAX_CACHE_SIZE = 96 * 1024 * 1024; // 96 MB byte-size ceiling (secondary guard)
const INDEX_TTL = 3600000; // 1 hour in ms

function _evictLRU() {
  // Linear scan for lowest lastUsed value — O(256), only runs when all slots occupied.
  // Uint32 wraparound is safe: evicted slots are zeroed, so after a wrap the lowest
  // Uint32 value is still the slot accessed least recently within the current epoch.
  let lruSlot = 0, lruTime = _cacheLastUsed[0];
  for (let i = 1; i < MAX_CACHE_SLOTS; i++) {
    if (_cacheLastUsed[i] < lruTime) { lruTime = _cacheLastUsed[i]; lruSlot = i; }
  }
  _cacheIndex.delete(_cacheKey[lruSlot]);
  _cacheSize -= _cacheBytes[lruSlot];
  _cacheBuf[lruSlot] = null;
  _cacheMeta[lruSlot] = null;
  _cacheKey[lruSlot] = null;
  _cacheHits[lruSlot] = 0;
  _cacheLastUsed[lruSlot] = 0;
  _cacheBytes[lruSlot] = 0;
  _cacheAddedAt[lruSlot] = 0;
  return lruSlot;
}

function addToCache(key, buf, meta) {
  let slot = _cacheIndex.get(key);
  if (slot !== undefined) {
    // Refresh existing slot in-place — preserve hit count, update payload.
    _cacheSize -= _cacheBytes[slot];
  } else {
    // Allocate a new slot: use free slot counter until full, then evict LRU.
    if (_cacheFreeSlot < MAX_CACHE_SLOTS) {
      slot = _cacheFreeSlot++;
    } else {
      slot = _evictLRU();
    }
    _cacheIndex.set(key, slot);
    _cacheKey[slot] = key;
    _cacheHits[slot] = 0;
    _cacheLastUsed[slot] = _cacheClock = (_cacheClock + 1) >>> 0;
  }
  _cacheBuf[slot] = buf;
  _cacheMeta[slot] = meta;
  _cacheBytes[slot] = buf.byteLength;
  _cacheAddedAt[slot] = Date.now();
  _cacheSize += buf.byteLength;

  // Byte-size ceiling: evict until under limit (rare — slot limit is the primary guard).
  while (_cacheSize > MAX_CACHE_SIZE && _cacheIndex.size > 0) _evictLRU();
}

function getFromCache(key) {
  const slot = _cacheIndex.get(key);
  if (slot === undefined) return null;
  _cacheHits[slot]++;
  _cacheLastUsed[slot] = _cacheClock = (_cacheClock + 1) >>> 0;
  return { buf: _cacheBuf[slot], meta: _cacheMeta[slot], hits: _cacheHits[slot], addedAt: _cacheAddedAt[slot] };
}

/**
 * Wraps an in-memory buffer as an R2-compatible response object.
 *
 * @param {ArrayBuffer} arrayBuffer - The file content.
 * @param {Object} meta - Metadata including etag and lastModified (ms timestamp or null).
 * @param {boolean} [isCached=false] - Whether this object was served from the isolate cache.
 * @param {number} [hits=0] - Isolate cache hit count.
 * @returns {Object} R2 object interface compatible with Cloudflare Workers.
 */
function wrapCachedObject(arrayBuffer, meta, isCached = false, hits = 0) {
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
 * R2 HEAD request wrapper with isolate caching.
 *
 * @param {Object} env - The Cloudflare Worker environment.
 * @param {string} key - The R2 object key to fetch.
 * @returns {Promise<Object|null>} A mock R2 object metadata wrapper, or null if not found.
 */
async function r2Head(env, key) {
  let cached = getFromCache(key);
  if (cached) {
    const isRelease = key.endsWith("InRelease") || key.endsWith("Release");
    if (isRelease && (Date.now() - cached.addedAt > INDEX_TTL)) {
      cached = null;
    }
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
 * R2 GET request wrapper with isolate caching and automatic background cache warming.
 *
 * @param {Object} env - The Cloudflare Worker environment.
 * @param {string} key - The R2 object key to fetch.
 * @param {Object} [ctx] - The execution context for background tasks.
 * @returns {Promise<Object|null>} A mock R2 object containing the body and metadata, or null if not found.
 */
async function r2Get(env, key, ctx) {
  let cached = getFromCache(key);
  let forceReindex = false;

  const isRelease = key.endsWith("InRelease") || key.endsWith("Release");
  if (cached && isRelease && (Date.now() - cached.addedAt > INDEX_TTL)) {
    cached = null;
    forceReindex = true;
  }

  if (cached) return wrapCachedObject(cached.buf, cached.meta, true, cached.hits);
  const obj = await env.DEBTHIN_BUCKET.get(key);
  if (!obj) return null;

  const buf = await obj.arrayBuffer();
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag; // preserve native ETag from bucket
  meta.lastModified = obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) * 1000 : null;

  addToCache(key, buf, meta);

  // Warm RAM cache from Release/InRelease files (Async background task)
  if (isRelease) {
    const { p0, p1, p2 } = tokenizePath(key);
    if (p0 === "dists" && p1 && p2) {
      const distroIndex = _hashIndexes.get(p1);

      // Skip expensive text decode and parsing if the cache is already warm
      if (!distroIndex || forceReindex) {
        const text = _textDecoder.decode(buf);
        const suiteRoot = `${p0}/${p1}/${p2}`;
        if (ctx) {
          ctx.waitUntil(Promise.resolve(warmRamCacheFromRelease(env, text, suiteRoot, forceReindex)));
        } else {
          warmRamCacheFromRelease(env, text, suiteRoot, forceReindex);
        }
      }
    }
  }
  return wrapCachedObject(buf, meta, false, 0);
}

/**
 * Parses Release/InRelease text to pre-warm the RAM cache with by-hash routing info
 * and empty file definitions, preventing expensive lookups during apt fetches.
 *
 * @param {Object} env - The Cloudflare Worker environment.
 * @param {string} text - The raw text of the InRelease/Release file.
 * @param {string} suiteRoot - The base path of the suite (e.g., "dists/debian/trixie").
 */
function warmRamCacheFromRelease(env, text, suiteRoot, forceReindex = false) {
  const sectionIdx = text.indexOf("\nSHA256:");
  if (sectionIdx === -1) return;

  const distro = suiteRoot.split("/")[1];
  const prefixLen = 6 + distro.length + 1; // "dists/".length + distro.length + "/".length
  
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
      if (!_cacheIndex.has(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, EMPTY_GZ, { contentType: "application/x-gzip" });
    } else if (hash === EMPTY_HASH) {
      if (!_cacheIndex.has(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, new ArrayBuffer(0), { contentType: "text/plain; charset=utf-8" });
    }

    if (hash.length === 64 && name.endsWith(".gz")) {
      // Only write if we have a plain object; if it's a Promise, handleRequest will merge
      if (!(distroIndex instanceof Promise)) {
        distroIndex[hash] = suiteRoot.slice(prefixLen) + "/" + name;
      }
    }

    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
}

// ── Utility Helpers ───────────────────────────────────────────────────────────

function isHex64(s) {
  if (s.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

function getContentType(key) {
  if (key.endsWith(".gz")) return "application/x-gzip";
  if (key.endsWith(".lz4")) return "application/x-lz4";
  if (key.endsWith(".xz")) return "application/x-xz";
  if (key.endsWith(".gpg")) return "application/pgp-keys";
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

// ── 304 Not Modified? ────────────────────────────────────────────────────────
/**
 * Checks if the requested resource has been modified based on ETag and Last-Modified headers.
 *
 * @param {Headers} requestHeaders - The incoming request headers.
 * @param {Object} obj - The mock R2 object containing metadata.
 * @returns {boolean} True if the resource is not modified (should return 304), false otherwise.
 */
function isNotModified(requestHeaders, obj) {
  const reqEtag = requestHeaders.get("if-none-match");
  // RFC 7232: If-None-Match takes precedence over If-Modified-Since
  if (reqEtag) {
    return reqEtag === "*" || reqEtag === obj.etag;
  }

  const reqIms = requestHeaders.get("if-modified-since");
  if (reqIms && obj.lastModified) {
    const clientDate = Date.parse(reqIms);
    // obj.lastModified is already rounded to seconds in r2Get/r2Head
    return !isNaN(clientDate) && obj.lastModified <= clientDate;
  }
  return false;
}

/**
 * R2 Fetch Handler
 *
 * @param {Object} env - The Cloudflare Worker environment.
 * @param {Request} request - The incoming HTTP request.
 * @param {string} key - R2 key to fetch.
 * @param {Object} [options] - Options object.
 * @param {string} [options.transform] - "strip-pgp" strips the PGP wrapper from an InRelease file to
 *                             produce a plain Release. "decompress" gunzips on the fly (for Packages).
 * @param {string} [options.fetchKey]  - overrides the R2 key used to fetch (e.g. Release → InRelease).
 * @param {Object} [options.ctx] - Execution context for background tasks (e.g. cache warming).
 */
async function serveR2(env, request, key, { transform, fetchKey, ctx, immutable } = {}) {
  const isHead = request.method === "HEAD";
  // For HEAD without transform we only need metadata; r2Head avoids fetching the body.
  // With transform we must fetch the body to apply it, even for HEAD, so r2Get is used.
  const obj = isHead && !transform ? await r2Head(env, fetchKey ?? key) : await r2Get(env, fetchKey ?? key, ctx);
  if (!obj) return new Response("Not found\n", { status: 404, headers: { ...H_CACHED, "X-Cache": "MISS" } });

  // Build response headers as a plain object — cheaper than Headers cloning on the hot path.
  // CF's Response constructor accepts plain objects directly.
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

  if (isNotModified(request.headers, obj)) {
    return new Response(null, { status: 304, headers: h });
  }

  if (transform === "strip-pgp") {
    h["Content-Type"] = "text/plain; charset=utf-8";
    h["X-Debthin"] = "hit-derived";
    return new Response(inReleaseToRelease(await obj.text()), { headers: h });
  }

  if (transform === "decompress") {
    const buf = await obj.arrayBuffer();
    h["Content-Type"] = "text/plain; charset=utf-8";
    h["X-Debthin"] = "hit-decomp";
    if (!buf.byteLength) return new Response("", { headers: h });

    // Create a fresh stream from the buffer and pipe through decompression
    const ds = new DecompressionStream("gzip");
    const decompressed = new Response(buf).body.pipeThrough(ds);
    return new Response(decompressed, { headers: h });
  }

  h["Content-Type"] = obj.httpMetadata?.contentType || getContentType(key);
  return new Response(obj.body, { headers: h });
}

// ── Config (loaded once per isolate lifetime) ─────────────────────────────────

const _hashIndexes = new Map();

import rawConfig from '../config.json';

const { DERIVED_CONFIG, CONFIG_JSON_STRING } = (() => {
  const config = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig.default || rawConfig;
  const configString = typeof rawConfig === "string" ? rawConfig : JSON.stringify(config);

  const derived = {};
  for (const [distro, c] of Object.entries(config)) {
    const upstreamRaw = c.upstream ?? c.upstream_archive ?? c.upstream_ports;
    if (!upstreamRaw) continue;
    const upstream = upstreamRaw.slice(upstreamRaw.indexOf("//") + 2); // strip protocol
    const components = new Set(c.components);
    const archArrays = [c.arches, c.archive_arches, c.ports_arches].filter(Boolean);
    const arches = new Set(["all", ...archArrays.flat()]);
    const aliasMap = new Map();
    const suites = new Set(Object.keys(c.suites ?? {}));
    for (const [suite, meta] of Object.entries(c.suites ?? {})) {
      if (meta.aliases) for (const alias of meta.aliases) aliasMap.set(alias, suite);
    }
    derived[distro] = { upstream, components, arches, aliasMap, suites };
  }
  return { DERIVED_CONFIG: derived, CONFIG_JSON_STRING: configString };
})();


// ── Release helpers ───────────────────────────────────────────────────────────

function inReleaseToRelease(text) {
  // Find the cleartext body between the PGP header and the signature block.
  // Debian InRelease files always have a PGP armour header before "Origin:", so
  // the "\n" prefix is always present. If for any reason it isn't, we return
  // the raw text unchanged rather than stripping nothing silently.
  const start = text.indexOf("\nOrigin:");
  if (start === -1) return text;
  const sigStart = text.indexOf("\n-----BEGIN PGP SIGNATURE-----");
  const end = sigStart === -1 ? text.length : sigStart;
  return text.slice(start + 1, end).trimEnd() + "\n";
}

/**
 * Extracts URL path segments recursively without Array splitting or GC thrashing.
 * Efficiently slices strings using indexOf boundaries.
 *
 * @param {string} path - The relative repository path (e.g., "dists/debian/trixie/Release").
 * @returns {Object} An object containing up to 5 positional path segments (p0 to p4).
 */
function tokenizePath(path) {
  const parts = {};
  const s1 = path.indexOf("/");
  if (s1 === -1) return parts;

  const s2 = path.indexOf("/", s1 + 1);
  const s3 = s2 !== -1 ? path.indexOf("/", s2 + 1) : -1;
  const s4 = s3 !== -1 ? path.indexOf("/", s3 + 1) : -1;

  parts.p0 = path.slice(0, s1);
  parts.p1 = path.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
  if (s2 !== -1) parts.p2 = path.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
  if (s3 !== -1) parts.p3 = path.slice(s3 + 1, s4 !== -1 ? s4 : undefined);
  if (s4 !== -1) parts.p4 = path.slice(s4 + 1);

  return parts;
}


/**
 * Parses the incoming request URL to efficiently extract the protocol and raw path.
 *
 * @param {Request} request - The incoming HTTP request.
 * @returns {Object} Extracted `protocol` ("http" or "https") and `rawPath`.
 */
function parseURL(request) {
  const urlStr = request.url;
  const protocol = request.headers.get("x-forwarded-proto") === "http" ? "http" : "https";
  const pathStart = urlStr.indexOf("/", protocol.length + 3);
  const rawPath = pathStart === -1 ? "" : urlStr.slice(pathStart + 1);
  return { protocol, rawPath };
}

export default {
  async fetch(request, env, ctx) {
    const t0 = Date.now();

    let response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (err) {
      response = new Response("Internal Server Error", { status: 500 });
    }

    // Clone headers once to append X-Timer and X-Served-By.
    // Unavoidable for these two bolt-on headers; kept to exactly two set() calls.
    // X-Timer: integer ms — toFixed(6) on a ms-resolution clock is false precision.
    const h = new Headers(response.headers);
    h.set("X-Timer", `S${t0},VS0,VE${Date.now() - t0}`);
    h.set("X-Served-By", `cache-${request.cf?.colo ?? "UNKNOWN"}-debthin`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: h
    });
  }
};

async function handleRequest(request, env, ctx) {
  // ── Method check ───────────────────────────────────────────────────────────
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", { status: 405, headers: { "Allow": "GET, HEAD" } });
  }
  // ── Query string check ───────────────────────────────────────────────────────
  if (request.url.indexOf("?") !== -1) {
    return new Response("Bad Request\n", { status: 400 });
  }

  const { protocol, rawPath } = parseURL(request);

  if (rawPath.includes("..")) {
    return new Response("Bad Request\n", { status: 400 });
  }

  const slash = rawPath.indexOf("/");

  // ── Static Assets Fast Path ───────────────────────────────────────────────
  if (slash === -1) {
    if (rawPath === "robots.txt") {
      const hr = new Headers(H_CACHED);
      hr.set("Content-Type", "text/plain; charset=utf-8");
      hr.set("X-Debthin", "hit-synthetic");
      hr.set("X-Cache", "HIT");
      hr.set("X-Cache-Hits", "0");
      return new Response("User-agent: *\nAllow: /$\nDisallow: /\n", { headers: hr });
    }
    if (rawPath === "config.json") {
      const hc = new Headers(H_CACHED);
      hc.set("Content-Type", "application/json; charset=utf-8");
      hc.set("X-Debthin", "hit-synthetic");
      hc.set("X-Cache", "HIT");
      hc.set("X-Cache-Hits", "0");
      return new Response(CONFIG_JSON_STRING, { headers: hc });
    }
    return serveR2(env, request, rawPath === "" ? "index.html" : rawPath);
  }

  const first = rawPath.slice(0, slash);

  // Explicit distro check
  if (!DERIVED_CONFIG[first]) {
    return new Response("Not found\n", { status: 404 });
  }

  const distro = first;
  const rest = rawPath.slice(slash + 1);

  // pool/ requests are .deb downloads - redirect immediately, no further dispatch needed
  // example: https://deb.debian.org/debian/pool/main/a/apt/apt_2.8.1_amd64.deb
  if (rest.startsWith("pool/")) {
    const { upstream } = DERIVED_CONFIG[distro];
    return new Response(null, {
      status: 301,
      headers: { "Location": `${protocol}://${upstream}/${rest}` }
    });
  }

  const { upstream, components, arches, aliasMap, suites } = DERIVED_CONFIG[distro];

  let suitePath = rest;
  let { p0, p1, p2, p3, p4 } = tokenizePath(rest);

  // ── Alias resolution for suites (e.g. "stable" → "bookworm") ──────────────────
  if (p0 === "dists" && p1 && !suites.has(p1)) {
    const canonical = aliasMap.get(p1);
    if (canonical) {
      p1 = canonical;
      const tailIdx = rest.indexOf("/", 6);
      suitePath = "dists/" + canonical + (tailIdx === -1 ? "" : rest.slice(tailIdx));
    }
  }

  const r2Key = `dists/${distro}/${suitePath.slice(6)}`;

  // ── Hash Index Lookup (dists/debian/...) ───────────────────────────────
  if (p0 === "dists" && p1 && p2) {
    if (!p3) {
      if (p2 === "InRelease" || p2 === "Release.gpg") {
        return serveR2(env, request, r2Key, { ctx });
      }
      if (p2 === "Release") return serveR2(env, request, r2Key, { fetchKey: r2Key.replace("Release", "InRelease"), transform: "strip-pgp", ctx });
    }

    // ── Packages & Hashes (dists/debian/.../binary-amd64/...) ──────────────────
    if (p3 && components.has(p2) && p3.startsWith("binary-") && arches.has(p3.slice(7))) {
      if (p4 === "Release") {
        const hbr = new Headers(H_CACHED);
        hbr.set("Content-Type", "text/plain; charset=utf-8");
        hbr.set("X-Debthin", "hit-generated");
        hbr.set("X-Cache", "HIT");
        hbr.set("X-Cache-Hits", "0");
        return new Response(`Archive: ${p1}\nComponent: ${p2}\nArchitecture: ${p3.slice(7)}\n`, { headers: hbr });
      }
      if (p4 === "Packages") {
        return serveR2(env, request, r2Key, { fetchKey: r2Key + ".gz", transform: "decompress" });
      }
      if (p4 === "Packages.gz" || p4 === "Packages.lz4" || p4 === "Packages.xz") {
        return serveR2(env, request, r2Key);
      }
    }

    // ── Hash Index Lookup (dists/debian/.../by-hash/SHA256/...) ──────────────────
    const byHashIdx = suitePath.indexOf("/by-hash/SHA256/");
    if (byHashIdx !== -1) {
      const sha256 = suitePath.slice(byHashIdx + 16);

      // ── Empty File Hashes ──────────────────────────────────────────────────────
      if (sha256 === EMPTY_GZ_HASH) {
        const heg = new Headers(H_IMMUTABLE);
        heg.set("Content-Type", "application/x-gzip");
        return new Response(request.method === "HEAD" ? null : EMPTY_GZ, { headers: heg });
      }
      if (sha256 === EMPTY_HASH) {
        const hep = new Headers(H_IMMUTABLE);
        hep.set("Content-Type", "text/plain; charset=utf-8");
        return new Response("", { headers: hep });
      }

      // ── Hash Index Lookup (dists/debian/.../by-hash/SHA256/...) ──────────────────
      if (sha256.length === 64 && isHex64(sha256)) {
        let distroIndex = _hashIndexes.get(distro);

        if (!distroIndex || distroIndex instanceof Promise) {
          if (!distroIndex) {
            const promise = r2Get(env, `dists/${distro}/by-hash-index.json`, ctx).then(async obj => {
              const json = obj ? JSON.parse(await obj.text()) : {};
              const current = _hashIndexes.get(distro);
              // Merge: background-warmed hashes (current) take precedence over JSON
              const freshData = (current instanceof Promise || !current) ? {} : current;
              return Object.assign(json, freshData);
            }).catch(() => ({}));
            _hashIndexes.set(distro, promise);
            distroIndex = promise;
          }
          distroIndex = await distroIndex;
          _hashIndexes.set(distro, distroIndex);
        }

        const relPath = distroIndex[sha256];
        if (relPath) return serveR2(env, request, `dists/${distro}/${relPath}`, { immutable: true });
        return new Response("Not found\n", { status: 404 });
      }
    }
  }
  // ── Redirect to upstream for unhandled paths ──────────────────────────────────────
  return new Response(null, {
    status: 301,
    headers: { "Location": `${protocol}://${upstream}/${suitePath}` }
  });
}
