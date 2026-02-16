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
        if (!response) throw new Error("Astro next() returned null response");

        // Add essential guardian/timing headers for observability
        response.headers.set('X-Guardian-Time', `${(performance.now() - startTime).toFixed(2)}ms`);
        response.headers.set('X-Guardian-Version', 'v18.12.5-resilient');

        return response;
    } catch (e: any) {
        console.error("[Middleware] Critical SSR Failure:", e.message);

        // V18.12.5.9: Disaster Recovery Redirect (Zero-Image Policy Compliant)
        // Ensure the error URL is safe and doesn't trigger secondary loops
        const errorUrl = new URL('/404', context.url.origin);
        errorUrl.searchParams.set('source', 'ssr-crash');
        errorUrl.searchParams.set('path', context.url.pathname);

        // If it's an API request or internal server island, return a small error fragment
        if (context.url.pathname.includes('/_server-islands/') || context.url.pathname.startsWith('/api/')) {
            return new Response(
                JSON.stringify({ error: 'Resilience Triggered: SSR Crash', reason: e.message }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Prevent recursive redirection if we're already on 404
        if (context.url.pathname === '/404') {
            return new Response("Critical System Failure: 404 Rendering Crashed", { status: 500 });
        }

        return context.redirect(errorUrl.toString());
    }
});
