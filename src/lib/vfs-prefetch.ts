/**
 * List-path whole-DB prefetch helper (Architecture B cold fast-path).
 *
 * Reads a SMALL rankings db (<=~3MB) WHOLE in one R2 GET and seeds the L0
 * chunk cache + file metadata, so the subsequent wa-sqlite b-tree walk is
 * 100% L0 hits with zero serialized R2 round-trips. Scoped to the list path;
 * does NOT touch jRead/jOpen range behavior used by detail/search/entity API.
 */

export interface PrefetchDeps {
    bucket: any;
    simulate?: boolean;
    chunkSize: number;
    l0Cache: Map<string, Uint8Array>;
    maxL0Chunks: number;
    fileStates: Map<string, { size: number; etag: string; sizePromise: Promise<number> | null }>;
}

/**
 * Fetch the whole db in one ranged-less GET (with per-fetch timeout) and seed
 * caches. Returns true on success, false on miss/timeout so the caller falls
 * back cleanly to the existing range-read path (no regression).
 */
export async function prefetchWholeToL0(
    name: string,
    deps: PrefetchDeps,
    fetchTimeoutMs = 4000,
): Promise<boolean> {
    if (deps.simulate || !deps.bucket) return false;
    const key = `data/${name}`;
    try {
        const obj: any = await Promise.race([
            deps.bucket.get(key),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('prefetch timeout')), fetchTimeoutMs)),
        ]);
        if (!obj) return false;
        const buf = new Uint8Array(await obj.arrayBuffer());
        const size = buf.length;
        if (size === 0) return false;
        const etag = (obj.httpEtag || obj.httpMetadata?.etag || obj.etag || 'v23')
            .replace(/"/g, '').replace('W/', '');
        // Seed metadata so jOpen->_fetchSize short-circuits (no HEAD round-trip).
        deps.fileStates.set(name, { size, etag, sizePromise: Promise.resolve(size) });
        const nChunks = Math.ceil(size / deps.chunkSize);
        for (let i = 0; i < nChunks; i++) {
            const start = i * deps.chunkSize;
            const chunk = buf.subarray(start, Math.min(start + deps.chunkSize, size));
            deps.l0Cache.set(`${name}-${etag}-${i}`, chunk);
            if (deps.l0Cache.size > deps.maxL0Chunks) {
                const firstKey = deps.l0Cache.keys().next().value;
                if (firstKey) deps.l0Cache.delete(firstKey);
            }
        }
        console.log(`[R2 VFS] Prefetched whole ${name} (${size}B, ${nChunks} chunks) to L0`);
        return true;
    } catch (e: any) {
        console.warn(`[R2 VFS] prefetchWholeToL0 ${name} failed: ${e?.message || e}`);
        return false;
    }
}
