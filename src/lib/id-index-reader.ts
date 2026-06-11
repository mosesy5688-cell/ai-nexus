/**
 * Read-path P1: canonical warm-tier id-index reader (slim v2).
 *
 * Loads data/id-index.bin (produced by scripts/factory/lib/id-index-generator.js)
 * into isolate RAM ONCE (R2 binding primary, CDN fallback under simulate), then
 * resolves any id / slug / umid form to the SINGLE meta-shard the packer wrote
 * it to — so the read path skips the all-shard probe (the per-op-hang failure
 * mode for unknown ids).
 *
 * ADDITIVE + zero-regression: every failure mode (file absent until next bake,
 * R2 miss, oversized blob, wrong/old format version, bad magic, decode error,
 * key miss) returns false/null so callers fall back to the EXISTING all-shard
 * probe unchanged. Never throws to the caller.
 *
 * Two hard guards protect the 128 MB CF Worker isolate:
 *   1. Size guard (MAX_INDEX_BYTES): the file is checked BEFORE its body is
 *      materialized, so the current live ~117 MB v1 blob is refused outright
 *      (no arrayBuffer alloc) -> no OOM, clean probe fallback (today's behavior).
 *   2. Version guard: only SLIM_VERSION (v2) is accepted; the bloated v1 layout
 *      is rejected even if it somehow slipped under the size cap.
 *
 * Binary layout: see id-index-generator.js header (magic "IDIX", v2, pointer-only).
 */
import { xxhash64 } from '../utils/xxhash64-core.js';

const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 8; // slim: shardIdx(2) + type(1) + flags(1) + fniScore(4)
const SLIM_VERSION = 2;
// Refuse anything larger than this so the legacy ~117 MB v1 blob never lands in
// the isolate. The slim v2 index is ~10-15 MB for ~551K entities.
const MAX_INDEX_BYTES = 30 * 1024 * 1024;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

export interface IdIndexHit {
    shardIdx: number;
    type: number;
    fniScore: number;
    isTrending: boolean;
}

// Isolate-scoped singletons. `triedLoad` makes a missing/absent/refused file a
// cheap permanent no-op (no repeated R2 GETs) for the lifetime of the isolate.
let VIEW: DataView | null = null;
let KEY_COUNT = 0;
let KEY_TABLE_OFF = 0;
let RECORD_TABLE_OFF = 0;
let triedLoad = false;
let loadPromise: Promise<boolean> | null = null;

async function fetchIndexBytes(env: any): Promise<ArrayBuffer | null> {
    const isSimulating = !!env?.SIMULATE_PRODUCTION
        || (!!import.meta.env?.DEV && env?.NODE_ENV !== 'production');
    if (env?.R2_ASSETS && !isSimulating) {
        const obj = await env.R2_ASSETS.get('data/id-index.bin');
        if (!obj) return null;
        // Size guard at the source: refuse oversized blobs WITHOUT reading the
        // body, so the legacy v1 (~117 MB) never allocates in the isolate.
        if (typeof obj.size === 'number' && obj.size > MAX_INDEX_BYTES) {
            console.warn(`[IdIndex] refusing oversized index (${obj.size} B > ${MAX_INDEX_BYTES} B)`);
            return null;
        }
        return obj.arrayBuffer();
    }
    const res = await fetch('https://cdn.free2aitools.com/data/id-index.bin');
    if (!res.ok) return null;
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_INDEX_BYTES) {
        console.warn(`[IdIndex] refusing oversized index (${lenHeader} B > ${MAX_INDEX_BYTES} B)`);
        return null;
    }
    return res.arrayBuffer();
}

function parseHeader(ab: ArrayBuffer): boolean {
    if (ab.byteLength < HEADER_SIZE) return false;
    // Defensive byte-length guard (e.g. chunked CDN response with no
    // content-length): refuse oversized after materialization too.
    if (ab.byteLength > MAX_INDEX_BYTES) return false;
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'IDIX') return false;
    // Version guard: only the slim v2 layout is parseable here. The bloated v1
    // (string-pool) layout is rejected -> caller falls back to the probe.
    const version = dv.getUint16(4, true);
    if (version !== SLIM_VERSION) return false;
    KEY_COUNT = dv.getUint32(8, true);
    const recordCount = dv.getUint32(12, true);
    KEY_TABLE_OFF = dv.getUint32(16, true);
    RECORD_TABLE_OFF = dv.getUint32(20, true);
    if (KEY_COUNT === 0 || recordCount === 0) return false;
    // Record table must fit inside the buffer.
    if (RECORD_TABLE_OFF + recordCount * RECORD_SIZE > ab.byteLength) return false;
    VIEW = dv;
    return true;
}

/**
 * Load the index into isolate memory once. Idempotent + concurrency-safe; on
 * any failure (or refusal) marks the index permanently unavailable for this
 * isolate and returns false (caller falls back). Never throws.
 */
export async function loadIdIndex(env: any): Promise<boolean> {
    if (VIEW) return true;
    if (triedLoad && !loadPromise) return false;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            const start = Date.now();
            const ab = await fetchIndexBytes(env);
            if (!ab || !parseHeader(ab)) { triedLoad = true; return false; }
            triedLoad = true;
            console.log(`[IdIndex] Loaded ${KEY_COUNT} keys in ${Date.now() - start}ms`);
            return true;
        } catch (e: any) {
            // Absent file / R2 error / decode error -> no-op fallback, no throw.
            console.warn('[IdIndex] load failed (falling back to probe):', e?.message || e);
            triedLoad = true;
            return false;
        } finally {
            loadPromise = null;
        }
    })();
    return loadPromise;
}

/**
 * Non-blocking warm peek. True ONLY when the index is already parsed and resident
 * in THIS isolate (VIEW set), so lookup() is synchronously usable at ZERO I/O
 * cost. Crucially this NEITHER starts a load NOR awaits an in-flight one: a
 * pending loadPromise (cold fetch racing) reports false, so a caller that gates
 * on warmth never pays the cold-isolate fetch+parse cost. Used by the absence
 * oracle's fan-out gate to opportunistically shrink low-fan-out lookups only when
 * the index is already free.
 */
export function isIndexWarm(): boolean {
    return VIEW !== null;
}

function readKeyHash(i: number): bigint {
    return VIEW!.getBigUint64(KEY_TABLE_OFF + i * KEY_ENTRY_SIZE, true);
}

function readRecord(recordIdx: number): IdIndexHit {
    const off = RECORD_TABLE_OFF + recordIdx * RECORD_SIZE;
    const dv = VIEW!;
    return {
        shardIdx: dv.getUint16(off + 0, true),
        type: dv.getUint8(off + 2),
        isTrending: dv.getUint8(off + 3) === 1,
        fniScore: dv.getFloat32(off + 4, true),
    };
}

/**
 * Resolve an id/slug/umid form to its record. Synchronous: assumes loadIdIndex
 * already resolved true. Returns null on miss OR when the index is unloaded
 * (so a caller that skips load() still falls back cleanly).
 */
export function lookup(idOrSlugOrUmid: string): IdIndexHit | null {
    if (!VIEW || !idOrSlugOrUmid) return null;
    const target = BigInt.asUintN(64, xxhash64(String(idOrSlugOrUmid).toLowerCase()) & MASK64);
    // Binary search the sorted key table.
    let lo = 0, hi = KEY_COUNT - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const h = readKeyHash(mid);
        if (h < target) lo = mid + 1;
        else if (h > target) hi = mid - 1;
        else {
            const recordIdx = VIEW.getUint32(KEY_TABLE_OFF + mid * KEY_ENTRY_SIZE + 8, true);
            return readRecord(recordIdx);
        }
    }
    return null;
}

/** Test/diagnostic hook: reset isolate state. */
export function _resetIdIndexForTest(): void {
    VIEW = null; KEY_COUNT = 0;
    KEY_TABLE_OFF = 0; RECORD_TABLE_OFF = 0;
    triedLoad = false; loadPromise = null;
}
