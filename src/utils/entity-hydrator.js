/**
 * Unified Entity Hydrator (V15.8)
 * Art 5.1 Compliance: Extracted from entity-cache-reader-core.js
 */

export function hydrateEntity(data, type) {
    if (!data) return null;

    const entity = data.entity || data;
    const computed = data.computed || {};
    const seo = data.seo || {};

    // V15.8: Proactive meta_json parsing for high-fidelity recovery
    let meta = {};
    try {
        if (entity.meta_json) {
            meta = typeof entity.meta_json === 'string'
                ? JSON.parse(entity.meta_json)
                : entity.meta_json;
        }
    } catch (e) {
        console.warn('[Hydrator] Failed to parse meta_json:', e.message);
    }

    // V15.2: Derive name from ID if missing
    const derivedName = entity.name || entity.title || entity.pretty_name ||
        (entity.id ? entity.id.split('--').pop() : 'Unknown');

    // Standard mappings for all types
    const hydrated = {
        ...entity,
        meta: meta,
        fni_score: computed.fni ?? entity.fni_score ?? entity.fni ?? 0,
        fni_percentile: computed.fni_percentile ?? entity.fni_percentile ?? entity.percentile,
        name: derivedName,
        relations: computed.relations || entity.relations || meta.extended?.relations || {},
        _computed: computed,
        _seo: seo,
        _hydrated: true
    };

    // Promotion of high-fidelity technical specs from meta_json (Data Vacuum Fix)
    if (meta.extended) {
        hydrated.context_length = hydrated.context_length || meta.extended.context_length;
        hydrated.architecture = hydrated.architecture || meta.extended.architecture;
        hydrated.params_billions = hydrated.params_billions || meta.extended.params_billions;
        hydrated.example_code = hydrated.example_code || meta.extended.example_code;

        // V15.8 (Fix): Promote README/Model Card to body_content if top-level is empty
        // This unlocks the "Data Vacuum" for Models, Agents, and Tools
        if (!hydrated.body_content) {
            hydrated.body_content = meta.readme || meta.model_card || meta.body_content || meta.extended?.readme || null;
        }
    }

    // Type-specific hydration
    if (type === 'model') {
        const benchmarks = computed.benchmarks || [];
        const firstBench = benchmarks[0] || {};
        hydrated.mmlu = firstBench.mmlu || entity.mmlu;
        hydrated.hellaswag = firstBench.hellaswag || entity.hellaswag;
        hydrated.arc_challenge = firstBench.arc_challenge || entity.arc_challenge;
        hydrated.avg_score = firstBench.avg_score || entity.avg_score;

        if (entity.config) {
            hydrated.architecture = hydrated.architecture || entity.config.model_type || entity.config.architectures?.[0];
            hydrated.context_length = hydrated.context_length || entity.config.max_position_embeddings || entity.config.n_ctx;
        }

        if (entity.id && (!entity.name || entity.name.includes('--') || entity.name.includes(':') || entity.name.includes('/'))) {
            const normalizedId = entity.id.replace(/:/g, '--').replace(/\//g, '--');
            const parts = normalizedId.split('--').filter(p => p);
            const namePart = parts[parts.length - 1] || entity.id;
            hydrated.name = entity.pretty_name || namePart || derivedName;
            hydrated.author = entity.author || (parts.length > 1 ? parts[parts.length - 2] : 'Unknown');
        }
    } else if (type === 'paper') {
        hydrated.title = derivedName;
        hydrated.abstract = entity.abstract || entity.description;
    } else if (type === 'tool' || type === 'dataset' || type === 'agent' || type === 'space') {
        if (entity.id && (!entity.name || entity.name.includes('--'))) {
            const parts = entity.id.split('--');
            // Handle space IDs: hf-space--author--name
            // Handle agent IDs: github--author--name
            const namePart = parts.length > 2 ? parts.slice(2).join('/') : parts[parts.length - 1];
            hydrated.name = entity.pretty_name || namePart || derivedName;
            if (type === 'space' || type === 'dataset') hydrated.title = hydrated.name;
        }
        hydrated.author = entity.author || (entity.id && entity.id.split('--').length > 1 ? entity.id.split('--')[1] : 'Unknown');
    }

    return hydrated;
}
