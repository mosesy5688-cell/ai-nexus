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

export const onRequest = defineMiddleware(async (context, next) => {
    const startTime = performance.now();

    // V14.4 Constitution Alignment: Pages + R2 Architecture ONLY
    // Purged L9 Guardian & KV Cache to eliminate Error 1102 (Resource Exhaustion)

    const response = await next();

    // Add essential guardian/timing headers for observability
    response.headers.set('X-Guardian-Time', `${(performance.now() - startTime).toFixed(2)}ms`);
    response.headers.set('X-Guardian-Version', 'v14.4-purge');

    return response;
});
