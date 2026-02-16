/**
 * catalog-fetcher.js (V16.9.23)
 * SSR Data Orchestrator for 6 Entity Catalogs & Category Hubs
 * Handles R2 (internal) -> CDN (public) fallback with Tiered Recovery.
 */
import { DataNormalizer } from '../scripts/lib/DataNormalizer.js';
import { loadCachedJSON } from './loadCachedJSON.js';

/**
 * Fetches catalog data with tiered fallback
 * @param {string} typeOrCategory - Entity type (model, agent...) or Category ID
 * @param {object} runtime - Optional environment for R2 direct access (Astro context)
 */
export async function fetchCatalogData(typeOrCategory, runtime = null) {
    const isType = ['model', 'agent', 'dataset', 'paper', 'space', 'tool'].includes(typeOrCategory);
    const locals = runtime?.locals || runtime || null;

    // V16.9.23: Dual-Mode Path Discovery
    const paginatedPath = `cache/rankings/${typeOrCategory}/p1.json`;
    const legacyPath = `cache/rankings/${typeOrCategory}-fni-top.json`;

    let items = [];
    let source = 'none';

    // Tier 1: Primary Rankings (loadCachedJSON handles R2/CDN and .gz)
    const { data: rankData, source: rankSource } = await loadCachedJSON(paginatedPath, { locals });
    if (rankData) {
        items = extractItems(rankData);
        source = `rankings-p1-${rankSource}`;
    }

    // Tier 2: Legacy Fallback
    if (items.length === 0) {
        const { data: legacyData, source: legacySource } = await loadCachedJSON(legacyPath, { locals });
        if (legacyData) {
            items = extractItems(legacyData);
            source = `rankings-legacy-${legacySource}`;
        }
    }

    // Tier 3: Tool-specific search-shard-0.json fallback
    if (items.length === 0 && typeOrCategory === 'tool') {
        const { data: toolData } = await loadCachedJSON('cache/search/shard-0.json', { locals });
        if (toolData) {
            const allRaw = extractItems(toolData);
            items = allRaw.filter(i => i.type === 'tool' || i.t === 'tool');
            source = 'search-index-fallback';
        }
    }

    // Tier 4: Trending Fallback (Emergency)
    if (items.length === 0) {
        // Parallel check for trending/trend-data
        const [trend1, trend2] = await Promise.all([
            loadCachedJSON('cache/trending.json', { locals }),
            loadCachedJSON('cache/trend-data.json', { locals })
        ]);

        const trendData = trend1.data || trend2.data;
        if (trendData) {
            const allRaw = extractItems(trendData);
            if (isType) {
                items = allRaw.filter(i => (i.type || i.t) === typeOrCategory || (typeOrCategory === 'model' && !(i.type || i.t)));
            } else {
                items = allRaw.filter(i => (i.category === typeOrCategory || i.primary_category === typeOrCategory));
            }
            items = items.slice(0, 50);
            source = `trending-fallback-${trend1.data ? 'trending' : 'trend-data'}`;
        }
    }

    // SSR Optimization: Cap the total number of items to normalize to prevent Error 1102
    // V18.2.5: Aggressive reduction for SSR (24 items) to avoid OOM in Workers
    const isSSR = Boolean(locals?.env || (typeof process !== 'undefined' && process.env.AGGREGATOR_MODE));
    const finalItems = items.slice(0, isSSR ? 24 : 100);

    const normalized = DataNormalizer.normalizeCollection(finalItems, isType ? typeOrCategory : 'model');
    console.log(`[CatalogFetcher] Resolved ${normalized.length} items (SSR Cap: ${isSSR ? 24 : 100}) for ${typeOrCategory} via ${source}`);

    return {
        items: normalized,
        error: normalized.length === 0 ? 'No entities found' : null,
        data_missing: normalized.length === 0,
        source
    };
}

function extractItems(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.entities || data.models || data.items || [];
}

/**
 * Truncates and cleans data for lightweight SSR injection
 */
export function truncateListingItem(item) {
    if (!item) return null;
    return {
        id: item.id || item.slug || '',
        name: item.name || item.title || '',
        author: item.author || item.creator || item.organization || '',
        // V18.2.5 Fix: Recover summary from multiple potential fields
        description: item.description || item.summary || item.seo_summary?.description || '',
        type: item.type || item.entity_type || 'model',
        downloads: item.downloads || 0,
        likes: item.likes || 0,
        // SPEC-CORE-METRICS: Universal promotions
        stars: item.stars || item.github_stars || 0,
        forks: item.forks || item.github_forks || 0,
        citations: item.citations || 0,
        published_date: item.published_date || '',
        runtime: item.runtime || null,
        size: item.size || '',
        fni_score: item.fni_score ?? item.fni ?? 0,
        fni_percentile: item.fni_percentile || '',
        pipeline_tag: item.pipeline_tag || item.primary_category || '',
        lastModified: item.lastModified || item._updated || ''
    };
}
