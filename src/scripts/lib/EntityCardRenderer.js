/**
 * EntityCardRenderer.js
 * Helper for UniversalCatalog to render entity cards.
 * Extracted to ensure CES Compliance (< 250 lines per file).
 */
import { generateEntityUrl } from '../../utils/url-utils.js';
import { extractAuthor, isActive as isRecentlyActive } from '../../utils/entity-utils.js';

export class EntityCardRenderer {
    static formatNumber(num) {
        if (!num) return 0;
        return new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(num);
    }

    static cleanText(text) {
        if (!text) return '';
        return text.replace(/<[^>]*>?/gm, '').substring(0, 150) + '...';
    }

    static createCardHTML(item, type) {
        const id = item.id || item.slug || '';
        const displayTitle = item.name || id.split('/').pop()?.replace(/--/g, '/') || 'Untitled Entity';
        const author = extractAuthor(id, item.author || item.creator || item.organization);
        const description = (item.description || item.summary || 'Structural intelligence indexing in progress...');
        const cleanDesc = this.cleanText(description);
        const link = generateEntityUrl(item, type);
        const isActive = isRecentlyActive(item.last_updated || item.lastModified);

        const fni = Math.round(item.fni_score ?? item.fni ?? 0);
        const fniPercentile = item.fni_percentile || item.percentile || '';

        let fniBadgeClass = "bg-gray-100 dark:bg-zinc-800 text-gray-500";
        if (fni >= 85) fniBadgeClass = "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400";
        else if (fni >= 70) fniBadgeClass = "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400";
        else if (fni > 0) fniBadgeClass = "bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400";

        let typeBadgeColor = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
        if (type === 'model') typeBadgeColor = 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400';
        if (type === 'agent') typeBadgeColor = 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400';
        if (type === 'dataset') typeBadgeColor = 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400';
        if (type === 'tool') typeBadgeColor = 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400';
        if (type === 'paper') typeBadgeColor = 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
        if (type === 'space') typeBadgeColor = 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';

        const typeLabel = (item.pipeline_tag || item.primary_category || type).replace(/-/g, ' ');

        // V19.1 Polymorphic Metrics Calculation
        const metrics = [];
        if (type === 'model' || type === 'dataset' || type === 'space') {
            if (item.downloads > 0) metrics.push({ icon: '📥', value: this.formatNumber(item.downloads), label: 'Downloads' });
            if (item.likes > 0) metrics.push({ icon: '❤️', value: this.formatNumber(item.likes), label: 'Likes' });
            if (type === 'dataset' && item.size) metrics.push({ icon: '💾', value: item.size, label: 'Size' });
            if (type === 'space' && item.runtime) metrics.push({ icon: '🚀', value: item.runtime, label: 'Runtime' });
        } else if (type === 'agent' || type === 'tool') {
            const stars = item.github_stars || item.stars || 0;
            const forks = item.github_forks || item.forks || 0;
            if (stars > 0) metrics.push({ icon: '⭐', value: this.formatNumber(stars), label: 'Stars' });
            if (forks > 0) metrics.push({ icon: '🍴', value: this.formatNumber(forks), label: 'Forks' });
        } else if (type === 'paper') {
            const citations = item.citations || 0;
            if (citations > 0) metrics.push({ icon: '📚', value: this.formatNumber(citations), label: 'Citations' });
            const year = item.published_date ? new Date(item.published_date).getFullYear() : null;
            if (year) metrics.push({ icon: '📅', value: year, label: 'Published' });
        }

        return `
            <a href="${link}" class="entity-card group p-5 bg-white dark:bg-zinc-900 rounded-xl hover:shadow-md transition-all border border-gray-100 dark:border-zinc-800 hover:border-indigo-500/50 block h-full flex flex-col">
                <div class="flex items-center justify-between mb-3">
                     <div class="flex items-center gap-2">
                         <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${typeBadgeColor}">${typeLabel}</span>
                         ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Recently updated"></span>' : ''}
                     </div>
                     ${(fni > 0 || fniPercentile) ? `
                        <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-full ${fniBadgeClass}">
                            <span class="text-[10px] font-bold">🛡️ ${fni > 0 ? fni : ''}</span>
                            ${(fniPercentile && typeof fniPercentile === 'string' && fniPercentile.startsWith('top_')) ?
                    `<span class="text-[9px] opacity-80 font-bold border-l border-current/20 pl-1.5">${fniPercentile.replace('top_', 'Top ')}</span>`
                    : (fniPercentile && typeof fniPercentile === 'number' && fniPercentile >= 90) ?
                        `<span class="text-[9px] opacity-80 font-bold border-l border-current/20 pl-1.5">Top ${100 - fniPercentile}%</span>`
                        : ''}
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
                    ${metrics.map(m => `
                        <div class="flex items-center gap-1" title="${m.label}">
                            <span>${m.icon}</span>
                            <span>${m.value}</span>
                        </div>
                    `).join('')}
                </div>
            </a>
        `;
    }
}
