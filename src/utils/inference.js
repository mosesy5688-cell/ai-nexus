
/**
 * V15.0 Entity Inference Engine
 * Infers "Use Cases" and "Capabilities" from raw tags/metadata
 * Zero-Runtime: Logic runs at build time or hydration time
 */

export const USE_CASE_MAP = {
    // NLP
    'text-generation': { id: 'chat', label: 'Chat & Dialogue', icon: '💬' },
    'text2text-generation': { id: 'translate', label: 'Translation/Summary', icon: '🔄' },
    'summarization': { id: 'summary', label: 'Summarization', icon: '📝' },
    'question-answering': { id: 'qa', label: 'Q&A System', icon: '❓' },
    'translation': { id: 'translate', label: 'Translation', icon: '🌐' },

    // Code
    'code': { id: 'code', label: 'Code Assistant', icon: '💻' },
    'python': { id: 'code', label: 'Python Coding', icon: '🐍' },

    // Vision
    'text-to-image': { id: 'art', label: 'Image Gen', icon: '🎨' },
    'image-to-text': { id: 'vision', label: 'Visual Und.', icon: '👁️' },
    'object-detection': { id: 'vision', label: 'Obj Detection', icon: '🔍' },

    // Audio
    'text-to-speech': { id: 'audio', label: 'TTS', icon: '🗣️' },
    'automatic-speech-recognition': { id: 'audio', label: 'ASR', icon: '👂' },

    // Special
    'rag': { id: 'rag', label: 'RAG Knowledge', icon: '📚' },
    'agent': { id: 'agent', label: 'Autonomous Agent', icon: '🤖' }
};

/**
 * Get distinct use cases for Zone 1.5
 * V15.0: "What can this be used for?" (3-5 second evaluation)
 */
export function getUseCases(tagsOrEntity = [], pipelineTag = '', entityType = 'model', fniScore = 0) {
    const goodFor = new Set();
    const limits = new Set();

    // V16.8.4: Robust Argument Handling (Supports tags array or full entity object)
    const isEntityObject = tagsOrEntity && !Array.isArray(tagsOrEntity) && typeof tagsOrEntity === 'object';
    const entity = isEntityObject ? tagsOrEntity : null;

    const safeTags = isEntityObject ? (entity.tags || []) : (Array.isArray(tagsOrEntity) ? tagsOrEntity : []);
    const safePipelineTag = pipelineTag || entity?.pipeline_tag || '';
    const safeType = entityType || entity?.type || 'model';
    const safeScore = fniScore || entity?.fni_score || 0;

    const allTags = [...safeTags, safePipelineTag].filter(Boolean).map(t => String(t).toLowerCase());

    // 1. Entity Type Logic
    if (safeType === 'model') {
        if (allTags.includes('text-generation')) goodFor.add('Chat & Dialogue');
        if (allTags.includes('code') || allTags.includes('python')) goodFor.add('Coding Assistant');
        if (allTags.includes('translation')) goodFor.add('Translation');
        if (allTags.includes('summarization')) goodFor.add('Content Summary');
        if (allTags.includes('rag') || allTags.includes('knowledge')) goodFor.add('RAG Systems');
        if (allTags.includes('text-to-image')) goodFor.add('AI Art Gen');

        // Limits
        if (safeScore < 50 && safeScore > 0) limits.add('Experimental / High Latency');
        if (allTags.includes('small-model')) limits.add('Limited Complexity');

        // V15.9 Trust Signal: Restrictive License Detection (V16.8.4 Fix: Use safe entity check)
        const licenseStr = String(entity?.license || '').toLowerCase();
        const fullTags = allTags.join(' ');
        if (licenseStr.includes('non-commercial') || fullTags.includes('cc-by-nc') || fullTags.includes('research-only')) {
            limits.add('Non-Commercial Use');
        } else if (licenseStr.includes('apache') || licenseStr.includes('mit')) {
            // permissible
        }
    }

    else if (safeType === 'agent') {
        if (allTags.includes('framework')) goodFor.add('Agent Orchestration');
        if (allTags.includes('mcp-server')) goodFor.add('External Tools');
        if (allTags.includes('autonomous')) goodFor.add('Long-term Planning');
    }

    else if (safeType === 'paper') {
        if (allTags.includes('nlp')) goodFor.add('Language Theory');
        if (allTags.includes('cv')) goodFor.add('Object Detection');
        if (allTags.includes('benchmark')) goodFor.add('Model Analytics');
    }

    else if (safeType === 'dataset') {
        if (allTags.includes('sft')) { goodFor.add('Instruction Tuning'); }
        if (allTags.includes('rlhf')) { goodFor.add('Alignment Training'); }
        if (allTags.includes('pretrain')) { goodFor.add('Base Training'); }
    }

    else if (safeType === 'space') {
        if (allTags.includes('chat')) goodFor.add('Live Sandbox');
    }

    else if (safeType === 'tool') {
        if (allTags.includes('deployment')) goodFor.add('Model Serving');
    }

    // Performance Badge: derived from real FNI score
    if (fniScore >= 90) goodFor.add('SOTA Performance');

    // Honest-empty: only tag/score/license-derived items are returned.
    // No fabricated per-type defaults. Empty arrays hide the zone.
    return {
        goodFor: Array.from(goodFor).slice(0, 3),
        limits: Array.from(limits).slice(0, 2)
    };
}

// Redundant logic removed for CES Art 5.1 compliance.
// getQuickInsights is now maintained in ./insight-engine.js
export { getQuickInsights } from './insight-engine.js';
