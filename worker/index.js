/**
 * debthin - Cloudflare Worker
 *
 * Serves curated apt indices from R2 for Debian and Ubuntu.
 * Proxy feature sandboxes third-party vendor repos:
 *
 *   deb [trusted=yes] https://deb.debthin.org apt.grafana.com/stable/main grafana
 *   deb [trusted=yes] https://deb.debthin.org apt.grafana.com/stable/main grafana==1.10
 *
 * apt sends:  GET /dists/apt.grafana.com/stable/main/grafana==1.10/binary-amd64/Packages.gz
 * Decoded as: host=apt.grafana.com  suite=stable  component=main  pin=1.10  arch=amd64
 *
 * Fetches upstream Packages.gz, reduces to one package per name (respecting
 * optional version pin), filters to packages with satisfiable intra-repo deps,
 * rewrites Filename: fields through /pkg/ so .deb 301s work, caches in R2 1h.
 *
 * Proxied .deb downloads:  GET /pkg/<host>/<path>  →  301 https://<host>/<path>
 *
 * NOTE: WebCrypto cannot produce OpenPGP-armored signatures. Proxy sources
 * require [trusted=yes] until openpgp.js signing is wired in.
 *
 * R2 bucket:  DEBTHIN_BUCKET
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PROXY_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_HEADERS      = { "Cache-Control": "public, max-age=3600" };

// ── R2 helpers ────────────────────────────────────────────────────────────────

const r2Get = (env, key)            => env.DEBTHIN_BUCKET.get(key);
const r2Put = (env, key, val, meta) => env.DEBTHIN_BUCKET.put(key, val, meta || {});

// transform: "strip-pgp" strips the PGP wrapper from an InRelease file to
// produce a plain Release. "decompress" gunzips on the fly (for Packages).
// fetchKey overrides the R2 key used to fetch (e.g. Release → InRelease).
async function serveR2(env, key, { transform, fetchKey } = {}) {
  const obj = await r2Get(env, fetchKey ?? key);
  if (!obj) return new Response("Not found\n", { status: 404 });

  if (transform === "strip-pgp") {
    return new Response(inReleaseToRelease(await obj.text()), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-derived" },
    });
  }

  if (transform === "decompress") {
    const ds = new DecompressionStream("gzip");
    const w  = ds.writable.getWriter();
    w.write(await obj.arrayBuffer());
    w.close();
    return new Response(await new Response(ds.readable).arrayBuffer(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-decomp" },
    });
  }

  const ct = obj.httpMetadata?.contentType || (
    key.endsWith(".gz")   ? "application/x-gzip"       :
    key.endsWith(".lz4")  ? "application/x-lz4"        :
    key.endsWith(".xz")   ? "application/x-xz"         :
    key.endsWith(".gpg")  ? "application/pgp-keys"      :
    key.endsWith(".html") ? "text/html; charset=utf-8"  :
    "text/plain; charset=utf-8"
  );
  return new Response(obj.body, {
    headers: { "Content-Type": ct, ...CACHE_HEADERS, "X-Debthin": "hit" },
  });
}

// ── Config (loaded once per isolate lifetime) ─────────────────────────────────

const _derivedByBucket = new WeakMap();

async function ensureConfig(env) {
  if (_derivedByBucket.has(env.DEBTHIN_BUCKET)) return;
  const obj = await r2Get(env, "config.json");
  if (!obj) throw new Error("config.json not found in R2");
  const config  = JSON.parse(await obj.text());
  const derived = {};
  for (const [distro, c] of Object.entries(config)) {
    // Each distro block must have: upstream (string), components (array),
    // arches (array or multiple arch arrays), suites (object with optional aliases).
    // upstream_key names the field holding the upstream hostname.
    const upstreamRaw = c.upstream ?? c.upstream_archive ?? c.upstream_ports;
    if (!upstreamRaw) continue; // skip non-distro keys (e.g. top-level metadata)
    const upstream  = upstreamRaw.slice(upstreamRaw.indexOf("//") + 2); // strip protocol
    const components = new Set(c.components);
    const archArrays = [c.arches, c.archive_arches, c.ports_arches].filter(Boolean);
    const arches     = new Set(["all", ...archArrays.flat()]);
    const aliasMap   = new Map();
    for (const [suite, meta] of Object.entries(c.suites ?? {})) {
      if (meta.aliases) for (const alias of meta.aliases) aliasMap.set(alias, suite);
    }
    derived[distro] = { upstream, components, arches, aliasMap };
  }
  _derivedByBucket.set(env.DEBTHIN_BUCKET, derived);
}

const getDerived = env => _derivedByBucket.get(env.DEBTHIN_BUCKET);

function resolveAlias(derived, distro, suitePath) {
  if (!suitePath.startsWith("dists/")) return suitePath;
  const slash2    = suitePath.indexOf("/", 6);
  const suite     = slash2 === -1 ? suitePath.slice(6) : suitePath.slice(6, slash2);
  const canonical = derived[distro].aliasMap.get(suite);
  if (!canonical) return suitePath;
  return "dists/" + canonical + suitePath.slice(slash2);
}

// ── Release helpers ───────────────────────────────────────────────────────────

function inReleaseToRelease(text) {
  // Find the cleartext body between the PGP header and the signature block.
  const start = text.indexOf("\nOrigin:");
  if (start === -1) return text;
  const sigStart = text.indexOf("\n-----BEGIN PGP SIGNATURE-----");
  const end = sigStart === -1 ? text.length : sigStart;
  return text.slice(start + 1, end).trimEnd() + "\n";
}

// ── Debian version comparison (deb-version(7)) ────────────────────────────────

function parseVersion(v) {
  let epoch = 0;
  const colonIdx = v.indexOf(":");
  if (colonIdx !== -1) { epoch = parseInt(v.slice(0, colonIdx), 10) || 0; v = v.slice(colonIdx + 1); }
  const dashIdx = v.lastIndexOf("-");
  return dashIdx !== -1
    ? { epoch, upstream: v.slice(0, dashIdx), revision: v.slice(dashIdx + 1) }
    : { epoch, upstream: v, revision: "0" };
}

function charOrder(c) {
  if (c === undefined) return 0;
  if (c === "~") return -1;
  const code = c.charCodeAt(0);
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return code;
  return code + 256;
}

function compareVersionPart(a, b) {
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    // Non-digit run: character-by-character per charOrder
    let na = "", nb = "";
    while (i < a.length && (a.charCodeAt(i) < 48 || a.charCodeAt(i) > 57)) na += a[i++];
    while (j < b.length && (b.charCodeAt(j) < 48 || b.charCodeAt(j) > 57)) nb += b[j++];
    for (let k = 0; k < Math.max(na.length, nb.length); k++) {
      const d = charOrder(na[k]) - charOrder(nb[k]);
      if (d !== 0) return d;
    }
    // Digit run: numeric comparison
    let da = "", db = "";
    while (i < a.length && a.charCodeAt(i) >= 48 && a.charCodeAt(i) <= 57) da += a[i++];
    while (j < b.length && b.charCodeAt(j) >= 48 && b.charCodeAt(j) <= 57) db += b[j++];
    const diff = parseInt(da || "0", 10) - parseInt(db || "0", 10);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareDebianVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  const up = compareVersionPart(pa.upstream, pb.upstream);
  return up !== 0 ? up : compareVersionPart(pa.revision, pb.revision);
}

// ── Packages parsing / filtering / serialization ──────────────────────────────

function parsePackages(text) {
  const pkgs = [];
  for (const stanza of text.split(/\n\n+/)) {
    if (!stanza.trim()) continue;
    const fields = {};
    let currentKey = null;
    for (const line of stanza.split("\n")) {
      if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) { // space or tab = continuation
        if (currentKey) fields[currentKey] += "\n" + line;
      } else {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        currentKey = line.slice(0, colon).toLowerCase();
        fields[currentKey] = line.slice(colon + 2); // skip ": "
      }
    }
    if (fields["package"]) pkgs.push(fields);
  }
  return pkgs;
}

function parseDeps(depStr) {
  if (!depStr) return [];
  return depStr.split(",").map(dep =>
    dep.split("|").map(alt => {
      // Strip version constraint "(>= 1.2)" if present
      const paren = alt.indexOf("(");
      return (paren === -1 ? alt : alt.slice(0, paren)).trim();
    }).filter(Boolean)
  );
}

function reduceToLatest(stanzas, pin) {
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

function filterPackages(pkgMap) {
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

function serializePackages(pkgMap) {
  // Capitalise hyphen-separated field keys (e.g. "pre-depends" → "Pre-Depends").
  // Keys are always lowercase ASCII from parsePackages so charCodeAt arithmetic is safe.
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

// ── Proxy: path parsing ───────────────────────────────────────────────────────

// apt uses the sources.list suite field verbatim as path segments, so the path
// after "dists/" is:  <host>/<suite>/<component>/<local-suite[==pin]>/binary-<arch>/<file>
function parseProxySuitePath(afterDists) {
  const [host, suite, component, fourth, fifth, file] = afterDists.split("/");
  if (!host || !suite || !component || !fourth) return null;

  if (fourth === "InRelease" || fourth === "Release" || fourth === "Release.gpg") {
    // "Release.gpg" → "release-gpg"; others already lowercase
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

// ── Proxy: InRelease integrity verification ───────────────────────────────────

const HASH_ALGOS = [
  { field: "SHA512:", subtle: "SHA-512", hex_len: 128 },
  { field: "SHA256:", subtle: "SHA-256", hex_len: 64  },
  { field: "SHA1:",   subtle: "SHA-1",   hex_len: 40  },
  { field: "MD5Sum:", subtle: null,      hex_len: 32  }, // WebCrypto has no MD5; skip verification
];

function extractInReleaseHash(text, filePath) {
  for (const { field, subtle, hex_len } of HASH_ALGOS) {
    const sectionIdx = text.indexOf("\n" + field);
    if (sectionIdx === -1) continue;
    // Walk lines after the section header without splitting the whole text
    let pos = text.indexOf("\n", sectionIdx + 1) + 1;
    while (pos > 0 && pos < text.length && text.charCodeAt(pos) === 32) {
      const lineEnd = text.indexOf("\n", pos);
      const line    = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
      // Line format: " <hash>  <size>  <filename>"
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

async function verifyHash(buf, { subtle, expected }) {
  if (!subtle) return null; // MD5 - no WebCrypto support, skip
  const digest = await crypto.subtle.digest(subtle, buf);
  const actual = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

// ── Proxy: R2 cache ───────────────────────────────────────────────────────────

const proxyCacheBase = (host, suite, component, pin, arch) =>
  `proxy/${host}/${suite}/${component}${pin ? `==${pin}` : ""}/${arch}`;

async function getCachedPackages(env, base) {
  const [gz, meta] = await Promise.all([r2Get(env, `${base}/Packages.gz`), r2Get(env, `${base}/cached-at`)]);
  if (!gz || !meta) return null;
  const [cachedAt, lastModified] = (await meta.text()).split("\t");
  return { gz, fresh: Date.now() - parseInt(cachedAt, 10) < PROXY_CACHE_TTL_MS, lastModified: lastModified || null };
}

async function putCachedPackages(env, base, gz, lastModified) {
  const metaValue = lastModified ? `${Date.now()}\t${lastModified}` : String(Date.now());
  await Promise.all([
    r2Put(env, `${base}/Packages.gz`, gz, { httpMetadata: { contentType: "application/x-gzip" } }),
    r2Put(env, `${base}/cached-at`, metaValue),
  ]);
}

// ── Proxy: request handler ────────────────────────────────────────────────────

async function handleProxy(request, env, afterDists) {
  const parsed = parseProxySuitePath(afterDists);
  if (!parsed) return new Response("Bad proxy path\n", { status: 400 });

  const { host, suite, component, type } = parsed;

  if (type === "inrelease" || type === "release") {
    const body = [
      `Origin: debthin-proxy`,
      `Label: debthin-proxy/${host}`,
      `Suite: ${suite}`,
      `Codename: ${suite}`,
      `Date: ${new Date().toUTCString()}`,
      `Acquire-By-Hash: no`,
      `Description: debthin filtered proxy index for ${host}`,
    ].join("\n") + "\n";
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "proxy-release" },
    });
  }

  if (type === "release-gpg") return new Response("Not supported\n", { status: 404 });

  const { pin, arch } = parsed;

  if (type === "arch-release") {
    return new Response(
      `Archive: ${suite}\nComponent: ${component}\nArchitecture: ${arch}\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "proxy-arch-release" } }
    );
  }

  // type === "packages"
  const { gz }    = parsed;
  const cacheBase = proxyCacheBase(host, suite, component, pin, arch);
  let cached      = await getCachedPackages(env, cacheBase);

  if (!cached || !cached.fresh) {
    const irHeaders = cached?.lastModified ? { "If-Modified-Since": cached.lastModified } : {};
    const irResp    = await fetch(`https://${host}/dists/${suite}/InRelease`, { headers: irHeaders });

    if (irResp.status === 304) {
      const metaValue = cached.lastModified ? `${Date.now()}\t${cached.lastModified}` : String(Date.now());
      await r2Put(env, `${cacheBase}/cached-at`, metaValue);
      cached = { ...cached, fresh: true };

    } else if (irResp.ok) {
      const lastModified = irResp.headers.get("Last-Modified") || null;
      const irText       = await irResp.text();
      const pkgPath      = `${component}/binary-${arch}/Packages.gz`;
      const hashEntry    = extractInReleaseHash(irText, pkgPath);
      const pkgUrl       = `/dists/${suite}/${component}/binary-${arch}/Packages.gz`;

      let pkgResp = await fetch(`https://${host}${pkgUrl}`);
      if (!pkgResp.ok) pkgResp = await fetch(`http://${host}${pkgUrl}`);

      if (!pkgResp.ok) {
        if (cached) cached = { ...cached, fresh: true };
        else return new Response("Upstream Packages.gz fetch failed\n", { status: 502 });
      } else {
        const pkgBuf = await pkgResp.arrayBuffer();

        if (hashEntry && await verifyHash(pkgBuf, hashEntry) === false) {
          return new Response(
            `Upstream Packages.gz hash mismatch (${hashEntry.field.slice(0, -1)})\n`, { status: 502 }
          );
        }

        const ds = new DecompressionStream("gzip");
        const w  = ds.writable.getWriter();
        w.write(pkgBuf);
        w.close();

        const filtered = filterPackages(reduceToLatest(parsePackages(await new Response(ds.readable).text()), pin));
        const prefix   = `pkg/${host}/`;
        for (const fields of filtered.values()) {
          if (fields["filename"]) fields["filename"] = prefix + fields["filename"];
        }

        const cs = new CompressionStream("gzip");
        const w2 = cs.writable.getWriter();
        w2.write(new TextEncoder().encode(serializePackages(filtered)));
        w2.close();
        const resultGz = await new Response(cs.readable).arrayBuffer();

        await putCachedPackages(env, cacheBase, resultGz, lastModified);
        cached = { gz: { arrayBuffer: async () => resultGz }, fresh: true };
      }

    } else {
      if (cached) cached = { ...cached, fresh: true };
      else return new Response("Upstream InRelease fetch failed\n", { status: 502 });
    }
  }

  const buf = await cached.gz.arrayBuffer();
  if (!gz) {
    const ds = new DecompressionStream("gzip");
    const w  = ds.writable.getWriter();
    w.write(buf);
    w.close();
    return new Response(await new Response(ds.readable).text(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "proxy-packages" },
    });
  }
  return new Response(buf, {
    headers: { "Content-Type": "application/x-gzip", ...CACHE_HEADERS, "X-Debthin": "proxy-packages-gz" },
  });
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const raw = url.pathname.slice(1); // always starts with /

    if (raw === "") return serveR2(env, "index.html");

    if (raw === "config.json" || raw === "debthin-keyring.gpg" || raw === "debthin-keyring-binary.gpg") {
      return serveR2(env, raw);
    }

    if (raw.startsWith("pkg/")) {
      return Response.redirect(`https://${raw.slice(4)}`, 301);
    }

    try {
      await ensureConfig(env);
    } catch {
      return new Response("Internal Server Error: Missing config.json", { status: 500 });
    }

    const derived = getDerived(env);
    const slash   = raw.indexOf("/");
    const first   = slash === -1 ? raw : raw.slice(0, slash);
    const distro  = derived[first] ? first : Object.keys(derived)[0];
    const rest    = derived[first] ? (slash === -1 ? "" : raw.slice(slash + 1)) : raw;

    // pool/ requests are .deb downloads - redirect immediately, no further dispatch needed
    if (rest.startsWith("pool/")) {
      const { upstream } = derived[distro];
      return Response.redirect(`${url.protocol}//${upstream}/${rest}${url.search}`, 301);
    }

    const suitePath = resolveAlias(derived, distro, rest);
    const r2Key     = `dists/${distro}/${suitePath.slice(6)}`;

    // Proxy: suite segment looks like a hostname (contains a dot)
    if (suitePath.startsWith("dists/")) {
      const afterDists = suitePath.slice(6);
      const slashIdx   = afterDists.indexOf("/");
      const suite      = slashIdx === -1 ? afterDists : afterDists.slice(0, slashIdx);
      if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}$/.test(suite)) {
        if (url.protocol === "http:") {
          return new Response(
            "Proxy requests must use HTTPS. Update your sources.list to use https://deb.debthin.org\n",
            { status: 403 }
          );
        }
        return handleProxy(request, env, afterDists);
      }
    }

    const { upstream, components, arches } = derived[distro];
    const parts = suitePath.split("/");
    const [p0, p1, p2, p3, p4] = parts;

    if (p0 === "dists" && p1 && p2) {
      if (!p3) {
        if (p2 === "InRelease" || p2 === "Release.gpg") {
          return serveR2(env, r2Key);
        }
        if (p2 === "Release") return serveR2(env, r2Key, { fetchKey: r2Key.replace("Release", "InRelease"), transform: "strip-pgp" });
      }

      if (p3 && components.has(p2) && p3.startsWith("binary-") && arches.has(p3.slice(7))) {
        if (p4 === "Release") {
          return new Response(
            `Archive: ${p1}\nComponent: ${p2}\nArchitecture: ${p3.slice(7)}\n`,
            { headers: { "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS, "X-Debthin": "hit-generated" } }
          );
        }
        if (p4 === "Packages") {
          return serveR2(env, r2Key, { fetchKey: r2Key + ".gz", transform: "decompress" });
        }
        if (p4 === "Packages.gz" || p4 === "Packages.lz4" || p4 === "Packages.xz") {
          return serveR2(env, r2Key);
        }
      }

      if (parts.length >= 5 && parts.at(-3) === "by-hash" && parts.at(-2) === "SHA256") {
        const sha256 = parts.at(-1);
        if (sha256.length === 64 && /^[0-9a-f]+$/.test(sha256)) {
          const indexObj = await r2Get(env, `dists/${distro}/${p1}/by-hash-index`);
          if (indexObj) {
            const relPath = JSON.parse(await indexObj.text())[sha256];
            if (relPath) return serveR2(env, `dists/${distro}/${p1}/${relPath}`);
          }
          return new Response("Not found", { status: 404 });
        }
      }
    }

    return Response.redirect(`${url.protocol}//${upstream}/${suitePath}${url.search}`, 301);
  },
};
