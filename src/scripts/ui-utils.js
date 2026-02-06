
// UI Utilities (Shared Frontend Logic)

export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num != null ? num.toLocaleString() : 0;
}

export function createModelCardHTML(model) {
    if (!model || !model.id) {
        console.warn('Model missing id:', model);
        return '';
    }
    const type = model.type || 'model';
    const prefix = type === 'agent' ? '/agent/' : type === 'dataset' ? '/dataset/' : type === 'tool' ? '/tool/' : type === 'paper' ? '/paper/' : type === 'space' ? '/space/' : '/model/';

    // V15.8: Use centralized SSOT logic - Preservation Policy
    const slug = (model.id || model.slug || '').toLowerCase();
    const modelUrl = `${prefix}${slug}`;
    const rawDesc = model.description || 'No description available.';
    const cleanDesc = rawDesc.replace(/<[^>]*>?/gm, '');
    const description = cleanDesc.substring(0, 120);

    const isRisingStarHTML = model.is_rising_star ? `<div class="absolute top-2 right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse" title="Rising Star">🔥</div>` : '';

    let tagsHtml = '';
    if (model.tags) {
        try {
            const tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags;
            if (Array.isArray(tags)) {
                tagsHtml = tags.slice(0, 2).map(t => `<span class="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">${t}</span>`).join('');
            }
        } catch (e) { }
    }

    // Note: Tailwind classes must match compilation scope
    return `
        <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full flex flex-col border border-gray-100 dark:border-gray-700">
            ${isRisingStarHTML}
            <div class="p-5 flex flex-col h-full justify-between">
                <div>
                    <h3 class="text-lg font-bold text-gray-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" title="${model.name}">
                        ${model.name}
                    </h3>
                    <p class="text-gray-500 dark:text-gray-400 text-xs mb-3 flex items-center gap-2">
                        <span>by ${model.author}</span>
                        ${tagsHtml ? `<span class="flex gap-1">${tagsHtml}</span>` : ''}
                    </p>
                    <p class="text-gray-600 dark:text-gray-300 text-sm h-20 overflow-hidden text-ellipsis leading-relaxed">
                        ${description}...
                    </p>
                </div>
                <div class="mt-4 flex items-center justify-end gap-4 text-xs text-gray-500 dark:text-gray-400">
                    <div class="flex items-center gap-1" title="${(model.likes || 0).toLocaleString()} likes">❤️ <span>${formatNumber(model.likes)}</span></div>
                    <div class="flex items-center gap-1" title="${(model.downloads || 0).toLocaleString()} downloads">📥 <span>${formatNumber(model.downloads)}</span></div>
                </div>
            </div>
        </a>
    `;
}
