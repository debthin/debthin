/**
 * @fileoverview Defines system-wide constants, static hashes, and HTTP headers. 
 * Allows isolated testing and minimizes object instantiation on hot paths.
 * 
 * Exports:
 * - H_BASE: Standard security headers.
 * - H_CACHED: Security headers with 1-hour cache TTL.
 * - H_IMMUTABLE: Security headers with 1-year immutable cache TTL.
 * - EMPTY_HASH: Known SHA256 of an empty file.
 * - EMPTY_GZ_HASH: Known SHA256 of an empty gzip payload.
 * - EMPTY_GZ: Pre-computed binary buffer of an empty gzip payload.
 */

/**
 * Standard HTTP security headers.
 * @type {Object}
 */
export const H_BASE = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "sameorigin",
  "Referrer-Policy": "no-referrer",
  "X-Xss-Protection": "1",
  "Permissions-Policy": "interest-cohort=()",
  "X-Clacks-Overhead": "GNU Terry Pratchett"
});

/**
 * Security headers with a standard 1-hour public Cache-Control directive.
 * @type {Object}
 */
export const H_CACHED = Object.freeze({ ...H_BASE, "Cache-Control": "public, max-age=3600, no-transform" });

/**
 * Security headers with a 1-year immutable Cache-Control directive.
 * @type {Object}
 */
export const H_IMMUTABLE = Object.freeze({ ...H_BASE, "Cache-Control": "public, max-age=31536000, immutable, no-transform" });

/**
 * SHA256 checksum representing an empty string.
 * @type {string}
 */
export const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * SHA256 checksum representing an empty GZIP chunk.
 * @type {string}
 */
export const EMPTY_GZ_HASH = "ac39ce295e2578367767006b7a1ef7728a4ba747707aacec48a30d843fe1ecaf";

/**
 * Binary payload evaluating to an empty compressed GZIP file.
 * @type {Uint8Array}
 */
export const EMPTY_GZ = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 4, 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
