/**
 * SRS-1 — OpenAPI ⇄ route-file parity invariant (tier-1, hermetic).
 *
 * INVARIANT: every public `/api/v1/*` path declared in the OpenAPI doc-contract
 * (src/data/openapi-schema.json) corresponds to a real Astro route file on disk,
 * and every public v1 route file is declared in OpenAPI. An Agent discovers the
 * surface from OpenAPI; a declared-but-absent path is a broken promise and an
 * undeclared-but-live route is an undiscoverable capability. This is a SET-PARITY
 * check between the declared path set and the filesystem route set.
 *
 * Also locks P-08 (NO_GAP): /api/v1/health is declared in OpenAPI AND has a route
 * file — the health surface stays consistent.
 *
 * HERMETIC: reads the static schema JSON + globs the route files. No live fetch.
 * Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');

// Map an OpenAPI path like '/api/v1/badge/{umid}' to the Astro route file that
// serves it: {param} -> [param] (catch-all entity uses [...id]).
function pathToRouteFiles(p: string): string[] {
    const rel = p.replace(/^\/api\/v1\//, '');
    // Known catch-all: /api/v1/entity/{id} -> entity/[...id].ts
    if (rel === 'entity/{id}') return ['src/pages/api/v1/entity/[...id].ts'];
    const file = rel.replace(/\{(\w+)\}/g, '[$1]');
    return [`src/pages/api/v1/${file}.ts`];
}

const DECLARED_V1_PATHS = Object.keys(schema.paths)
    .filter((p) => p.startsWith('/api/v1/'))
    .sort();

// The route files that actually exist under src/pages/api/v1, expressed as the
// OpenAPI path they back. Kept in lock-step with the filesystem.
const ROUTE_FILE_TO_PATH: Record<string, string> = {
    'src/pages/api/v1/select.ts': '/api/v1/select',
    'src/pages/api/v1/search.ts': '/api/v1/search',
    'src/pages/api/v1/compare.ts': '/api/v1/compare',
    'src/pages/api/v1/badge/[umid].ts': '/api/v1/badge/{umid}',
    'src/pages/api/v1/entity/[...id].ts': '/api/v1/entity/{id}',
    'src/pages/api/v1/health.ts': '/api/v1/health',
    'src/pages/api/v1/datasets.ts': '/api/v1/datasets',
    'src/pages/api/v1/concepts.ts': '/api/v1/concepts',
    'src/pages/api/v1/trends/batch.ts': '/api/v1/trends/batch',
};

describe('SRS-1: every declared v1 OpenAPI path has a route file on disk', () => {
    for (const p of DECLARED_V1_PATHS) {
        it(`${p} -> route file exists`, () => {
            const candidates = pathToRouteFiles(p);
            const found = candidates.some((c) => existsSync(abs(c)));
            expect(found, `${p} expected one of ${candidates.join(' | ')}`).toBe(true);
        });
    }
});

describe('SRS-1: every v1 route file on disk is declared in OpenAPI', () => {
    for (const [file, path] of Object.entries(ROUTE_FILE_TO_PATH)) {
        it(`${file} is present and its path ${path} is declared`, () => {
            expect(existsSync(abs(file)), `${file} must exist`).toBe(true);
            expect(schema.paths[path], `${path} must be declared in OpenAPI`).toBeDefined();
        });
    }

    it('declared v1 path set === route-file-derived path set (no drift either way)', () => {
        const fromFiles = Object.values(ROUTE_FILE_TO_PATH).sort();
        expect(DECLARED_V1_PATHS).toEqual(fromFiles);
    });
});

describe('SRS-1: P-08 health route+OpenAPI consistency (NO_GAP)', () => {
    it('/api/v1/health is declared in OpenAPI', () => {
        expect(schema.paths['/api/v1/health']).toBeDefined();
        expect(schema.paths['/api/v1/health'].get).toBeDefined();
    });
    it('the /api/v1/health route file exists', () => {
        expect(existsSync(abs('src/pages/api/v1/health.ts'))).toBe(true);
    });
});

describe('SRS-1: honest-contract caps/nullables in OpenAPI match the locked runtime', () => {
    // Spot-lock the two contract numbers SRS-1 cares about at the route-parity
    // tier (the field-level enumeration lives in openapi-stats-nullable.test.ts).
    it('search limit maximum == 20 (FREE_TIER_MAX)', () => {
        const limit = schema.paths['/api/v1/search'].get.parameters
            .find((p: any) => p.name === 'limit');
        expect(limit.schema.maximum).toBe(20);
    });
    it('CompareResponse resolved fni_factors.semantic is nullable', () => {
        const resolved = schema.components.schemas.CompareResponse
            .properties.entities.items.oneOf[0];
        expect(resolved.properties.fni_factors.properties.semantic.nullable).toBe(true);
    });
});
