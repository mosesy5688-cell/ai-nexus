/**
 * R2 Range VFS for @journeyapps/wa-sqlite (Asyncify build)
 * V22.16: Stable Architecture + ETag Version Isolation
 */

// @ts-ignore
import { FacadeVFS } from '@journeyapps/wa-sqlite/src/FacadeVFS.js';
// @ts-ignore
import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';
import { getChunkFromCacheAPI, putChunkToCacheAPI } from './vfs-cache-utils.js';

function getBasename(path: string): string {
    return path.split(/[\\/]/).pop() || '';
}

const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const L0_CACHE = new Map<string, Uint8Array>();
const MAX_L0_CHUNKS = 128; // ~32MB in-memory per isolate

export class R2RangeVFS extends FacadeVFS {
    private fileStates = new Map<string, { size: number, etag: string, sizePromise: Promise<number> | null }>();
    private handleMap = new Map<number, string>();

    constructor(public bucket: any, private options: { simulate?: boolean } = {}, module?: any) {
        // Register the VFS with a unique name per file (e.g. 'r2-range')
        super('r2-range', module);
    }

    // Critical for Asyncify: explicitly declare which methods are async
    hasAsyncMethod(methodName: string): boolean {
        return ['xOpen', 'xAccess', 'xRead', 'xFileSize'].includes(methodName);
    }

    private async _fetchSize(name: string): Promise<{ size: number, etag: string }> {
        let state = this.fileStates.get(name);
        if (state && state.sizePromise) return state.sizePromise.then(() => state!);

        if (!state) {
            state = { size: 0, etag: '', sizePromise: null };
            this.fileStates.set(name, state);
        }

        state.sizePromise = (async () => {
            const key = `data/${name}`;
            try {
                if (this.bucket && !this.options.simulate) {
                    const obj = await this.bucket.head(key);
                    if (!obj) throw new Error(`${key} head failed`);
                    state!.size = obj.size;
                    state!.etag = (obj.httpMetadata?.etag || obj.etag || 'v23').replace(/"/g, '').replace('W/', '');
                } else {
                    const res = await fetch(`https://cdn.free2aitools.com/${key}`, { method: 'HEAD' });
                    if (!res.ok) throw new Error(`${key} CDN head failed`);
                    state!.size = parseInt(res.headers.get('content-length') || '0', 10);
                    state!.etag = (res.headers.get('etag') || 'v23-dev').replace(/"/g, '').replace('W/', '');
                }
                console.log(`[R2 VFS] [HEAD] Synchronized Metadata for ${name}: ETag=${state!.etag}, Size=${state!.size}`);
            } catch (e: any) {
                console.warn(`[R2 VFS] Warning: Failed to fetch metadata for ${name} (${e.message}). Using empty fallback.`);
                state!.size = 0;
                state!.etag = 'missing';
            }
            return state!.size;
        })();

        await state.sizePromise;
        return { size: state.size, etag: state.etag };
    }

    async jOpen(name: string | null, pFile: number, flags: number, pOutFlags: DataView): Promise<number> {
        if (!name) return VFS.SQLITE_CANTOPEN;
        const fileName = getBasename(name);
        this.handleMap.set(pFile, fileName);
        await this._fetchSize(fileName);
        pOutFlags.setInt32(0, flags, true);
        return VFS.SQLITE_OK;
    }

    async jRead(pFile: number, pData: Uint8Array, iOffset: number): Promise<number> {
        const fileName = this.handleMap.get(pFile);
        if (!fileName) return VFS.SQLITE_IOERR_READ;
        const state = this.fileStates.get(fileName);
        if (!state) return VFS.SQLITE_IOERR_READ;

        const length = pData.byteLength;
        const chunkIndex = Math.floor(iOffset / CHUNK_SIZE);
        const chunkOffset = iOffset % CHUNK_SIZE;

        const cacheKey = `${fileName}-${state.etag}-${chunkIndex}`;

        try {
            // --- L0 Cache (In-Memory, 0ms) ---
            if (L0_CACHE.has(cacheKey)) {
                const cachedChunk = L0_CACHE.get(cacheKey)!;
                const avail = cachedChunk.length - chunkOffset;
                const toCopy = Math.max(0, Math.min(avail, length));
                if (toCopy < length) pData.fill(0); // Very important: zero fill trailing memory
                if (toCopy > 0) {
                    pData.set(cachedChunk.subarray(chunkOffset, chunkOffset + toCopy));
                }
                return toCopy < length ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
            }

            // --- L1 Cache (Cloudflare Cache API, ~10ms) ---
            // The utility uses: https://vfs-cache.internal/${etag}/chunk/${chunkIndex}
            let chunk = await getChunkFromCacheAPI(chunkIndex, state.etag);

            // --- L2 Origin (R2 Storage, ~50ms) ---
            if (!chunk) {
                const start = chunkIndex * CHUNK_SIZE;
                const end = start + CHUNK_SIZE - 1;

                if (this.bucket && !this.options.simulate) {
                    const obj = await this.bucket.get(`data/${fileName}`, { range: { offset: start, length: CHUNK_SIZE } });
                    chunk = new Uint8Array(await obj.arrayBuffer());
                } else {
                    const res = await fetch(`https://cdn.free2aitools.com/data/${fileName}`, { headers: { Range: `bytes=${start}-${end}` } });
                    chunk = new Uint8Array(await res.arrayBuffer());
                }

                // Write back to Edge Cache (1-year Immutable TTL)
                if (chunk) await putChunkToCacheAPI(chunkIndex, chunk, state.etag);
            }

            if (chunk) {
                // Save to L0
                L0_CACHE.set(cacheKey, chunk);
                if (L0_CACHE.size > MAX_L0_CHUNKS) {
                    const firstKey = L0_CACHE.keys().next().value;
                    if (firstKey) L0_CACHE.delete(firstKey); // Evict LRU
                }

                const avail = chunk.length - chunkOffset;
                const toCopy = Math.max(0, Math.min(avail, length));
                if (toCopy < length) pData.fill(0); // Very important: zero fill trailing memory
                if (toCopy > 0) {
                    pData.set(chunk.subarray(chunkOffset, chunkOffset + toCopy));
                }
                return toCopy < length ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
            }
            return VFS.SQLITE_IOERR_READ;
        } catch (e) {
            console.error(`[R2 VFS] jRead Error:`, e);
            return VFS.SQLITE_IOERR_READ;
        }
    }

    async jFileSize(pFile: number, pSize64: DataView): Promise<number> {
        const fileName = this.handleMap.get(pFile);
        if (!fileName) return VFS.SQLITE_IOERR_FSTAT;
        const state = this.fileStates.get(fileName);
        if (!state) return VFS.SQLITE_IOERR_FSTAT;

        pSize64.setBigInt64(0, BigInt(state.size), true);
        return VFS.SQLITE_OK;
    }

    async jAccess(name: string, flags: number, pResOut: DataView): Promise<number> {
        // Assume exists for any .db request to the VFS
        const exists = name.endsWith('.db') ? 1 : 0;
        pResOut.setInt32(0, exists, true);
        return VFS.SQLITE_OK;
    }

    async jClose(pFile: number): Promise<number> {
        this.handleMap.delete(pFile);
        return VFS.SQLITE_OK;
    }

    // --- Read-Only Stubs ---
    jWrite() { return VFS.SQLITE_READONLY; }
    jSync() { return VFS.SQLITE_OK; }
    jLock() { return VFS.SQLITE_OK; }
    jUnlock() { return VFS.SQLITE_OK; }
    jCheckReservedLock(pFile: number, pResOut: DataView) {
        pResOut.setInt32(0, 0, true);
        return VFS.SQLITE_OK;
    }
}
