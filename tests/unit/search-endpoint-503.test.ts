import { describe, it, expect, vi, beforeEach } from 'vitest';

// B8 — /api/search endpoint envelope. Proves the route wraps every async tier in
// the budget/per-op firewall and, on exhaustion, returns an HONEST retryable 503
// (no-store + Retry-After + machine-readable reason) NEVER riding to a dead
// connection and NEVER masquerading a transient as a clean empty search result
// (Founder: a transient must never masquerade as an empty result). A normal warm
// search still returns its
// unchanged envelope. We mock every R2/VFS/fallback dependency so no real I/O runs.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null, AI: { run: vi.fn() } } }));

const fetchAllTermPostings = vi.fn();
const mergePostings = vi.fn();
vi.mock('../../src/lib/term-index-engine.js', () => ({
    fetchAllTermPostings: (...a: any[]) => fetchAllTermPostings(...a),
    mergePostings: (...a: any[]) => mergePostings(...a),
    // groupByShard is used by search-shard-ops; give it the real grouping.
    groupByShard: (cands: { umid: string; shard: number }[]) => {
        const g = new Map<number, string[]>();
        for (const c of cands) { if (!g.has(c.shard)) g.set(c.shard, []); g.get(c.shard)!.push(c.umid); }
        return g;
    },
}));

const getCachedDbConnection = vi.fn();
const executeSql = vi.fn();
vi.mock('../../src/lib/sqlite-engine.js', () => ({
    getCachedDbConnection: (...a: any[]) => getCachedDbConnection(...a),
    executeSql: (...a: any[]) => executeSql(...a),
    evictCachedDb: vi.fn(async () => {}),
    loadManifest: vi.fn(async () => ({ _etag: 'etag-1', partitions: { meta_shards: 64 } })),
}));

const clusterFallbackSearch = vi.fn();
vi.mock('../../src/lib/cluster-fallback.js', () => ({
    clusterFallbackSearch: (...a: any[]) => clusterFallbackSearch(...a),
}));
vi.mock('../../src/lib/cluster-rerank.js', () => ({ applyClusterSemanticRerank: vi.fn(async () => {}) }));
vi.mock('../../src/utils/search-query-builder.js', () => ({
    parseCommands: () => ({}),
    buildQuery: () => ({ sql: 'SELECT 1', params: [] }),
    determineTargetDbs: () => ({ priority: ['p0'], expansion: [] }),
}));

import { GET } from '../../src/pages/api/search.js';
import { SEARCH_BUDGET_MS } from '../../src/lib/search-budget.js';

function req(qs: string) {
    const url = new URL(`https://free2aitools.com/api/search?${qs}`);
    return { url } as any;
}

beforeEach(() => {
    fetchAllTermPostings.mockReset();
    mergePostings.mockReset();
    getCachedDbConnection.mockReset();
    executeSql.mockReset();
    clusterFallbackSearch.mockReset();
});

describe('GET /api/search — keyword warm path (no regression)', () => {
    it('term hits + warm hydration -> 200 with unchanged envelope', async () => {
        fetchAllTermPostings.mockResolvedValue({ terms: ['x'], results: new Map([['x', {}]]), manifest: null });
        mergePostings.mockReturnValue([{ umid: 'a', score: 90, shard: 1 }]);
        getCachedDbConnection.mockResolvedValue({ sqlite3: {}, db: {} });
        executeSql.mockResolvedValue([{ id: 'a', type: 'model', name: 'A', fni_score: 50 }]);
        const res = await GET(req('q=llama'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tier).toBe('inverted_index');
        expect(body.results).toHaveLength(1);
        expect(res.headers.get('Cache-Control')).toMatch(/public/);
    });
});

describe('GET /api/search — cold-shard hydration timeout', () => {
    it('hydration shards all fail transiently with NO rows -> honest 503 (cold_shard_timeout), no-store', async () => {
        fetchAllTermPostings.mockResolvedValue({ terms: ['x'], results: new Map([['x', {}]]), manifest: null });
        mergePostings.mockReturnValue([{ umid: 'a', score: 90, shard: 1 }]);
        getCachedDbConnection.mockRejectedValue(new Error('transient VFS open failure'));
        executeSql.mockResolvedValue([]);
        const res = await GET(req('q=llama'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Retry-After')).toBe('2');
        const body = await res.json();
        expect(body.transient).toBe(true);
        expect(body.reason).toBe('cold_shard_timeout');
        // The transient is NOT a clean empty result.
        expect(body.results).toBeUndefined();
    });
});

describe('GET /api/search — Tier-2 cluster fallback hard bound (the worst class)', () => {
    it('zero inverted hits + fallback throws (timeout) -> honest 503 (not a hang, not fake-empty)', async () => {
        // No term hits -> route enters the fallback. The fallback rejects (the
        // route caps it with withOpTimeout; a rejection stands in for that bail).
        fetchAllTermPostings.mockResolvedValue({ terms: ['zzz'], results: new Map(), manifest: null });
        clusterFallbackSearch.mockRejectedValue(Object.assign(new Error("Op 'cluster_fallback' exceeded 5000ms deadline"), { code: 'VFS_OP_TIMEOUT' }));
        const res = await GET(req('q=zzzunmatched'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = await res.json();
        expect(body.transient).toBe(true);
        expect(body.reason).toBe('cluster_fallback_budget');
        expect(body.tier).toBe('cluster_fallback');
    });

    it('zero inverted hits + fallback embed timeout -> reason=embedding_timeout', async () => {
        fetchAllTermPostings.mockResolvedValue({ terms: ['zzz'], results: new Map(), manifest: null });
        clusterFallbackSearch.mockRejectedValue(Object.assign(new Error("Op 'fallback:embed' exceeded 4000ms deadline"), { code: 'VFS_OP_TIMEOUT' }));
        const res = await GET(req('q=zzzunmatched'));
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.reason).toBe('embedding_timeout');
    });

    it('zero inverted hits + fallback COMPLETES with nothing -> genuine empty 200 (NOT a 503)', async () => {
        // A fallback that runs and honestly finds nothing is a real empty result,
        // distinct from a budget-bailed transient. Must be a 200 empty, not a 503.
        fetchAllTermPostings.mockResolvedValue({ terms: ['zzz'], results: new Map(), manifest: null });
        clusterFallbackSearch.mockResolvedValue([]);
        const res = await GET(req('q=zzzunmatched'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tier).toBe('empty');
        expect(body.results).toEqual([]);
    });
});

describe('GET /api/search — browse budget', () => {
    it('browse (no q, type filter) with all shards failing + no rows -> honest 503 (cold_shard_timeout)', async () => {
        getCachedDbConnection.mockRejectedValue(new Error('transient VFS open failure'));
        executeSql.mockResolvedValue([]);
        const res = await GET(req('type=model'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = await res.json();
        expect(body.reason).toBe('cold_shard_timeout');
        expect(body.tier).toBe('browse');
    });

    it('browse warm -> 200 browse envelope', async () => {
        getCachedDbConnection.mockResolvedValue({ sqlite3: {}, db: {} });
        executeSql.mockResolvedValue([{ id: 'm1', type: 'model', _dbSort: 0 }]);
        const res = await GET(req('type=model'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tier).toBe('browse');
        expect(body.results).toHaveLength(1);
    });
});
