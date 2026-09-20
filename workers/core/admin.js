/**
 * @fileoverview Shared admin and request validation for all workers.
 * Provides robots.txt, health, secret-gated cache status/flush, and
 * common request pre-checks (method, traversal, query strings).
 */

const H_PLAIN = Object.freeze({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
});

const H_JSON = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
});

const ROBOTS_BODY = "User-agent: *\nAllow: /$\nDisallow: /\n";
// Daily pipeline plus slack for GitHub's scheduled-run drift, which has been
// observed at 2-4h behind the 04:00 UTC cron.
const DEFAULT_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const DEFAULT_METHODS = ["GET", "HEAD"];
const ISOLATE_ID = Math.random().toString(16).slice(2, 10);
// Cloudflare Workers return 0 from Date.now() at module scope.
// Captured lazily on the first request via wrapHandler.
let ISOLATE_START_TIME = 0;

/**
 * Validates an inbound request for allowed HTTP methods, query strings,
 * and path traversal. Returns a 4xx Response if invalid, or null if the
 * request passes all checks.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {string} rawPath - The parsed URL path (no leading slash).
 * @param {string[]} [allowedMethods=["GET","HEAD"]] - Accepted HTTP methods.
 * @returns {Response|null} Error response or null if valid.
 */
export function validateRequest(request, rawPath, allowedMethods = DEFAULT_METHODS) {
    if (!allowedMethods.includes(request.method)) {
        return new Response("Method Not Allowed\n", {
            status: 405,
            headers: { "Allow": allowedMethods.join(", ") }
        });
    }
    if (request.url.indexOf("?") !== -1) {
        return new Response("Bad Request\n", { status: 400 });
    }
    if (rawPath.includes("..")) {
        return new Response("Bad Request\n", { status: 400 });
    }
    // Drop common scanner and exploit probes
    if (rawPath.startsWith(".git")
        || rawPath.startsWith(".env")
        || rawPath.startsWith("ecp/")
        || rawPath.startsWith("xmlrpc")) {
        return new Response("Not Found\n", { status: 404 });
    }
    const slash = rawPath.indexOf("/");
    if (slash !== -1 && rawPath.slice(slash + 1).startsWith("wp-includes")) {
        return new Response("Not Found\n", { status: 404 });
    }
    return null;
}

/**
 * Returns a synthetic robots.txt response that blocks all crawlers
 * except the root page.
 *
 * @returns {Response} The robots.txt response.
 */
function handleRobots() {
    return new Response(ROBOTS_BODY, { headers: H_PLAIN });
}

/**
 * Validates the admin secret from a path segment against the ADMIN_SECRET
 * env var. Returns true only when the env var is set and matches.
 *
 * @param {Env} env - Cloudflare environment bindings.
 * @param {string} provided - The secret extracted from the URL.
 * @returns {boolean} Whether the secret is valid.
 */
function isValidSecret(env, provided) {
    return typeof env.ADMIN_SECRET === "string"
        && env.ADMIN_SECRET.length > 0
        && provided === env.ADMIN_SECRET;
}

/**
 * Reads a published status document and reports whether its build is recent.
 * Never throws: an unreadable or malformed document is reported as ERROR so
 * the health endpoint degrades rather than 500s.
 *
 * @param {R2Bucket} bucket - R2 bucket binding holding the status document.
 * @param {string} key - Object key, e.g. "status.json".
 * @param {number} maxAgeMs - Age beyond which the build counts as stale.
 * @param {number} now - Current epoch ms.
 * @returns {Promise<{state: string, reason?: string, builtAt?: string, ageSeconds?: number, maxAgeSeconds?: number}>} Freshness verdict.
 */
async function checkFreshness(bucket, key, maxAgeMs, now) {
    let builtAt;
    try {
        const obj = await bucket.get(key);
        if (!obj) return { state: "ERROR", reason: `${key} not found` };
        builtAt = JSON.parse(await obj.text()).built_at;
    } catch (e) {
        return { state: "ERROR", reason: `cannot read ${key}: ${e.message}` };
    }

    if (!builtAt) return { state: "ERROR", reason: `no built_at in ${key}` };

    const built = Date.parse(builtAt);
    if (Number.isNaN(built)) {
        return { state: "ERROR", reason: `unparseable built_at: ${builtAt}` };
    }

    const ageMs = now - built;
    return {
        state: ageMs > maxAgeMs ? "STALE" : "OK",
        builtAt,
        ageSeconds: Math.floor(ageMs / 1000),
        maxAgeSeconds: Math.floor(maxAgeMs / 1000)
    };
}

/**
 * Returns a health check response with R2 connectivity status, optional data
 * freshness, aggregated cache statistics, and isolate uptime telemetry.
 *
 * @param {R2Bucket} bucket - R2 bucket binding to probe.
 * @param {string} serviceName - Identifies the worker in the response.
 * @param {Function} getStats - Returns aggregated cache stats object.
 * @param {string} [freshnessKey] - Status document key; omit to skip the check.
 * @param {number} [maxAgeMs] - Staleness threshold (default 36h).
 * @returns {Promise<Response>} JSON health response (200 OK or 503 DEGRADED).
 */
async function handleHealth(bucket, serviceName, getStats, freshnessKey, maxAgeMs) {
    let r2 = "OK";
    try { await bucket.head("healthcheck-ping"); } catch { r2 = "ERROR"; }

    const now = Date.now();
    const uptimeSeconds = Math.floor((now - ISOLATE_START_TIME) / 1000);

    // Opt-in: only workers that publish a status.json pass a freshnessKey.
    // R2 being reachable says nothing about whether what it holds is current -
    // this endpoint returned 200 OK for the whole of the 2026-05/09 outage.
    let freshness = null;
    if (freshnessKey) {
        freshness = await checkFreshness(bucket, freshnessKey, maxAgeMs ?? DEFAULT_MAX_AGE_MS, now);
    }

    const healthy = r2 === "OK" && (!freshness || freshness.state === "OK");

    const body = {
        status: healthy ? "OK" : "DEGRADED",
        service: serviceName,
        r2,
        ...(freshness ? { freshness } : {}),
        isolate: {
            id: ISOLATE_ID,
            uptimeSeconds,
            uptimeFormatted: formatUptime(uptimeSeconds)
        },
        cache: getStats(),
        time: now
    };
    return new Response(JSON.stringify(body, null, 2) + "\n", {
        status: healthy ? 200 : 503,
        headers: H_JSON
    });
}

/**
 * Formats a duration in seconds into a human-readable string.
 *
 * @param {number} totalSeconds - Duration in whole seconds.
 * @returns {string} Formatted string like "2d 5h 30m 12s".
 */
function formatUptime(totalSeconds) {
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${d}d ${h}h ${m}m ${s}s`;
}

/**
 * Returns L1 cache statistics as JSON.
 *
 * @param {Function} getStats - Function returning cache stats object.
 * @returns {Response} JSON cache statistics response.
 */
function handleStatus(getStats) {
    return new Response(JSON.stringify(getStats(), null, 2) + "\n", {
        status: 200,
        headers: H_JSON
    });
}

/**
 * Flushes all L1 caches and returns confirmation.
 *
 * @param {Function} flushFn - No-arg function that purges all caches.
 * @returns {Response} JSON confirmation response.
 */
function handleFlush(flushFn) {
    flushFn();
    return new Response(JSON.stringify({ flushed: true, time: Date.now() }) + "\n", {
        status: 200,
        headers: H_JSON
    });
}

/**
 * Attempts to route a raw path to an admin endpoint. Returns a Response
 * if matched, or null if the path is not an admin route.
 *
 * Expected paths (none contain a slash):
 *   robots.txt               → synthetic robots.txt
 *   health                   → R2 probe + data freshness + cache stats
 *   _cache_status.{secret}   → L1 cache stats (JSON)
 *   _cache_flush.{secret}    → flush all L1 caches
 *
 * @param {string} rawPath - URL path without leading slash.
 * @param {Env} env - Cloudflare environment bindings (needs ADMIN_SECRET).
 * @param {{bucket: R2Bucket, serviceName: string, getStats: Function, flush: Function, freshnessKey?: string, maxAgeMs?: number}} opts - Handler configuration.
 *   freshnessKey: JSON object in the bucket carrying a `built_at` timestamp.
 *   When set, /health reports 503 if that build is older than maxAgeMs.
 * @returns {Promise<Response>|Response|null} Admin response or null if not matched.
 */
export function routeAdminPath(rawPath, env, { bucket, serviceName, getStats, flush, freshnessKey, maxAgeMs }) {
    if (rawPath === "robots.txt") {
        return handleRobots();
    }

    if (rawPath === "health") {
        return handleHealth(bucket, serviceName, getStats, freshnessKey, maxAgeMs);
    }

    if (rawPath.startsWith("_cache_status.")) {
        const secret = rawPath.slice("_cache_status.".length);
        if (!isValidSecret(env, secret)) return null;
        return handleStatus(getStats);
    }

    if (rawPath.startsWith("_cache_flush.")) {
        const secret = rawPath.slice("_cache_flush.".length);
        if (!isValidSecret(env, secret)) return null;
        return handleFlush(flush);
    }

    return null;
}

/**
 * Wraps a request handler with error trapping and performance headers.
 * Returns a Cloudflare Worker module export ({ fetch }) that:
 *  - catches unhandled errors and returns 500
 *  - appends X-Timer (start + duration) and X-Served-By (colo + service name)
 *
 * @template E
 * @param {(request: Request, env: E, ctx: ExecutionContext) => Promise<Response>} handler - The request handler.
 * @param {string} serviceName - Suffix for the X-Served-By header.
 * @returns {{fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>}} Cloudflare Worker module export.
 */
export function wrapHandler(handler, serviceName) {
    return {
        /** @param {Request} request @param {E} env @param {ExecutionContext} ctx */
        async fetch(request, env, ctx) {
            const t0 = Date.now();
            if (!ISOLATE_START_TIME) ISOLATE_START_TIME = t0;

            let response;
            try {
                response = await handler(request, env, ctx);
            } catch (err) {
                console.error(err.stack || err);
                response = new Response("Internal Server Error", { status: 500 });
            }

            const h = new Headers(response.headers);
            h.set("X-Timer", `S${t0},VS0,VE${Date.now() - t0}`);
            h.set("X-Served-By", `cache-${request.cf?.colo ?? "UNKNOWN"}-${serviceName}`);
            h.set("X-Isolate-ID", ISOLATE_ID);

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: h
            });
        }
    };
}
