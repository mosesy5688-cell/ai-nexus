/**
 * R5 Phase-1 — the reference consumer (/api/v1/entity/[...id].ts) is byte-identical
 * in legacy_only. Drives the REAL GET handler with the substrate mocked, asserting
 * the fence threading: pin resolved in PHASE1_READER_MODE, pin.build_id + undefined
 * indexBlobKey into the oracle, undefined blobKey into getCachedDbConnection (fixed
 * key), and the ETag kept on pin._etag (NOT build_id) so it is unchanged from today.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEtag } from '../../src/lib/etag-helper.js';

const LEGACY_PIN = {
    build_id: 'run-E', _etag: 'etag-E', partitions: { meta_shards: 96 },
    logicalToBlob: null, source: 'legacy', generation: null,
    cyclePrefix: '', manifestKey: 'data/shards_manifest.json',
};

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: { name: 'r2' } } }));

const loadManifest = vi.fn(async (..._a: any[]) => LEGACY_PIN);
const getCachedDbConnection = vi.fn(async (..._a: any[]) => ({ sqlite3: {}, db: {} }));
const executeSql = vi.fn(async (..._a: any[]) => [{ id: 'test-id', type: 'model' }]);
vi.mock('../../src/lib/sqlite-engine.js', () => ({
    loadManifest: (...a: any[]) => loadManifest(...a),
    getCachedDbConnection: (...a: any[]) => getCachedDbConnection(...a),
    executeSql: (...a: any[]) => executeSql(...a),
}));

const resolveShardsForCandidates = vi.fn(async (..._a: any[]) => ({
    orderedShards: [[0, ['test-id']]], indexLoaded: false, absenceProven: false,
}));
vi.mock('../../src/lib/entity-absence-oracle.js', () => ({
    resolveShardsForCandidates: (...a: any[]) => resolveShardsForCandidates(...a),
}));
vi.mock('../../src/lib/entity-match-resolver.js', () => ({
    resolveEntityMatch: () => ({ kind: 'FOUND', row: { id: 'test-id', type: 'model' } }),
    CANDIDATE_FETCH_LIMIT: 26,
}));
vi.mock('../../src/lib/entity-projection.js', () => ({
    projectEntity: (r: any) => ({ id: r.id, type: r.type }),
}));
vi.mock('../../src/utils/packet-loader.js', () => ({ fetchBundleReadme: vi.fn() }));

import { GET } from '../../src/pages/api/v1/entity/[...id].js';

function req(headers: Record<string, string> = {}) {
    return {
        params: { id: 'test-id' },
        url: new URL('https://x/api/v1/entity/test-id'),
        request: new Request('https://x/api/v1/entity/test-id', { headers }),
    } as any;
}

beforeEach(() => {
    loadManifest.mockClear(); getCachedDbConnection.mockClear();
    executeSql.mockClear(); resolveShardsForCandidates.mockClear();
});

describe('entity reference consumer — legacy_only threading (byte-identical)', () => {
    it('resolves the pin in PHASE1_READER_MODE (loadManifest 3rd arg = legacy_only)', async () => {
        await GET(req());
        expect(loadManifest).toHaveBeenCalledWith(expect.anything(), expect.any(Boolean), 'legacy_only');
    });

    it('threads pin.build_id + undefined indexBlobKey into resolveShardsForCandidates', async () => {
        await GET(req());
        const call = resolveShardsForCandidates.mock.calls[0] as any[];
        expect(call[3]).toBe('run-E');     // manifestBuildId === pin.build_id
        expect(call[4]).toBeUndefined();   // indexBlobKey undefined (legacy: logicalToBlob null)
    });

    it('getCachedDbConnection blobKey (4th arg) is undefined -> fixed-key path', async () => {
        await GET(req());
        expect(getCachedDbConnection).toHaveBeenCalled();
        const call = getCachedDbConnection.mock.calls[0] as any[];
        expect(call[2]).toBe('meta-00.db'); // dbName from orderedShards [[0,...]]
        expect(call[3]).toBeUndefined();    // blobKey undefined in legacy_only
    });

    it('ETag byte-identical: uses pin._etag NOT pin.build_id (304 proof)', async () => {
        const expected = buildEtag(LEGACY_PIN._etag, 'test-id', '');
        const wrong = buildEtag(LEGACY_PIN.build_id, 'test-id', '');
        expect(expected).not.toBe(wrong); // the two differ -> this discriminates
        const res = await GET(req({ 'If-None-Match': expected }));
        expect(res.status).toBe(304);
        expect(res.headers.get('ETag')).toBe(expected);
    });
});
