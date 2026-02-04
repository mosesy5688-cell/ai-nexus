/**
 * EntityCardRenderer.js
 * Helper for UniversalCatalog to render entity cards.
 * Extracted to ensure CES Compliance (< 250 lines per file).
 */
import { stripPrefix } from '../../utils/mesh-routing-core.js';

export class EntityCardRenderer {
    static getLink(type, item) {
        let slug = item.slug || item.id;
        // Standardized slug stripping
        // V16.9.23: Use centralized SSOT logic for maximal backward compatibility
        slug = stripPrefix(slug).replace(/--/g, '/');

        if (type === 'space') return `/space/${slug}`;
        if (type === 'tool') return `/tool/${slug}`;
        if (type === 'dataset') return `/dataset/${slug}`;
        if (type === 'paper') return `/paper/${slug}`;
        if (type === 'agent') return `/agent/${slug}`;
        return `/${type}/${slug}`;
    }

    static getTypeLabel(type) {
        if (type === 'space') return 'Space';
        if (type === 'tool') return 'Tool';
        if (type === 'dataset') return 'Dataset';
        if (type === 'paper') return 'Paper';
        return type;
    }

    static formatNumber(num) {
        return new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(num);
    }

    static cleanText(text) {
        if (!text) return '';
        return text
            // Remove HTML tags
            .replace(/<[^>]*>?/gm, '')
            // Remove Markdown images ![alt](url)
            .replace(/!\[.*?\]\(.*?\)/g, '')
            // Remove Markdown links [text](url) -> text
            .replace(/\[(.*?)\]\(.*?\)/g, '$1')
            // Remove raw long URLs (common in bad data)
            .replace(/https?:\/\/[^\s]{30,}/g, '')
            // Remove specific common clutter
            .replace(/!GitHub repo size|!Harbor Ko-fi/gi, '')
            // Clean up whitespace
            .replace(/\s+/g, ' ')
            .trim();
    }

    static createCardHTML(item, type) {
        const cleanDesc = this.cleanText(item.description || item.summary || '');
        const fniDisplay = item.fni_score && item.fni_score > 0
            ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full ${(item.fni_percentile || 0) >= 90 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500'}">🛡️ ${Math.round(item.fni_score)}</span>`
            : '';

        const typeLabel = (item.pipeline_tag || item.primary_category || type).replace(/-/g, ' ');
        const link = this.getLink(type, item);

        // Define color scheme based on type - Professional Muted Palette
        let badgeColor = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
        if (type === 'model') badgeColor = 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400';
        if (type === 'agent') badgeColor = 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400';
        if (type === 'dataset') badgeColor = 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400';

        const displayTitle = item.name || item.id?.split('/').pop() || 'Untitled Entity';

        return `
            <a href="${link}" class="entity-card group p-5 bg-white dark:bg-zinc-900 rounded-xl hover:shadow-md transition-all border border-gray-100 dark:border-zinc-800 hover:border-indigo-500/50 block h-full flex flex-col">
                <div class="flex items-center justify-between mb-3">
                     <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${badgeColor}">${typeLabel}</span>
                     ${fniDisplay}
                </div>
                <h3 class="text-sm font-bold text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-1" title="${displayTitle}">${displayTitle}</h3>
                <p class="text-[11px] text-gray-400 dark:text-zinc-500 mt-1 mb-3 uppercase tracking-wider font-medium">by ${item.author || item.creator || 'Nexus Collective'}</p>
                <p class="text-xs text-gray-600 dark:text-zinc-400 line-clamp-3 mb-4 flex-grow leading-relaxed" title="${cleanDesc}">${cleanDesc || 'Structural intelligence indexing in progress...'}</p>
                 <div class="flex items-center gap-4 pt-4 border-t border-gray-50 dark:border-zinc-800 text-[10px] font-bold text-gray-400 uppercase tracking-tighter">
                    ${item.downloads ? `<span>📥 ${this.formatNumber(item.downloads)}</span>` : ''}
                    ${item.likes ? `<span>❤️ ${this.formatNumber(item.likes)}</span>` : ''}
                </div>
            </a>
        `;
    }
}

