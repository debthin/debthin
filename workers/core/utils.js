/**
 * @fileoverview String and URL parsing utilities.
 * Avoids heavy allocations by using manual indexOf sweeps and charCode bounds.
 * 
 * Exports:
 * - tokenizePath: Zero-allocation linear string segmenter mapping URL path domains to properties.
 * - parseURL: Lightweight protocol and raw endpoint location extractor.
 * - isHex64: Mathematical iterative sweep for rapid 64-character lowercase SHA256 hash checks.
 * - getContentType: Fixed mapping correlating native extensions immediately to headers.
 */

/**
 * Slices endpoint paths into zero-allocation dictionary properties.
 * Hardwired indexOf chains for maxParts 2-5 maintain a stable V8 hidden
 * class shape. Falls back to a generic loop for other values.
 *
 * @param {string} path - URL path segment.
 * @param {number} [maxParts=5] - Maximum number of components to extract.
 * @returns {Record<string, string>} Keys p0-pN mapped to sequential path chunks.
 */
export function tokenizePath(path, maxParts = 5) {
  /** @type {Record<string, string>} */
  const parts = {};
  const s1 = path.indexOf("/");
  if (s1 === -1 || maxParts <= 0) return parts;

  if (maxParts === 2) {
    parts.p0 = path.slice(0, s1);
    parts.p1 = path.slice(s1 + 1);
    return parts;
  }

  const s2 = path.indexOf("/", s1 + 1);
  if (maxParts === 3) {
    parts.p0 = path.slice(0, s1);
    parts.p1 = path.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
    if (s2 !== -1) parts.p2 = path.slice(s2 + 1);
    return parts;
  }

  const s3 = s2 !== -1 ? path.indexOf("/", s2 + 1) : -1;
  if (maxParts === 4) {
    parts.p0 = path.slice(0, s1);
    parts.p1 = path.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
    if (s2 !== -1) parts.p2 = path.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
    if (s3 !== -1) parts.p3 = path.slice(s3 + 1);
    return parts;
  }

  const s4 = s3 !== -1 ? path.indexOf("/", s3 + 1) : -1;
  if (maxParts === 5) {
    parts.p0 = path.slice(0, s1);
    parts.p1 = path.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
    if (s2 !== -1) parts.p2 = path.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
    if (s3 !== -1) parts.p3 = path.slice(s3 + 1, s4 !== -1 ? s4 : undefined);
    if (s4 !== -1) parts.p4 = path.slice(s4 + 1);
    return parts;
  }

  // Generic fallback for maxParts > 5 or maxParts === 1
  let currentIdx = -1;
  for (let i = 0; i < maxParts; i++) {
    if (i === maxParts - 1) {
      parts[`p${i}`] = path.slice(currentIdx + 1);
      break;
    }
    const nextIdx = path.indexOf("/", currentIdx + 1);
    parts[`p${i}`] = path.slice(currentIdx + 1, nextIdx !== -1 ? nextIdx : undefined);
    currentIdx = nextIdx;
    if (currentIdx === -1) break;
  }
  return parts;
}

/**
 * Decodes protocol and relative paths bypassing heavy URL constructors.
 *
 * @param {Request} request - Edge worker Request object.
 * @returns {{protocol: string, rawPath: string}} Parsed URL parameters.
 */
export function parseURL(request) {
  const urlStr = request.url;
  const protocol = request.headers.get("x-forwarded-proto") === "http" ? "http" : "https";
  const pathStart = urlStr.indexOf("/", protocol.length + 3);
  const rawPath = pathStart === -1 ? "" : urlStr.slice(pathStart + 1);
  return { protocol, rawPath };
}

/**
 * Iterates directly over characters to verify exactly 64-length lowercase hex.
 *
 * @param {string} s - Hex string to test.
 * @returns {boolean} True if the string is a valid low-case SHA256.
 */
export function isHex64(s) {
  if (s.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/**
 * Maps standard file extensions to target MIME types.
 *
 * @param {string} key - Filename parameter.
 * @returns {string} Formatted Content-Type mapping.
 */
export function getContentType(key) {
  if (key.endsWith(".gz")) return "application/x-gzip";
  if (key.endsWith(".lz4")) return "application/x-lz4";
  if (key.endsWith(".xz")) return "application/x-xz";
  if (key.endsWith(".gpg")) return "application/pgp-keys";
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}
