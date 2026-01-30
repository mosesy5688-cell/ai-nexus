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
    },
    replicate: {
        model: 'replicate-model--',
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

    // 1. Initial Cleanup: Remove file artifacts and normalize delimiters
    let cleanId = id.replace(/\.json$/, '').replace(/[\/:]/g, '--');

    // 2. Identify and Strip ALL known prefixes (Recursive/Multi-pass)
    // We map prefixes to hints for source (s) and type (t)
    const knownPrefixes = {
        'hf-model--': { s: 'hf', t: 'model' },
        'hf-dataset--': { s: 'hf', t: 'dataset' },
        'hf-space--': { s: 'hf', t: 'space' },
        'gh-agent--': { s: 'gh', t: 'agent' },
        'gh-tool--': { s: 'gh', t: 'tool' },
        'arxiv-paper--': { s: 'arxiv', t: 'paper' },
        'civitai-model--': { s: 'civitai', t: 'model' },
        'kaggle-dataset--': { s: 'kaggle', t: 'dataset' },
        'huggingface--': { s: 'hf' },
        'github--': { s: 'gh' },
        'arxiv--': { s: 'arxiv' },
        'paper--': { t: 'paper' },
        'model--': { t: 'model' },
        'dataset--': { t: 'dataset' },
        'space--': { t: 'space' },
        'agent--': { t: 'agent' },
        'tool--': { t: 'tool' },
        'civitai--': { s: 'civitai' },
        'kaggle--': { s: 'kaggle' },
        'replicate--': { s: 'replicate' },
        'replicate-model--': { s: 'replicate', t: 'model' },
        'hf--': { s: 'hf' },
        'gh--': { s: 'gh' }
    };

    let hintS = null;
    let hintT = null;
    let stripped = true;

    while (stripped) {
        stripped = false;
        // Sort keys by length DESC to ensure longest match (canonical) is preferred over short legacy prefixes
        const keys = Object.keys(knownPrefixes).sort((a, b) => b.length - a.length);
        for (const p of keys) {
            if (cleanId.startsWith(p)) {
                const hint = knownPrefixes[p];
                if (hint.s) hintS = hint.s;
                if (hint.t) hintT = hint.t;
                cleanId = cleanId.slice(p.length);
                stripped = true;
                break;
            }
        }
    }

    // 3. Resolve Final Source and Type
    let s = (source || hintS || '').toLowerCase();
    let t = (type || hintT || '').toLowerCase();

    // Canonical normalization
    if (s === 'huggingface') s = 'hf';
    if (s === 'github') s = 'gh';

    // Contextual Guessing (Fallback)
    if (!s) {
        if (id.includes('github.com')) s = 'gh';
        else if (id.includes('huggingface.co')) s = 'hf';
        else s = 'hf'; // System default
    }

    if (!t) {
        if (s === 'arxiv') t = 'paper';
        else if (s === 'gh') t = 'agent';
        else t = 'model';
    }

    const prefix = PREFIX_MAP[s]?.[t];

    // 4. Final Assembly
    return prefix ? `${prefix}${cleanId}` : cleanId;
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

