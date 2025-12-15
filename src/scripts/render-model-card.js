// src/scripts/render-model-card.js
// Shared client-side template for rendering model cards
// This ensures consistency across index.astro and explore.astro

export function renderModelCard(model) {
    const modelId = (model.author && model.name) ? `${model.author}/${model.name}` : model.id;
    const slug = model.slug || modelId.replace(/\//g, '--');
    const modelUrl = `/model/${slug}`;
    const description = (model.description || 'No description available.')
        .replace(/\<[^>]*>?/gm, '')
        .substring(0, 120) + '...';

    const formatNumber = (n) => {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n || 0;
    };

    const getSourceIcon = (source) => {
        switch (source?.toLowerCase()) {
            case 'huggingface': return '🤗';
            case 'github': return '🐙';
            case 'pytorch': return '🔥';
            default: return '📦';
        }
    };

    const getSourceLabel = (source) => {
        switch (source?.toLowerCase()) {
            case 'huggingface': return 'HF';
            case 'github': return 'GH';
            case 'pytorch': return 'PT';
            default: return 'UNK';
        }
    };

    const getSourceGradient = (source) => {
        switch (source?.toLowerCase()) {
            case 'huggingface': return 'from-orange-400 via-yellow-500 to-amber-400';
            case 'github': return 'from-gray-700 via-gray-800 to-gray-900';
            case 'pytorch': return 'from-red-500 via-orange-500 to-red-600';
            case 'replicate': return 'from-indigo-500 via-purple-500 to-pink-500';
            default: return 'from-blue-500 via-indigo-500 to-purple-600';
        }
    };

    const getFirstTag = (tagsData) => {
        try {
            if (!tagsData) return null;
            // Handle both array and JSON string
            const tags = typeof tagsData === 'string' ? JSON.parse(tagsData) : tagsData;
            return Array.isArray(tags) && tags.length > 0 ? tags[0] : null;
        } catch (e) {
            return null;
        }
    };

    // V4.9: Entity type detection (Art.X-Entity)
    const deriveEntityType = (id) => {
        if (!id) return 'model';
        if (id.startsWith('hf-dataset--')) return 'dataset';
        if (id.startsWith('benchmark--')) return 'benchmark';
        if (id.startsWith('arxiv--')) return 'paper';
        if (id.startsWith('agent--')) return 'agent';
        return 'model';
    };

    const getEntityIcon = (type) => {
        switch (type) {
            case 'model': return '🧠';
            case 'dataset': return '📊';
            case 'benchmark': return '🏆';
            case 'paper': return '📄';
            case 'agent': return '🤖';
            default: return '📦';
        }
    };

    const getEntityLabel = (type) => {
        switch (type) {
            case 'model': return 'Model';
            case 'dataset': return 'Dataset';
            case 'benchmark': return 'Benchmark';
            case 'paper': return 'Paper';
            case 'agent': return 'Agent';
            default: return 'Item';
        }
    };

    const firstTag = getFirstTag(model.tags);
    const entityType = deriveEntityType(model.id || model.umid || model.slug);

    return `
    <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full border border-gray-100 dark:border-gray-700">
        ${model.is_rising_star ? `
        <div class="absolute top-2 right-2 z-10 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse shadow-sm" title="Rising Star">
            🔥
        </div>
        ` : ''}
        
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
                <div class="flex gap-2">
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
