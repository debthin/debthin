/**
 * @fileoverview Debian control file parsers and graph manipulation algorithms.
 * Handles parsing Debian dependency graphs, filtering by version pins,
 * and stripping invalid dependency layers.
 */

import { compareDebianVersions, parseVersion } from './version.js';

/**
 * Deserializes an APT formatted Packages payload into primitive JavaScript objects.
 * 
 * @param {string} text - Raw Packages file payload.
 * @returns {Array<Object>} An array of dictionaries representing package stanzas.
 */
export function parsePackages(text) {
  const pkgs = [];
  for (const stanza of text.split(/\n\n+/)) {
    if (!stanza.trim()) continue;
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
 * @param {Array<Object>} stanzas - Raw deserialized Packages payload.
 * @param {string|null} pin - Target version pin constraint.
 * @returns {Map<string, Object>} An isolated map keeping only the newest acceptable versions.
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
 * Processes a raw APT Packages decompressed stream iteratively, extracting bounds into a mapped dictionary.
 * Natively avoids V8 Out-Of-Memory limits by dropping discarded versions continuously across chunks.
 * 
 * @param {ReadableStream} readableStream - The uncompressed ASCII text flow.
 * @param {string|null} pin - Target framework pinning restriction constraints.
 * @returns {Promise<Map<string, Object>>} The reduced mapping of best package versions.
 */
export async function reduceStreamToLatest(readableStream, pin) {
  const decoder = new TextDecoderStream();
  const reader = readableStream.pipeThrough(decoder).getReader();

  const best = new Map();
  let buffer = "";

  const processStanzaStr = (stanzaText) => {
    if (!stanzaText.trim()) return;
    const fields = Object.create(null);
    let currentKey = null;

    for (const line of stanzaText.split("\n")) {
      if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) {
        if (currentKey) fields[currentKey] += "\n" + line;
      } else {
        const colon = line.indexOf(":");
        if (colon !== -1) {
          currentKey = line.slice(0, colon).toLowerCase();
          fields[currentKey] = line.slice(colon + 2);
        }
      }
    }

    const name = fields["package"];
    if (!name) return;
    
    const version = fields["version"] || "";
    if (pin) {
      const { upstream } = parseVersion(version);
      if (upstream !== pin && !upstream.startsWith(pin + ".")) return;
    }
    
    if (!best.has(name) || compareDebianVersions(version, best.get(name)["version"] || "") > 0) {
      best.set(name, fields);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const stanzaStr = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      processStanzaStr(stanzaStr);
    }
  }

  if (buffer.trim()) processStanzaStr(buffer.trim());

  return best;
}

/**
 * Evaluates the resulting graph to verify satisfied dependencies.
 * Automatically removes isolated packages that lack the required dependency layers internally.
 * 
 * @param {Map<string, Object>} pkgMap - Resolved map of targeted latest versions.
 * @returns {Map<string, Object>} The final filtered graph containing only viable packages.
 */
export function filterPackages(pkgMap) {
  const provides = new Map();
  for (const [, fields] of pkgMap) {
    for (const alts of parseDeps(fields["provides"] || "")) {
      for (const virt of alts) {
        if (!provides.has(virt)) provides.set(virt, []);
        provides.get(virt).push(fields["package"]);
      }
    }
  }
  const canSatisfy = dep => pkgMap.has(dep) || provides.has(dep);
  const filtered   = new Map();
  for (const [name, fields] of pkgMap) {
    let ok = true;
    for (const depField of [fields["depends"], fields["pre-depends"]].filter(Boolean)) {
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
 * 
 * @param {Map<string, Object>} pkgMap - The final post-filtered mapping structure.
 * @returns {string} The fully serialized string ready for compression.
 */
export function serializePackages(pkgMap) {
  const capitalise = k => k.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase());
  const stanzas = [];
  for (const fields of pkgMap.values()) {
    const lines = [`Package: ${fields["package"]}`];
    for (const [k, v] of Object.entries(fields)) {
      if (k !== "package") lines.push(`${capitalise(k)}: ${v}`);
    }
    stanzas.push(lines.join("\n"));
  }
  return stanzas.join("\n\n") + "\n";
}
