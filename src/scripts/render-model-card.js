// src/scripts/render-model-card.js
// Shared client-side template for rendering model cards
// V5.0: CES-001 Clean URL format
// V19.2: Unified Premium Entity Card (Client-Side)
import { getRouteFromId, getTypeFromId } from '../utils/mesh-routing-core.js';

export function renderModelCard(model) {
    let author = model.author;
    if (!author && model.id) {
        const cleanId = model.id.replace(/^[a-z]+:/i, '');
        const parts = cleanId.split(/[:/]/);
        if (parts.length >= 2) author = parts[0];
    }
    author = author || 'unknown';
    const name = model.name || model.id?.split(/[:/]/).pop()?.replace(/--/g, '/') || 'unknown';
    const entityType = model.type || model.entity_type || getTypeFromId(model.id || '');
    const modelUrl = getRouteFromId(model.id || model.slug || '', entityType);

    const description = (model.description || model.summary || 'No description available.')
        .replace(/\<[^>]*>?/gm, '')
        .substring(0, 120) + (model.description?.length > 120 ? '...' : '');

    const fni = Math.round(model.fni_score || 0);
    const fniPercentile = model.fni_percentile;

    let meta = {};
    try {
        meta = typeof model.meta_json === 'string' ? JSON.parse(model.meta_json || '{}') : (model.meta_json || {});
    } catch (e) { meta = {}; }
    const ext = meta.extended || {};
    const params = ext.params_billions || 0;
    const hasQuant = (ext.quantizations?.length || 0) > 0;
    const vram = params ? Math.ceil(hasQuant ? (params * 0.6 + 2) : (params * 2.2 + 4)) : null;
    const sizeTag = params ? (params >= 1 ? `${params}B` : `${Math.round(params * 1000)}M`) : null;

    const typeColors = {
        model: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
        agent: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
        dataset: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400',
        tool: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
        paper: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
        space: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    };
    const typeBadgeColor = typeColors[entityType] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
    const typeLabel = (model.pipeline_tag || model.primary_category || entityType).replace(/-/g, ' ');

    function formatNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n || 0;
    }

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
        
        ${(sizeTag || vram) && entityType === 'model' ? `
            <div class="flex flex-wrap gap-2 mb-3">
                ${sizeTag ? `<span class="text-[10px] font-mono font-bold px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded">${sizeTag}</span>` : ''}
                ${vram ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${vram <= 12 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' : vram <= 24 ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'}">💾 ${vram}GB VRAM</span>` : ''}
            </div>
        ` : ''}

        <h3 class="text-sm font-black text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-2 mt-1 mb-1 tracking-tight" title="${name}">${name}</h3>
        <p class="text-[11px] text-gray-400 dark:text-zinc-500 mb-3 uppercase tracking-[0.15em] font-black">by ${author}</p>
        <p class="text-xs text-gray-600 dark:text-zinc-400 line-clamp-3 mb-4 flex-grow leading-relaxed">${description}</p>

        <div class="flex items-center gap-4 pt-4 border-t border-gray-50 dark:border-zinc-800/50 text-[10px] font-black text-gray-400 uppercase tracking-widest">
            <div class="flex items-center gap-1.5" title="Downloads">📥 <span>${formatNumber(model.downloads || model.download_count)}</span></div>
            <div class="flex items-center gap-1.5" title="Likes">❤️ <span>${formatNumber(model.likes || model.likes_count)}</span></div>
            ${(model.github_stars || model.stars) > 0 ? `<div class="flex items-center gap-1.5" title="Stars">⭐ <span>${formatNumber(model.github_stars || model.stars)}</span></div>` : ''}
        </div>
    </a>
    `;
}

