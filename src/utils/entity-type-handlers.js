/**
 * Entity Type Handlers (V15.22)
 * CES Compliance: Extracted from entity-hydrator.js to honor line limits.
 */
import { applyVramLogic } from './entity-vram-logic.js';

export function handleModelType(hydrated, entity, computed, meta, derivedName) {
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

    // Apply VRAM Logic
    applyVramLogic(hydrated);
}

export function handlePaperType(hydrated, entity, meta, derivedName) {
    hydrated.title = derivedName;
    hydrated.abstract = entity.abstract || entity.description || meta.abstract || meta.description;
    hydrated.arxiv_id = entity.arxiv_id || meta.arxiv_id || meta.extended?.arxiv_id;
    hydrated.citations = entity.citations || entity.citation_count || meta.citations || meta.extended?.citations;
    hydrated.published_date = entity.published_date || meta.published_date || meta.extended?.published_date;
    hydrated.authors = entity.authors || meta.authors || meta.extended?.authors || [];
}

export function handleGenericType(hydrated, entity, type, meta, derivedName) {
    if (entity.id && (!entity.name || entity.name.includes('--'))) {
        const parts = entity.id.split('--');
        const namePart = parts.length > 2 ? parts.slice(2).join('/') : parts[parts.length - 1];
        hydrated.name = entity.pretty_name || namePart || derivedName;
        if (type === 'space' || type === 'dataset') hydrated.title = hydrated.name;
    }
    hydrated.author = entity.author || (entity.id && entity.id.split('--').length > 1 ? entity.id.split('--')[1] : 'Unknown');

    // Promotion of specialized metadata
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
