/**
 * Mesh Routing Core (V16.95 Restoration)
 * 
 * Strict Canonical Matching. No heuristics.
 * R2 Data is the ONLY Source of Truth.
 */

export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();

    // V2.0 Standard Prefixes - Supporting both current -- and legacy : formats
    const prefixes = [
        // Source-Specific Prefixes (SPEC-ID-V2.1)
        'hf-model--', 'hf-agent--', 'hf-tool--', 'hf-dataset--', 'hf-space--', 'hf-paper--', 'hf-collection--',
        'gh-model--', 'gh-agent--', 'gh-tool--', 'gh-repo--',
        'arxiv-paper--', 'arxiv--', 'paper--',
        'replicate-model--', 'replicate-agent--', 'replicate-space--',
        'civitai-model--', 'ollama-model--',
        'kaggle-dataset--', 'kaggle-model--',

        // Standardized Dual-Dash Legacy (SPEC-URL-V15.0/V16.2 Support)
        'huggingface--', 'github--', 'arxiv--', 'kaggle--', 'civitai--', 'ollama--', 'replicate--',

        // Legacy/Direct Format Mapping
        'huggingface:', 'github:', 'arxiv:', 'kaggle:', 'civitai:', 'ollama:', 'replicate:',
        'knowledge--', 'concept--', 'report--', 'dataset--', 'model--', 'agent--', 'tool--', 'space--'
    ];

    for (const p of prefixes) {
        if (result.startsWith(p)) {
            result = result.slice(p.length);
            break;
        }
    }

    // Standardize separators to dual-dash
    return result.replace(/[:\/]/g, '--').replace(/^--|--$/g, '');
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
    if (low.startsWith('gh-agent--') || low.startsWith('github-agent--') || low.startsWith('hf-agent--') || low.startsWith('replicate-agent--') || low.startsWith('agent--')) return 'agent';
    if (low.startsWith('gh-tool--') || low.startsWith('hf-tool--') || low.startsWith('github-tool--') || low.startsWith('tool--')) return 'tool';
    if (low.startsWith('gh-model--') || low.startsWith('hf-model--') || low.startsWith('replicate-model--') || low.startsWith('civitai-model--') || low.startsWith('ollama-model--')) return 'model';

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
 * V2.0 Routing logic - "What you see is what you fetch"
 * SLUG = Full Canonical ID (except for Knowledge/Reports which use slugs)
 */
export function getRouteFromId(id, type = null) {
    if (!id) return '#';

    let resolvedType = type || getTypeFromId(id);
    const lowId = id.toLowerCase();

    // V2.1 Rule: Clean SEO URL. Strip redundant technical prefixes and convert -- to /
    let slug = lowId;
    if (resolvedType === 'knowledge' || resolvedType === 'report') {
        slug = stripPrefix(id).replace(/--/g, '/');
        // V16.8.15: Fix double slash or redundant technical segments for reports
        if (resolvedType === 'report') {
            slug = slug.replace(/\/+/g, '-');
        }
        if (resolvedType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[slug]) {
            slug = KNOWLEDGE_ALIAS_MAP[slug];
        }
    } else {
        // For primary types (model, agent, etc.), strip the source-type-- prefix
        // V16.8.4 Fix: If the ID contains slashes already (pure HF style), don't inject extra -- logic
        const stripped = stripPrefix(id);
        slug = stripped.includes('/') ? stripped : stripped.replace(/--/g, '/');
    }

    const routeMap = {
        'knowledge': `/knowledge/${slug}`,
        'report': `/reports/${slug}`,
        'paper': `/paper/${slug}`,
        'dataset': `/dataset/${slug}`,
        'space': `/space/${slug}`,
        'agent': `/agent/${slug}`,
        'tool': `/tool/${slug}`,
        'model': `/model/${slug}`
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
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
