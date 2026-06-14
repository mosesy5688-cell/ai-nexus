/**
 * P-05 — OpenAPI parity for /api/v1/concepts + /api/v1/trends/batch.
 *
 * DOC-CONTRACT GAP: both routes are LIVE (HTTP 200) and publicly advertised as
 * "Layer 0 endpoints" on /about (about.astro), but were ABSENT from
 * src/data/openapi-schema.json — so an Agent reading OpenAPI could not discover
 * them. This guard locks the doc to the runtime in two ways:
 *
 *  (1) Declaration: both paths exist in OpenAPI with the GET method, the params
 *      the handlers actually read, the caps they actually enforce, and the
 *      400/500/204 responses they actually emit.
 *
 *  (2) Conformance: the OpenAPI-declared success/error shapes match the literal
 *      shapes the handlers construct. The expected key sets below are transcribed
 *      from the handler source:
 *        - concepts: src/pages/api/v1/concepts.ts  (project() + GET body + errorResponse())
 *        - trends:   src/pages/api/v1/trends/batch.ts (GET body + errorResponse())
 *      A regression that drifts the doc from the runtime envelope fails here.
 *
 * Pure contract test — it reads the static schema and the handler-derived key
 * sets; it does not invoke the live route (no R2 / DB).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');

// --- Runtime-truth key sets, transcribed from the handler source ----------

// concepts.ts project(): the 13 keys of each concept list item.
const CONCEPT_ITEM_KEYS = [
    'id', 'slug', 'umid', 'title', 'subtitle', 'summary', 'category',
    'tags', 'author', 'word_count', 'published_at', 'updated_at', 'canonical_url',
].sort();
// concepts.ts GET 200 body: top-level keys.
const CONCEPTS_BODY_KEYS = [
    'version', 'total_count', 'limit', 'offset', 'next_offset',
    'category', 'concepts', 'meta',
].sort();
// concepts.ts errorResponse(): structured envelope keys.
const CONCEPTS_ERROR_KEYS = [
    'error', 'code', 'message', 'endpoint', 'timestamp', '_gateway_trace',
].sort();

// trends/batch.ts GET 200 body: top-level keys.
const TRENDS_BODY_KEYS = ['version', 'trends', 'missing', 'meta'].sort();
// trend-fetcher.js entry shape (trend-data-generator schema).
const TREND_ENTRY_KEYS = ['scores', 'dates', 'change7d', 'direction', 'latest'].sort();

function schemaPropKeys(s: any): string[] {
    return Object.keys(s.properties || {}).sort();
}

describe('P-05: /api/v1/concepts is declared in OpenAPI and conforms to runtime', () => {
    const path = schema.paths['/api/v1/concepts'];

    it('declares the path with GET + OPTIONS', () => {
        expect(path).toBeDefined();
        expect(path.get).toBeDefined();
        expect(path.options).toBeDefined();
    });

    it('declares the limit/offset/category params with the runtime caps', () => {
        const params: any[] = path.get.parameters;
        const byName = (n: string) => params.find((p) => p.name === n);

        // concepts.ts: Math.max(1, Math.min(200, limitRaw)), default 50.
        const limit = byName('limit');
        expect(limit.schema.minimum).toBe(1);
        expect(limit.schema.maximum).toBe(200);
        expect(limit.schema.default).toBe(50);

        // concepts.ts: Math.max(0, offsetRaw), default 0.
        const offset = byName('offset');
        expect(offset.schema.minimum).toBe(0);
        expect(offset.schema.default).toBe(0);

        // concepts.ts: CATEGORY_REGEX = /^[a-z][a-z0-9-]{0,40}$/.
        const category = byName('category');
        expect(category.required).not.toBe(true);
        expect(category.schema.pattern).toBe('^[a-z][a-z0-9-]{0,40}$');
    });

    it('declares 200 / 400 / 500 with the right schema refs (204 on OPTIONS)', () => {
        const r = path.get.responses;
        expect(r['200'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/ConceptsResponse');
        // 400 (bad category) and 500 (upstream) both use the structured envelope.
        expect(r['400'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/ConceptsError');
        expect(r['500'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/ConceptsError');
        expect(path.options.responses['204']).toBeDefined();
    });

    it('ConceptsResponse top-level shape matches the GET body keys', () => {
        const resp = schema.components.schemas.ConceptsResponse;
        expect(schemaPropKeys(resp)).toEqual(CONCEPTS_BODY_KEYS);
        // honest-contract: next_offset and category surface null verbatim.
        expect(resp.properties.next_offset.nullable).toBe(true);
        expect(resp.properties.category.nullable).toBe(true);
        // concepts is an array of Concept.
        expect(resp.properties.concepts.items.$ref)
            .toBe('#/components/schemas/Concept');
    });

    it('Concept item shape matches project() in concepts.ts', () => {
        const concept = schema.components.schemas.Concept;
        expect(schemaPropKeys(concept)).toEqual(CONCEPT_ITEM_KEYS);
        // nullable fields per project() ( ... || null ).
        for (const f of ['umid', 'subtitle', 'summary', 'category', 'author',
            'published_at', 'updated_at', 'canonical_url']) {
            expect(concept.properties[f].nullable).toBe(true);
        }
        expect(concept.properties.tags.type).toBe('array');
        expect(concept.properties.word_count.type).toBe('integer');
    });

    it('ConceptsError envelope matches errorResponse() in concepts.ts', () => {
        const err = schema.components.schemas.ConceptsError;
        expect(schemaPropKeys(err)).toEqual(CONCEPTS_ERROR_KEYS);
        expect(err.properties.error.type).toBe('boolean');
    });
});

describe('P-05: /api/v1/trends/batch is declared in OpenAPI and conforms to runtime', () => {
    const path = schema.paths['/api/v1/trends/batch'];

    it('declares the path with GET + OPTIONS', () => {
        expect(path).toBeDefined();
        expect(path.get).toBeDefined();
        expect(path.options).toBeDefined();
    });

    it('declares ids as required with the runtime cap noted (MAX_IDS = 25)', () => {
        const params: any[] = path.get.parameters;
        const ids = params.find((p) => p.name === 'ids');
        expect(ids).toBeDefined();
        expect(ids.required).toBe(true);
        // batch.ts: MAX_IDS = 25 — documented in the param/400 description.
        expect(ids.description).toMatch(/25/);
        expect(path.get.responses['400'].description).toMatch(/25/);
    });

    it('declares 200 / 400 / 500 with the right schema refs (204 on OPTIONS)', () => {
        const r = path.get.responses;
        expect(r['200'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/TrendsBatchResponse');
        // batch.ts errorResponse() emits the simple { error } envelope.
        expect(r['400'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/Error');
        expect(r['500'].content['application/json'].schema.$ref)
            .toBe('#/components/schemas/Error');
        expect(path.options.responses['204']).toBeDefined();
    });

    it('TrendsBatchResponse top-level shape matches the GET body keys', () => {
        const resp = schema.components.schemas.TrendsBatchResponse;
        expect(schemaPropKeys(resp)).toEqual(TRENDS_BODY_KEYS);
        // trends is a map of id -> TrendEntry.
        expect(resp.properties.trends.type).toBe('object');
        expect(resp.properties.trends.additionalProperties.$ref)
            .toBe('#/components/schemas/TrendEntry');
        expect(resp.properties.missing.type).toBe('array');
    });

    it('TrendEntry shape matches the trend-fetcher entry schema', () => {
        const entry = schema.components.schemas.TrendEntry;
        expect(schemaPropKeys(entry)).toEqual(TREND_ENTRY_KEYS);
        // direction enum per trend-data-generator.
        expect(entry.properties.direction.enum).toEqual(['up', 'down', 'stable']);
    });
});
