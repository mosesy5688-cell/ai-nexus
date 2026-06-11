import { describe, it, expect, vi, beforeEach } from 'vitest';

// B7 — /api/v1/compare endpoint envelope. Proves the route wraps the budgeted
// cold-shard scan and, on exhaustion, returns an HONEST retryable 503
// (Retry-After + Cache-Control: no-store + resolved/pending body), NEVER riding
// to a dead connection — and that a normal warm compare still returns the 200
// envelope unchanged. We mock sqlite-engine so no real VFS is touched; a slow
// connection-open simulates the cold-shard stall.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));

const getCachedDbConnection = vi.fn();
const executeSql = vi.fn();
vi.mock('../../src/lib/sqlite-engine.js', () => ({
    getCachedDbConnection: (...a: any[]) => getCachedDbConnection(...a),
    executeSql: (...a: any[]) => executeSql(...a),
    loadManifest: vi.fn(async () => ({ _etag: 'etag-1', partitions: { meta_shards: 64 } })),
}));

import { GET } from '../../src/pages/api/v1/compare.js';

function req(ids: string) {
    const url = new URL(`https://free2aitools.com/api/v1/compare?ids=${encodeURIComponent(ids)}`);
    return { url, request: new Request(url.href) } as any;
}

beforeEach(() => {
    getCachedDbConnection.mockReset();
    executeSql.mockReset();
});

describe('GET /api/v1/compare — honest 503 on cold-shard exhaustion', () => {
    it('a shard whose open fails transiently -> 503 with Retry-After + no-store + pending ids', async () => {
        // Every shard open rejects (a transient VFS error stands in for the cold
        // stall the per-op firewall converts to a rejection) -> the scan resolves
        // nothing -> the route returns an honest 503, never a dead connection.
        getCachedDbConnection.mockRejectedValue(new Error('transient VFS open failure'));
        executeSql.mockResolvedValue([]);
        const res = await GET(req('hf-model--a--x,hf-model--b--y'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('2');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = await res.json();
        expect(body.error).toMatch(/transient|budget/i);
        // Honest partial signal: nothing resolved, both ids pending.
        expect(Array.isArray(body.pending)).toBe(true);
        expect(body.pending.length).toBe(2);
        expect(body.resolved).toEqual([]);
    });

    it('normal warm compare -> 200 with the unchanged envelope shape', async () => {
        getCachedDbConnection.mockResolvedValue({ sqlite3: {}, db: {} });
        executeSql.mockImplementation(async (_s3: any, _db: any, _sql: string, params: any[]) => {
            // Echo a row for each bound key so both ids resolve.
            const key = params[0];
            return [{
                id: key, slug: key, name: 'X', author: 'a', type: 'model',
                fni_score: 50, fni_a: 60, fni_p: 70, fni_r: 50, fni_q: 80,
                params_billions: 8, context_length: 8192, vram_estimate_gb: 16,
                license: 'apache-2.0', pipeline_tag: 'text-generation',
                downloads: 100, stars: 10, last_modified: '2026-01-01', architecture: 'llama',
            }];
        });
        const res = await GET(req('hf-model--a--x,hf-model--b--y'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.version).toBe('fni_v2.0');
        expect(body.entities).toHaveLength(2);
        expect(body.entities[0].found).toBe(true);
        // Envelope shape preserved: per-entity fni_factors with semantic=null + note.
        expect(body.entities[0].fni_factors.semantic).toBeNull();
        expect(body.entities[0].fni_factors.semantic_note).toMatch(/query-time baseline/i);
        expect(body.meta.requested).toBe(2);
        expect(body.meta.found).toBe(2);
        // 200 keeps the cacheable public Cache-Control (NOT no-store).
        expect(res.headers.get('Cache-Control')).toMatch(/public/);
    });

    it('still rejects <2 / >25 ids with 400 (public limit unchanged)', async () => {
        const one = await GET(req('only-one'));
        expect(one.status).toBe(400);
        const tooMany = await GET(req(Array.from({ length: 26 }, (_, i) => `id${i}`).join(',')));
        expect(tooMany.status).toBe(400);
    });
});
