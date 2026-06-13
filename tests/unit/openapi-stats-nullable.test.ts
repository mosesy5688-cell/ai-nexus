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
 * here. Scope is exactly the Founder-fixed six fields; CompareResponse is out of
 * scope and intentionally not asserted.
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
