/**
 * R5 Phase-1 — VFS blob-key derivation, id-index pinned-key plumbing, and the B4
 * coherence gate (NOT weakened). Real modules + the shared IDIX fixture; no module
 * mocks, so the B4 oracle here is the production code path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dbOpenName, vfsKeyForOpen, vfsStateName, isBlobKey } from '../../src/lib/vfs-blob-key.js';
import { loadIdIndex, _resetIdIndexForTest } from '../../src/lib/id-index-reader.js';
import { resolveShardsForCandidates } from '../../src/lib/entity-absence-oracle.js';
import { buildIndexBuffer, mockEnv } from './helpers/id-index-fixture.js';

// The fixed-key getCachedDbConnection consumers (design gate §2.7) with the dbName
// each passes. blobKey ABSENT must map EVERY one to the fixed key data/<dbName>
// (today), never a blob key — this is what keeps the 12 unedited consumers inert.
const FIXED_KEY_CONSUMERS: [string, string][] = [
    ['search.ts:50', 'meta-03.db'],
    ['search.ts:54', 'meta-07.db'],
    ['badge/[umid].ts:93', 'meta-12.db'],
    ['compare.ts:84', 'meta-40.db'],
    ['concepts.ts:73 (ANCHOR_DB)', 'meta-knowledge.db'],
    ['entity/[...id].ts:140', 'meta-00.db'],
    ['select.ts:58', 'meta-55.db'],
    ['knowledge.astro:26', 'meta-knowledge.db'],
    ['ranking/index.astro:53', 'meta-00.db'],
    ['trends.astro:13', 'meta-report.db'],
    ['catalog-fetcher.js:90', 'rankings-model.db'],
    ['catalog-fetcher.js:128', 'meta-22.db'],
    ['vfs-metadata-provider.ts:164', 'meta-31.db'],
    ['vfs-site-metadata.ts:19', 'meta-00.db'],
];

describe('vfs-blob-key: blobKey ABSENT -> every consumer stays fixed-key (data/<dbName>)', () => {
    it.each(FIXED_KEY_CONSUMERS)('%s (%s) -> data/<dbName>', (_label, dbName) => {
        const openName = dbOpenName(dbName, undefined);
        expect(openName).toBe(dbName);
        expect(vfsKeyForOpen(openName)).toBe(`data/${dbName}`);
        expect(vfsStateName(openName)).toBe(dbName);
        expect(isBlobKey(openName)).toBe(false);
    });
});

describe('vfs-blob-key: a pinned blob key is used VERBATIM (never data/<sha>)', () => {
    const SHA = '0123abcd';
    const BLOB = `data/blobs/${SHA}`;

    it('dbOpenName threads the blob key; R2 key + cache identity stay data/blobs/<sha>', () => {
        const openName = dbOpenName('meta-00.db', BLOB);
        expect(openName).toBe(BLOB);
        expect(vfsKeyForOpen(openName)).toBe(BLOB);   // VERBATIM key
        expect(vfsStateName(openName)).toBe(BLOB);    // cache identity = immutable blob key
        expect(isBlobKey(openName)).toBe(true);
    });

    it('RED-then-restore: the blob key must NOT collapse to data/<sha>', () => {
        // The regression the fence guards: stripping the blobs/ prefix to a
        // basename would rewrite the key to data/<sha> and 404 every pinned read.
        const buggy = `data/${BLOB.split('/').pop()}`;   // simulate the bug -> data/0123abcd
        expect(buggy).toBe(`data/${SHA}`);               // (this IS the regression value)
        expect(vfsKeyForOpen(BLOB)).not.toBe(buggy);     // RED: we never produce it
        expect(vfsKeyForOpen(BLOB)).toBe(BLOB);          // GREEN: verbatim
    });
});

function idxEnv(servedKey: string, buf: ArrayBuffer) {
    const keys: string[] = [];
    const env = {
        NODE_ENV: 'production',
        R2_ASSETS: { get: async (k: string) => { keys.push(k); return k === servedKey ? { size: buf.byteLength, arrayBuffer: async () => buf } : null; } },
    };
    return { env, keys };
}

describe('id-index-reader: pinned cycle blob key vs the fixed data/id-index.bin', () => {
    beforeEach(() => _resetIdIndexForTest());

    it('blobKey ABSENT -> GETs the fixed data/id-index.bin (today)', async () => {
        const { env, keys } = idxEnv('data/id-index.bin', buildIndexBuffer([{ form: 'a', shardIdx: 1 }], 'run-x'));
        expect(await loadIdIndex(env)).toBe(true);
        expect(keys).toEqual(['data/id-index.bin']);
    });

    it('blobKey PRESENT -> GETs the pinned blob key, never data/id-index.bin', async () => {
        const { env, keys } = idxEnv('data/blobs/idxsha', buildIndexBuffer([{ form: 'a', shardIdx: 1 }], 'run-x'));
        expect(await loadIdIndex(env, 'data/blobs/idxsha')).toBe(true);
        expect(keys).toEqual(['data/blobs/idxsha']);
        expect(keys).not.toContain('data/id-index.bin');
    });
});

const IDX_BID = 'run-3000-aaa';
const NEW_BID = 'run-3001-bbb';
function missPlan() {
    const candidates = ['9999.1', 'arxiv--9999.1', 'unknown--9999.1'];
    const shardForms = new Map<number, string[]>([
        [1, ['9999.1']], [2, ['arxiv--9999.1']], [3, ['unknown--9999.1']],
    ]);
    return { candidates, shardForms };
}

describe('B4 coherence gate NOT weakened + RED-then-restore', () => {
    beforeEach(() => _resetIdIndexForTest());

    it('coherent (index build_id === manifest build_id) -> absence PROVEN', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'present', shardIdx: 7 }], IDX_BID));
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, IDX_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(true);
    });

    it('incoherent (stale index vs newer manifest) -> absence NOT proven, full fan-out kept', async () => {
        const env = mockEnv(buildIndexBuffer([{ form: 'present', shardIdx: 7 }], IDX_BID));
        const { candidates, shardForms } = missPlan();
        const r = await resolveShardsForCandidates(shardForms, candidates, env, NEW_BID);
        expect(r.indexLoaded).toBe(true);
        expect(r.absenceProven).toBe(false);     // gate holds: no false 404
        expect(r.orderedShards.length).toBe(3);  // nothing dropped
    });

    it('RED-then-restore: the coherence gate is the sole suppressor of false absence', async () => {
        const { candidates, shardForms } = missPlan();
        // MUTATE: forge the served manifest build_id to MATCH the stale index ->
        // absence fires. Proves absence is gated ONLY by the build_id compare.
        _resetIdIndexForTest();
        const envA = mockEnv(buildIndexBuffer([{ form: 'present', shardIdx: 7 }], IDX_BID));
        const mutated = await resolveShardsForCandidates(shardForms, candidates, envA, IDX_BID);
        expect(mutated.absenceProven).toBe(true);   // RED under forged coherence

        // RESTORE: the real (mismatched) served build_id -> absence suppressed.
        _resetIdIndexForTest();
        const envB = mockEnv(buildIndexBuffer([{ form: 'present', shardIdx: 7 }], IDX_BID));
        const restored = await resolveShardsForCandidates(shardForms, candidates, envB, NEW_BID);
        expect(restored.absenceProven).toBe(false); // GREEN: gate protects
    });
});
