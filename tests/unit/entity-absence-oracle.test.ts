import { describe, it, expect, beforeEach } from 'vitest';
import { resolveShardsForCandidates } from '../../src/lib/entity-absence-oracle.js';
import { _resetIdIndexForTest } from '../../src/lib/id-index-reader.js';
import { xxhash64 } from '../../src/utils/xxhash64-core.js';

// B4 — id-index absence oracle + index-driven candidate resolution.
//
// These tests drive resolveShardsForCandidates against a synthetic slim-v2
// id-index.bin (the SAME on-disk layout id-index-generator.js emits and
// id-index-reader.ts parses), wired through a mock env.R2_ASSETS so the reader's
// real load + binary-search path runs. We assert the three contract outcomes:
//   (a) index hit  -> candidate set shrinks to the resolved shard
//   (b) all-miss   -> absenceProven, ZERO shards to probe
//   (c) index absent/refused -> fan-out parity (original order, no absence claim)

const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 8;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

/** Build a valid slim-v2 IDIX buffer mapping each key form -> a shardIdx. */
function buildIndexBuffer(entries: { form: string; shardIdx: number }[]): ArrayBuffer {
    // One record per distinct shardIdx grouping is overkill; give each entry its
    // own record (matches the generator: every form points at one record).
    const records = entries.map(e => ({ shardIdx: e.shardIdx }));
    const keys = entries.map((e, i) => ({
        hash: BigInt.asUintN(64, xxhash64(e.form.toLowerCase()) & MASK64),
        recordIdx: i,
    }));
    keys.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

    const keyTableOffset = HEADER_SIZE;
    const recordTableOffset = keyTableOffset + keys.length * KEY_ENTRY_SIZE;
    const total = recordTableOffset + records.length * RECORD_SIZE;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    bytes[0] = 'I'.charCodeAt(0); bytes[1] = 'D'.charCodeAt(0);
    bytes[2] = 'I'.charCodeAt(0); bytes[3] = 'X'.charCodeAt(0);
    dv.setUint16(4, 2, true);            // version = slim v2
    dv.setUint32(8, keys.length, true);  // keyCount
    dv.setUint32(12, records.length, true); // recordCount
    dv.setUint32(16, keyTableOffset, true);
    dv.setUint32(20, recordTableOffset, true);
    for (let i = 0; i < keys.length; i++) {
        const off = keyTableOffset + i * KEY_ENTRY_SIZE;
        dv.setBigUint64(off, keys[i].hash, true);
        dv.setUint32(off + 8, keys[i].recordIdx, true);
    }
    for (let i = 0; i < records.length; i++) {
        const off = recordTableOffset + i * RECORD_SIZE;
        dv.setUint16(off, records[i].shardIdx, true);
        dv.setUint8(off + 2, 0);   // type
        dv.setUint8(off + 3, 0);   // flags
        dv.setFloat32(off + 4, 0); // fniScore
    }
    return buf;
}

/** Mock env whose R2 binding serves the given index buffer (or 404s if null).
 * NODE_ENV=production + no SIMULATE_PRODUCTION makes the reader's isSimulating
 * guard false even under vitest's import.meta.env.DEV, so it takes the R2_ASSETS
 * branch (not the CDN fetch fallback) and reads our in-memory buffer. */
function mockEnv(buf: ArrayBuffer | null): any {
    return {
        NODE_ENV: 'production',
        R2_ASSETS: {
            get: async (key: string) => {
                if (key !== 'data/id-index.bin' || !buf) return null;
                return { size: buf.byteLength, arrayBuffer: async () => buf };
            },
        },
    };
}

describe('resolveShardsForCandidates — id-index absence oracle', () => {
    beforeEach(() => _resetIdIndexForTest());

    it('(a) index hit shrinks the candidate set to the resolved shard', async () => {
        // The real entity "arxiv--2307.01952" lives on shard 7. The candidate
        // plan fanned out across many shards; only the resolved one should remain.
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }]));
        const candidates = ['2307.01952', 'arxiv--2307.01952', 'unknown--2307.01952'];
        // Pretend the caller hashed each candidate to a different shard.
        const shardForms = new Map<number, string[]>([
            [3, ['2307.01952']],
            [7, ['arxiv--2307.01952']],
            [42, ['unknown--2307.01952']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);
        // Only the resolved shard 7 is probed (10 -> 1), with its bound form.
        expect(r.orderedShards).toEqual([[7, ['arxiv--2307.01952']]]);
    });

    it('(b) all candidates miss the index -> absenceProven, ZERO shards probed', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'arxiv--2307.01952', shardIdx: 7 }]));
        // None of these exist in the index.
        const candidates = ['9999.99999', 'arxiv--9999.99999', 'unknown--9999.99999'];
        const shardForms = new Map<number, string[]>([
            [1, ['9999.99999']],
            [2, ['arxiv--9999.99999']],
            [3, ['unknown--9999.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(true);
        // Absence is proven WITHOUT probing any shard.
        expect(r.orderedShards).toEqual([]);
    });

    it('(c) index absent -> fan-out parity (original order, no absence claim)', async () => {
        const env = mockEnv(null); // R2 returns null -> loadIdIndex fails
        const candidates = ['9999.99999', 'arxiv--9999.99999'];
        const shardForms = new Map<number, string[]>([
            [1, ['9999.99999']],
            [2, ['arxiv--9999.99999']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env);
        expect(r.indexLoaded).toBe(false);
        // Never assert absence when the oracle is unavailable.
        expect(r.absenceProven).toBe(false);
        // Identical to the current behavior: the original insertion order.
        expect(r.orderedShards).toEqual([[1, ['9999.99999']], [2, ['arxiv--9999.99999']]]);
    });

    it('(c2) refused (oversized) index -> fan-out parity, no absence claim', async () => {
        // size guard refuses anything > 30 MB without reading the body.
        const env = {
            NODE_ENV: 'production',
            R2_ASSETS: {
                get: async () => ({ size: 200 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }),
            },
        };
        const candidates = ['anything', 'arxiv--anything'];
        const shardForms = new Map<number, string[]>([[5, ['anything']], [9, ['arxiv--anything']]]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env);
        expect(r.indexLoaded).toBe(false);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[5, ['anything']], [9, ['arxiv--anything']]]);
    });

    it('hit dedupes when multiple candidates resolve the same shard', async () => {
        // Two stored forms of one entity both on shard 11 -> one probe entry.
        const env = mockEnv(buildIndexBuffer([
            { form: 'meta-llama--llama-3-8b', shardIdx: 11 },
            { form: 'hf-model--meta-llama--llama-3-8b', shardIdx: 11 },
        ]));
        const candidates = ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b'];
        const shardForms = new Map<number, string[]>([
            [11, ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b']],
        ]);
        const r = await resolveShardsForCandidates(shardForms, candidates, env);
        expect(r.absenceProven).toBe(false);
        expect(r.orderedShards).toEqual([[11, ['meta-llama--llama-3-8b', 'hf-model--meta-llama--llama-3-8b']]]);
    });
});
