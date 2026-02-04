// src/scripts/lib/DataNormalizer.js
/**
 * Shared data normalization logic for V16.2 Search & Catalog
 * Ensures consistent fields across different data sources (core vs full json)
 */
import { stripPrefix } from '../../utils/mesh-routing-core.js';

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

        if (!slug && id) {
            // V16.9.23: Use centralized SSOT logic for maximal backward compatibility
            slug = stripPrefix(id).replace(/--/g, '/');
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
            category: item.category || item.pipeline_tag || item.primary_category || '',
            // Handle both legacy 'fni' and current 'fni_score'
            fni_score: parseFloat(item.fni || item.fni_score || 0)
        };
    },

    /**
     * Normalizes a collection of items
     */
    normalizeCollection(items, defaultType = 'model') {
        if (!Array.isArray(items)) return [];
        return items.map(item => this.normalize(item, defaultType));
    },

    /**
     * Sorts a collection based on a specified criteria
     */
    sortCollection(items, sortBy) {
        switch (sortBy) {
            case 'fni':
                items.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
                break;
            case 'downloads':
                items.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
                break;
            case 'likes':
                items.sort((a, b) => (b.likes || 0) - (a.likes || 0));
                break;
            case 'recent':
                items.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
                break;
            case 'name':
                items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                break;
        }
        return items;
    }
};
