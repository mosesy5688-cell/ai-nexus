import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
    // TEMPORARY: KV caching disabled to avoid quota limits
    // Issue: Middleware was caching every /model/ and /topic/ page
    // causing excessive KV operations (read + write per request)
    // 
    // Re-enable after implementing:
    // 1. Rate limiting
    // 2. Selective caching (only popular pages)
    // 3. Or upgrade to paid tier

    /* DISABLED KV CACHING
const url = new URL(context.request.url);
    const isCacheable = url.pathname.startsWith('/model/') || url.pathname.startsWith('/topic/');

    if (isCacheable && context.locals.runtime?.env?.KV_CACHE) {
        const CACHE_VERSION = 'v3.0.5';
        const cacheKey = `${url.pathname}:${CACHE_VERSION}`;
        let cached = await context.locals.runtime.env.KV_CACHE.get(cacheKey);

        if (cached && typeof cached !== 'string') {
            try {
                cached = JSON.stringify(cached);
            } catch (_) {
                cached = '';
            }
        }

        if (cached) {
            return new Response(cached, {
                headers: { 'Content-Type': 'text/html', 'X-KV-Cache': 'HIT' }
            });
        }
    }
    */

    const response = await next();

    /* DISABLED KV WRITE
    if (isCacheable && response.status === 200 && context.locals.runtime?.env?.KV_CACHE) {
        const html = await response.clone().text();
        const CACHE_VERSION = 'v3.0.5';
        const cacheKey = `${url.pathname}:${CACHE_VERSION}`;
        context.locals.runtime.ctx.waitUntil(context.locals.runtime.env.KV_CACHE.put(cacheKey, html, { expirationTtl: 86400 }));
        response.headers.set('X-KV-Cache', 'MISS');
    }
    */

    return response;
});
