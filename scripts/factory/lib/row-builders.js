/**
 * V23.1 Shard-DB Row and Bundle Builders
 * Extracted to satisfy CES Art 5.1 (250-line limit)
 */

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

    return [
        s(e.id), s(e.umid || e.id), s(e.slug), s(e.name || e.displayName), s(e.type, 'model'),
        s(e.author), s(summary), s(category), tr(tags, 500), n(e.fni_score), s(e.fni_percentile),
        n(e.fni_s ?? fniMetrics.s), n(e.fni_a ?? fniMetrics.a), n(e.fni_p ?? fniMetrics.p),
        n(e.fni_r ?? fniMetrics.r), n(e.fni_q ?? fniMetrics.q), n(e.raw_pop),
        n(pBillions), s(arch), n(ctxLen), e.is_trending ? 1 : 0,
        n(e.stars || e.likes), n(e.downloads), s(e.last_modified), bundleKey, n(offset), n(size),
        s(e._trend_7d),
        s(e.license || e.license_spdx), s(e.source_url), s(e.pipeline_tag),
        s(e.raw_image_url || e.image_url), n(e.vram_estimate_gb), s(e.source || e.source_platform),
        tr(e.task_categories, 500), n(e.num_rows), s(e.primary_language), n(e.forks), n(e.citation_count),
        s(e.runtime_hardware), n(e.vocab_size), n(e.num_layers), n(e.hidden_size),
        tr(e.datasets_used, 500), tr(e.quick_start, 1000),
        n(e.vram_fp16_gb), n(e.vram_int8_gb), n(e.vram_int4_gb),
        '', '', s(e.search_vector),
        s(e.canonical_url), tr(e.citation, 500),
        e.has_fulltext ? 1 : 0,
        (e.has_ollama || e.has_gguf) ? 1 : 0,
        s(e.hosted_on || '[]'),
        classifyLicense(e.license || e.license_spdx),
        ((e.has_ollama || e.has_gguf) && (pBillions <= 13 || !pBillions)) ? 1 : 0,
        s(e.hosted_on_checked_at)
    ];
}
