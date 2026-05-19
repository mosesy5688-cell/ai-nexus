/**
 * Strong ETag + If-None-Match + 304 helper for /api/v1/* endpoints.
 *
 * Pattern: ETag = `"<manifestEtag>-<resourceHash>"`
 *   - manifestEtag bumps every cron R2 upload (cross-cycle invalidation, no
 *     manual cache busting needed; old ETags auto-expire when new manifest lands)
 *   - resourceHash discriminates between resources within a single cycle
 *     (entity id / sorted compare ids / search query tuple)
 *
 * Why no Web Crypto / SHA-256:
 *   ETags don't need cryptographic strength — they just need stable bucketing
 *   per (manifestEtag, resource). djb2 is sync, tiny, and sufficient.
 *
 * Usage:
 *   const etag = buildEtag(manifest?._etag, normalizedKey);
 *   if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);
 *   // ... build full response ...
 *   return new Response(body, { headers: { ...CORS_HEADERS, ETag: etag } });
 */

/** Tiny non-crypto hash for stable bucketing of resource parts. */
function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

/**
 * Build a strong ETag from manifest._etag and resource-identifying parts.
 * Parts are joined with `|` after empty-filtering so the same logical resource
 * produces the same ETag regardless of trailing nulls/empties.
 */
export function buildEtag(manifestEtag: string | null | undefined, ...parts: string[]): string {
    const m = (manifestEtag || 'unknown').replace(/"/g, '');
    const r = parts.filter(Boolean).join('|');
    return `"${m}-${djb2(r)}"`;
}

/**
 * Returns true if the request's If-None-Match matches our ETag exactly,
 * or the client sent the wildcard `*` (RFC 7232 §3.2).
 *
 * We only emit strong ETags, so weak-match (W/"...") is not handled — a client
 * sending W/"x" would not match `"x"` by this function, which is the strictest
 * safe behavior (false negative = serve full body, no correctness risk).
 */
export function matchesIfNoneMatch(request: Request, etag: string): boolean {
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (!ifNoneMatch) return false;
    if (ifNoneMatch === '*') return true;
    // Multi-value support: "etag1, etag2" — split + trim
    const candidates = ifNoneMatch.split(',').map(s => s.trim());
    return candidates.includes(etag);
}

/**
 * Build a 304 Not Modified response. RFC 7232 §4.1 requires no message body
 * and the same caching headers (ETag, Cache-Control, etc.) the 200 would have
 * carried, so the client can refresh its cache TTL without re-downloading.
 */
export function notModified(etag: string, headers: Record<string, string>): Response {
    return new Response(null, {
        status: 304,
        headers: { ...headers, ETag: etag },
    });
}
