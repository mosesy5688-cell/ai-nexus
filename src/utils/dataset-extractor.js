// V27.72: Curated ML dataset extraction engine using strict word boundaries.
// Rejects technique/model names (Vicuna/HELM/CoT) to prevent semantic poisoning
// of Mesh Tier via false positives like "trained on 8x A100" → "A100" in datasets.
// ARC disambiguated to ARC-Easy / ARC-Challenge / AI2-ARC (raw "ARC" collides
// with AWS / ARKit / Helm chart). Lowercase dedup for stable Mesh ID.

const CURATED_DATASETS = [
    'ImageNet', 'MNIST', 'CIFAR(?:-10|-100)?', 'MMLU', 'HumanEval',
    'GLUE', 'SuperGLUE', 'SQuAD', 'MS-COCO', 'COCO', 'WMT\\d+', 'IWSLT',
    'GSM8K', 'MATH', 'MBPP', 'ShareGPT', 'LMSYS-Chat-1M', 'Alpaca',
    'HellaSwag', 'TruthfulQA', 'Winogrande', 'BoolQ', 'PIQA', 'OpenBookQA',
    'BBH', 'FLAN', 'Dolly', 'OpenOrca', 'UltraChat', 'TriviaQA',
    'NaturalQuestions', 'ARC-Easy', 'ARC-Challenge', 'AI2-ARC'
];

const DATASET_REGEX = new RegExp(`\\b(${CURATED_DATASETS.join('|')})\\b`, 'gi');

/**
 * Extract normalized, deduplicated lowercase dataset slugs from raw text corpus.
 * Returns [] on empty/non-string input — honest empty over fabricated entries.
 * @param {string} text
 * @returns {string[]}
 */
export function extractDatasetsFromText(text) {
    if (!text || typeof text !== 'string') return [];
    const matches = text.match(DATASET_REGEX) || [];
    return Array.from(new Set(matches.map(m => m.toLowerCase())));
}
