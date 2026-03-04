/**
 * R2 Range VFS for @journeyapps/wa-sqlite (Asyncify build)
 * V22.16: Stable Architecture + ETag Version Isolation
 */

// @ts-ignore
import { FacadeVFS } from '@journeyapps/wa-sqlite/src/FacadeVFS.js';
// @ts-ignore
import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js';
import { getChunkFromCacheAPI, putChunkToCacheAPI } from './vfs-cache-utils.js';

const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const L0_CACHE = new Map<string, Uint8Array>();
const MAX_L0_CHUNKS = 128; // ~32MB in-memory per isolate

export class R2RangeVFS extends FacadeVFS {
    private fileSize: number | null = null;
    private dbEtag: string = '';
    private sizePromise: Promise<number> | null = null;

    constructor(private bucket: any, private options: { simulate?: boolean } = {}, module?: any) {
        // Register the VFS with a unique name per file (e.g. 'r2-range')
        super('r2-range', module);
    }

    // Critical for Asyncify: explicitly declare which methods are async
    hasAsyncMethod(methodName: string): boolean {
        return ['xOpen', 'xAccess', 'xRead', 'xFileSize'].includes(methodName);
    }

    private async _fetchSize(): Promise<number> {
        if (this.sizePromise) return this.sizePromise;

        this.sizePromise = (async () => {
            if (this.bucket && !this.options.simulate) {
                // Production: Get size and ETag from R2
                const obj = await this.bucket.head('data/meta.db');
                if (!obj) throw new Error('meta.db head failed');
                this.fileSize = obj.size;
                // Clean ETag (e.g. W/"xyz" -> xyz)
                this.dbEtag = (obj.httpMetadata?.etag || obj.etag || 'v22').replace(/"/g, '').replace('W/', '');
            } else {
                // Local Simulation: Get size and ETag from CDN
                const res = await fetch('https://cdn.free2aitools.com/data/meta.db', { method: 'HEAD' });
                this.fileSize = parseInt(res.headers.get('content-length') || '0', 10);
                this.dbEtag = (res.headers.get('etag') || 'v22-dev').replace(/"/g, '').replace('W/', '');
            }
            console.log(`[R2 VFS] DB ETag: ${this.dbEtag}, Size: ${this.fileSize}`);
            return this.fileSize!;
        })();

        return this.sizePromise;
    }

    async jOpen(name: string | null, pFile: number, flags: number, pOutFlags: DataView): Promise<number> {
        if (name && !name.endsWith('meta.db')) {
            return VFS.SQLITE_CANTOPEN;
        }
        await this._fetchSize(); // Ensure size/ETag are loaded before opening
        pOutFlags.setInt32(0, flags, true);
        return VFS.SQLITE_OK;
    }

    async jRead(pFile: number, pData: Uint8Array, iOffset: number): Promise<number> {
        const length = pData.byteLength;
        const chunkIndex = Math.floor(iOffset / CHUNK_SIZE);
        const chunkOffset = iOffset % CHUNK_SIZE;

        // The core fixing: Cache key MUST include ETag for version isolation
        const cacheKey = `${this.dbEtag}-${chunkIndex}`;

        try {
            // --- L0 Cache (In-Memory, 0ms) ---
            if (L0_CACHE.has(cacheKey)) {
                pData.set(L0_CACHE.get(cacheKey)!.subarray(chunkOffset, chunkOffset + length));
                return VFS.SQLITE_OK;
            }

            // --- L1 Cache (Cloudflare Cache API, ~10ms) ---
            // The utility uses: https://vfs-cache.internal/${etag}/chunk/${chunkIndex}
            let chunk = await getChunkFromCacheAPI(chunkIndex, this.dbEtag);

            // --- L2 Origin (R2 Storage, ~50ms) ---
            if (!chunk) {
                const start = chunkIndex * CHUNK_SIZE;
                const end = start + CHUNK_SIZE - 1;

                if (this.bucket && !this.options.simulate) {
                    const obj = await this.bucket.get('data/meta.db', { range: { offset: start, length: CHUNK_SIZE } });
                    chunk = new Uint8Array(await obj.arrayBuffer());
                } else {
                    const res = await fetch('https://cdn.free2aitools.com/data/meta.db', { headers: { Range: `bytes=${start}-${end}` } });
                    chunk = new Uint8Array(await res.arrayBuffer());
                }

                // Write back to Edge Cache (1-year Immutable TTL)
                if (chunk) await putChunkToCacheAPI(chunkIndex, chunk, this.dbEtag);
            }

            if (chunk) {
                // Save to L0
                L0_CACHE.set(cacheKey, chunk);
                if (L0_CACHE.size > MAX_L0_CHUNKS) {
                    L0_CACHE.delete(L0_CACHE.keys().next().value); // Evict LRU
                }

                pData.set(chunk.subarray(chunkOffset, chunkOffset + length));
                return VFS.SQLITE_OK;
            }
            return VFS.SQLITE_IOERR_READ;
        } catch (e) {
            console.error(`[R2 VFS] jRead Error:`, e);
            return VFS.SQLITE_IOERR_READ;
        }
    }

    async jFileSize(pFile: number, pSize64: DataView): Promise<number> {
        const size = await this._fetchSize();
        pSize64.setBigInt64(0, BigInt(size), true);
        return VFS.SQLITE_OK;
    }

    async jAccess(name: string, flags: number, pResOut: DataView): Promise<number> {
        // Only pretend meta.db exists. Force "-journal" or "-wal" to not exist.
        const exists = (name && name.endsWith('meta.db')) ? 1 : 0;
        pResOut.setInt32(0, exists, true);
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
