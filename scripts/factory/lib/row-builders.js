/**
 * V23.1 Shard-DB Row and Bundle Builders
 * Extracted to satisfy CES Art 5.1 (250-line limit)
 */

/**
 * V22.8: Build complete bundle JSON for VFS shard packing
 */
export function buildBundleJson(e, fniMetrics, pBillions, ctxLen, arch) {
    return Buffer.from(JSON.stringify({
        readme: e.readme || e.html_readme || e.body_content || e.content || e.description || '',
        changelog: e.changelog || '',
        benchmarks: e.benchmarks || [],
        paper_abstract: e.paper_abstract || '',
        mesh_profile: e.mesh_profile || { relations: [] },
        fni_metrics: fniMetrics,
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

/**
 * V24.12: Build 38-column entity row for meta.db/search.db
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
    const n = (v, fallback = 0) => {
        if (typeof v === 'number' && !isNaN(v)) return v;
        const parsed = Number(v);
        return isNaN(parsed) ? fallback : parsed;
    };

    return [
        s(e.id), s(e.umid || e.id), s(e.slug), s(e.name || e.displayName), s(e.type, 'model'),
        s(e.author), s(summary), s(category), s(tags), n(e.fni_score), s(e.fni_percentile),
        n(e.fni_p ?? fniMetrics.p), n(e.fni_v ?? fniMetrics?.f ?? fniMetrics?.v),
        n(e.fni_c ?? fniMetrics.c), n(e.fni_u ?? fniMetrics.u),
        n(pBillions), s(arch), n(ctxLen), e.is_trending ? 1 : 0,
        n(e.stars || e.likes), n(e.downloads), s(e.last_modified), bundleKey, n(offset), n(size),
        '', s(e._trend_7d),
        s(e.license || e.license_spdx), s(e.source_url), s(e.pipeline_tag),
        s(e.raw_image_url || e.image_url), n(e.vram_estimate_gb), s(e.source || e.source_platform),
        s(e.task_categories), n(e.num_rows), s(e.primary_language), n(e.forks), n(e.citation_count),
        s(e.runtime_hardware), n(e.vocab_size), n(e.num_layers), n(e.hidden_size),
        s(e.datasets_used), s(e.quick_start),
        n(e.vram_fp16_gb), n(e.vram_int8_gb), n(e.vram_int4_gb),
        '', '', s(e.search_vector)
    ];
}
