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
    if (meta.extended || meta.config || entity.config) {
        const config = entity.config || meta.config || meta.extended?.config || {};

        hydrated.context_length = hydrated.context_length || meta.extended?.context_length || config.max_position_embeddings || config.n_ctx || config.max_seq_len;
        hydrated.architecture = hydrated.architecture || meta.extended?.architecture || config.model_type || config.architectures?.[0];
        hydrated.params_billions = hydrated.params_billions || meta.extended?.params_billions || config.num_parameters;
        hydrated.example_code = hydrated.example_code || meta.extended?.example_code || meta.usage || meta.sample_code;
        hydrated.license_spdx = hydrated.license_spdx || meta.extended?.license || meta.license || config.license;

        // V15.9: Additional Architectural Detail for NeuralExplorer/TechSpecs
        hydrated.num_layers = hydrated.num_layers || config.num_hidden_layers || config.n_layer || config.num_layers;
        hydrated.hidden_size = hydrated.hidden_size || config.hidden_size || config.n_embd || config.d_model;
        hydrated.num_heads = hydrated.num_heads || config.num_attention_heads || config.n_head;
        hydrated.vocab_size = hydrated.vocab_size || config.vocab_size;

        // V15.8 (Fix): Promote README/Model Card to body_content if top-level is empty
        if (!hydrated.body_content) {
            hydrated.body_content = entity.body_content || meta.readme || meta.model_card || meta.body_content || meta.description || meta.extended?.readme || null;
        }

        // Secondary fallback for description if body_content is still empty
        if (!hydrated.description && hydrated.body_content) {
            hydrated.description = hydrated.body_content.substring(0, 500).split('\n')[0];
        }
    }

    // Type-specific hydration
    if (type === 'model') {
        const benchmarks = computed.benchmarks || [];
        const firstBench = benchmarks[0] || {};

        // Ensure benchmarks are promoted from all possible sources
        hydrated.mmlu = hydrated.mmlu || firstBench.mmlu || entity.mmlu || meta.extended?.mmlu;
        hydrated.hellaswag = hydrated.hellaswag || firstBench.hellaswag || entity.hellaswag || meta.extended?.hellaswag;
        hydrated.arc_challenge = hydrated.arc_challenge || firstBench.arc_challenge || entity.arc_challenge || meta.extended?.arc_challenge;
        hydrated.gsm8k = hydrated.gsm8k || firstBench.gsm8k || entity.gsm8k || meta.extended?.gsm8k;
        hydrated.humaneval = hydrated.humaneval || firstBench.humaneval || entity.humaneval || meta.extended?.humaneval;
        hydrated.avg_score = firstBench.avg_score || entity.avg_score || meta.extended?.avg_score;

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
        hydrated.abstract = entity.abstract || entity.description || meta.abstract || meta.description;
        hydrated.arxiv_id = entity.arxiv_id || meta.arxiv_id || meta.extended?.arxiv_id;
        hydrated.citations = entity.citations || entity.citation_count || meta.citations || meta.extended?.citations;
        hydrated.published_date = entity.published_date || meta.published_date || meta.extended?.published_date;
        hydrated.authors = entity.authors || meta.authors || meta.extended?.authors || [];
    } else if (type === 'tool' || type === 'dataset' || type === 'agent' || type === 'space') {
        if (entity.id && (!entity.name || entity.name.includes('--'))) {
            const parts = entity.id.split('--');
            const namePart = parts.length > 2 ? parts.slice(2).join('/') : parts[parts.length - 1];
            hydrated.name = entity.pretty_name || namePart || derivedName;
            if (type === 'space' || type === 'dataset') hydrated.title = hydrated.name;
        }
        hydrated.author = entity.author || (entity.id && entity.id.split('--').length > 1 ? entity.id.split('--')[1] : 'Unknown');

        // Promotion of specialized metadata for max density
        if (type === 'dataset') {
            hydrated.size_bytes = entity.size_bytes || meta.size_bytes || meta.extended?.size_bytes;
            hydrated.rows = entity.rows || meta.rows || meta.extended?.rows;
            hydrated.files_count = entity.files_count || meta.files_count || meta.extended?.files;
            hydrated.features = entity.features || meta.features || meta.extended?.features;
            hydrated.configs = entity.configs || meta.configs || meta.extended?.configs || [];
        } else if (type === 'agent' || type === 'tool') {
            hydrated.github_stars = entity.github_stars || entity.stars || meta.stars || meta.stargazers_count || meta.extended?.stars;
            hydrated.github_forks = entity.github_forks || entity.forks || meta.forks || meta.forks_count || meta.extended?.forks;
            hydrated.language = entity.language || meta.language || meta.extended?.language || 'Python';
            hydrated.version = entity.version || meta.version || meta.extended?.version || '1.0.0';
            hydrated.framework = entity.framework || meta.framework || meta.extended?.framework;
        } else if (type === 'space') {
            hydrated.sdk = entity.sdk || meta.sdk || meta.extended?.sdk || 'gradio';
            hydrated.hardware = entity.hardware || meta.hardware || meta.extended?.hardware;
            hydrated.running_status = entity.running_status || meta.running_status || meta.extended?.runtime_stage || 'RUNNING';
        }
    }

    return hydrated;
}

/**
 * Augment an already hydrated entity with data from global summary files (V15.5)
 * Standardizes technical specs like parameters, context, and benchmark scores.
 */
export function augmentEntity(hydrated, summaryData) {
    if (!hydrated || !summaryData) return hydrated;

    // 1. Tech Specs Augmentation (Universal)
    if (summaryData.params_billions !== undefined && !hydrated.params_billions) {
        hydrated.params_billions = summaryData.params_billions;
    }
    if (summaryData.context_length !== undefined && !hydrated.context_length) {
        hydrated.context_length = summaryData.context_length;
    }
    if (summaryData.architecture_family && !hydrated.architecture) {
        hydrated.architecture = summaryData.architecture_family;
    }

    // V15.10: Support for non-model augmentation
    if (summaryData.citations !== undefined && !hydrated.citations) {
        hydrated.citations = summaryData.citations;
    }
    if (summaryData.size_bytes !== undefined && !hydrated.size_bytes) {
        hydrated.size_bytes = summaryData.size_bytes;
    }
    if (summaryData.github_stars !== undefined && !hydrated.github_stars) {
        hydrated.github_stars = summaryData.github_stars;
    }

    // 2. Benchmarks Augmentation
    if (summaryData.mmlu !== undefined && !hydrated.mmlu) hydrated.mmlu = summaryData.mmlu;
    if (summaryData.humaneval !== undefined && !hydrated.humaneval) hydrated.humaneval = summaryData.humaneval;
    if (summaryData.hellaswag !== undefined && !hydrated.hellaswag) hydrated.hellaswag = summaryData.hellaswag;
    if (summaryData.arc_challenge !== undefined && !hydrated.arc_challenge) hydrated.arc_challenge = summaryData.arc_challenge;
    if (summaryData.avg_score !== undefined && !hydrated.avg_score) hydrated.avg_score = summaryData.avg_score;

    // 3. FNI/Percentile Augmentation (Best effort)
    if (summaryData.fni_score !== undefined && !hydrated.fni_score) hydrated.fni_score = summaryData.fni_score;
    if (summaryData.fni_percentile !== undefined && !hydrated.fni_percentile) hydrated.fni_percentile = summaryData.fni_percentile;

    return hydrated;
}
