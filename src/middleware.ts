import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
    const url = new URL(context.request.url);
    const isCacheable = url.pathname.startsWith('/model/') || url.pathname.startsWith('/topic/');

    if (isCacheable && context.locals.runtime?.env?.KV_CACHE) {
        // Append version to cache key to force invalidation of old/stale cache
        const CACHE_VERSION = 'v3.0.5'; // bump version to invalidate stale non‑string cache entries
        const cacheKey = `${url.pathname}:${CACHE_VERSION}`;
        let cached = await context.locals.runtime.env.KV_CACHE.get(cacheKey);

        // Guard against accidentally cached objects (which would render as "[object Object]")
        if (cached && typeof cached !== 'string') {
            try {
                cached = JSON.stringify(cached);
            } catch (_) {
                // Fallback to empty string if serialization fails
                cached = '';
            }
        }

        if (cached) {
            return new Response(cached, {
                headers: { 'Content-Type': 'text/html', 'X-KV-Cache': 'HIT' }
            });
        }
    }

    const response = await next();

    if (isCacheable && response.status === 200 && context.locals.runtime?.env?.KV_CACHE) {
        const html = await response.clone().text();
        // Cache for 24 hours (86400 seconds)
        context.locals.runtime.ctx.waitUntil(
            context.locals.runtime.env.KV_CACHE.put(`${url.pathname}:v3.0.5`, html, { expirationTtl: 86400 })
        );
        response.headers.set('X-KV-Cache', 'MISS');
    }

    return response;
});
