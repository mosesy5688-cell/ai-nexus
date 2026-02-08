/**
 * Universal Identity Normalizer V2.1
 * SPEC: Universal Prefixing Standard (V2.1 - Final)
 * 
 * Centralized logic for entity ID normalization to ensure 
 * 100% architectural consistency.
 */

export const PREFIX_MAP = {
    hf: {
        model: 'hf-model--',
        dataset: 'hf-dataset--',
        space: 'hf-space--',
        agent: 'hf-agent--',
        paper: 'hf-paper--',
        collection: 'hf-collection--',
        tool: 'hf-tool--',
    },

    gh: {
        agent: 'gh-agent--',
        tool: 'gh-tool--',
        model: 'gh-model--',
        repo: 'gh-repo--',
    },
    arxiv: {
        paper: 'arxiv-paper--',
    },
    civitai: {
        model: 'civitai-model--',
    },
    kaggle: {
        dataset: 'kaggle-dataset--',
        model: 'kaggle-model--',
    },
    replicate: {
        model: 'replicate-model--',
    },
    ollama: {
        model: 'ollama-model--',
    },
    knowledge: {
        concept: 'knowledge--',
    },
    report: {
        weekly: 'report--',
    }
};

export const ALL_PREFIXES = Object.values(PREFIX_MAP).flatMap(source => Object.values(source));

/**
 * Generate mapping of known prefixes to hints
 */
function getKnownPrefixes() {
    const prefixes = {
        'huggingface-deepspec--': { s: 'hf' },
        'huggingface_deepspec--': { s: 'hf' },
        'huggingface--': { s: 'hf' },
        'github--': { s: 'gh' },
        'arxiv--': { s: 'arxiv' },
        'paper--': { t: 'paper' },
        'model--': { t: 'model' },
        'dataset--': { t: 'dataset' },
        'space--': { t: 'space' },
        'agent--': { t: 'agent' },
        'tool--': { t: 'tool' },
        'prompt--': { t: 'prompt' },
        'hf--': { s: 'hf' },
        'gh--': { s: 'gh' },
        'replicate--': { s: 'replicate' },
        'civitai--': { s: 'civitai' },
        'kaggle--': { s: 'kaggle' },
        'ollama--': { s: 'ollama' }
    };

    // Auto-add from PREFIX_MAP
    for (const [s, types] of Object.entries(PREFIX_MAP)) {
        for (const [t, p] of Object.entries(types)) {
            prefixes[p] = { s, t };
        }
    }

    return prefixes;
}

const KNOWN_PREFIXES = getKnownPrefixes();

/**
 * Normalize an ID into canonical format
 */
export function normalizeId(id, source, type) {
    if (!id) return null;

    // 1. Initial Cleanup: Normalize delimiters and lowercase
    let cleanId = id.toLowerCase()
        .replace(/\.meta\.json$/i, '') // V16.96.2: Added for meta files
        .replace(/\.meta$/i, '')       // V16.96.2: Added for meta files
        .replace(/\.md$/i, '')         // V16.96.2: Added for markdown files
        .replace(/\.json$/i, '')
        .replace(/[\/:]/g, '--')
        .trim();

    // V16.96.2: Academic Continuity (Art 3.1)
    // Strip version suffixes (v1, v2...) from ArXiv IDs to allow updates/merging
    if (cleanId.match(/\d{4}\.\d{4,5}v\d+$/)) {
        cleanId = cleanId.replace(/v\d+$/, '');
    }

    // 2. Identify and Strip ALL known prefixes (Recursive/Multi-pass)
    // V16.96.2: Robust prefix removal to prevent 'hf-agent--gh-agent--'
    let hintS = null;
    let hintT = null;
    let stripped = true;

    while (stripped) {
        stripped = false;
        // Sort keys by length DESC to ensure longest match (canonical) is preferred
        const keys = Object.keys(KNOWN_PREFIXES).sort((a, b) => b.length - a.length);
        for (const p of keys) {
            if (cleanId.startsWith(p)) {
                const hint = KNOWN_PREFIXES[p];
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

    // Canonical source normalization
    if (s === 'huggingface') s = 'hf';
    if (s === 'github') s = 'gh';

    // Contextual Guessing (Fallback)
    if (!s) {
        if (id.includes('github.com')) s = 'gh';
        else if (id.includes('huggingface.co')) s = 'hf';
        else if (id.includes('arxiv.org')) s = 'arxiv';
        else s = 'hf'; // System default
    }

    // FINAL SAFETY: Iterate once more through all known prefixes to ensure no nesting remains
    // This handles cases where unconventional prefix strings might exist (e.g. hf-model--gh-model--)
    let safetyCheck = true;
    while (safetyCheck) {
        safetyCheck = false;
        for (const p of Object.keys(KNOWN_PREFIXES)) {
            if (cleanId.startsWith(p)) {
                cleanId = cleanId.slice(p.length);
                safetyCheck = true;
            }
        }
    }

    if (!t) {
        if (s === 'arxiv') t = 'paper';
        else if (s === 'gh') {
            // V16.9.23: Refined GH source classification
            // Check for tool indicators in the ID/slug
            const lowerId = (id || '').toLowerCase();
            if (lowerId.includes('tool') || lowerId.includes('mcp') || lowerId.includes('plugin')) {
                t = 'tool';
            } else {
                t = 'agent';
            }
        }
        else t = 'model';
    }


    const prefix = PREFIX_MAP[s]?.[t];

    // 4. Final Assembly (V16.8.21: Canonical ID Mode as per SPEC-V16.2 Section 2.1)
    return prefix ? `${prefix}${cleanId}` : cleanId;
}

export function getNodeSource(id, type) {
    if (type === 'paper') return 'arxiv';
    if (type === 'agent' || type === 'tool') {
        const lowerId = (id || '').toLowerCase();
        if (lowerId.startsWith('hf-') || lowerId.startsWith('huggingface--')) return 'hf';
        return 'gh';
    }

    if (type === 'dataset' || type === 'space') return 'hf';
    if (type === 'model') {
        const lowerId = (id || '').toLowerCase();
        if (lowerId.startsWith('gh-model--') || lowerId.startsWith('github--')) return 'gh';
        if (lowerId.startsWith('civitai')) return 'civitai';
        if (lowerId.startsWith('replicate')) return 'replicate';
        if (lowerId.startsWith('kaggle')) return 'kaggle';
        if (lowerId.startsWith('ollama')) return 'ollama';
        return 'hf';
    }
    return null;
}

// CommonJS compatibility for legacy scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeId, getNodeSource, PREFIX_MAP, ALL_PREFIXES };
}
