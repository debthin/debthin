/**
 * debthin - Cloudflare Worker
 *
 * Serves curated apt indices from R2 for Debian and Ubuntu.
 * R2 bucket:  DEBTHIN_BUCKET
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_HEADERS      = { "Cache-Control": "public, max-age=3600" };

// Empty file hashes (e3b0c442... is an empty file, ac39ce29... is an empty gzip file)
const EMPTY_HASH         = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_GZ_HASH      = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";
const EMPTY_GZ           = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 4, 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;

// ── R2 helpers & Isolate Cache ────────────────────────────────────────────────

const _r2Cache = new Map();

function createMockR2Object(arrayBuffer, meta, isCached = false) {
  return {
    get body() { return arrayBuffer.byteLength ? new Response(arrayBuffer).body : null; },
    httpMetadata: meta,
    etag: meta.etag || `W/"${arrayBuffer.byteLength}-${Date.now()}"`,
    lastModified: meta.lastModified || new Date().toUTCString(),
    isCached,
    async arrayBuffer() { return arrayBuffer; },
    async text() { return new TextDecoder().decode(arrayBuffer); }
  };
}

async function r2Head(env, key) {
  if (_r2Cache.has(key)) return createMockR2Object(new ArrayBuffer(0), _r2Cache.get(key).meta, true);
  const obj = await env.DEBTHIN_BUCKET.head(key);
  if (!obj) return null;
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag;
  meta.lastModified = obj.uploaded ? obj.uploaded.toUTCString() : null;
  return createMockR2Object(new ArrayBuffer(0), meta);
}

async function r2Get(env, key) {
  if (_r2Cache.has(key)) return createMockR2Object(_r2Cache.get(key).buf, _r2Cache.get(key).meta, true);
  const obj = await env.DEBTHIN_BUCKET.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  const meta = obj.httpMetadata || {};
  meta.etag = obj.etag; // preserve native ETag from bucket
  meta.lastModified = obj.uploaded ? obj.uploaded.toUTCString() : null;
  _r2Cache.set(key, { buf, meta });

  if (key.endsWith("InRelease") || key.endsWith("Release")) {
    const text = new TextDecoder().decode(buf);
    const parts = key.split("/");
    if (parts.length >= 3 && parts[0] === "dists") {
      const suiteRoot = parts.slice(0, 3).join("/"); // e.g. dists/debian/trixie
      warmRamCacheFromRelease(env, text, suiteRoot);
    }
  }
  return createMockR2Object(buf, meta);
}

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
      _r2Cache.set(`${suiteRoot}/${name}`, { buf: EMPTY_GZ, meta: { contentType: "application/x-gzip" } });
    } else if (hash === EMPTY_HASH) {
      _r2Cache.set(`${suiteRoot}/${name}`, { buf: new ArrayBuffer(0), meta: { contentType: "text/plain; charset=utf-8" } });
    }
    
    if (hash.length === 64 && name.endsWith(".gz")) {
      distroIndex[hash] = suiteRoot.slice(prefixLen) + "/" + name;
    }
    
    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
}

const r2Put = (env, key, val, meta) => env.DEBTHIN_BUCKET.put(key, val, meta || {});

// ── Utility Helpers ───────────────────────────────────────────────────────────

function getContentType(key) {
  if (key.endsWith(".gz"))   return "application/x-gzip";
  if (key.endsWith(".lz4"))  return "application/x-lz4";
  if (key.endsWith(".xz"))   return "application/x-xz";
  if (key.endsWith(".gpg"))  return "application/pgp-keys";
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

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

// ── R2 Fetch Handlers ─────────────────────────────────────────────────────────

// transform: "strip-pgp" strips the PGP wrapper from an InRelease file to
// produce a plain Release. "decompress" gunzips on the fly (for Packages).
// fetchKey overrides the R2 key used to fetch (e.g. Release → InRelease).
async function serveR2(env, request, key, { transform, fetchKey } = {}) {
  const isHead = request.method === "HEAD";
  const obj = isHead && !transform ? await r2Head(env, fetchKey ?? key) : await r2Get(env, fetchKey ?? key);
  if (!obj) return new Response("Not found\n", { status: 404 });
  
  const hitType = obj.isCached ? "hit-isolate-cache" : "hit";
  const commonHeaders = { ...CACHE_HEADERS, "X-Debthin": hitType };
  if (obj.etag) commonHeaders.ETag = obj.etag;
  if (obj.lastModified) commonHeaders["Last-Modified"] = obj.lastModified;

  if (isNotModified(request.headers, obj)) {
     return new Response(null, { status: 304, headers: commonHeaders });
  }

  if (transform === "strip-pgp") {
    return new Response(inReleaseToRelease(await obj.text()), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-derived" },
    });
  }

  if (transform === "decompress") {
    const ds = new DecompressionStream("gzip");
    const w  = ds.writable.getWriter();
    w.write(await obj.arrayBuffer());
    w.close();
    return new Response(await new Response(ds.readable).arrayBuffer(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-decomp" },
    });
  }

  commonHeaders["Content-Type"] = obj.httpMetadata?.contentType || getContentType(key);
  return new Response(obj.body, { headers: commonHeaders });
}

// ── Config (loaded once per isolate lifetime) ─────────────────────────────────

const _hashIndexes = new Map();

import configText from '../config.json';
const config = typeof configText === "string" ? JSON.parse(configText) : configText.default || configText;

const DERIVED_CONFIG = (() => {
  const derived = {};
  for (const [distro, c] of Object.entries(config)) {
    const upstreamRaw = c.upstream ?? c.upstream_archive ?? c.upstream_ports;
    if (!upstreamRaw) continue;
    const upstream  = upstreamRaw.slice(upstreamRaw.indexOf("//") + 2); // strip protocol
    const components = new Set(c.components);
    const archArrays = [c.arches, c.archive_arches, c.ports_arches].filter(Boolean);
    const arches     = new Set(["all", ...archArrays.flat()]);
    const aliasMap   = new Map();
    for (const [suite, meta] of Object.entries(c.suites ?? {})) {
      if (meta.aliases) for (const alias of meta.aliases) aliasMap.set(alias, suite);
    }
    derived[distro] = { upstream, components, arches, aliasMap };
  }
  return derived;
})();

function resolveAlias(derived, distro, suitePath) {
  if (!suitePath.startsWith("dists/")) return suitePath;
  const slash2    = suitePath.indexOf("/", 6);
  const suite     = slash2 === -1 ? suitePath.slice(6) : suitePath.slice(6, slash2);
  const canonical = derived[distro].aliasMap.get(suite);
  if (!canonical) return suitePath;
  return "dists/" + canonical + suitePath.slice(slash2);
}

// ── Release helpers ───────────────────────────────────────────────────────────

function inReleaseToRelease(text) {
  // Find the cleartext body between the PGP header and the signature block.
  const start = text.indexOf("\nOrigin:");
  if (start === -1) return text;
  const sigStart = text.indexOf("\n-----BEGIN PGP SIGNATURE-----");
  const end = sigStart === -1 ? text.length : sigStart;
  return text.slice(start + 1, end).trimEnd() + "\n";
}

// Extract URL path segments recursively without Array splitting / GC thrashing
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



export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { "Allow": "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const url = new URL(request.url);
    if (url.search) {
      return new Response("Bad Request: Query strings are not supported\n", { status: 400 });
    }
    
    // Cloudflare natively handles upstream TLS offloading and sets x-forwarded-proto
    const protocol = request.headers.get("x-forwarded-proto") === "http" ? "http:" : "https:";
    const raw = url.pathname.slice(1);

    const slash   = raw.indexOf("/");

    // ── Static Assets Fast Path ───────────────────────────────────────────────
    if (slash === -1) {
      if (raw === "robots.txt") {
        return new Response("User-agent: *\nAllow: /$\nDisallow: /\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Debthin": "hit-synthetic" },
        });
      }
      if (raw === "config.json") {
        return new Response(typeof configText === "string" ? configText : JSON.stringify(configText), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Debthin": "hit-synthetic" },
        });
      }
      return serveR2(env, request, raw === "" ? "index.html" : raw);
    }

    const first   = raw.slice(0, slash);
    
    // Explicit distro check
    if (!DERIVED_CONFIG[first]) {
      return new Response("Not found - Unknown distribution or endpoint\n", { status: 404 });
    }
    
    const distro  = first;
    const rest    = slash === -1 ? "" : raw.slice(slash + 1);

    // pool/ requests are .deb downloads - redirect immediately, no further dispatch needed
    if (rest.startsWith("pool/")) {
      const { upstream } = DERIVED_CONFIG[distro];
      return Response.redirect(`${protocol}//${upstream}/${rest}`, 301);
    }

    const suitePath = resolveAlias(DERIVED_CONFIG, distro, rest);
    const r2Key     = `dists/${distro}/${suitePath.slice(6)}`;

    // Get a cached hash index map (will trigger async fetch if empty and unpopulated)
    const getHashIndex = async () => {
      let distroIndex = _hashIndexes.get(distro);
      // Soft populated index exists as raw object
      if (distroIndex && typeof distroIndex === 'object' && !(distroIndex instanceof Promise)) {
         return distroIndex;
      }
      if (!distroIndex) {
        const promise = r2Get(env, `dists/${distro}/by-hash-index.json`).then(async obj => {
          if (obj) {
             const json = JSON.parse(await obj.text());
             // Merge with any hashes that got softly populated while we were fetching
             const existing = _hashIndexes.get(distro);
             return Object.assign({}, json, typeof existing === 'object' && !(existing instanceof Promise) ? existing : {});
          }
          return {};
        }).catch(() => ({}));
        _hashIndexes.set(distro, promise);
        distroIndex = promise;
      }
      return distroIndex;
    };

    const { upstream, components, arches } = DERIVED_CONFIG[distro];
    
    const { p0, p1, p2, p3, p4 } = tokenizePath(suitePath);

    if (p0 === "dists" && p1 && p2) {
      if (!p3) {
        if (p2 === "InRelease" || p2 === "Release.gpg") {
          return serveR2(env, request, r2Key);
        }
        if (p2 === "Release") return serveR2(env, request, r2Key, { fetchKey: r2Key.replace("Release", "InRelease"), transform: "strip-pgp" });
      }

      if (p3 && components.has(p2) && p3.startsWith("binary-") && arches.has(p3.slice(7))) {
        if (p4 === "Release") {
          return new Response(
            `Archive: ${p1}\nComponent: ${p2}\nArchitecture: ${p3.slice(7)}\n`,
            { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-generated" } }
          );
        }
        if (p4 === "Packages") {
          return serveR2(env, request, r2Key, { fetchKey: r2Key + ".gz", transform: "decompress" });
        }
        if (p4 === "Packages.gz" || p4 === "Packages.lz4" || p4 === "Packages.xz") {
          return serveR2(env, request, r2Key);
        }
      }

      const byHashIdx = suitePath.indexOf("/by-hash/SHA256/");
      if (byHashIdx !== -1) {
        const sha256 = suitePath.slice(byHashIdx + 16);
        if (sha256 === EMPTY_GZ_HASH) {
          return new Response(request.method === "HEAD" ? null : EMPTY_GZ, {
            headers: { "Content-Type": "application/x-gzip", ...CACHE_HEADERS, "X-Debthin": "hit-empty" },
          });
        }
        if (sha256 === EMPTY_HASH) {
          return new Response("", {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-empty" },
          });
        }
        if (sha256.length === 64 && /^[0-9a-f]+$/.test(sha256)) {
          const index = await getHashIndex();
          const relPath = index[sha256];
          if (relPath) return serveR2(env, request, `dists/${distro}/${relPath}`);
          return new Response("Not found", { status: 404 });
        }
      }
    }

    return Response.redirect(`${protocol}//${upstream}/${suitePath}`, 301);
  },
};
