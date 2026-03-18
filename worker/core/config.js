/**
 * @fileoverview Loads and parses the `config.json` rules.
 * Derives O(1) structures like Set lookup maps to maximize edge verification speed.
 * 
 * Exports:
 * - DERIVED_CONFIG: Processed objects indexing distributions, components, arches, and aliases.
 * - CONFIG_JSON_STRING: The raw original configuration string.
 */

import configData from '../../config.json';

/**
 * Parses the layout dictionary locally caching configuration settings.
 * @type {Object}
 * @property {Object} DERIVED_CONFIG - The parsed and structurally verified layout dictionary.
 * @property {string} CONFIG_JSON_STRING - The literal canonical string version of the config data block.
 */
export const { DERIVED_CONFIG, CONFIG_JSON_STRING } = (() => {
  const config = configData.default || configData;
  const configString = JSON.stringify(config);
  const derived = {};
  for (const [distro, c] of Object.entries(config)) {
    const upstreamRaw = c.upstream ?? c.upstream_archive ?? c.upstream_ports;
    if (!upstreamRaw) continue;
    const upstream = upstreamRaw.slice(upstreamRaw.indexOf("//") + 2); // strip protocol
    const components = new Set(c.components);
    const archArrays = [c.arches, c.archive_arches, c.ports_arches].filter(Boolean);
    const arches = new Set(["all", ...archArrays.flat()]);
    const aliasMap = new Map();
    const suites = new Set(Object.keys(c.suites ?? {}));
    for (const [suite, meta] of Object.entries(c.suites ?? {})) {
      if (meta.aliases) for (const alias of meta.aliases) aliasMap.set(alias, suite);
    }
    derived[distro] = { upstream, components, arches, aliasMap, suites };
  }
  return { DERIVED_CONFIG: derived, CONFIG_JSON_STRING: configString };
})();
