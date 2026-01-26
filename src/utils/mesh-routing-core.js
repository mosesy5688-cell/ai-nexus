/**
 * Mesh Routing Core (V16.11)
 * Decoupled routing and type discovery to ensure CES compliance.
 * V16.2: Strictly aligned with R2 SSOT prefixes.
 */

/**
 * Normalizes entity IDs to facilitate flexible matching across platforms.
 * V16.2: Precise prefix stripping to prevent ID mangling (Fixes c-- ghost nodes).
 */
export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';

    let result = id.toLowerCase();

    // V16.38: Reinforced Prefix Stripping (Absolute Start)
    // V16.60: Expanded to include all platform providers for global matching
    const canonicalPrefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface|huggingface_deepspec|replicate|github|knowledge|report|arxiv|dataset|datasets|tool|tools|paper|model|agent|agents|space|spaces|author|kaggle|concept)[:\-\/ ]+/i;

    result = result.replace(canonicalPrefixes, '');

    // V16.38: Recursive stripping for nested-prefix cases (e.g. hf-model--dataset--)
    let prev;
    do {
        prev = result;
        result = result.replace(canonicalPrefixes, '');
    } while (result !== prev);

    // V16.14: Strip common knowledge 'phrase noise'
    result = result.replace(/^what-is-/, '');

    // V16.14: Final Semantic Alias Mapper (Bridges Graph vs Index gaps)
    const aliases = {
        'mixture-of-experts': 'moe',
        'retrieval-augmented-generation': 'rag',
        'low-rank-augmentation': 'lora'
    };
    if (aliases[result]) result = aliases[result];

    // Standardize separators to double-dash per SPEC V16.2
    return result
        .replace(/:/g, '--')
        .replace(/\//g, '--')
        .replace(/^--|--$/g, ''); // Clean edges
}

/**
 * V16.11 Unified Type Discovery logic for the entire Knowledge Mesh.
 */
export function getTypeFromId(id) {
    if (!id || typeof id !== 'string') return 'model';
    const low = id.toLowerCase();

    // 1. Explicit Prefix Mapping (V16.2 Standard)
    if (low.includes('knowledge--') || low.includes('concept--')) return 'knowledge';
    if (low.includes('report--')) return 'report';
    if (low.includes('arxiv--') || low.includes('paper--') || low.match(/^arxiv:\d+/)) return 'paper';
    if (low.includes('dataset--') || low.includes('kaggle--')) return 'dataset';
    if (low.includes('space--')) return 'space';
    if (low.includes('agent--')) return 'agent';
    if (low.includes('tool--')) return 'tool';

    // 2. Platform Path Mapping (HF/GitHub fallback)
    if (low.includes('dataset/') || low.includes('datasets/')) return 'dataset';
    if (low.includes('space/') || low.includes('spaces/')) return 'space';
    if (low.includes('agent/') || low.includes('agents/')) return 'agent';
    if (low.includes('tool/') || low.includes('tools/')) return 'tool';

    // 3. Semantic Keyword Fallback (Only for naked IDs)
    if (!low.includes('/')) {
        const kWords = ['rag', 'moe', 'lora', 'llm', 'quant-'];
        if (kWords.some(k => low === k || low.startsWith(k))) return 'knowledge';
    } else {
        // Broad semantic indicators for non-canonical platform repos
        if (low.includes('-dataset') || low.includes('-classification') || low.includes('data-set')) return 'dataset';
        if (low.includes('-agent')) return 'agent';
        if (low.includes('bench')) return 'dataset';
    }

    return 'model';
}

/**
 * V16.11: Routing logic refined for R2 SSOT.
 * Removed local SLUG_MAPPING to ensure data integrity.
 */
export function getRouteFromId(id, type = null) {
    if (!id) return '#';

    let resolvedType = type || getTypeFromId(id);
    let rawId = stripPrefix(id);

    // V16.11: No more dynamic "Fundamentals" redirect in the core.
    // Routing is a direct map of the cleaned ID. 
    // Validation happens in the UI layer where the index is available.

    const cleanId = rawId.replace(/--/g, '/');

    // V16.38: Double-Deep Guard (Heuristic Correction)
    // If the path still contains entity markers but classified as model, pivot the type.
    if (resolvedType === 'model') {
        if (cleanId.includes('dataset/') || cleanId.includes('kaggle/') || cleanId.includes('-dataset') || cleanId.includes('-classification')) resolvedType = 'dataset';
        else if (cleanId.includes('agent/') || cleanId.includes('-agent')) resolvedType = 'agent';
        else if (cleanId.includes('tool/') || cleanId.includes('-tool-')) resolvedType = 'tool';
        else if (cleanId.includes('paper/') || cleanId.includes('arxiv/')) resolvedType = 'paper';
        else if (cleanId.includes('space/')) resolvedType = 'space';
        else if (cleanId.includes('knowledge/') || cleanId.includes('concept/')) resolvedType = 'knowledge';
    }

    // Direct platform redirect for external datasets (Zero-Limit Transparency)
    if (cleanId.startsWith('kaggle/')) {
        const p = cleanId.replace('kaggle/', '').split('/');
        if (p.length >= 2) return `https://www.kaggle.com/datasets/${p[0]}/${p[1]}`;
    }

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

    // V16.38: Final Sanity Strip (Prevents /model/dataset/ duplication if heuristic caught it)
    const checkDups = /^\/(model|agent|tool|dataset|paper|space|knowledge|report)\/(model|agent|tool|dataset|paper|space|knowledge|report)\//;
    const path = finalPath.replace(checkDups, '/$2/');

    // Safety: Ensure we never return a trailing slash (404 risk)
    return path.endsWith('/') ? path.slice(0, -1) : path;
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
