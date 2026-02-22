// src/scripts/home-search.js
// V19.2: Unified SQLite VFS Orchestrator
// V21.14: Dual-Engine Fusion Search (VFS + Shard Fallback)
// Offloads heavy indexing to R2 via sql.js-httpvfs for Zero-UI-Lag performance.

import { createDbWorker } from "sql.js-httpvfs";
import { VFS_CONFIG } from "../lib/db.js";
import {
    loadHotShard,
    loadFullSearchIndex as loadShards,
    searchShardPool,
    getShardStatus
} from "./search-shard-engine.js";

// Worker Instance (VFS SQLite)
let dbWorker = null;
let isLoaded = false;
let isLoading = false;
let itemCount = 0;

// Initialize Search Engine (Mount VFS + Hot Shard)
export async function initSearch() {
    // Stage A: Trigger Hot Shard pre-loading (Instant Engine)
    loadHotShard();

    if (isLoaded || dbWorker) return true;
    if (isLoading) return new Promise(resolve => {
        const interval = setInterval(() => {
            if (isLoaded) { clearInterval(interval); resolve(true); }
        }, 100);
    });

    isLoading = true;
    try {
        // 1. Learn current version via HEAD
        let vHash = '';
        for (let i = 0; i < 3; i++) {
            try {
                const headRes = await fetch('/api/vfs-proxy/content.db', { method: 'HEAD', cache: 'no-cache' });
                if (headRes.ok) {
                    const rawEtag = headRes.headers.get('ETag') || '';
                    vHash = rawEtag.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
                    if (vHash) break;
                }
                if (headRes.status === 429) await new Promise(r => setTimeout(r, 500 * (i + 1)));
            } catch (e) {
                console.warn(`[HomeSearch] HEAD probe failed`, e);
            }
        }

        if (!vHash) {
            vHash = 'v21.10.1-stable';
            console.warn('[HomeSearch] ETag probe failed, falling back to stable.');
        }

        const vParam = `v=${vHash}`;

        // 2. Speculative warm-up
        try {
            await fetch(`/api/vfs-proxy/content.db?${vParam}`, {
                headers: { 'Range': 'bytes=0-131071' },
                cache: 'default'
            });
        } catch (e) { }

        console.log(`[HomeSearch] Mounting SQLite VFS (${vParam})`);
        dbWorker = await createDbWorker(
            [{ from: "inline", config: { serverMode: "full", url: `/api/vfs-proxy/content.db?${vParam}`, requestChunkSize: VFS_CONFIG.requestChunkSize } }],
            VFS_CONFIG.workerUrl,
            VFS_CONFIG.wasmUrl
        );
        isLoaded = true;
        isLoading = false;

        const res = await dbWorker.db.query(`SELECT COUNT(*) as c FROM entities;`);
        itemCount = res[0].c;
        console.log(`[HomeSearch] VFS Ready. Peer count: ${itemCount}`);
        return true;
    } catch (e) {
        console.error('[HomeSearch] VFS Mount Error:', e);
        isLoading = false;
        return false;
    }
}

// V21.14: Shard-based Lazy Loading Fallback Wrapper
export async function loadFullSearchIndex(onProgress) {
    return loadShards(onProgress, () => isLoaded);
}

// Perform Search via Dual-Engine Fusion (Hot Shard -> VFS FTS5)
export async function performSearch(query, limit = 20, filters = {}) {
    const start = performance.now();
    const shards = getShardStatus();

    // TIER 1: Hot Shard / Shard Fallback Search (0ms UX)
    if (!isLoaded && shards.isHotLoaded) {
        const hits = searchShardPool(query, limit, filters);
        if (hits.length > 0 && !isLoaded) {
            console.log(`[HomeSearch] [Shard Engine] Found ${hits.length} results in ${(performance.now() - start).toFixed(1)}ms`);
            return hits;
        }
    }

    if (!dbWorker && !isLoaded) await initSearch();

    // Final Shard Fallback if VFS is dead/mounting
    if (!dbWorker) {
        return searchShardPool(query, limit, filters);
    }

    try {
        const columns = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.stars, e.downloads, e.last_modified`;
        let sql = `SELECT ${columns} FROM entities e`;
        const params = [];

        if (query && query.length >= 2) {
            const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(t => t.length > 0).map(t => `"${t}"*`).join(' AND ');
            if (safeQuery) {
                sql = `SELECT ${columns} FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ?`;
                params.push(safeQuery);
            }
        } else {
            sql += ` WHERE 1=1`;
        }

        if (filters.entityType && filters.entityType !== 'all') {
            sql += ` AND e.type = ?`;
            params.push(filters.entityType);
        }

        if (filters.min_likes > 0) {
            sql += ` AND e.stars >= ?`;
            params.push(filters.min_likes);
        }

        if (filters.sources && filters.sources.length > 0) {
            sql += ` AND (e.id LIKE ? OR e.bundle_key LIKE ?)`;
            params.push(`%${filters.sources[0]}%`, `%${filters.sources[0]}%`);
        }

        const ob = filters.sort === 'likes' ? 'e.stars DESC' : (filters.sort === 'last_updated' ? 'e.last_modified DESC' : 'e.fni_score DESC');
        sql += ` ORDER BY ${ob} LIMIT ? OFFSET ?`;
        const page = parseInt(filters.page) || 1;
        const lim = parseInt(limit);
        params.push(lim, (page - 1) * lim);

        let results = await dbWorker.db.query(sql, params);

        // Cold Start Resilience
        if (results.length === 0 && query.length >= 2) {
            await new Promise(r => setTimeout(r, 500));
            results = await dbWorker.db.query(sql, params);
        }

        const mapped = results.map(r => ({
            id: r.id, name: r.name, slug: r.slug, type: r.type, author: r.author, description: r.summary,
            fni_score: r.fni_score, likes: r.stars, downloads: r.downloads, tags: [], last_updated: r.last_modified
        }));

        console.log(`[HomeSearch] Found ${mapped.length} via VFS in ${(performance.now() - start).toFixed(1)}ms`);
        return mapped;
    } catch (e) {
        console.error('[HomeSearch] VFS Search Query Error:', e);
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
        isLoaded,
        isHotLoaded: shards.isHotLoaded,
        isFallingBack: shards.isFallingBack,
        shardsProgress: shards.shardsProgress,
        isFullSearchActive: true,
        isFullSearchLoading: shards.isFallingBack && !isLoaded,
        itemCount: isLoaded ? itemCount : shards.itemCount
    };
}
