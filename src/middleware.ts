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

    try {
        // V18.12.5: Global Resilience Wrap
        const response = await next();

        // Add essential guardian/timing headers for observability
        response.headers.set('X-Guardian-Time', `${(performance.now() - startTime).toFixed(2)}ms`);
        response.headers.set('X-Guardian-Version', 'v18.12.5-resilient');

        return response;
    } catch (e: any) {
        console.error("[Middleware] Critical SSR Failure:", e);

        // V18.12.5: Disaster Recovery Redirect
        // If a 500 occurs on a critical detail page, redirect to a static fallback or 
        // return a custom "Soft 500" page that doesn't trigger the Cloudflare generic error.

        const errorUrl = new URL('/404?source=ssr-crash&error=' + encodeURIComponent(e.message || 'unknown'), context.url.origin);

        // If it's an API request or internal server island, return a small error fragment
        if (context.url.pathname.includes('/_server-islands/') || context.url.pathname.startsWith('/api/')) {
            return new Response(
                JSON.stringify({ error: 'Resilience Triggered: Island Failure', message: e.message }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // For full page crashes, redirect to 404 with custom query
        return context.redirect(errorUrl.toString());
    }
});
