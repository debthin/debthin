/**
 * @fileoverview Loads and parses the `config.json` rules.
 * Derives O(1) structures like Set lookup maps to maximize edge verification speed.
 * 
 * Exports:
 * - DERIVED_CONFIG: Processed objects indexing distributions, components, arches, and aliases.
 * - CONFIG_JSON_STRING: The raw original configuration string.
 */


// @ts-expect-error — import attributes (`with { type: 'json' }`) not yet supported by tsc
import configData from '../../config.json' with { type: 'json' };

/**
 * Parses the layout dictionary locally caching configuration settings.
 * @type {{DERIVED_CONFIG: Record<string, any>, CONFIG_JSON_STRING: string}}
 */
export const { DERIVED_CONFIG, CONFIG_JSON_STRING } = (() => {
  const config = /** @type {Record<string, any>} */ (/** @type {any} */ (configData).default || configData);
  const configString = JSON.stringify(config);
  /** @type {Record<string, any>} */
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

    // Build per-architecture upstream mapping for distros with split mirrors
    // (e.g. Ubuntu: archive.ubuntu.com for amd64/i386, ports.ubuntu.com for arm64/riscv64)
    const archUpstreams = new Map();
    const stripProto = (/** @type {string} */ url) => url.slice(url.indexOf("//") + 2);
    if (c.upstream) {
      const host = stripProto(c.upstream);
      for (const a of arches) archUpstreams.set(a, host);
    }
    if (c.upstream_archive && c.archive_arches) {
      const host = stripProto(c.upstream_archive);
      for (const a of c.archive_arches) archUpstreams.set(a, host);
    }
    if (c.upstream_ports && c.ports_arches) {
      const host = stripProto(c.upstream_ports);
      for (const a of c.ports_arches) archUpstreams.set(a, host);
    }

    derived[distro] = { upstream, components, arches, aliasMap, suites, archUpstreams };
  }
  return { DERIVED_CONFIG: derived, CONFIG_JSON_STRING: configString };
})();
