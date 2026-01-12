// src/utils/entity-cache-reader-depth.js
/**
 * V6.3 Depth Entity Cache Reader
 * Constitutional: Art.I-Extended - Frontend D1 = 0
 * 
 * Part of entity-cache-reader-v6 splitting for CES compliance (250 line limit)
 */

/**
 * Normalize slug for cache file lookup (Shared)
 */
function normalizeForCache(slug, entityType = 'model') {
    if (!slug) return '';
    let parts = Array.isArray(slug) ? slug : slug.split('/');
    if (parts.length === 1 && parts[0].includes(':')) {
        const [source, rest] = parts[0].split(':');
        parts = [source, ...rest.split('/')];
    }
    if (parts.length === 2) {
        const sourcePrefix = entityType === 'space' ? 'hf-space'
            : entityType === 'dataset' ? 'hf-dataset'
                : 'huggingface';
        parts = [sourcePrefix, ...parts];
    }
    return parts
        .map(p => p.toLowerCase().trim())
        .join('--')
        .replace(/:/g, '--');
}

/**
 * Get dataset data from R2 cache
 */
export async function getDatasetFromCache(slug, locals) {
    if (!slug) return null;
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) {
        if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
            const normalizedSlug = normalizeForCache(slug, 'dataset');
            try {
                const fs = await import('fs');
                const localPath = 'G:/ai-nexus/data/merged.json';
                if (fs.existsSync(localPath)) {
                    const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                    const found = data.find(m => normalizeForCache(m.slug || m.id, 'dataset') === normalizedSlug);
                    if (found) return { ...found, _cache_source: 'local-fs-shim' };
                }
            } catch (e) { }
        }
        return null;
    }

    const normalizedSlug = normalizeForCache(slug, 'dataset');
    const rawSlug = slug.replace(/\//g, '--').replace(/:/g, '--');
    const cachePaths = [
        `cache/entities/dataset/${normalizedSlug}.json`,
        `cache/entities/dataset/huggingface--${rawSlug}.json`,
        `cache/entities/dataset/hf-dataset--${rawSlug}.json`,
        `cache/entities/dataset/dataset--${rawSlug}.json`,
        `cache/entities/dataset/${rawSlug}.json`,
        `cache/entities/dataset/github--${rawSlug}.json`
    ];

    for (const cachePath of cachePaths) {
        try {
            const cacheFile = await r2.get(cachePath);
            if (cacheFile) {
                const cacheData = await cacheFile.json();
                return {
                    ...cacheData.entity || cacheData,
                    _cache_source: 'r2-cache',
                    _contract_version: cacheData.contract_version,
                };
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
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (!r2) {
        if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
            const normalizedSlug = normalizeForCache(slug, 'paper');
            try {
                const fs = await import('fs');
                const localPath = 'G:/ai-nexus/data/merged.json';
                if (fs.existsSync(localPath)) {
                    const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
                    const found = data.find(m => normalizeForCache(m.slug || m.id, 'paper') === normalizedSlug);
                    if (found) return { ...found, _cache_source: 'local-fs-shim' };
                }
            } catch (e) { }
        }
        return null;
    }

    const normalizedSlug = normalizeForCache(slug, 'paper');
    const rawSlug = slug.replace(/\//g, '--').replace(/:/g, '--');
    const cachePaths = [
        `cache/entities/paper/${normalizedSlug}.json`,
        `cache/entities/paper/arxiv--${rawSlug}.json`,
        `cache/entities/paper/paper--${rawSlug}.json`,
        `cache/entities/paper/${rawSlug}.json`
    ];

    for (const cachePath of cachePaths) {
        try {
            const cacheFile = await r2.get(cachePath);
            if (cacheFile) {
                const cacheData = await cacheFile.json();
                return {
                    ...cacheData.entity || cacheData,
                    _cache_source: 'r2-cache',
                    _contract_version: cacheData.contract_version,
                };
            }
        } catch (e) { }
    }
    return null;
}
