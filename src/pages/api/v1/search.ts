/**
 * V∞ Phase 1C: Free Public API — /api/v1/search
 * Wraps internal /api/search with versioned response format.
 * Zero auth (Phase 3), CDN cached, limit hard-capped at 5.
 */
import type { APIRoute } from 'astro';
import { GET as internalSearch } from '../search.js';

const FREE_TIER_MAX = 5;
const API_VERSION = 'fni_v2.0';

export const GET: APIRoute = async (context) => {
    // Hard-cap limit for free tier
    const url = new URL(context.url.href);
    const rawLimit = parseInt(url.searchParams.get('limit') || '5');
    url.searchParams.set('limit', String(Math.min(Math.max(rawLimit, 1), FREE_TIER_MAX)));

    // Call internal search with capped params
    const internal = await internalSearch({ ...context, url });
    const body = await internal.json();

    // Strip internal fields + wrap with version
    if (body.results) body.results.forEach((r: any) => { delete r._dbSort; delete r._score; delete r._source; });
    const wrapped = { version: API_VERSION, ...body };

    // Preserve original headers (cache + CORS)
    const headers = new Headers(internal.headers);
    return new Response(JSON.stringify(wrapped), { status: internal.status, headers });
};
