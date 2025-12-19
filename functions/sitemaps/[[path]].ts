/**
 * Cloudflare Functions Sitemap Proxy
 * V6.1 Constitution Compliant - Edge proxy for R2 sitemap files
 * 
 * Routes:
 *   /sitemaps/sitemap-index.xml -> R2: sitemaps/sitemap-index.xml
 *   /sitemaps/models-1.xml.gz   -> R2: sitemaps/models-1.xml.gz
 * 
 * Ref: SPEC_SITEMAP_V6.1.md
 */

interface Env {
    R2_ASSETS: R2Bucket;
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const { request, env, params } = context;
    const url = new URL(request.url);

    // Extract path segments - params.path is an array for catch-all routes
    const pathSegments = params.path;
    if (!pathSegments || pathSegments.length === 0) {
        return new Response("Not Found", { status: 404 });
    }

    // Reconstruct the path
    const path = Array.isArray(pathSegments) ? pathSegments.join("/") : pathSegments;
    const r2Key = `sitemaps/${path}`;

    console.log(`[Sitemap Proxy] Fetching: ${r2Key}`);

    // Fetch from R2
    const object = await env.R2_ASSETS.get(r2Key);

    if (!object) {
        console.log(`[Sitemap Proxy] Not found: ${r2Key}`);
        return new Response("Sitemap Not Found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // Set correct Content-Type based on file extension
    if (path.endsWith(".gz")) {
        headers.set("Content-Type", "application/x-gzip");
        headers.set("Content-Encoding", "gzip");
    } else if (path.endsWith(".xml")) {
        headers.set("Content-Type", "application/xml; charset=utf-8");
    }

    // Cache headers - 1 hour cache, revalidate in background for 1 day
    headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");

    return new Response(object.body, { headers });
};
