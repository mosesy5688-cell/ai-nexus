/**
 * Mesh Routing Core (V16.4)
 * Decoupled routing and type discovery to ensure CES compliance.
 */

/**
 * Normalizes entity IDs to facilitate flexible matching across platforms.
 */
export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';

    // Normalize to lowercase for consistent prefix matching
    let result = id.toLowerCase();

    // V16.4: Surgical Prefix Stripping (Fixes 404s)
    // ONLY strip the entity type markers, PRESERVE platform/author segments (github, hf, etc.)
    const schemaPrefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec|knowledge|kb|report|arxiv|dataset|tool|paper|model|agent|space|hf)[:\-\/]+/;

    result = result.replace(schemaPrefixes, '');

    // Standardize separators to double-dash per SPEC V16.2
    return result
        .replace(/:/g, '--')
        .replace(/\//g, '--');
}

/**
 * V16.4 Unified Type Discovery logic for the entire Knowledge Mesh.
 */
export function getTypeFromId(id) {
    if (!id || typeof id !== 'string') return 'model';
    const low = id.toLowerCase();
    if (low.includes('knowledge--') || low.includes('kb--') || low.includes('concept--')) return 'knowledge';
    if (low.includes('report--')) return 'report';
    if (low.includes('arxiv--') || low.includes('paper--')) return 'paper';
    if (low.includes('dataset--')) return 'dataset';
    if (low.includes('space--')) return 'space';
    if (low.includes('agent--')) return 'agent';
    if (low.includes('tool--')) return 'tool';
    return 'model';
}

/**
 * V16.4: Cross-Source Slug Redirects (Fixes 404s)
 * Standardized mapping to ensure knowledge links resolve to canonical slugs.
 */
export const SLUG_MAPPING = {
    'instruction-tuning': 'fine-tuning',
    'image-generation': 'multimodal',
    'chat-models': 'agents',
    'rag-retrieval': 'rag',
    'vector-databases': 'rag',
    'prompt-engineering': 'prompt-engineering',
    'transformer-architecture': 'transformer',
    'direct-preference-optimization': 'fine-tuning',
    'what-is-rag': 'rag',
    'local-deployment': 'local-inference',
    'what-is-quantization': 'quantization',
    'audio-models': 'multimodal',
    'agentic-ai': 'agents',
    'what-is-moe': 'moe',
    'mixture-of-experts': 'moe',
    'lora-finetuning': 'fine-tuning',
    'speech-models': 'multimodal',
    'inference-optimization': 'local-inference',
    'gguf-format': 'gguf',
    'ai-alignment': 'fine-tuning',
    'vision-models': 'multimodal',
    'attention-mechanism': 'transformer'
};

/**
 * V16.4 Unified Routing logic to prevent 404s on Agent/Tool Mesh links.
 */
export function getRouteFromId(id, type = null) {
    if (!id) return '#';

    let resolvedType = type || getTypeFromId(id);
    let rawId = stripPrefix(id);

    // Apply Global Redirect Mapping for Knowledge Nodes
    if (resolvedType === 'knowledge') {
        const slug = rawId.split('--').pop();
        if (SLUG_MAPPING[slug]) {
            rawId = rawId.replace(slug, SLUG_MAPPING[slug]);
        }
    }

    const cleanId = rawId.replace(/--/g, '/');

    // Custom routing table
    const routeMap = {
        'knowledge': `/knowledge/${cleanId}`,
        'report': `/reports/${cleanId}`,
        'paper': id.toLowerCase().includes('arxiv') ? `/paper/arxiv/${cleanId}` : `/paper/${cleanId}`,
        'dataset': `/dataset/${cleanId}`,
        'space': `/space/${cleanId}`,
        'agent': `/agent/${cleanId}`,
        'tool': `/tool/${cleanId}`
    };

    return routeMap[resolvedType] || `/model/${cleanId}`;
}
