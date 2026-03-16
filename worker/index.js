/**
 * debthin - Cloudflare Worker
 *
 * Serves curated apt indices from R2 for Debian and Ubuntu.
 * R2 bucket:  DEBTHIN_BUCKET
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "sameorigin",
  "Referrer-Policy": "no-referrer",
  "X-Xss-Protection": "1",
  "Permissions-Policy": "interest-cohort=()",
  "X-Clacks-Overhead": "GNU Terry Pratchett"
};

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600", ...BASE_HEADERS };
const IMMUTABLE_CACHE_HEADERS = { "Cache-Control": "public, max-age=31536000, immutable", ...BASE_HEADERS };
const SYNTHETIC_HIT_HEADERS = { "X-Cache": "HIT", "X-Cache-Hits": "0" };

// Empty file hashes (e3b0c442... is an empty file, ac39ce29... is an empty gzip file)
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_GZ_HASH = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";
const EMPTY_GZ = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 4, 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;

// ── R2 helpers & Isolate Cache ────────────────────────────────────────────────

const _r2Cache = new Map();
let _r2CacheSize = 0;
const MAX_CACHE_SIZE = 96 * 1024 * 1024; // 96 MB maximum isolate RAM for cache

function addToCache(key, buf, meta) {
  if (_r2Cache.has(key)) {
    _r2CacheSize -= _r2Cache.get(key).buf.byteLength;
    _r2Cache.delete(key);
  }
  _r2Cache.set(key, { buf, meta, hits: 0 });
  _r2CacheSize += buf.byteLength;

  // Prune oldest (LRU) until we're under the high watermark
  while (_r2CacheSize > MAX_CACHE_SIZE && _r2Cache.size > 0) {
    const oldestKey = _r2Cache.keys().next().value;
    _r2CacheSize -= _r2Cache.get(oldestKey).buf.byteLength;
    _r2Cache.delete(oldestKey);
  }
}

function getFromCache(key) {
  if (!_r2Cache.has(key)) return null;
  const val = _r2Cache.get(key);
  val.hits++;
  // Re-insert to mark as recently used
  _r2Cache.delete(key);
  _r2Cache.set(key, val);
  return val;
}

/**
 * Creates a mock R2 object for in-memory caching.
 *
 * @param {ArrayBuffer} arrayBuffer - The file content.
 * @param {Object} meta - Metadata including etag and lastModified.
 * @param {boolean} [isCached=false] - Whether this object was served from the isolate cache.
 * @returns {Object} Mock R2 object interface compatible with Cloudflare Workers.
 */
function createMockR2Object(arrayBuffer, meta, isCached = false, hits = 0) {
  return {
    get body() { return arrayBuffer.byteLength ? new Response(arrayBuffer).body : null; },
    httpMetadata: meta,
    etag: meta.etag || `W/"${arrayBuffer.byteLength}-${Date.now()}"`,
    lastModified: meta.lastModified || new Date().toUTCString(),
    isCached,
    hits,
    async arrayBuffer() { return arrayBuffer; },
    async text() { return new TextDecoder().decode(arrayBuffer); }
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
  const cached = getFromCache(key);
  if (cached) return createMockR2Object(new ArrayBuffer(0), cached.meta, true, cached.hits);
  const obj = await env.DEBTHIN_BUCKET.head(key);
  if (!obj) return null;
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag;
  meta.lastModified = obj.uploaded ? obj.uploaded.toUTCString() : null;
  return createMockR2Object(new ArrayBuffer(0), meta, false, 0);
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
  const cached = getFromCache(key);
  if (cached) return createMockR2Object(cached.buf, cached.meta, true, cached.hits);
  const obj = await env.DEBTHIN_BUCKET.get(key);
  if (!obj) return null;

  const buf = await obj.arrayBuffer();
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag; // preserve native ETag from bucket
  meta.lastModified = obj.uploaded ? obj.uploaded.toUTCString() : null;

  addToCache(key, buf, meta);

  // Warm RAM cache from Release/InRelease files (Async background task)
  if (key.endsWith("InRelease") || key.endsWith("Release")) {
    const parts = key.split("/");
    if (parts.length >= 3 && parts[0] === "dists") {
      const distro = parts[1];
      const distroIndex = _hashIndexes.get(distro);

      // Skip expensive text decode and parsing if the cache is already warm
      if (!distroIndex || (typeof distroIndex === 'object' && distroIndex instanceof Promise)) {
        const text = new TextDecoder().decode(buf);
        const suiteRoot = parts.slice(0, 3).join("/"); // e.g. dists/debian/trixie
        if (ctx) {
          ctx.waitUntil(Promise.resolve().then(() => warmRamCacheFromRelease(env, text, suiteRoot)));
        } else {
          warmRamCacheFromRelease(env, text, suiteRoot);
        }
      }
    }
  }
  return createMockR2Object(buf, meta, false, 0);
}

/**
 * Parses Release/InRelease text to pre-warm the RAM cache with by-hash routing info
 * and empty file definitions, preventing expensive lookups during apt fetches.
 *
 * @param {Object} env - The Cloudflare Worker environment.
 * @param {string} text - The raw text of the InRelease/Release file.
 * @param {string} suiteRoot - The base path of the suite (e.g., "dists/debian/trixie").
 */
function warmRamCacheFromRelease(env, text, suiteRoot) {
  const sectionIdx = text.indexOf("\nSHA256:");
  if (sectionIdx === -1) return;

  const distro = suiteRoot.split("/")[1];
  const prefixLen = 7 + distro.length; // "dists/".length + distro.length + 1
  let distroIndex = _hashIndexes.get(distro);
  if (!distroIndex || distroIndex instanceof Promise) {
    distroIndex = typeof distroIndex === 'object' && distroIndex !== null && !(distroIndex instanceof Promise) ? distroIndex : {};
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
      if (!_r2Cache.has(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, EMPTY_GZ, { contentType: "application/x-gzip" });
    } else if (hash === EMPTY_HASH) {
      if (!_r2Cache.has(`${suiteRoot}/${name}`)) addToCache(`${suiteRoot}/${name}`, new ArrayBuffer(0), { contentType: "text/plain; charset=utf-8" });
    }

    if (hash.length === 64 && name.endsWith(".gz")) {
      distroIndex[hash] = suiteRoot.slice(prefixLen) + "/" + name;
    }

    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
}

// ── Utility Helpers ───────────────────────────────────────────────────────────

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
  if (reqEtag && obj.etag && reqEtag === obj.etag) return true;

  const reqIms = requestHeaders.get("if-modified-since");
  if (reqIms && obj.lastModified) {
    const clientDate = Date.parse(reqIms);
    const serverDate = Date.parse(obj.lastModified);
    if (!isNaN(clientDate) && serverDate <= clientDate) return true;
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
  const obj = isHead && !transform ? await r2Head(env, fetchKey ?? key) : await r2Get(env, fetchKey ?? key, ctx);
  if (!obj) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Cache": "MISS", ...BASE_HEADERS } });

  const hitType = obj.isCached ? "hit-isolate-cache" : "hit";
  const cacheOverride = immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : {};
  const commonHeaders = { 
    ...CACHE_HEADERS, 
    ...cacheOverride, 
    "X-Debthin": hitType,
    "X-Cache": obj.isCached ? "HIT" : "MISS",
    "X-Cache-Hits": obj.hits.toString()
  };
  if (obj.etag) commonHeaders.ETag = obj.etag;
  if (obj.lastModified) commonHeaders["Last-Modified"] = obj.lastModified;

  if (isNotModified(request.headers, obj)) {
    return new Response(null, { status: 304, headers: commonHeaders });
  }

  if (transform === "strip-pgp") {
    return new Response(inReleaseToRelease(await obj.text()), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...commonHeaders, "X-Debthin": "hit-derived" },
    });
  }

  if (transform === "decompress") {
    if (!obj.body) return new Response("", { headers: { ...commonHeaders, "X-Debthin": "hit-decomp" } });
    const ds = new DecompressionStream("gzip");
    return new Response(obj.body.pipeThrough(ds), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...commonHeaders, "X-Debthin": "hit-decomp" },
    });
  }

  commonHeaders["Content-Type"] = obj.httpMetadata?.contentType || getContentType(key);
  return new Response(obj.body, { headers: commonHeaders });
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
    const ts = (t0 / 1000).toFixed(6);

    let response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (err) {
      response = new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain", ...BASE_HEADERS } });
    }

    const newHeaders = new Headers(response.headers);
    const dur = ((Date.now() - t0) / 1000).toFixed(6);
    
    newHeaders.set("X-Timer", `S${ts},VS0,VE${dur}`);
    if (!newHeaders.has("X-Served-By")) {
      const colo = request.cf && request.cf.colo ? request.cf.colo : "FLX";
      newHeaders.set("X-Served-By", `cache-${colo}-debthin`);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};

async function handleRequest(request, env, ctx) {
    // ── Method check ───────────────────────────────────────────────────────────
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { "Allow": "GET, HEAD", "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS }
      });
    }
    // ── Query string check ───────────────────────────────────────────────────────
    if (request.url.indexOf("?") !== -1) {
      return new Response("Bad Request: Query strings are not supported\n", { 
        status: 400, 
        headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } 
      });
    }

    const { protocol, rawPath } = parseURL(request);

    const slash = rawPath.indexOf("/");

    // ── Static Assets Fast Path ───────────────────────────────────────────────
    if (slash === -1) {
      if (rawPath === "robots.txt") {
        return new Response("User-agent: *\nAllow: /$\nDisallow: /\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Debthin": "hit-synthetic", ...SYNTHETIC_HIT_HEADERS, ...BASE_HEADERS },
        });
      }
      if (rawPath === "config.json") {
        return new Response(CONFIG_JSON_STRING, {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Debthin": "hit-synthetic", ...SYNTHETIC_HIT_HEADERS, ...BASE_HEADERS },
        });
      }
      return serveR2(env, request, rawPath === "" ? "index.html" : rawPath);
    }

    const first = rawPath.slice(0, slash);

    // Explicit distro check
    if (!DERIVED_CONFIG[first]) {
      return new Response("Not found - Unknown distribution or endpoint\n", { 
        status: 404, 
        headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } 
      });
    }

    const distro = first;
    const rest = rawPath.slice(slash + 1);

    // pool/ requests are .deb downloads - redirect immediately, no further dispatch needed
    // example: https://deb.debian.org/debian/pool/main/a/apt/apt_2.8.1_amd64.deb
    if (rest.startsWith("pool/")) {
      const { upstream } = DERIVED_CONFIG[distro];
      return new Response(null, {
        status: 301,
        headers: { "Location": `${protocol}://${upstream}/${rest}`, ...BASE_HEADERS }
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
          return new Response(
            `Archive: ${p1}\nComponent: ${p2}\nArchitecture: ${p3.slice(7)}\n`,
            { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-generated", ...SYNTHETIC_HIT_HEADERS } }
          );
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
          return new Response(request.method === "HEAD" ? null : EMPTY_GZ, {
            headers: { "Content-Type": "application/x-gzip", ...IMMUTABLE_CACHE_HEADERS, "X-Debthin": "hit-empty", ...SYNTHETIC_HIT_HEADERS },
          });
        }
        if (sha256 === EMPTY_HASH) {
          return new Response("", {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...IMMUTABLE_CACHE_HEADERS, "X-Debthin": "hit-empty", ...SYNTHETIC_HIT_HEADERS },
          });
        }

        // ── Hash Index Lookup (dists/debian/.../by-hash/SHA256/...) ──────────────────
        if (sha256.length === 64 && /^[0-9a-f]+$/.test(sha256)) {
          let distroIndex = _hashIndexes.get(distro);

          // Check if we have a valid hash index, if not, fetch it from R2 and cache it
          if (!distroIndex || (typeof distroIndex === 'object' && distroIndex instanceof Promise)) {
            if (!distroIndex) {
              const promise = r2Get(env, `dists/${distro}/by-hash-index.json`, ctx).then(async obj => {
                if (obj) {
                  const json = JSON.parse(await obj.text());
                  const existing = _hashIndexes.get(distro);
                  return Object.assign({}, json, typeof existing === 'object' && !(existing instanceof Promise) ? existing : {});
                }
                return {};
              }).catch(() => ({}));
              _hashIndexes.set(distro, promise);
              distroIndex = promise;
            }
            distroIndex = await distroIndex;
          }

          const relPath = distroIndex[sha256];
          if (relPath) return serveR2(env, request, `dists/${distro}/${relPath}`, { immutable: true });
          return new Response("Not found\n", { 
            status: 404, 
            headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } 
          });
        }
      }
    }
    // ── Redirect to upstream for unhandled paths ──────────────────────────────────────
    return new Response(null, {
      status: 301,
      headers: { "Location": `${protocol}://${upstream}/${suitePath}`, ...BASE_HEADERS }
    });
}
