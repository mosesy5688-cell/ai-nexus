/**
 * ENT-503 review F3 / M1 — route-level casing tests for GET /api/v1/entity/:id.
 * The route matches lower(id|slug|umid) (index keys are lowercased; stored casing
 * is not normalized), but exact-case rows lead the ORDER BY and preferExactCase
 * keeps them, so case-folding never changes which entity origin/main served.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRangeR2 } from './helpers/ent503-range-r2.js';

vi.mock('cloudflare:workers', async () => ({ env: (await import('./helpers/ent503-route-harness.js')).H.env }));
vi.mock('../../src/lib/sqlite-engine.js', async () => (await import('./helpers/ent503-route-harness.js')).sqliteEngineMock());
vi.mock('../../src/utils/packet-loader.js', () => ({ fetchBundleReadme: vi.fn(), loadEntityStreams: vi.fn() }));

import { GET } from '../../src/pages/api/v1/entity/[...id].js';
import { _resetIdIndexForTest } from '../../src/lib/id-index-reader.js';
import { H, OVER_CAP, dbOf, REAL, idxFor, twin, callRoute } from './helpers/ent503-route-harness.js';

const call = (id: string) => callRoute(GET, id);

describe('ENT-503 casing (route level, local)', () => {
    let r2: ReturnType<typeof mockRangeR2>;
    beforeEach(() => {
        _resetIdIndexForTest();
        r2 = mockRangeR2();
        H.env.R2_ASSETS = r2;
        H.pin = { ...H.pin, build_id: 'run-B' };
        H.rows = [];
        H.shardMode = new Map();
        H.sqlCalls = 0;
        H.clock.t = 9_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => H.clock.t);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('review F3: stored id/slug with UPPERCASE, coherent ASCII hit -> 200 (lower() SQL), not a permanent 503', async () => {
        const UP = { ...REAL, id: 'hf-model--Acme--Widget', slug: 'Acme--Widget' };
        r2.publish(idxFor('run-B', [{ id: UP.id.toLowerCase(), slug: UP.slug.toLowerCase() }]), 'e-B', OVER_CAP);
        H.rows = [{ ...UP, _db: dbOf(UP.slug.toLowerCase()) }];
        const r = await call('acme--widget');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(UP.id);
    });

    // -- review M1: case twins / exact-case preference ---------------------------

    it('M1: id case twins -> lowercase request returns the lowercase entity (origin/main behaviour)', async () => {
        const UP = twin('hf-model--Acme--W', 'Acme--W'), LO = twin('hf-model--acme--w', 'acme--w');
        r2.publish(idxFor('run-B', [{ id: 'hf-model--acme--w', slug: 'acme--w' }]), 'e-B', OVER_CAP);
        H.rows = [UP, LO];
        const r = await call('hf-model--acme--w');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe('hf-model--acme--w');
    });

    it('M1: id case twins -> exact uppercase request returns the uppercase entity', async () => {
        const UP = twin('hf-model--Acme--W', 'Acme--W'), LO = twin('hf-model--acme--w', 'acme--w');
        r2.publish(idxFor('run-B', [{ id: 'hf-model--acme--w', slug: 'acme--w' }]), 'e-B', OVER_CAP);
        H.rows = [UP, LO];
        const r = await call('hf-model--Acme--W');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe('hf-model--Acme--W');
    });

    it('M1: uppercase-only stored row is reachable (200) by its lowercase id', async () => {
        const UP = twin('hf-model--Acme--W', 'Acme--W');
        r2.publish(idxFor('run-B', [{ id: 'hf-model--acme--w', slug: 'acme--w' }]), 'e-B', OVER_CAP);
        H.rows = [UP];
        const r = await call('hf-model--acme--w');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe('hf-model--Acme--W');
    });

    it('M1: bare-id slug case twins (different types) -> FOUND the exact-case row, no new 409', async () => {
        const UPM = twin('hf-model--Acme--W', 'Acme--W', 'model'), LOD = twin('hf-dataset--acme--w', 'acme--w', 'dataset');
        r2.publish(idxFor('run-B', [{ id: 'hf-dataset--acme--w', slug: 'acme--w' }]), 'e-B', OVER_CAP);
        H.rows = [UPM, LOD];
        const r = await call('acme--w');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe('hf-dataset--acme--w');
    });

    it('M1 ORDER BY: exact-case id outranks a binary-smaller case twin that matches by slug', async () => {
        // Y sorts first in BINARY order ('C' < 'c') and is exact via its slug; X is the
        // exact requested id. Only the (id = raw) ORDER BY key makes X win the dedupe.
        const X = twin('hf-model--Acme--W', 'Acme--W'), Y = { ...twin('hf-model--ACME--W', 'acme--w'), _db: dbOf('acme--w') };
        r2.publish(idxFor('run-B', [{ id: 'hf-model--acme--w', slug: 'acme--w' }]), 'e-B', OVER_CAP);
        H.rows = [Y, X];
        const r = await call('hf-model--Acme--W');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe('hf-model--Acme--W');
    });
});
