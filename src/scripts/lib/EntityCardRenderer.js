/**
 * EntityCardRenderer.js
 * Helper for UniversalCatalog to render entity cards.
 * Extracted to ensure CES Compliance (< 250 lines per file).
 */

export class EntityCardRenderer {
    static getLink(type, item) {
        const slug = item.slug || item.id;
        if (type === 'space') return `/space/${slug}`;
        if (type === 'tool') return `/tool/${slug}`;
        if (type === 'dataset') return `/dataset/${slug}`;
        if (type === 'paper') return `/paper/${slug}`;
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

    static createCardHTML(item, type) {
        // Sanitize description
        const cleanDesc = (item.description || '').replace(/<[^>]*>?/gm, '');
        const fniDisplay = item.fni_score && item.fni_score > 0
            ? `<span class="text-xs font-bold text-gray-500 dark:text-gray-400">🛡️ ${Math.round(item.fni_score)}</span>`
            : '';

        const typeLabel = this.getTypeLabel(type);
        const link = this.getLink(type, item);

        // Define color scheme based on type
        let badgeColor = 'bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300'; // Default Model
        if (type === 'agent') badgeColor = 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300';
        if (type === 'space') badgeColor = 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300';
        if (type === 'tool') badgeColor = 'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300';
        if (type === 'dataset') badgeColor = 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300';
        if (type === 'paper') badgeColor = 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300';

        // Override for SDK in Spaces
        let labelText = typeLabel;
        if (type === 'space' && item.sdk) {
            labelText = item.sdk; // e.g. "Gradio"
        }

        return `
            <a href="${link}" class="entity-card p-4 bg-white dark:bg-gray-800 rounded-xl hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 block fade-in">
                <div class="flex items-center justify-between mb-2">
                     <span class="text-xs px-2 py-0.5 rounded-full ${badgeColor} capitalize">${labelText}</span>
                     ${fniDisplay}
                </div>
                <h3 class="font-bold text-gray-900 dark:text-white truncate">${item.name || item.id}</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2" title="${cleanDesc}">${cleanDesc}</p>
                 <div class="flex items-center gap-3 mt-3 text-xs text-gray-400">
                    ${item.downloads ? `<span>📥 ${this.formatNumber(item.downloads)}</span>` : ''}
                    ${item.likes ? `<span>❤️ ${this.formatNumber(item.likes)}</span>` : ''}
                    ${item.authors ? `<span>👤 ${item.authors}</span>` : ''}
                </div>
            </a>
        `;
    }
}
