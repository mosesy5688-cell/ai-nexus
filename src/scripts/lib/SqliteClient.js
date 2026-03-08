/**
 * SqliteClient.js (V23.3)
 * Browser-side SQLite Engine for Catalog Listings
 * Architecture: wa-sqlite + FacadeVFS (Range Requests)
 */
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { FacadeVFS } from '@journeyapps/wa-sqlite/src/FacadeVFS.js';
import * as SQLite from '@journeyapps/wa-sqlite/src/sqlite-constants.js';

// V23.3: Use Vite ?url for reliable WASM serving across all environments
import wasmUrl from '../../assets/sqlite/wa-sqlite-async.wasm?url';

const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const L0_CACHE = new Map();
const MAX_L0_CHUNKS = 128; // ~32MB in-memory

class BrowserRangeVFS extends FacadeVFS {
    constructor(wasmModule) {
        super('browser-range', wasmModule);
        this.fileStates = new Map();
        this.handleMap = new Map();
    }

    hasAsyncMethod(methodName) {
        return ['xOpen', 'xAccess', 'xRead', 'xFileSize'].includes(methodName);
    }

    async _fetchMetadata(name) {
        let state = this.fileStates.get(name);
        if (state && state.promise) return state.promise;

        if (!state) {
            state = { size: 0, etag: '', promise: null };
            this.fileStates.set(name, state);
        }

        state.promise = (async () => {
            const url = `/api/vfs-proxy/${name}`;
            const res = await fetch(url, { method: 'HEAD' });
            if (!res.ok) throw new Error(`VFS HEAD failed for ${name}`);

            state.size = parseInt(res.headers.get('content-length') || '0', 10);
            state.etag = (res.headers.get('etag') || 'v23-dev').replace(/"/g, '').replace('W/', '');
            console.log(`[Browser VFS] [HEAD] Synchronized: ${name}, ETag=${state.etag}, Size=${state.size}`);
            return state.size;
        })();

        return state.promise;
    }

    async jOpen(name, pFile, flags, pOutFlags) {
        if (!name) return SQLite.SQLITE_CANTOPEN;
        const fileName = name.split('/').pop();
        this.handleMap.set(pFile, fileName);
        await this._fetchMetadata(fileName);
        pOutFlags.setInt32(0, flags, true);
        return SQLite.SQLITE_OK;
    }

    async jRead(pFile, pData, iOffset) {
        const fileName = this.handleMap.get(pFile);
        if (!fileName) return SQLite.SQLITE_IOERR_READ;
        const state = this.fileStates.get(fileName);
        if (!state) return SQLite.SQLITE_IOERR_READ;

        const length = pData.byteLength;
        const chunkIndex = Math.floor(iOffset / CHUNK_SIZE);
        const chunkOffset = iOffset % CHUNK_SIZE;
        const cacheKey = `${fileName}-${state.etag}-${chunkIndex}`;

        try {
            // --- L0 Cache (In-Memory) ---
            if (L0_CACHE.has(cacheKey)) {
                const chunk = L0_CACHE.get(cacheKey);
                const avail = chunk.length - chunkOffset;
                const toCopy = Math.max(0, Math.min(avail, length));
                if (toCopy < length) pData.fill(0);
                if (toCopy > 0) pData.set(chunk.subarray(chunkOffset, chunkOffset + toCopy));
                return toCopy < length ? SQLite.SQLITE_IOERR_SHORT_READ : SQLite.SQLITE_OK;
            }

            // --- Origin Fetch ---
            const start = chunkIndex * CHUNK_SIZE;
            const end = start + CHUNK_SIZE - 1;
            const url = `/api/vfs-proxy/${fileName}`;

            const res = await fetch(url, {
                headers: { 'Range': `bytes=${start}-${end}` }
            });

            if (!res.ok) {
                if (res.status === 416) {
                    pData.fill(0);
                    return SQLite.SQLITE_IOERR_SHORT_READ;
                }
                return SQLite.SQLITE_IOERR_READ;
            }

            const buffer = await res.arrayBuffer();
            const chunk = new Uint8Array(buffer);

            // Save to L0
            L0_CACHE.set(cacheKey, chunk);
            if (L0_CACHE.size > MAX_L0_CHUNKS) {
                const firstKey = L0_CACHE.keys().next().value;
                L0_CACHE.delete(firstKey);
            }

            const avail = chunk.length - chunkOffset;
            const toCopy = Math.max(0, Math.min(avail, length));
            if (toCopy < length) pData.fill(0);
            if (toCopy > 0) pData.set(chunk.subarray(chunkOffset, chunkOffset + toCopy));

            return toCopy < length ? SQLite.SQLITE_IOERR_SHORT_READ : SQLite.SQLITE_OK;
        } catch (e) {
            console.error('[Browser VFS] Read Error:', e);
            return SQLite.SQLITE_IOERR_READ;
        }
    }

    async jFileSize(pFile, pSize64) {
        const fileName = this.handleMap.get(pFile);
        const state = this.fileStates.get(fileName);
        pSize64.setBigInt64(0, BigInt(state.size), true);
        return SQLite.SQLITE_OK;
    }

    async jAccess(name, flags, pResOut) {
        const exists = name.endsWith('.db') ? 1 : 0;
        pResOut.setInt32(0, exists, true);
        return SQLite.SQLITE_OK;
    }

    jClose(pFile) {
        this.handleMap.delete(pFile);
        return SQLite.SQLITE_OK;
    }

    jWrite() { return SQLite.SQLITE_READONLY; }
    jSync() { return SQLite.SQLITE_OK; }
    jLock() { return SQLite.SQLITE_OK; }
    jUnlock() { return SQLite.SQLITE_OK; }
}

export class SqliteClient {
    constructor() {
        this.sqlite3 = null;
        this.db = null;
        this.vfs = null;
        this.initPromise = null;
    }

    async init() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            const resolvedWasm = wasmUrl || '/assets/sqlite/wa-sqlite-async.wasm';
            console.log('[SqliteClient] Initializing Engine:', resolvedWasm);
            const module = await SQLiteAsyncESMFactory({
                locateFile: (name) => {
                    if (name.endsWith('.wasm')) return resolvedWasm;
                    return name;
                }
            });
            this.sqlite3 = Factory(module);

            this.vfs = new BrowserRangeVFS(module);
            this.sqlite3.vfs_register(this.vfs, true);
        })();

        return this.initPromise;
    }

    async open(dbName) {
        await this.init();
        if (this.db) {
            try { await this.sqlite3.close(this.db); } catch (e) { }
        }
        this.db = await this.sqlite3.open_v2(dbName, SQLite.SQLITE_OPEN_READONLY, 'browser-range');
        return this.db;
    }

    async query(sql, params = []) {
        if (!this.db) throw new Error('Database not open');
        const results = [];

        for await (const stmt of this.sqlite3.statements(this.db, sql)) {
            if (params.length > 0) {
                this.sqlite3.bind_collection(stmt, params);
            }

            const columns = this.sqlite3.column_names(stmt);
            while (await this.sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
                const rowData = this.sqlite3.row(stmt);
                const obj = {};
                columns.forEach((col, i) => {
                    obj[col] = rowData[i];
                });
                results.push(obj);
            }
        }
        return results;
    }
}
