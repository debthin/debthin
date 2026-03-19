/**
 * @fileoverview Proxy route handlers executing curation extraction.
 * Distributes endpoint traffic across logically split metadata and packaging targets.
 */

import { serveR2, r2Head } from '../../core/r2.js';
import { extractInReleaseHash, verifyHash, proxyCacheBase } from '../utils.js';
import { parsePackages, reduceToLatest, filterPackages, serializePackages, reduceStreamToLatest } from '../packages.js';

const PROXY_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };
const MAX_PAYLOAD_SIZE = 25 * 1024 * 1024; // 25 MB hard limit

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

  const obj = await r2Head(env, cacheKey);
  const fresh = obj && obj.lastModified && (Date.now() - obj.lastModified < PROXY_CACHE_TTL_MS);

  if (!fresh) {
    let up = false;
    try {
      if ((await fetch(`https://${host}/dists/${suite}/InRelease`, { method: "HEAD" })).ok) up = true;
      else if ((await fetch(`https://${host}/dists/${suite}/Release`, { method: "HEAD" })).ok) up = true;
      else if ((await fetch(`http://${host}/dists/${suite}/InRelease`, { method: "HEAD" })).ok) up = true;
    } catch (e) {
      // DNS/network exception cleanly trapped
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
    
    // Asynchronous background R2 writing mapped natively
    ctx.waitUntil(env.DEBTHIN_BUCKET.put(cacheKey, buf, { httpMetadata: meta }));
    
    // Return early skipping serveR2 to avoid race conditions!
    return new Response(body, { headers: { ...meta, ...CACHE_HEADERS, "X-Debthin": "proxy-release" } });
  }

  return serveR2(env, request, cacheKey, { ctx });
}

/**
 * Triggers full cryptographic verifications and payload deserialization parsing blocks.
 */
async function handleProxyPackages(request, env, ctx, parsed, blockKey) {
  const { host, suite, component, pin, arch, gz } = parsed;
  const cacheBase = proxyCacheBase(host, suite, component, pin, arch);
  const cacheKey = `${cacheBase}/Packages.gz`;

  const obj = await r2Head(env, cacheKey);
  const fresh = obj && obj.lastModified && (Date.now() - obj.lastModified < PROXY_CACHE_TTL_MS);

  if (!fresh) {
    const irHeaders = obj && obj.lastModified ? { "If-Modified-Since": new Date(obj.lastModified).toUTCString() } : {};
    let irResp;
    try {
      irResp = await fetch(`https://${host}/dists/${suite}/InRelease`, { headers: irHeaders });
    } catch (e) {
      // Trap DNS failures identically
    }

    if (!irResp || (!irResp.ok && irResp.status !== 304)) {
      if (!obj) {
        ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "404", { httpMetadata: { contentType: "text/plain" } }));
        return new Response("Bad Gateway (Upstream Invalid)\n", { status: 502 });
      }
    } else if (irResp.status === 304) {
      if (obj) {
        ctx.waitUntil((async () => {
          const fullObj = await env.DEBTHIN_BUCKET.get(cacheKey);
          if (fullObj) await env.DEBTHIN_BUCKET.put(cacheKey, fullObj.body, { httpMetadata: fullObj.httpMetadata });
        })().catch(() => {}));
      }
    } else if (irResp.ok) {
      const irText       = await irResp.text();
      let pkgPath, hashEntry, pkgUrl, isGz = false;
      
      for (const ext of [".gz", ""]) {
        const p = `${component}/binary-${arch}/Packages${ext}`;
        const h = extractInReleaseHash(irText, p);
        if (h) { pkgPath = p; hashEntry = h; pkgUrl = `/dists/${suite}/${p}`; isGz = ext === ".gz"; break; }
      }

      if (!pkgUrl) return new Response("Bad Gateway\n", { status: 502 });

      let pkgResp;
      try {
        pkgResp = await fetch(`https://${host}${pkgUrl}`);
        if (!pkgResp.ok) pkgResp = await fetch(`http://${host}${pkgUrl}`);
      } catch (e) {
        // DNS trapped securely
      }

      if (!pkgResp || !pkgResp.ok) {
        if (!obj) return new Response("Bad Gateway\n", { status: 502 });
      } else {
        const cl = parseInt(pkgResp.headers.get("content-length") || "0", 10);
        if (cl > MAX_PAYLOAD_SIZE) {
          ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "too-large", { httpMetadata: { contentType: "text/plain" } }));
          return new Response("Upstream repository too large\n", { status: 502 });
        }

        let pkgBuf;
        try {
          pkgBuf = await pkgResp.arrayBuffer();
        } catch (e) {
          if (!obj) return new Response("Bad Gateway\n", { status: 502 });
        }

        if (pkgBuf && pkgBuf.byteLength > MAX_PAYLOAD_SIZE) {
          ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "too-large", { httpMetadata: { contentType: "text/plain" } }));
          return new Response("Upstream repository too large\n", { status: 502 });
        }

        if (hashEntry && await verifyHash(pkgBuf, hashEntry) === false) {
          return new Response("Bad Gateway\n", { status: 502 });
        }

        let readable = new Response(pkgBuf).body;
        if (isGz) readable = readable.pipeThrough(new DecompressionStream("gzip"));

        let filtered;
        try {
          filtered = filterPackages(await reduceStreamToLatest(readable, pin));
        } catch (e) {
          if (!obj) return new Response("Internal Server Error\n", { status: 500 });
        }
        
        const prefix = `pkg/${host}/`;
        if (filtered) {
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

          // Serve immediately dynamically skipping read-sync paths
          if (gz) {
            return new Response(resultGz, { headers: { ...meta, ...CACHE_HEADERS } });
          } else {
            // Re-decompress for raw mapping natively
            const rawBody = new Response(resultGz).body.pipeThrough(new DecompressionStream("gzip"));
            return new Response(rawBody, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS } });
          }
        }
      }
    } else {
      if (!obj) return new Response("Bad Gateway\n", { status: 502 });
    }
  }

  return serveR2(env, request, cacheKey, { ctx, transform: gz ? undefined : "decompress" });
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
  const isBlocked = await r2Head(env, blockKey);
  if (isBlocked && Date.now() - isBlocked.lastModified < PROXY_CACHE_TTL_MS) {
    return new Response("Not found (Upstream Blocked)\n", { status: 404 });
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
