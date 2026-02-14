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

    // V16.8.31: Identity protection - beautifyName and beautifyAuthor handle this now.
    // Removed raw segment injection that was causing "--" to appear in UI.

    // V16.22-26: Robust Source URL Construction
    if (!hydrated.source_url && hydrated.id) {
        const id = hydrated.id;
        if (id.startsWith('replicate--') || id.startsWith('replicate:')) {
            const slug = id.replace(/^(replicate--|replicate:)/, '');
            hydrated.source_url = `https://replicate.com/${slug}`;
        } else if (id.startsWith('hf-model--') || id.startsWith('hf-agent--') || id.startsWith('hf-tool--') || id.startsWith('huggingface:') || (entity.source === 'huggingface' && id.includes('/'))) {
            const slug = id.replace(/^(hf-model--|hf-agent--|hf-tool--|huggingface:)/, '').replace(/--/g, '/');
            hydrated.source_url = `https://huggingface.co/${slug}`;
        } else if (id.startsWith('gh-model--') || id.startsWith('gh-agent--') || id.startsWith('gh-tool--') || id.startsWith('github--') || id.startsWith('github:')) {
            const slug = id.replace(/^(gh-model--|gh-agent--|gh-tool--|github--|github:)/, '').replace(/--/g, '/');
            hydrated.source_url = `https://github.com/${slug}`;
        } else if (entity.author && entity.name && entity.source === 'huggingface') {
            hydrated.source_url = `https://huggingface.co/${entity.author}/${entity.name}`;
        }
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

    // V16.24-26: Robust Paper Source URL
    if (!hydrated.source_url && (hydrated.arxiv_id || hydrated.id)) {
        const id = hydrated.arxiv_id || (hydrated.id?.startsWith('arxiv--') ? hydrated.id.replace('arxiv--', '') : null) || (hydrated.id?.startsWith('arxiv:') ? hydrated.id.replace('arxiv:', '') : null);
        if (id) hydrated.source_url = `https://arxiv.org/abs/${id}`;
    }
}

export function handleGenericType(hydrated, entity, type, meta, derivedName) {
    // V16.8.31: Identity protection for generic types
    hydrated.author = hydrated.author || entity.author || (entity.id && entity.id.split('--').length > 1 ? entity.id.split('--')[1] : 'Unknown');

    // V16.24-26: Robust Generic Source URL Construction (Datasets, Spaces, Tools, Agents)
    if (!hydrated.source_url && hydrated.id) {
        const id = hydrated.id;
        if (id.startsWith('hf-dataset--') || id.startsWith('hf-dataset:')) {
            const slug = id.replace('hf-dataset--', '').replace('hf-dataset:', '').replace(/--/g, '/');
            hydrated.source_url = `https://huggingface.co/datasets/${slug}`;
        } else if (id.startsWith('hf-space--') || id.startsWith('hf-space:')) {
            const slug = id.replace('hf-space--', '').replace('hf-space:', '').replace(/--/g, '/');
            hydrated.source_url = `https://huggingface.co/spaces/${slug}`;
        } else if (id.startsWith('github--') || id.startsWith('github:')) {
            const slug = id.replace('github--', '').replace('github:', '').replace(/--/g, '/');
            hydrated.source_url = `https://github.com/${slug}`;
        } else if (id.startsWith('replicate--') || id.startsWith('replicate:')) {
            const slug = id.replace('replicate--', '').replace('replicate:', '');
            hydrated.source_url = `https://replicate.com/${slug}`;
        }
    }

    // Promotion of specialized metadata
    if (type === 'dataset') {
        hydrated.size_bytes = entity.size_bytes || meta.size_bytes || meta.extended?.size_bytes || meta.dataset_info?.dataset_size;
        hydrated.rows = entity.rows || meta.rows || meta.extended?.rows || meta.dataset_info?.splits?.train?.num_examples;
        hydrated.files_count = entity.files_count || meta.files_count || meta.extended?.files;
        hydrated.features = entity.features || meta.features || meta.extended?.features;
    } else if (type === 'agent' || type === 'tool') {
        hydrated.github_stars = entity.github_stars || entity.stars || meta.stars || meta.stargazers_count || meta.extended?.stars;
        hydrated.github_forks = entity.github_forks || entity.forks || meta.forks || meta.forks_count || meta.extended?.forks;
        hydrated.language = entity.language || meta.language || meta.extended?.language || meta.info?.language || 'Python';
        hydrated.version = entity.version || meta.version || meta.extended?.version || '1.0.0';
        hydrated.framework = entity.framework || meta.framework || meta.extended?.framework || meta.info?.framework;
    } else if (type === 'space') {
        hydrated.sdk = entity.sdk || meta.sdk || meta.extended?.sdk || meta.sdk_version || 'gradio';
        hydrated.hardware = entity.hardware || meta.hardware || meta.extended?.hardware || 'CPU';
        hydrated.running_status = entity.running_status || meta.running_status || meta.extended?.runtime_stage || 'RUNNING';
    }

    if (!hydrated.source && hydrated.id) {
        if (hydrated.id.includes('hf-') || hydrated.id.includes('huggingface')) hydrated.source = 'huggingface';
        else if (hydrated.id.includes('github') || hydrated.id.includes('gh-')) hydrated.source = 'github';
    }
}

export function heuristicMining(hydrated) {
    if (!hydrated.body_content) return;
    const body = hydrated.body_content;

    // Architecture Hints
    if (!hydrated.architecture) {
        if (body.match(/MoE|Mixture of Experts/i)) hydrated.architecture = 'MoE';
        else if (body.match(/GQA|Grouped Query Attention/i)) hydrated.architecture = 'GQA';
    }

    // Parameter Recovery (v16.5 Higher Precision)
    if (!hydrated.params_billions) {
        const pMatch = body.match(/(\d+(\.\d+)?)\s?B\s(Parameters|Params)/i);
        if (pMatch) hydrated.params_billions = parseFloat(pMatch[1]);
    }

    // Quantization Hints (for VRAM calibration)
    if (!hydrated.quant_bits) {
        if (body.match(/Q4_K_M|4-bit/i)) hydrated.quant_bits = 4;
        else if (body.match(/Q8_0|8-bit/i)) hydrated.quant_bits = 8;
    }
}

export function mineRelations(hydrated, meta) {
    const relSource = meta.extended || meta.relations || hydrated.relations || {};
    const toArray = (val) => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') {
            if (val.trim().startsWith('[') && val.trim().endsWith(']')) {
                try { const p = JSON.parse(val); if (Array.isArray(p)) return p; } catch (e) { }
            }
            return val.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    };

    hydrated.arxiv_refs = toArray(hydrated.arxiv_refs || relSource.arxiv_refs || relSource.arxiv_ids || relSource.citing_papers);
    hydrated.datasets_used = toArray(hydrated.datasets_used || relSource.datasets_used || relSource.training_data || relSource.used_datasets);
    hydrated.similar_models = toArray(hydrated.similar_models || relSource.similar_models || relSource.related_models);
    hydrated.base_model = hydrated.base_model || relSource.base_model || relSource.parent_model || null;

    // V15.21 Tag Mining (Updated for V2.0 prefixes)
    const tags = toArray(hydrated.tags || []);
    tags.forEach(tag => {
        if ((tag.startsWith('arxiv:') || tag.startsWith('arxiv--')) && !hydrated.arxiv_refs.includes(tag.split(/:|--/).pop())) {
            hydrated.arxiv_refs.push(tag.split(/:|--/).pop());
        }
        if ((tag.startsWith('dataset:') || tag.startsWith('dataset--')) && !hydrated.datasets_used.includes(tag.split(/:|--/).pop())) {
            hydrated.datasets_used.push(tag.split(/:|--/).pop());
        }
        if (tag.startsWith('base_model:') && !hydrated.base_model) hydrated.base_model = tag.substring(11);
    });

    hydrated.knowledge_links = hydrated.knowledge_links || [];
}
