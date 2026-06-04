/**
 * Entity projection for GET /api/v1/entity/:id.
 *
 * Maps a raw ~60-column entities row to the ~30-field Agent-facing shape,
 * omitting internal storage fields per feedback_no_architecture_exposure.
 * Extracted from the route file to keep it under the CES Art 5.1 monolith
 * ceiling; pure (no I/O), so it is unit-testable in isolation.
 */
import { entityCanonicalUrl, cleanSourceUrl } from '../utils/mesh-routing-core.js';
import { extractArxivIdFromKey } from '../utils/entity-type-handlers.js';
import { sanitizeCitation } from '../utils/text-sanitizer.js';

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

export function projectEntity(e: any) {
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
