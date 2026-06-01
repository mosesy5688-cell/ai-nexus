/**
 * GET /api/v1/entity/:id — Single-entity detail lookup.
 *
 * Agent-first endpoint: search returns IDs, agents need a way to fetch the
 * full structured metadata for one entity without scraping the HTML detail
 * page. Closes the search -> detail chain that was previously broken (P0-3
 * in the 2026-05-16 Agent-perspective audit).
 *
 * Routing: same shard derivation as compare.ts / badge.ts — xxhash64Mod of
 * (id, slug, umid) candidates against partitions.meta_shards from manifest.
 * Query: SELECT * WHERE id = ? OR slug = ? OR umid = ? LIMIT 1.
 *
 * Response projection: 60 raw entity columns -> ~30 Agent-relevant fields,
 * grouped into identity / classification / fni / specs / stats / links /
 * relations. Omits internal storage fields (bundle_key/offset/size,
 * search_vector, readme_html) per feedback_no_architecture_exposure.
 *
 * Optional ?include=body lazy-loads readme_html from the .bin fused-shard
 * (cold tier) via packet-loader.fetchBundleReadme — the SQL row only stores
 * bundle pointers, not the full HTML, to keep meta-NN.db slots small.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../../constants/shard-constants.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../../lib/etag-helper.js';
import { buildEntityProbePlan } from '../../../../lib/slug-helper.js';
import { fetchBundleReadme } from '../../../../utils/packet-loader.js';

const API_VERSION = 'fni_v2.0';

// V27.93 (D2): wall-clock budget for the multi-shard cold-VFS probe loop.
// Mirrors the page resolver (vfs-metadata-provider FALLBACK_BUDGET_MS): an
// un-budgeted fan-out can chain many cold R2-VFS opens (19/31/88s observed)
// into CF's ~30s limit -> 524. Safe here only because buildEntityProbePlan
// orders highest-probability candidates first, so a real entity is reached
// before the budget is spent. Bailing on budget yields a retryable 503, never
// a hard 404 (honest-contract: a slow/transient miss is not "does not exist").
const PROBE_BUDGET_MS = 6000;

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
    const entity: any = {
        id: e.id,
        slug: e.slug,
        type: e.type,
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
                semantic: e.fni_s ?? null,
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
            // V27.45: honest-contract — null when not-measured, 0 only when explicitly zero.
            // Per llms.txt: '0 means measured-zero, null means not-measured'.
            downloads: e.downloads ?? null,
            stars: e.stars ?? null,
            forks: e.forks ?? null,
            citation_count: e.citation_count ?? null,
            num_rows: e.num_rows ?? null,
            last_modified: e.last_modified || null,
        },

        links: {
            source_url: e.source_url || null,
            canonical_url: e.canonical_url || null,
            image_url: e.image_url || null,
            detail_url: `https://free2aitools.com/${e.type || 'model'}/${e.slug || e.id}`,
            badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(e.slug || e.id)}`,
        },

        relations: {
            datasets_used: parseTags(e.datasets_used),
            benchmarks: safeJsonParse(e.benchmarks, null),
            related: safeJsonParse(e.ui_related_mesh, []),
        },

        citation: e.citation || null,
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
                const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
                const rows = await executeSql(engine.sqlite3, engine.db, sql, bindings);
                if (rows.length > 0) { row = rows[0]; break; }
            } catch (e: any) {
                console.warn('[ENTITY] shard probe error', dbName, e.message);
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
                return error(503, 'Lookup inconclusive (transient/budget); retry later');
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

function error(status: number, message: string) {
    return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
