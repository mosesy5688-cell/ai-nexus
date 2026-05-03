import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import crypto from 'crypto';
import { renderHtmlFFI } from './rust-bridge.js';

let isMarkedConfigured = false;
let sanitizeConfig = null;

// V25.12 (2026-05-04): HTML render cache (avoid re-rendering unchanged readme)
let cacheDbRef = null;
let htmlCacheGetStm = null;
let htmlCachePutStm = null;
let htmlCacheBatch = [];
let htmlStats = { hits: 0, misses: 0, errors: 0 };
const HTML_CACHE_FLUSH_SIZE = 1000;

export function configureDistiller(cacheDb = null) {
    if (!isMarkedConfigured) {
        // V25.1 Compute Shift-Left: Pre-allocate Markdown Options
        marked.setOptions({ gfm: true, breaks: true });
        sanitizeConfig = {
            allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
            allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, 'img': ['src', 'alt', 'width', 'height'] }
        };
        isMarkedConfigured = true;
    }
    if (cacheDb && !htmlCacheGetStm) {
        cacheDbRef = cacheDb;
        htmlCacheGetStm = cacheDb.prepare('SELECT html FROM html_cache WHERE hash = ?');
        htmlCachePutStm = cacheDb.prepare('INSERT OR REPLACE INTO html_cache (hash, html) VALUES (?, ?)');
        htmlCacheBatch = [];
        htmlStats = { hits: 0, misses: 0, errors: 0 };
    }
}

function flushHtmlCacheBatch() {
    if (!htmlCachePutStm || !cacheDbRef || htmlCacheBatch.length === 0) return;
    const insertMany = cacheDbRef.transaction((entries) => {
        for (const e of entries) htmlCachePutStm.run(e.hash, e.html);
    });
    insertMany(htmlCacheBatch);
    htmlCacheBatch = [];
}

/**
 * Flush any pending HTML cache writes. Call after main pass completes.
 */
export function flushDistillerCache() {
    flushHtmlCacheBatch();
}

/**
 * Get HTML render cache statistics.
 */
export function getDistillerStats() {
    return {
        hits: htmlStats.hits,
        misses: htmlStats.misses,
        errors: htmlStats.errors,
        total: htmlStats.hits + htmlStats.misses + htmlStats.errors
    };
}

// V25.12: Rust-primary render (pulldown-cmark + ammonia); JS path only on FFI miss.
let _renderModeLogged = false;
function renderRaw(rawReadme) {
    const ffi = renderHtmlFFI(rawReadme);
    if (!_renderModeLogged) {
        console.log(`[DISTILLER] HTML render mode: ${ffi !== null ? 'Rust FFI' : 'JS fallback (marked+sanitize-html)'}`);
        _renderModeLogged = true;
    }
    if (ffi !== null) return ffi;
    return sanitizeHtml(marked.parse(rawReadme), sanitizeConfig);
}

function renderHtmlWithCache(rawReadme) {
    if (!htmlCacheGetStm) {
        try { return renderRaw(rawReadme); } catch (err) { return ''; }
    }
    const hash = crypto.createHash('md5').update(rawReadme).digest('hex');
    const cached = htmlCacheGetStm.get(hash);
    if (cached) { htmlStats.hits++; return cached.html; }
    try {
        const html = renderRaw(rawReadme);
        htmlCacheBatch.push({ hash, html });
        if (htmlCacheBatch.length >= HTML_CACHE_FLUSH_SIZE) flushHtmlCacheBatch();
        htmlStats.misses++;
        return html;
    } catch (err) {
        htmlStats.errors++;
        return '';
    }
}

export function distillEntity(e, pBillions, entityLookup) {
    // V24.12: Promote meta_json fields to top-level for DB storage
    const meta = typeof e.meta_json === 'string' ? JSON.parse(e.meta_json || '{}') : (e.meta_json || {});
    e.task_categories ??= Array.isArray(meta.task_categories) ? meta.task_categories.join(', ') : (meta.task_categories || '');
    e.num_rows ??= meta.rows_count || 0;
    e.primary_language ??= Array.isArray(meta.language) ? meta.language[0] : (meta.language || '');
    e.forks ??= meta.forks || 0;
    e.citation_count ??= meta.citation_count || 0;
    e.stars ??= meta.stars || 0;

    // V2.0: FNI Pillar Promotion (S-A-P-R-Q Alignment)
    const fMetrics = e.fni_metrics || meta.fni_metrics || meta.fni?.metrics || {};
    e.fni_s ??= fMetrics.s ?? 50.0; // Semantic (factory default 50.0, query-time override)
    e.fni_a ??= fMetrics.a ?? fMetrics.v ?? meta.fni?.v ?? 0; // Authority (was mesh/velocity)
    e.fni_p ??= fMetrics.p ?? meta.fni?.p ?? 0; // Popularity
    e.fni_r ??= fMetrics.r ?? fMetrics.f ?? meta.fni?.f ?? 0; // Recency (was freshness)
    e.fni_q ??= fMetrics.q ?? 0; // Quality (completeness + utility merged)

    // V18.9: FNI Singularity is sole authority. No quality_score fallback.
    e.fni_score ??= 0;

    // V25.1 Distillation: Goldmine
    e.runtime_hardware = meta.runtime_hardware || meta.hardware || '';
    e.vocab_size = meta.vocab_size || 0;
    e.num_layers = meta.num_hidden_layers || meta.num_layers || 0;
    e.hidden_size = meta.hidden_size || 0;
    e.datasets_used = Array.isArray(meta.datasets) ? meta.datasets.join(', ') : (meta.datasets || '');
    e.quick_start = meta.quick_start || '';

    // V25.1 Distillation: VRAM Calculation
    if (pBillions > 0) {
        e.vram_fp16_gb = Number((pBillions * 2.2).toFixed(1));
        e.vram_int8_gb = Number((pBillions * 1.2).toFixed(1));
        e.vram_int4_gb = Number((pBillions * 0.7).toFixed(1));
    }

    // V25.1 Distillation: AOT HTML Compilation (V25.12: with cache)
    const rawReadme = e.readme || e.html_readme || e.body_content || e.content || e.description || '';
    if (rawReadme && !e.readme_html) {
        e.readme_html = renderHtmlWithCache(rawReadme);
    }

    // V25.1 Distillation: Mesh Pre-joining
    // V25.12: Mark unresolved refs with _unresolved=1 for post-pass fix-up.
    // Forward refs to same-run new entities miss the SQLite lookup proxy
    // (entity not yet flushed); resolveMeshFixup() repairs them after main pass.
    const relations = Array.isArray(e.relations) ? e.relations : (e.mesh_profile?.relations || []);
    e.ui_related_mesh = JSON.stringify(relations.map(rel => {
        const targetId = rel.target || rel.target_id || rel.id;
        const t = entityLookup.get(targetId);
        const type = rel.type || rel.t || 'model';
        return t
            ? { id: targetId, type, name: t.name, icon: t.icon || '📦' }
            : { id: targetId, type, name: targetId, icon: '📦', _unresolved: 1 };
    }));

    // V25.1 Distillation: Search Vector Normalization
    const category = e.category || '';
    const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');
    const tagsCombo = `${tags} ${category} ${e.pipeline_tag || ''}`.toLowerCase();
    let searchExpanded = '';
    if (tagsCombo.includes('nlp') || tagsCombo.includes('text') || tagsCombo.includes('llm')) {
        searchExpanded += ' natural language processing text generation llm language model transformers';
    }
    if (tagsCombo.includes('cv') || tagsCombo.includes('vision') || tagsCombo.includes('image')) {
        searchExpanded += ' computer vision image generation sight';
    }
    e.search_vector = searchExpanded;

    return e;
}
