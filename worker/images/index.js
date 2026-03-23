/**
 * @fileoverview Main entrypoint for the Image Distribution Worker.
 * Handles request validation, routing, and environment binding.
 */

import { parseURL } from '../core/utils.js';
import { getCacheStats } from './cache.js';
import { hydrateRegistryState } from './indexes.js';
import {
    handleLxcIndex,
    handleIncusPointer,
    handleIncusIndex,
    handleOciRegistry,
    routeImagePath
} from './handlers/index.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Evaluates the inbound request and dispatches to the appropriate handler.
 * Checks HTTP method, path traversal, and routes to specific endpoints.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {Object} env - Cloudflare environment bindings.
 * @param {Object} ctx - Worker execution context.
 * @returns {Promise<Response>} The constructed response.
 */
async function handleRequest(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed\n", { status: 405, headers: { "Allow": "GET, HEAD" } });
    }
    if (request.url.indexOf("?") !== -1) return new Response("Bad Request\n", { status: 400 });

    const { rawPath } = parseURL(request);
    if (rawPath.includes("..")) return new Response("Bad Request\n", { status: 400 });

    if (rawPath === "health") {
        const stats = getCacheStats();
        return new Response(JSON.stringify({ status: "ok", service: "debthin-images", cache: stats }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
    }

    // 1. Image file paths — cache metadata, redirect binaries
    if (rawPath.startsWith("images/")) {
        return await routeImagePath(request, env, ctx, rawPath);
    }

    // 2. Classic LXC
    if (rawPath === "meta/1.0/index-system") return await handleLxcIndex(request, env.IMAGES_BUCKET, ctx);

    // 3. Incus/LXD Pointer
    if (rawPath === "streams/v1/index.json") return await handleIncusPointer(request, env.IMAGES_BUCKET, ctx);

    // 4. Incus/LXD Database
    if (rawPath === "streams/v1/images.json") return await handleIncusIndex(request, env.IMAGES_BUCKET, ctx);

    // 5. Docker / OCI Registry
    if (rawPath === "v2" || rawPath.startsWith("v2/")) {
        return await handleOciRegistry(request, env.IMAGES_BUCKET, ctx, rawPath, env);
    }

    return new Response("Not Found. debthin image server.", { status: 404 });
}

export default {
    /**
     * Primary fetch handler for the images worker.
     * Wraps handleRequest in error handling and appends performance tracking headers.
     *
     * @param {Request} request - The inbound HTTP request.
     * @param {Object} env - Cloudflare environment bindings.
     * @param {Object} ctx - Worker execution context.
     * @returns {Promise<Response>} The final HTTP response.
     */
    async fetch(request, env, ctx) {
        const _now = Date.now();

        // Background-warm the registry state on every inbound request
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(hydrateRegistryState(env.IMAGES_BUCKET).catch(e => console.error("Warmup Error:", e)));
        }

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
