/**
 * @fileoverview Proxy route handlers executing curation extraction.
 * Distributes endpoint traffic across logically split metadata and packaging targets.
 */

import { r2Head } from '../../core/r2.js';
import { serveR2 } from '../../core/http.js';
import { extractInReleaseHash, verifyHash, proxyCacheBase } from '../utils.js';
import { filterPackages, serializePackages, reduceStreamToLatest } from '../packages.js';
import { proxyMetaCache, proxyDataCache } from '../cache.js';

const PROXY_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };
const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2 MB hard limit

const PERMANENT_BLOCKLIST = new Set([
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  "deb.debian.org",
  "security.debian.org",
  "ftp.debian.org",
  "kali.download"
]);

/**
 * Handles generating and mapping proxy Release manifests natively locally.
 */
async function handleProxyMetadata(request, env, ctx, parsed, blockKey) {
  const { host, suite, component, type, pin, arch } = parsed;
  const cacheKey = type === "arch-release" 
    ? proxyCacheBase(host, suite, component, pin, arch) + "/Release"
    : `proxy/${host}/${suite}/${type === "inrelease" ? "InRelease" : "Release"}`;

  const obj = await r2Head(env, cacheKey, proxyMetaCache);
  const fresh = obj && obj.lastModified && (Date.now() - obj.lastModified < PROXY_CACHE_TTL_MS);

  if (!fresh) {
    let up = false;
    try {
      // Execute HEAD probes concurrently, resolving immediately on the first success
      await Promise.any([
        fetch(`https://${host}/dists/${suite}/InRelease`, { method: "HEAD" }).then(r => r.ok ? r : Promise.reject()),
        fetch(`https://${host}/dists/${suite}/Release`, { method: "HEAD" }).then(r => r.ok ? r : Promise.reject()),
        fetch(`http://${host}/dists/${suite}/InRelease`, { method: "HEAD" }).then(r => r.ok ? r : Promise.reject())
      ]);
      up = true;
    } catch (e) {
      // AggregateError trapped cleanly natively on 3 failures
    }

    if (!up) {
      ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "404", { httpMetadata: { contentType: "text/plain" } }));
      return new Response("Not found (Upstream Repository Invalid)\n", { status: 404 });
    }

    const body = type === "arch-release"
      ? `Archive: ${suite}\nComponent: ${component}\nArchitecture: ${arch}\n`
      : [
          `Origin: debthin-proxy`,
          `Label: debthin-proxy/${host}`,
          `Suite: ${suite}`,
          `Codename: ${suite}`,
          `Date: ${new Date().toUTCString()}`,
          `Acquire-By-Hash: no`,
          `Description: debthin filtered proxy index for ${host}`,
        ].join("\n") + "\n";
        
    const buf = new TextEncoder().encode(body);
    const meta = { contentType: "text/plain; charset=utf-8" };
    
    ctx.waitUntil(env.DEBTHIN_BUCKET.put(cacheKey, buf, { httpMetadata: meta }));
    return new Response(body, { headers: { ...meta, ...CACHE_HEADERS, "X-Debthin": "proxy-release" } });
  }

  return serveR2(env, request, cacheKey, proxyMetaCache, { ctx });
}

// ── Packages Pipeline Sub-routines ──────────────────────────────────────────

/**
 * Verifies upstream liveness natively executing an InRelease HEAD check natively.
 */
async function checkUpstream304(host, suite, lastModified) {
  const irHeaders = lastModified ? { "If-Modified-Since": new Date(lastModified).toUTCString() } : {};
  try {
    const irResp = await fetch(`https://${host}/dists/${suite}/InRelease`, { headers: irHeaders });
    return irResp;
  } catch (e) {
    return null;
  }
}

/**
 * Fetches the upstream Packages block securely with size circuit breakers natively.
 */
async function fetchUpstreamPackages(host, pkgUrl, env, blockKey, ctx) {
  let pkgResp;
  try {
    pkgResp = await fetch(`https://${host}${pkgUrl}`);
    if (!pkgResp.ok) pkgResp = await fetch(`http://${host}${pkgUrl}`);
  } catch (e) {
    return null;
  }

  if (!pkgResp || !pkgResp.ok) return null;

  const cl = parseInt(pkgResp.headers.get("content-length") || "0", 10);
  if (cl > MAX_PAYLOAD_SIZE) {
    ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "too-large", { httpMetadata: { contentType: "text/plain" } }));
    throw new Error("EXCEEDS_MAX_SIZE");
  }

  let pkgBuf;
  try {
    pkgBuf = await pkgResp.arrayBuffer();
  } catch (e) {
    return null;
  }

  if (pkgBuf && pkgBuf.byteLength > MAX_PAYLOAD_SIZE) {
    ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "too-large", { httpMetadata: { contentType: "text/plain" } }));
    throw new Error("EXCEEDS_MAX_SIZE");
  }

  return pkgBuf;
}

/**
 * Parses, reduces, and repackages an upstream buffer natively.
 */
async function processAndCachePackages(pkgBuf, hashEntry, isGz, pin, host, env, cacheKey, ctx, gz) {
  if (hashEntry && await verifyHash(pkgBuf, hashEntry) === false) {
    throw new Error("HASH_MISMATCH");
  }

  let readable = new Response(pkgBuf).body;
  if (isGz) readable = readable.pipeThrough(new DecompressionStream("gzip"));

  let filtered;
  try {
    filtered = filterPackages(await reduceStreamToLatest(readable, pin));
  } catch (e) {
    throw new Error("STREAM_PARSE_ERROR");
  }

  const prefix = `pkg/${host}/`;
  for (const fields of filtered.values()) {
    if (fields["filename"]) fields["filename"] = prefix + fields["filename"];
  }

  const cs = new CompressionStream("gzip");
  const w2 = cs.writable.getWriter();
  w2.write(new TextEncoder().encode(serializePackages(filtered)));
  w2.close();
  const resultGz = await new Response(cs.readable).arrayBuffer();

  const meta = { contentType: "application/x-gzip" };
  ctx.waitUntil(env.DEBTHIN_BUCKET.put(cacheKey, resultGz, { httpMetadata: meta }));

  // Drop SWR meta pin for cheap 304 re-timestamping natively!
  ctx.waitUntil(env.DEBTHIN_BUCKET.put(`${cacheKey}.meta`, "valid", { httpMetadata: { contentType: "text/plain" }}));

  if (gz) {
    return new Response(resultGz, { headers: { ...meta, ...CACHE_HEADERS } });
  } else {
    const rawBody = new Response(resultGz).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(rawBody, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS } });
  }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Triggers full cryptographic verifications and payload deserialization parsing blocks natively.
 */
async function handleProxyPackages(request, env, ctx, parsed, blockKey) {
  const { host, suite, component, pin, arch, gz } = parsed;
  const cacheBase = proxyCacheBase(host, suite, component, pin, arch);
  const cacheKey = `${cacheBase}/Packages.gz`;
  const metaKey = `${cacheKey}.meta`;

  // Explicit SWR checking on the cheap meta pin avoiding giant fetches.
  const metaObj = await r2Head(env, metaKey, proxyMetaCache);
  const obj = await r2Head(env, cacheKey, proxyDataCache);
  
  // Use metadata tracking to evaluate freshness.
  const evalModified = metaObj ? metaObj.lastModified : (obj ? obj.lastModified : null);
  const fresh = evalModified && (Date.now() - evalModified < PROXY_CACHE_TTL_MS);

  if (!fresh) {
    const irResp = await checkUpstream304(host, suite, evalModified);

    if (!irResp || (!irResp.ok && irResp.status !== 304)) {
      if (!obj) {
        ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "404", { httpMetadata: { contentType: "text/plain" } }));
        return new Response("Bad Gateway (Upstream Invalid)\n", { status: 502 });
      }
      // Explicit fallback to stale obj on network failures seamlessly!
    } else if (irResp.status === 304) {
      if (obj) {
        // FAST 304 REVALIDATION natively! 
        // We write 5 bytes to *.meta rather than downloading and uploading a 10MB index!
        ctx.waitUntil(env.DEBTHIN_BUCKET.put(metaKey, "valid", { httpMetadata: { contentType: "text/plain" } }));
        proxyMetaCache.add(metaKey, new ArrayBuffer(5), { contentType: "text/plain", lastModified: Date.now() }, Date.now());
      }
    } else if (irResp.ok) {
      try {
        const irText = await irResp.text();
        let extract = null;
        for (const ext of [".gz", ""]) {
          const p = `${component}/binary-${arch}/Packages${ext}`;
          const h = extractInReleaseHash(irText, p);
          if (h) { extract = { pkgPath: p, hashEntry: h, pkgUrl: `/dists/${suite}/${p}`, isGz: ext === ".gz" }; break; }
        }

        if (!extract) throw new Error("BAD_UPSTREAM_MANIFEST");

        const pkgBuf = await fetchUpstreamPackages(host, extract.pkgUrl, env, blockKey, ctx);
        if (!pkgBuf) throw new Error("UPSTREAM_BIN_MISSING");

        return await processAndCachePackages(pkgBuf, extract.hashEntry, extract.isGz, pin, host, env, cacheKey, ctx, gz);

      } catch (err) {
        if (err.message === "EXCEEDS_MAX_SIZE") return new Response("Upstream repository too large\n", { status: 502 });
        if (!obj) return new Response("Bad Gateway or Internal Server Error\n", { status: err.message === "STREAM_PARSE_ERROR" ? 500 : 502 });
        // Implicitly fall through to stale Cache serving cleanly below organically natively!
      }
    }
  }

  // Serve strictly from R2 mappings generically
  return serveR2(env, request, cacheKey, proxyDataCache, { ctx, transform: gz ? undefined : "decompress" });
}

/**
 * Global dynamic dispatcher allocating proxy paths strictly toward separated evaluation functions neutrally.
 */
export async function handleProxyRepository(request, env, ctx, parsed) {
  const { host, suite, type } = parsed;

  if (PERMANENT_BLOCKLIST.has(host)) {
    return new Response("Not found (Host Permanently Blocked)\n", { status: 404 });
  }

  const blockKey = `proxy/${host}/${suite}/.blocklist`;
  const isBlocked = await r2Head(env, blockKey, proxyMetaCache);

  if (isBlocked) {
    if (isBlocked.httpMetadata && isBlocked.httpMetadata.status === 404) {
      // Safely bypasses latency limits mapping native negative resolutions
    } else if (isBlocked.lastModified && Date.now() - isBlocked.lastModified < PROXY_CACHE_TTL_MS) {
      return new Response("Not found (Upstream Blocked)\n", { status: 404 });
    }
  } else {
    // Store negative blocklist checks securely locally preserving execution limits unconditionally!
    proxyMetaCache.add(blockKey, new ArrayBuffer(0), { status: 404, lastModified: Date.now() }, Date.now());
  }

  if (type === "inrelease" || type === "release" || type === "arch-release") {
    return await handleProxyMetadata(request, env, ctx, parsed, blockKey);
  }

  if (type === "release-gpg") {
    return new Response("Not found\n", { status: 404 });
  }

  if (type === "packages") {
    return await handleProxyPackages(request, env, ctx, parsed, blockKey);
  }

  return new Response("Bad Request\n", { status: 400 });
}
