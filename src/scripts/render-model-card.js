// src/scripts/render-model-card.js
// Shared client-side template for rendering model cards
// V5.0: CES-001 Clean URL format
import { stripPrefix } from '../utils/mesh-routing-core.js';

export function renderModelCard(model) {
    // V14.4 Fix: Extract author from entity.id when author field is missing
    // trending.json format: id = "huggingface:hexgrad:kokoro-82m"
    // Need to extract "hexgrad" as author
    let author = model.author;
    if (!author && model.id) {
        // Remove source prefix (huggingface:, arxiv:, etc.)
        const cleanId = model.id.replace(/^[a-z]+:/i, '');
        // Split by : or / to get author and name
        const parts = cleanId.split(/[:/]/);
        if (parts.length >= 2) {
            author = parts[0]; // First part is author
        }
    }
    author = author || 'unknown';

    const name = model.name || model.id?.split(/[:/]/).pop() || 'unknown';

    const entityType = deriveEntityType(model.id || model.umid || model.slug);

    // V15.8: Standardized URL generation (Clean prefixes + Strip source/type)
    const prefix = entityType === 'agent' ? '/agent/' : entityType === 'dataset' ? '/dataset/' : entityType === 'tool' ? '/tool/' : entityType === 'paper' ? '/paper/' : entityType === 'space' ? '/space/' : '/model/';

    // V16.9.23: Use centralized SSOT logic (SEO Optimized)
    const modelUrl = getRouteFromId(model.id || model.slug || '', entityType);

    const description = (model.description || 'No description available.')
        .replace(/\<[^>]*>?/gm, '')
        .substring(0, 120) + '...';

    function formatNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n || 0;
    }

    function getSourceIcon(source) {
        switch (source?.toLowerCase()) {
            case 'huggingface': return '🤗';
            case 'github': return '🐙';
            case 'pytorch': return '🔥';
            default: return '📦';
        }
    }

    function getSourceLabel(source) {
        switch (source?.toLowerCase()) {
            case 'huggingface': return 'HF';
            case 'github': return 'GH';
            case 'pytorch': return 'PT';
            default: return 'UNK';
        }
    }

    function getSourceGradient(source) {
        switch (source?.toLowerCase()) {
            case 'huggingface': return 'from-orange-400 via-yellow-500 to-amber-400';
            case 'github': return 'from-gray-700 via-gray-800 to-gray-900';
            case 'pytorch': return 'from-red-500 via-orange-500 to-red-600';
            case 'replicate': return 'from-indigo-500 via-purple-500 to-pink-500';
            default: return 'from-blue-500 via-indigo-500 to-purple-600';
        }
    }

    function getFirstTag(tagsData) {
        try {
            if (!tagsData) return null;
            // Handle both array and JSON string
            const tags = typeof tagsData === 'string' ? JSON.parse(tagsData) : tagsData;
            return Array.isArray(tags) && tags.length > 0 ? tags[0] : null;
        } catch (e) {
            return null;
        }
    }

    // V4.9: Entity type detection (Art.X-Entity)
    function deriveEntityType(id) {
        if (!id) return 'model';
        const lowerId = id.toLowerCase();
        if (lowerId.includes('dataset--')) return 'dataset';
        if (lowerId.includes('space--')) return 'space';
        if (lowerId.includes('paper--') || lowerId.includes('arxiv--')) return 'paper';
        if (lowerId.includes('agent--')) return 'agent';
        if (lowerId.includes('tool--')) return 'tool';
        if (lowerId.includes('benchmark--')) return 'benchmark';
        return 'model';
    }

    function getEntityIcon(type) {
        switch (type) {
            case 'model': return '🧠';
            case 'dataset': return '📊';
            case 'benchmark': return '🏆';
            case 'paper': return '📄';
            case 'agent': return '🤖';
            case 'tool': return '🛠️';
            case 'space': return '🚀';
            default: return '📦';
        }
    }

    function getEntityLabel(type) {
        switch (type) {
            case 'model': return 'Model';
            case 'dataset': return 'Dataset';
            case 'benchmark': return 'Benchmark';
            case 'paper': return 'Paper';
            case 'agent': return 'Agent';
            case 'tool': return 'Tool';
            case 'space': return 'Space';
            default: return 'Item';
        }
    }

    const firstTag = getFirstTag(model.tags);

    return `
    <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full border border-gray-100 dark:border-gray-700">
        ${model.is_rising_star ? `
        <div class="absolute top-2 right-2 z-10 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse shadow-sm" title="Rising Star">
            🔥
        </div>
        ` : ''
        }
        
        <div class="absolute top-2 left-2 z-10 flex items-center gap-1 bg-gray-100/90 dark:bg-gray-700/90 backdrop-blur-sm px-2 py-1 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300 shadow-sm border border-gray-200 dark:border-gray-600">
            <span>${getEntityIcon(entityType)}</span>
            <span>${getEntityLabel(entityType)}</span>
        </div>

        <div class="p-5 flex flex-col h-full justify-between pt-10">
            <div>
                <h3 class="text-lg font-bold text-gray-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" title="${model.name}">
                    ${model.name}
                </h3>
                <p class="text-gray-500 dark:text-gray-400 text-xs mb-3 flex items-center gap-1">
                    <span>by ${model.author}</span>
                </p>
                <p class="text-gray-600 dark:text-gray-300 text-sm h-20 overflow-hidden text-ellipsis leading-relaxed line-clamp-3">
                    ${description}
                </p>
            </div>
            <div class="mt-4 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3">
                <div class="flex gap-2 items-center">
                    <!-- V14.5.1: Mini trend placeholder for sparklines -->
                    <div class="mini-trend" data-entity-id="${model.id || ''}" data-w="60" data-h="20">
                        <canvas class="mini-trend-canvas" width="60" height="20" aria-label="7-day trend"></canvas>
                        <span class="mini-trend-badge">--</span>
                    </div>
                    ${firstTag ? `
                    <span class="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full truncate max-w-[80px]">
                        ${firstTag}
                    </span>
                    ` : ''}
                </div>
                <div class="flex gap-3">
                    <div class="flex items-center gap-1" title="${(model.likes || 0).toLocaleString()} likes">❤️ <span>${formatNumber(model.likes)}</span></div>
                    <div class="flex items-center gap-1" title="${(model.downloads || 0).toLocaleString()} downloads">📥 <span>${formatNumber(model.downloads)}</span></div>
                </div>
            </div>
        </div>
    </a>
    `;
}
