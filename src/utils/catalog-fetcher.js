/**
 * catalog-fetcher.js (V16.9.23)
 * SSR Data Orchestrator for 6 Entity Catalogs & Category Hubs
 * Handles R2 (internal) -> CDN (public) fallback with Tiered Recovery.
 */
import { DataNormalizer } from '../scripts/lib/DataNormalizer.js';

const CDN_BASE = 'https://cdn.free2aitools.com/cache';

/**
 * Fetches catalog data with tiered fallback
 * @param {string} typeOrCategory - Entity type (model, agent...) or Category ID
 * @param {object} runtimeEnv - Optional environment for R2 direct access (Astro context)
 */
export async function fetchCatalogData(typeOrCategory, runtime = null) {
    const isType = ['model', 'agent', 'dataset', 'paper', 'space', 'tool'].includes(typeOrCategory);
    const env = runtime?.env || runtime || null;

    // V16.5: SSOT Tier 1 - Rankings (FNI Top 100)
    const rankingPath = `rankings/${typeOrCategory}-fni-top.json`;
    const cdnUrl = `${CDN_BASE}/${rankingPath}`;

    let items = [];
    let source = 'none';

    // Tier 0: Local Dev Bypassing (CORS Strategy)
    // Uses the local data-mirror proxy to avoid CORS on localhost
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        try {
            console.log(`[CatalogFetcher] Dev Mode: Fetching via data-mirror for ${typeOrCategory}`);
            const localRes = await fetch(`/data-mirror/${rankingPath}`);
            if (localRes.ok) {
                const data = await localRes.json();
                items = extractItems(data);
                source = 'localhost-mirror';
            }
        } catch (e) {
            console.warn(`[CatalogFetcher] Local mirror miss: ${e.message}`);
        }
    }

    // Tier 1: Try R2 Internal (Direct O(1) access)
    // In Astro SSR, env.R2_ASSETS should be available if bound
    if (items.length === 0 && env?.R2_ASSETS) {
        try {
            // R2 store uses cache/ prefix usually
            const obj = await env.R2_ASSETS.get(`cache/${rankingPath}`);
            if (obj) {
                const data = await obj.json();
                items = extractItems(data);
                source = 'r2-internal';
            }
        } catch (e) {
            console.warn(`[CatalogFetcher] R2 miss: ${e.message}`);
        }
    }

    // Tier 2: Try CDN Rankings
    if (items.length === 0) {
        try {
            const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                items = extractItems(data);
                source = 'cdn-rankings';
            }
        } catch (e) {
            console.warn(`[CatalogFetcher] CDN fail for ${typeOrCategory}: ${e.message}`);
        }
    }

    // Tier 3: Anti-Crash Fallback (Tool-specific search-shard-0.json)
    if (items.length === 0 && typeOrCategory === 'tool') {
        try {
            const indexUrl = `${CDN_BASE}/search/shard-0.json`;
            const res = await fetch(indexUrl);
            if (res.ok) {
                const data = await res.json();
                const allRaw = extractItems(data);
                items = allRaw.filter(i => i.type === 'tool');
                source = 'search-index-fallback';
            }
        } catch (e) {
            console.error(`[CatalogFetcher] Tool Fallback Failed:`, e.message);
        }
    }

    // Tier 4: Trending Fallback (Legacy/Emergency)
    if (items.length === 0) {
        try {
            const trendUrl = `${CDN_BASE}/trending.json`;
            const res = await fetch(trendUrl);
            if (res.ok) {
                const data = await res.json();
                const allRaw = extractItems(data);

                if (isType) {
                    items = allRaw.filter(i => i.type === typeOrCategory || (typeOrCategory === 'model' && !i.type));
                } else {
                    items = allRaw.filter(i => (i.category === typeOrCategory || i.primary_category === typeOrCategory));
                }
                source = 'trending-fallback';
            }
        } catch (e) {
            console.error(`[CatalogFetcher] Critical Fallback Failed:`, e.message);
        }
    }

    const normalized = DataNormalizer.normalizeCollection(items, isType ? typeOrCategory : 'model');
    console.log(`[CatalogFetcher] Resolved ${normalized.length} items for ${typeOrCategory} via ${source}`);

    return {
        items: normalized,
        error: normalized.length === 0 ? 'No entities found' : null,
        source
    };
}

function extractItems(data) {
    if (Array.isArray(data)) return data;
    return data.entities || data.models || data.items || [];
}

/**
 * Truncates and cleans data for lightweight SSR injection
 */
export function truncateListingItem(item) {
    if (!item) return null;
    return {
        id: item.id || '',
        name: item.name || '',
        author: item.author || 'Nexus Collective',
        description: (item.description || '').replace(/<[^>]*>?/gm, ''),
        slug: item.slug || '',
        type: item.type || 'model',
        fni_score: item.fni_score || 0,
        downloads: item.downloads || 0,
        likes: item.likes || 0,
        category: item.category || ''
    };
}
