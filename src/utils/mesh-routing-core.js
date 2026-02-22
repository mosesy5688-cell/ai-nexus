/**
 * Mesh Routing Core (V16.95 Restoration)
 * 
 * Strict Canonical Matching. No heuristics.
 * R2 Data is the ONLY Source of Truth.
 */

export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();

    // V2.0 Standard Prefixes - Supporting both current -- and legacy : or / formats
    const prefixes = [
        // Source-Specific Prefixes (SPEC-ID-V2.1)
        'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
        'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
        'arxiv-paper', 'arxiv', 'paper',
        'replicate-model', 'replicate-agent', 'replicate-space',
        'civitai-model', 'ollama-model',
        'kaggle-dataset', 'kaggle-model',
        'langchain-prompt', 'langchain-agent',

        // Standardized Dual-Dash Legacy (SPEC-URL-V15.0/V16.2 Support)
        'huggingface', 'github', 'arxiv', 'kaggle', 'civitai', 'ollama', 'replicate',

        // Legacy/Direct Format Mapping
        'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt'
    ];

    for (const p of prefixes) {
        // Match prefix followed by --, :, /, or ending exactly with prefix
        const pLow = p.toLowerCase();
        if (result.startsWith(`${pLow}--`) || result.startsWith(`${pLow}:`) || result.startsWith(`${pLow}/`)) {
            result = result.slice(pLow.length + (result[pLow.length] === '-' ? 2 : 1));
            break;
        } else if (result.startsWith(`${pLow}-`) && !result.startsWith(`${pLow}--`)) {
            // Handle single dash edge case
            result = result.slice(pLow.length + 1);
            break;
        }
    }

    // V16.8.31: Dual-separator normalization (Support both -- and /)
    // V21.0: Aggressive normalization for all hf/gh/arxiv source patterns
    return result
        .replace(/[:\/]/g, '--')
        .replace(/^--|--$/g, '')
        .replace(/--+/g, '--');
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
    if (low.startsWith('arxiv-paper--') || low.startsWith('arxiv--') || low.startsWith('hf-paper--') || low.startsWith('paper--')) return 'paper';
    if (low.startsWith('hf-dataset--') || low.startsWith('kaggle-dataset--') || low.startsWith('dataset--')) return 'dataset';
    if (low.startsWith('hf-space--') || low.startsWith('space--')) return 'space';
    if (low.startsWith('gh-agent--') || low.startsWith('github-agent--') || low.startsWith('hf-agent--') || low.startsWith('replicate-agent--') || low.startsWith('langchain-agent--') || low.startsWith('agent--')) return 'agent';
    if (low.startsWith('gh-tool--') || low.startsWith('hf-tool--') || low.startsWith('github-tool--') || low.startsWith('tool--')) return 'tool';
    if (low.startsWith('hf-prompt--') || low.startsWith('prompt--')) return 'prompt';
    if (low.startsWith('gh-model--') || low.startsWith('hf-model--') || low.startsWith('replicate-model--') || low.startsWith('civitai-model--') || low.startsWith('ollama-model--') || low.startsWith('kaggle-model--')) return 'model';

    // V21.15.2: Detect ArXiv Category Patterns (cs.AI, stat.ML, etc.)
    if (low.match(/^(cs|stat|math|physics|q-bio|q-fin|econ|eess)\.[a-z]{2,8}$/)) return 'category';

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
    'mixture-of-experts': 'moe',
    'transformer-architecture': 'transformer'
};

/**
 * V2.0 Routing logic - "What you see is what you fetch"
 * SLUG = Full Canonical ID (except for Knowledge/Reports which use slugs)
 */
export function getRouteFromId(id, type = null) {
    if (!id || id === '#') return '#';

    // V21.15: Handle already-routed absolute paths
    if (id.startsWith('/') && !id.includes('--')) return id;

    const idDerivedType = getTypeFromId(id);
    // Explicit type or ID prefix or presence of -- triggers derived type logic
    let resolvedType = (id.startsWith('knowledge--') || id.startsWith('report--') || id.includes('--')) ? idDerivedType : (type || idDerivedType);

    let slug = '';
    const norm = stripPrefix(id);

    if (resolvedType === 'knowledge' || resolvedType === 'concept' || resolvedType === 'report') {
        const baseType = (resolvedType === 'report') ? 'report' : 'knowledge';
        slug = norm.replace(/--/g, '/');

        if (baseType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[slug]) {
            slug = KNOWLEDGE_ALIAS_MAP[slug];
        }

        const baseRoute = baseType === 'report' ? 'reports' : 'knowledge';
        return `/${baseRoute}/${slug}`;
    } else if (resolvedType === 'paper') {
        slug = norm.replace(/--/g, '.');
    } else {
        // V16.8.31 SEO RESTORATION: Use hierarchical / separator
        // Filter out empty segments to prevent // in URLs
        slug = norm.split('--').filter(Boolean).join('/');
    }

    if (!slug || slug === 'unknown') return '#';

    const routeMap = {
        'dataset': `/dataset/${slug}`,
        'space': `/space/${slug}`,
        'agent': `/agent/${slug}`,
        'tool': `/tool/${slug}`,
        'prompt': `/prompt/${slug}`,
        'model': `/model/${slug}`,
        'paper': `/paper/${slug}`,
        'report': `/reports/${slug}`,
        'knowledge': `/knowledge/${slug}`,
        // V21.15.2: Route categories to ranking filter
        'category': `/ranking/papers?category=${slug}`
    };

    const finalPath = routeMap[resolvedType] || `/model/${slug}`;
    return finalPath.endsWith('/') ? finalPath.slice(0, -1) : finalPath;
}

/**
 * V16.4: Consistent slug normalization for tags and relations.
 */
export function normalizeSlug(tag) {
    if (!tag || typeof tag !== 'string') return '';
    return tag.toLowerCase()
        .replace(/[^a-z0-9\.]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
