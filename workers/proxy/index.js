/**
 * @fileoverview debthin - Proxy Cloudflare Worker
 *
 * Proxy feature sandboxes third-party vendor repos:
 *
 *   deb [trusted=yes] https://deb.debthin.org apt.grafana.com/stable/main grafana
 *   deb [trusted=yes] https://deb.debthin.org apt.grafana.com/stable/main grafana==1.10
 *
 * Fetches upstream Packages.gz, reduces to one package per name, filters dependencies,
 * rewrites Filename fields, and proxies actual .deb downloads.
 */

import { parseURL } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { parseProxySuitePath } from './utils.js';
import { handleProxyRepository } from './handlers/index.js';
import { getProxyCacheStats, purgeProxyCaches } from './cache.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Validates and routes incoming proxy requests.
 * Routes to admin endpoints, package proxying, or distribution handling.
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} env - Cloudflare environment bindings.
 * @param {Object} ctx - Worker execution context for waitUntil jobs.
 * @returns {Promise<Response>} The evaluated HTTP Response.
 */
async function handleRequest(request, env, ctx) {
  const { rawPath } = parseURL(request);

  const invalid = validateRequest(request, rawPath);
  if (invalid) return invalid;


  // Intercept `pkg/` blocks executing binary payload proxy redirect 301 mappings
  if (rawPath.startsWith("pkg/")) {
    const origin = rawPath.slice(4);
    return Response.redirect(`https://${origin}`, 301);
  }
  
  // Intercept generic `dists/` block configurations routing them mapping targets locally
  if (rawPath.startsWith("dists/")) {
    const afterDists = rawPath.slice(6);
    const parsed = parseProxySuitePath(afterDists);
    if (!parsed) return new Response("Bad proxy path\n", { status: 400 });
    
    return handleProxyRepository(request, env, ctx, parsed);
  }

  // Admin endpoints (robots.txt, health, cache status/flush)
  const adminResponse = routeAdminPath(rawPath, env, {
      bucket: env.DEBTHIN_BUCKET,
      serviceName: "debthin-proxy",
      getStats: getProxyCacheStats,
      flush: purgeProxyCaches,
  });
  if (adminResponse) return adminResponse;

  return new Response("Proxy Not Found\n", { status: 404 });
}

export default wrapHandler(handleRequest, "debthin-proxy");
