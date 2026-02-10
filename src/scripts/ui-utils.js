// UI Utilities (Shared Frontend Logic)
import { getRouteFromId, getTypeFromId } from '../utils/mesh-routing-core.js';

export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num != null ? num.toLocaleString() : 0;
}

export function createModelCardHTML(model) {
    if (!model || (!model.id && !model.umid)) {
        console.warn('Model missing id:', model);
        return '';
    }
    const type = model.type || model.entity_type || getTypeFromId(model.id || model.umid || '');
    const modelUrl = getRouteFromId(model.id || model.umid || model.slug || '', type);

    const displayTitle = model.name || (model.id || model.umid || '').split(/[:/]/).pop()?.replace(/--/g, '/') || 'Untitled Entity';
    const author = model.author || model.creator || 'Nexus Collective';
    const description = (model.description || model.summary || 'Indexing structural intelligence...')
        .replace(/<[^>]*>?/gm, '')
        .substring(0, 120) + (model.description?.length > 120 ? '...' : '');

    const fni = Math.round(model.fni_score || 0);
    const fniPercentile = model.fni_percentile;

    const typeColors = {
        model: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
        agent: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
        dataset: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400',
        tool: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
        paper: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
        space: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    };
    const typeBadgeColor = typeColors[type] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
    const typeLabel = (model.pipeline_tag || model.primary_category || type).replace(/-/g, ' ');

    return `
        <a href="${modelUrl}" class="entity-card group p-5 bg-white dark:bg-zinc-900 rounded-2xl hover:shadow-xl transition-all duration-300 border border-gray-100 dark:border-zinc-800 hover:border-indigo-500/50 block h-full flex flex-col hover:-translate-y-1">
            <div class="flex items-center justify-between mb-3">
                 <span class="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${typeBadgeColor}">${typeLabel}</span>
                 ${fni > 0 ? `
                    <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-600/90 text-white shadow-sm">
                        <span class="text-[10px] font-bold">🛡️ ${fniPercentile?.startsWith('top_') ? fniPercentile.replace('top_', 'Top ') : `FNI ${fni}`}</span>
                    </div>
                 ` : ''}
            </div>
            <h3 class="text-sm font-black text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-2 mt-1 mb-1 tracking-tight" title="${displayTitle}">
                ${displayTitle}
            </h3>
            <p class="text-[11px] text-gray-400 dark:text-zinc-500 mb-3 uppercase tracking-[0.15em] font-black">by ${author}</p>
            <p class="text-xs text-gray-600 dark:text-zinc-400 line-clamp-3 mb-4 flex-grow leading-relaxed">${description}</p>
            <div class="flex items-center gap-4 pt-4 border-t border-gray-50 dark:border-zinc-800/50 text-[10px] font-black text-gray-400 uppercase tracking-widest">
                <div class="flex items-center gap-1.5" title="Downloads">📥 <span>${formatNumber(model.downloads || model.download_count)}</span></div>
                <div class="flex items-center gap-1.5" title="Likes">❤️ <span>${formatNumber(model.likes || model.likes_count)}</span></div>
            </div>
        </a>
    `;
}

