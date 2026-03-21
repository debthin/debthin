/**
 * @fileoverview Route handlers for the image distribution CDN worker.
 */

/**
 * Handles generating the Classic LXC index mapping (index-system).
 * Scans the R2 bucket and constructs a flattened CSV mapping of available container trees.
 * 
 * @param {Object} bucket - The Cloudflare R2 bucket binding.
 * @returns {Promise<Response>} The HTTP response containing the CSV index.
 */
export async function generateLxcIndex(bucket) {
    let indexData = "";
    let processedVersions = new Set();
    let cursor = undefined;

    do {
        const listed = await bucket.list({ prefix: 'images/debian/', cursor: cursor });

        for (const object of listed.objects) {
            const parts = object.key.split('/');
            if (parts.length !== 7) continue;

            const [, os, release, arch, variant, version,] = parts;
            const versionKey = `${os}-${release}-${arch}-${version}`;

            if (!processedVersions.has(versionKey)) {
                indexData += `${os};${release};${arch};${variant};${version};/images/${os}/${release}/${arch}/${variant}/${version}/\n`;
                processedVersions.add(versionKey);
            }
        }
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return new Response(indexData, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=3600'
        }
    });
}

/**
 * Serves the static Incus/LXD pointer file indexing the actual streams endpoint.
 *
 * @returns {Response} The HTTP response containing the predefined JSON pointer.
 */
export function serveIncusPointer() {
    return new Response(JSON.stringify({
        format: "index:1.0",
        index: { images: { datatype: "image-downloads", path: "streams/v1/images.json" } }
    }, null, 2), { 
        headers: { 
            'Content-Type': 'application/json', 
            'Cache-Control': 'public, max-age=86400' 
        } 
    });
}

/**
 * Translates the physical R2 bucket state into an Incus simplestreams JSON tree.
 * Extracts embedded SHA256 hashes directly from the S3 customMetadata API boundaries.
 *
 * @param {Object} bucket - The Cloudflare R2 bucket binding granting access to `customMetadata`.
 * @returns {Promise<Response>} The HTTP response comprising the Simplestreams JSON manifest.
 */
export async function generateIncusIndex(bucket) {
    let products = {};
    let cursor = undefined;

    do {
        const listed = await bucket.list({
            prefix: 'images/debian/',
            include: ['customMetadata'],
            cursor: cursor
        });

        for (const object of listed.objects) {
            const parts = object.key.split('/');
            if (parts.length !== 7) continue;

            const [, os, release, arch, variant, version, filename] = parts;
            const productName = `${os}:${release}:${arch}:${variant}`;

            if (!products[productName]) {
                products[productName] = {
                    aliases: `${release}, ${os}/${release}, ${os}/${release}/${variant}, default`,
                    architecture: arch,
                    os: os,
                    release: release,
                    release_title: `Debian ${release.charAt(0).toUpperCase() + release.slice(1)} (debthin.org)`,
                    versions: {}
                };
            }

            if (!products[productName].versions[version]) {
                products[productName].versions[version] = { items: {} };
            }

            let itemName = "";
            if (filename === "incus.tar.xz") itemName = "incus_meta";
            else if (filename === "rootfs.tar.xz") itemName = "rootfs";
            else continue;

            products[productName].versions[version].items[itemName] = {
                ftype: filename,
                path: object.key,
                size: object.size,
                sha256: object.customMetadata?.sha256 || "HASH_MISSING"
            };
        }
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const streamsJson = {
        format: "products:1.0",
        datatype: "image-downloads",
        products: products
    };

    return new Response(JSON.stringify(streamsJson, null, 2), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
        }
    });
}

/**
 * Redirects binary container downloads to the unmetered R2 public zone to avoid edge egress costs.
 *
 * @param {string} rawPath - The intercepted request path starting with `/images/`.
 * @returns {Response} An HTTP 301 redirection payload.
 */
export function handleImageRedirect(rawPath) {
    const publicR2Url = `https://r2-public.debthin.org${rawPath}`;
    return Response.redirect(publicR2Url, 301);
}
