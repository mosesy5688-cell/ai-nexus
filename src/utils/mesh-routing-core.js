/**
 * Mesh Routing Core (V16.95 Restoration)
 * 
 * Strict Canonical Matching. No heuristics.
 * R2 Data is the ONLY Source of Truth.
 */

export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();

    // V2.0 Standard Prefixes - SSOT (Matrix Extension)
    const prefixes = [
        'hf-model--', 'hf-agent--', 'hf-tool--', 'hf-dataset--', 'hf-space--', 'hf-paper--', 'hf-collection--',
        'gh-model--', 'gh-agent--', 'gh-tool--', 'gh-repo--',
        'arxiv-paper--', 'kaggle-dataset--', 'kaggle-model--', 'civitai-model--', 'ollama-model--',
        'replicate-model--', 'mcp-server--', 'langchain-agent--', 'langchain-prompt--',
        'huggingface-deepspec--', 'huggingface_deepspec--', 'huggingface--', 'github-agent--', 'github-tool--', 'github--',
        'knowledge--', 'concept--', 'paper--', 'report--', 'arxiv--', 'replicate:', 'replicate--', 'kaggle--', 'civitai--', 'ollama--', 'author--',
        'model--', 'agent--', 'tool--', 'dataset--', 'space--'
    ];

    for (const p of prefixes) {
        if (result.startsWith(p)) {
            result = result.slice(p.length);
            break;
        }
    }

    // Standardize separators to dual-dash and clean edges (Restore/Cleanup Phase)
    return result.replace(/[\/:]/g, '--').replace(/^--|--$/g, '');
}

export const isMatch = (a, b) => {
    if (!a || !b) return false;
    const aNorm = stripPrefix(a);
    const bNorm = stripPrefix(b);
    return aNorm !== '' && aNorm === bNorm;
};

/**
 * V16.95: Content Type Discovery based strictly on SSOT prefixes.
 */
export function getTypeFromId(id) {
    if (!id || typeof id !== 'string') return 'model';
    const low = id.toLowerCase();

    if (low.startsWith('knowledge--') || low.startsWith('concept--')) return 'knowledge';
    if (low.startsWith('report--')) return 'report';
    if (low.startsWith('arxiv-paper--') || low.startsWith('arxiv--') || low.startsWith('paper--')) return 'paper';
    if (low.startsWith('hf-dataset--') || low.startsWith('kaggle-dataset--') || low.startsWith('dataset--')) return 'dataset';
    if (low.startsWith('hf-space--') || low.startsWith('space--')) return 'space';
    if (low.startsWith('gh-agent--') || low.startsWith('github-agent--') || low.startsWith('agent--')) return 'agent';
    if (low.startsWith('gh-tool--') || low.startsWith('hf-tool--') || low.startsWith('github-tool--') || low.startsWith('tool--')) return 'tool';
    if (low.startsWith('gh-model--') || low.startsWith('hf-model--')) return 'model';

    return 'model';
}

/**
 * V16.96: Knowledge Alias Map
 * Maps technical terms and legacy slugs to canonical articles.
 */
export const KNOWLEDGE_ALIAS_MAP = {
    'instruction-tuning': 'fine-tuning',
    'image-generation': 'multimodal',
    'chat-models': 'large-language-model',
    'rlhf': 'fine-tuning',
    'direct-preference-optimization': 'fine-tuning',
    'context-window': 'context-length',
    'mixture-of-experts': 'moe'
};

/**
 * V16.95: Routing logic strictly mapping IDs to paths.
 */
export function getRouteFromId(id, type = null) {
    if (!id) return '#';

    let resolvedType = type || getTypeFromId(id);
    let rawId = stripPrefix(id);

    // Apply aliasing for knowledge articles
    if (resolvedType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[rawId]) {
        rawId = KNOWLEDGE_ALIAS_MAP[rawId];
    }

    const cleanId = rawId.replace(/--/g, '/');
    const lowId = id.toLowerCase();

    // Direct platform redirect for external datasets (Kaggle/Source Logic)
    if (lowId.includes('kaggle-dataset--') || lowId.includes('kaggle--')) {
        const parts = cleanId.split('/');
        if (parts.length >= 2) return `https://www.kaggle.com/datasets/${parts[0]}/${parts[1]}`;
    }

    const routeMap = {
        'knowledge': `/knowledge/${cleanId}`,
        'report': `/reports/${cleanId}`,
        'paper': `/paper/${cleanId}`,
        'dataset': `/dataset/${cleanId}`,
        'space': `/space/${cleanId}`,
        'agent': `/agent/${cleanId}`,
        'tool': `/tool/${cleanId}`,
        'model': `/model/${cleanId}`
    };

    const finalPath = routeMap[resolvedType] || `/model/${cleanId}`;

    // Safety: Ensure we never return a trailing slash
    return finalPath.endsWith('/') ? finalPath.slice(0, -1) : finalPath;
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
