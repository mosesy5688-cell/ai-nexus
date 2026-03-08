/**
 * SQLite WASM Engine & Connection Pool (SSR)
 * V23.10: Handle Persistence Fix & Universal Routing
 */
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
// @ts-ignore
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { R2RangeVFS } from './r2-vfs.js';

let globalSqlite3: any = null;
let globalSqliteModule: any = null;
let globalVFS: any = null;
let sqliteInitPromise: Promise<void> | null = null;
let shardManifest: any = null;

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

    sqliteInitPromise = (async () => {
        const wasmConfig: any = {};

        // V24.10: Detect CF Workers first — nodejs_compat_v2 polyfills process.versions
        // so the old `process.versions?.node` check incorrectly takes the Node.js path
        const isCloudflareWorkers = typeof caches !== 'undefined' && 'default' in caches;

        if (!isCloudflareWorkers && typeof process !== 'undefined' && process.versions?.node) {
            // Node.js (dev): read WASM from local filesystem
            const { readFileSync } = await import('fs');
            const { join } = await import('path');
            try {
                const paths = [
                    join(process.cwd(), 'node_modules', '@journeyapps', 'wa-sqlite', 'dist', 'wa-sqlite-async.wasm'),
                    join(process.cwd(), '..', 'node_modules', '@journeyapps', 'wa-sqlite', 'dist', 'wa-sqlite-async.wasm')
                ];
                for (const p of paths) {
                    try {
                        wasmConfig.wasmBinary = readFileSync(p);
                        break;
                    } catch { }
                }
            } catch (e) {
                console.warn('[SQLite] WASM local read failed');
            }
        } else {
            // V24.10c: Cloudflare Workers blocks WebAssembly.instantiate(bytes)
            // Must use instantiateStreaming(Response) which IS allowed
            const wasmUrl = 'https://cdn.free2aitools.com/wasm/wa-sqlite-async.wasm';
            wasmConfig.locateFile = (file: string) => `https://cdn.free2aitools.com/wasm/${file}`;
            wasmConfig.instantiateWasm = (imports: any, successCallback: any) => {
                WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
                    .then(result => successCallback(result.instance, result.module))
                    .catch(e => console.error('[SQLite] WASM instantiate failed:', e));
                return {};
            };
        }

        globalSqliteModule = await SQLiteAsyncESMFactory(wasmConfig);
        globalSqlite3 = Factory(globalSqliteModule);
        globalVFS = new R2RangeVFS(r2Bucket, { simulate: shouldSimulate }, globalSqliteModule);
        globalSqliteModule.vfs_register(globalVFS, true);
    })();

    return sqliteInitPromise;
}

export async function getCachedDbConnection(r2Bucket: any, shouldSimulate: boolean, dbName: string) {
    await initSqlite(r2Bucket, shouldSimulate);
    if (!shouldSimulate && r2Bucket && globalVFS) globalVFS.bucket = r2Bucket;

    if (dbCache.has(dbName)) {
        const entry = dbCache.get(dbName)!;
        entry.lastUsed = Date.now();
        return { sqlite3: globalSqlite3, module: globalSqliteModule, db: entry.db };
    }

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
        const handle = await globalSqlite3.open_v2(dbName, 1, 'r2-range');
        if (!handle) throw new Error(`Failed to open handle: ${dbName}`);
        return handle;
    });

    dbCache.set(dbName, { db, lastUsed: Date.now() });
    return { sqlite3: globalSqlite3, module: globalSqliteModule, db };
}

export async function loadManifest(r2Bucket: any, simulate: boolean) {
    if (shardManifest) return shardManifest;
    try {
        if (r2Bucket && !simulate) {
            const obj = await r2Bucket.get('data/shards_manifest.json');
            shardManifest = await obj.json();
            shardManifest._etag = (obj.httpEtag || obj.etag || 'v23').replace(/"/g, '');
        } else {
            const res = await fetch('https://cdn.free2aitools.com/data/shards_manifest.json');
            shardManifest = await res.json();
            shardManifest._etag = (res.headers.get('etag') || 'v23-dev').replace(/"/g, '');
        }
    } catch (e) {
        shardManifest = { partitions: { model: 5, paper: 14, dataset: 8, tool: 2 }, _etag: 'fallback' };
    }
    return shardManifest;
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
