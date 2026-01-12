// src/utils/entity-cache-reader-depth.js
/**
 * V6.3 Depth Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Part of entity-cache-reader-v6 splitting for CES compliance (250 line limit)
 */

import { fetchEntityFromR2 } from './entity-cache-reader-core.js';

/**
 * Get dataset data from R2 cache
 */
export async function getDatasetFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('dataset', slug, locals);
    if (result) return { ...result.entity, _cache_source: 'r2-cache' };

    // Dev Shim
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
        try {
            const { normalizeEntitySlug } = await import('./entity-cache-reader-core.js');
            const targetId = normalizeEntitySlug(slug, 'dataset');
            const fs = await import('fs');
            const localPath = 'G:/ai-nexus/data/merged.json';
            if (fs.existsSync(localPath)) {
                const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                const found = data.find(m => normalizeEntitySlug(m.id || m.slug, 'dataset') === targetId);
                if (found) return { ...found, _cache_source: 'local-fs-shim' };
            }
        } catch (e) { }
    }
    return null;
}

/**
 * Get paper data from R2 cache
 */
export async function getPaperFromCache(slug, locals) {
    if (!slug) return null;
    const result = await fetchEntityFromR2('paper', slug, locals);
    if (result) return { ...result.entity, _cache_source: 'r2-cache' };

    // Dev Shim
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
        try {
            const { normalizeEntitySlug } = await import('./entity-cache-reader-core.js');
            const targetId = normalizeEntitySlug(slug, 'paper');
            const fs = await import('fs');
            const localPath = 'G:/ai-nexus/data/merged.json';
            if (fs.existsSync(localPath)) {
                const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                const found = data.find(m => normalizeEntitySlug(m.id || m.slug, 'paper') === targetId);
                if (found) return { ...found, _cache_source: 'local-fs-shim' };
            }
        } catch (e) { }
    }
    return null;
}
