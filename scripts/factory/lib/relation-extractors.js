import { normalizeId } from '../../utils/id-normalizer.js';

/**
 * Relation Extractors V14.5.2
 */

// STACK relation tool mappings
const KNOWN_TOOLS = {
    'vllm': 'tool--vllm--vllm',
    'ollama': 'tool--ollama--ollama',
    'llama.cpp': 'tool--ggerganov--llama.cpp',
    'tgi': 'tool--huggingface--text-generation-inference',
    'transformers': 'tool--huggingface--transformers',
    'langchain': 'tool--langchain-ai--langchain',
    'llamaindex': 'tool--run-llama--llama_index',
    'gguf': 'tool--ggerganov--llama.cpp',
    'exl2': 'tool--turboderp--exllamav2',
    'awq': 'tool--casper-hansen--autoawq',
    'gptq': 'tool--autogptq--autogptq',
    'moe': 'knowledge--what-is-moe',
    'rag': 'knowledge--what-is-rag',
    'quantization': 'knowledge--what-is-quantization',
    'agentic': 'knowledge--agentic-ai',
};

/** Helper to infer source from type for V2.1 compatibility */
function getNodeSource(id, type) {
    if (type === 'paper') return 'arxiv';
    if (type === 'agent' || type === 'tool') return 'github';
    if (type === 'dataset' || type === 'space') return 'huggingface';
    if (type === 'model') {
        if (id && id.startsWith('civitai')) return 'civitai';
        return 'huggingface';
    }
    return null;
}

/** Create relation object helper */
function rel(sourceId, sourceType, targetId, targetType, relType, conf = 1.0) {
    // V2.1 Standard: Ensure IDs are always canonicalized with source context
    const sourceS = getNodeSource(sourceId, sourceType);
    const targetS = getNodeSource(targetId, targetType);

    return {
        source_id: normalizeId(sourceId, sourceS, sourceType),
        source_type: sourceType,
        target_id: normalizeId(targetId, targetS, targetType),
        target_type: targetType,
        relation_type: relType,
        confidence: conf,
    };
}

/** Safe array conversion */
function toArray(val) {
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
}

/** Extract all relations from entity metadata */
export function extractEntityRelations(entity) {
    const relations = [];
    const id = entity.id || entity.slug;
    const type = entity.type || 'model';

    // BASED_ON: base_model field
    for (const t of toArray(entity.base_model)) {
        if (t?.length > 2) relations.push(rel(id, type, t, 'model', 'BASED_ON'));
    }

    // TRAINED_ON: datasets field
    for (const ds of toArray(entity.datasets || entity.datasets_used)) {
        if (ds?.length > 2) relations.push(rel(id, type, ds, 'dataset', 'TRAINED_ON'));
    }

    // CITES: paper references
    for (const p of toArray(entity.arxiv_refs || entity.paper_refs || entity.references)) {
        if (p?.length > 2) relations.push(rel(id, type, p, 'paper', 'CITES'));
    }

    // USES: models used by agent/space
    for (const m of toArray(entity.models_used || entity.models || entity.model_id)) {
        if (m?.length > 2) relations.push(rel(id, type, m, 'model', 'USES'));
    }

    // DEMO_OF: space with SDK
    if ((entity.sdk === 'gradio' || entity.sdk === 'streamlit') && entity.model_id) {
        relations.push(rel(id, 'space', entity.model_id, 'model', 'DEMO_OF', 0.9));
    }

    // IMPLEMENTS: paper implementations
    if (type === 'paper') {
        for (const impl of toArray(entity.implementations)) {
            if (impl?.length > 2) relations.push(rel(id, 'paper', impl, 'model', 'IMPLEMENTS'));
        }
    }

    // STACK: detect tools from tags/description
    if (type === 'model') {
        const text = [...(entity.tags || []), entity.description || '', entity.name || '']
            .join(' ').toLowerCase();
        for (const [kw, toolId] of Object.entries(KNOWN_TOOLS)) {
            if (text.includes(kw)) {
                relations.push({ ...rel(id, 'model', toolId, 'tool', 'STACK', 0.8), target_id: toolId });
            }
        }
    }

    // DEP: agent/tool dependencies
    if ((type === 'agent' || type === 'tool') && entity.dependencies) {
        for (const dep of toArray(entity.dependencies)) {
            if (dep?.length > 2) relations.push(rel(id, type, dep, 'tool', 'DEP'));
        }
    }

    // V15: FEATURES - Extract from "features" or "highlights"
    for (const f of toArray(entity.features || entity.highlights)) {
        if (f?.length > 2) relations.push(rel(id, type, f, 'concept', 'FEATURES', 0.9));
    }

    // V15: TRENDING - Detect from velocity if present
    if (entity.velocity > 0.5) {
        relations.push(rel(id, type, 'concept--trending-now', 'concept', 'TRENDING', 0.8));
    }

    // V15: EXPLAIN - Support for knowledge articles
    if (entity.knowledge_tags) {
        for (const kt of toArray(entity.knowledge_tags)) {
            relations.push(rel(id, type, kt, 'concept', 'EXPLAIN', 1.0));
        }
    }

    return relations;
}
