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
 * Optional ?include=body adds readme_html (can be up to 250KB per entity);
 * default omits it to keep Agent calls lean.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../../constants/shard-constants.js';

const API_VERSION = 'fni_v2.0';

const CORS_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
};

const SLUG_PREFIXES = [
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'arxiv-paper', 'arxiv', 'paper',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model', 'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt',
];

function deriveSlug(id: string): string {
    let r = (id || '').toLowerCase();
    for (const p of SLUG_PREFIXES) {
        if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
            r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1));
            break;
        }
    }
    return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}

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

function project(e: any, includeBody: boolean) {
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
            downloads: e.downloads ?? 0,
            stars: e.stars ?? 0,
            forks: e.forks ?? 0,
            citation_count: e.citation_count ?? 0,
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

    if (includeBody) {
        entity.body = {
            readme_html: e.readme_html || null,
            has_fulltext: !!e.has_fulltext,
        };
    }

    return entity;
}

export const GET: APIRoute = async ({ params, url }) => {
    const start = Date.now();
    const rawId = (params.id || '').trim();
    if (!rawId) return error(400, 'Missing required path parameter: id');

    const includeBody = url.searchParams.get('include')?.split(',').includes('body') || false;

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const manifest = await loadManifest(r2Bucket, isDev);
        const metaShards = Number(manifest?.partitions?.meta_shards) || META_SHARD_COUNT;

        // Pack-db routes by slug || id, so probe both shards (typically 1-2).
        const idLower = rawId.toLowerCase();
        const slug = deriveSlug(rawId);
        const shardsToProbe = new Set<number>();
        shardsToProbe.add(xxhash64Mod(idLower, metaShards));
        shardsToProbe.add(xxhash64Mod(slug, metaShards));

        const keys = [idLower, slug, rawId];
        let row: any = null;
        for (const shardIdx of shardsToProbe) {
            const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
            const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
            const rows = await executeSql(engine.sqlite3, engine.db,
                'SELECT * FROM entities WHERE id = ? OR slug = ? OR umid = ? OR id = ? LIMIT 1',
                [keys[0], keys[1], keys[2], keys[2]]);
            if (rows.length > 0) { row = rows[0]; break; }
        }

        if (!row) return error(404, `Entity not found: ${rawId}`);

        return new Response(JSON.stringify({
            version: API_VERSION,
            entity: project(row, includeBody),
            meta: { elapsed_ms: Date.now() - start, etag: manifest?._etag || null },
        }), { headers: CORS_HEADERS });
    } catch (e: any) {
        console.error('[ENTITY]', rawId, e.message, e.stack);
        return error(500, 'Internal error');
    }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function error(status: number, message: string) {
    return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
