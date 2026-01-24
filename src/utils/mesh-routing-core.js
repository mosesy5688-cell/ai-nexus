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

    // Comprehensive list of prefixes to strip
    const prefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec|knowledge|kb|report|arxiv|dataset|tool|replicate|github|huggingface|concept|paper|model|agent|space|hf)[:\-\/]+/;

    // Double pass to handle nested prefixes like replicate:meta/ or hf-model--
    result = result.replace(prefixes, '');
    result = result.replace(prefixes, '');

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
 * V16.4 Unified Routing logic to prevent 404s on Agent/Tool Mesh links.
 */
export function getRouteFromId(id, type = null) {
    const resolvedType = type || getTypeFromId(id);
    const cleanId = stripPrefix(id).replace(/--/g, '/');

    // Custom routing table
    const routeMap = {
        'knowledge': `/knowledge/${cleanId}`,
        'report': `/reports/${cleanId}`,
        'paper': `/paper/${cleanId}`,
        'dataset': `/dataset/${cleanId}`,
        'space': `/space/${cleanId}`,
        'agent': `/agent/${cleanId}`,
        'tool': `/tool/${cleanId}`
    };

    return routeMap[resolvedType] || `/model/${cleanId}`;
}
