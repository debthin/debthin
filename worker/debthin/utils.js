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


