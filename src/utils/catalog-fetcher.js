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
export async function fetchCatalogData(typeOrCategory, runtimeEnv = null) {
    const isType = ['model', 'agent', 'dataset', 'paper', 'space', 'tool'].includes(typeOrCategory);

    // rankings/[type|category]/p1.json
    const path = `rankings/${typeOrCategory}/p1.json`;
    const cdnUrl = `${CDN_BASE}/${path}`;

    let items = [];
    let source = 'none';

    // Tier 1: Try R2 Internal (Rankings)
    if (runtimeEnv?.R2_ASSETS) {
        try {
            const obj = await runtimeEnv.R2_ASSETS.get(`cache/${path}`);
            if (obj) {
                const data = await obj.json();
                items = extractItems(data);
                source = `r2-rankings-${typeOrCategory}`;
            }
        } catch (e) {
            console.warn(`[CatalogFetcher] R2 Rankings miss for ${typeOrCategory}`);
        }
    }

    // Tier 2: Try CDN Rankings
    if (items.length === 0) {
        try {
            const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const size = res.headers.get('content-length');
                if (size && parseInt(size) > 5000000) { // 5MB Limit
                    console.warn(`[CatalogFetcher] Rankings ${typeOrCategory} too large for SSR (${size} bytes)`);
                } else {
                    const data = await res.json();
                    items = extractItems(data);
                    source = `cdn-rankings-${typeOrCategory}`;
                }
            }
        } catch (e) {
            console.warn(`[CatalogFetcher] CDN Rankings fail for ${typeOrCategory}: ${e.message}`);
        }
    }

    // Tier 3: Trending Fallback (filtered by type or category)
    if (items.length === 0) {
        try {
            const trendUrl = `${CDN_BASE}/trending.json`;
            const res = await fetch(trendUrl);
            if (res.ok) {
                const size = res.headers.get('content-length');
                // Strict 2MB limit for the massive trending.json fallback
                if (size && parseInt(size) > 2000000) {
                    console.warn(`[CatalogFetcher] Trending fallback skipped: too large for SSR (${size} bytes)`);
                } else {
                    const data = await res.json();
                    const allRaw = data.entities || data.models || data.items || [];

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
            description: (item.description || '').substring(0, 160).replace(/<[^>]*>?/gm, ''),
            slug: item.slug || '',
            type: item.type || 'model',
            fni_score: item.fni_score || 0,
            downloads: item.downloads || 0,
            likes: item.likes || 0,
            category: item.category || ''
        };
    }
