
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
export function getUseCases(tags = [], pipelineTag = '', entityType = 'model', fniScore = 0) {
    const goodFor = new Set();
    const limits = new Set();
    const allTags = [...(tags || []), pipelineTag].filter(Boolean).map(t => t.toLowerCase());

    // 1. Entity Type Logic
    if (entityType === 'model') {
        if (allTags.includes('text-generation')) goodFor.add('Chat & Dialogue');
        if (allTags.includes('code') || allTags.includes('python')) goodFor.add('Coding Assistant');
        if (allTags.includes('translation')) goodFor.add('Translation');
        if (allTags.includes('summarization')) goodFor.add('Content Summary');
        if (allTags.includes('rag') || allTags.includes('knowledge')) goodFor.add('RAG Systems');
        if (allTags.includes('text-to-image')) goodFor.add('AI Art Gen');

        // Limits
        if (fniScore < 50 && fniScore > 0) limits.add('Experimental / High Latency');
        if (allTags.includes('small-model')) limits.add('Limited Complexity');
    }

    else if (entityType === 'agent') {
        if (allTags.includes('framework')) goodFor.add('Agent Orchestration');
        if (allTags.includes('mcp-server')) goodFor.add('External Tools');
        if (allTags.includes('autonomous')) goodFor.add('Long-term Planning');

        // Limits
        limits.add('Requires API Keys');
    }

    else if (entityType === 'paper') {
        if (allTags.includes('nlp')) goodFor.add('Language Theory');
        if (allTags.includes('cv')) goodFor.add('Object Detection');
        if (allTags.includes('benchmark')) goodFor.add('Model Analytics');

        // Defaults if tags sparse
        if (goodFor.size === 0) goodFor.add('SOTA Research');
        limits.add('Academic Implementation');
    }

    else if (entityType === 'dataset') {
        if (allTags.includes('sft')) goodFor.add('Instruction Tuning');
        if (allTags.includes('rlhf')) goodFor.add('Alignment Training');
        if (allTags.includes('pretrain')) goodFor.add('Base Training');

        if (goodFor.size === 0) goodFor.add('Data Science');
    }

    else if (entityType === 'space') {
        goodFor.add('Interactive UI Demo');
        if (allTags.includes('chat')) goodFor.add('Live Sandbox');
    }

    else if (entityType === 'tool') {
        goodFor.add('Developer SDK');
        if (allTags.includes('deployment')) goodFor.add('Model Serving');
    }

    // Performance Badge
    if (fniScore >= 90) goodFor.add('SOTA Performance');

    // Defaults
    if (goodFor.size === 0) goodFor.add('Innovative Solution');
    if (limits.size === 0) limits.add('Generic Use');

    return {
        goodFor: Array.from(goodFor).slice(0, 3),
        limits: Array.from(limits).slice(0, 2)
    };
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
        insights.push({ label: 'Likes', value: formatNum(entity.likes) });
        if (entity.has_gguf) insights.push({ label: 'Format', value: 'GGUF ✓', highlight: true });
    }

    else if (type === 'agent') {
        insights.push({ label: 'Tools', value: entity.tools_count || '-' });
        insights.push({ label: 'Language', value: entity.language || 'Python' });
        insights.push({ label: 'Stars', value: formatNum(entity.stars || entity.github_stars) });
        insights.push({ label: 'Verified', value: entity.verified ? 'Yes' : 'No', highlight: entity.verified });
    }

    else if (type === 'dataset') {
        insights.push({ label: 'Size', value: entity.size_gb ? `${entity.size_gb} GB` : '-' });
        insights.push({ label: 'Rows', value: formatNum(entity.rows) });
        insights.push({ label: 'Format', value: entity.format || 'Parquet' });
        insights.push({ label: 'Likes', value: formatNum(entity.likes) });
    }

    else if (type === 'paper') {
        insights.push({ label: 'Citations', value: formatNum(entity.citations || entity.citation_count) });
        insights.push({ label: 'Published', value: entity.published_date ? new Date(entity.published_date).getFullYear() : '2024' });
        insights.push({ label: 'Pages', value: entity.pages || 'N/A' });
        insights.push({ label: 'FNI Rank', value: entity.fni_score ? `Top ${100 - (entity.fni_percentile || 0)}%` : '-', highlight: true });
    }

    else if (type === 'space') {
        insights.push({ label: 'SDK', value: entity.sdk || 'Gradio' });
        insights.push({ label: 'Config', value: entity.hardware || 'CPU' });
        insights.push({ label: 'Status', value: entity.runtime?.stage || 'Running', highlight: true });
        insights.push({ label: 'Likes', value: formatNum(entity.likes) });
    }

    else if (type === 'tool') {
        insights.push({ label: 'Lang', value: entity.language || '-' });
        insights.push({ label: 'Stars', value: formatNum(entity.stars || entity.github_stars) });
        insights.push({ label: 'Version', value: entity.version || 'v1.0.0' });
        insights.push({ label: 'License', value: entity.license || 'MIT', highlight: true });
    }

    return insights;
}
