import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { evidenceElement, methodForVerb } from './evidence-carrier.js';

/**
 * Relation Extractors V14.5.2
 *
 * D0a (source_trail): each emitted relation carries a LOGICAL 2A EvidenceElement
 * on `_evidence` (the WHY). The relations-generator interns it into the per-graph
 * evidence dictionary and replaces it with a COMPACT ref (spec 2B) -- the edge
 * NEVER stores the fat object. source_url = the SOURCE entity's source_url
 * (registry-loader projectEntityForRelations:245); null when absent (honest).
 */

// STACK relation tool mappings
const KNOWN_TOOLS = {
    'vllm': 'gh-tool--vllm--vllm',
    'ollama': 'gh-tool--ollama--ollama',
    'llama.cpp': 'gh-tool--ggerganov--llama.cpp',
    'tgi': 'hf-tool--huggingface--text-generation-inference',
    'transformers': 'hf-tool--huggingface--transformers',
    'langchain': 'gh-tool--langchain-ai--langchain',
    'llamaindex': 'gh-tool--run-llama--llama_index',
    'gguf': 'gh-tool--ggerganov--llama.cpp',
    'exl2': 'gh-tool--turboderp--exllamav2',
    'awq': 'gh-tool--casper-hansen--autoawq',
    'gptq': 'gh-tool--autogptq--autogptq',
    'moe': 'knowledge--what-is-moe',
    'rag': 'knowledge--what-is-rag',
    'quantization': 'knowledge--what-is-quantization',
    'agentic': 'knowledge--agentic-ai',
};


// V27.94 hotfix: relation projection now carries source fields (model_id,
// knowledge_tags, etc.) that may be non-string (e.g. numeric model_id). A
// non-string / too-short id is BAD DATA - skip it, never coerce/fabricate.
const isValidRelId = (v) => typeof v === 'string' && v.length > 2;

/**
 * Create relation object helper (returns null when either id is invalid).
 * `ev` = { source_field, source_url } for the D0a source_trail element: the raw
 * ref value is the un-normalized targetId; method derives from the verb.
 */
function rel(sourceId, sourceType, targetId, targetType, relType, conf = 1.0, ev = {}) {
    // V27.94 hotfix: drop edge if either id is non-string/too-short bad data.
    if (!isValidRelId(sourceId) || !isValidRelId(targetId)) return null;

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
        // D0a 2A logical EvidenceElement (interned -> compact ref by the generator).
        _evidence: evidenceElement({
            signal: ev.source_field || relType, value: targetId,
            source_field: ev.source_field || relType, method: methodForVerb(relType),
            producer: 'rel_extractor', source_url: ev.source_url ?? null,
        }),
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
    // D0a: the source entity source_url is the in-scope evidence for every edge
    // this entity emits (projectEntityForRelations:245 carries it). null = honest.
    const su = entity.source_url || null;
    const ev = (source_field) => ({ source_field, source_url: su });

    // V27.94 hotfix: push only when rel() returns a real edge (it returns null
    // for non-string/too-short ids - e.g. a numeric source id from projection).
    const push = (r) => { if (r) relations.push(r); };

    // BASED_ON: base_model field
    for (const t of toArray(entity.base_model)) {
        if (t?.length > 2) push(rel(id, type, t, 'model', 'BASED_ON', 1.0, ev('base_model')));
    }

    // TRAINED_ON: datasets field. A benchmark's dataset ref is the data it
    // measures on, not training data — emit USES (semantically correct), never
    // the model-centric TRAINED_ON. (benchmark 5th-type type-guard, panel R2.)
    const datasetRel = type === 'benchmark' ? 'USES' : 'TRAINED_ON';
    for (const ds of toArray(entity.datasets || entity.datasets_used)) {
        if (ds?.length > 2) push(rel(id, type, ds, 'dataset', datasetRel, 1.0, ev('datasets')));
    }

    // CITES: paper references
    for (const p of toArray(entity.arxiv_refs || entity.paper_refs || entity.references)) {
        if (p?.length > 2) push(rel(id, type, p, 'paper', 'CITES', 1.0, ev('arxiv_refs')));
    }

    // USES: models used by agent/space
    for (const m of toArray(entity.models_used || entity.models || entity.model_id)) {
        if (m?.length > 2) push(rel(id, type, m, 'model', 'USES', 1.0, ev('models_used')));
    }

    // EVALUATED_ON: model -> benchmark (5th-type identity-edge generator).
    // entity.benchmarks is an OBJECT { ifeval, bbh, math_lvl5, gpqa, musr,
    // mmlu_pro, average, name } keyed by the RAW V2_COLUMNS value (the same key
    // used as the benchmark node canonical-id suffix — single source of truth, so
    // no separator drift / orphan edges). Membership-derived (a score key means
    // this model was evaluated on that sub-benchmark), never parsed from free
    // text. EXCLUDE both `average` (a derived aggregate, not a benchmark) AND
    // `name` (the model display name carried alongside scores) — both are poison
    // keys that would mint phantom benchmark nodes.
    if (type === 'model' && entity.benchmarks && typeof entity.benchmarks === 'object'
        && !Array.isArray(entity.benchmarks)) {
        const EXCLUDED_BENCH_KEYS = new Set(['average', 'name']);
        for (const benchId of Object.keys(entity.benchmarks)) {
            if (EXCLUDED_BENCH_KEYS.has(benchId)) continue;
            const targetId = `benchmark--openllm--${benchId}`;
            push(rel(id, 'model', targetId, 'benchmark', 'EVALUATED_ON', 1.0, ev('benchmarks')));
        }
    }

    // DEMO_OF: space with SDK
    // V27.94 hotfix: entity.model_id may be numeric now - rel() skips non-string.
    if ((entity.sdk === 'gradio' || entity.sdk === 'streamlit') && entity.model_id) {
        push(rel(id, 'space', entity.model_id, 'model', 'DEMO_OF', 0.9, ev('model_id')));
    }

    // IMPLEMENTS: paper implementations
    if (type === 'paper') {
        for (const impl of toArray(entity.implementations)) {
            if (impl?.length > 2) push(rel(id, 'paper', impl, 'model', 'IMPLEMENTS', 1.0, ev('implementations')));
        }
    }

    // STACK: detect tools from tags/description
    if (type === 'model') {
        const text = [...(entity.tags || []), entity.description || '', entity.name || '']
            .join(' ').toLowerCase();
        for (const [kw, toolId] of Object.entries(KNOWN_TOOLS)) {
            if (text.includes(kw)) {
                // V27.94 hotfix: guard the spread - rel() may return null.
                const r = rel(id, 'model', toolId, 'tool', 'STACK', 0.8, ev('tags'));
                if (r) relations.push({ ...r, target_id: toolId }); // _evidence preserved by spread
            }
        }
    }

    // DEP: agent/tool dependencies
    if ((type === 'agent' || type === 'tool') && entity.dependencies) {
        for (const dep of toArray(entity.dependencies)) {
            if (dep?.length > 2) push(rel(id, type, dep, 'tool', 'DEP', 1.0, ev('dependencies')));
        }
    }

    // V15: FEATURES - Extract from "features" or "highlights"
    for (const f of toArray(entity.features || entity.highlights)) {
        if (f?.length > 2) push(rel(id, type, f, 'concept', 'FEATURES', 0.9, ev('features')));
    }

    // V15: TRENDING - Detect from velocity if present. Structural (velocity, not
    // an external cross-ref) -> sentinel method via methodForVerb('TRENDING').
    if (entity.velocity > 0.5) {
        push(rel(id, type, 'concept--trending-now', 'concept', 'TRENDING', 0.8, ev('velocity')));
    }

    // V15: EXPLAIN - Support for knowledge articles
    // V27.94 hotfix: knowledge_tags may contain numeric entries - rel() skips them.
    if (entity.knowledge_tags) {
        for (const kt of toArray(entity.knowledge_tags)) {
            push(rel(id, type, kt, 'concept', 'EXPLAIN', 1.0, ev('knowledge_tags')));
        }
    }

    return relations;
}
