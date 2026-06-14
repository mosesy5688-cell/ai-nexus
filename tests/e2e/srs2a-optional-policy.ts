/**
 * SRS-2A — EXPLICIT optional-resource policy (Founder-exact, SRS2-HARNESS-2).
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
