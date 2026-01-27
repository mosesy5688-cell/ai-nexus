/**
 * V14.3 Entity Validation Utils
 * Validates entities for R2 cache path compatibility
 * 
 * Supports all L1 adapters: HF, ArXiv, CivitAI, GitHub, Ollama, Kaggle, etc.
 * 
 * @module l5/entity-validator
 */

// Sources with simple ID formats (no author/name required)
const SIMPLE_ID_SOURCES = [
    'arxiv', 'civitai', 'ollama', 'kaggle', 'replicate',
    'semanticscholar', 'deepspec', 'openllm', 'mcp', 'langchain'
];

/**
 * Check if entity has a valid cache path format
 * @param {Object} entity - Entity to validate
 * @returns {boolean} True if entity can be resolved to R2 cache path
 */
export function hasValidCachePath(entity) {
    const id = entity.id || entity.slug || entity.umid || '';
    if (!id) return false;

    const source = (entity.source || '').toLowerCase();
    const idLower = id.toLowerCase();

    // Check simple ID sources first
    for (const src of SIMPLE_ID_SOURCES) {
        if (source.includes(src) || idLower.startsWith(src + ':')) {
            return true;
        }
    }

    // V14.5: Check entity type prefixes (hf-space, hf-dataset, github-agent, mcp-server)
    // V16.96: Update for Universal Prefixing V2.0
    const TYPE_PREFIXES = [
        'hf-model--', 'hf-space--', 'hf-dataset--',
        'gh-model--', 'gh-tool--', 'gh-agent--',
        'arxiv-paper--', 'kaggle-dataset--', 'civitai-model--', 'ollama-model--',
        'github-agent--', 'mcp-server--', 'github--'
    ];
    for (const prefix of TYPE_PREFIXES) {
        if (idLower.startsWith(prefix)) {
            return true;
        }
    }

    // HuggingFace/GitHub: must have author/name format (contains / or :)
    // V16.96: accept colon as a valid separator for multi-part IDs
    const hasSeparator = id.includes('/') || id.includes(':');

    return hasSeparator;
}

/**
 * Filter entities to only those with valid R2 cache paths
 * @param {Array} entities - Array of entities
 * @returns {Array} Filtered entities
 */
export function filterValidEntities(entities) {
    const valid = entities.filter(hasValidCachePath);
    console.log(`📊 Filtered: ${valid.length}/${entities.length} entities have valid cache paths`);
    return valid;
}
