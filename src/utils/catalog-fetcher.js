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

    // V16.9.23: Dual-Mode Path Discovery (Legacy vs V16.2 Paginated)
    const legacyPath = `rankings/${typeOrCategory}-fni-top.json`;
    const paginatedPath = `rankings/${typeOrCategory}/p1.json`;

    const pathsToTry = [paginatedPath, legacyPath];

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
    if (items.length === 0 && env?.R2_ASSETS) {
        for (const rankingPath of pathsToTry) {
            try {
                const paths = [rankingPath.endsWith('.gz') ? rankingPath : rankingPath + '.gz', rankingPath];
                for (const p of paths) {
                    const obj = await env.R2_ASSETS.get(`cache/${p}`);
                    if (obj) {
                        let data;
                        if (p.endsWith('.gz')) {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = obj.body.pipeThrough(ds);
                            const response = new Response(decompressedStream);
                            data = await response.json();
                        } else {
                            data = await obj.json();
                        }
                        items = extractItems(data);
                        if (items.length > 0) {
                            source = `r2-internal-${p}`;
                            break;
                        }
                    }
                }
                if (items.length > 0) break;
            } catch (e) {
                console.warn(`[CatalogFetcher] R2 error for ${rankingPath}: ${e.message}`);
            }
        }
    }

    // Tier 2: Try CDN Rankings
    if (items.length === 0) {
        for (const rankingPath of pathsToTry) {
            try {
                const paths = [rankingPath.endsWith('.gz') ? rankingPath : rankingPath + '.gz', rankingPath];
                for (const p of paths) {
                    const res = await fetch(`${CDN_BASE}/${p}`, { signal: AbortSignal.timeout(5000) });
                    if (res.ok) {
                        let data;
                        const isGzip = p.endsWith('.gz');
                        const isAlreadyDecompressed = res.headers.get('Content-Encoding') === 'gzip';

                        if (isGzip && !isAlreadyDecompressed) {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = res.body.pipeThrough(ds);
                            const response = new Response(decompressedStream);
                            data = await response.json();
                        } else {
                            data = await res.json();
                        }

                        items = extractItems(data);
                        if (items.length > 0) {
                            source = `cdn-rankings-${p}`;
                            break;
                        }
                    }
                }
                if (items.length > 0) break;
            } catch (e) {
                console.warn(`[CatalogFetcher] CDN fail for ${rankingPath}: ${e.message}`);
            }
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
            const paths = ['trending.json', 'trending.json.gz'];
            for (const p of paths) {
                const trendUrl = `${CDN_BASE}/${p}`;
                const res = await fetch(trendUrl, { signal: AbortSignal.timeout(5000) });
                if (res.ok) {
                    let data;
                    const isGzip = p.endsWith('.gz');
                    const isAlreadyDecompressed = res.headers.get('Content-Encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        const ds = new DecompressionStream('gzip');
                        const decompressedStream = res.body.pipeThrough(ds);
                        const response = new Response(decompressedStream);
                        data = await response.json();
                    } else {
                        data = await res.json();
                    }

                    const allRaw = extractItems(data);
                    if (isType) {
                        items = allRaw.filter(i => i.type === typeOrCategory || (typeOrCategory === 'model' && !i.type));
                    } else {
                        items = allRaw.filter(i => (i.category === typeOrCategory || i.primary_category === typeOrCategory));
                    }
                    items = items.slice(0, 50);
                    source = `trending-fallback-${p}`;
                    if (items.length > 0) break;
                }
            }
        } catch (e) {
            console.error(`[CatalogFetcher] Critical Fallback Failed:`, e.message);
        }
    }

    // SSR Optimization: Cap the total number of items to normalize to prevent Error 1102
    // V18.2.5: Aggressive reduction for SSR (24 items) to avoid OOM in Workers
    const isSSR = Boolean(runtime?.env || (typeof process !== 'undefined' && process.env.AGGREGATOR_MODE));
    const finalItems = items.slice(0, isSSR ? 24 : 100);

    const normalized = DataNormalizer.normalizeCollection(finalItems, isType ? typeOrCategory : 'model');
    console.log(`[CatalogFetcher] Resolved ${normalized.length} items (SSR Cap: ${isSSR ? 24 : 100}) for ${typeOrCategory} via ${source}`);

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
