/**
 * V6.0.1 Category Mapping
 * Maps HuggingFace pipeline_tags to 5 primary categories
 * @module l5/category-mapping
 */

// Text Generation
const TEXT_GEN = 'text-generation';
// Knowledge Retrieval
const KNOWLEDGE = 'knowledge-retrieval';
// Vision & Multimedia
const VISION = 'vision-multimedia';
// Automation
const AUTOMATION = 'automation-workflow';
// Infrastructure
const INFRA = 'infrastructure-ops';

export const PIPELINE_TO_V6_CATEGORY = {
    'text-generation': TEXT_GEN, 'conversational': TEXT_GEN, 'text2text-generation': TEXT_GEN,
    'summarization': TEXT_GEN, 'translation': TEXT_GEN, 'fill-mask': TEXT_GEN, 'table-question-answering': TEXT_GEN,
    'feature-extraction': KNOWLEDGE, 'sentence-similarity': KNOWLEDGE, 'token-classification': KNOWLEDGE,
    'question-answering': KNOWLEDGE, 'document-question-answering': KNOWLEDGE, 'text-classification': KNOWLEDGE,
    'text-to-image': VISION, 'image-to-text': VISION, 'image-classification': VISION, 'object-detection': VISION,
    'video-classification': VISION, 'text-to-video': VISION, 'automatic-speech-recognition': VISION,
    'text-to-speech': VISION, 'image-to-image': VISION, 'image-segmentation': VISION,
    'audio-classification': VISION, 'audio-to-audio': VISION, 'unconditional-image-generation': VISION,
    'image-to-video': VISION, 'visual-question-answering': VISION, 'audio': VISION, 'video': VISION,
    'zero-shot-classification': AUTOMATION, 'reinforcement-learning': AUTOMATION, 'robotics': AUTOMATION,
    'tabular-classification': AUTOMATION, 'tabular-regression': AUTOMATION, 'graph-ml': AUTOMATION,
    'depth-estimation': INFRA, 'image-feature-extraction': INFRA, 'mask-generation': INFRA,
    'video-text-to-text': INFRA, 'other': INFRA
};

export const CATEGORY_METADATA = {
    'text-generation': { label: 'Text Generation & Content Creation', icon: '💬', color: '#6366f1' },
    'knowledge-retrieval': { label: 'Knowledge Retrieval & Data Analysis', icon: '🔍', color: '#10b981' },
    'vision-multimedia': { label: 'Vision & Multimedia Processing', icon: '🎨', color: '#f59e0b' },
    'automation-workflow': { label: 'Automation & Workflow Integration', icon: '⚡', color: '#8b5cf6' },
    'infrastructure-ops': { label: 'Infrastructure & Optimization', icon: '🔧', color: '#64748b' },
    'uncategorized': { label: 'Uncategorized', icon: '📦', color: '#9ca3af' }
};
