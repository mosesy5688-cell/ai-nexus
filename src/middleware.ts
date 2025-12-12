import { defineMiddleware } from "astro:middleware";

/**
 * Smart KV Caching Middleware with Visit Counter
 * 
 * Strategy:
 * - Count visits to each page
 * - Only cache pages with 3+ visits (hot content)
 * - Automatic quota management within free tier limits
 * 
 * Free Tier Limits:
 * - Reads: 100,000/day (plenty for counters)
 * - Writes: 1,000/day (only hot pages cached)
 */

const CACHE_VERSION = 'v3.0.7';
const MIN_VISITS_TO_CACHE = 3; // Visit threshold
const CACHE_TTL = 86400; // 24 hours

export const onRequest = defineMiddleware(async (context, next) => {
    const url = new URL(context.request.url);
    const isCacheable = url.pathname.startsWith('/model/') || url.pathname.startsWith('/topic/');

    if (!isCacheable || !context.locals.runtime?.env?.KV_CACHE) {
        return await next();
    }

    const pageKey = url.pathname;
    const cacheKey = `html:${pageKey}:${CACHE_VERSION}`;
    const counterKey = `count:${pageKey}`;

    try {
        // Step 1: Check if page is already cached (READ)
        const cachedHTML = await context.locals.runtime.env.KV_CACHE.get(cacheKey);

        if (cachedHTML && typeof cachedHTML === 'string') {
            // Cache hit - return immediately
            return new Response(cachedHTML, {
                headers: {
                    'Content-Type': 'text/html',
                    'X-Cache': 'HIT',
                    'X-Cache-Key': cacheKey
                }
            });
        }

        // Step 2: Get visit counter (READ)
        const visitCountStr = await context.locals.runtime.env.KV_CACHE.get(counterKey);
        const visitCount = parseInt(visitCountStr || '0');
        const newVisitCount = visitCount + 1;

        // Step 3: Increment counter (WRITE - but counters are cheap)
        // Use short TTL for counters to auto-cleanup cold pages
        await context.locals.runtime.env.KV_CACHE.put(
            counterKey,
            newVisitCount.toString(),
            { expirationTtl: 172800 } // 48 hours
        );

        // Step 4: Render page
        const response = await next();

        // Step 5: Cache only if hot enough (WRITE - selective)
        if (response.status === 200 && newVisitCount >= MIN_VISITS_TO_CACHE) {
            const html = await response.clone().text();

            // Cache the HTML (this is our precious write operation)
            context.locals.runtime.ctx.waitUntil(
                context.locals.runtime.env.KV_CACHE.put(cacheKey, html, {
                    expirationTtl: CACHE_TTL
                })
            );

            response.headers.set('X-Cache', 'MISS-CACHED');
            response.headers.set('X-Visit-Count', newVisitCount.toString());
        } else {
            response.headers.set('X-Cache', 'MISS-NOT-HOT');
            response.headers.set('X-Visit-Count', newVisitCount.toString());
        }

        return response;

    } catch (error) {
        console.error('KV middleware error:', error);
        // Fallback to no caching on error
        return await next();
    }
});
