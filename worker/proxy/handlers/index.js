/**
 * @fileoverview Proxy route handlers executing curation extraction.
 * Distributes endpoint traffic across logically split metadata and packaging targets.
 */

import { serveR2, r2Head } from '../../core/r2.js';
import { extractInReleaseHash, verifyHash, proxyCacheBase } from '../utils.js';
import { parsePackages, reduceToLatest, filterPackages, serializePackages, reduceStreamToLatest } from '../packages.js';

const PROXY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Handles generating and mapping proxy Release manifests natively locally.
 *
 * @param {Request} request - The original bound client HTTP execution parameters.
 * @param {Object} env - The Cloudflare infrastructure runtime constraints.
 * @param {Object} ctx - Isolated thread execution wrapper parameters.
 * @param {Object} parsed - Actively resolved coordinate path constraints.
 * @returns {Promise<Response>} Manifest text payload.
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
    } catch (e) {}

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
    await env.DEBTHIN_BUCKET.put(cacheKey, buf, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  }

  return serveR2(env, request, cacheKey, { ctx });
}

/**
 * Triggers full cryptographic verifications and payload deserialization parsing blocks against upstream endpoints.
 *
 * @param {Request} request - The original bound client HTTP execution parameters.
 * @param {Object} env - The Cloudflare infrastructure runtime constraints.
 * @param {Object} ctx - Isolated thread execution wrapper parameters.
 * @param {Object} parsed - Actively resolved coordinate path constraints.
 * @returns {Promise<Response>} Stripped APT packages list.
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
    } catch(e) {}

    if (!irResp || (!irResp.ok && irResp.status !== 304)) {
      if (!obj) {
        ctx.waitUntil(env.DEBTHIN_BUCKET.put(blockKey, "404", { httpMetadata: { contentType: "text/plain" } }));
        return new Response("Bad Gateway (Upstream Invalid)\n", { status: 502 });
      }
    } else if (irResp.status === 304) {
      if (obj) {
        const fullObj = await env.DEBTHIN_BUCKET.get(cacheKey);
        if (fullObj) {
          ctx.waitUntil(env.DEBTHIN_BUCKET.put(cacheKey, fullObj.body, { httpMetadata: fullObj.httpMetadata }));
        }
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

      let pkgResp = await fetch(`https://${host}${pkgUrl}`);
      if (!pkgResp.ok) pkgResp = await fetch(`http://${host}${pkgUrl}`);

      if (!pkgResp.ok) {
        if (!obj) return new Response("Bad Gateway\n", { status: 502 });
      } else {
        const pkgBuf = await pkgResp.arrayBuffer();

        if (hashEntry && await verifyHash(pkgBuf, hashEntry) === false) {
          return new Response("Bad Gateway\n", { status: 502 });
        }

        let readable = new Response(pkgBuf).body;
        if (isGz) readable = readable.pipeThrough(new DecompressionStream("gzip"));

        const filtered = filterPackages(await reduceStreamToLatest(readable, pin));
        
        const prefix = `pkg/${host}/`;
        for (const fields of filtered.values()) {
          if (fields["filename"]) fields["filename"] = prefix + fields["filename"];
        }

        const cs = new CompressionStream("gzip");
        const w2 = cs.writable.getWriter();
        w2.write(new TextEncoder().encode(serializePackages(filtered)));
        w2.close();
        const resultGz = await new Response(cs.readable).arrayBuffer();

        await env.DEBTHIN_BUCKET.put(cacheKey, resultGz, { httpMetadata: { contentType: "application/x-gzip" } });
      }
    } else {
      if (!obj) return new Response("Bad Gateway\n", { status: 502 });
    }
  }

  return serveR2(env, request, cacheKey, { ctx, transform: gz ? undefined : "decompress" });
}

/**
 * Global dynamic dispatcher allocating proxy paths strictly toward separated evaluation functions neutrally.
 * Implements a global blocklist timeout caching failing origin hosts explicitly natively.
 *
 * @param {Request} request - Raw inbound request edge hook.
 * @param {Object} env - Bound Cloudflare bucket configurations.
 * @param {Object} ctx - Event boundaries parameters natively enabling background pushes.
 * @param {Object} parsed - Destructured path mapping constraints uniquely routing domains.
 * @returns {Promise<Response>} Resolved package files or HTTP response blocks manually mapping native architectures.
 */
export async function handleProxyRepository(request, env, ctx, parsed) {
  const { host, suite, type } = parsed;

  const blockKey = `proxy/${host}/${suite}/.blocklist`;
  const isBlocked = await r2Head(env, blockKey);
  if (isBlocked && Date.now() - isBlocked.lastModified < PROXY_CACHE_TTL_MS) {
    return new Response("Not found (Upstream Blocked)\n", { status: 404 });
  }

  if (type === "inrelease" || type === "release" || type === "arch-release") {
    const res = await handleProxyMetadata(request, env, ctx, parsed, blockKey);
    return res;
  }

  if (type === "release-gpg") {
    return new Response("Not found\n", { status: 404 });
  }

  if (type === "packages") {
    return handleProxyPackages(request, env, ctx, parsed, blockKey);
  }

  return new Response("Bad Request\n", { status: 400 });
}
