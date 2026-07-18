/**
 * GET /api/v1/_health — runtime observability endpoint (V27.9).
 *
 * Per-isolate counters from the R2 VFS layer + Node runtime info.
 * Cloudflare isolates have independent state, so each call returns
 * the metrics from the isolate that handled the request — useful
 * for spot-checking during incidents, not for global aggregation
 * (Durable Object / KV would be needed for that).
 *
 * Counters tracked (since isolate boot):
 *   jread_total          — total VFS reads attempted
 *   jread_errors         — errors caught at jRead catch (any throw)
 *   short_read_attempts  — times the L2 retry path saw a size mismatch
 *   short_read_recovered — short reads that succeeded after >=1 retry
 *   short_read_exhausted — short reads that failed all 3 attempts
 *   l0_hits              — chunks served from in-memory L0 cache
 *   l1_hits              — chunks served from Cloudflare Cache API
 *   l2_fetches           — chunks fetched from R2 origin (or CDN fallback)
 *   l0_size              — current L0 entry count (max MAX_L0_CHUNKS)
 *   isolate_uptime_ms    — time since this isolate started serving
 *
 * Hit ratio derivations (computed client-side as needed):
 *   l0_hit_ratio = l0_hits / jread_total
 *   l1_hit_ratio = l1_hits / (jread_total - l0_hits)
 *   short_read_rate = short_read_attempts / l2_fetches
 *
 * Response is intentionally minimal — no auth, no rate limit, CDN
 * does not cache (`Cache-Control: no-store`). Caller should treat
 * the numbers as a snapshot, not a continuous metric.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getVfsHealth } from '../../../lib/r2-vfs.js';
import { loadManifest } from '../../../lib/sqlite-engine.js';
import { PHASE1_READER_MODE } from '../../../lib/published-pointer.js';

const HEALTH_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

const API_VERSION = 'fni_v2.0';

export const GET: APIRoute = async () => {
    const start = Date.now();
    let vfs: any = null;
    try {
        vfs = getVfsHealth();
    } catch (e: any) {
        // VFS module may not be initialized in some isolates (no prior search call).
        // Return null for vfs in that case so the endpoint still serves the rest.
        vfs = { error: e?.message || 'vfs_not_initialized' };
    }

    // P1b (D-2026-0717-345): external freshness/coherence signal. Sourced ONLY
    // from the already-loaded shards manifest (small JSON, memory-cached ~free).
    // This MUST stay cheap: it does NOT force-load the ~26MB id-index.bin — the
    // index<->manifest build_id comparison is done externally by the reliability
    // probe via a public Range read of the index header, never by Health.
    const r2Bucket = (env as any)?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;
    // FENCE (D-350): resolve in legacy_only (never GETs data/current.json). The
    // returned CyclePin drives BOTH the existing freshness fields and the R5
    // reader block below — a SINGLE loadManifest call, no id-index force-load.
    const manifest = await loadManifest(r2Bucket, isDev, PHASE1_READER_MODE).catch(() => null);
    const manifest_state: 'loaded' | 'fallback' | 'unavailable' = !manifest
        ? 'unavailable'
        : manifest._etag === 'fallback' ? 'fallback' : 'loaded';

    const body = {
        version: API_VERSION,
        status: 'ok',
        timestamp: new Date().toISOString(),
        served_build_id: manifest?.build_id ?? null,
        manifest_etag: manifest?._etag ?? null,
        manifest_state,
        // R5 Phase-1 reader substrate signal. Deliberately publication metadata
        // ONLY — reader_mode / publication_source / build_id / generation. NO raw
        // request counts, user traffic, or adoption/KPI (any path-selection counter
        // stays internal). generation is null in legacy_only.
        reader: {
            reader_mode: PHASE1_READER_MODE,
            publication_source: manifest?.source ?? null,
            build_id: manifest?.build_id ?? null,
            generation: manifest?.generation ?? null,
        },
        vfs,
        runtime: {
            node_compat: typeof process !== 'undefined' && !!process.version,
            now_ms: Date.now(),
        },
        meta: {
            elapsed_ms: Date.now() - start,
            isolate_random_id: globalThis.crypto?.randomUUID
                ? globalThis.crypto.randomUUID().slice(0, 8)
                : 'unavailable',
        },
    };

    return new Response(JSON.stringify(body, null, 2), { headers: HEALTH_HEADERS });
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: HEALTH_HEADERS });
