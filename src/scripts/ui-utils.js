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

    // Extraction Logic (Sync with entity-utils.js)
    const id = model.id || model.umid || '';
    const name = model.name || id.split(/[:/]/).pop()?.replace(/--/g, '/') || 'unknown';

    let author = model.author || model.creator;
    const isNumeric = /^\d+$/.test(author);
    if (!author || isNumeric) {
        const cleanId = id.replace(/^[a-z]+:/i, '').replace(/^[a-z]+-[a-z]+--/i, '');
        const parts = cleanId.split(/[:/]/);
        author = parts.length >= 2 ? parts[0] : 'Open Source';
    }

    const getSource = (id) => {
        const lowId = (id || '').toLowerCase();
        if (lowId.startsWith('hf:') || lowId.includes('huggingface')) return { icon: '🤗', label: 'HF' };
        if (lowId.startsWith('gh:') || lowId.includes('github')) return { icon: '🐙', label: 'GH' };
        if (lowId.startsWith('arxiv:') || lowId.includes('arxiv')) return { icon: '📄', label: 'ArXiv' };
        if (lowId.includes('pytorch')) return { icon: '🔥', label: 'PT' };
        return { icon: '📦', label: 'Source' };
    };
    const source = getSource(id || model.source);

    const lastUpdate = new Date(model.last_updated || model.lastModified || 0);
    const isActive = lastUpdate.getTime() > 0 && (Date.now() - lastUpdate.getTime()) / (1000 * 3600 * 24) <= 30;

    const type = model.type || model.entity_type || getTypeFromId(id);
    const modelUrl = getRouteFromId(id || model.slug || '', type);

    const description = (model.description || model.summary || 'Indexing structural intelligence...')
        .replace(/<[^>]*>?/gm, '');

    const tags = (typeof model.tags === 'string' ? JSON.parse(model.tags || '[]') : (model.tags || [])).slice(0, 2);

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
                 <div class="flex items-center gap-2">
                    <span class="text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${typeBadgeColor}">${typeLabel}</span>
                    <div class="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-zinc-500 font-black uppercase tracking-widest">
                        <span title="${source.label}">${source.icon}</span>
                        ${isActive ? `<span class="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse" title="Active"></span>` : ''}
                    </div>
                 </div>
                 ${fni > 0 ? `
                    <div class="text-xs px-2 py-1 rounded-full font-bold shadow-sm bg-indigo-600/90 text-white">
                        🛡️ ${fniPercentile?.startsWith('top_') ? fniPercentile.replace('top_', 'Top ') : `FNI ${fni}`}
                    </div>
                 ` : ''}
            </div>
            <h3 class="text-sm font-black text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-2 mt-1 mb-1 tracking-tight" title="${name}">
                ${name}
            </h3>
            <p class="text-[11px] text-gray-400 dark:text-zinc-500 mb-3 uppercase tracking-[0.15em] font-black">by ${author}</p>
            <p class="text-sm text-gray-600 dark:text-zinc-400 line-clamp-3 mb-4 flex-grow leading-relaxed">${description}</p>
            
            <div class="flex items-center justify-between pt-4 border-t border-gray-50 dark:border-zinc-800/50">
                <div class="flex flex-wrap gap-1.5">
                    ${tags.map(tag => `
                        <span class="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500 rounded border border-gray-100 dark:border-zinc-700/50">
                            ${tag}
                        </span>
                    `).join('')}
                </div>
                <div class="flex items-center gap-3 text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none">
                    <div class="flex items-center gap-1" title="Downloads/Usage">
                        <span>📥</span>
                        <span>${formatNumber(model.downloads || model.download_count)}</span>
                    </div>
                    <div class="flex items-center gap-1" title="Likes">
                        <span>❤️</span>
                        <span>${formatNumber(model.likes || model.likes_count)}</span>
                    </div>
                </div>
            </div>
        </a>
    `;
}

