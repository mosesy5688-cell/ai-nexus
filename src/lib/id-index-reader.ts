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
import { readIndexHead, readIndexRange, IndexVersionChanged, IndexUnpinnable, DEFAULT_INDEX_KEY, type IndexObject } from './id-index-range.js';

import {
    HEAD_READ_BYTES, KEY_ENTRY_SIZE, RECORD_SIZE, MAX_WINDOW_ENTRIES, MAX_INDEX_READS,
    MAX_PLAN_FORMS, judgeCeiling, type CeilingVerdict,
} from './id-index-budget.js';
export { MAX_WINDOW_ENTRIES, MAX_INDEX_READS } from './id-index-budget.js';

const HEADER_SIZE = 32;
const SLIM_VERSION_MIN = 2;
const SLIM_VERSION_MAX = 3;
const BUILD_ID_VERSION = 3;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;
// Window size, read cap and the supported-size ceiling are DERIVED in
// id-index-budget.ts (v127 f2). Interpolation rounds before giving up ('search_exhausted' -> degrade). With a
// 3-sigma window, round 1 brackets the key ~99.7% of the time.
const MAX_ROUNDS = 6;

export interface IdIndexHit {
    shardIdx: number;
    type: number;
    fniScore: number;
    isTrending: boolean;
}

export type IndexStatus = 'ok' | 'refused' | 'absent' | 'bad_header' | 'r2_error' | 'version_changed'
    | 'no_etag' | 'search_exhausted' | 'over_budget' | 'timeout' | 'not_consulted';

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
    verdict: CeilingVerdict;
}

class CorruptIndex extends Error {}
class SearchExhausted extends Error {}
class OverBudget extends Error {}

// Per-lookup counted I/O (enforces MAX_INDEX_READS).
interface IndexIO {
    head(key: string, length: number): ReturnType<typeof readIndexHead>;
    range(obj: IndexObject, offset: number, length: number): Promise<DataView>;
}
function makeIO(env: any): IndexIO {
    let n = 0;
    const tick = () => { if (++n > MAX_INDEX_READS) throw new OverBudget(`id-index read cap ${MAX_INDEX_READS} reached`); };
    return {
        head: async (key, length) => { tick(); return readIndexHead(env, key, length); },
        range: async (obj, offset, length) => { tick(); return readIndexRange(env, obj, offset, length); },
    };
}

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
    return { ...obj, buildId, keyCount, recordCount, keyOff, recOff, verdict: 'ok' };
}

async function loadHeader(io: IndexIO, key: string, prev: Header | null): Promise<Header | 'absent' | 'bad_header'> {
    const head = await io.head(key, HEAD_READ_BYTES);
    if (!head) return 'absent';
    let h = parseHeader(head.obj, head.bytes);
    if (h === 'need_more') {
        // Long build_id token: re-read the full header from the SAME version.
        const len = HEADER_SIZE + (head.bytes[24] | (head.bytes[25] << 8));
        const dv = await io.range(head.obj, 0, len);
        h = parseHeader(head.obj, new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    }
    if (h === 'need_more' || h === 'bad_header') return 'bad_header';
    // v127 f2: judged ONCE per object version -> one warn/refusing line per version.
    h.verdict = prev && prev.key === key && prev.etag === h.etag ? prev.verdict : judgeCeiling(h.size, h.keyCount, key);
    return h;
}

function hashOf(form: string): bigint {
    return BigInt.asUintN(64, xxhash64(String(form).toLowerCase()) & MASK64);
}

/** Interpolation search of the sorted key table. Returns recordIdx or -1 (definite miss). */
async function findRecordIdx(io: IndexIO, h: Header, target: bigint): Promise<number> {
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
        const dv = await io.range(h, h.keyOff + wlo * KEY_ENTRY_SIZE, n * KEY_ENTRY_SIZE);
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

async function readRecord(io: IndexIO, h: Header, idx: number): Promise<IdIndexHit> {
    if (idx < 0 || idx >= h.recordCount) throw new CorruptIndex(`record ${idx} out of range`);
    const dv = await io.range(h, h.recOff + idx * RECORD_SIZE, RECORD_SIZE);
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
    const io = makeIO(env);
    if (uniq.length > MAX_PLAN_FORMS) return fail('over_budget');
    let reload = false;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // A refused version is re-checked each lookup (one 256 B read) so a
            // shrunk/replaced index is picked up; same etag -> no repeated log line.
            if (reload || !HEADER || HEADER.key !== key || HEADER.verdict === 'refused') {
                const h = await loadHeader(io, key, HEADER);
                if (h === 'absent' || h === 'bad_header') return fail(h);
                HEADER = h; HEADER_AT = Date.now();
            }
            const age = Date.now() - HEADER_AT;
            const h = HEADER;
            // Above the derived ceiling: no lookups (I-1 analogue) -> degrade, never 404.
            if (h.verdict === 'refused') return { ...fail('refused'), size: h.size, headerAgeMs: age };
            const hits = new Map<string, IdIndexHit | null>();
            await Promise.all(uniq.map(async f => {
                const idx = await findRecordIdx(io, h, hashOf(f));
                hits.set(f, idx < 0 ? null : await readRecord(io, h, idx));
            }));
            return { status: 'ok', buildId: h.buildId, hits, size: h.size, headerAgeMs: age };
        } catch (e: any) {
            // v127 f3: the cached header is NEVER discarded before its replacement
            // is parsed: a version change forces a re-read for THIS lookup and the
            // header is swapped only on success (loadHeader above); a transient
            // read error keeps it.
            if (e instanceof IndexVersionChanged) { reload = true; continue; }
            const status: IndexStatus = e instanceof OverBudget ? 'over_budget'
                : e instanceof SearchExhausted ? 'search_exhausted'
                : e instanceof CorruptIndex ? 'bad_header' : e instanceof IndexUnpinnable ? 'no_etag' : 'r2_error';
            console.warn(`[IdIndex] lookup ${status}:`, e?.message || e);
            return fail(status);
        }
    }
    return fail('version_changed');
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
