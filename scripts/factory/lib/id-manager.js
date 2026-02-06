/**
 * SPEC-ID-V2.0: Canonical Entity Identity Manager
 * 
 * Target: [SOURCE]-[TYPE]--[OWNER]--[NAME]
 * Rule: All Lowercase, Double-Dash separator, Flat Storage mapping.
 */

/**
 * Generate V2.0 Canonical ID
 * @param {string} source - 'huggingface' | 'github' | 'arxiv'
 * @param {string} type - 'model' | 'paper' | 'tool' | 'agent' | 'space' | 'dataset'
 * @param {string} rawId - Original ID (e.g. 'meta-llama/Llama-2-7b' or '2301.12345')
 */
export function generateCanonicalId(source, type, rawId) {
    if (!rawId) throw new Error("Raw ID is required");

    // 1. Define prefix mapping (SPEC-ID-V2.0 Section 2)
    const prefixMap = {
        'huggingface': 'hf',
        'github': 'gh',
        'arxiv': 'arxiv'
    };

    const srcPrefix = prefixMap[source.toLowerCase()];
    if (!srcPrefix) throw new Error(`Unknown source: ${source}`);

    const cleanType = type.toLowerCase().trim();

    // 2. Base cleaning (Full Lowercase per Rule 1)
    let cleanRaw = rawId.toLowerCase().trim().replace(/v\d+$/, ''); // Strip version suffixes for ArXiv

    // 3. Construct ID (Double-Dash Protection per Rule 3)
    let finalId = '';

    if (source.toLowerCase() === 'arxiv') {
        // arxiv-paper--2301.12345
        finalId = `${srcPrefix}-${cleanType}--${cleanRaw}`;
    } else {
        // hf-model--meta-llama--llama-3 (Replace slash with double-dash)
        const parts = cleanRaw.split(/[\/:]/); // Support legacy slash or colon
        if (parts.length >= 2) {
            finalId = `${srcPrefix}-${cleanType}--${parts[0]}--${parts.slice(1).join('--')}`;
        } else {
            finalId = `${srcPrefix}-${cleanType}--${cleanRaw}`;
        }
    }

    // 4. Final sanitization (Allow only valid chars)
    return finalId.replace(/[^a-z0-9\-\.]/g, '-').replace(/-+/g, '-').replace(/--/g, '~~').replace(/-/g, '-').replace(/~~/g, '--');
}

/**
 * Parse ID for UI/Routing needs
 * @param {string} canonicalId 
 */
export function parseCanonicalId(canonicalId) {
    if (!canonicalId || !canonicalId.includes('--')) {
        return { source: 'unknown', type: 'unknown', owner: '', name: canonicalId };
    }

    const [sourceType, ...rest] = canonicalId.split('--');
    const [source, type] = sourceType.split('-');

    return {
        source, // hf, gh, arxiv
        type,   // model, tool, paper
        owner: rest.length > 1 ? rest[0] : '',
        name: rest.length > 1 ? rest.slice(1).join('--') : rest[0],
        slug: rest.join('/') // For legacy UI display
    };
}
