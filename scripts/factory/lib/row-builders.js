/**
 * V23.1 Shard-DB Row and Bundle Builders
 * Extracted to satisfy CES Art 5.1 (250-line limit)
 */
import { lookupContextLength } from '../../ingestion/adapters/hf-arch-lookup.js';

const PARAMS_NAME_RE = /(\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])/;

/**
 * V27.11: Resolve params_billions, context_length, architecture with fallbacks.
 * Prevents null→0 silent coercion: applies name-regex and arch-lookup when fields are absent.
 */
export function resolveEntitySpecs(e) {
    const arch = e.architecture ?? e.technical?.architecture ?? '';
    let pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? null;
    if (!pBillions) {
        const m = String(e.name || e.id || '').match(PARAMS_NAME_RE);
        if (m) { const v = parseFloat(m[1]); if (v >= 0.1 && v <= 2000) pBillions = v; }
    }
    let ctxLen = e.context_length ?? e.technical?.context_length ?? null;
    if (!ctxLen && arch) ctxLen = lookupContextLength(arch) || null;
    return { pBillions: pBillions || 0, ctxLen: ctxLen || 0, arch };
}

/**
 * V22.8: Build complete bundle JSON for VFS shard packing
 */
export function buildBundleJson(e, pBillions, ctxLen, arch) {
    return Buffer.from(JSON.stringify({
        readme: e.body_content || e.readme || e.html_readme || e.content || e.description || '',
        changelog: e.changelog || '',
        benchmarks: e.benchmarks || [],
        paper_abstract: e.paper_abstract || '',
        mesh_profile: e.mesh_profile || { relations: [] },
        params_billions: pBillions, context_length: ctxLen, architecture: arch,
        license: e.license || e.license_spdx || '',
        source_url: e.source_url || '',
        source: e.source || e.source_platform || '',
        pipeline_tag: e.pipeline_tag || '',
        image_url: e.raw_image_url || e.image_url || '',
        vram_estimate_gb: e.vram_estimate_gb || null,
        quick_insights: e.quick_insights || [],
        use_cases: e.use_cases || [],
        quantization: e.quantization || '',
        html_readme: e.html_readme || '',
        relations: e.relations || [],
        created_at: e.created_at || '',
        display_description: e.display_description || ''
    }), 'utf8');
}

const PERMISSIVE_LICENSES = new Set([
    'mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc',
    'unlicense', 'cc0-1.0', 'wtfpl', 'zlib', 'bsl-1.0', 'openrail',
]);
const COPYLEFT_LICENSES = new Set([
    'gpl-2.0', 'gpl-3.0', 'lgpl-2.1', 'lgpl-3.0', 'agpl-3.0', 'mpl-2.0',
]);
const NC_LICENSES = new Set([
    'cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0',
    'llama2', 'llama 2', 'creativeml-openrail-m',
]);

export function classifyLicense(raw) {
    if (!raw) return 'unknown';
    const lc = raw.toLowerCase().trim();
    for (const k of PERMISSIVE_LICENSES) if (lc.includes(k)) return 'permissive';
    for (const k of COPYLEFT_LICENSES) if (lc.includes(k)) return 'copyleft';
    for (const k of NC_LICENSES) if (lc.includes(k)) return 'non-commercial';
    return 'unknown';
}

/**
 * V26.6: Build 59-column entity row for meta.db (shard_hash removed — factory-only, never read at runtime).
 * Column 54 (has_fulltext) lets sync-ledger skip entities already enriched by Factory 1.5.
 * Authoritative source is master-fusion (fuse-shard-js.js) which sets entity.has_fulltext
 * based on R2 {umid}.md.gz presence + quality heuristic (>1000 chars, >=2 headings).
 */
export function buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, summary, bundleKey, offset, size) {
    const s = (v, fallback = '') => {
        if (v == null) return fallback;
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'bigint') return v;
        if (Array.isArray(v)) return v.join(', ');
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    };
    const tr = (v, max) => { const r = s(v); return typeof r === 'string' && r.length > max ? r.substring(0, max) : r; };
    const n = (v, fallback = 0) => {
        if (typeof v === 'number' && !isNaN(v)) return v;
        const parsed = Number(v);
        return isNaN(parsed) ? fallback : parsed;
    };
    // V27.45: honest-contract — preserves null/undefined as null (vs coercing to 0).
    // Use for columns where llms.txt distinguishes measured-zero (0) from not-measured (null).
    const nOrNull = (v) => {
        if (v == null || v === '') return null;
        if (typeof v === 'number' && !isNaN(v)) return v;
        const parsed = Number(v);
        return isNaN(parsed) ? null : parsed;
    };
    // PR-3 (R1): honest-contract text — null when not-present (vs s()'s '' coercion),
    // so the entity API's `e.<field> || null` surfaces a true not-measured null.
    const sOrNull = (v) => {
        if (v == null) return null;
        const r = s(v);
        return r === '' ? null : r;
    };

    return [
        s(e.id), s(e.umid || e.id), s(e.slug), s(e.name || e.displayName), s(e.type, 'model'),
        s(e.author), s(summary), s(category), tr(tags, 500), n(e.fni_score), s(e.fni_percentile),
        n(e.fni_s ?? fniMetrics.s), n(e.fni_a ?? fniMetrics.a), n(e.fni_p ?? fniMetrics.p),
        n(e.fni_r ?? fniMetrics.r), n(e.fni_q ?? fniMetrics.q), n(e.raw_pop),
        nOrNull(pBillions), s(arch), nOrNull(ctxLen), e.is_trending ? 1 : 0,
        // V27.45 + PR-3 (R3): stars=null on HF (no stars concept per V27.25 honest-contract);
        // a real value (incl. measured-zero) only when sourced from a true stars field.
        // Dropped the `?? e.likes` fallback: (a) likes != stars (HF likes leaking into a
        // stars column is fabrication), and (b) `0 ?? likes` returns 0, which zeroed every
        // gh-tool whose stars promoted to 0 instead of falling through. Upstream
        // (output-mapper / processor-core / distiller) now sets e.stars to the true gh value
        // or null, so reading e.stars alone is correct and honest for all sources.
        nOrNull(e.stars), nOrNull(e.downloads), s(e.last_modified), bundleKey, n(offset), n(size),
        s(e._trend_7d),
        s(e.license || e.license_spdx), s(e.source_url), s(e.pipeline_tag),
        s(e.raw_image_url || e.image_url), nOrNull(e.vram_estimate_gb), s(e.source || e.source_platform),
        tr(e.task_categories, 500), nOrNull(e.num_rows), s(e.primary_language), nOrNull(e.forks), nOrNull(e.citation_count),
        s(e.runtime_hardware), nOrNull(e.vocab_size), nOrNull(e.num_layers), nOrNull(e.hidden_size),
        // V27.72: JSON.stringify (was comma-join via s()) — API parseTags handles both forms.
        tr(JSON.stringify(Array.isArray(e.datasets_used) ? e.datasets_used.map(x => String(x).toLowerCase()) : (typeof e.datasets_used === 'string' && e.datasets_used.trim() ? e.datasets_used.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : [])), 500), tr(e.quick_start, 1000),
        nOrNull(e.vram_fp16_gb), nOrNull(e.vram_int8_gb), nOrNull(e.vram_int4_gb),
        // ARCHITECTURE GUARD — DO NOT inline e.readme_html here.
        // Full HTML lives in the .bin fused-shard (cold tier); the SQL row keeps
        // an empty string and points to .bin via bundle_key/offset/size (line 110).
        // V27.44 co-restored readme_html alongside the real fix (ui_related_mesh),
        // inflating each meta-NN.db slot ~40MB → ~340MB and breaching the R2↔GHA
        // ≤50MB rule by 6.8×. Read via packet-loader.fetchBundleReadme on demand.
        '', s(e.ui_related_mesh), s(e.search_vector),
        s(e.canonical_url), tr(e.citation, 500),
        e.has_fulltext ? 1 : 0,
        (e.has_ollama || e.has_gguf) ? 1 : 0,
        s(e.hosted_on || '[]'),
        classifyLicense(e.license || e.license_spdx),
        ((e.has_ollama || e.has_gguf) && (pBillions <= 13 || !pBillions)) ? 1 : 0,
        s(e.hosted_on_checked_at),
        e.benchmarks ? JSON.stringify(e.benchmarks) : null,
        // PR-3 (R1): hot-column promotion. SAME positional order as pack-schemas.js
        // entitiesTableSql and rust project.rs PR3_HOT_COLUMNS. Populated by the
        // distiller (v25-distiller.js) from meta_json / meta_json.config; null = not-measured.
        nOrNull(e.num_heads), nOrNull(e.kv_heads), nOrNull(e.moe_experts), nOrNull(e.moe_active),
        sOrNull(e.sdk), sOrNull(e.running_status), sOrNull(e.size_category), nOrNull(e.files_count),
        sOrNull(e.modality), nOrNull(e.published_year), sOrNull(e.primary_category)
    ];
}
