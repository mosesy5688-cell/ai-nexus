/**
 * ENT-503 (I-1) — route-level Z-4 judged-red table for GET /api/v1/entity/:id.
 * REAL handler + REAL oracle + REAL range reader over a mocked substrate. The
 * index object is declared LARGER than the old 30 MB whole-blob cap (production
 * since 2026-10-08). `slow` shards emulate production cold opens (each probe
 * eats the 6 s budget) so the pre-fix outcome for a fan-out is the honest 503.
 * Acceptance (f2): (i) real entity -> detail; (ii) definitely absent -> 404;
 * (iii) not completed -> 503. Review F1: a coherent index HIT whose shard(s)
 * return nothing (stale shard handle) must be 503, never 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xxhash64Mod } from '../../src/utils/xxhash64.js';
import { buildIndexBuffer } from './helpers/id-index-fixture.js';
import { mockRangeR2 } from './helpers/ent503-range-r2.js';

const H = vi.hoisted(() => ({
    env: { NODE_ENV: 'production', R2_ASSETS: null as any },
    pin: { build_id: 'run-B', _etag: 'etag-pin', partitions: { meta_shards: 96 }, logicalToBlob: null } as any,
    rows: [] as any[],
    shardMode: new Map<string, 'error' | 'slow' | 'stale'>(),
    sqlCalls: 0,
    clock: { t: 0 },
}));
vi.mock('cloudflare:workers', () => ({ env: H.env }));
vi.mock('../../src/lib/sqlite-engine.js', () => ({
    loadManifest: async () => H.pin,
    getCachedDbConnection: async (_b: any, _d: any, dbName: string) => ({ sqlite3: {}, db: { dbName } }),
    executeSql: async (_s: any, db: any, sql: string, bind: any[]) => {
        H.sqlCalls++;
        const mode = H.shardMode.get(db.dbName);
        if (mode === 'error') throw new Error('shard read failed');
        if (mode === 'slow') { H.clock.t += 7000; return []; }
        if (mode === 'stale') return []; // old-build pages: clean miss for a new entity
        // Faithful to the route SQL's casing: lower(col) IN (...) when present,
        // exact (case-sensitive) comparison otherwise (pre-F3 SQL).
        const ci = /lower\(id\) IN/.test(sql);
        const forms = new Set(bind.slice(0, -2).map((v: any) => String(v)));
        const norm = (v: any) => (ci ? String(v).replace(/[A-Z]/g, c => c.toLowerCase()) : String(v));
        return H.rows.filter(r => r._db === db.dbName && (forms.has(norm(r.id)) || forms.has(norm(r.slug))));
    },
}));
vi.mock('../../src/utils/packet-loader.js', () => ({ fetchBundleReadme: vi.fn(), loadEntityStreams: vi.fn() }));

import { GET } from '../../src/pages/api/v1/entity/[...id].js';
import { _resetIdIndexForTest } from '../../src/lib/id-index-reader.js';
import { INDEX_BYTES_CEILING } from '../../src/lib/id-index-budget.js';

const SH = 96;
const OVER_CAP = 31_666_148; // production size on 2026-10-10 (> 31,457,280 old cap)
const dbOf = (form: string) => `meta-${String(xxhash64Mod(form, SH)).padStart(2, '0')}.db`;
const ABSENT = '__reliability_probe_invalid_id__';
const REAL = { id: 'hf-model--acme--widget', slug: 'acme--widget', type: 'model', name: 'widget', author: 'acme', source: 'huggingface' };
const NEW = { id: 'hf-model--acme--brandnew', slug: 'acme--brandnew', type: 'model', name: 'brandnew', author: 'acme', source: 'huggingface' };
const place = (r: any) => ({ ...r, _db: dbOf(r.slug) });
const idxFor = (bid: string, ents: any[]) => buildIndexBuffer(
    ents.flatMap(e => [{ form: e.id, shardIdx: xxhash64Mod(e.slug, SH) }, { form: e.slug, shardIdx: xxhash64Mod(e.slug, SH) }]), bid);

async function call(id: string) {
    const res = await GET({ params: { id }, url: new URL(`https://x/api/v1/entity/${id}`), request: new Request('https://x') } as any);
    return { status: res.status, body: await res.json(), cc: res.headers.get('Cache-Control') };
}

describe('ENT-503 Z-4 judged-red table (route level, local)', () => {
    let r2: ReturnType<typeof mockRangeR2>;
    let errLog: any;
    beforeEach(() => {
        _resetIdIndexForTest();
        r2 = mockRangeR2();
        H.env.R2_ASSETS = r2;
        H.pin = { ...H.pin, build_id: 'run-B' };
        H.rows = [place(REAL)];
        H.shardMode = new Map();
        H.sqlCalls = 0;
        H.clock.t = 9_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => H.clock.t);
        errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    const slowAll = () => { for (let i = 0; i < SH; i++) H.shardMode.set(`meta-${String(i).padStart(2, '0')}.db`, 'slow'); };

    it('Z1 index > old cap, coherent, absent, cold shards -> 404 with zero probes (was 503)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        slowAll();
        const r = await call(ABSENT);
        expect(r.status).toBe(404);
        expect(H.sqlCalls).toBe(0);
    });

    it('Z2 index > old cap, coherent, present -> 200 correct detail on the first probe', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        const r = await call('acme--widget');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(REAL.id);
        expect(H.sqlCalls).toBe(1);
    });

    it('Z3 index > old cap, INCOHERENT (index A, manifest B), absent, cold shards -> 503 (unchanged)', async () => {
        r2.publish(idxFor('run-A', [REAL]), 'e-A', OVER_CAP);
        slowAll();
        const r = await call(ABSENT);
        expect(r.status).toBe(503);
        expect(r.cc).toBe('no-store');
        const line = errLog.mock.calls.map((c: any[]) => c.join(' ')).find((l: string) => l.includes('inconclusive'));
        expect(line).toMatch(/br=I-4\/I-6 .*ist=ok coh=false res=false ibid=run-A mbid=run-B isz=31666148/);
    });

    it('Z4 entity NEW in served build, index lags (A) -> found via full fan-out, never 404', async () => {
        r2.publish(idxFor('run-A', [REAL]), 'e-A', OVER_CAP);
        H.rows = [place(REAL), place(NEW)];
        const r = await call('acme--brandnew');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(NEW.id);
    });

    it('Z5 = v127 f4(v): coherent index HIT, resolved shard returns ZERO rows (stale), others clean -> 503, never 404', async () => {
        r2.publish(idxFor('run-B', [REAL, NEW]), 'e-B', OVER_CAP);
        H.rows = [place(REAL)];                     // isolate still reads build-A pages
        H.shardMode.set(dbOf(NEW.slug), 'stale');
        const r = await call('acme--brandnew');
        expect(r.status).toBe(503);
        const line = errLog.mock.calls.map((c: any[]) => c.join(' ')).find((l: string) => l.includes('inconclusive'));
        expect(line).toMatch(/br=hit\/empty-hit .*coh=true res=true/);
    });

    it('Z6 range read failure -> degrade; absent + cold shards -> 503 (unchanged)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        r2.failIf = (g) => g.offset !== null && g.offset > 0;
        slowAll();
        const r = await call(ABSENT);
        expect(r.status).toBe(503);
        const line = errLog.mock.calls.map((c: any[]) => c.join(' ')).find((l: string) => l.includes('inconclusive'));
        expect(line).toMatch(/br=I-3\/I-6 idx=false ist=r2_error/);
    });

    it('Z7 range read failure -> degrade; absent + every shard clean -> 404 by clean exhaustion (unchanged)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        r2.failIf = (g) => g.offset !== null && g.offset > 0;
        const r = await call(ABSENT);
        expect(r.status).toBe(404);
        expect(H.sqlCalls).toBeGreaterThan(2);
    });

    it('Z8 etag changes on every read (publish storm) -> version_changed -> 503 with cold shards', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        let n = 0;
        r2.beforeServe = (g) => { if (g.offset !== null && g.offset > 0) r2.publish(idxFor('run-B', [REAL]), `e-${++n}`, OVER_CAP); };
        slowAll();
        const r = await call(ABSENT);
        expect(r.status).toBe(503);
    });

    it('Z9 manifest build_id missing -> no absence proof -> 503 with cold shards', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        H.pin = { ...H.pin, build_id: null };
        slowAll();
        expect((await call(ABSENT)).status).toBe(503);
    });

    it('Z10 present, coherent, its shard errors -> 503 (unchanged)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        H.shardMode.set(dbOf(REAL.slug), 'error');
        expect((await call('acme--widget')).status).toBe(503);
    });

    it('Z11 index object absent -> degrade; absent + cold shards -> 503 (unchanged)', async () => {
        r2.publish(null, 'none');
        slowAll();
        expect((await call(ABSENT)).status).toBe(503);
    });

    it('Z12 typed (prefixed) absent id = low fan-out -> index not consulted, 2-shard probe decides (unchanged)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        const r = await call('hf-model--nobody--nothing');
        expect(r.status).toBe(404);
        expect(r2.gets.length).toBe(0);
    });

    const inconclusive = () => errLog.mock.calls.map((c: any[]) => c.join(' ')).find((l: string) => l.includes('inconclusive'));

    it('v127 f4(iv): index size = derived ceiling + 1 B -> refused + refusing line; invalid id 503 (not 404)', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', INDEX_BYTES_CEILING + 1);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        slowAll();
        const r = await call(ABSENT);
        expect(r.status).toBe(503);
        expect(warn.mock.calls.map((c: any[]) => c.join(' ')).some((l: string) => l.includes('[IdIndex] refusing index'))).toBe(true);
        expect(inconclusive()).toMatch(/br=I-1\/I-6 idx=false ist=refused/);
    });

    it('I-2 attribution: index read never settles -> timeout -> 503 with br=I-2', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        r2.hangIf = (g) => g.offset !== null && g.offset > 0;
        H.clock.t = 9_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => H.clock.t);
        H.shardMode.set(dbOf(ABSENT), 'error');
        const r = await call(ABSENT);
        expect(r.status).toBe(503);
        expect(inconclusive()).toMatch(/br=I-2\/I-5 idx=false ist=timeout/);
    }, 10_000);

    it('I-5 attribution: coherent hit, resolved shard errors -> 503 with br=hit/I-5', async () => {
        r2.publish(idxFor('run-B', [REAL]), 'e-B', OVER_CAP);
        H.shardMode.set(dbOf(REAL.slug), 'error');
        expect((await call('acme--widget')).status).toBe(503);
        expect(inconclusive()).toMatch(/br=hit\/I-5 /);
    });

    it('review F3: stored id/slug with UPPERCASE, coherent ASCII hit -> 200 (lower() SQL), not a permanent 503', async () => {
        const UP = { ...REAL, id: 'hf-model--Acme--Widget', slug: 'Acme--Widget' };
        r2.publish(idxFor('run-B', [{ id: UP.id.toLowerCase(), slug: UP.slug.toLowerCase() }]), 'e-B', OVER_CAP);
        H.rows = [{ ...UP, _db: dbOf(UP.slug.toLowerCase()) }];
        const r = await call('acme--widget');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(UP.id);
    });

    it('acceptance (iii) unfinished lookup: present id, budget exhausted before its shard -> 503', async () => {
        r2.publish(idxFor('run-A', [REAL]), 'e-A', OVER_CAP); // incoherent: full fan-out, resolved first
        slowAll();
        expect((await call('acme--widget')).status).toBe(503);
    });
});
