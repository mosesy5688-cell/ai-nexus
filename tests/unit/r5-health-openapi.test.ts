/**
 * R5 Phase-1 (Commit 2) — health reader-mode observability + OpenAPI contract.
 *
 * Locks: (1) the OpenAPI HealthResponse.reader block exposes EXACTLY reader_mode /
 * publication_source / build_id / generation (privacy: NO raw counts / traffic /
 * adoption); (2) the REAL GET handler emits that block across loaded/fallback/
 * unavailable, in the hardcoded legacy_only mode, from a SINGLE loadManifest call
 * (no id-index force-load); (3) doc<->runtime keys stay in sync (anti-vacuity).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
const loadManifest = vi.fn();
vi.mock('../../src/lib/sqlite-engine.js', () => ({ loadManifest: (...a: any[]) => loadManifest(...a) }));
vi.mock('../../src/lib/r2-vfs.js', () => ({ getVfsHealth: () => ({ jread_total: 0 }) }));

import { GET } from '../../src/pages/api/v1/health.js';
import { PHASE1_READER_MODE } from '../../src/lib/published-pointer.js';

const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');
const READER = () => schema.components.schemas.HealthResponse.properties.reader;
const ALLOWED = ['build_id', 'generation', 'publication_source', 'reader_mode'];

function legacyPin(build_id = 'run-777', _etag = 'etag-777') {
    return { build_id, _etag, source: 'legacy', generation: null };
}

describe('R5: OpenAPI HealthResponse.reader contract', () => {
    it('reader is an object', () => {
        expect(READER()).toBeDefined();
        expect(READER().type).toBe('object');
    });
    it('exposes EXACTLY the 4 allowed fields (privacy: no counts/traffic/adoption)', () => {
        expect(Object.keys(READER().properties).sort()).toEqual(ALLOWED);
    });
    it('reader_mode enum matches the ReaderMode union', () => {
        expect([...READER().properties.reader_mode.enum].sort()).toEqual(['legacy_only', 'pointer_capable']);
    });
    it('publication_source is a nullable closed enum matching CyclePin.source', () => {
        const p = READER().properties.publication_source;
        expect([p.type, p.nullable]).toEqual(['string', true]);
        expect([...p.enum].sort()).toEqual(['fallback', 'legacy', 'pointer']);
    });
    it('build_id nullable string, generation nullable integer', () => {
        expect([READER().properties.build_id.type, READER().properties.build_id.nullable]).toEqual(['string', true]);
        expect([READER().properties.generation.type, READER().properties.generation.nullable]).toEqual(['integer', true]);
    });
});

describe('R5: REAL GET /api/v1/health — reader block (loaded/fallback/unavailable)', () => {
    beforeEach(() => loadManifest.mockReset());

    it('legacy loaded -> reader_mode=legacy_only, source=legacy, build_id set, generation null', async () => {
        loadManifest.mockResolvedValue(legacyPin());
        const b = await (await GET({} as any)).json();
        expect(b.reader).toEqual({ reader_mode: 'legacy_only', publication_source: 'legacy', build_id: 'run-777', generation: null });
        expect(loadManifest).toHaveBeenCalledTimes(1); // single data dep, no id-index force-load
        expect((loadManifest.mock.calls[0] as any[])[2]).toBe(PHASE1_READER_MODE); // fence: hardcoded mode
        expect(PHASE1_READER_MODE).toBe('legacy_only');
    });

    it('fallback pin -> publication_source=fallback (still legacy_only)', async () => {
        loadManifest.mockResolvedValue({ _etag: 'fallback', source: 'fallback', build_id: null, generation: null });
        const b = await (await GET({} as any)).json();
        expect([b.reader.publication_source, b.reader.reader_mode]).toEqual(['fallback', 'legacy_only']);
    });

    it('unavailable (null manifest) -> publication_source null, build_id null, still legacy_only', async () => {
        loadManifest.mockResolvedValue(null);
        const b = await (await GET({} as any)).json();
        expect(b.reader).toEqual({ reader_mode: 'legacy_only', publication_source: null, build_id: null, generation: null });
    });

    it('privacy + anti-vacuity: reader present, EXACTLY 4 keys, none traffic/adoption/count', async () => {
        loadManifest.mockResolvedValue(legacyPin());
        const b = await (await GET({} as any)).json();
        expect(b.reader).toBeDefined();                       // anti-vacuity: a dropped block fails here
        expect(Object.keys(b.reader).sort()).toEqual(ALLOWED);
        const banned = /request|traffic|adoption|count|kpi|users?/i;
        for (const k of Object.keys(b.reader)) expect(k).not.toMatch(banned);
    });

    it('doc<->runtime: runtime reader keys === OpenAPI reader.properties keys', async () => {
        loadManifest.mockResolvedValue(legacyPin());
        const b = await (await GET({} as any)).json();
        expect(Object.keys(b.reader).sort()).toEqual(Object.keys(READER().properties).sort());
    });
});
