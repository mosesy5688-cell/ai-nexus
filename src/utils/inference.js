
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
 * @param {string[]} tags - List of entity tags
 * @param {string} pipelineTag - HuggingFace pipeline tag
 * @param {string} entityType - model, agent, etc.
 */
export function getUseCases(tags = [], pipelineTag = '', entityType = 'model') {
    const cases = new Map();
    const allTags = [...(tags || []), pipelineTag].filter(Boolean).map(t => t.toLowerCase());

    // 1. Map known tags
    allTags.forEach(tag => {
        if (USE_CASE_MAP[tag]) {
            cases.set(USE_CASE_MAP[tag].id, USE_CASE_MAP[tag]);
        }
    });

    // 2. Infer from Entity Type defaults if empty
    if (cases.size === 0) {
        if (entityType === 'model') cases.set('general', { id: 'general', label: 'General Task', icon: '⚡' });
        if (entityType === 'dataset') cases.set('train', { id: 'train', label: 'Model Training', icon: '🏋️' });
        if (entityType === 'space') cases.set('demo', { id: 'demo', label: 'Interactive Demo', icon: '🎮' });
        if (entityType === 'paper') cases.set('research', { id: 'research', label: 'Deep Research', icon: '🔬' });
        if (entityType === 'tool') cases.set('dev', { id: 'dev', label: 'Development', icon: '🛠️' });
        if (entityType === 'agent') cases.set('assist', { id: 'assist', label: 'AI Assistant', icon: '🤖' });
    }

    // 3. Add Performance Badge (if applicable)
    // This would ideally come from a passed FNI score, but logic kept simple here

    return Array.from(cases.values()).slice(0, 4); // Max 4 items
}

/**
 * Get Quick Insight metrics for Zone 2
 * Adapts based on entity type
 */
export function getQuickInsights(entity, type) {
    const insights = [];

    // Helper to format numbers (e.g. 1.2M)
    const formatNum = (n) => {
        if (!n) return '-';
        if (n > 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n > 1000) return (n / 1000).toFixed(1) + 'K';
        return n;
    };

    if (type === 'model') {
        insights.push({ label: 'Params', value: entity.params_billions ? `${entity.params_billions}B` : '-' });
        insights.push({ label: 'Context', value: entity.context_length ? `${Math.round(entity.context_length / 1024)}k` : '-' });
        insights.push({ label: 'Downloads', value: formatNum(entity.downloads) });
        insights.push({ label: 'License', value: entity.license || 'Unknown' });
        if (entity.has_gguf) insights.push({ label: 'Format', value: 'GGUF ✓', highlight: true });
    }

    else if (type === 'agent') {
        insights.push({ label: 'Tools', value: entity.tools_count || '-' });
        insights.push({ label: 'Stars', value: formatNum(entity.stars || entity.github_stars) });
        insights.push({ label: 'Framework', value: entity.framework || '-' });
    }

    else if (type === 'dataset') {
        insights.push({ label: 'Size', value: entity.size_gb ? `${entity.size_gb} GB` : '-' });
        insights.push({ label: 'Rows', value: formatNum(entity.rows) });
        insights.push({ label: 'Format', value: entity.format || '-' });
    }

    else if (type === 'paper') {
        insights.push({ label: 'Citations', value: formatNum(entity.citations) });
        insights.push({ label: 'Published', value: entity.published_date ? new Date(entity.published_date).getFullYear() : '-' });
        insights.push({ label: 'Pages', value: entity.pages || '-' });
    }

    else if (type === 'space') {
        insights.push({ label: 'SDK', value: entity.sdk || '-' });
        insights.push({ label: 'Likes', value: formatNum(entity.likes) });
        insights.push({ label: 'Status', value: entity.runtime?.stage || 'Running' });
    }

    else if (type === 'tool') {
        insights.push({ label: 'Lang', value: entity.language || '-' });
        insights.push({ label: 'License', value: entity.license || '-' });
        insights.push({ label: 'Stars', value: formatNum(entity.stars) });
    }

    return insights;
}
