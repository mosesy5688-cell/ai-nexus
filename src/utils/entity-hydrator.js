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

    hydrated.context_length = hydrated.context_length || meta.extended?.context_length || config.max_position_embeddings || config.n_ctx || config.max_seq_len || config.max_sequence_length || config.model_max_length || config.seq_length || config.n_positions;
    hydrated.architecture = hydrated.architecture || meta.extended?.architecture || config.model_type || config.architectures?.[0] || config.arch;
    hydrated.params_billions = parseFloat(hydrated.params_billions || meta.extended?.params_billions || config.num_parameters || config.n_params || 0) || null;

    hydrated.num_layers = hydrated.num_layers || config.num_hidden_layers || config.n_layer || config.n_layers;
    hydrated.hidden_size = hydrated.hidden_size || config.hidden_size || config.n_embd || config.d_model || config.dim;
    hydrated.num_heads = hydrated.num_heads || config.num_attention_heads || config.n_head || config.n_heads;

    if (!hydrated.body_content) {
        hydrated.body_content = entity.body_content || meta.readme || meta.model_card || meta.description || null;
    }

    // V16.1 Deep Dive Content Extraction
    hydrated.installation = meta.extended?.installation || meta.installation || null;
    hydrated.usage = meta.extended?.usage || meta.usage || meta.usage_example || null;
    hydrated.configuration = meta.extended?.config_guide || meta.configuration || meta.setup || null;
    hydrated.license_full = meta.extended?.license_text || meta.license || null;
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

    // V16.3 Semantic Tag-to-Knowledge Mapping
    const TAG_TO_KNOWLEDGE = {
        'text-generation': 'llm-benchmarks',
        'text2text-generation': 'llm-benchmarks',
        'text-classification': 'transformer',
        'conversational': 'agents',
        'question-answering': 'rag',
        'summarization': 'context-length',
        'translation': 'transformer',
        'fill-mask': 'transformer',
        'token-classification': 'transformer',
        'sentence-similarity': 'embeddings',
        'feature-extraction': 'embeddings',
        'text-embedding': 'embeddings',
        'image-text-to-text': 'multimodal',
        'image-to-text': 'multimodal',
        'visual-question-answering': 'multimodal',
        'text-to-image': 'multimodal',
        'image-classification': 'multimodal',
        'object-detection': 'multimodal',
        'moe': 'moe',
        'mixture-of-experts': 'moe',
        'gguf': 'gguf',
        'quantized': 'quantization',
        '4bit': 'quantization',
        '8bit': 'quantization',
        'awq': 'quantization',
        'gptq': 'quantization',
        'lora': 'fine-tuning',
        'peft': 'fine-tuning',
        'rlhf': 'fine-tuning',
        'dpo': 'fine-tuning',
        'vram': 'vram',
        'ollama': 'ollama',
        'huggingface': 'huggingface',
        'rag': 'rag',
        'retrieval': 'rag',
        'local-inference': 'local-inference',
        'local': 'local-inference',
        'prompt': 'prompt-engineering'
    };

    hydrated.knowledge_links = hydrated.knowledge_links || [];
    tags.forEach(tag => {
        const normalizedTag = tag.toLowerCase().trim();
        const knowledgeSlug = TAG_TO_KNOWLEDGE[normalizedTag];
        if (knowledgeSlug && !hydrated.knowledge_links.find(k => k.slug === knowledgeSlug)) {
            hydrated.knowledge_links.push({ slug: knowledgeSlug, title: knowledgeSlug.replace(/-/g, ' ').toUpperCase(), icon: '🧠' });
        }
    });
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
