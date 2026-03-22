import { parseURL, tokenizePath } from '../core/utils.js';
import { handleStaticAssets, handleUpstreamRedirect, handleDistributionHashIndex } from './handlers/index.js';
import { resolveUpstream } from './utils.js';
import { DERIVED_CONFIG, CONFIG_JSON_STRING } from '../core/config.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Validates and routes incoming Edge HTTP requests.
 * Evaluates HTTP method validity, query string blocks, directory traversal deterrence,
 * suite configuration matching, and canonical alias redirection before
 * falling back to the proxy layer handlers.
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} env - Cloudflare environment bindings.
 * @param {Object} ctx - Worker execution context for waitUntil jobs.
 * @returns {Promise<Response>} The evaluated HTTP Response or proxy instruction.
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

  const slash = rawPath.indexOf("/");

  // Serve static root assets directly (e.g. index.html, robots.txt, config.json)
  if (slash === -1) {
    return handleStaticAssets(rawPath, env, request, CONFIG_JSON_STRING);
  }

  // Validate the requested distribution against our active config namespace
  const first = rawPath.slice(0, slash);
  let distroConfig = DERIVED_CONFIG[first];

  if (!distroConfig) {
    let fallbackHost;
    for (const key in DERIVED_CONFIG) {
      if (first.startsWith(key)) {
        fallbackHost = DERIVED_CONFIG[key].upstream.split("/")[0];
        break;
      }
    }
    if (fallbackHost) {
      return handleUpstreamRedirect(protocol, fallbackHost, rawPath);
    }
    return new Response("Not found\n", { status: 404 });
  }

  const distro = first;
  const rest = rawPath.slice(slash + 1);
  const { upstream, aliasMap, suites, archUpstreams } = distroConfig;

  // Immediately redirect apt pool binary requests to the original upstream
  if (rest.startsWith("pool/")) {
    return handleUpstreamRedirect(protocol, resolveUpstream(rest, archUpstreams, upstream), rest);
  }

  // Parse nested dists/ paths using our lightweight allocator-free tokenizer
  let suitePath = rest;
  let tokens = tokenizePath(rest);

  // Attempt canonical suite resolution mapping (e.g. "stable" -> "bookworm")
  if (tokens.p0 === "dists" && tokens.p1 && !suites.has(tokens.p1)) {
    const canonical = aliasMap.get(tokens.p1);
    if (canonical) {
      tokens.p1 = canonical;
      const tailIdx = rest.indexOf("/", 6);
      suitePath = "dists/" + canonical + (tailIdx === -1 ? "" : rest.slice(tailIdx));
    }
  }

  // Redirect ALL i18n requests (including Translation files and their by-hash lookups) directly to upstream
  if (tokens.p0 === "dists" && tokens.p1 && tokens.p3 === "i18n") {
    return handleUpstreamRedirect(protocol, resolveUpstream(suitePath, archUpstreams, upstream), suitePath);
  }

  // Map active Release, Packages, and by-hash lookups through the proxy handlers
  if (tokens.p0 === "dists" && tokens.p1 && tokens.p2) {
    const response = await handleDistributionHashIndex(request, env, ctx, distro, suitePath, tokens, distroConfig);
    if (response) return response;
  }

  // Fallback unconditionally to upstream redirect for unmatched paths
  return handleUpstreamRedirect(protocol, resolveUpstream(suitePath, archUpstreams, upstream), suitePath);
}

export default {
  /**
   * Primary invocation entrypoint for the Cloudflare fetch event lifecycle.
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
    h.set("X-Served-By", `cache-${request.cf?.colo ?? "UNKNOWN"}-debthin`);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: h
    });
  }
};
