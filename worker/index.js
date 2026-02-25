/**
 * debthin - Cloudflare Worker
 *
 * Serves curated Packages/Release/InRelease from KV.
 * Decompresses Packages.gz on the fly when uncompressed Packages requested.
 * Redirects all other requests (actual .deb files etc.) to deb.debian.org.
 *
 * KV namespace binding: MIRROR_KV
 */

const UPSTREAM_BASE = "https://deb.debian.org/debian";

const SUITE_ALIASES = {
  stable:       "trixie",
  oldstable:    "bookworm",
  oldoldstable: "bullseye",
  testing:      "forky",
};

const KV_PATTERNS = [
  /^index\.html$/,
  /^debthin-keyring\.gpg$/,
  /^debthin-keyring-binary\.gpg$/,
  /^dists\/[^/]+\/InRelease$/,
  /^dists\/[^/]+\/Release$/,
  /^dists\/[^/]+\/Release\.gpg$/,
  /^dists\/[^/]+\/main\/binary-(all|amd64|arm64|armhf|i386|riscv64)\/Packages(\.gz|\.lz4|\.xz)?$/,
  /^dists\/[^/]+\/main\/binary-(all|amd64|arm64|armhf|i386|riscv64)\/Packages$/,
  /^dists\/[^/]+\/main\/binary-(all|amd64|arm64|armhf|i386|riscv64)\/Release$/,
];

function resolveAliases(path) {
  const parts = path.split("/");
  if (parts[0] === "dists" && parts[1] && SUITE_ALIASES[parts[1]]) {
    parts[1] = SUITE_ALIASES[parts[1]];
  }
  return parts.join("/");
}

function shouldServeFromKV(path) {
  return KV_PATTERNS.some((p) => p.test(path));
}

function contentType(path) {
  if (path.endsWith(".gz"))   return "application/x-gzip";
  if (path.endsWith(".lz4"))  return "application/x-lz4";
  if (path.endsWith(".xz"))   return "application/x-xz";
  if (path.endsWith(".gpg"))  return "application/pgp-keys";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function decodeKVValue(entry) {
  const meta = entry.metadata || {};
  let body = entry.value;
  if (meta.encoding === "base64") {
    const text = new TextDecoder().decode(body);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    body = bytes.buffer;
  }
  return { body, meta };
}

async function serveFromKV(env, kvKey, responsePath) {
  const entry = await env.MIRROR_KV.getWithMetadata(kvKey, "arrayBuffer");
  if (entry.value === null) return null;

  const { body, meta } = await decodeKVValue(entry);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": meta["content-type"] || contentType(responsePath),
      "Cache-Control": "public, max-age=3600",
      "X-Debthin": "hit",
    },
  });
}

async function serveDecompressed(env, kvKey) {
  const entry = await env.MIRROR_KV.getWithMetadata(kvKey, "arrayBuffer");
  if (entry.value === null) return null;

  const { body } = await decodeKVValue(entry);

  // Decompress gzip using DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(body);
  writer.close();

  const decompressed = await new Response(ds.readable).arrayBuffer();

  return new Response(decompressed, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Debthin": "hit-decomp",
    },
  });
}

function archReleaseBody(path) {
  // Generate per-arch Release on the fly from path
  // path: dists/SUITE/main/binary-ARCH/Release
  const parts = path.split("/");
  const suite = parts[1];
  const arch = parts[3].replace("binary-", "");
  return `Archive: ${suite}\nComponent: main\nArchitecture: ${arch}\n`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = resolveAliases(url.pathname.replace(/^\//, ""));

    // Root request
    if (path === "") {
      return serveFromKV(env, "index.html", "index.html");
    }

    // Per-arch Release - generate on the fly, no KV needed
    if (/^dists\/[^/]+\/main\/binary-(all|amd64|arm64|armhf|i386|riscv64)\/Release$/.test(path)) {
      return new Response(archReleaseBody(path), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "X-Debthin": "hit-generated",
        },
      });
    }

    // Uncompressed Packages - decompress from KV on the fly
    if (/^dists\/[^/]+\/main\/binary-(all|amd64|arm64|armhf|i386|riscv64)\/Packages$/.test(path)) {
      const response = await serveDecompressed(env, path + ".gz");
      if (response) return response;
      if (path.startsWith("dists/")) return new Response("Not found", { status: 404 });
    }

    if (shouldServeFromKV(path)) {
      const response = await serveFromKV(env, path, path);
      if (response) return response;
      if (path.startsWith("dists/")) return new Response("Not found", { status: 404 });
    }

    return Response.redirect(`${UPSTREAM_BASE}/${path}${url.search}`, 301);
  },
};
