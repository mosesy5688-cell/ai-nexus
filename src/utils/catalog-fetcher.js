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
            try {
                // A. Try Fast Path: trending.json
                const file = await r2.get('cache/trending.json');
                if (file) {
                    const data = await file.json();
                    items = parseData(data, type);
                    source = 'r2-trend';
                }
            } catch (e) {
                console.warn(`[CatalogFetcher] R2 Trending Load Error:`, e);
            }

            // B. Fallback: Scan Bucket (Self-Healing)
            if (items.length === 0) {
                console.log(`[CatalogFetcher] Trending empty for ${type}. Scanning R2 bucket path: cache/entities/${type}/`);
                try {
                    const list = await r2.list({ prefix: `cache/entities/${type}/`, limit: 40 });

                    // Filter for main JSONs (ignore .meta.json)
                    const keys = list.objects
                        .filter(o => !o.key.endsWith('.meta.json'))
                        .map(o => o.key)
                        .slice(0, 24); // Limit to one page

                    if (keys.length > 0) {
                        console.log(`[CatalogFetcher] Found ${keys.length} raw files. Fetching in parallel...`);
                        const responses = await Promise.all(keys.map(key => r2.get(key)));
                        const validResponses = responses.filter(r => r);

                        // Parse JSONs
                        const jsonPromises = validResponses.map(async (r) => {
                            try { return await r.json(); } catch (e) { return null; }
                        });

                        const results = await Promise.all(jsonPromises);
                        items = results.filter(r => r && r.id).map(normalizeItem);
                        source = 'r2-direct';
                    }
                } catch (e) {
                    console.error(`[CatalogFetcher] R2 Direct Scan Error:`, e);
                }
            }
        }

        // 2. Fallback to CDN (Public)
        if (items.length === 0) {
            try {
                console.log(`[CatalogFetcher] Fetching from CDN...`);
                const res = await fetch('https://cdn.free2aitools.com/cache/trending.json', {
                    headers: { 'User-Agent': 'Free2AI-SSR/1.0' },
                    signal: AbortSignal.timeout(8000) // 8s timeout
                });
                if (res.ok) {
                    const data = await res.json();
                    items = parseData(data, type);
                    source = 'cdn';
                } else {
                    console.error(`[CatalogFetcher] CDN Error: ${res.status}`);
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
        if (type === 'space') return item.type === 'space';
        if (type === 'tool') return item.type === 'tool';
        if (type === 'dataset') return item.type === 'dataset';
        if (type === 'paper') return item.type === 'paper';
        return false;
    }).map(normalizeItem);
}

// Ensure consistent fields
function normalizeItem(item) {
    return {
        ...item,
        name: item.name || item.id?.split('/').pop() || 'Untitled',
        description: item.description || '',
        slug: item.slug || item.id
    };
}
