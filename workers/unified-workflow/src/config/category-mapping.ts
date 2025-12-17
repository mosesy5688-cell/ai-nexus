/**
 * V6.0 Pipeline Tag to Category Mapping
 * Constitution Annex A.2.3 - Canonical mapping from HuggingFace pipeline_tag
 * 
 * @see docs/CONSTITUTION_ANNEX_A_V6.md
 */

import { CategoryId } from './categories';

/**
 * Maps HuggingFace pipeline_tag values to our primary categories
 * Order within arrays doesn't matter - all map to the same category
 */
export const CATEGORY_MAP: Record<CategoryId, string[]> = {
    'text-generation': [
        'text-generation',
        'conversational',
        'text2text-generation',
        'summarization',
        'translation',
        'fill-mask',
        'table-question-answering'
    ],

    'knowledge-retrieval': [
        'feature-extraction',
        'sentence-similarity',
        'token-classification',
        'question-answering',
        'document-question-answering',
        'text-classification'
    ],

    'vision-multimedia': [
        'text-to-image',
        'image-to-text',
        'image-classification',
        'object-detection',
        'video-classification',
        'text-to-video',
        'automatic-speech-recognition',
        'text-to-speech',
        'image-to-image',
        'image-segmentation',
        'audio-classification',
        'audio-to-audio',
        'unconditional-image-generation',
        'image-to-video',
        'visual-question-answering'
    ],

    'automation-workflow': [
        'zero-shot-classification',
        'reinforcement-learning',
        'robotics',
        'tabular-classification',
        'tabular-regression',
        'graph-ml'
    ],

    'infrastructure-ops': [
        'depth-estimation',
        'image-feature-extraction',
        'mask-generation',
        'video-text-to-text',
        'other'
    ]
};

/**
 * Reverse lookup: pipeline_tag -> category
 * Generated at module load for O(1) lookups
 */
export const PIPELINE_TO_CATEGORY: Record<string, CategoryId> = {};

for (const [category, tags] of Object.entries(CATEGORY_MAP)) {
    for (const tag of tags) {
        PIPELINE_TO_CATEGORY[tag] = category as CategoryId;
    }
}
