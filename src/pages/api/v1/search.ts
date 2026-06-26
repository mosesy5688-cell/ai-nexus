/**
 * V∞ Phase 1C: Free Public API — /api/v1/search
 * Wraps internal /api/search with versioned response format.
 * Zero auth (Phase 1 Pure Free), CDN cached, limit hard-capped at 20.
 * V27.60: 5→20 align with MCP search default; Layer 0 surface generosity.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { GET as internalSearch } from '../search.js';
import { loadManifest } from '../../../lib/sqlite-engine.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../lib/etag-helper.js';
// D-135 (F3): shared owner of the search-path Semantic-evidence semantics so the
// MCP search/rank dispatch and this REST v1 surface cannot drift.
import { normalizeSearchEvidence, EVIDENCE_CONTRACT_VERSION } from '../../../constants/evidence-contract.js';

const FREE_TIER_MAX = 20;
const API_VERSION = EVIDENCE_CONTRACT_VERSION;

export const GET: APIRoute = async (context) => {
    // Hard-cap limit for free tier
    const url = new URL(context.url.href);
    const rawLimit = parseInt(url.searchParams.get('limit') || '5');
    const cappedLimit = String(Math.min(Math.max(rawLimit, 1), FREE_TIER_MAX));
    url.searchParams.set('limit', cappedLimit);

    // V27.22: ETag check — load manifest (memory cached, ~free) so we can
    // build a stable ETag from (manifest._etag, q, type, capped limit) before
    // running the search. Skips internal search entirely on 304 hits.
    const r2Bucket = (env as any)?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;
    const manifest = await loadManifest(r2Bucket, isDev).catch(() => null);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const type = url.searchParams.get('type') || 'all';
    const etag = buildEtag(manifest?._etag, q, type, cappedLimit);

    // CORS + cache headers baseline for both 304 and 200 responses.
    const BASE_HEADERS: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=3600',
        'Access-Control-Allow-Origin': '*',
    };
    if (matchesIfNoneMatch(context.request, etag)) return notModified(etag, BASE_HEADERS);

    // Call internal search with capped params
    const internal = await internalSearch({ ...context, url });

    // B8: a transient 503 (cold-path / fallback budget) passes through UNCHANGED —
    // its honest envelope (transient/reason + Retry-After + Cache-Control: no-store)
    // must reach the client verbatim. Never layer an ETag (would invite a cached
    // 304) or the version wrapper onto a no-store transient.
    if (internal.status === 503) return internal;

    const body = await internal.json();

    // Strip internal fields + wrap with version
    if (body.results) body.results.forEach((r: any) => {
        delete r._dbSort; delete r._score; delete r._source;
        // Contract remediation (D3): fni_s in browse mode is a constant factory
        // baseline (50), not a per-entity measurement, and live semantic/ANN
        // ranking is not currently provided. Null it + carry a note so Agents do
        // not ingest a bare 50.0 as measured relevance (mirrors select/compare/
        // entity honest-contract). No live UI consumer reads fni_s from /api/v1.
        // D-135 (F3): wording now lives in the shared evidence-contract owner so
        // the MCP search/rank dispatch applies the SAME caveat (no divergent copy).
        normalizeSearchEvidence(r);
    });
    const wrapped = { version: API_VERSION, ...body };

    // Preserve original headers (internal cache + CORS) then layer ETag on top
    const headers = new Headers(internal.headers);
    headers.set('ETag', etag);
    return new Response(JSON.stringify(wrapped), { status: internal.status, headers });
};
