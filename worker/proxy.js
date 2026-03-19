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

import { parseURL } from './core/utils.js';
import { handleUpstreamRedirect } from './handlers/index.js';
import { parseProxySuitePath } from './proxy/utils.js';
import { handleProxyRepository } from './proxy/handlers/index.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Validates and routes incoming Edge HTTP proxy requests natively mirroring the core architecture constraints.
 * Evaluates HTTP method validity, query string blocks, directory traversal deterrence exactly 1:1 functionally natively.
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} env - Cloudflare environment bindings.
 * @param {Object} ctx - Worker execution context for waitUntil jobs.
 * @returns {Promise<Response>} The evaluated HTTP Response resolving proxy execution commands safely securely.
 */
async function handleRequest(request, env, ctx) {
  // Reject unsupported HTTP methods and query strings
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", { status: 405, headers: { "Allow": "GET, HEAD" } });
  }
  if (request.url.indexOf("?") !== -1) {
    return new Response("Bad Request\n", { status: 400 });
  }

  const { protocol, rawPath } = parseURL(request);

  // Prevent basic directory traversal attacks
  if (rawPath.includes("..")) {
    return new Response("Bad Request\n", { status: 400 });
  }

  // Health check endpoint parity mapping identical to the core infrastructure
  if (rawPath === "health") {
    return new Response("pass\n", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  // Intercept `pkg/` blocks executing massive binary payload proxy redirect 301 mappings natively
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

  return new Response("Proxy Not Found\n", { status: 404 });
}

export default {
  /**
   * Primary invocation entrypoint aligning fetch wrappers with standard index execution blocks exactly logically natively.
   * Traps internal request handling errors and injects analytical caching metric headers
   * like X-Timer and X-Served-By before resolving back to the edge node.
   * 
   * @param {Request} request - The inbound HTTP request.
   * @param {Object} env - Cloudflare environment bindings.
   * @param {Object} ctx - Worker execution context.
   * @returns {Promise<Response>} The final formulated HTTP Response.
   */
  async fetch(request, env, ctx) {
    const _now = Date.now();

    let response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (err) {
      console.error(err.stack || err);
      response = new Response("Internal Server Error", { status: 500 });
    }

    const h = new Headers(response.headers);
    h.set("X-Timer", `S${_now},VS0,VE${Date.now() - _now}`);
    h.set("X-Served-By", `cache-${request.cf?.colo ?? "UNKNOWN"}-debthin-proxy`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: h
    });
  }
};
