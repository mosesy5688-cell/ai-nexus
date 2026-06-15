import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { emit, isEnabled } from "./lib/telemetry/ae-adapter";
import { buildRestEvent } from "./lib/telemetry/request-classifier";

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

// P2 Adoption Telemetry (TA2). Per D-53 O-5: telemetry runs AFTER the Guardian
// header calc, BEFORE returning the response; ALWAYS inside an isolated swallow
// block so it can never fail/slow/alter the serve path; reads response.status
// ONLY (no body/stream/clone, no header mutation); emits AT MOST ONCE. Routes
// /api/mcp + /api/v1/datasets are route-owned (EXCLUDED here, O-2). The binding
// token is NEVER named here -- the whole env is passed to emit(), which is the
// only module that dereferences the binding.
function recordTelemetry(pathname: string, method: string, headers: Headers, ownHost: string | null, status: number): void {
    try {
        if (!isEnabled(env)) return;                 // default-OFF short-circuit (no classification work)
        if (pathname === '/api/mcp' || pathname.startsWith('/api/v1/datasets')) return; // route-owned (O-2)
        const refererHeader = headers.get('referer');
        let refererHost: string | null = null;
        if (refererHeader) { try { refererHost = new URL(refererHeader).hostname; } catch { refererHost = null; } }
        const event = buildRestEvent({
            method,
            pathname,
            uaString: headers.get('user-agent'),
            refererHost,
            ownHost,
            status,
            now: new Date(),
        });
        if (event) emit(env, event);                 // at most once (null event -> no emit)
    } catch {
        // Telemetry must never throw into / delay / alter the serve path (D-53 O-5).
    }
}

export const onRequest = defineMiddleware(async (context, next) => {
    const startTime = performance.now();
    const reqMethod = context.request.method;
    const reqHeaders = context.request.headers;
    const ownHost = context.url.hostname;
    const reqPath = context.url.pathname;

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

        // P2 telemetry (normal path): classify from the FINAL response status,
        // emit at most once, return the SAME response object unchanged.
        recordTelemetry(reqPath, reqMethod, reqHeaders, ownHost, response.status);

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
            const apiError = new Response(
                JSON.stringify({ error: 'Resilience Triggered: SSR Crash', reason: e.message }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
            // Telemetry on the FINAL error Response (an allowed API surface gets 5xx).
            recordTelemetry(reqPath, reqMethod, reqHeaders, ownHost, apiError.status);
            return apiError;
        }

        // Prevent recursive redirection if we're already on 404
        if (context.url.pathname === '/404') {
            const crash = new Response("Critical System Failure: 404 Rendering Crashed", { status: 500 });
            // /404 has no allowed surface -> classifier drops it (no emit), but the
            // call stays symmetric so the exactly-once XOR is structurally provable.
            recordTelemetry(reqPath, reqMethod, reqHeaders, ownHost, crash.status);
            return crash;
        }

        // Human SSR-crash redirect: the /404 target has no allowed surface -> no emit.
        recordTelemetry(reqPath, reqMethod, reqHeaders, ownHost, 302);
        return context.redirect(errorUrl.toString());
    }
});
