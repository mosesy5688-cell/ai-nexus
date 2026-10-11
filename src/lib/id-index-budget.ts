/**
 * ENT-503 / v127 f2: the range-read id-index's per-request budgets and the
 * SUPPORTED-SIZE CEILING DERIVED from them (no free-standing size cap).
 *
 * Memory context (one 128 MB CF Worker isolate; enumerated, not assumed):
 *   - r2-vfs.ts:14-16      L0 chunk cache: 128 x 256 KiB          = 32 MiB
 *   - sqlite-engine.ts:30  16 cached shard connections; SQLite default
 *                          page cache (-2000 KiB each, no PRAGMA in repo) <= 32 MiB
 *   - wa-sqlite-async.wasm module binary                          ~ 2.2 MiB
 *   => <= ~66 MiB held by the shard read path; the remainder carries the JS heap
 *      and every in-flight request. The index holds NOTHING resident beyond its
 *      parsed header (~100 B); its cost is per-request transient, bounded below.
 *
 * Derivation (all integers; see the constants):
 *   W  = MAX_WINDOW_ENTRIES (one window read, W x 12 B)
 *   F  = MAX_PLAN_FORMS (buildEntityProbePlan emits <= 12: 3 base forms + 9
 *        AUTO_PREFIXES, or 3 + <= 5 paper forms; 16 leaves headroom)
 *   H  = MAX_RESOLVED_HITS (record reads; 1-2 in practice)
 *   P  = MAX_READ_PARALLELISM (review M3: in-flight reads per lookup)
 *   Reads per lookup  <= 2 attempts x (2 header + F windows + H records).
 *   Live bytes        <= P x W x 12 B: at most P reads are in flight, and a
 *        version-change retry starts only after attempt 1's reads SETTLED
 *        (runBounded never abandons a read), so attempts never overlap.
 *   ONE window per form requires round 1 to bracket the key: a uniform key's
 *   position deviates by sigma <= sqrt(n)/2, and the window spans
 *   +-(3 sigma + 32) <= W/2  <=>  n <= ((W - 64) / 3)^2  = KEY_COUNT_CEILING.
 *   Byte ceiling = head read + n x (12 B key + 8 B record) (records <= keys).
 * Beyond the ceiling the read budget no longer covers a typical lookup, so the
 * index is REFUSED (status 'refused' -> fan-out degrade; never a 404). The root
 * fix for unbounded growth is producer-side (index compaction / sharding) —
 * backlog for a separate ruling, not implemented here.
 */

export const KEY_ENTRY_SIZE = 12;
export const RECORD_SIZE = 8;
export const HEAD_READ_BYTES = 256;

export const MAX_WINDOW_ENTRIES = 16384;
export const MAX_PLAN_FORMS = 16;
export const MAX_RESOLVED_HITS = 4;

/** Hard cap on index R2 operations per lookup (both attempts) = 44. */
export const MAX_INDEX_READS = 2 * (2 + MAX_PLAN_FORMS + MAX_RESOLVED_HITS);
export const MAX_READ_PARALLELISM = 4;
/** Per-lookup live-bytes bound = 4 x 16384 x 12 B = 786,432 B (at the ceiling). */
export const TRANSIENT_BYTES_MAX = MAX_READ_PARALLELISM * MAX_WINDOW_ENTRIES * KEY_ENTRY_SIZE;

/**
 * Run fn over items with at most `limit` in flight. Resolves only after EVERY
 * started call settled (no orphaned reads); rethrows the first failure. Stops
 * starting new calls once one failed.
 */
export async function runBounded<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed: { e: any } | null = null;
    const worker = async () => {
        while (!failed && next < items.length) {
            const x = items[next++];
            try { await fn(x); } catch (e) { if (!failed) failed = { e }; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed) throw (failed as { e: any }).e;
}
/** floor(((16384 - 64) / 3)^2) = 29,593,600 keys. */
export const KEY_COUNT_CEILING = Math.floor(((MAX_WINDOW_ENTRIES - 64) / 3) ** 2);
/** 256 + 29,593,600 x 20 = 591,872,256 B. */
export const INDEX_BYTES_CEILING = HEAD_READ_BYTES + KEY_COUNT_CEILING * (KEY_ENTRY_SIZE + RECORD_SIZE);
export const WARN_FRACTION = 0.8;

export type CeilingVerdict = 'ok' | 'warn' | 'refused';

/**
 * Judge one index object version against the derived ceiling and emit the
 * warn / refusing line (caller logs once per object version).
 */
export function judgeCeiling(sizeBytes: number, keyCount: number, key: string): CeilingVerdict {
    const byteUse = sizeBytes / INDEX_BYTES_CEILING;
    const keyUse = keyCount / KEY_COUNT_CEILING;
    if (sizeBytes > INDEX_BYTES_CEILING || keyCount > KEY_COUNT_CEILING) {
        console.warn(`[IdIndex] refusing index ${key} (size=${sizeBytes} B keys=${keyCount} > ceiling ${INDEX_BYTES_CEILING} B / ${KEY_COUNT_CEILING} keys)`);
        return 'refused';
    }
    if (byteUse >= WARN_FRACTION || keyUse >= WARN_FRACTION) {
        console.warn(`[IdIndex] approaching ceiling ${key}: size=${sizeBytes} B ceiling=${INDEX_BYTES_CEILING} B remaining=${INDEX_BYTES_CEILING - sizeBytes} B; keys=${keyCount} ceiling=${KEY_COUNT_CEILING} remaining=${KEY_COUNT_CEILING - keyCount}`);
        return 'warn';
    }
    return 'ok';
}
