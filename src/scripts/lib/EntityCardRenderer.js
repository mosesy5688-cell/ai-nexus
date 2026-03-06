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
        let baseName = item.name || '';
        if (!baseName || baseName.toLowerCase() === 'unknown') {
            baseName = id.split('/').pop()?.split('--').pop()?.replace(/--/g, '/') || 'Untitled Entity';
        }
        const displayTitle = baseName;

        const author = extractAuthor(id, item.author || item.creator || item.organization);
        const description = item.description || item.summary || item.d || '';
        const fallbackDesc = description || 'Structural intelligence indexing in progress...';

        // R5.7.1 High Density description cleaning
        const cleanDesc = (fallbackDesc || "").replace(/<img[^>]*>/gi, "").replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, " ").trim().substring(0, 120);

        const link = generateEntityUrl(item, type);
        const isActive = isRecentlyActive(item.last_updated || item.lastModified);

        const fni = Math.round(item.fni_score ?? item.fni ?? 0);
        const fniPercentile = item.fni_percentile || item.percentile || '';

        // R5.7.1 Minimalism Tokens mapped to V22.10 Industrial
        let fniBadgeClass = "bg-black/40 border-white/5 text-zinc-500";
        if (fni >= 85) fniBadgeClass = "bg-emerald-950/30 border-emerald-500/20 text-emerald-500";
        else if (fni >= 70) fniBadgeClass = "bg-indigo-950/30 border-indigo-500/20 text-indigo-400";
        else if (fni > 0) fniBadgeClass = "bg-zinc-900/50 border-white/10 text-white";

        const typeLabel = (item.pipeline_tag || item.primary_category || type).replace(/-/g, ' ');

        const metrics = [];
        if (type === 'model' || type === 'dataset' || type === 'space') {
            if (type === 'model' && item.params_billions > 0) metrics.push({ icon: '🧠', value: `${item.params_billions}B`, label: 'Params' });
            if (type === 'model' && item.context_length > 0) metrics.push({ icon: '📏', value: this.formatNumber(item.context_length), label: 'Context' });
            if (item.downloads > 0) metrics.push({ icon: '📥', value: this.formatNumber(item.downloads), label: 'Downloads' });
            if (item.likes > 0) metrics.push({ icon: '❤️', value: this.formatNumber(item.likes), label: 'Likes' });
        } else if (type === 'agent' || type === 'tool') {
            const stars = item.github_stars || item.stars || 0;
            if (stars > 0) metrics.push({ icon: '⭐', value: this.formatNumber(stars), label: 'Stars' });
        } else if (type === 'paper') {
            const citations = item.citations || 0;
            if (citations > 0) metrics.push({ icon: '📚', value: this.formatNumber(citations), label: 'Citations' });
            const year = item.published_date ? new Date(item.published_date).getFullYear() : null;
            if (year) metrics.push({ icon: '📅', value: year, label: 'Published' });
        }

        return `
            <a href="${link}" data-astro-prefetch class="entity-card group py-2 px-3 bg-[var(--bg-surface)] rounded-sm transition-all border border-[var(--border-hairline)] hover:border-zinc-500 flex flex-col md:flex-row md:items-center justify-between w-full h-auto gap-2 md:gap-4 relative overflow-hidden" data-entity-id="${id}" data-entity-type="${type}">
                <!-- Left: Identity -->
                <div class="flex items-center gap-3 md:w-1/4 shrink-0 overflow-hidden">
                    <span class="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-sm bg-black/20 text-zinc-500 border border-white/5 shrink-0 min-w-[60px] text-center truncate">${typeLabel}</span>
                    ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>' : ''}
                    <h3 class="text-xs font-bold text-white group-hover:text-[#bdc3ff] transition-colors truncate" title="${displayTitle}">
                        ${displayTitle}
                    </h3>
                </div>
                
                <!-- Mid: Description -->
                <div class="flex-1 truncate hidden md:block border-l border-[var(--border-hairline)] pl-4">
                    <p class="text-[10px] text-zinc-400 truncate mt-0.5 font-medium">
                        ${cleanDesc}
                    </p>
                </div>

                <!-- Right: Author, Badges & Metrics -->
                <div class="flex items-center gap-4 shrink-0 whitespace-nowrap justify-between md:justify-end md:w-[35%] border-t md:border-t-0 border-[var(--border-hairline)] pt-2 md:pt-0">
                    <span class="text-[9px] text-zinc-500 font-medium truncate max-w-[100px]">by <strong class="text-zinc-400 font-bold">${author || 'Unknown'}</strong></span>
                    
                    <div class="flex items-center gap-1.5 justify-end hidden sm:flex">
                        ${(fni > 0 || fniPercentile) ? `
                            <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-sm border relative z-10 fni-badge-container ${fniBadgeClass}">
                                <span class="text-[10px] font-black tabular-nums fni-value">${fni > 0 ? fni : '0'}</span>
                                <span class="text-[8px] font-bold uppercase tracking-widest opacity-80">FNI</span>
                            </div>
                        ` : ''}
                    </div>

                    <div class="flex items-center gap-3 text-[9px] font-bold text-zinc-500 uppercase tracking-widest justify-end min-w-[120px] metrics-container">
                        ${metrics.map(m => `
                            <div class="flex items-center gap-1 shrink-0" title="${m.label}">
                                <span class="text-white tabular-nums">${m.value}</span>
                                <span class="opacity-40">${m.label.substring(0, 3)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </a>
        `;
    }
}
