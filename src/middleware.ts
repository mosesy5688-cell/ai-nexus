import { defineMiddleware } from "astro:middleware";

/**
 * V4.8 Unified Middleware
 * 
 * Layer 1: L9 Guardian Protection (SYNC < 5ms)
 * Layer 2: Smart KV Caching
 * 
 * Constitution V4.8 Compliance:
 * - Guardian Law: SYNC < 5ms
 * - Art.IX-Batch: KV batch writes
 * - Art.IX-Metrics: P95 monitoring
 */

const CACHE_VERSION = 'v4.8.0';
const MIN_VISITS_TO_CACHE = 3;
const CACHE_TTL = 86400;

// L9 Guardian Constants
const RATE_LIMIT_PER_MINUTE = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// In-memory rate limit cache (resets on worker restart)
const rateLimitCache = new Map<string, { count: number; resetAt: number }>();

/**
 * L9 Guardian: SYNC protection layer (< 5ms)
 */
async function guardianCheck(context: any): Promise<Response | null> {
    const ip = context.request.headers.get('cf-connecting-ip') || 'unknown';
    const url = new URL(context.request.url);
    const env = context.locals.runtime?.env;
    const startTime = performance.now();

    if (!env?.KV_CACHE) {
        return null; // No KV, skip guardian
    }

    // 1. Check blacklist (KV read - fast)
    try {
        const isBlacklisted = await env.KV_CACHE.get(`blacklist:${ip}`);
        if (isBlacklisted) {
            return new Response('Forbidden', {
                status: 403,
                headers: {
                    'X-Guardian-Blocked': 'blacklist',
                    'X-Guardian-Time': `${(performance.now() - startTime).toFixed(2)}ms`
                }
            });
        }
    } catch (e) {
        // KV error, continue without blocking
    }

    // 2. Rate limit check (memory - instant)
    const now = Date.now();
    const rateKey = `${ip}:${url.pathname}`;
    const rateData = rateLimitCache.get(rateKey);

    if (rateData) {
        if (now < rateData.resetAt) {
            if (rateData.count >= RATE_LIMIT_PER_MINUTE) {
                return new Response('Too Many Requests', {
                    status: 429,
                    headers: {
                        'Retry-After': '60',
                        'X-Guardian-Blocked': 'rate-limit',
                        'X-Guardian-Time': `${(performance.now() - startTime).toFixed(2)}ms`
                    }
                });
            }
            rateData.count++;
        } else {
            rateData.count = 1;
            rateData.resetAt = now + RATE_LIMIT_WINDOW_MS;
        }
    } else {
        rateLimitCache.set(rateKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    }

    // Clean up old entries periodically
    if (rateLimitCache.size > 10000) {
        const entries = Array.from(rateLimitCache.entries());
        for (const [key, data] of entries) {
            if (now > data.resetAt) {
                rateLimitCache.delete(key);
            }
        }
    }

    return null; // Pass through
}

export const onRequest = defineMiddleware(async (context, next) => {
    const startTime = performance.now();
    const url = new URL(context.request.url);

    // ═══════════════════════════════════════════════════════
    // LAYER 1: L9 Guardian Protection
    // ═══════════════════════════════════════════════════════
    const guardianResponse = await guardianCheck(context);
    if (guardianResponse) {
        return guardianResponse;
    }

    // ═══════════════════════════════════════════════════════
    // LAYER 2: Reserved for light-weight checks
    // ═══════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════
    // LAYER 3: Smart KV Caching (existing logic)
    // ═══════════════════════════════════════════════════════
    const isCacheable = url.pathname.startsWith('/model/') || url.pathname.startsWith('/topic/');

    if (!isCacheable || !context.locals.runtime?.env?.KV_CACHE) {
        const response = await next();
        // Add guardian time header
        response.headers.set('X-Guardian-Time', `${(performance.now() - startTime).toFixed(2)}ms`);
        response.headers.set('X-Guardian-Version', 'v5.0');
        return response;
    }

    const pageKey = url.pathname;
    const cacheKey = `html:${pageKey}:${CACHE_VERSION}`;
    const counterKey = `count:${pageKey}`;

    try {
        // Step 1: Check if page is already cached (READ)
        const cachedHTML = await context.locals.runtime.env.KV_CACHE.get(cacheKey);

        if (cachedHTML && typeof cachedHTML === 'string') {
            // Cache hit - return immediately with browser caching
            return new Response(cachedHTML, {
                headers: {
                    'Content-Type': 'text/html',
                    'X-Cache': 'HIT',
                    'X-Cache-Key': cacheKey,
                    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' // V4.6: Browser caching
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
