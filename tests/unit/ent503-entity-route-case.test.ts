/**
 * ENT-503 review F3 / M1 / R1 — route-level casing tests for GET /api/v1/entity/:id,
 * under PRODUCTION-FAITHFUL placement: rows live on meta-<xxhash64(RAW slug)> and
 * the id-index is built first-wins in slot order (helpers/ent503-route-harness.ts).
 * Case twins therefore sit on DIFFERENT shards and the index can point at the
 * UPPERCASE twin. Expected values are origin/main's (lowercased forms, case-
 * sensitive SQL): an exact-case row anywhere must win; a fold-only row is served
 * only after a clean, complete loop (new true positive); otherwise 503 / 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRangeR2 } from './helpers/ent503-range-r2.js';

vi.mock('cloudflare:workers', async () => ({ env: (await import('./helpers/ent503-route-harness.js')).H.env }));
vi.mock('../../src/lib/sqlite-engine.js', async () => (await import('./helpers/ent503-route-harness.js')).sqliteEngineMock());
vi.mock('../../src/utils/packet-loader.js', () => ({ fetchBundleReadme: vi.fn(), loadEntityStreams: vi.fn() }));

import { GET } from '../../src/pages/api/v1/entity/[...id].js';
import { _resetIdIndexForTest } from '../../src/lib/id-index-reader.js';
import { H, SH, OVER_CAP, dbOf, idxFor, twin, splitTwinStem, slotOf, callRoute } from './helpers/ent503-route-harness.js';

const call = (id: string) => callRoute(GET, id);
const { up, lo } = splitTwinStem();          // e.g. 'Acme--W7' / 'acme--w7'
const UP = twin(`hf-model--${up}`, up);       // on meta-<hash(up)>  (lower slot)
const LO = twin(`hf-model--${lo}`, lo);       // on meta-<hash(lo)>
const UPD = twin(`hf-dataset--${up}`, up, 'dataset'); // same raw slug as UP -> same shard

describe('ENT-503 casing (route level, production placement, local)', () => {
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

    it('fixture: twins on different shards; first-wins index points at the UPPERCASE twin', () => {
        expect(UP._db).not.toBe(LO._db);
        expect(slotOf(UP)).toBeLessThan(slotOf(LO));
    });

    it('R1: lowercase bare request, index -> UP shard -> returns LO (origin/main), not UP', async () => {
        r2.publish(idxFor('run-B', [UP, LO]), 'e-B', OVER_CAP);
        H.rows = [UP, LO];
        const r = await call(lo);
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(LO.id);
    });

    it('R1: uppercase bare request -> origin/main parity (LO: forms are lowercased)', async () => {
        r2.publish(idxFor('run-B', [UP, LO]), 'e-B', OVER_CAP);
        H.rows = [UP, LO];
        const r = await call(up);
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(LO.id);
    });

    it('R1: canonical lowercase id request -> LO (origin/main parity)', async () => {
        r2.publish(idxFor('run-B', [UP, LO]), 'e-B', OVER_CAP);
        H.rows = [UP, LO];
        const r = await call(LO.id);
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(LO.id);
    });

    it('R1: two fold-only rows on the UP shard do NOT turn origin/main FOUND(LO) into 409', async () => {
        r2.publish(idxFor('run-B', [UP, UPD, LO]), 'e-B', OVER_CAP);
        H.rows = [UP, UPD, LO];
        const r = await call(lo);
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(LO.id);
    });

    it('uppercase-only row is reachable when the loop finished cleanly (new true positive)', async () => {
        r2.publish(idxFor('run-B', [UP]), 'e-B', OVER_CAP);
        H.rows = [UP];
        const r = await call(lo);
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(UP.id);
    });

    it('uppercase-only row + a shard error during continued probing -> 503, not the fallback', async () => {
        r2.publish(idxFor('run-B', [UP]), 'e-B', OVER_CAP);
        H.rows = [UP];
        H.shardMode.set(dbOf(lo), 'error');
        expect((await call(lo)).status).toBe(503);
    });

    it('uppercase-only row + budget bail during continued probing -> 503, not the fallback', async () => {
        r2.publish(idxFor('run-B', [UP]), 'e-B', OVER_CAP);
        H.rows = [UP];
        for (let i = 0; i < SH; i++) {
            const db = `meta-${String(i).padStart(2, '0')}.db`;
            if (db !== UP._db) H.shardMode.set(db, 'slow');
        }
        expect((await call(lo)).status).toBe(503);
    });

    it('F3: co-resident uppercase-only stored id is reachable (200)', async () => {
        const U = twin('hf-model--Acme--Widget', 'Acme--Widget');
        r2.publish(idxFor('run-B', [U]), 'e-B', OVER_CAP);
        H.rows = [U];
        const r = await call('acme--widget');
        expect(r.status).toBe(200);
        expect(r.body.entity.id).toBe(U.id);
    });
});
