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
 * Returns a health check response with R2 connectivity status,
 * aggregated cache statistics, and isolate uptime telemetry.
 *
 * @param {R2Bucket} bucket - R2 bucket binding to probe.
 * @param {string} serviceName - Identifies the worker in the response.
 * @param {Function} getStats - Returns aggregated cache stats object.
 * @returns {Promise<Response>} JSON health response (200 OK or 503 DEGRADED).
 */
async function handleHealth(bucket, serviceName, getStats) {
    let r2 = "OK";
    try { await bucket.head("healthcheck-ping"); } catch { r2 = "ERROR"; }

    const now = Date.now();
    const uptimeSeconds = Math.floor((now - ISOLATE_START_TIME) / 1000);

    const body = {
        status: r2 === "OK" ? "OK" : "DEGRADED",
        service: serviceName,
        r2,
        isolate: {
            id: ISOLATE_ID,
            uptimeSeconds,
            uptimeFormatted: formatUptime(uptimeSeconds)
        },
        cache: getStats(),
        time: now
    };
    return new Response(JSON.stringify(body, null, 2) + "\n", {
        status: r2 === "OK" ? 200 : 503,
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
 *   health                   → R2 probe + cache stats
 *   _cache_status.{secret}   → L1 cache stats (JSON)
 *   _cache_flush.{secret}    → flush all L1 caches
 *
 * @param {string} rawPath - URL path without leading slash.
 * @param {Env} env - Cloudflare environment bindings (needs ADMIN_SECRET).
 * @param {{bucket: R2Bucket, serviceName: string, getStats: Function, flush: Function}} opts - Handler configuration.
 * @returns {Promise<Response>|Response|null} Admin response or null if not matched.
 */
export function routeAdminPath(rawPath, env, { bucket, serviceName, getStats, flush }) {
    if (rawPath === "robots.txt") {
        return handleRobots();
    }

    if (rawPath === "health") {
        return handleHealth(bucket, serviceName, getStats);
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
 * @param {Function} handler - async (request, env, ctx) => Response
 * @param {string} serviceName - Suffix for the X-Served-By header.
 * @returns {Object} Cloudflare Worker module export with a fetch method.
 */
export function wrapHandler(handler, serviceName) {
    return {
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
