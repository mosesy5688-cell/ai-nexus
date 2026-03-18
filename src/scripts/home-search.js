// src/scripts/home-search.js
// V22.10: SSR-Unified Search Orchestrator
// Tier 1: hot-shard.bin (browser memory, 0ms)
// Tier 2: /api/search (SSR, meta.db FTS5/B-Tree, ~50ms)
// Browser no longer loads WASM SQLite â€?all SQL runs server-side.

import {
    loadHotShard,
    loadFullSearchIndex as loadShards,
    searchShardPool,
    getShardStatus,
    parseQueryWithCommands
} from "./search-shard-engine.js";

// V22.10: SSR search state (replaces WASM VFS state)
let isApiReady = true; // SSR API is always ready â€?no WASM to load

export async function initSearch() {
    // V22.10: Load hot shard eagerly. No WASM SQLite to initialize.
    loadHotShard();
    return true;
}

// V21.14: Shard-based Lazy Loading Fallback Wrapper
export async function loadFullSearchIndex(onProgress) {
    return loadShards(onProgress, () => isApiReady);
}

/**
 * V22.10: Perform Search via Tier 1 â†?Tier 2 Cascade
 * Tier 1: searchShardPool() (browser memory, 0ms)
 * Tier 2: fetch /api/search (SSR, meta.db FTS5/B-Tree)
 */
export async function performSearch(query, filters = {}, limit = 20, page = 0) {
    const start = performance.now();
    const shards = getShardStatus();

    // TIER 1: Hot Shard / Binary Search (0ms)
    if (shards.isHotLoaded) {
        const hits = searchShardPool(query, limit, filters);
        if (hits.length > 0) {
            console.log(`[HomeSearch] [Tier 1] Found ${hits.length} results in ${(performance.now() - start).toFixed(1)}ms`);
            return hits;
        }
    }

    // TIER 2: SSR API Search (meta.db FTS5/B-Tree)
    try {
        const parsed = parseQueryWithCommands(query);
        const searchQuery = parsed.query || query;

        const params = new URLSearchParams({
            q: query, // Send full query (SSR parses commands server-side too)
            sort: filters.sort || 'fni',
            type: filters.entityType || 'all',
            limit: String(limit),
            page: String((page || 0) + 1)
        });

        const res = await fetch(`/api/search?${params}`, {
            signal: AbortSignal.timeout(5000) // 5s timeout per CES Art 3.4
        });

        if (!res.ok) {
            console.warn(`[HomeSearch] [Tier 2] SSR API returned ${res.status}`);
            return searchShardPool(query, limit, filters); // Fallback to Tier 1
        }

        let data = await res.json();

        // --- V22.10 Tier 3: Semantic Engine Auto-Fallback ---
        // If keyword search fails, intelligently fall back to AI semantic similarity
        if ((!data.results || data.results.length === 0) && filters.mode !== 'semantic' && query.length >= 3) {
            console.warn(`[HomeSearch] [Tier 2] 0 results for '${query}'. Initiating Tier 3 Semantic Fallback...`);

            // Signal UI to show Tier 3 status
            window.dispatchEvent(new CustomEvent('search-status-change', { detail: { tier: 'semantic' } }));

            params.set('mode', 'semantic');
            const semanticRes = await fetch(`/api/search?${params}`, { signal: AbortSignal.timeout(10000) });
            if (semanticRes.ok) {
                const semanticData = await semanticRes.json();
                if (semanticData.results && semanticData.results.length > 0) {
                    data = semanticData; // Override with semantic results
                    console.log(`[HomeSearch] [Tier 3] Found ${data.results.length} semantic matches!`);
                }
            }
        }
        const mapped = (data.results || []).map(r => ({
            id: r.id, name: r.name, slug: r.slug, type: r.type, author: r.author,
            description: r.description, fni_score: r.fni_score, likes: r.likes,
            downloads: r.downloads, last_updated: r.last_updated,
            license: r.license, pipeline_tag: r.pipeline_tag || r.task || '',
            typeLabel: (r.pipeline_tag || r.task || r.type || '').replace(/-/g, ' '),
            params_billions: r.params_billions, context_length: r.context_length,
            vram_est: r.vram_est || 0
        }));

        console.log(`[HomeSearch] [Tier 2] Found ${mapped.length} via SSR in ${(performance.now() - start).toFixed(1)}ms (server: ${data.elapsed_ms}ms)`);
        return mapped;
    } catch (e) {
        console.error('[HomeSearch] [Tier 2] SSR Search Error:', e);
        // Final fallback to Tier 1 shard data
        return searchShardPool(query, limit, filters);
    }
}

// History Utils
const HISTORY_KEY = 'f2ai_search_history';
export function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
export function saveSearchHistory(query) {
    if (!query || query.length < 2) return;
    const history = getSearchHistory().filter(h => h !== query);
    history.unshift(query);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 5)));
}
export function clearSearchHistory() { localStorage.removeItem(HISTORY_KEY); }
export function setFullSearchActive(active) { }

export function getSearchStatus() {
    const shards = getShardStatus();
    return {
        isLoaded: true, // SSR API is always available
        isHotLoaded: shards.isHotLoaded,
        isFallingBack: shards.isFallingBack,
        shardsProgress: shards.shardsProgress,
        isFullSearchActive: true,
        isFullSearchLoading: false,
        itemCount: shards.itemCount
    };
}
