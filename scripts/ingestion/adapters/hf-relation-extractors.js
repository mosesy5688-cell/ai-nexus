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

import { inferType } from './hf-utils.js';

/**
 * C4 Stage-2 (Founder D-2026-0714-333): SOURCE-FAMILY-AUTHORITATIVE identity type
 * for the HF MODEL adapter. The model source family is 'model'; relationship
 * metadata (cardData.datasets) and pipeline_tag==='dataset' CANNOT change the
 * canonical identity type (that was the phantom root cause). inferType is DEMOTED
 * to a descriptive/validation signal only (never an identity determinant).
 *
 * D-2026-0714-334/335/336 (PROSPECTIVE model->tool prevention): the HF MODEL source
 * canonical identity type is ALWAYS 'model'. inferType (incl. its 'tool' verdict) is
 * DESCRIPTIVE ONLY and MUST NOT set identity type / ID prefix / registry key. A
 * transformers-no-pipeline HF model repo now mints hf-model-- (not hf-tool--).
 * Existing historical hf-tool-- rows are NOT rewritten (valid_id_changed_count=0);
 * they are a REPORT-ONLY residual (G1-P kept OPEN), never deleted in this PR.
 * @param {Object} raw
 * @returns {'model'}
 */
export function modelSourceEntityType(raw) {
    return 'model';
}

/**
 * C4 Stage-2 (D-333): INTERNAL/OBSERVATIONAL source-family vs inferred-descriptive
 * -type diagnostic. Never a public field, never a gate. axis 'model-dataset' = the
 * DEMOTED case (identity kept 'model'); axis 'model-tool' = the OUT-OF-SCOPE
 * residual (identity preserved as 'tool'); 'none' = agreement.
 * @param {Object} raw
 * @returns {{source_family:'model', inferred_descriptive:string, identity_type:('model'|'tool'), agrees:boolean, axis:('none'|'model-dataset'|'model-tool')}}
 */
export function sourceTypeDiagnostic(raw) {
    const inferred = inferType(raw);
    const identity_type = modelSourceEntityType(raw);
    const agrees = inferred === 'model';
    const axis = agrees ? 'none' : (inferred === 'dataset' ? 'model-dataset' : 'model-tool');
    return { source_family: 'model', inferred_descriptive: inferred, identity_type, agrees, axis };
}

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
