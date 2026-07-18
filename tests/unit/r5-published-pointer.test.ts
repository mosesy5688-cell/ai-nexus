/**
 * R5 Phase-1 reader substrate — THE FENCE (Founder D-2026-0717-350).
 *
 * Locks the non-negotiables: production runs legacy_only; legacy_only NEVER GETs
 * data/current.json and is byte-identical to today's manifest fields; the
 * pointer_capable branch is reachable ONLY via dependency injection and fails
 * safe on every fault. Includes an explicit non-vacuity proof (the spy DOES see
 * current.json under pointer_capable) and a RED-then-restore mutation proof on
 * the key guarantee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate sqlite-engine from wa-sqlite / VFS so the REAL production loadManifest
// entry point runs hermetically (loadManifest itself touches neither).
vi.mock('../../src/lib/r2-vfs.js', () => ({ R2RangeVFS: class {}, getVfsHealth: () => ({}) }));
vi.mock('@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs', () => ({ default: () => ({}) }));
vi.mock('@journeyapps/wa-sqlite/src/sqlite-api.js', () => ({ Factory: () => ({}) }));

import { loadManifest, _resetManifestCacheForTest } from '../../src/lib/sqlite-engine.js';
import {
    resolvePublishedPointer, loadLegacyCyclePin, buildLegacyCyclePin,
    buildFallbackCyclePin, PHASE1_READER_MODE, _resetPublishedPointerForTest,
} from '../../src/lib/published-pointer.js';

function jsonObj(body: any, etag = 'etag-abc') {
    return { httpEtag: `"${etag}"`, etag: `"${etag}"`, json: async () => body };
}
function throwingObj() {
    return { json: async () => { throw new Error('corrupt json'); } };
}
function mockR2(objects: Record<string, any>) {
    const getCalls: string[] = [];
    const get = vi.fn(async (key: string) => {
        getCalls.push(key);
        const v = objects[key];
        return v === undefined ? null : v;
    });
    return { getCalls, get };
}
const legacyStore = (buildId = 'run-L', etag = 'eL') => ({
    'data/shards_manifest.json': jsonObj({ build_id: buildId, partitions: { meta_shards: 96 } }, etag),
});
const validPointerStore = () => ({
    'data/current.json': jsonObj({
        schema: 1, build_id: 'run-5', cycle_prefix: 'data/cycles/run-5/',
        manifest_key: 'data/cycles/run-5/manifest.json', generation: 5,
    }),
    'data/cycles/run-5/manifest.json': jsonObj({
        build_id: 'run-5', partitions: { meta_shards: 96 },
        blobs: { 'meta-00.db': 'sha256:abc', 'id-index.bin': 'sha256:idx' },
    }),
    ...legacyStore(),
});
const withLegacy = (r2: ReturnType<typeof mockR2>) => ({ loadLegacy: () => loadLegacyCyclePin(r2, false) });

beforeEach(() => { _resetManifestCacheForTest(); _resetPublishedPointerForTest(); });

describe('FENCE: legacy_only NEVER GETs data/current.json', () => {
    it('PHASE1_READER_MODE is the hardcoded legacy_only constant', () => {
        expect(PHASE1_READER_MODE).toBe('legacy_only');
    });

    it('production loadManifest (default mode) GETs ONLY shards_manifest.json', async () => {
        const r2 = mockR2(validPointerStore());
        const pin = await loadManifest(r2, false); // default mode === PHASE1_READER_MODE
        expect(r2.get).toHaveBeenCalledWith('data/shards_manifest.json');
        expect(r2.get).not.toHaveBeenCalledWith('data/current.json'); // STRICTLY 0 current.json GETs
        expect(pin.source).toBe('legacy');
        expect(pin.build_id).toBe('run-L');
        expect(pin.logicalToBlob).toBeNull();
    });

    it('resolvePublishedPointer(legacy_only) delegates to legacy, no current.json', async () => {
        const r2 = mockR2(validPointerStore());
        const pin = await resolvePublishedPointer(r2, false, 'legacy_only', withLegacy(r2));
        expect(r2.getCalls).toEqual(['data/shards_manifest.json']);
        expect(r2.getCalls).not.toContain('data/current.json');
        expect(pin.source).toBe('legacy');
    });

    it('(non-vacuity) the spy DOES observe current.json under pointer_capable', async () => {
        const r2 = mockR2(validPointerStore());
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect(r2.getCalls).toContain('data/current.json'); // proves the legacy_only ZERO is meaningful
        expect(pin.source).toBe('pointer');
    });
});

describe('legacy CyclePin field parity (today baseline)', () => {
    it('build_id / partitions / _etag preserved + arbitrary manifest fields survive', () => {
        const raw = { build_id: 'run-7', partitions: { meta_shards: 96, total_entities: 551000, rankings_dbs: true }, shards: [1, 2, 3] };
        const pin = buildLegacyCyclePin(raw, 'etag-7');
        expect([pin.build_id, pin._etag, pin.source]).toEqual(['run-7', 'etag-7', 'legacy']);
        expect(pin.partitions).toEqual(raw.partitions);
        expect(pin.logicalToBlob).toBeNull();
        expect((pin as any).shards).toEqual([1, 2, 3]); // unedited consumers keep every field
    });

    it('hard-fallback CyclePin mirrors today ({_etag:fallback, meta_shards:96})', () => {
        const fb = buildFallbackCyclePin();
        expect([fb._etag, fb.source, fb.build_id]).toEqual(['fallback', 'fallback', null]);
        expect(fb.partitions.meta_shards).toBe(96);
    });

    it('loadLegacyCyclePin degrades to the hard-fallback on an R2 miss', async () => {
        const r2 = mockR2({}); // shards_manifest absent -> get null -> obj.json() throws -> fallback
        const pin = await loadLegacyCyclePin(r2, false);
        expect([pin.source, pin._etag]).toEqual(['fallback', 'fallback']);
        expect(pin.partitions.meta_shards).toBe(96);
    });
});

describe('pointer_capable DI degrade — every fault fails safe', () => {
    it('valid pointer -> source:pointer + logicalToBlob (blob keys VERBATIM data/blobs/<sha>)', async () => {
        const r2 = mockR2(validPointerStore());
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect(pin.source).toBe('pointer');
        expect(pin.generation).toBe(5);
        expect(pin.logicalToBlob!.get('meta-00.db')).toBe('data/blobs/abc'); // sha256: prefix stripped, blobs/ kept
        expect(pin.logicalToBlob!.get('id-index.bin')).toBe('data/blobs/idx');
    });

    it('pointer absent -> degrade to legacy', async () => {
        const r2 = mockR2(legacyStore('run-A'));
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect([pin.source, pin.build_id]).toEqual(['legacy', 'run-A']);
    });

    it('pointer corrupt (JSON throws) -> degrade to legacy', async () => {
        const r2 = mockR2({ 'data/current.json': throwingObj(), ...legacyStore('run-B') });
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect([pin.source, pin.build_id]).toEqual(['legacy', 'run-B']);
    });

    it('unknown / greater schema -> degrade to legacy (never mis-route)', async () => {
        const r2 = mockR2({ 'data/current.json': jsonObj({ schema: 2, build_id: 'x', manifest_key: 'k' }), ...legacyStore('run-C') });
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect([pin.source, pin.build_id]).toEqual(['legacy', 'run-C']);
    });

    it('pointer resolves but cycle manifest 404s -> MF-9 degrade to legacy', async () => {
        const r2 = mockR2({
            'data/current.json': jsonObj({ schema: 1, build_id: 'run-5', manifest_key: 'data/cycles/run-5/manifest.json', generation: 5 }),
            ...legacyStore('run-D'), // manifest_key intentionally absent from the store
        });
        const pin = await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect([pin.source, pin.build_id]).toEqual(['legacy', 'run-D']);
    });
});

describe('RED-then-restore mutation proof — the fence assertion has teeth', () => {
    it('the "no current.json GET" assertion FAILS when the guarantee is breached, PASSES when restored', async () => {
        // MUTATE the guarantee: run the FUTURE non-fenced mode. It MUST breach
        // "never GET current.json" so the assertion goes RED (not vacuous).
        const r2 = mockR2(validPointerStore());
        await resolvePublishedPointer(r2, false, 'pointer_capable', withLegacy(r2));
        expect(() => expect(r2.getCalls).not.toContain('data/current.json')).toThrow(); // RED under mutation

        // RESTORE: legacy_only (the production fence) never touches current.json -> GREEN.
        _resetPublishedPointerForTest();
        const r2b = mockR2(validPointerStore());
        await resolvePublishedPointer(r2b, false, 'legacy_only', withLegacy(r2b));
        expect(r2b.getCalls).not.toContain('data/current.json'); // GREEN restored
    });
});
