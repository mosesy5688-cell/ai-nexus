import { generateUrlSlug } from './url-utils.js';

/**
 * catalog-fetcher.js
 * Centralized logic for fetching catalog data in Astro SSR (Zero-Runtime)
 * Handles R2 (internal) -> CDN (public) fallback.
 */

export async function fetchCatalogData(type, runtimeEnv) {
    let items = [];
    let error = null;
    let source = 'none';

    console.log(`[CatalogFetcher] Loading ${type}...`);

    try {
        // 1. Try env.R2_ASSETS (Cloudflare Internal)
        if (runtimeEnv?.R2_ASSETS) {
            const r2 = runtimeEnv.R2_ASSETS;

            // A. Try RANKING PATH (Most accurate for sorted lists)
            try {
                const rankingFile = await r2.get(`cache/rankings/${type}/p1.json`);
                if (rankingFile) {
                    const data = await rankingFile.json();
                    items = (data.items || data.entities || data.models || []).map(normalizeItem);
                    source = `r2-rankings-${type}`;
                }
            } catch (e) {
                console.log(`[CatalogFetcher] R2 Rankings miss for ${type}, falling back to entities.json`);
            }

            // Fallback to legacy trending.json if rankings fail
            if (items.length === 0) {
                try {
                    const trendFile = await r2.get('cache/trending.json');
                    if (trendFile) {
                        const data = await trendFile.json();
                        items = parseData(data, type);
                        source = 'r2-trend-fallback';
                    }
                } catch (ex) { /* ignore */ }
            }
        }

        // 2. Fallback to CDN (Public)
        if (items.length === 0) {
            try {
                console.log(`[CatalogFetcher] Fetching from CDN...`);
                const res = await fetch('https://cdn.free2aitools.com/cache/trending.json', {
                    headers: { 'User-Agent': 'Free2AI-SSR/1.0' },
                    signal: AbortSignal.timeout(8000)
                });
                if (res.ok) {
                    const data = await res.json();
                    items = parseData(data, type);
                    source = 'cdn';
                }
            } catch (e) {
                console.error(`[CatalogFetcher] CDN Fetch Error:`, e);
                error = e.message;
            }
        }
    } catch (e) {
        console.error(`[CatalogFetcher] Critical Error:`, e);
        error = e.message;
    }

    console.log(`[CatalogFetcher] Loaded ${items.length} ${type} from ${source}`);
    return { items, error, source };
}

// Helper: Extract valid items based on type
function parseData(data, type) {
    let all = [];

    // Normalize structure (Handle array vs object)
    if (Array.isArray(data)) {
        all = data;
    } else if (data.models || data.agents) {
        // Combined structure
        all = [
            ...(data.models || []),
            ...(data.agents || []),
            ...(data.spaces || []),
            ...(data.tools || []),
            ...(data.datasets || []),
            ...(data.papers || [])
        ];
    }

    // Filter by type
    return all.filter(item => {
        // Strict Type Check
        if (type === 'model') return item.type === 'model' || (item.id && !item.type && !item.id.startsWith('space/'));
        if (type === 'agent') return item.type === 'agent' || (item.id && item.id.includes('agent'));
        if (type === 'space') return item.type === 'space' || (item.id && item.id.startsWith('space/'));
        if (type === 'tool') return item.type === 'tool';
        if (type === 'dataset') return item.type === 'dataset' || (item.id && item.id.startsWith('dataset/'));
        if (type === 'paper') return item.type === 'paper' || (item.id && (item.id.includes('arxiv') || item.id.startsWith('paper')));
        return false;
    }).map(normalizeItem);
}


// Ensure consistent fields
export function normalizeItem(item) {
    return {
        ...item,
        name: item.name || item.id?.split('/').pop() || 'Untitled',
        description: item.description || '',
        slug: generateUrlSlug(item) || item.slug || item.id // Priority: Clean Slug
    };
}

/**
 * Truncate item for Minimal Listing Schema (SSR Optimization)
 * Keeps only fields required by EntityCardRenderer.js
 */
export function truncateListingItem(item) {
    if (!item) return null;
    return {
        id: item.id || '',
        slug: item.slug || '',
        name: item.name || '',
        description: item.description ? item.description.substring(0, 160) : '',
        type: item.type || '',
        fni_score: item.fni_score || 0,
        downloads: item.downloads || 0,
        likes: item.likes || 0,
        authors: item.authors || item.author || '', // Compatibility
        sdk: item.sdk || '' // For Spaces
    };
}
