/**
 * HK-1 — OpenAPI ⇄ honest-contract nullability consistency.
 *
 * GROUNDED DOC-CONTRACT GAP (DEBT-003): the producer schema deliberately omits
 * `DEFAULT 0` from the stats columns (scripts/factory/lib/pack-schemas.js:
 *   `stars INTEGER, downloads INTEGER … forks INTEGER, citation_count INTEGER`)
 * per the V27.45 honest-contract rule ("0 = measured-zero, null = not-measured").
 * Both read paths surface that null verbatim — entity-projection emits
 * `e.downloads ?? null` etc. (src/lib/entity-projection.ts) and SSR search
 * serialises the raw DB row (src/pages/api/search.ts) with no `|| 0` coercion.
 *
 * The OpenAPI doc-contract (src/data/openapi-schema.json, 3.0.3) previously
 * promised a bare `integer`, so a strict typed client would reject the runtime
 * `null`. This guard locks the doc to the runtime: the six stats fields must be
 * `nullable` (3.0.3 style) while still typed `integer`. A regression that
 * reintroduces a non-nullable promise — re-breaking the honest contract — fails
 * here. Scope is exactly the Founder-fixed six fields.
 *
 * HONEST-CONTRACT-SYNC (G-03/G-04): two further doc⇄runtime gaps are locked here.
 *  - G-04: compare.ts emits `fni_factors.semantic: null` (V27 honesty sweep —
 *    fni_s is a query-time baseline, not a per-entity measurement). The OpenAPI
 *    CompareResponse promised a bare non-nullable `number`, so a strict client
 *    would reject the runtime null. The resolved-entity branch's semantic must be
 *    `nullable` while still typed `number`.
 *  - G-03: the real free-tier search cap is `FREE_TIER_MAX = 20`
 *    (src/pages/api/v1/search.ts), not 5. The OpenAPI `limit` param maximum must
 *    match the runtime so the contract does not under-promise the cap.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');

const STATS_PROP = (s: any) => s.components.schemas.EntityResponse
    .properties.entity.properties.stats.properties;
const SEARCH_PROP = (s: any) => s.components.schemas.SearchResponse
    .properties.results.items.properties;

describe('HK-1: OpenAPI stats fields match honest-contract runtime nullability', () => {
    it('uses the 3.0.x nullable convention (sanity: not 3.1)', () => {
        expect(schema.openapi).toMatch(/^3\.0/);
    });

    for (const field of ['downloads', 'stars', 'forks', 'citation_count']) {
        it(`EntityResponse.stats.${field} is nullable integer`, () => {
            const prop = STATS_PROP(schema)[field];
            expect(prop).toBeDefined();
            expect(prop.type).toBe('integer');
            // honest-contract: not-measured surfaces as `null`, not `0`.
            expect(prop.nullable).toBe(true);
        });
    }

    for (const field of ['downloads', 'stars']) {
        it(`SearchResponse.results.${field} is nullable integer`, () => {
            const prop = SEARCH_PROP(schema)[field];
            expect(prop).toBeDefined();
            expect(prop.type).toBe('integer');
            expect(prop.nullable).toBe(true);
        });
    }
});

describe('HONEST-CONTRACT-SYNC: OpenAPI ⇄ runtime contract consistency (G-03/G-04)', () => {
    it('G-04: CompareResponse resolved fni_factors.semantic is nullable number (matches compare.ts null emission)', () => {
        const resolved = schema.components.schemas.CompareResponse
            .properties.entities.items.oneOf[0];
        const semantic = resolved.properties.fni_factors.properties.semantic;
        expect(semantic).toBeDefined();
        // honest-contract: query-time baseline surfaces as `null`, not a measured number.
        expect(semantic.type).toBe('number');
        expect(semantic.nullable).toBe(true);
    });

    it('G-03: search `limit` param maximum matches runtime FREE_TIER_MAX (20)', () => {
        const limitParam = schema.paths['/api/v1/search'].get.parameters
            .find((p: any) => p.name === 'limit');
        expect(limitParam).toBeDefined();
        // src/pages/api/v1/search.ts: FREE_TIER_MAX = 20.
        expect(limitParam.schema.maximum).toBe(20);
        expect(limitParam.schema.minimum).toBe(1);
        // default stays 5 (search.ts: parseInt(... || '5')).
        expect(limitParam.schema.default).toBe(5);
    });
});
