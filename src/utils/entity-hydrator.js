/**
 * Unified Entity Hydrator (V15.22)
 * CES Compliance: Refactored to honor < 250 lines rule.
 */
import { applyVramLogic } from './entity-vram-logic.js';
import { handleModelType, handlePaperType, handleGenericType } from './entity-type-handlers.js';

export function hydrateEntity(data, type, summaryData) {
    if (!data) return null;

    const entity = data.entity || data;
    const computed = data.computed || {};
    const seo = data.seo || {};

    let meta = {};
    try {
        if (entity.meta_json) {
            meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : entity.meta_json;
        }
    } catch (e) {
        console.warn('[Hydrator] meta_json parse error:', e.message);
    }

    const derivedName = entity.name || entity.title || entity.pretty_name || (entity.id ? entity.id.split('--').pop() : 'Unknown');

    const hydrated = {
        ...entity,
        meta: meta,
        fni_score: computed.fni ?? entity.fni_score ?? entity.fni ?? 0,
        fni_percentile: computed.fni_percentile ?? entity.fni_percentile ?? entity.percentile,
        fni_commentary: computed.fni_commentary || entity.fni_commentary || meta.fni?.commentary || null,
        fni_metrics: computed.fni_metrics || entity.fni_metrics || meta.fni?.metrics || {},
        name: derivedName,
        relations: computed.relations || entity.relations || meta.extended?.relations || {},
        _computed: computed,
        _seo: seo,
        _hydrated: true
    };

    beautifyName(hydrated);
    if (summaryData) attemptWarmCacheFallback(hydrated, summaryData);
    extractTechSpecs(hydrated, entity, meta);
    mineRelations(hydrated, meta);

    // Type-specific logic moved to handlers
    if (type === 'model') handleModelType(hydrated, entity, computed, meta, derivedName);
    else if (type === 'paper') handlePaperType(hydrated, entity, meta, derivedName);
    else handleGenericType(hydrated, entity, type, meta, derivedName);

    // Elastic Parameter Inference
    if (!hydrated.params_billions || hydrated.params_billions <= 0) {
        const idStr = (hydrated.id || '').toLowerCase();
        const paramMatch = idStr.match(/(\d+)([bm])$/);
        if (paramMatch) {
            const val = parseFloat(paramMatch[1]);
            const unit = paramMatch[2];
            hydrated.params_billions = unit === 'b' ? val : val / 1000;
        }
    }

    if (type === 'model') applyVramLogic(hydrated);
    return hydrated;
}

function beautifyName(hydrated) {
    const isSlug = hydrated.name && !hydrated.name.includes(' ') && (hydrated.name.includes('-') || hydrated.name.includes('_'));
    if (!hydrated.name || hydrated.name === hydrated.id || isSlug) {
        const parts = (hydrated.id || '').split('--').pop()?.split('/') || [];
        const rawName = parts.pop() || hydrated.id || 'Unknown Entity';
        hydrated.name = rawName.replace(/[-_]/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
}

function attemptWarmCacheFallback(hydrated, summaryData) {
    if (!Array.isArray(summaryData)) return;
    if (hydrated.params_billions && hydrated.downloads) return;

    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const searchId = norm(hydrated.id || '').replace(/^hf-model-/, '');
    const fallback = summaryData.find(s => {
        const sid = norm(s.id || s.umid || s.slug || '').replace(/^hf-model-/, '');
        return sid === searchId || sid.endsWith('-' + searchId) || searchId.endsWith('-' + sid) || sid === norm(hydrated.slug);
    });

    if (fallback) {
        hydrated.params_billions = hydrated.params_billions || fallback.params_billions;
        hydrated.downloads = hydrated.downloads || fallback.downloads;
        hydrated.likes = hydrated.likes || fallback.likes || fallback.stars;
        hydrated.context_length = hydrated.context_length || fallback.context_length;
        hydrated.fni_score = hydrated.fni_score || fallback.fni_score || fallback.fni;
    }
}

function extractTechSpecs(hydrated, entity, meta) {
    const config = entity.config || meta.config || meta.extended?.config || {};

    // V16.96: Enhanced extraction from nested config (Ghost Fields)
    const getVal = (paths, fallback = null) => {
        for (const path of paths) {
            const val = path.split('.').reduce((obj, key) => obj?.[key], config);
            if (val !== undefined && val !== null) return val;
        }
        return fallback;
    };

    hydrated.context_length = hydrated.context_length || meta.extended?.context_length ||
        getVal(['max_position_embeddings', 'n_ctx', 'max_seq_len', 'max_sequence_length', 'model_max_length', 'seq_length', 'n_positions']);

    hydrated.architecture = hydrated.architecture || meta.extended?.architecture ||
        getVal(['model_type', 'architectures.0', 'arch']);

    hydrated.params_billions = parseFloat(hydrated.params_billions || meta.extended?.params_billions ||
        getVal(['num_parameters', 'n_params', 'safetensors.total']) || 0) || null;

    // V16.20: Heuristic Parameter Extraction from Name
    if (!hydrated.params_billions && hydrated.name) {
        // Match 7b, 7B, 7.5b, 70B etc.
        const pMatch = hydrated.name.match(/(\d+(\.\d+)?)\s?[Bb]([iI][lL])?/);
        if (pMatch) hydrated.params_billions = parseFloat(pMatch[1]);
    }

    // V16.20: Heuristic Context Extraction from Name (e.g. 128k, 32K)
    if (!hydrated.context_length && hydrated.name) {
        const cMatch = hydrated.name.match(/(\d+)\s?[Kk]([wW]|[tT])?/);
        if (cMatch) {
            const kVal = parseInt(cMatch[1]);
            if (!isNaN(kVal)) hydrated.context_length = kVal * 1024;
        }
    }

    // V16.21: Parameter-Scale Defaults for Sparse LLMs
    if (!hydrated.context_length && hydrated.params_billions) {
        hydrated.context_length = 4096; // Conservative default for modern LLMs
    }

    hydrated.num_layers = hydrated.num_layers || config.num_hidden_layers || config.n_layer || config.n_layers;
    hydrated.hidden_size = hydrated.hidden_size || config.hidden_size || config.n_embd || config.d_model || config.dim;
    hydrated.num_heads = hydrated.num_heads || config.num_attention_heads || config.n_head || config.n_heads;

    // V16.5: MoE & Ghost Field Extraction
    hydrated.moe_experts = getVal(['num_local_experts', 'num_experts', 'n_experts', 'moe.num_experts']);
    hydrated.moe_active = getVal(['num_experts_per_tok', 'num_active_experts', 'n_active_experts']);
    hydrated.kv_heads = getVal(['num_key_value_heads', 'multi_query_attention', 'n_kv_heads']);
    hydrated.vocab_size = getVal(['vocab_size', 'n_vocab']);
    hydrated.tie_weights = getVal(['tie_word_embeddings'], false);

    if (!hydrated.body_content) {
        hydrated.body_content = entity.body_content || entity.readme || meta.readme || meta.model_card || meta.description || meta.abstract || null;
    }

    // V16.5: Heuristic README Mining (Deep Spec Recovery)
    heuristicMining(hydrated);

    // Auto-extract gallery images from body content
    if (hydrated.body_content && (!hydrated.gallery_images || hydrated.gallery_images.length === 0)) {
        const imgRegex = /!\[.*?\]\((.*?)\)/g;
        const images = [];
        let m;
        while ((m = imgRegex.exec(hydrated.body_content)) !== null) {
            if (m[1] && !images.includes(m[1])) images.push(m[1]);
        }
        hydrated.gallery_images = images.slice(0, 6);
    }
}

function heuristicMining(hydrated) {
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

function mineRelations(hydrated, meta) {
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

    // V15.21 Tag Mining
    const tags = toArray(hydrated.tags || []);
    tags.forEach(tag => {
        if (tag.startsWith('arxiv:') && !hydrated.arxiv_refs.includes(tag.substring(6))) hydrated.arxiv_refs.push(tag.substring(6));
        if (tag.startsWith('dataset:') && !hydrated.datasets_used.includes(tag.substring(8))) hydrated.datasets_used.push(tag.substring(8));
        if (tag.startsWith('base_model:') && !hydrated.base_model) hydrated.base_model = tag.substring(11);
    });

    hydrated.knowledge_links = hydrated.knowledge_links || [];
}


export function augmentEntity(hydrated, summaryData) {
    if (!hydrated || !summaryData) return hydrated;
    ['params_billions', 'context_length', 'mmlu', 'humaneval', 'hellaswag', 'arc_challenge', 'avg_score', 'fni_score', 'fni_percentile'].forEach(key => {
        if (summaryData[key] !== undefined && !hydrated[key]) hydrated[key] = summaryData[key];
    });
    if (summaryData.architecture_family && !hydrated.architecture) hydrated.architecture = summaryData.architecture_family;
    if (hydrated.params_billions && !hydrated.vram_gb) applyVramLogic(hydrated);
    return hydrated;
}
