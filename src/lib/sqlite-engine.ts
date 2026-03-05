/**
 * SQLite WASM Engine & Connection Pool (SSR)
 * V23.1: Centralized LRU Cache & Federated Query Execution
 */
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
// @ts-ignore
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { R2RangeVFS } from './r2-vfs.js';

let globalSqlite3: any = null;
let globalSqliteModule: any = null;
let globalVFS: any = null;
let sqliteInitPromise: Promise<void> | null = null;
let globalVfsName: string = '';
let shardManifest: any = null;

const MAX_CACHED_DBS = 4;
if (!(globalThis as any).dbCache) {
    (globalThis as any).dbCache = new Map<string, { db: any, lastUsed: number }>();
}

export async function getCachedDbConnection(r2Bucket: any, shouldSimulate: boolean, dbName: string) {
    if (!sqliteInitPromise) {
        sqliteInitPromise = (async () => {
            let wasmConfig: any = {};
            if (typeof process !== 'undefined' && process.versions?.node) {
                const { readFileSync } = await import('fs');
                const { resolve, dirname } = await import('path');
                const { fileURLToPath } = await import('url');
                const wasmPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm');
                try {
                    wasmConfig.wasmBinary = readFileSync(wasmPath);
                } catch (e) {
                    console.warn('[SQLite] WASM local read failed, falling back to default locateFile');
                }
            }

            globalSqliteModule = await SQLiteAsyncESMFactory(wasmConfig);
            globalSqlite3 = Factory(globalSqliteModule);

            globalVfsName = `r2-range-${Date.now()}`;
            globalVFS = new R2RangeVFS(r2Bucket, { simulate: shouldSimulate }, globalSqliteModule);
            // @ts-ignore
            globalVFS.name = globalVfsName;
            globalSqlite3.vfs_register(globalVFS, true);
        })();
    }

    await sqliteInitPromise;
    if (!shouldSimulate && r2Bucket && globalVFS) globalVFS.bucket = r2Bucket;

    const cache = (globalThis as any).dbCache as Map<string, { db: any, lastUsed: number }>;

    if (cache.has(dbName)) {
        const entry = cache.get(dbName)!;
        entry.lastUsed = Date.now();
        return { sqlite3: globalSqlite3, module: globalSqliteModule, db: entry.db };
    }

    if (cache.size >= MAX_CACHED_DBS) {
        let oldestName = '';
        let oldestTime = Infinity;
        for (const [name, entry] of cache.entries()) {
            if (name === 'meta-model-core.db' || name === 'meta-ecosystem.db') continue;
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestName = name;
            }
        }
        if (oldestName) {
            const evicted = cache.get(oldestName)!;
            await globalSqlite3.close(evicted.db);
            cache.delete(oldestName);
        }
    }

    const db = await globalSqlite3.open_v2(dbName, 1, globalVfsName);
    cache.set(dbName, { db, lastUsed: Date.now() });

    return { sqlite3: globalSqlite3, module: globalSqliteModule, db };
}

export async function loadManifest(r2Bucket: any, simulate: boolean) {
    if (shardManifest) return shardManifest;
    try {
        if (r2Bucket && !simulate) {
            const obj = await r2Bucket.get('data/shards_manifest.json');
            shardManifest = await obj.json();
        } else {
            const res = await fetch('https://cdn.free2aitools.com/data/shards_manifest.json');
            shardManifest = await res.json();
        }
    } catch (e) {
        shardManifest = { partitions: { model: 5, paper: 4 } };
    }
    return shardManifest;
}

export async function executeSql(sqlite3: any, db: any, sql: string, params: any[], semanticScores?: Map<number, number>) {
    const rows: any[] = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length > 0) sqlite3.bind_collection(stmt, params);
        let columns: string[] | null = null;
        while (await sqlite3.step(stmt) === 100) {
            columns = columns ?? sqlite3.column_names(stmt);
            const row = sqlite3.row(stmt);
            const obj: any = {};
            columns!.forEach((c, idx) => obj[c] = row[idx]);

            rows.push({
                id: obj.id, name: obj.name, slug: obj.slug, type: obj.type,
                author: obj.author, description: obj.summary, fni_score: obj.fni_score,
                likes: obj.stars, downloads: obj.downloads, last_updated: obj.last_modified,
                license: obj.license, task: obj.pipeline_tag,
                params_billions: obj.params_billions, context_length: obj.context_length,
                _semanticScore: semanticScores ? semanticScores.get(obj._rowid || obj.id) || 0 : (obj.rank || 0),
                _dbSort: obj.rank !== undefined ? obj.rank : -(obj.fni_score || 0)
            });
        }
    }
    return rows;
}
