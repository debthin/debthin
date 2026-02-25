/**
 * debthin - Cloudflare Worker
 *
 * Serves curated Packages/Release/InRelease from KV.
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
  /^dists\/[^/]+\/InRelease$/,
  /^dists\/[^/]+\/Release$/,
  /^dists\/[^/]+\/Release\.gpg$/,
  /^dists\/[^/]+\/main\/binary-[^/]+\/Packages(\.gz|\.lz4|\.xz)?$/,
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
  if (path.endsWith(".gz"))  return "application/x-gzip";
  if (path.endsWith(".lz4")) return "application/x-lz4";
  if (path.endsWith(".xz"))  return "application/x-xz";
  return "text/plain; charset=utf-8";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = resolveAliases(url.pathname.replace(/^\//, ""));

    if (shouldServeFromKV(path)) {
      const entry = await env.MIRROR_KV.getWithMetadata(path, "arrayBuffer");

      if (entry.value !== null) {
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

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": meta["content-type"] || contentType(path),
            "Cache-Control": "public, max-age=3600",
            "X-Debthin": "hit",
          },
        });
      }
    }

    return Response.redirect(`${UPSTREAM_BASE}/${path}${url.search}`, 301);
  },
};
