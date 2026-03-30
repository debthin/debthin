/**
 * @fileoverview Main entrypoint for the Image Distribution Worker.
 * Handles request validation, routing, and environment binding.
 */

import { parseURL } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { getCacheStats, indexCache } from './cache.js';
import { H_HTML, H_ICON } from './http.js';
import {
    handleLxcIndex,
    handleIncusPointer,
    handleIncusIndex,
    handleOciRegistry,
    routeImagePath,
    serveR2Static
} from './handlers/index.js';

// ── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Evaluates the inbound request and dispatches to the appropriate handler.
 * Validates the request, then routes to specific endpoints.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {ImagesEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @returns {Promise<Response>} The constructed response.
 */
async function handleRequest(request, env, ctx) {
    let { rawPath } = parseURL(request);
    // LXC clients double-slash the base URL; strip the residual leading /
    if (rawPath.charCodeAt(0) === 47) rawPath = rawPath.slice(1);

    const invalid = validateRequest(request, rawPath);
    if (invalid) return invalid;



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

    // 6. Static assets served from R2
    if (rawPath === "" || rawPath === "index.html") {
        return serveR2Static(request, env.IMAGES_BUCKET, ctx, "index.html", H_HTML);
    }
    if (rawPath === "favicon.ico") {
        return serveR2Static(request, env.IMAGES_BUCKET, ctx, "favicon.ico", H_ICON);
    }

    // Admin endpoints (robots.txt, health, cache status/flush)
    const adminResponse = routeAdminPath(rawPath, env, {
        bucket: env.IMAGES_BUCKET,
        serviceName: "debthin-images",
        getStats: getCacheStats,
        flush: () => indexCache.purge(),
    });
    if (adminResponse) return adminResponse;

    return new Response("Not Found. debthin image server.", { status: 404 });
}

export default wrapHandler(handleRequest, "debthin");
