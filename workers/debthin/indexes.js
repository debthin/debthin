/**
 * @fileoverview Debian InRelease manifest parser and RAM cache index manager.
 * Extracted from generic R2 layer to enforce clean separation of concerns.
 */

import { metaCache, dataCache } from './cache.js';
import { EMPTY_GZ_HASH, EMPTY_GZ, EMPTY_HASH } from '../core/constants.js';

const _textDecoder = new TextDecoder();

/**
 * Lazily populated index map caching upstream file architectures. 
 * Enables the worker to selectively bypass R2 lookups for by-hash target queries.
 * @type {Map<string, Record<string, string>|Promise<Record<string, string>>>}
 */
export const _hashIndexes = new Map();

/**
 * Retrieves the currently mapped index for a distribution, or undefined.
 * @param {string} distro - The distribution canonical name.
 * @returns {Record<string, string>|Promise<Record<string, string>>|undefined}
 */
export function getDistroIndex(distro) {
  return _hashIndexes.get(distro);
}

/**
 * Assigns or deletes a mapped index for a distribution.
 * @param {string} distro - Canonical distribution name.
 * @param {Record<string, string>|Promise<Record<string, string>>|null} index - The resolved lookup structure to map.
 */
export function setDistroIndex(distro, index) {
  if (index === null) _hashIndexes.delete(distro);
  else _hashIndexes.set(distro, index);
}

/**
 * Returns the size of the tracked distributions in memory.
 * @returns {number} Map size count.
 */
export function getDistroIndexCount() {
  return _hashIndexes.size;
}

/**
 * Parses a textual Debian Release manifest to locate the SHA256 checksum segment.
 * Iterates over each line block building memory map references correlating checksum signatures to target filenames.
 *
 * @param {ArrayBuffer|string} payload - Raw Release manifest payload text values or ArrayBuffer.
 * @param {string} suiteRoot - Active directory base reference limit bindings.
 * @param {boolean} [forceReindex=false] - Triggers deletion of the directory mapping values.
 */
export function warmRamCacheFromRelease(payload, suiteRoot, forceReindex = false) {
  const text = typeof payload === "string" ? payload : _textDecoder.decode(payload);
  const sectionIdx = text.indexOf("\nSHA256:");
  if (sectionIdx === -1) return;

  const distro = suiteRoot.split("/")[1];
  const prefixLen = 6 + distro.length + 1; // "dists/" + distro + "/"

  if (forceReindex) {
    _hashIndexes.delete(distro);
  }

  let distroIndex = _hashIndexes.get(distro);
  if (!distroIndex) {
    distroIndex = {};
    _hashIndexes.set(distro, distroIndex);
  }

  let pos = text.indexOf("\n", sectionIdx + 1) + 1;
  while (pos > 0 && pos < text.length && text.charCodeAt(pos) === 32) {
    const lineEnd = text.indexOf("\n", pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
    const s1 = line.indexOf(" ", 1);
    const s2 = line.indexOf(" ", s1 + 1);
    const hash = line.slice(1, s1);
    const name = line.slice(s2 + 1);

    if (hash === EMPTY_GZ_HASH) {
      if (!dataCache.has(`${suiteRoot}/${name}`)) dataCache.add(`${suiteRoot}/${name}`, /** @type {*} */ (EMPTY_GZ), { contentType: "application/x-gzip" }, Date.now(), true);
    } else if (hash === EMPTY_HASH) {
      if (!dataCache.has(`${suiteRoot}/${name}`)) dataCache.add(`${suiteRoot}/${name}`, new ArrayBuffer(0), { contentType: "text/plain; charset=utf-8" }, Date.now(), true);
    }

    if (hash.length === 64 && name.endsWith("/Packages.gz")) {
      if (!(distroIndex instanceof Promise)) {
      distroIndex[hash] = suiteRoot.slice(prefixLen) + "/" + name;
      }
    }

    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
}
