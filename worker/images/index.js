import { parseURL } from '../core/utils.js';
import { getCacheStats } from './cache.js';
import {
    handleLxcIndex,
    handleIncusPointer,
    handleIncusIndex,
    handleImageRedirect
} from './handlers/index.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Evaluates and maps the inbound request for the image indexer worker.
 * Checks validity of HTTP methods, path traversal, and dispatches to specific handlers.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} env - Cloudflare environment bindings.
 * @returns {Promise<Response>} The constructed runtime Response.
 */
async function handleRequest(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed\n", { status: 405, headers: { "Allow": "GET, HEAD" } });
    }
    if (request.url.indexOf("?") !== -1) {
        return new Response("Bad Request\n", { status: 400 });
    }

    const { rawPath } = parseURL(request);

    if (rawPath.includes("..")) {
        return new Response("Bad Request\n", { status: 400 });
    }

    if (rawPath === "health") {
        let r2 = "OK";
        try { await env.IMAGES_BUCKET.head("healthcheck-ping"); } catch (e) { r2 = "ERROR"; }
        const stats = {
          status: r2 === "OK" ? "OK" : "DEGRADED",
          r2,
          cache: getCacheStats(),
          time: Date.now()
        };
        const hh = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Debthin": "hit-synthetic" });
        return new Response(JSON.stringify(stats, null, 2) + "\n", { headers: hh, status: r2 === "OK" ? 200 : 503 });
    }

    // 1. Classic LXC (lxc-create -t download)
    if (rawPath === "meta/1.0/index-system") {
        return await handleLxcIndex(request, env.IMAGES_BUCKET);
    }

    // 2. Incus/LXD Pointer
    if (rawPath === "streams/v1/index.json") {
        return await handleIncusPointer(request);
    }

    // 3. Incus/LXD Database
    if (rawPath === "streams/v1/images.json") {
        return await handleIncusIndex(request, env.IMAGES_BUCKET);
    }

    // 4. Direct Downloads (Redirect to unmetered R2)
    if (rawPath.startsWith("images/")) {
        return handleImageRedirect('/' + rawPath);
    }

    return new Response("Not Found. debthin image server.", { status: 404 });
}

export default {
    /**
     * Primary edge invocation block for the images worker.
     * Incorporates protective try/catch routing and embeds synthetic performance tracking headers.
     * 
     * @param {Request} request - The inbound HTTP request.
     * @param {Object} env - Cloudflare environment bindings.
     * @param {Object} ctx - Worker execution context.
     * @returns {Promise<Response>} The final HTTP response payload.
     */
    async fetch(request, env, ctx) {
        const _now = Date.now();

        let response;
        try {
            response = await handleRequest(request, env);
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
