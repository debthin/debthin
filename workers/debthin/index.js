import { parseURL, tokenizePath } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { handleStaticAssets, handleUpstreamRedirect, handleDistributionHashIndex } from './handlers/index.js';
import { resolveUpstream } from './utils.js';
import { DERIVED_CONFIG, CONFIG_JSON_STRING } from '../core/config.js';
import { getCacheStats, purgeAllCaches } from './cache.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Validates and routes incoming Edge HTTP requests.
 * Routes to admin endpoints, static assets, distribution metadata,
 * or upstream redirects based on path structure.
 * 
 * @param {Request} request - The inbound HTTP request.
 * @param {DebthinEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context for waitUntil jobs.
 * @returns {Promise<Response>} The evaluated HTTP Response or proxy instruction.
 */
async function handleRequest(request, env, ctx) {
  const { protocol, rawPath } = parseURL(request);

  const invalid = validateRequest(request, rawPath);
  if (invalid) return invalid;

  const slash = rawPath.indexOf("/");

  // Root-level paths (no slash): admin endpoints, then static assets
  if (slash === -1) {
    const adminResponse = routeAdminPath(rawPath, env, {
        bucket: env.DEBTHIN_BUCKET,
        serviceName: "debthin",
        getStats: getCacheStats,
        flush: purgeAllCaches,
    });
    if (adminResponse) return adminResponse;

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

export default wrapHandler(handleRequest, "debthin");
