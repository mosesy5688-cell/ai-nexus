/**
 * GET /api/v1/entity/:id — Single-entity detail lookup.
 *
 * Agent-first endpoint: search returns IDs; agents fetch full structured
 * metadata for one entity here (closes the search -> detail chain, P0-3).
 * Routing: per-candidate xxhash64Mod against partitions.meta_shards, probing
 * the highest-probability shard first (see buildEntityProbePlan), then
 * SELECT * WHERE id/slug/umid IN (candidate forms) LIMIT 1 per shard.
 * Projection: 60 raw columns -> ~30 Agent fields; omits internal storage fields
 * per feedback_no_architecture_exposure. ?include=body lazy-loads readme_html
 * from the .bin fused-shard (cold tier) via packet-loader.fetchBundleReadme.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../../constants/shard-constants.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../../lib/etag-helper.js';
import { buildEntityProbePlan } from '../../../../lib/slug-helper.js';
import { fetchBundleReadme } from '../../../../utils/packet-loader.js';
import { entityCanonicalUrl, cleanSourceUrl } from '../../../../utils/mesh-routing-core.js';
import { extractArxivIdFromKey } from '../../../../utils/entity-type-handlers.js';
import { sanitizeCitation } from '../../../../utils/text-sanitizer.js';
import { withOpTimeout, isOpTimeout } from '../../../../lib/op-timeout.js';

const API_VERSION = 'fni_v2.0';

// V27.93 (D2): wall-clock budget for the multi-shard cold-VFS probe loop.
// Mirrors the page resolver (vfs-metadata-provider FALLBACK_BUDGET_MS): an
// un-budgeted fan-out can chain many cold R2-VFS opens (19/31/88s observed)
// into CF's ~30s limit -> 524. Safe here only because buildEntityProbePlan
// orders highest-probability candidates first, so a real entity is reached
// before the budget is spent. Bailing on budget yields a retryable 503, never
// a hard 404 (honest-contract: a slow/transient miss is not "does not exist").
const PROBE_BUDGET_MS = 6000;

// Per-op timeout firewall. PROBE_BUDGET_MS above bounds the LOOP (between
// shards); this bounds a SINGLE cold op that hangs (a stalled R2 range read
// inside one connection-open or SQL step). The page resolver
// (vfs-metadata-provider OP_TIMEOUT_MS) already has this; the entity API had
// only the loop budget, so one hung op could consume the whole budget and
// surface as a 524. Must stay <= PROBE_BUDGET_MS so a single slow op cannot
// push past the total budget. On timeout the op is NOT cancelled (see
// op-timeout.ts header) — it finishes in the background, releases its own
// SQLite lock, and warms the cache for the retry. Matches the page path.
const OP_TIMEOUT_MS = 5000;

const CORS_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
};

function safeJsonParse(s: any, fallback: any = null) {
    if (s == null || s === '') return fallback;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return fallback; }
}

function parseTags(s: any): string[] {
    const v = safeJsonParse(s, null);
    if (Array.isArray(v)) return v.filter(t => typeof t === 'string');
    if (typeof s === 'string' && s) return s.split(',').map(t => t.trim()).filter(Boolean);
    return [];
}

function project(e: any) {
    // V27.A7 (R7): paper-only bare arxiv id (null otherwise); canonical = single landing URL reused by detail_url + canonical_url.
    const arxivId = e.type === 'paper' ? extractArxivIdFromKey(e.slug || e.id) : null;
    const canonical = entityCanonicalUrl(e);
    const entity: any = {
        id: e.id,
        slug: e.slug,
        type: e.type,
        arxiv_id: arxivId,
        name: e.name,
        author: e.author || null,
        source: e.source || null,
        summary: e.summary || null,

        category: e.category || null,
        tags: parseTags(e.tags),
        license: e.license || null,
        license_type: e.license_type || null,
        pipeline_tag: e.pipeline_tag || null,
        task_categories: parseTags(e.task_categories),
        primary_language: e.primary_language || null,

        fni: {
            score: e.fni_score ?? null,
            percentile: e.fni_percentile || null,
            factors: {
                // V27 sweep-1 (S honesty): fni_s is a constant baseline, not measured per-entity -> emit null + note so Agents do not ingest it as a measured score (honest-contract, mirrors V27.96).
                semantic: null,
                semantic_note: 'query-time baseline; scored live at search; not a per-entity value',
                authority: e.fni_a ?? null,
                popularity: e.fni_p ?? null,
                recency: e.fni_r ?? null,
                quality: e.fni_q ?? null,
            },
            is_trending: !!e.is_trending,
            trend_7d: safeJsonParse(e.trend_7d, e.trend_7d || null),
        },

        specs: {
            params_billions: e.params_billions ?? null,
            context_length: e.context_length ?? null,
            architecture: e.architecture || null,
            vocab_size: e.vocab_size ?? null,
            num_layers: e.num_layers ?? null,
            hidden_size: e.hidden_size ?? null,
            vram: {
                estimate_gb: e.vram_estimate_gb ?? null,
                fp16_gb: e.vram_fp16_gb ?? null,
                int8_gb: e.vram_int8_gb ?? null,
                int4_gb: e.vram_int4_gb ?? null,
            },
            ollama_compatible: e.ollama_compatible == null ? null : !!e.ollama_compatible,
            can_run_local: e.can_run_local == null ? null : !!e.can_run_local,
            hosted_on: safeJsonParse(e.hosted_on, e.hosted_on || null),
            runtime_hardware: e.runtime_hardware || null,
        },

        stats: {
            // V27.45: honest-contract -> null when not-measured, 0 only when explicitly zero (per llms.txt).
            downloads: e.downloads ?? null,
            stars: e.stars ?? null,
            forks: e.forks ?? null,
            citation_count: e.citation_count ?? null,
            num_rows: e.num_rows ?? null,
            last_modified: e.last_modified || null,
        },

        links: {
            // V27.A7 (R7): source_url S2->arxiv; canonical_url was the raw DB
            // column (/papers/<raw-id>, a 404 leaking the id) -> true canonical.
            source_url: cleanSourceUrl(e.source_url, arxivId),
            canonical_url: canonical,
            image_url: e.image_url || null,
            detail_url: canonical,
            badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(e.slug || e.id)}`,
        },

        relations: {
            datasets_used: parseTags(e.datasets_used),
            benchmarks: safeJsonParse(e.benchmarks, null),
            related: safeJsonParse(e.ui_related_mesh, []),
        },

        citation: sanitizeCitation(e.citation),
        quick_start: e.quick_start || null,
    };

    return entity;
}

export const GET: APIRoute = async ({ params, url, request }) => {
    const start = Date.now();
    const rawId = (params.id || '').trim();
    if (!rawId) return error(400, 'Missing required path parameter: id');

    const includeBody = url.searchParams.get('include')?.split(',').includes('body') || false;

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const manifest = await loadManifest(r2Bucket, isDev);
        const metaShards = Number(manifest?.partitions?.meta_shards) || META_SHARD_COUNT;

        // V27.22: ETag = manifest._etag + (id, include flag) — cross-cycle
        // invalidation handled by manifest bump; ?include=body has different
        // payload so it gets a different ETag bucket.
        const etag = buildEtag(manifest?._etag, rawId.toLowerCase(), includeBody ? 'body' : '');
        if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);

        // V27.93 (D1+D2): ordered, paper-aware candidate plan. buildEntityProbePlan
        // injects stored paper forms (arxiv--<id> / bare / unknown--<id>) for
        // arxiv-shaped ids so ~270K papers stop 404ing, and orders the most-
        // likely-correct forms first so the budget below never starves the
        // correct shard.
        const candidates = buildEntityProbePlan(rawId);

        // Per-candidate -> its OWN shard (packer shards by xxhash64(slug); a
        // single form lands on the wrong shard). Map preserves insertion order,
        // so the highest-probability shards are probed first. We bind only the
        // forms that hashed to each shard, matching the page-resolver pattern.
        const shardForms = new Map<number, string[]>();
        for (const c of candidates) {
            const idx = xxhash64Mod(c, metaShards);
            const arr = shardForms.get(idx);
            if (arr) arr.push(c); else shardForms.set(idx, [c]);
        }

        // Per-shard try/catch: a single shard error (transient VFS / SQL) must
        // not 500 the whole request if another shard might satisfy the lookup.
        // Track errors + budget-bail so a transient miss is not a false 404.
        let row: any = null;
        let probedShards = 0;
        let budgetBailed = false;
        const shardErrors: string[] = [];
        for (const [shardIdx, forms] of shardForms) {
            if (Date.now() - start > PROBE_BUDGET_MS) { budgetBailed = true; break; }
            probedShards++;
            const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
            const placeholders = forms.map(() => '?').join(',');
            const sql = `SELECT * FROM entities WHERE id IN (${placeholders}) OR slug IN (${placeholders}) OR umid IN (${placeholders}) LIMIT 1`;
            const bindings = [...forms, ...forms, ...forms];
            try {
                // Per-op firewall: a single hung cold open/SQL must not eat the
                // whole budget or hang past it (mirrors the page resolver).
                const engine = await withOpTimeout(
                    getCachedDbConnection(r2Bucket, isDev, dbName),
                    OP_TIMEOUT_MS, `open:${dbName}`);
                const rows = await withOpTimeout(
                    executeSql(engine.sqlite3, engine.db, sql, bindings),
                    OP_TIMEOUT_MS, `sql:${dbName}`);
                if (rows.length > 0) { row = rows[0]; break; }
            } catch (e: any) {
                console.warn(`[ENTITY] shard probe ${isOpTimeout(e) ? 'timeout' : 'error'}`, dbName, e.message);
                shardErrors.push(`${dbName}: ${e.message}`);
            }
        }

        if (!row) {
            // Honest-contract: 404 means "genuinely absent, do not retry" and is
            // only safe when every intended shard was probed cleanly with no row.
            // If we bailed on budget or any shard errored, the entity MAY exist
            // on an un-probed/errored shard -> retryable 503, never a false 404.
            if (budgetBailed || shardErrors.length > 0) {
                console.error('[ENTITY] inconclusive', rawId, `bailed=${budgetBailed} probed=${probedShards}/${shardForms.size}`, shardErrors.join('; '));
                // Honest retryable signal for Agent clients: explicit Retry-After
                // so a client retries (instead of hard-coding a fallback), and
                // no-store so this transient negative is never cached as truth.
                return error(503, 'Lookup inconclusive (transient/budget); retry later', {
                    'Retry-After': '2',
                    'Cache-Control': 'no-store',
                });
            }
            return error(404, `Entity not found: ${rawId}`);
        }

        const entity = project(row);
        if (includeBody) {
            if (row.bundle_key && row.bundle_size > 0) {
                try {
                    const bundleData = await fetchBundleReadme(row.bundle_key, row.bundle_offset, row.bundle_size);
                    entity.body = { readme_html: bundleData.readme, has_fulltext: !!row.has_fulltext };
                } catch (err: any) {
                    console.warn(`[entity] cold-tier readme fetch failed for ${row.id}:`, err?.message);
                    entity.body = { readme_html: null, has_fulltext: !!row.has_fulltext };
                }
            } else {
                entity.body = { readme_html: null, has_fulltext: !!row.has_fulltext };
            }
        }

        return new Response(JSON.stringify({
            version: API_VERSION,
            entity,
            meta: { elapsed_ms: Date.now() - start, etag: manifest?._etag || null, candidates_tried: candidates.length },
        }), { headers: { ...CORS_HEADERS, ETag: etag } });
    } catch (e: any) {
        console.error('[ENTITY]', rawId, e.message, e.stack);
        return error(500, 'Internal error');
    }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function error(status: number, message: string, extraHeaders: Record<string, string> = {}) {
    return new Response(JSON.stringify({ error: message }), { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}
