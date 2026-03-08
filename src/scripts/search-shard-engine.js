import { VfsDecoder } from '../lib/vfs-decoder.ts';

let hotResults = [];
let vfsDecoder = null;
let isHotLoaded = false;
let fallBackResults = [];
let isFallingBack = false;
let totalShards = 0;
let shardsLoaded = 0;

const CDN_BASE = 'https://cdn.free2aitools.com';
const ENTITY_TYPES = ['model', 'dataset', 'agent', 'tool', 'space', 'paper', 'prompt'];

/**
 * V22.9 Unified Command Parser
 * Extracts GitHub-style filters and numeric comparisons.
 */
export function parseQueryWithCommands(query) {
    const rawQ = query?.toLowerCase() || '';
    const tokens = rawQ.split(/\s+/);
    const filters = {};
    const searchTerms = [];

    tokens.forEach(token => {
        if (token.includes(':')) {
            const [key, val] = token.split(':');
            if (['author', 'task', 'license', 'params', 'fni', 'ctx'].includes(key)) {
                filters[key] = val;
            } else {
                searchTerms.push(token);
            }
        } else if (token) {
            searchTerms.push(token);
        }
    });

    return { query: searchTerms.join(' '), filters };
}

/**
 * Helper for numeric comparisons (e.g., ">7", "<100")
 */
export function compareNumeric(val, matchStr) {
    if (!matchStr) return true;
    const num = parseFloat(matchStr.replace(/[^\d.]/g, ''));
    if (isNaN(num)) return true;
    if (matchStr.startsWith('>=')) return val >= num;
    if (matchStr.startsWith('<=')) return val <= num;
    if (matchStr.startsWith('>')) return val > num;
    if (matchStr.startsWith('<')) return val < num;
    return val >= num; // Default to >=
}

/**
 * V22.10: Zero-Copy Binary Hot-Shard Loader
 * Fetches the core high-FNI entities via hot-shard.bin for instant search results.
 */
export async function loadHotShard() {
    if (isHotLoaded) return;

    // Priority 1: Zero-Copy Binary (hot-shard.bin)
    // Priority 1: Zero-Copy Binary (hot-shard.bin)
    // Removed cache-buster to allow Native HTTP/ETag caching and Edge caching.
    const binaryPaths = [
        `/api/vfs-proxy/hot-shard.bin`,
        `${CDN_BASE}/data/hot-shard.bin`
    ];

    for (const path of binaryPaths) {
        try {
            const res = await fetch(path);
            if (!res.ok) continue;

            const buffer = await res.arrayBuffer();
            vfsDecoder = new VfsDecoder(buffer);
            console.log(`[HotEngine] 🔥 Zero-Copy Binary Loaded: ${vfsDecoder.getCount()} entities.`);
            isHotLoaded = true;
            return;
        } catch (e) {
            console.warn(`[HotEngine] Binary load failed for ${path}:`, e.message);
        }
    }

    // Priority 2: Legacy JSON Fallback (search-core.json)
    const jsonPaths = [
        '/api/vfs-proxy/cache/search-core.json.gz',
        `${CDN_BASE}/cache/search-core.json.gz`
    ];

    for (const path of jsonPaths) {
        try {
            const res = await fetch(path);
            if (!res.ok) continue;

            let data;
            const etag = res.headers.get('etag') || 'unknown'; // V22.10.1 ETag validation

            const ds = new DecompressionStream('gzip');
            const decompressedRes = new Response(res.body.pipeThrough(ds));
            try {
                data = await decompressedRes.json();
            } catch {
                data = await (await fetch(path)).json();
            }

            const entities = data?.entities || data || [];
            hotResults = entities.map(e => ({
                id: e.slug || e.id,
                name: e.name || e.displayName,
                slug: e.slug || e.id,
                type: e.type,
                fni_score: e.fni_score || 0,
                downloads: e.downloads || 0,
                stars: e.stars || 0
            }));

            isHotLoaded = true;
            console.log(`[HotEngine] 💾 Legacy JSON Loaded: ${hotResults.length} entities.`);
            return;
        } catch (e) {
            console.warn(`[HotEngine] JSON load failed for ${path}:`, e.message);
        }
    }
}

/**
 * Optimized Search Pool: Combines Binary VFS and Legacy Shards
 */
export function searchShardPool(query, limit, filters) {
    const results = [];
    const parsed = parseQueryWithCommands(query);
    const q = parsed.query;
    const combined = { ...filters, ...parsed.filters };

    // 1. Search Binary VFS (Top 30K-50K)
    if (vfsDecoder) {
        const vfsCount = vfsDecoder.getCount();
        for (let i = 0; i < vfsCount; i++) {
            const rec = vfsDecoder.getRecord(i);

            // Filter by Type
            if (combined.entityType && combined.entityType !== 'all') {
                const typeName = ENTITY_TYPES[rec.type];
                if (typeName !== combined.entityType) continue;
            }

            // Command-based Filters (Author, Task, License)
            if (combined.author && !rec.author.toLowerCase().includes(combined.author)) continue;
            if (combined.task && !rec.task.toLowerCase().includes(combined.task)) continue;
            if (combined.license && !rec.license.toLowerCase().includes(combined.license)) continue;

            // Numeric Command Matchers (Params, FNI, Context)
            if (!compareNumeric(rec.paramsBil, combined.params)) continue;
            if (!compareNumeric(rec.fniScore, combined.fni)) continue;
            if (!compareNumeric(rec.contextLength, combined.ctx)) continue;

            // Multi-term AND match across name, slug, author
            const hay = (rec.name + ' ' + rec.slug + ' ' + rec.author).toLowerCase();
            const terms = q ? q.split(/\s+/) : [];
            if (!q || terms.every(t => hay.includes(t))) {
                results.push({
                    id: rec.slug,
                    name: rec.name,
                    slug: rec.slug,
                    author: rec.author,
                    license: rec.license,
                    task: rec.task,
                    type: ENTITY_TYPES[rec.type],
                    fni_score: rec.fniScore,
                    downloads: rec.downloads,
                    stars: rec.stars,
                    params_billions: rec.paramsBil,
                    context_length: rec.contextLength,
                    updated_secs: rec.updatedSecs,
                    is_trending: rec.isTrending
                });
            }
            if (results.length >= limit) break;
        }
    }

    // 2. Search Legacy JSON Pool (if loaded)
    if (results.length < limit) {
        const legacyPool = [...hotResults, ...fallBackResults];
        for (const e of legacyPool) {
            if (results.length >= limit) break;
            if (vfsDecoder && results.some(r => r.id === (e.slug || e.id))) continue;

            if (filters.entityType && filters.entityType !== 'all' && e.type !== filters.entityType) continue;

            if (!q || e.name?.toLowerCase().includes(q) || e.slug?.toLowerCase().includes(q)) {
                results.push(e);
            }
        }
    }

    // Sort Results
    if (filters.sort === 'likes' || filters.sort === 'stars') {
        results.sort((a, b) => (b.stars || b.likes || 0) - (a.stars || a.likes || 0));
    } else if (filters.sort === 'downloads') {
        results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else {
        results.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
    }

    return results.slice(0, limit);
}

export function getShardStatus() {
    return {
        isHotLoaded,
        isFallingBack,
        isVfsBinary: !!vfsDecoder,
        itemCount: (vfsDecoder ? vfsDecoder.getCount() : hotResults.length) + fallBackResults.length
    };
}

/**
 * Legacy Shard Loader (Optional)
 */
export async function loadFullSearchIndex(onProgress, isVfsLoaded) {
    if (isVfsLoaded() || isFallingBack) return true;
    return true;
}
