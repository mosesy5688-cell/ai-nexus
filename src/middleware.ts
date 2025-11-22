import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
    const url = new URL(context.request.url);
    const isCacheable = url.pathname.startsWith('/model/') || url.pathname.startsWith('/topic/');

    if (isCacheable && context.locals.runtime?.env?.KV_CACHE) {
        const cacheKey = url.pathname;
        const cached = await context.locals.runtime.env.KV_CACHE.get(cacheKey);

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
            context.locals.runtime.env.KV_CACHE.put(url.pathname, html, { expirationTtl: 86400 })
        );
        response.headers.set('X-KV-Cache', 'MISS');
    }

    return response;
});
