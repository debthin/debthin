/**
 * debthin - Cloudflare Worker
 *
 * Serves curated Packages/Release/InRelease from R2.
 * Decompresses Packages.gz on the fly when uncompressed Packages requested.
 * Generates per-arch/component Release on the fly.
 * Resolves by-hash requests via a per-suite hash index stored in R2.
 *
 * Path routing:
 *   /debian/...  → R2, fallthrough to deb.debian.org/debian/...
 *   /ubuntu/...  → R2, fallthrough to archive.ubuntu.com/ubuntu/...
 *   /...         → assume debian (backwards compatible)
 *   anything else           → assume debian
 *
 * R2 bucket binding: DEBTHIN_BUCKET
 */

import config from "../config.json";

const UPSTREAMS = {
  debian: config.debian.upstream.replace(/^https?:\/\//, ''),
  ubuntu: config.ubuntu.upstream_archive.replace(/^https?:\/\//, ''),
};

function getConfig(distro) {
  return config[distro];
}

function components(distro) {
  return getConfig(distro).components;
}

function componentRe(distro) {
  return components(distro).join("|");
}

function resolveAliases(distro, suitePath) {
  const c = getConfig(distro);
  const parts = suitePath.split("/");
  if (parts[0] === "dists" && parts[1]) {
    const term = parts[1];
    // Check if the term is a formal suite or an alias
    for (const [suite, meta] of Object.entries(c.suites)) {
      if (suite === term || (meta.aliases && meta.aliases.includes(term))) {
        parts[1] = suite;
        break;
      }
    }
  }
  return parts.join("/");
}

function buildArchRegex(distro) {
  const c = getConfig(distro);
  if (distro === 'debian') {
    return c.arches.join("|") + "|all"; // Debian allows 'all'
  } else {
    // Ubuntu combines both archive and ports arches
    const allArches = new Set([...c.archive_arches, ...c.ports_arches, "all"]);
    return Array.from(allArches).join("|");
  }
}

function contentType(path) {
  if (path.endsWith(".gz")) return "application/x-gzip";
  if (path.endsWith(".lz4")) return "application/x-lz4";
  if (path.endsWith(".xz")) return "application/x-xz";
  if (path.endsWith(".gpg")) return "application/pgp-keys";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600",
};

async function r2Get(env, key) {
  return env.DEBTHIN_BUCKET.get(key);
}

async function serveR2(env, key) {
  const obj = await r2Get(env, key);
  if (!obj) return null;
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || contentType(key),
      ...CACHE_HEADERS,
      "X-Debthin": "hit",
    },
  });
}

async function serveDecompressed(env, key) {
  const obj = await r2Get(env, key);
  if (!obj) return null;
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const data = await obj.arrayBuffer();
  writer.write(data);
  writer.close();
  const decompressed = await new Response(ds.readable).arrayBuffer();
  return new Response(decompressed, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CACHE_HEADERS,
      "X-Debthin": "hit-decomp",
    },
  });
}

function inReleaseToRelease(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.startsWith("Origin:"));
  const end = lines.findIndex(l => l.startsWith("-----BEGIN PGP SIGNATURE-----"));
  if (start === -1) return text;
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trimEnd() + "\n";
}

function archReleaseBody(suitePath) {
  // dists/SUITE/COMPONENT/binary-ARCH/Release
  const parts = suitePath.split("/");
  const suite = parts[1];
  const component = parts[2];
  const arch = parts[3].replace("binary-", "");
  return `Archive: ${suite}\nComponent: ${component}\nArchitecture: ${arch}\n`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const raw = url.pathname.replace(/^\//, "");

    // Root
    if (raw === "") {
      const obj = await r2Get(env, "index.html");
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...CACHE_HEADERS },
      });
    }

    // Keyring files
    if (/^debthin-keyring(-binary)?\.gpg$/.test(raw)) {
      return await serveR2(env, raw) || new Response("Not found", { status: 404 });
    }

    // Route by distro prefix
    const slash = raw.indexOf("/");
    const first = slash === -1 ? raw : raw.slice(0, slash);
    let distro, rest;

    if (first === "debian" || first === "ubuntu") {
      distro = first;
      rest = slash === -1 ? "" : raw.slice(slash + 1);
    } else {
      // No distro prefix - assume debian (backwards compat)
      // Covers dists/..., pool/..., and any other debian paths
      distro = "debian";
      rest = raw;
    }

    const upstream = UPSTREAMS[distro];
    const suitePath = resolveAliases(distro, rest);
    const r2Key = `${distro}/${suitePath}`;
    const c = componentRe(distro);

    // Suite-level Release - strip PGP wrapper from InRelease
    if (/^dists\/[^/]+\/Release$/.test(suitePath)) {
      const obj = await r2Get(env, r2Key.replace(/\/Release$/, "/InRelease"));
      if (!obj) return new Response("Not found", { status: 404 });
      const text = await obj.text();
      return new Response(inReleaseToRelease(text), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS,
          "X-Debthin": "hit-derived"
        },
      });
    }

    const archRe = buildArchRegex(distro);

    // Per-component per-arch Release - generated on the fly
    if (new RegExp(`^dists/[^/]+/(${c})/binary-(${archRe})/Release$`).test(suitePath)) {
      return new Response(archReleaseBody(suitePath), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8", ...CACHE_HEADERS,
          "X-Debthin": "hit-generated"
        },
      });
    }

    // Uncompressed Packages - decompress on the fly
    if (new RegExp(`^dists/[^/]+/(${c})/binary-(${archRe})/Packages$`).test(suitePath)) {
      return await serveDecompressed(env, r2Key + ".gz")
        || new Response("Not found", { status: 404 });
    }

    // By-hash - resolve via suite hash index
    const byHashMatch = suitePath.match(/^(dists\/[^/]+)\/.+\/by-hash\/SHA256\/([0-9a-f]{64})$/);
    if (byHashMatch) {
      const suitePrefix = byHashMatch[1];
      const sha256 = byHashMatch[2];
      const indexObj = await r2Get(env, `${distro}/${suitePrefix}/by-hash-index`);
      if (indexObj) {
        const index = JSON.parse(await indexObj.text());
        const relPath = index[sha256];
        if (relPath) {
          return await serveR2(env, `${distro}/${suitePrefix}/${relPath}`)
            || new Response("Not found", { status: 404 });
        }
      }
      return new Response("Not found", { status: 404 });
    }

    // Known dist paths - serve from R2
    const distPatterns = [
      new RegExp(`^dists/[^/]+/InRelease$`),
      new RegExp(`^dists/[^/]+/Release\\.gpg$`),
      new RegExp(`^dists/[^/]+/(${c})/binary-(${archRe})/Packages(\\.gz|\\.lz4|\\.xz)?$`),
    ];
    if (distPatterns.some(p => p.test(suitePath))) {
      return await serveR2(env, r2Key)
        || new Response("Not found", { status: 404 });
    }

    // Everything else - redirect to upstream, matching client protocol
    const proto = url.protocol; // "http:" or "https:"
    return Response.redirect(`${proto}//${upstream}/${suitePath}${url.search}`, 301);
  },
};
