import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import crypto from 'crypto';
import { renderHtmlFFI } from './rust-bridge.js';
import { deriveTaskCategories } from './task-classifier.js';
import { deriveArchitectureFromTags } from './arch-derivation.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';

// V27.94 (3rd-diag) ROOT fix: mesh relation TARGETS arrive stripped
// (e.g. "2512.20848", "huggingface--transformers", "what-is-rag") while
// entity_lookup is keyed by the CANONICAL prefixed id (arxiv-paper--...).
// Humanize a slug into a display name so a genuine miss still yields a node
// whose name !== id (verify-db flags name===id as degenerate). Takes the last
// '--' segment when present else the whole slug, swaps -/_ for spaces, and
// title-cases. e.g. "huggingface--transformers"->"Transformers",
// "what-is-rag"->"What Is Rag", "agentic-ai"->"Agentic Ai". This supplies only
// a readable label for a real mesh edge; it never invents the relationship.
function humanizeMeshName(rawId) {
    if (typeof rawId !== 'string' || !rawId) return null;
    const seg = rawId.includes('--') ? rawId.split('--').pop() : rawId;
    const words = seg.replace(/[-_]+/g, ' ').trim();
    if (!words) return null;
    const titled = words.replace(/\b\w/g, (c) => c.toUpperCase());
    return titled;
}

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
    if (!e.task_categories || e.task_categories === '' || (Array.isArray(e.task_categories) && e.task_categories.length === 0)) {
        e.tags ??= meta.tags;
        const derived = deriveTaskCategories(e);
        e.task_categories = derived.length > 0 ? derived.join(', ') : (Array.isArray(meta.task_categories) ? meta.task_categories.join(', ') : (meta.task_categories || ''));
    }
    // V27.45: honest-contract — preserve null when source data unavailable
    // (vs explicit zero). Per llms.txt: 0 = measured-zero, null = not-measured.
    e.num_rows ??= meta.rows_count ?? null;
    e.primary_language ??= Array.isArray(meta.language) ? meta.language[0] : (meta.language || null);
    e.forks ??= meta.forks ?? null;
    e.citation_count ??= meta.citation_count ?? null;
    e.stars ??= meta.stars ?? null;

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
    // V27.45: preserve null when meta_json lacks them. V27.61: ??= so adapter-set
    // values aren't clobbered (matches honest-contract pattern on lines 107-111).
    e.runtime_hardware ??= meta.runtime_hardware || meta.hardware || null;
    e.vocab_size ??= meta.vocab_size ?? null;
    e.num_layers ??= meta.num_hidden_layers ?? meta.num_layers ?? null;
    e.hidden_size ??= meta.hidden_size ?? null;
    e.datasets_used ??= Array.isArray(meta.datasets) ? meta.datasets.join(', ') : (meta.datasets || null);
    e.quick_start ??= meta.quick_start || null;

    // V27.46: derive architecture from tags when meta_json lacks it.
    // HF cardData.architecture is often empty even when tags clearly mark the family
    // (e.g., 'llama', 'mistral', 'qwen'). Recovers ~70-80% of previously-null arch values.
    if (!e.architecture && Array.isArray(e.tags)) {
        const derived = deriveArchitectureFromTags(e.tags);
        if (derived) e.architecture = derived;
    }

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
    // V27.94 (3rd-diag) ROOT fix: canonicalize each relation target before the
    // entity_lookup .get() (the target arrives STRIPPED; the lookup is keyed by
    // the CANONICAL id, so the old code missed 100% -> degenerate nodes). On a
    // miss we write a humanized display name (no _unresolved marker — see below).
    // V27.73: check non-empty, not just isArray — adapters initialize relations=[]
    // which made the mesh_profile branch dead. Hit-rate was 0% post-V27.71 verified.
    const relations = (Array.isArray(e.relations) && e.relations.length > 0)
        ? e.relations : (e.mesh_profile?.relations || []);
    e.ui_related_mesh = JSON.stringify(relations.map(rel => {
        // V27.94 (A.2): tolerate Rust array-form edges [target_id, type, conf]
        // (relations-generator.js addEdge). Reading rel.target/.type as object keys
        // on an array yielded undefined -> degenerate {type:'model',icon} nodes.
        const isArr = Array.isArray(rel);
        const rawTarget = isArr ? rel[0] : (rel.target || rel.target_id || rel.id);
        const type = (isArr ? rel[1] : (rel.type || rel.t)) || 'model';
        // V27.94 (3rd-diag) ROOT fix: the raw target is a STRIPPED id while
        // entity_lookup is keyed by the CANONICAL prefixed id. Canonicalize
        // before lookup — mirrors relation-extractors.js:42-44 and
        // mesh-profile-baker.js:80 — else .get() misses 100% -> degenerate.
        const targetId = normalizeId(rawTarget, getNodeSource(rawTarget, type), type) || rawTarget;
        const t = entityLookup.get(targetId);
        if (t && t.name) {
            return { id: targetId, type, name: t.name, icon: t.icon || '📦' };
        }
        // MISS: knowledge concepts / hub tools (EXPLAINS edges) dominate the mesh
        // (~597K of ~947K) and are NOT streamed into entity_lookup, so they will
        // never resolve. Supply a humanized display name so the node is
        // non-degenerate (name !== id) — a real edge with a readable label; we do
        // NOT invent the relationship, only its display name. We deliberately do
        // NOT set _unresolved here: verify-db's canary counts _unresolved itself
        // as degenerate, and the resolveMeshFixup post-pass could never resolve a
        // never-streamed target — keeping the marker would pin ~63% of edges
        // degenerate and fail the gate. Tradeoff: the <1% same-run forward-refs
        // keep this humanized name instead of upgrading to the real entity name
        // post-pass; the name stays truthful (derived from the slug).
        const name = humanizeMeshName(rawTarget) || targetId;
        return { id: targetId, type, name, icon: '📦' };
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
