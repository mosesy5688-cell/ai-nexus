/**
 * Universal Identity Normalizer V2.1
 * SPEC: Universal Prefixing Standard (V2.1 - Final)
 * 
 * Centralized logic for entity ID normalization to ensure 
 * 100% architectural consistency.
 */

const PREFIX_MAP = {
    hf: {
        model: 'hf-model--',
        dataset: 'hf-dataset--',
        space: 'hf-space--',
    },
    gh: {
        agent: 'gh-agent--',
        tool: 'gh-tool--',
    },
    arxiv: {
        paper: 'arxiv-paper--',
    },
    civitai: {
        model: 'civitai-model--',
    },
    kaggle: {
        dataset: 'kaggle-dataset--',
    }
};

const ALL_PREFIXES = Object.values(PREFIX_MAP).flatMap(source => Object.values(source));

/**
 * Normalize an entity ID based on source and type
 * @param {string} id - Raw ID (e.g., "meta-llama/Llama-2")
 * @param {string} source - Origin source (huggingface, github, etc.)
 * @param {string} type - Entity type (model, dataset, etc.)
 * @returns {string} Canonical ID (e.g., "hf-model--meta-llama--Llama-2")
 */
export function normalizeId(id, source, type) {
    if (!id) return null;

    // 1. Cleanup: Remove .json suffix if present (R2 filename artifact)
    let cleanId = id.replace(/\.json$/, '');

    // 2. Transmutation: Replace slashes and colons with double-hyphens
    cleanId = cleanId.replace(/[\/:]/g, '--');

    // Legacy Prefix Stripping to prevent Double-Prefixing (huggingface-- -> hf-model--)
    const legacyPrefixes = ['huggingface--', 'github--', 'arxiv--', 'paper--', 'civitai--', 'kaggle--'];
    for (const lp of legacyPrefixes) {
        if (cleanId.startsWith(lp)) {
            cleanId = cleanId.slice(lp.length);
            break;
        }
    }

    // 3. Idempotency Check (V2.1 Logic)
    // If the ID already starts with any canonical prefix, it's considered normalized.
    if (ALL_PREFIXES.some(p => cleanId.startsWith(p))) {
        return cleanId;
    }

    // 4. Source/Type Mapping fallbacks
    let normalizedSource = (source || '').toLowerCase();

    // Alias mapping for V2.0 Standard
    if (normalizedSource === 'huggingface') normalizedSource = 'hf';
    if (normalizedSource === 'github') normalizedSource = 'gh';

    let normalizedType = (type || '').toLowerCase();

    // Contextual guessing if source/type is missing
    if (!normalizedSource && (cleanId.includes('--') || id.includes('/'))) {
        normalizedSource = 'huggingface'; // Default high-traffic origin
    }
    if (!normalizedType && normalizedSource === 'arxiv') {
        normalizedType = 'paper';
    } else if (!normalizedType && (normalizedSource === 'huggingface' || normalizedSource === 'civitai')) {
        normalizedType = 'model';
    }

    const prefix = PREFIX_MAP[normalizedSource]?.[normalizedType];

    // 5. Final Assembly
    if (prefix) {
        return `${prefix}${cleanId}`;
    }

    // Final fallback if no prefix mapping matches
    return cleanId;
}

/** Helper to infer source from type for V2.0 compatibility */
export function getNodeSource(id, type) {
    if (type === 'paper') return 'arxiv';
    if (type === 'agent' || type === 'tool') return 'gh';
    if (type === 'dataset' || type === 'space') return 'hf';
    if (type === 'model') {
        if (id && id.startsWith('civitai')) return 'civitai';
        return 'hf';
    }
    return null;
}

// CommonJS compatibility for legacy scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeId, getNodeSource, PREFIX_MAP, ALL_PREFIXES };
}

