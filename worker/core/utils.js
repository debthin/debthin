/**
 * @fileoverview String and URL parsing utilities.
 * Avoids heavy allocations by using manual indexOf sweeps and charCode bounds.
 *
 * Exports:
 * - inReleaseToRelease: Strips PGP signatures.
 * - tokenizePath: Zero-allocation path chunker.
 * - parseURL: Lightweight request endpoint decoder.
 * - isHex64: SHA256 length and charCode validator.
 * - getContentType: Extension-based MIME type switch.
 */

/**
 * Extracts the metadata body from an InRelease file by locating Origin and PGP boundaries.
 *
 * @param {string} text - Raw InRelease payload.
 * @returns {string} The parsed payload buffer.
 */
export function inReleaseToRelease(text) {
  const start = text.indexOf("\nOrigin:");
  if (start === -1) return text;
  const sigStart = text.indexOf("\n-----BEGIN PGP SIGNATURE-----");
  const end = sigStart === -1 ? text.length : sigStart;
  return text.slice(start + 1, end).trimEnd() + "\n";
}

/**
 * Slices endpoint paths into zero-allocation dictionary properties.
 *
 * @param {string} path - URL path segment.
 * @returns {Object} Keys p0-p4 mapped to sequential path chunks.
 */
export function tokenizePath(path) {
  const parts = {};
  const s1 = path.indexOf("/");
  if (s1 === -1) return parts;

  const s2 = path.indexOf("/", s1 + 1);
  const s3 = s2 !== -1 ? path.indexOf("/", s2 + 1) : -1;
  const s4 = s3 !== -1 ? path.indexOf("/", s3 + 1) : -1;

  parts.p0 = path.slice(0, s1);
  parts.p1 = path.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
  if (s2 !== -1) parts.p2 = path.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
  if (s3 !== -1) parts.p3 = path.slice(s3 + 1, s4 !== -1 ? s4 : undefined);
  if (s4 !== -1) parts.p4 = path.slice(s4 + 1);

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
