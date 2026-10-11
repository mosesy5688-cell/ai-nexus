/**
 * Read-path P1: canonical warm-tier id-index reader (slim v2/v3), RANGE-READ.
 *
 * Resolves any id / slug / umid form to the SINGLE meta-shard the packer wrote
 * it to, from data/id-index.bin (scripts/factory/lib/id-index-generator.js).
 *
 * ENT-503 (I-1): this reader used to pull the whole blob into isolate RAM behind
 * a 30 MB size guard. The corpus is append-only; on 2026-10-08 the file crossed
 * the guard (31,499,992 B) and was refused in every isolate, so the absence
 * oracle never loaded and unknown ids fell to the budgeted fan-out -> 503. Any
 * new fixed cap would be crossed again, so the reader no longer holds the index:
 *   - header (magic/version/counts/offsets/build_id) is read once per object
 *     version and cached per isolate (~100 B);
 *   - each candidate form is located by INTERPOLATION search over the key table
 *     (the generator writes it SORTED ascending by xxhash64, i.e. near-uniform
 *     keys), reading one small window (~3 sigma of the order-statistic spread,
 *     ~50 KB at 2.1M keys, grows only with sqrt(keyCount)) per round;
 *   - a hit reads its 8-byte record.
 * Every window read is pinned to the header's etag (id-index-range.ts), so the
 * build_id that gates absence proof describes exactly the bytes searched.
 *
 * Failure modes never throw to the caller; they return a non-'ok' status so the
 * oracle degrades to the existing fan-out (and logs which one).
 */
import { xxhash64 } from '../utils/xxhash64-core.js';
import { readIndexHead, readIndexRange, IndexVersionChanged, DEFAULT_INDEX_KEY, type IndexObject } from './id-index-range.js';

const HEADER_SIZE = 32;
const HEAD_READ_BYTES = 256; // header + a typical build_id token in ONE read
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 8; // slim: shardIdx(2) + type(1) + flags(1) + fniScore(4)
const SLIM_VERSION_MIN = 2;
const SLIM_VERSION_MAX = 3;
const BUILD_ID_VERSION = 3;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;
// Per-round window cap (entries). 16384 x 12 B = 192 KB transient per form.
export const MAX_WINDOW_ENTRIES = 16384;
// Interpolation rounds before giving up ('search_exhausted' -> degrade). With a
// 3-sigma window, round 1 brackets the key ~99.7% of the time.
const MAX_ROUNDS = 6;

export interface IdIndexHit {
    shardIdx: number;
    type: number;
    fniScore: number;
    isTrending: boolean;
}

export type IndexStatus = 'ok' | 'absent' | 'bad_header' | 'r2_error' | 'version_changed'
    | 'search_exhausted' | 'timeout' | 'not_consulted';

export interface IndexLookup {
    status: IndexStatus;
    /** Stamped build_id of the EXACT object version searched (null for v2 / non-ok). */
    buildId: string | null;
    /** form (lowercased) -> hit, or null for a definite miss. Only meaningful when ok. */
    hits: Map<string, IdIndexHit | null>;
    /** Attribution: byte size of the object version read (0 when unknown). */
    size: number;
    /** Attribution: age of the cached header used (ms; 0 = read this request). */
    headerAgeMs: number;
}

interface Header extends IndexObject {
    buildId: string | null;
    keyCount: number;
    recordCount: number;
    keyOff: number;
    recOff: number;
}

class CorruptIndex extends Error {}
class SearchExhausted extends Error {}

// Isolate-scoped: ONLY the parsed header of the last-seen object version.
let HEADER: Header | null = null;
let HEADER_AT = 0;

function parseHeader(obj: IndexObject, b: Uint8Array): Header | 'bad_header' | 'need_more' {
    if (b.byteLength < HEADER_SIZE) return 'bad_header';
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'IDIX') return 'bad_header';
    const version = dv.getUint16(4, true);
    if (version < SLIM_VERSION_MIN || version > SLIM_VERSION_MAX) return 'bad_header';
    const keyCount = dv.getUint32(8, true);
    const recordCount = dv.getUint32(12, true);
    const keyOff = dv.getUint32(16, true);
    const recOff = dv.getUint32(20, true);
    if (keyCount === 0 || recordCount === 0) return 'bad_header';
    if (keyOff < HEADER_SIZE || recOff < keyOff + keyCount * KEY_ENTRY_SIZE) return 'bad_header';
    if (obj.size && recOff + recordCount * RECORD_SIZE > obj.size) return 'bad_header';
    // B4 coherence token (v3). A corrupt/absent token -> null (absence proof off
    // downstream), NOT a parse failure.
    let buildId: string | null = null;
    if (version >= BUILD_ID_VERSION) {
        const len = dv.getUint16(24, true);
        if (len > 0 && HEADER_SIZE + len <= keyOff) {
            if (HEADER_SIZE + len > b.byteLength) return 'need_more';
            try { buildId = new TextDecoder().decode(b.subarray(HEADER_SIZE, HEADER_SIZE + len)) || null; } catch { buildId = null; }
        }
    }
    return { ...obj, buildId, keyCount, recordCount, keyOff, recOff };
}

async function loadHeader(env: any, key: string): Promise<Header | 'absent' | 'bad_header'> {
    const head = await readIndexHead(env, key, HEAD_READ_BYTES);
    if (!head) return 'absent';
    let h = parseHeader(head.obj, head.bytes);
    if (h === 'need_more') {
        // Long build_id token: re-read the full header from the SAME version.
        const len = HEADER_SIZE + (head.bytes[24] | (head.bytes[25] << 8));
        const dv = await readIndexRange(env, head.obj, 0, len);
        h = parseHeader(head.obj, new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    }
    return h === 'need_more' ? 'bad_header' : h;
}

function hashOf(form: string): bigint {
    return BigInt.asUintN(64, xxhash64(String(form).toLowerCase()) & MASK64);
}

/** Interpolation search of the sorted key table. Returns recordIdx or -1 (definite miss). */
async function findRecordIdx(env: any, h: Header, target: bigint): Promise<number> {
    let lo = 0, hi = h.keyCount - 1;
    let loH = 0n, hiH = MASK64;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (lo > hi) return -1;
        const m = hi - lo + 1;
        let wlo = lo, whi = hi;
        if (m > MAX_WINDOW_ENTRIES) {
            const span = Number(hiH - loH) || 1;
            const p = Math.min(1, Math.max(0, Number(target - loH) / span));
            const est = lo + p * (m - 1);
            const half = Math.min(MAX_WINDOW_ENTRIES >> 1, Math.ceil(3 * Math.sqrt(m * p * (1 - p))) + 32);
            wlo = Math.max(lo, Math.floor(est - half));
            whi = Math.min(hi, Math.ceil(est + half));
        }
        const n = whi - wlo + 1;
        const dv = await readIndexRange(env, h, h.keyOff + wlo * KEY_ENTRY_SIZE, n * KEY_ENTRY_SIZE);
        const at = (i: number) => dv.getBigUint64(i * KEY_ENTRY_SIZE, true);
        const first = at(0), last = at(n - 1);
        if (target < first) { if (wlo === lo) return -1; hi = wlo - 1; hiH = first; continue; }
        if (target > last) { if (whi === hi) return -1; lo = whi + 1; loH = last; continue; }
        let a = 0, b = n - 1;
        while (a <= b) {
            const mid = (a + b) >>> 1;
            const v = at(mid);
            if (v < target) a = mid + 1;
            else if (v > target) b = mid - 1;
            else return dv.getUint32(mid * KEY_ENTRY_SIZE + 8, true);
        }
        return -1; // bracketed by [first,last] but absent -> definite miss
    }
    throw new SearchExhausted('id-index search exhausted');
}

async function readRecord(env: any, h: Header, idx: number): Promise<IdIndexHit> {
    if (idx < 0 || idx >= h.recordCount) throw new CorruptIndex(`record ${idx} out of range`);
    const dv = await readIndexRange(env, h, h.recOff + idx * RECORD_SIZE, RECORD_SIZE);
    return {
        shardIdx: dv.getUint16(0, true),
        type: dv.getUint8(2),
        isTrending: dv.getUint8(3) === 1,
        fniScore: dv.getFloat32(4, true),
    };
}

/**
 * Resolve every form against ONE pinned index version. A version change during
 * the lookup re-reads the header and retries once; otherwise non-'ok'.
 */
export async function lookupForms(env: any, forms: string[], blobKey?: string): Promise<IndexLookup> {
    const key = blobKey || DEFAULT_INDEX_KEY;
    const fail = (status: IndexStatus): IndexLookup => ({ status, buildId: null, hits: new Map(), size: HEADER?.size ?? 0, headerAgeMs: 0 });
    const uniq = [...new Set(forms.filter(Boolean).map(f => String(f).toLowerCase()))];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (!HEADER || HEADER.key !== key) {
                const h = await loadHeader(env, key);
                if (h === 'absent' || h === 'bad_header') return fail(h);
                HEADER = h; HEADER_AT = Date.now();
            }
            const age = Date.now() - HEADER_AT;
            const h = HEADER;
            const hits = new Map<string, IdIndexHit | null>();
            await Promise.all(uniq.map(async f => {
                const idx = await findRecordIdx(env, h, hashOf(f));
                hits.set(f, idx < 0 ? null : await readRecord(env, h, idx));
            }));
            return { status: 'ok', buildId: h.buildId, hits, size: h.size, headerAgeMs: age };
        } catch (e: any) {
            // Only a version change invalidates the cached header (it no longer
            // describes the object); a transient read error keeps it (still valid).
            if (e instanceof IndexVersionChanged) { HEADER = null; continue; }
            const status: IndexStatus = e instanceof SearchExhausted ? 'search_exhausted'
                : e instanceof CorruptIndex ? 'bad_header' : 'r2_error';
            console.warn(`[IdIndex] lookup ${status}:`, e?.message || e);
            return fail(status);
        }
    }
    return fail('version_changed');
}

/** Header-only load (diagnostics/tests): true when a parseable index header is reachable. */
export async function loadIdIndex(env: any, blobKey?: string): Promise<boolean> {
    try {
        const h = await loadHeader(env, blobKey || DEFAULT_INDEX_KEY);
        if (h === 'absent' || h === 'bad_header') return false;
        HEADER = h; HEADER_AT = Date.now();
        return true;
    } catch { return false; }
}

/** Diagnostics: true when a parsed header is cached in this isolate (no I/O). */
export function isIndexWarm(): boolean { return HEADER !== null; }

/** build_id of the cached header (null when none cached / v2). */
export function getIndexBuildId(): string | null {
    return HEADER ? HEADER.buildId : null;
}

/** Test/diagnostic hook: reset isolate state. */
export function _resetIdIndexForTest(): void {
    HEADER = null; HEADER_AT = 0;
}
