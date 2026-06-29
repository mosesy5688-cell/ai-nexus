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

// GR-02 (Founder D-184 §B) — Tier-A LIVE security headers, applied on the SSR
// response path. The static public/_headers file is NOT applied by the SSR Worker
// (same dead-file class as the retired public/_redirects), so the live authority
// is here. STRICT #2218 CONSTRAINT: NO new top-level import is added to this file
// and these values are INLINE plain data / local constants — no shared header
// helper, config module or src/lib subsystem is imported (a static import would
// pull a module into the Worker cold-load chain, the TA2-INCIDENT-1 failure mode).
// Tier-B (full script/style/connect CSP, COOP/COEP/CORP, HSTS changes, preload)
// is deliberately NOT set here.

// Conservative deny-list of powerful features the site genuinely does NOT use.
// clipboard-write + fullscreen are intentionally LEFT OUT (the copy button +
// any future media UI must keep working).
const PERMISSIONS_POLICY_VALUE =
    'geolocation=(), camera=(), microphone=(), usb=(), payment=(), ' +
    'magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=(), hid=()';

// Route-class discriminator: a HUMAN response is one served as text/html. Every
// machine/API surface (/api/*, openapi.json, llms.txt, sitemaps, vfs binary) and
// every static asset (/_astro/*, /assets/*, .wasm) carries a NON-text/html
// Content-Type, so this never misclassifies them as human pages.
export function isHumanHtmlResponse(contentType: string | null | undefined): boolean {
    return (contentType || '').toLowerCase().includes('text/html');
}

// Apply Tier-A security headers ADDITIVELY to an already-produced Response.
// - nosniff is set IDEMPOTENTLY (only if absent) so it is never doubled against an
//   edge-injected value — exactly one effective value.
// - X-Frame-Options: DENY is applied to every response (harmless on machine/API).
// - The human-only set (frame-ancestors CSP, Referrer-Policy, Permissions-Policy)
//   is applied ONLY to text/html responses.
// CORS (Access-Control-Allow-*), Cache-Control, ETag, Content-Type, status and
// redirect Location are never read or rewritten. Immutable-header Responses
// (redirects, static assets) NEVER throw — the mutation is best-effort.
export function applyTierASecurityHeaders(response: Response): Response {
    try {
        const h = response.headers;
        if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
        h.set('X-Frame-Options', 'DENY');
        if (isHumanHtmlResponse(h.get('content-type'))) {
            h.set('Content-Security-Policy', "frame-ancestors 'none'");
            h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
            h.set('Permissions-Policy', PERMISSIONS_POLICY_VALUE);
        }
    } catch {
        // Immutable headers (redirects / static assets) — leave the response as-is.
    }
    return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
    const startTime = performance.now();

    try {
        // V18.12.5: Global Resilience Wrap
        const response = await next();
        if (!response) throw new Error("Astro next() returned null response");

        // V23.10: Guard against immutable Response headers (e.g. Response.redirect())
        try {
            response.headers.set('X-Guardian-Time', `${(performance.now() - startTime).toFixed(2)}ms`);
            response.headers.set('X-Guardian-Version', 'v18.12.5-resilient');
        } catch {
            // Response has immutable headers (redirects, static assets) — return as-is
        }

        // GR-02 (D-184 §B): Tier-A live security headers, additive + immutable-safe.
        applyTierASecurityHeaders(response);

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
