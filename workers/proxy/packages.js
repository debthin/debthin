/**
 * @fileoverview Debian control file parsers and graph manipulation algorithms.
 * Handles parsing Debian dependency graphs, filtering by version pins,
 * and stripping invalid dependency layers.
 */

import { compareDebianVersions, parseVersion } from './version.js';

/**
 * Retrieves a field value from a stanza regardless of its storage type.
 * Stanzas from parsePackages/reduceToLatest use plain objects; stanzas from
 * reduceStreamToLatest use Maps. This accessor unifies both code paths.
 *
 * @param {Record<string, string>|Map<string, string>} fields - The stanza field container.
 * @param {string} key - The lowercase field name.
 * @returns {string|undefined} The field value, or undefined if not present.
 */
function fieldGet(fields, key) {
  return fields instanceof Map ? fields.get(key) : fields[key];
}

/**
 * Iterates over all key-value pairs in a stanza regardless of storage type.
 *
 * @param {Record<string, string>|Map<string, string>} fields - The stanza field container.
 * @returns {Iterable<[string, string]>} Key-value pairs.
 */
function fieldEntries(fields) {
  return fields instanceof Map ? fields.entries() : Object.entries(fields);
}

/**
 * Deserializes an APT formatted Packages payload into primitive JavaScript objects.
 * 
 * @param {string} text - Raw Packages file payload.
 * @returns {Array<Record<string, string>>} An array of dictionaries representing package stanzas.
 */
export function parsePackages(text) {
  const pkgs = [];
  for (const stanza of text.split(/\n\n+/)) {
    if (!stanza.trim()) continue;
    /** @type {Record<string, string>} */
    const fields = {};
    let currentKey = null;
    for (const line of stanza.split("\n")) {
      if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) {
        if (currentKey) fields[currentKey] += "\n" + line;
      } else {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        currentKey = line.slice(0, colon).toLowerCase();
        fields[currentKey] = line.slice(colon + 2);
      }
    }
    if (fields["package"]) pkgs.push(fields);
  }
  return pkgs;
}

/**
 * Parses Debian dependency fields (Depends, Pre-Depends) into an easily evaluated array.
 * 
 * @param {string} depStr - Raw dependency string (e.g., "libc6 (>= 2.1), perl | awk").
 * @returns {Array<Array<string>>} Multi-dimensional array representing logical AND(OR(dependencies)).
 */
export function parseDeps(depStr) {
  if (!depStr) return [];
  return depStr.split(",").map(dep =>
    dep.split("|").map(alt => {
      const paren = alt.indexOf("(");
      return (paren === -1 ? alt : alt.slice(0, paren)).trim();
    }).filter(Boolean)
  );
}

/**
 * Filters a package list to keep only the highest stable versions.
 * Discards components that do not match the target pin version string, if provided.
 * 
 * @param {Array<Record<string, string>>} stanzas - Raw deserialized Packages payload.
 * @param {string|null} pin - Target version pin constraint.
 * @returns {Map<string, Record<string, string>>} An isolated map keeping only the newest acceptable versions.
 */
export function reduceToLatest(stanzas, pin) {
  const best = new Map();
  for (const stanza of stanzas) {
    const name    = stanza["package"];
    const version = stanza["version"] || "";
    if (pin) {
      const { upstream } = parseVersion(version);
      if (upstream !== pin && !upstream.startsWith(pin + ".")) continue;
    }
    if (!best.has(name) || compareDebianVersions(version, best.get(name)["version"] || "") > 0) {
      best.set(name, stanza);
    }
  }
  return best;
}

/**
 * Slab-allocated, JIT-optimized APT Packages stream processor.
 * Pre-allocates a 1MB memory slab to guarantee zero allocations during standard
 * chunk processing. Utilizes V8 Maps for stanza field storage to prevent
 * hidden-class megamorphism on dynamic field parsing.
 *
 * @param {ReadableStream} readableStream - The uncompressed byte stream.
 * @param {string|null} pin - Target framework pinning restriction constraints.
 * @returns {Promise<Map<string, Map<string, string>>>} The reduced mapping of best package versions.
 */
export async function reduceStreamToLatest(readableStream, pin) {
  const reader = readableStream.getReader();
  const best = new Map();
  const decoder = new TextDecoder();

  // 1MB pre-allocated slab. Prevents Uint8Array allocations inside the loop.
  let slab = new Uint8Array(1024 * 1024);
  let slabOffset = 0;

  const processStanza = (/** @type {Uint8Array} */ stanzaBytes) => {
    const text = decoder.decode(stanzaBytes);
    if (!text.trim()) return;

    const pkgMatch = text.match(/^Package:\s*(.+)$/m);
    const verMatch = text.match(/^Version:\s*(.+)$/m);

    if (!pkgMatch) return;
    const name = pkgMatch[1];
    const version = verMatch ? verMatch[1] : "";

    if (pin) {
      const { upstream } = parseVersion(version);
      if (upstream !== pin && !upstream.startsWith(pin + ".")) return;
    }

    if (!best.has(name) || compareDebianVersions(version, best.get(name).get("version") || "") > 0) {
      best.set(name, parseStanzaFieldsMap(text));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Expand slab only if the incoming chunk overflows the buffer
    if (slabOffset + value.length > slab.length) {
      const newSlab = new Uint8Array(slab.length * 2 + value.length);
      newSlab.set(slab.subarray(0, slabOffset));
      slab = newSlab;
    }

    slab.set(value, slabOffset);
    const totalLength = slabOffset + value.length;

    let start = 0;
    for (let i = 0; i < totalLength - 1; i++) {
      if (slab[i] === 10 && slab[i + 1] === 10) {
        processStanza(slab.subarray(start, i));
        start = i + 2;
      }
    }

    // Shift leftover bytes to the beginning of the slab
    if (start < totalLength) {
      slab.copyWithin(0, start, totalLength);
      slabOffset = totalLength - start;
    } else {
      slabOffset = 0;
    }
  }

  if (slabOffset > 0) processStanza(slab.subarray(0, slabOffset));

  return best;
}

/**
 * Parses a raw Debian control stanza string into a Map to preserve V8 hidden
 * class optimization. Using Map avoids the megamorphic property lookups that
 * occur when V8 encounters objects with varying key sets.
 *
 * @param {string} stanzaText - A single decoded stanza block.
 * @returns {Map<string, string>} Dictionary of field name → value.
 */
function parseStanzaFieldsMap(stanzaText) {
  const fields = new Map();
  let currentKey = null;
  const lines = stanzaText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) {
      if (currentKey) fields.set(currentKey, fields.get(currentKey) + "\n" + line);
    } else {
      const colon = line.indexOf(":");
      if (colon !== -1) {
        currentKey = line.slice(0, colon).toLowerCase();
        fields.set(currentKey, line.slice(colon + 2));
      }
    }
  }
  return fields;
}

/**
 * Evaluates the resulting graph to verify satisfied dependencies.
 * Automatically removes isolated packages that lack the required dependency layers internally.
 * Supports both plain-object stanzas (from parsePackages) and Map stanzas (from reduceStreamToLatest).
 * 
 * @param {Map<string, Record<string, string>|Map<string, string>>} pkgMap - Resolved map of targeted latest versions.
 * @returns {Map<string, Record<string, string>|Map<string, string>>} The final filtered graph containing only viable packages.
 */
export function filterPackages(pkgMap) {
  const provides = new Map();
  for (const [, fields] of pkgMap) {
    for (const alts of parseDeps(fieldGet(fields, "provides") || "")) {
      for (const virt of alts) {
        if (!provides.has(virt)) provides.set(virt, []);
        provides.get(virt).push(fieldGet(fields, "package"));
      }
    }
  }
  const canSatisfy = (/** @type {string} */ dep) => pkgMap.has(dep) || provides.has(dep);
  const filtered   = new Map();
  for (const [name, fields] of pkgMap) {
    let ok = true;
    for (const depField of [fieldGet(fields, "depends"), fieldGet(fields, "pre-depends")].filter(Boolean)) {
      for (const alts of parseDeps(depField)) {
        if (!alts.some(canSatisfy)) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) filtered.set(name, fields);
  }
  return filtered;
}

/**
 * Serializes the final mapped structure back into APT-compatible textual formatting.
 * Supports both plain-object stanzas and Map stanzas.
 * 
 * @param {Map<string, Record<string, string>|Map<string, string>>} pkgMap - The final post-filtered mapping structure.
 * @returns {string} The fully serialized string ready for compression.
 */
export function serializePackages(pkgMap) {
  const capitalise = (/** @type {string} */ k) => k.replace(/(^|-)([a-z])/g, (/** @type {string} */ _, /** @type {string} */ p, /** @type {string} */ c) => p + c.toUpperCase());
  const stanzas = [];
  for (const fields of pkgMap.values()) {
    const lines = [`Package: ${fieldGet(fields, "package")}`];
    for (const [k, v] of fieldEntries(fields)) {
      if (k !== "package") lines.push(`${capitalise(k)}: ${v}`);
    }
    stanzas.push(lines.join("\n"));
  }
  return stanzas.join("\n\n") + "\n";
}
