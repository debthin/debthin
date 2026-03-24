/**
 * @fileoverview Debian version string parsing and comparison utilities.
 * Implements standard deb-version(7) comparison rules (epoch:upstream-revision).
 */

/**
 * Parses a Debian version string into epoch, upstream, and revision components.
 * 
 * @param {string} v - The raw Debian version string (e.g., "1:2.3.4-5").
 * @returns {{epoch: number, upstream: string, revision: string}} Parsed version components.
 */
export function parseVersion(v) {
  let epoch = 0;
  const colonIdx = v.indexOf(":");
  if (colonIdx !== -1) { epoch = parseInt(v.slice(0, colonIdx), 10) || 0; v = v.slice(colonIdx + 1); }
  const dashIdx = v.lastIndexOf("-");
  return dashIdx !== -1
    ? { epoch, upstream: v.slice(0, dashIdx), revision: v.slice(dashIdx + 1) }
    : { epoch, upstream: v, revision: "0" };
}

/**
 * Calculates the sorting order of a character per Debian policy.
 * Tildes sort before nothing, which sorts before letters, which sort before punctuation.
 * 
 * @param {string} [c] - A single character to evaluate.
 * @returns {number} The absolute sorting weight of the character.
 */
export function charOrder(c) {
  if (c === undefined) return 0;
  if (c === "~") return -1;
  const code = c.charCodeAt(0);
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return code;
  return code + 256;
}

/**
 * Compares two components (upstream or revision) of a Debian version string.
 * Splits strings into contiguous alpha and numeric chunks for discrete comparison.
 * 
 * @param {string} a - The first version component.
 * @param {string} b - The second version component.
 * @returns {number} A negative number if a < b, positive if a > b, or 0 if equal.
 */
export function compareVersionPart(a, b) {
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let na = "", nb = "";
    while (i < a.length && (a.charCodeAt(i) < 48 || a.charCodeAt(i) > 57)) na += a[i++];
    while (j < b.length && (b.charCodeAt(j) < 48 || b.charCodeAt(j) > 57)) nb += b[j++];
    for (let k = 0; k < Math.max(na.length, nb.length); k++) {
      const d = charOrder(na[k]) - charOrder(nb[k]);
      if (d !== 0) return d;
    }
    let da = "", db = "";
    while (i < a.length && a.charCodeAt(i) >= 48 && a.charCodeAt(i) <= 57) da += a[i++];
    while (j < b.length && b.charCodeAt(j) >= 48 && b.charCodeAt(j) <= 57) db += b[j++];
    const diff = parseInt(da || "0", 10) - parseInt(db || "0", 10);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Standard public Debian version comparator.
 * Applies epoch, upstream, then revision evaluation.
 * 
 * @param {string} a - The first version string.
 * @param {string} b - The second version string.
 * @returns {number} Comparison result.
 */
export function compareDebianVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  const up = compareVersionPart(pa.upstream, pb.upstream);
  return up !== 0 ? up : compareVersionPart(pa.revision, pb.revision);
}
