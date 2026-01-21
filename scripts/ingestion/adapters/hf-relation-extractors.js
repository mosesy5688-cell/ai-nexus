/**
 * HuggingFace Relation Extractors V16.5
 * 
 * CES Compliant: Extracted from hf-normalizer.js to stay under 250 lines
 * Contains enhanced relationship extraction functions for:
 * - base_model (BASED_ON relations)
 * - datasets_used (TRAINED_ON relations)
 * - arxiv_refs (CITES relations)
 * 
 * @module ingestion/adapters/hf-relation-extractors
 */

/**
 * Extract base model reference with enhanced source matching
 * @param {Object} raw - Raw model data from HuggingFace
 * @returns {string|null} Base model ID or null
 */
export function extractBaseModel(raw) {
    // Source 1: Tags
    const tags = raw.tags || [];
    const baseTag = tags.find(t => t.startsWith('base_model:'));
    if (baseTag) return baseTag.replace('base_model:', '');

    // Source 2: cardData direct field
    if (raw.cardData?.base_model) return raw.cardData.base_model;

    // Source 3: cardData model-index
    if (raw.cardData?.['model-index']?.[0]?.['base_model']) {
        return raw.cardData['model-index'][0]['base_model'];
    }

    // Source 4: README pattern matching
    const readme = raw.readme || '';
    const patterns = [
        /(?:based on|fine-?tuned from|derived from|built on)\s+\[?([a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+)\]?/i,
        /(?:base model|parent model)[:\s]+\[?([a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+)\]?/i
    ];
    for (const pattern of patterns) {
        const match = readme.match(pattern);
        if (match) return match[1];
    }

    return null;
}

/**
 * Extract datasets used with enhanced source matching
 * @param {Object} raw - Raw model data from HuggingFace
 * @returns {string[]} Array of dataset IDs
 */
export function extractDatasetsUsed(raw) {
    const datasets = new Set();

    // Source 1: Tags
    (raw.tags || [])
        .filter(t => t.startsWith('dataset:'))
        .forEach(t => datasets.add(t.replace('dataset:', '')));

    // Source 2: cardData.datasets array
    if (Array.isArray(raw.cardData?.datasets)) {
        raw.cardData.datasets.forEach(d => {
            if (typeof d === 'string') datasets.add(d);
            else if (d?.name) datasets.add(d.name);
        });
    }

    // Source 3: cardData.dataset single field
    if (raw.cardData?.dataset) {
        datasets.add(raw.cardData.dataset);
    }

    return Array.from(datasets);
}

/**
 * Extract arXiv references with enhanced README parsing
 * @param {Object} raw - Raw model data from HuggingFace
 * @returns {string[]} Array of arXiv IDs
 */
export function extractArxivRefs(raw) {
    const refs = new Set();

    // Source 1: Tags
    (raw.tags || [])
        .filter(t => t.startsWith('arxiv:'))
        .forEach(t => refs.add(t.replace('arxiv:', '')));

    // Source 2: README content parsing
    const readme = raw.readme || '';
    const arxivPatterns = [
        /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/gi,
        /arxiv\.org\/pdf\/(\d{4}\.\d{4,5})/gi,
        /\[(\d{4}\.\d{4,5})\]/g,
        /arXiv:\s*(\d{4}\.\d{4,5})/gi
    ];
    for (const pattern of arxivPatterns) {
        let match;
        while ((match = pattern.exec(readme)) !== null) {
            refs.add(match[1]);
        }
    }

    // Source 3: cardData.paper field
    if (raw.cardData?.paper) {
        const paperMatch = raw.cardData.paper.match(/(\d{4}\.\d{4,5})/);
        if (paperMatch) refs.add(paperMatch[1]);
    }

    return Array.from(refs);
}
