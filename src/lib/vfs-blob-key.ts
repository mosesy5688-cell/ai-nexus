/**
 * R5 Phase-1 VFS blob-key derivation (CES split from r2-vfs.ts / sqlite-engine.ts).
 *
 * Pure, side-effect-free helpers shared by the SQLite connection pool
 * (getCachedDbConnection) and the R2 range VFS (R2RangeVFS). They translate a
 * SQLite "open name" into (a) the R2 object key it reads from and (b) the cache
 * identity used by dbCache / fileStates / L0 / L1.
 *
 * TWO open-name shapes, ONE rule:
 *   - LEGACY (today): a bare db name such as `meta-00.db` / `meta-knowledge.db`
 *     / `id-index.bin`. Read from the FIXED key `data/<basename>`; cache identity
 *     is the basename. This is exactly today's behavior and is what every
 *     unedited fixed-key consumer keeps hitting (blobKey absent).
 *   - PINNED (R5 pointer path, reachable only when a CyclePin supplies a blob
 *     key): the FULL content-addressed key `data/blobs/<sha>`. Used VERBATIM as
 *     both the R2 key and the cache identity — a write-once, etag-stable blob.
 *
 * CRITICAL fence (R5 design gate §2.6, MF-6): a `data/blobs/<sha>` open name must
 * NEVER be collapsed to `data/<sha>`. The blobs prefix is load-bearing (it is the
 * real object key); stripping it to a basename would 404 every pinned read. That
 * regression is exactly what these helpers + their unit tests lock out.
 */

const BLOB_PREFIX = 'data/blobs/';

function basename(path: string): string {
    return path.split(/[\\/]/).pop() || '';
}

/**
 * The SQLite/VFS open name for a db.
 *   blobKey present -> the full pinned blob key (`data/blobs/<sha>`), used verbatim.
 *   blobKey absent  -> the bare dbName (legacy fixed-key path) — today's behavior.
 */
export function dbOpenName(dbName: string, blobKey?: string): string {
    return blobKey || dbName;
}

/**
 * Map a VFS open name to its R2 object key.
 *   `data/blobs/<sha>` -> returned VERBATIM (it already IS the full key).
 *   anything else      -> `data/<basename>` (the fixed key, exactly as today).
 */
export function vfsKeyForOpen(openName: string): string {
    if (openName.startsWith(BLOB_PREFIX)) return openName;
    return `data/${basename(openName)}`;
}

/**
 * The cache identity (fileStates / L0 / L1 / dbCache key) for an open name.
 *   `data/blobs/<sha>` -> the immutable blob key (write-once => etag never
 *                         changes => a new cycle is a new key, never a stale
 *                         splice; eliminates the etag cold-cliff).
 *   anything else      -> the basename (legacy identity, as today).
 */
export function vfsStateName(openName: string): string {
    if (openName.startsWith(BLOB_PREFIX)) return openName;
    return basename(openName);
}

/** True iff the open name is a pinned content-addressed blob key. */
export function isBlobKey(openName: string): boolean {
    return openName.startsWith(BLOB_PREFIX);
}
