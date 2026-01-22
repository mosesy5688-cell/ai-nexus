// src/scripts/lib/DataNormalizer.js
/**
 * Shared data normalization logic for V16.2 Search & Catalog
 * Ensures consistent fields across different data sources (core vs full json)
 */
export const DataNormalizer = {
    normalize(item, defaultType = 'model') {
        const id = item.id;
        const type = item.type || defaultType;
        let name = item.name || '';
        let slug = item.slug || '';
        let author = item.author || '';

        // Derive missing name from ID
        if (!name && id) {
            name = id.split('--').pop().split(':').pop().split('/').pop();
        }

        // Derive missing slug from ID
        if (!slug && id) {
            slug = id.replace(/^(github--|hf-dataset--|arxiv--|replicate:)/, '')
                .replace('--', '/')
                .replace(':', '/');
        }

        // Derive missing author from ID
        if (!author && id) {
            if (id.includes('--')) {
                author = id.split('--')[1];
            } else if (id.includes(':')) {
                author = id.split(':')[1].split('/')[0];
            }
        }

        return {
            ...item,
            id,
            name,
            type,
            slug,
            author,
            // Handle both legacy 'fni' and current 'fni_score'
            fni_score: item.fni || item.fni_score || 0
        };
    },

    /**
     * Normalizes a collection of items
     */
    normalizeCollection(items, defaultType = 'model') {
        if (!Array.isArray(items)) return [];
        return items.map(item => this.normalize(item, defaultType));
    }
};
