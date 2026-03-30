/**
 * @fileoverview Proxy route decoders and cryptography verification wrappers.
 * Performs deep evaluation of upstream validation hashes to verify remote caching fidelity.
 */

const HASH_ALGOS = [
  { field: "SHA512:", subtle: "SHA-512", hex_len: 128 },
  { field: "SHA256:", subtle: "SHA-256", hex_len: 64  },
  { field: "SHA1:",   subtle: "SHA-1",   hex_len: 40  },
  { field: "MD5Sum:", subtle: null,      hex_len: 32  },
];

/**
 * Isolates and identifies the requested virtual repository proxy coordinate boundaries.
 * 
 * @param {string} afterDists - The path fragment evaluated directly after the `/dists/` root locator.
 * @returns {ParsedProxyRoute|null} Parameter map matching hosts, components, and target binary architectures.
 */
export function parseProxySuitePath(afterDists) {
  const [host, suite, component, fourth, fifth, file] = afterDists.split("/");
  if (!host || !suite || !component || !fourth) return null;

  if (fourth === "InRelease" || fourth === "Release" || fourth === "Release.gpg") {
    return { host, suite, component, type: fourth === "Release.gpg" ? "release-gpg" : fourth.toLowerCase() };
  }

  if (!fifth || !fifth.startsWith("binary-")) return null;
  const pinIdx = fourth.indexOf("==");
  const pin    = pinIdx === -1 ? null : fourth.slice(pinIdx + 2);
  const arch   = fifth.slice(7);

  if (file === "Release")           return { host, suite, component, pin, arch, type: "arch-release" };
  if (file?.startsWith("Packages")) return { host, suite, component, pin, arch, gz: file.endsWith(".gz"), type: "packages" };
  return null;
}

/**
 * Reverses upstream InRelease index payloads evaluating the internal target file cryptography bounds.
 * 
 * @param {string} text - Standard textual InRelease layout.
 * @param {string} filePath - Exact virtual path boundary to query against inside the mapped target list.
 * @returns {{field: string, subtle: string|null, expected: string}|null} Extracted hashing targets.
 */
export function extractInReleaseHash(text, filePath) {
  for (const { field, subtle, hex_len } of HASH_ALGOS) {
    const sectionIdx = text.indexOf("\n" + field);
    if (sectionIdx === -1) continue;
    let pos = text.indexOf("\n", sectionIdx + 1) + 1;
    while (pos > 0 && pos < text.length && text.charCodeAt(pos) === 32) {
      const lineEnd = text.indexOf("\n", pos);
      const line    = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
      const s1 = line.indexOf(" ", 1);
      const s2 = line.indexOf(" ", s1 + 1);
      const hash = line.slice(1, s1);
      const name = line.slice(s2 + 1);
      if (name === filePath && hash.length === hex_len) return { field, subtle, expected: hash };
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    }
  }
  return null;
}

/**
 * Triggers native Cloudflare WebCrypto evaluation checking physical ArrayBuffer streams natively globally across edge domains.
 * 
 * @param {ArrayBuffer} buf - Local stream payload memory chunk.
 * @param {{subtle: string|null, expected: string}} hashParams - Extracted cryptography hash definition and value bounds (Subtle bindings).
 * @returns {Promise<boolean|null>} Returns boolean validity or null implicitly bypass.
 */
export async function verifyHash(buf, { subtle, expected }) {
  if (!subtle) return null;
  const digest = await crypto.subtle.digest(subtle, buf);
  const actual = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

/**
 * Formats a deterministic R2 cache hierarchy URL proxy structure.
 * 
 * @param {string} host - Vendor repository block.
 * @param {string} suite - Canonical suite map.
 * @param {string} component - Origin component layout.
 * @param {string|null} pin - Target framework pinning restriction constraints natively parsed.
 * @param {string} arch - Exact execution binary architecture bounding layout.
 * @returns {string} The fully qualified R2 cache key index.
 */
export const proxyCacheBase = (host, suite, component, pin, arch) =>
  `proxy/${host}/${suite}/${component}${pin ? "==" + pin : ""}/${arch}`;
