/**
 * Phase 0.5a — GET /api/v1/trends/batch?ids=a,b,c
 *
 * Returns 7-day FNI trend (scores + dates + change% + direction + latest) for
 * up to 50 entities in one call. Backs the future Phase 0.5b migration off the
 * public CDN bulk file `cache/trend-data.json.zst`:
 *   - SSR-injection callers can pass the result into MiniTrendChart's
 *     `initialData` prop (no client fetch at all).
 *   - Client-fallback callers (MiniTrendChart's CDN path replacement) hit
 *     this endpoint with a single id or a small batch.
 *
 * Pattern modeled on src/pages/api/v1/compare.ts: same ETag (manifest._etag +
 * sorted lower-cased ids), same Cache-Control, same error envelope. ids sorted
 * for ETag normalization so `?ids=a,b` and `?ids=b,a` share the cache key.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { loadManifest } from '../../../../lib/sqlite-engine.js';
import { getTrendsForIds } from '../../../../utils/trend-fetcher.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../../lib/etag-helper.js';

const API_VERSION = 'fni_v2.0';
const MAX_IDS = 50;

const CORS_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
};

export const GET: APIRoute = async ({ url, request }) => {
    const start = Date.now();
    const idsParam = url.searchParams.get('ids');
    if (!idsParam) return errorResponse(400, 'Missing required parameter: ids');

    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return errorResponse(400, 'At least 1 id required');
    if (ids.length > MAX_IDS) return errorResponse(400, `Maximum ${MAX_IDS} ids allowed`);

    try {
        const r2Bucket = (env as any)?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const manifest = await loadManifest(r2Bucket, isDev);

        const sortedIds = [...ids].map(s => s.toLowerCase()).sort().join(',');
        const etag = buildEtag(manifest?._etag, sortedIds);
        if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);

        const trendsMap = await getTrendsForIds(ids, r2Bucket, isDev);
        const trends: Record<string, any> = {};
        const missing: string[] = [];
        for (const id of ids) {
            const entry = trendsMap.get(id);
            if (entry) trends[id] = entry;
            else missing.push(id);
        }

        const body = {
            version: API_VERSION,
            trends,
            missing,
            meta: { elapsed_ms: Date.now() - start, found: Object.keys(trends).length, requested: ids.length },
        };
        return new Response(JSON.stringify(body), { headers: { ...CORS_HEADERS, ETag: etag } });
    } catch (e: any) {
        console.error('[trends/batch]', e?.message || e);
        return errorResponse(500, 'Internal error');
    }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function errorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
