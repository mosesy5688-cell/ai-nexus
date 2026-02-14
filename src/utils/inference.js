
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

        // Limits
        limits.add('Requires API Keys');
    }

    else if (safeType === 'paper') {
        if (allTags.includes('nlp')) goodFor.add('Language Theory');
        if (allTags.includes('cv')) goodFor.add('Object Detection');
        if (allTags.includes('benchmark')) goodFor.add('Model Analytics');

        // Defaults if tags sparse
        if (goodFor.size === 0) goodFor.add('SOTA Research');
        limits.add('Academic Implementation');
    }

    else if (safeType === 'dataset') {
        if (allTags.includes('sft')) { goodFor.add('Instruction Tuning'); }
        if (allTags.includes('rlhf')) { goodFor.add('Alignment Training'); }
        if (allTags.includes('pretrain')) { goodFor.add('Base Training'); }

        if (goodFor.size === 0) { goodFor.add('Data Science'); }
    }

    else if (safeType === 'space') {
        goodFor.add('Interactive UI Demo');
        if (allTags.includes('chat')) goodFor.add('Live Sandbox');
    }

    else if (safeType === 'tool') {
        goodFor.add('Developer SDK');
        if (allTags.includes('deployment')) goodFor.add('Model Serving');
    }

    // Performance Badge
    if (fniScore >= 90) goodFor.add('SOTA Performance');

    // Defaults
    if (goodFor.size === 0) {
        if (allTags.includes('api')) goodFor.add('API Integration');
        else if (allTags.includes('web')) goodFor.add('Web Application');
        else goodFor.add('Innovative Solution');
    }
    if (limits.size === 0) {
        if (allTags.includes('beta')) limits.add('Experimental Phase');
        else limits.add('Generic Use');
    }

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
        if (n === null || n === undefined || isNaN(n)) return '-';
        const num = Number(n);
        if (num > 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num > 1000) return (num / 1000).toFixed(1) + 'K';
        return num;
    };

    if (!entity) return insights;

    const safeType = type || 'model';

    if (safeType === 'model') {
        const isTrending = (entity.downloads > 50000) || (entity.fni_percentile > 95);

        // FNI Decision Score (Promoted to Position 1)
        if (entity.fni_score > 0) {
            insights.push({
                label: 'FNI Score',
                value: entity.fni_score,
                highlight: entity.fni_score > 85,
                badge: entity.fni_score > 90 ? 'Elite' : (entity.fni_score > 70 ? 'Trusted' : 'Audited')
            });
        }

        insights.push({
            label: 'Params',
            value: entity.params_billions ? `${entity.params_billions}B` : '-',
            highlight: entity.params_billions > 70,
            badge: entity.params_billions < 3 ? 'Tiny' : (entity.params_billions > 100 ? 'Massive' : null)
        });
        insights.push({
            label: 'Context',
            value: entity.context_length ? `${Math.round(entity.context_length / 1024)}k` : '-',
            highlight: entity.context_length > 32768,
            badge: entity.context_length >= 128000 ? 'Long' : null
        });
        insights.push({
            label: 'Downloads',
            value: formatNum(entity.downloads),
            badge: isTrending ? 'Hot' : null
        });

        // V15.15: Unified VRAM Metric
        if (entity.vram_gb) {
            insights.push({
                label: 'Est. VRAM',
                value: `~${Math.ceil(entity.vram_gb)}GB`,
                highlight: true,
                badge: entity.vram_gb <= 8 ? '8G GPU' : (entity.vram_gb <= 24 ? '24G GPU' : 'H100+')
            });
        }

        if (entity.has_gguf) insights.push({ label: 'Format', value: 'GGUF ✓', highlight: true, badge: 'Local' });

        if (entity.license) {
            const licenseStr = String(entity.license).toLowerCase();
            const isPermissive = licenseStr.includes('apache') || licenseStr.includes('mit');
            insights.push({
                label: 'License',
                value: licenseStr.split('-')[0].toUpperCase(),
                highlight: isPermissive,
                badge: isPermissive ? 'Commercial' : 'Restricted'
            });
        }
    }

    else if (safeType === 'agent') {
        if (entity.fni_score > 0) {
            insights.push({ label: 'FNI Score', value: entity.fni_score, highlight: true, badge: 'Logic Audit' });
        }
        insights.push({ label: 'Tools', value: entity.tools_count || '-', badge: entity.tools_count > 5 ? 'Power' : null });
        insights.push({ label: 'Language', value: entity.language || 'Python', highlight: true });
        insights.push({ label: 'Stars', value: formatNum(entity.stars || entity.github_stars), badge: (entity.stars > 1000) ? 'Popular' : null });
        insights.push({ label: 'Capability', value: entity.verified ? 'Verified' : 'Community', highlight: entity.verified });
        if (entity.license) insights.push({ label: 'License', value: entity.license });
    }

    else if (safeType === 'dataset') {
        if (entity.fni_score > 0) {
            insights.push({ label: 'FNI Score', value: entity.fni_score, highlight: true, badge: 'Data Integrity' });
        }
        insights.push({ label: 'Size', value: entity.size_gb ? `${entity.size_gb} GB` : '-', badge: entity.size_gb > 100 ? 'Large' : null });
        insights.push({ label: 'Rows', value: formatNum(entity.rows) });
        insights.push({ label: 'Format', value: entity.format || 'Parquet', highlight: true });
        insights.push({ label: 'Tokens', value: entity.token_count ? formatNum(entity.token_count) : '-', badge: entity.token_count > 1e12 ? '1T+' : null });
    }

    else if (safeType === 'paper') {
        insights.push({ label: 'Citations', value: formatNum(entity.citations || entity.citation_count), highlight: true, badge: 'High Impact' });
        insights.push({ label: 'Year', value: entity.published_date ? new Date(entity.published_date).getFullYear() : (entity.year || '2024') });
        insights.push({ label: 'Venue', value: entity.venue || 'ArXiv', badge: entity.venue ? 'Peer-Reviewed' : null });

        // V16.6 Fix: Correct percentile string
        const percentile = entity.fni_percentile || 0;
        insights.push({ label: 'FNI Rank', value: percentile > 0 ? `Top ${100 - percentile}%` : '-', highlight: true });
    }

    else if (safeType === 'space') {
        insights.push({ label: 'SDK', value: entity.sdk || 'Gradio', highlight: true });
        insights.push({ label: 'Hardware', value: entity.hardware || 'CPU', badge: entity.hardware?.includes('gpu') ? 'GPU Accel' : null });
        insights.push({ label: 'Status', value: entity.runtime?.stage || 'Running', highlight: true });
        insights.push({ label: 'Activity', value: formatNum(entity.likes), badge: entity.likes > 100 ? 'Active' : null });
    }

    else if (safeType === 'tool') {
        insights.push({ label: 'Lang', value: entity.language || '-', highlight: true });
        insights.push({ label: 'Stars', value: formatNum(entity.stars || entity.github_stars), badge: 'Open Source' });
        insights.push({ label: 'Version', value: entity.version || 'v1.0.0' });
        insights.push({ label: 'Reliability', value: entity.fni_score > 80 ? 'Stable' : 'Alpha', highlight: true });
    }

    return insights;
}
