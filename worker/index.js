import { setNow } from './core/cache.js';
import { tokenizePath, parseURL } from './core/utils.js';
import { handleStaticAssets, handleUpstreamRedirect, handleDistributionHashIndex } from './handlers/index.js';
import { DERIVED_CONFIG, CONFIG_JSON_STRING } from './core/config.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

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
  if (!DERIVED_CONFIG[first]) {
    return new Response("Not found\n", { status: 404 });
  }

  const distro = first;
  const rest = rawPath.slice(slash + 1);
  const distroConfig = DERIVED_CONFIG[distro];
  const { upstream, aliasMap, suites } = distroConfig;

  // Immediately redirect apt pool binary requests to the original upstream
  if (rest.startsWith("pool/")) {
    return handleUpstreamRedirect(protocol, upstream, rest);
  }

  // Parse nested dists/ paths using our lightweight allocator-free tokenizer
  let suitePath = rest;
  let tokens = tokenizePath(rest);
  const { p0, p1 } = tokens;

  // Attempt canonical suite resolution mapping (e.g. "stable" -> "bookworm")
  if (p0 === "dists" && p1 && !suites.has(p1)) {
    const canonical = aliasMap.get(p1);
    if (canonical) {
      tokens.p1 = canonical;
      const tailIdx = rest.indexOf("/", 6);
      suitePath = "dists/" + canonical + (tailIdx === -1 ? "" : rest.slice(tailIdx));
    }
  }

  // Map active Release, Packages, and by-hash lookups through the proxy handlers
  if (tokens.p0 === "dists" && tokens.p1 && tokens.p2) {
    const response = await handleDistributionHashIndex(request, env, ctx, distro, suitePath, tokens, distroConfig);
    if (response) return response;
  }

  // Fallback unconditionally to upstream redirect for unmatched paths
  return handleUpstreamRedirect(protocol, upstream, suitePath);
}

export default {
  async fetch(request, env, ctx) {
    const _now = Date.now();
    setNow(_now);

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
