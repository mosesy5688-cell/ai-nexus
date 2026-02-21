// src/scripts/home-search.js
// V19.2: Unified SQLite VFS Orchestrator
// Offloads heavy indexing to R2 via sql.js-httpvfs for Zero-UI-Lag performance.

import { createDbWorker } from "sql.js-httpvfs";
import { VFS_CONFIG } from "../lib/db.js";

// Worker Instance (VFS SQLite)
let dbWorker = null;
let isLoaded = false;
let isLoading = false;
let itemCount = 0;

// Initialize Search Engine (Mount VFS)
export async function initSearch() {
    if (isLoaded || dbWorker) return true;
    if (isLoading) return new Promise(resolve => {
        const interval = setInterval(() => {
            if (isLoaded) { clearInterval(interval); resolve(true); }
        }, 100);
    });

    isLoading = true;
    try {
        console.log('[HomeSearch] Mounting SQLite VFS to /api/vfs-proxy/content.db');
        dbWorker = await createDbWorker(
            [
                {
                    from: "inline",
                    config: {
                        serverMode: "full",
                        url: "/api/vfs-proxy/content.db",
                        requestChunkSize: VFS_CONFIG.requestChunkSize
                    }
                }
            ],
            VFS_CONFIG.workerUrl,
            VFS_CONFIG.wasmUrl
        );
        isLoaded = true;
        isLoading = false;

        // Verify database integrity via lightweight probe
        const res = await dbWorker.db.query(`SELECT COUNT(*) as c FROM entities;`);
        itemCount = res[0].c;
        console.log(`[HomeSearch] VFS Ready. Peer count: ${itemCount}`);
        return true;
    } catch (e) {
        console.error('[HomeSearch] VFS Mount Error:', e);
        if (e.message?.includes('429') || e.toString().includes('429')) {
            console.warn('[HomeSearch] Rate limit detected. Search may be degraded.');
        }
        isLoading = false;
        return false;
    }
}

// Full Search active state (Simulated for VFS, everything is full index)
let isFullSearchActive = true;

export async function loadFullSearchIndex(onProgress) {
    if (onProgress) onProgress({ progress: 100 });
    return true; // VFS is 0-wait full search intrinsically
}

// Perform Search via VFS FTS5
export async function performSearch(query, limit = 20, filters = {}) {
    if (!dbWorker) await initSearch();
    if (!dbWorker) return [];

    const start = performance.now();
    try {
        const columns = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.stars, e.downloads, e.last_modified`;
        let sql = `SELECT ${columns} FROM entities e`;
        const params = [];

        // 1. Full Text Search
        if (query && query.length >= 2) {
            // FTS5 MATCH escaping
            const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(t => t.length > 0).map(t => `"${t}"*`).join(' AND ');
            if (safeQuery) {
                sql = `SELECT ${columns} FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ?`;
                params.push(safeQuery);
            }
        } else {
            sql += ` WHERE 1=1`;
        }

        // 2. Filters
        if (filters.entityType && filters.entityType !== 'all') {
            sql += ` AND e.type = ?`;
            params.push(filters.entityType);
        }

        if (filters.min_likes > 0) {
            sql += ` AND e.stars >= ?`;
            params.push(filters.min_likes);
        }

        if (filters.sources && filters.sources.length > 0) {
            const placeholders = filters.sources.map(() => '?').join(',');
            // Mapping source filter to bundle_key or slug prefix if necessary, simplified here
            sql += ` AND (e.id LIKE ? OR e.bundle_key LIKE ?)`;
            // simplistic source match
            params.push(`%${filters.sources[0]}%`, `%${filters.sources[0]}%`);
        }

        // 3. Sorting
        let ob = 'e.fni_score DESC';
        if (filters.sort === 'likes') ob = 'e.stars DESC';
        if (filters.sort === 'last_updated') ob = 'e.last_modified DESC';
        sql += ` ORDER BY ${ob} LIMIT ? OFFSET ?`;

        const page = parseInt(filters.page) || 1;
        const lim = parseInt(limit);
        params.push(lim, (page - 1) * lim);

        const results = await dbWorker.db.query(sql, params);

        // Map SQLite output names to Frontend expected names
        const mapped = results.map(r => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            type: r.type,
            author: r.author,
            description: r.summary,
            fni_score: r.fni_score,
            likes: r.stars,
            downloads: r.downloads,
            tags: [], // SQLite metadata-only schema lacks array fields natively
            last_updated: r.last_modified
        }));

        const duration = performance.now() - start;
        console.log(`[HomeSearch] Found ${mapped.length} results in ${duration.toFixed(1)}ms via VFS`);

        return mapped;
    } catch (e) {
        console.error('[HomeSearch] VFS Search Query Error:', e);
        return [];
    }
}

// History Utils (Main Thread Storage)
const HISTORY_KEY = 'f2ai_search_history';
const MAX_HISTORY = 5;

export function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

export function saveSearchHistory(query) {
    if (!query || query.length < 2) return;
    const history = getSearchHistory().filter(h => h !== query);
    history.unshift(query);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

export function clearSearchHistory() {
    localStorage.removeItem(HISTORY_KEY);
}

export function setFullSearchActive(active) {
    isFullSearchActive = true; // Always true in V19 VFS
}

export function getSearchStatus() {
    return {
        isLoaded,
        isFullSearchActive: true,
        isFullSearchLoading: false,
        itemCount
    };
}
