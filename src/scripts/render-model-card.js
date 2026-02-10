// src/scripts/render-model-card.js
// Shared client-side template for rendering model cards
// V5.0: CES-001 Clean URL format
import { generateEntityUrl } from '../utils/url-utils.js';
import { extractAuthor } from '../utils/entity-utils.js';

export function renderModelCard(model) {
    const entityType = deriveEntityType(model.id || model.umid || model.slug);
    const id = model.id || model.slug || '';
    const displayTitle = model.name || id.split('/').pop()?.replace(/--/g, '/') || 'Untitled Entity';
    const author = extractAuthor(id, model.author || model.creator || model.organization);
    const description = (model.description || 'No description available.').replace(/<[^>]*>?/gm, '');
    const cleanDesc = description.substring(0, 150) + '...';
    const modelUrl = generateEntityUrl(model, entityType);

    const fni = Math.round(model.fni_score || 0);
    const fniPercentile = model.fni_percentile || 0;

    let fniBadgeClass = "bg-gray-100 dark:bg-zinc-800 text-gray-500";
    if (fni >= 85) fniBadgeClass = "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400";
    else if (fni >= 70) fniBadgeClass = "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400";
    else if (fni > 0) fniBadgeClass = "bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400";

    let typeBadgeColor = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
    if (entityType === 'model') typeBadgeColor = 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400';
    if (entityType === 'agent') typeBadgeColor = 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400';
    if (entityType === 'dataset') typeBadgeColor = 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400';
    if (entityType === 'tool') typeBadgeColor = 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400';
    if (entityType === 'paper') typeBadgeColor = 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
    if (entityType === 'space') typeBadgeColor = 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';

    const typeLabel = (model.pipeline_tag || model.primary_category || entityType).replace(/-/g, ' ');

    function formatNumber(n) {
        if (!n) return 0;
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n;
    }

    function deriveEntityType(id) {
        if (!id) return 'model';
        const lowerId = id.toLowerCase();
        if (lowerId.includes('dataset--')) return 'dataset';
        if (lowerId.includes('space--')) return 'space';
        if (lowerId.includes('paper--') || lowerId.includes('arxiv--')) return 'paper';
        if (lowerId.includes('agent--')) return 'agent';
        if (lowerId.includes('tool--')) return 'tool';
        return 'model';
    }

    return `
        <a href="${modelUrl}" class="entity-card group p-5 bg-white dark:bg-zinc-900 rounded-xl hover:shadow-md transition-all border border-gray-100 dark:border-zinc-800 hover:border-indigo-500/50 block h-full flex flex-col">
            <div class="flex items-center justify-between mb-3">
                 <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${typeBadgeColor}">${typeLabel}</span>
                 ${(model.fni_score !== undefined && model.fni_score !== null) ? `
                    <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-full ${fniBadgeClass}">
                        <span class="text-[10px] font-bold">🛡️ ${fni}</span>
                        ${fniPercentile >= 90 ? '<span class="text-[9px] opacity-80 font-bold border-l border-current/20 pl-1.5">TOP</span>' : ''}
                    </div>
                 ` : ''}
            </div>
            
            <h3 class="text-sm font-bold text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-1 mb-1" title="${displayTitle}">
                ${displayTitle}
            </h3>
            
            <p class="text-[11px] text-gray-400 dark:text-zinc-500 mb-3 uppercase tracking-wider font-medium">by ${author}</p>
            
            <p class="text-xs text-gray-600 dark:text-zinc-400 line-clamp-3 mb-4 flex-grow leading-relaxed">
                ${cleanDesc}
            </p>

            <div class="flex items-center gap-4 pt-4 border-t border-gray-50 dark:border-zinc-800 text-[10px] font-bold text-gray-400 uppercase tracking-tighter">
                ${model.downloads > 0 ? `
                    <div class="flex items-center gap-1">
                        <span>📥</span>
                        <span>${formatNumber(model.downloads)}</span>
                    </div>
                ` : ''}
                ${model.likes > 0 ? `
                    <div class="flex items-center gap-1">
                        <span>❤️</span>
                        <span>${formatNumber(model.likes)}</span>
                    </div>
                ` : ''}
            </div>
        </a>
    `;
}
