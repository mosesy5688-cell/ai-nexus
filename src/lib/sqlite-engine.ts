/**
 * SQLite WASM Engine & Connection Pool (SSR)
 * V26.2: CF Workers WASM fix — use ?module import via @cloudflare/vite-plugin
 */
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
// @ts-ignore
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { R2RangeVFS } from './r2-vfs.js';
import {
    PHASE1_READER_MODE, resolvePublishedPointer, loadLegacyCyclePin,
    type CyclePin, type ReaderMode,
} from './published-pointer.js';
import { dbOpenName } from './vfs-blob-key.js';
// V26.2: ?module import handled natively by @cloudflare/vite-plugin
// This gives us a pre-compiled WebAssembly.Module at build time,
// bypassing CF Workers' runtime WASM compilation block.
// @ts-ignore
import wasmModule from '../assets/sqlite/wa-sqlite-async.wasm?module';

let globalSqlite3: any = null;
let globalSqliteModule: any = null;
let globalVFS: any = null;
let sqliteInitPromise: Promise<void> | null = null;
let shardManifest: CyclePin | null = null;
let manifestLoadedAt = 0;
const MANIFEST_TTL = 300_000;

// V23.10: Move cache to module scope to prevent handle mismatch across HMR reloads
const dbCache = new Map<string, { db: any, lastUsed: number }>();
const MAX_CACHED_DBS = 16;

// V23.1: Global Lock for Asyncify Re-entrancy Protection
let sqliteLock: Promise<void> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prevLock = sqliteLock;
    let resolveLock: () => void;
    sqliteLock = new Promise(resolve => resolveLock = resolve);
    await prevLock;
    try {
        return await fn();
    } finally {
        resolveLock!();
    }
}

async function initSqlite(r2Bucket: any, shouldSimulate: boolean) {
    if (sqliteInitPromise) return sqliteInitPromise;

    const wasmConfig: any = {};
    sqliteInitPromise = (async () => {
      try {
        // V26.1: Detect CF Workers first
        const isCloudflareWorkers = typeof caches !== 'undefined' && 'default' in caches;

        if (!isCloudflareWorkers && typeof process !== 'undefined' && process.versions?.node) {
            // Node.js (dev/build): read WASM from local filesystem
            const { readFileSync } = await import('fs');
            const { join } = await import('path');
            const paths = [
                join(process.cwd(), 'src', 'assets', 'sqlite', 'wa-sqlite-async.wasm'),
                join(process.cwd(), 'node_modules', '@journeyapps', 'wa-sqlite', 'dist', 'wa-sqlite-async.wasm'),
                join(process.cwd(), '..', 'node_modules', '@journeyapps', 'wa-sqlite', 'dist', 'wa-sqlite-async.wasm')
            ];
            for (const p of paths) {
                try {
                    wasmConfig.wasmBinary = readFileSync(p);
                    console.log('[SQLite] Loaded WASM from:', p);
                    break;
                } catch { }
            }
        } else {
            // V26.2: CF Workers — pre-compiled WebAssembly.Module
            // @cloudflare/vite-plugin handles ?module imports at build time,
            // producing a pre-compiled WebAssembly.Module. CF Workers allows
            // WebAssembly.instantiate(module, imports) but blocks compile from bytes.
            console.log('[SQLite] CF Workers: using pre-compiled WASM module');
            wasmConfig.instantiateWasm = (imports: any, successCallback: any) => {
                WebAssembly.instantiate(wasmModule, imports).then((instance: any) => {
                    successCallback(instance, wasmModule);
                });
                return {}; // Emscripten expects synchronous return
            };
        }

        globalSqliteModule = await SQLiteAsyncESMFactory(wasmConfig);
        globalSqlite3 = Factory(globalSqliteModule);
        globalVFS = new R2RangeVFS(r2Bucket, { simulate: shouldSimulate }, globalSqliteModule);
        globalSqliteModule.vfs_register(globalVFS, true);
      } catch (e: any) {
        // V26.3: Reset init promise on failure so subsequent requests can retry
        // (otherwise every page load forever would hit the same rejected cached promise).
        console.error('[SQLite Engine] WASM init failed:', e?.message || e);
        sqliteInitPromise = null;
        throw e;
      }
    })();

    return sqliteInitPromise;
}

const openingDbs = new Map<string, Promise<any>>();

export async function getCachedDbConnection(r2Bucket: any, shouldSimulate: boolean, dbName: string, blobKey?: string) {
    await initSqlite(r2Bucket, shouldSimulate);
    if (!shouldSimulate && r2Bucket && globalVFS) globalVFS.bucket = r2Bucket;

    // MF-4/MF-6: when a CyclePin pins a content-addressed blob key, dbCache + the
    // VFS open name key by that immutable sha (a cross-cycle re-open is a NEW
    // entry, never a stale-blob reuse). blobKey absent (every fixed-key consumer
    // today) -> keyed by dbName, opened against data/<dbName> — exactly today.
    const cacheKey = blobKey || dbName;
    const openName = dbOpenName(dbName, blobKey);

    if (dbCache.has(cacheKey)) {
        const entry = dbCache.get(cacheKey)!;
        entry.lastUsed = Date.now();
        return { sqlite3: globalSqlite3, module: globalSqliteModule, db: entry.db };
    }

    if (openingDbs.has(cacheKey)) {
        await openingDbs.get(cacheKey);
        const entry = dbCache.get(cacheKey);
        if (entry) { entry.lastUsed = Date.now(); return { sqlite3: globalSqlite3, module: globalSqliteModule, db: entry.db }; }
    }

    const openPromise = (async () => {
    if (dbCache.size >= MAX_CACHED_DBS) {
        let oldestName = '';
        let oldestTime = Infinity;
        for (const [name, entry] of dbCache.entries()) {
            if (name.includes('core')) continue;
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestName = name;
            }
        }
        if (oldestName) {
            const evicted = dbCache.get(oldestName)!;
            dbCache.delete(oldestName);
            await withLock(async () => {
                await globalSqlite3.close(evicted.db);
            });
        }
    }

    const db = await withLock(async () => {
        const handle = await globalSqlite3.open_v2(openName, 1, 'r2-range');
        if (!handle) throw new Error(`Failed to open handle: ${openName}`);
        return handle;
    });

    dbCache.set(cacheKey, { db, lastUsed: Date.now() });
    })();

    openingDbs.set(cacheKey, openPromise);
    try { await openPromise; } finally { openingDbs.delete(cacheKey); }
    const entry = dbCache.get(cacheKey)!;
    return { sqlite3: globalSqlite3, module: globalSqliteModule, db: entry.db };
}

/**
 * List-path only: warm L0 by reading a small rankings db whole in one R2 GET.
 * Ensures the VFS is initialised, then delegates to the scoped VFS method.
 * Returns false (caller falls back to range reads) on any miss/timeout.
 */
export async function prefetchRankingsDb(r2Bucket: any, shouldSimulate: boolean, dbName: string, fetchTimeoutMs = 4000): Promise<boolean> {
    try {
        await initSqlite(r2Bucket, shouldSimulate);
        if (!shouldSimulate && r2Bucket && globalVFS) globalVFS.bucket = r2Bucket;
        if (!globalVFS) return false;
        return await globalVFS.prefetchWholeToL0(dbName, fetchTimeoutMs);
    } catch (e: any) {
        console.warn(`[SQLite Engine] prefetchRankingsDb ${dbName} failed: ${e?.message || e}`);
        return false;
    }
}

/** Evict a cached DB connection and reset VFS state for re-fetch on retry */
export async function evictCachedDb(dbName: string) {
    const entry = dbCache.get(dbName);
    if (entry) {
        dbCache.delete(dbName);
        try { await withLock(async () => globalSqlite3.close(entry.db)); } catch {}
    }
    if (globalVFS) globalVFS.resetFileState(dbName);
}

/**
 * Resolve the served cycle pin, module-cached (MANIFEST_TTL). Returns a CyclePin
 * whose build_id/partitions/_etag are byte-identical to the pre-R5 raw manifest in
 * legacy_only (plus additive CyclePin fields the fixed-key consumers ignore).
 *
 * FENCE (D-350): `mode` defaults to PHASE1_READER_MODE ('legacy_only'), so every
 * caller — the reference consumer AND the 12 unedited fixed-key consumers — runs
 * legacy_only. In legacy_only this NEVER constructs the pointer resolver and NEVER
 * GETs data/current.json (footprint == today: one shards_manifest.json GET).
 * `pointer_capable` is reachable ONLY when a test passes it explicitly (DI) — no
 * production caller does, so it is unreachable in production.
 */
export async function loadManifest(r2Bucket: any, simulate: boolean, mode: ReaderMode = PHASE1_READER_MODE): Promise<CyclePin> {
    if (shardManifest && (Date.now() - manifestLoadedAt) < MANIFEST_TTL) return shardManifest;
    shardManifest = mode === 'legacy_only'
        ? await loadLegacyCyclePin(r2Bucket, simulate)
        : await resolvePublishedPointer(r2Bucket, simulate, mode, {
            loadLegacy: () => loadLegacyCyclePin(r2Bucket, simulate),
        });
    manifestLoadedAt = Date.now();
    return shardManifest;
}

/** Test hook: clear the module-scoped manifest cache so a fresh mode/mock resolves. */
export function _resetManifestCacheForTest(): void {
    shardManifest = null;
    manifestLoadedAt = 0;
}

export async function executeSql(sqlite3: any, db: any, sql: string, params: any[] = [], semanticScores?: Map<number, number>) {
    return await withLock(async () => {
        const rows: any[] = [];
        try {
            for await (const stmt of sqlite3.statements(db, sql)) {
                if (params && params.length > 0) {
                    const count = sqlite3.bind_parameter_count(stmt);
                    sqlite3.bind_collection(stmt, params.slice(0, count));
                }

                while (await sqlite3.step(stmt) === 100) {
                    const columns = sqlite3.column_names(stmt);
                    const rowData = sqlite3.row(stmt);
                    const obj: any = {};
                    columns.forEach((c: string, i: number) => {
                        obj[c] = rowData[i];
                    });
                    if (semanticScores && obj._rowid != null) {
                        obj._semanticScore = semanticScores.get(obj._rowid) ?? 0;
                    }
                    if (!semanticScores) {
                        obj._dbSort = obj.rank != null ? obj.rank : -(obj.fni_score || 0);
                    }
                    rows.push(obj);
                }
            }
            return rows;
        } catch (e: any) {
            console.error(`[SQLite Engine] SQL Error:`, e.message, "| SQL:", sql);
            throw e;
        }
    });
}
