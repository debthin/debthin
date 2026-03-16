/**
 * debthin - Proxy Cloudflare Worker
 *
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

const PROXY_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_HEADERS      = { "Cache-Control": "public, max-age=3600" };

// ── R2 helpers ────────────────────────────────────────────────────────────────

const r2Get = (env, key) => env.DEBTHIN_BUCKET.get(key);
const r2Put = (env, key, val, meta) => env.DEBTHIN_BUCKET.put(key, val, meta || {});

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

function parseDeps(depStr) {
  if (!depStr) return [];
  return depStr.split(",").map(dep =>
    dep.split("|").map(alt => {
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

function parseProxySuitePath(afterDists) {
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

// ── Proxy: InRelease integrity verification ───────────────────────────────────

const HASH_ALGOS = [
  { field: "SHA512:", subtle: "SHA-512", hex_len: 128 },
  { field: "SHA256:", subtle: "SHA-256", hex_len: 64  },
  { field: "SHA1:",   subtle: "SHA-1",   hex_len: 40  },
  { field: "MD5Sum:", subtle: null,      hex_len: 32  },
];

function extractInReleaseHash(text, filePath) {
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

async function verifyHash(buf, { subtle, expected }) {
  if (!subtle) return null;
  const digest = await crypto.subtle.digest(subtle, buf);
  const actual = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

// ── Proxy: R2 cache ───────────────────────────────────────────────────────────

const proxyCacheBase = (host, suite, component, pin, arch) =>
  `proxy/${host}/${suite}/${component}${pin ? `==${pin}` : ""}/${arch}`;

async function getCachedPackages(env, base) {
  const [gzObj, metaObj] = await Promise.all([r2Get(env, `${base}/Packages.gz`), r2Get(env, `${base}/cached-at`)]);
  if (!gzObj || !metaObj) return null;
  const buf = await gzObj.arrayBuffer();
  const [cachedAt, lastModified] = (await metaObj.text()).split("\t");
  return { gz: { arrayBuffer: async () => buf }, fresh: Date.now() - parseInt(cachedAt, 10) < PROXY_CACHE_TTL_MS, lastModified: lastModified || null };
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { "Allow": "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const url = new URL(request.url);
    const raw = url.pathname.slice(1);

    if (raw.startsWith("pkg/")) {
      return Response.redirect(`https://${raw.slice(4)}`, 301);
    }
    
    if (raw.startsWith("dists/")) {
      const afterDists = raw.slice(6);
      return handleProxy(request, env, afterDists);
    }

    return new Response("Proxy Not Found", { status: 404 });
  },
};
