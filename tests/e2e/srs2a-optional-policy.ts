/**
 * SRS-2A — EXPLICIT optional-resource policy (Founder-exact, SRS2-HARNESS-3).
 *
 * Third-party identity does NOT, by itself, make a failed request ignorable.
 * A request may be downgraded to NONCRITICAL_NETWORK_WARNING ONLY when it is a
 * KNOWN-OPTIONAL service (analytics / telemetry / non-essential prefetch) AND it
 * is not a document/navigation or a page-required script/style/font/data fetch.
 * This is an ALLOWLIST of known-optional hosts/paths, NOT "non-same-origin =>
 * ignore". When in doubt the resource stays CRITICAL (-> SEVERE upstream).
 *
 * jsdelivr / github / huggingface are intentionally NOT host-allowlisted: they
 * commonly host critical runtime libs or data/API dependencies. They are
 * optional only when the SPECIFIC path is provably non-critical (see
 * OPTIONAL_PATHS), never by host identity alone.
 *
 * SRS2-HARNESS-3 (optional-telemetry classification ORDER): the previous order
 * short-circuited on `PAGE_REQUIRED_TYPES` (which lists xhr/fetch) BEFORE the
 * telemetry-host check, so a Cloudflare Insights `POST /cdn-cgi/rum` beacon
 * (resourceType=xhr) was mis-scored SEVERE. The fix introduces an EXACT
 * telemetry SIGNATURE — a host+path(+method) tuple, NOT a host-only allowlist
 * and NEVER a broad "third-party xhr" downgrade — that the classifier checks
 * BEFORE the generic xhr/fetch page-required severity rule. A beacon-class xhr
 * is recognised ONLY on an exact signature match; else it falls through to the
 * unchanged conservative classification (when in doubt SEVERE).
 */

/** Resource types that can NEVER be optional (page-required to render/run). */
const PAGE_REQUIRED_TYPES = new Set([
    'document',
    'script',
    'stylesheet',
    'font',
    'fetch',
    'xhr',
]);

/**
 * Hosts whose traffic is, by purpose, analytics/telemetry/beacon — failure does
 * not impair the page. Matched against the request URL's hostname (suffix-safe).
 */
const OPTIONAL_HOSTS = [
    'googletagmanager.com',
    'google-analytics.com',
    'analytics.google.com',
    'static.cloudflareinsights.com',
    'cloudflareinsights.com',
    'plausible.io',
    'clarity.ms',
    'stats.g.doubleclick.net',
];

/**
 * Path fragments that are provably non-critical EVEN on otherwise-critical hosts
 * (e.g. an avatar image or an external link prefetch). A path match alone is not
 * enough: the resourceType must also be non-page-required (enforced in
 * isKnownOptional). Avatars/prefetch are the only sanctioned cases.
 */
const OPTIONAL_PATHS = [
    /\/avatars?\//i,
    /\/rum(\?|$|\/)/i, // Real-User-Monitoring beacon (cf-rum / analytics)
    /\/cdn-cgi\/(rum|speculation|challenge-platform)/i,
];

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function hostMatches(host: string, suffix: string): boolean {
    return host === suffix || host.endsWith('.' + suffix);
}

/**
 * True iff this failed request is a KNOWN-OPTIONAL resource that may be
 * downgraded. Requires BOTH: (a) the resourceType is NOT page-required, AND
 * (b) the host is an allowlisted telemetry host OR the path is an explicitly
 * sanctioned non-critical path (avatar / RUM beacon). Anything else -> false
 * (stays critical -> SEVERE). Returns a reason for the artifact.
 */
export function isKnownOptional(
    url: string,
    resourceType: string,
): { optional: boolean; reason: string } {
    // A page-required resource type is NEVER optional, regardless of host/path.
    if (PAGE_REQUIRED_TYPES.has(resourceType)) {
        return { optional: false, reason: `page-required resourceType=${resourceType} (not downgradable)` };
    }
    const host = hostnameOf(url);
    for (const h of OPTIONAL_HOSTS) {
        if (hostMatches(host, h)) {
            return { optional: true, reason: `known-optional telemetry host ${host}` };
        }
    }
    for (const p of OPTIONAL_PATHS) {
        if (p.test(url)) {
            return { optional: true, reason: `sanctioned non-critical path ${url}` };
        }
    }
    // jsdelivr/github/huggingface and any other third-party fall through here:
    // optional ONLY by specific path above, never by host identity.
    return { optional: false, reason: `not on optional allowlist (host=${host || 'unparseable'}, type=${resourceType}) -> critical` };
}

/** Run-level co-occurrence context (SRS2-HARNESS-3): a pageerror/hydration
 *  failure on the same page vetoes any telemetry downgrade. Absent => no veto. */
export interface FailureContext {
    pageErrored?: boolean;
    hydrationFailed?: boolean;
}

/** Resource types a telemetry BEACON may legitimately use. A signature match is
 *  still required; this only narrows what a beacon is allowed to look like. */
const BEACON_TYPES = new Set(['xhr', 'fetch', 'beacon']);

function pathnameOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return '';
    }
}

/**
 * EXACT optional-telemetry signatures (SRS2-HARNESS-3 first batch — ONLY these).
 * A signature is a host + path (+ method) tuple, NOT a host-only allowlist. The
 * request must be cross-origin (sameOrigin === false): a SAME-ORIGIN xhr to one
 * of these paths is NOT a third-party beacon and never matches here.
 *
 *  - Cloudflare Insights RUM: host == cloudflareinsights.com (or subdomain) AND
 *    path == /cdn-cgi/rum AND method == POST AND type in {xhr, fetch, beacon}.
 *  - Google Analytics (beacon endpoints ONLY): host == www.google-analytics.com
 *    OR region*.google-analytics.com ; path == /collect OR /g/collect ;
 *    method in {POST, GET} ; type in {xhr, fetch, beacon}.
 *
 * googletagmanager.com SCRIPT loads are deliberately NOT a signature here — a
 * script is page-required, not a beacon, and stays SEVERE on failure.
 */
const TELEMETRY_SIGNATURES: Array<{
    name: string;
    host: (h: string) => boolean;
    path: (p: string) => boolean;
    method: (m: string) => boolean;
}> = [
    {
        name: 'cloudflare-insights-rum',
        host: (h) => hostMatches(h, 'cloudflareinsights.com'),
        path: (p) => p === '/cdn-cgi/rum',
        method: (m) => m === 'POST',
    },
    {
        name: 'google-analytics-collect',
        host: (h) => h === 'www.google-analytics.com'
            || /^region\d*\.google-analytics\.com$/.test(h)
            || h === 'google-analytics.com',
        path: (p) => p === '/collect' || p === '/g/collect',
        method: (m) => m === 'POST' || m === 'GET',
    },
];

/**
 * True iff the request EXACTLY matches a first-batch telemetry signature
 * (cross-origin beacon-class xhr/fetch to a known telemetry host+path+method).
 * This is the ONLY sanctioned way an xhr/fetch may be treated as optional; it
 * is intentionally narrow and never downgrades a broad "third-party xhr".
 */
export function isExactTelemetrySignature(
    url: string,
    resourceType: string,
    method: string,
    sameOrigin: boolean,
): { match: boolean; reason: string } {
    if (sameOrigin) {
        return { match: false, reason: `same-origin ${resourceType} is not a third-party telemetry beacon` };
    }
    if (!BEACON_TYPES.has(resourceType)) {
        return { match: false, reason: `resourceType=${resourceType} is not a beacon class (xhr/fetch/beacon)` };
    }
    const host = hostnameOf(url);
    const path = pathnameOf(url);
    const m = (method || '').toUpperCase();
    for (const sig of TELEMETRY_SIGNATURES) {
        if (sig.host(host) && sig.path(path) && sig.method(m)) {
            return { match: true, reason: `exact telemetry signature ${sig.name} (${host}${path} ${m})` };
        }
    }
    return { match: false, reason: `no exact telemetry signature (host=${host || 'unparseable'}, path=${path}, method=${m})` };
}

/**
 * SRS2-HARNESS-4 (CORS-policy console correlation): the SAME RUM request yields a
 * `requestfailed` AND a separate `console.error` whose URL is embedded in the
 * message TEXT (a different shape than net::ERR_FAILED). Known CORS blocked shapes
 * (case-insensitive, single-quoted URL): "Access to XMLHttpRequest at '...'",
 * "Access to fetch at '...'", "Access to resource at '...'". EXACT-MATCH ONLY:
 * never broadens CORS handling beyond the exact-signature telemetry case; a
 * "CORS"/"third-party" label is NOT itself a downgrade reason.
 */
const CORS_URL_PATTERNS: RegExp[] = [
    /Access to XMLHttpRequest at '([^']+)'/i,
    /Access to fetch at '([^']+)'/i,
    /Access to resource at '([^']+)'/i,
];

/** Extract the URL embedded in a known CORS console.error text shape, or null
 *  when no sanctioned pattern matches (no URL -> caller stays SEVERE). */
export function extractCorsUrl(text: string): string | null {
    for (const p of CORS_URL_PATTERNS) {
        const m = p.exec(text);
        if (m && m[1]) {
            try { return new URL(m[1]).toString(); } catch { return null; }
        }
    }
    return null;
}

/** True iff the text is a recognised CORS-policy blocked-request message. */
export function isCorsConsoleText(text: string): boolean {
    return /blocked by CORS policy/i.test(text) || CORS_URL_PATTERNS.some((p) => p.test(text));
}

export interface CorsVerdict {
    url: string | null; matched: boolean; sigReason: string; downgrade: boolean; reason: string;
}

/**
 * SRS2-HARNESS-4 verdict for a CORS console.error. The extracted URL is re-run
 * through the EXACT telemetry signature using the SAME beacon context the RUM
 * request uses (cross-origin POST xhr); a downgrade requires a real signature
 * match AND no co-occurring pageerror/hydration. Returns the extracted URL, the
 * match result, and the verdict so raw text + URL + match are ALL preservable.
 * Never downgrades by the "CORS"/"third-party" label.
 */
export function classifyCorsConsole(text: string, ctx: FailureContext = {}): CorsVerdict {
    const url = extractCorsUrl(text);
    if (!url) {
        return { url: null, matched: false, sigReason: 'no extractable URL', downgrade: false, reason: 'CORS console.error with NO extractable URL -> uncorrelated (SEVERE)' };
    }
    const sig = isExactTelemetrySignature(url, 'xhr', 'POST', false);
    if (!sig.match) {
        return { url, matched: false, sigReason: sig.reason, downgrade: false, reason: `CORS URL ${url} does NOT match an exact telemetry signature (${sig.reason}) -> SEVERE` };
    }
    if (ctx.pageErrored || ctx.hydrationFailed) {
        const co = ctx.pageErrored ? 'pageerror' : 'hydration failure';
        return { url, matched: true, sigReason: sig.reason, downgrade: false, reason: `CORS ${sig.reason} BUT co-occurs with ${co} -> SEVERE` };
    }
    return { url, matched: true, sigReason: sig.reason, downgrade: true, reason: `CORS beacon ${sig.reason}; raw text + extracted URL + match preserved` };
}
