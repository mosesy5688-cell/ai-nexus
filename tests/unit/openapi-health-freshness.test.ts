/**
 * D-2026-0717-345 P1b — Health freshness/coherence: doc⇄runtime contract + the REAL
 * GET handler.
 *
 * Health (src/pages/api/v1/health.ts) exposes three freshness fields sourced from the
 * already-loaded shards manifest: served_build_id, manifest_etag, manifest_state.
 * Two locks:
 *  (1) the public OpenAPI schema matches that runtime (nullable strings + a closed
 *      manifest_state enum), so a strict typed client sees them; and
 *  (2) the REAL GET handler is executed (loadManifest mocked to loaded/fallback/
 *      unavailable) — asserting the response BODY + HTTP contract per case, and that
 *      the served path's only data dependency is loadManifest (it does NOT force-load
 *      the ~26MB id-index.bin). A regression that drops/mistypes a field or wires in
 *      an id-index read fails here (D-346).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mock the ONLY runtime deps health.ts imports so the REAL GET handler runs
// hermetically (no R2, no id-index, no network). loadManifest is the sole data dep;
// getVfsHealth returns in-memory isolate counters (not a data/index load).
vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
const loadManifest = vi.fn();
vi.mock('../../src/lib/sqlite-engine.js', () => ({ loadManifest: (...a: any[]) => loadManifest(...a) }));
vi.mock('../../src/lib/r2-vfs.js', () => ({ getVfsHealth: () => ({ jread_total: 0 }) }));

import { GET } from '../../src/pages/api/v1/health.js';

const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');
const HEALTH_PROPS = () => schema.components.schemas.HealthResponse.properties;
const HEALTH_SRC = fileURLToPath(new URL('../../src/pages/api/v1/health.ts', import.meta.url));

describe('P1b: OpenAPI HealthResponse exposes the three freshness fields', () => {
    it('uses the 3.0.x nullable convention (sanity: not 3.1)', () => {
        expect(schema.openapi).toMatch(/^3\.0/);
    });
    it('served_build_id is a nullable string', () => {
        const p = HEALTH_PROPS().served_build_id;
        expect(p).toBeDefined();
        expect([p.type, p.nullable]).toEqual(['string', true]);
    });
    it('manifest_etag is a nullable string', () => {
        const p = HEALTH_PROPS().manifest_etag;
        expect(p).toBeDefined();
        expect([p.type, p.nullable]).toEqual(['string', true]);
    });
    it('manifest_state is a closed enum (loaded|fallback|unavailable)', () => {
        const p = HEALTH_PROPS().manifest_state;
        expect(p).toBeDefined();
        expect(p.type).toBe('string');
        // Must match the runtime union in health.ts exactly (no extra/missing member).
        expect([...p.enum].sort()).toEqual(['fallback', 'loaded', 'unavailable']);
    });
    it('the endpoint 200 response still references HealthResponse', () => {
        const ref = schema.paths['/api/v1/health'].get.responses['200'].content['application/json'].schema.$ref;
        expect(ref).toBe('#/components/schemas/HealthResponse');
    });
});

describe('P1b: REAL GET /api/v1/health handler — freshness across loaded/fallback/unavailable', () => {
    beforeEach(() => loadManifest.mockReset());

    it('loaded: real manifest -> served_build_id + manifest_etag + manifest_state=loaded (200 JSON)', async () => {
        loadManifest.mockResolvedValue({ build_id: 'run-777', _etag: 'etag-777' });
        const res = await GET({} as any);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
        const b = await res.json();
        expect([b.served_build_id, b.manifest_etag, b.manifest_state]).toEqual(['run-777', 'etag-777', 'loaded']);
        expect(loadManifest).toHaveBeenCalledTimes(1);
    });

    it('fallback: {_etag:"fallback"} -> manifest_state=fallback, no build id', async () => {
        loadManifest.mockResolvedValue({ _etag: 'fallback' });
        const b = await (await GET({} as any)).json();
        expect([b.manifest_state, b.manifest_etag, b.served_build_id]).toEqual(['fallback', 'fallback', null]);
    });

    it('unavailable: null manifest -> manifest_state=unavailable, nulls', async () => {
        loadManifest.mockResolvedValue(null);
        const b = await (await GET({} as any)).json();
        expect([b.manifest_state, b.served_build_id, b.manifest_etag]).toEqual(['unavailable', null, null]);
    });

    it('does NOT load id-index.bin: loadManifest is the sole data dependency of the executed path', async () => {
        loadManifest.mockResolvedValue({ build_id: 'x', _etag: 'y' });
        await GET({} as any);
        expect(loadManifest).toHaveBeenCalledTimes(1); // the only awaited data dependency
        // Static proof: the handler imports NO id-index module (the comment names it
        // only to explain WHY it is avoided; there is no import/read of it).
        const src = readFileSync(HEALTH_SRC, 'utf8');
        expect(src).not.toMatch(/from\s+['"][^'"]*id-index[^'"]*['"]/i);
        expect(src).not.toMatch(/IdIndex|readIndex|loadIndex/);
    });
});
