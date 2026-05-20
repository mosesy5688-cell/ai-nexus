/**
 * Phase 0.5a — Trend data SSR helper.
 *
 * Reads `cache/trend-data.json.zst` from R2 via the worker binding (NOT the
 * public CDN), decompresses with fzstd, parses, and caches the resulting
 * Map in module scope with a 5-minute TTL. Mirrors the cache pattern from
 * sqlite-engine.loadManifest so each isolate pays the decode cost at most
 * once per 5 min.
 *
 * Schema (from scripts/factory/lib/trend-data-generator.js:56-62):
 *   trendData[id] = { scores: number[<=7], dates: string[<=7],
 *                     change7d: number, direction: 'up'|'down'|'stable',
 *                     latest: number }
 *
 * Phase 0.5b will move callers off the public CDN bulk file onto either:
 *   (a) SSR injection — list pages call getTrendsForIds() and pass the
 *       7-day scores into MiniTrendChart's initialData prop, OR
 *   (b) Client fallback via /api/v1/trends/batch (this helper's HTTP wrapper).
 */

const TREND_OBJECT_KEY = 'cache/trend-data.json.zst';
const TTL_MS = 5 * 60 * 1000;
const CDN_FALLBACK = 'https://cdn.free2aitools.com/cache/trend-data.json.zst';

let cachedIndex = null; // Object keyed by entity id → trend entry, or null
let cachedAt = 0;

async function decompressZst(bytes) {
    const { decompress } = await import('fzstd');
    return decompress(new Uint8Array(bytes));
}

/**
 * Returns the parsed trend index, or null if R2/CDN fetch failed.
 * Cached per isolate with a 5-minute TTL.
 */
export async function loadTrendIndex(r2Bucket, isDev) {
    if (cachedIndex !== null && (Date.now() - cachedAt) < TTL_MS) return cachedIndex;
    try {
        let bytes;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(TREND_OBJECT_KEY);
            if (!obj) throw new Error('trend-data object missing in R2');
            bytes = await obj.arrayBuffer();
        } else {
            const res = await fetch(CDN_FALLBACK);
            if (!res.ok) throw new Error(`CDN fetch ${res.status}`);
            bytes = await res.arrayBuffer();
        }
        const decoded = await decompressZst(bytes);
        const json = new TextDecoder().decode(decoded);
        cachedIndex = JSON.parse(json);
        cachedAt = Date.now();
        return cachedIndex;
    } catch (e) {
        console.warn('[trend-fetcher] loadTrendIndex failed:', e?.message || e);
        // Cache the null briefly to avoid hammering R2 on persistent failure.
        cachedAt = Date.now();
        cachedIndex = null;
        return null;
    }
}

/**
 * Look up trend entries for the given ids. Missing ids are simply absent
 * from the returned Map (no error thrown). Caller can compute missing[]
 * by diffing input vs result keys.
 *
 * Lookup is exact-match by id string — the trend-data-generator keys by
 * the same `id` field that meta DBs use, so list/detail pages can pass
 * the entity.id they already have without normalization.
 */
export async function getTrendsForIds(ids, r2Bucket, isDev) {
    const out = new Map();
    if (!Array.isArray(ids) || ids.length === 0) return out;
    const index = await loadTrendIndex(r2Bucket, isDev);
    if (!index) return out;
    for (const id of ids) {
        const entry = index[id];
        if (entry) out.set(id, entry);
    }
    return out;
}
