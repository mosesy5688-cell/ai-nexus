/**
 * Read-path P1: canonical warm-tier id-index reader.
 *
 * Loads data/id-index.bin (produced by scripts/factory/lib/id-index-generator.js)
 * into isolate RAM ONCE (R2 binding primary, CDN fallback under simulate), then
 * resolves any id / slug / umid form to the SINGLE meta-shard the packer wrote
 * it to, plus a few core card fields — so the read path skips the all-shard
 * probe (the per-op-hang failure mode for unknown ids).
 *
 * ADDITIVE + zero-regression: every failure mode (file absent until next bake,
 * R2 miss, bad magic, decode error, key miss) returns null so callers fall back
 * to the EXISTING all-shard probe unchanged. Never throws to the caller.
 *
 * Binary layout: see id-index-generator.js header (magic "IDIX", v1).
 */
import { xxhash64 } from '../utils/xxhash64-core.js';

const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 26;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

export interface IdIndexHit {
    shardIdx: number;
    type: number;
    fniScore: number;
    isTrending: boolean;
    name: string;
    summary: string;
    slug: string;
}

// Isolate-scoped singletons. `triedLoad` makes a missing/absent file a cheap
// permanent no-op (no repeated R2 GETs) for the lifetime of the isolate.
let BUFFER: Uint8Array | null = null;
let VIEW: DataView | null = null;
let KEY_COUNT = 0;
let KEY_TABLE_OFF = 0;
let RECORD_TABLE_OFF = 0;
let STR_POOL_OFF = 0;
let triedLoad = false;
let loadPromise: Promise<boolean> | null = null;
const decoder = new TextDecoder('utf-8');

async function fetchIndexBytes(env: any): Promise<ArrayBuffer | null> {
    const isSimulating = !!env?.SIMULATE_PRODUCTION
        || (!!import.meta.env?.DEV && env?.NODE_ENV !== 'production');
    if (env?.R2_ASSETS && !isSimulating) {
        const obj = await env.R2_ASSETS.get('data/id-index.bin');
        if (!obj) return null;
        return obj.arrayBuffer();
    }
    const res = await fetch('https://cdn.free2aitools.com/data/id-index.bin');
    if (!res.ok) return null;
    return res.arrayBuffer();
}

function parseHeader(ab: ArrayBuffer): boolean {
    if (ab.byteLength < HEADER_SIZE) return false;
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'IDIX') return false;
    KEY_COUNT = dv.getUint32(8, true);
    const recordCount = dv.getUint32(12, true);
    KEY_TABLE_OFF = dv.getUint32(16, true);
    RECORD_TABLE_OFF = dv.getUint32(20, true);
    STR_POOL_OFF = dv.getUint32(24, true);
    if (KEY_COUNT === 0 || recordCount === 0) return false;
    if (STR_POOL_OFF > ab.byteLength) return false;
    BUFFER = new Uint8Array(ab);
    VIEW = dv;
    return true;
}

/**
 * Load the index into isolate memory once. Idempotent + concurrency-safe; on
 * any failure marks the index permanently unavailable for this isolate and
 * returns false (caller falls back). Never throws.
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

function readKeyHash(i: number): bigint {
    return VIEW!.getBigUint64(KEY_TABLE_OFF + i * KEY_ENTRY_SIZE, true);
}

function decodeStr(off: number, len: number): string {
    if (len === 0) return '';
    return decoder.decode(BUFFER!.subarray(STR_POOL_OFF + off, STR_POOL_OFF + off + len));
}

function readRecord(recordIdx: number): IdIndexHit {
    const off = RECORD_TABLE_OFF + recordIdx * RECORD_SIZE;
    const dv = VIEW!;
    const nameOff = dv.getUint32(off + 8, true);
    const nameLen = dv.getUint16(off + 12, true);
    const sumOff = dv.getUint32(off + 14, true);
    const sumLen = dv.getUint16(off + 18, true);
    const slugOff = dv.getUint32(off + 20, true);
    const slugLen = dv.getUint16(off + 24, true);
    return {
        shardIdx: dv.getUint16(off + 0, true),
        type: dv.getUint8(off + 2),
        isTrending: dv.getUint8(off + 3) === 1,
        fniScore: dv.getFloat32(off + 4, true),
        name: decodeStr(nameOff, nameLen),
        summary: decodeStr(sumOff, sumLen),
        slug: decodeStr(slugOff, slugLen),
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
    BUFFER = null; VIEW = null; KEY_COUNT = 0;
    KEY_TABLE_OFF = 0; RECORD_TABLE_OFF = 0; STR_POOL_OFF = 0;
    triedLoad = false; loadPromise = null;
}
