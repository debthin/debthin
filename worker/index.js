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
    body: arrayBuffer.byteLength ? new Response(arrayBuffer).body : null,
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

  const reqEtag = request.headers.get("if-none-match");
  if (reqEtag && obj.etag && reqEtag === obj.etag) {
     return new Response(null, { status: 304, headers: commonHeaders });
  }

  const reqIms = request.headers.get("if-modified-since");
  if (reqIms && obj.lastModified) {
     const clientDate = new Date(reqIms);
     const serverDate = new Date(obj.lastModified);
     // 304 if the server's resource is older or same age as the client's cache
     if (!isNaN(clientDate) && serverDate <= clientDate) {
        return new Response(null, { status: 304, headers: commonHeaders });
     }
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

  const ct = obj.httpMetadata?.contentType || (
    key.endsWith(".gz")   ? "application/x-gzip"       :
    key.endsWith(".lz4")  ? "application/x-lz4"        :
    key.endsWith(".xz")   ? "application/x-xz"         :
    key.endsWith(".gpg")  ? "application/pgp-keys"      :
    key.endsWith(".html") ? "text/html; charset=utf-8"  :
    key.endsWith(".json") ? "application/json"          :
    "text/plain; charset=utf-8"
  );
  
  commonHeaders["Content-Type"] = ct;
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



export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { "Allow": "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const urlStr = request.url;
    const isHttps = urlStr.charCodeAt(4) === 115; // 's' is 115
    const pathStart = urlStr.indexOf("/", isHttps ? 8 : 7);
    const rawPath = pathStart === -1 ? "" : urlStr.slice(pathStart + 1);
    
    if (rawPath.indexOf("?") !== -1) {
      return new Response("Bad Request: Query strings are not supported\n", { status: 400 });
    }
    
    const raw = rawPath;
    const protocol = isHttps ? "https:" : "http:";

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
    
    // Instead of splitting array and GC'ing, inline the slashes
    let p0, p1, p2, p3, p4 = undefined;
    const s1 = suitePath.indexOf("/");
    const s2 = s1 !== -1 ? suitePath.indexOf("/", s1 + 1) : -1;
    const s3 = s2 !== -1 ? suitePath.indexOf("/", s2 + 1) : -1;
    const s4 = s3 !== -1 ? suitePath.indexOf("/", s3 + 1) : -1;
    
    if (s1 !== -1) {
       p0 = suitePath.slice(0, s1);
       p1 = suitePath.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
       if (s2 !== -1) p2 = suitePath.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
       if (s3 !== -1) p3 = suitePath.slice(s3 + 1, s4 !== -1 ? s4 : undefined);
       if (s4 !== -1) p4 = suitePath.slice(s4 + 1);
    }

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
