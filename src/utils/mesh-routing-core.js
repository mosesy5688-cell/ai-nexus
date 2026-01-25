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

    // V16.2 Canonical Prefixes ONLY
    const canonicalPrefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|knowledge|report|arxiv|dataset|tool|paper|model|agent|space)[:\-\/]+/;

    result = result.replace(canonicalPrefixes, '');

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

    // Safety: Ensure we never return a trailing slash (404 risk)
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
