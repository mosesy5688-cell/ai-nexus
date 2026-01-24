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
    'direct-preference-optimization': 'dpo',
    'what-is-rag': 'rag',
    'local-deployment': 'local-inference',
    'what-is-quantization': 'quantization',
    'audio-models': 'multimodal',
    'agentic-ai': 'agents',
    'what-is-moe': 'moe',
    'mixture-of-experts': 'moe',
    'lora-finetuning': 'lora',
    'speech-models': 'multimodal',
    'inference-optimization': 'inference-optimization',
    'gguf-format': 'gguf',
    'ai-alignment': 'rlhf',
    'vision-models': 'multimodal',
    'attention-mechanism': 'transformer',
    'what-is-mmlu': 'mmlu',
    'what-is-humaneval': 'humaneval',
    'what-is-fni': 'fni',
    'what-is-transformer': 'transformer',
    'what-is-ollama': 'ollama',
    'multimodal-learning': 'multimodal',
    'llm-evaluation': 'llm-benchmarks',
    'inference': 'inference-optimization',
    'high-preformance': 'inference-optimization',
    'deep-learning': 'fundamentals',
    'neural-network': 'fundamentals',
    'vulkan': 'inference-optimization',
    'simd': 'inference-optimization',
    'mlir': 'inference-optimization',
    'riscv': 'local-inference',
    'onnx': 'inference-optimization',
    'pytorch': 'fundamentals',
    'tensorflow': 'fundamentals',
    'keras': 'fundamentals',
    'mxnet': 'fundamentals',
    'ncnn': 'inference-optimization',
    'ios': 'local-inference',
    'cpp': 'fundamentals',
    'c': 'fundamentals',
    'machine-learning': 'fundamentals',
    'algorithms': 'fundamentals'
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
        const parts = rawId.split('--').filter(Boolean);
        let slug = parts[parts.length - 1] || '';

        if (SLUG_MAPPING[slug]) {
            rawId = SLUG_MAPPING[slug];
        } else if (!slug) {
            return '/knowledge'; // Fallback for malformed ID
        } else {
            rawId = slug;
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

    const finalPath = routeMap[resolvedType] || `/model/${cleanId}`;

    // Safety: Ensure we never return a trailing slash knowledge link (404 risk)
    if (resolvedType === 'knowledge' && finalPath.endsWith('/')) {
        return '/knowledge';
    }

    return finalPath;
}

/**
 * V16.4: Consistent slug normalization for tags and relations.
 */
export function normalizeSlug(tag) {
    if (!tag || typeof tag !== 'string') return '';
    return tag.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
