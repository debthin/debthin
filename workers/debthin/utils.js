/**
 * @fileoverview String tokenizers and parsers tailored exactly for Debian package layouts.
 */

/**
 * Extracts the metadata body from an InRelease file by locating Origin and PGP boundaries.
 *
 * @param {string} text - Raw InRelease payload.
 * @returns {string} The parsed payload buffer.
 */
export function inReleaseToRelease(text) {
  let startIndex = text.indexOf("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n");
  startIndex = startIndex !== -1 ? startIndex + 49 : 0;
  
  let endIndex = text.indexOf("\n-----BEGIN PGP SIGNATURE-----", startIndex);
  if (endIndex === -1) endIndex = text.length;

  return text.slice(startIndex, endIndex);
}

/**
 * Resolves the correct upstream hostname for a given path by extracting
 * the architecture from the URL. Checks two patterns:
 *   - dists paths: "binary-{arch}/" directory segment
 *   - pool paths: "_{arch}.deb" or "_{arch}.udeb" filename suffix
 *
 * Uses indexOf/slice only — no regex allocations on the hot path.
 *
 * @param {string} path - The path after the distro prefix.
 * @param {Map<string, string>} archUpstreams - Per-arch upstream hostname map.
 * @param {string} fallback - The default upstream hostname.
 * @returns {string} The resolved upstream hostname.
 */
export function resolveUpstream(path, archUpstreams, fallback) {
  // dists paths: extract arch from "binary-{arch}/"
  const bi = path.indexOf("binary-");
  if (bi !== -1) {
    const archStart = bi + 7;
    const archEnd = path.indexOf("/", archStart);
    const arch = archEnd === -1 ? path.slice(archStart) : path.slice(archStart, archEnd);
    if (archUpstreams.has(arch)) return archUpstreams.get(arch);
  }
  // pool paths: extract arch from "_{arch}.deb" or "_{arch}.udeb"
  const dot = path.lastIndexOf(".deb");
  if (dot !== -1) {
    let tail = dot;
    if (path.charCodeAt(tail - 1) === 117) tail--; // skip 'u' in .udeb
    const uscore = path.lastIndexOf("_", tail);
    if (uscore !== -1) {
      const arch = path.slice(uscore + 1, tail);
      if (archUpstreams.has(arch)) return archUpstreams.get(arch);
    }
  }
  return fallback;
}
