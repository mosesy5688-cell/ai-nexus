/**
 * SRS-1 -- P3-CONTRACT-1 machine-contract parity invariants (tier-1, hermetic).
 *
 * Locks the served MACHINE CONTRACTS (OpenAPI prose+schema, MCP static manifest)
 * against the CURRENTLY-IMPLEMENTED public runtime: drift in either direction fails.
 *   DJ-R05 (T1) search result-limit parity (prose + schema + runtime all == 20).
 *   DJ-R06 (T2) SearchResponse schema == runtime-derived public-v1 200 field set.
 *   DJ-R10 (T3) pagination contract: documented params == handler acceptance.
 *   DJ-R11 (A2) SERVED /api/v1/search description (openapi.json.ts transform OUTPUT)
 *               carries pagination + consistency caveat; see D-42.
 *   DJ-M02 (T4) MCP static enum parity. DJ-W05 (T5) EntityResponse id/canonical_id.
 *   T-NONEXP    no capability expansion: tool count / endpoint set unchanged.
 *
 * Reads repo SOURCE + parses static JSON; A2 invokes the openapi.json.ts route GET
 * (cloudflare:workers mocked in vitest.config). No live fetch. Deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GET as OPENAPI_GET } from '../../src/pages/openapi.json.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');
const mcpJson = require('../../public/.well-known/mcp.json');

const SEARCH_SRC = read('src/pages/api/search.ts');
const V1_SEARCH_SRC = read('src/pages/api/v1/search.ts');
const MCP_SRC = read('src/pages/api/mcp.ts');
const OPENAPI_ROUTE_SRC = read('src/pages/openapi.json.ts');
const PROJECTION_SRC = read('src/lib/entity-projection.ts');

const SEARCH_PATH = schema.paths['/api/v1/search'].get;
const SEARCH_ITEM = schema.components.schemas.SearchResponse.properties.results.items.properties;
const SEARCH_RESP = schema.components.schemas.SearchResponse.properties;
const ENTITY = schema.components.schemas.EntityResponse.properties.entity;
// A2 helper: the ACTUAL served /api/v1/search description (openapi.json.ts transform output).
let _servedDesc: string | null = null;
async function servedSearchDescription(): Promise<string> {
    if (_servedDesc != null) return _servedDesc;
    const res = await (OPENAPI_GET as any)({ request: new Request('https://x/openapi.json') });
    const body = JSON.parse(await res.text());
    _servedDesc = body?.paths?.['/api/v1/search']?.get?.description ?? '';
    return _servedDesc!;
}
// T2 helper: derive the EXACT public-v1 200 field set from runtime SOURCE (DISPLAY_COLS aliases).
function displayColFields(): string[] {
    const m = SEARCH_SRC.match(/const DISPLAY_COLS = `([^`]+)`/);
    expect(m, 'search.ts must declare DISPLAY_COLS').toBeTruthy();
    return m![1].split(',').map((c) => c.trim().replace(/^e\./, '')).filter(Boolean);
}
const RESPOND_TOP = ['results', 'total_count', 'tier', 'elapsed_ms']; // respond() top-level envelope keys
describe('SRS-1 DJ-R05 (T1): search result-limit prose <-> schema <-> runtime == 20', () => {
    it('runtime FREE_TIER_MAX == 20 (v1/search.ts)', () => {
        const m = V1_SEARCH_SRC.match(/const FREE_TIER_MAX = (\d+)/);
        expect(m).toBeTruthy();
        expect(Number(m![1])).toBe(20);
    });
    it('OpenAPI schema limit.maximum == 20', () => {
        const limit = SEARCH_PATH.parameters.find((p: any) => p.name === 'limit');
        expect(limit.schema.maximum).toBe(20);
    });
    it('dynamic openapi.json.ts per-request cap "up to 20 results per request" in BOTH branches; no 5; no tier', () => {
        // D-123: per-request wording replaced tier framing in both no-count + count branches.
        const matches = OPENAPI_ROUTE_SRC.match(/Returns up to (\d+) results per request\./g) || [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
        for (const phrase of matches) expect(phrase).toBe('Returns up to 20 results per request.');
        expect(OPENAPI_ROUTE_SRC).not.toMatch(/returns up to 5 results/i);
        expect(OPENAPI_ROUTE_SRC).not.toMatch(/free tier/i); // D-123 negative
    });
    it('static schema search description + limit param state the per-request cap of 20; no 5; no tier', () => {
        expect(SEARCH_PATH.description).toMatch(/Returns up to 20 results per request\./);
        expect(SEARCH_PATH.description).not.toMatch(/up to 5 results/);
        expect(SEARCH_PATH.description).not.toMatch(/free tier/i); // D-123 negative
        const limit = SEARCH_PATH.parameters.find((p: any) => p.name === 'limit');
        expect(limit.description).toMatch(/Maximum results per request \(capped at 20\)/);
        expect(limit.description).not.toMatch(/free tier/i);
    });
});
describe('SRS-1 DJ-R06 (T2): SearchResponse schema == actual public-v1 response field set', () => {
    // RESULT-ITEM set from runtime source (non-circular): DISPLAY_COLS + fni_s_note; fni_s nulled.
    const expectedItemFields = (() => {
        const cols = displayColFields();
        expect(cols).toContain('fni_s'); // v1 wrapper nulls this in place
        const set = new Set(cols);
        // v1/search.ts adds fni_s_note via the shared normalizeSearchEvidence owner (D-135 F3, REST v1 <-> MCP).
        expect(V1_SEARCH_SRC).toMatch(/normalizeSearchEvidence\(r\)/);
        set.add('fni_s_note');
        return [...set].sort();
    })();
    it('declared item fields EXACTLY equal the runtime-derived set (no missing, no extra)', () => {
        const declared = Object.keys(SEARCH_ITEM).sort();
        expect(declared).toEqual(expectedItemFields);
    });
    it('top-level fields == respond() envelope + v1 `version` (always-present on 200)', () => {
        expect(V1_SEARCH_SRC).toMatch(/version: API_VERSION, \.\.\.body/); // v1 wraps { version, ...body }
        const expectedTop = [...RESPOND_TOP, 'version'].sort();
        expect(Object.keys(SEARCH_RESP).sort()).toEqual(expectedTop);
    });
    it('NO internal/underscore-prefixed field is declared in the public schema', () => {
        expect(V1_SEARCH_SRC).toMatch(/delete r\._dbSort; delete r\._score; delete r\._source/); // stripped pre-serialize
        for (const k of [...Object.keys(SEARCH_ITEM), ...Object.keys(SEARCH_RESP)]) {
            expect(k.startsWith('_')).toBe(false);
        }
    });
    it('nullability annotations present: stats/string fields nullable; fni_s null+note', () => {
        for (const f of ['stars', 'downloads', 'last_modified', 'license', 'pipeline_tag', 'author', 'summary']) {
            expect(SEARCH_ITEM[f].nullable, `${f} must be nullable`).toBe(true);
        }
        expect(SEARCH_ITEM.fni_s.nullable).toBe(true); // nulled by v1 wrapper -> nullable + note
        expect(SEARCH_ITEM.fni_s_note.type).toBe('string');
    });
    it('total_count declared as integer + marked required (respond() always emits it)', () => {
        expect(SEARCH_ITEM.fni_s).toBeDefined();
        expect(SEARCH_RESP.total_count.type).toBe('integer');
        expect(schema.components.schemas.SearchResponse.required).toContain('total_count');
    });
});
describe('SRS-1 DJ-R10 (T3): pagination contract -- documented params <-> handler', () => {
    const declaredParams = SEARCH_PATH.parameters.map((p: any) => p.name).sort();
    it('OpenAPI declares q,type,limit,page (the handler-accepted search params)', () => {
        expect(declaredParams).toEqual(['limit', 'page', 'q', 'type']);
    });
    it('search.ts reads each declared param from searchParams', () => {
        for (const p of ['q', 'type', 'limit', 'page']) {
            expect(SEARCH_SRC, `handler must read ${p}`).toMatch(
                new RegExp(`searchParams\\.get\\('${p}'\\)`),
            );
        }
    });
    it('page param: 1-based, default 1, minimum 1 (matches search.ts Math.max(...,1))', () => {
        const page = SEARCH_PATH.parameters.find((p: any) => p.name === 'page');
        expect(page.schema.minimum).toBe(1);
        expect(page.schema.default).toBe(1);
        expect(SEARCH_SRC).toMatch(/Math\.max\(parseInt\(url\.searchParams\.get\('page'\) \|\| '1'\), 1\)/);
        expect(page.description).toMatch(/offset = \(page-1\)\*limit/);
        expect(SEARCH_SRC).toMatch(/const offset = \(page - 1\) \* limit/); // (page-1)*limit in handler
    });
});
// A2 / D-42: the served /api/v1/search description is produced by the openapi.json.ts
// TRANSFORM, which OVERWRITES the static path description; assert on its OUTPUT (the
// deployed bug proved the static-only caveat is discarded and never served).
describe('SRS-1 DJ-R11 (A2): SERVED /api/v1/search description projection (openapi.json.ts owner)', () => {
    let served = '';
    beforeAll(async () => { served = await servedSearchDescription(); });
    it('T-A3-1 served pagination: 1-based page + default 1 + (page - 1) * limit + total_count', () => {
        expect(served).toMatch(/Pagination is 1-based via `page`/);
        expect(served).toMatch(/default page is 1/);
        expect(served).toMatch(/offset = \(page - 1\) \* limit/);
        expect(served).toMatch(/`total_count` in the response supports client-side page calculation/);
    });
    it('T-A3-2 served caveat: refresh + no cursor + no snapshot consistency', () => {
        expect(served).toMatch(/Results may change between requests as the dataset is refreshed/);
        expect(served).toMatch(/does not provide cursor or snapshot consistency/);
    });
    it('T-A3-3 preservation: catalog purpose + per-request cap 20 + transient note; no "up to 5"; no tier', () => {
        expect(served).toMatch(/Full-text search across the Free2AITools catalog/);
        expect(served).toMatch(/Returns up to 20 results per request\./);
        expect(served).toMatch(/retryable transient 503 under cold-path or fallback budget limits/);
        expect(served).not.toMatch(/up to 5 results/);
        expect(served).not.toMatch(/free tier/i); // D-123 negative
    });
    it('T-A3-4 projection-owner regression: caveat survives transform (FAILS vs static-only bug)', async () => {
        // Deployed-bug projection: cap + transient note but NO caveat. NEUTRAL per-request wording (D-123).
        const buggyServed = 'Full-text search across the Free2AITools catalog of AI models, tools, datasets, papers, and benchmarks, ranked by FNI score. Returns up to 20 results per request. Search may return a retryable transient 503; retry according to Retry-After.';
        expect(buggyServed).not.toMatch(/does not provide cursor or snapshot consistency/);
        const actual = await servedSearchDescription();
        expect(actual).toMatch(/does not provide cursor or snapshot consistency/);
        expect(actual).toMatch(/Pagination is 1-based via `page`/);
        expect(actual).not.toBe(buggyServed); // served owner genuinely exercised
    });
    it('T-A3-5 no unrelated change: params, response schemas, MCP, path count, endpoint set', () => {
        expect(SEARCH_PATH.parameters.map((p: any) => p.name).sort()).toEqual(['limit', 'page', 'q', 'type']);
        expect(Object.keys(SEARCH_RESP).sort()).toEqual([...RESPOND_TOP, 'version'].sort());
        expect(ENTITY.properties.id).toBeDefined();
        expect(ENTITY.properties.canonical_id).toBeDefined();
        expect(mcpJson.tools.length).toBe(5);
        const paths = Object.keys(schema.paths);
        expect(paths.length).toBe(10);
        expect(paths).toContain('/api/v1/search');
        expect(paths).toContain('/api/mcp');
    });
});
describe('SRS-1 DJ-M02 (T4): MCP static enum <-> dynamic handler enum parity', () => {
    // Dynamic enum: parse the search tool inputSchema `type` enum out of mcp.ts source.
    function handlerSearchTypeEnum(): string[] {
        const m = MCP_SRC.match(/type:\s*'string',\s*enum:\s*\[([^\]]+)\][^}]*Filter by entity type/);
        expect(m, 'mcp.ts search inputSchema must declare a type enum').toBeTruthy();
        return m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    }
    function staticSearchTypeEnum(): string[] {
        const tool = mcpJson.tools.find((t: any) => t.name === 'free2aitools_search');
        return tool.inputSchema.properties.type.enum; // D-135 (F5): MCP-standard inputSchema (was input_schema)
    }
    it('static mcp.json search type enum == dynamic mcp.ts enum (set parity)', () => {
        expect(staticSearchTypeEnum().slice().sort()).toEqual(handlerSearchTypeEnum().slice().sort());
    });
    it('benchmark is in BOTH enums (served entity type)', () => {
        expect(staticSearchTypeEnum()).toContain('benchmark');
        expect(handlerSearchTypeEnum()).toContain('benchmark');
    });
    it('benchmark is a served entity type per OpenAPI (type list + search type param enum)', () => {
        expect(ENTITY.properties.type.description).toMatch(/benchmark/);
        const typeParam = SEARCH_PATH.parameters.find((p: any) => p.name === 'type');
        expect(typeParam.schema.enum).toContain('benchmark');
    });
});
describe('SRS-1 DJ-W05 (T5): EntityResponse identity contract', () => {
    it('declares both id and canonical_id', () => {
        expect(ENTITY.properties.id).toBeDefined();
        expect(ENTITY.properties.canonical_id).toBeDefined();
        expect(ENTITY.properties.canonical_id.type).toBe('string');
    });
    it('canonical_id is required + non-null (projected from required id: canonical_id == e.id)', () => {
        expect(ENTITY.required).toContain('id');
        expect(ENTITY.required).toContain('canonical_id');
        expect(ENTITY.properties.canonical_id.nullable).not.toBe(true);
        // entity-projection.ts: canonical_id: e.id (same-value semantics).
        expect(PROJECTION_SRC).toMatch(/canonical_id: e\.id/);
    });
    it('NO top-level umid declared (runtime does not emit it)', () => {
        expect(ENTITY.properties.umid).toBeUndefined();
    });
    it('contract states canonical_id == id (same value), NOT "id is umid"', () => {
        expect(ENTITY.properties.canonical_id.description).toMatch(/same canonical identifier value as `id`|canonical_id == id/);
        const idDesc = (ENTITY.properties.id.description || '').toLowerCase();
        const cidDesc = (ENTITY.properties.canonical_id.description || '').toLowerCase();
        // No machine-contract equivalence asserting id IS the umid.
        expect(idDesc).not.toMatch(/is your umid|id is the umid|id == umid/);
        expect(cidDesc).not.toMatch(/id is your umid|id is the umid|id == umid/);
    });
});
describe('SRS-1 T-NONEXP: no capability expansion (counts/endpoints unchanged)', () => {
    it('MCP still advertises exactly 5 tools (static + dynamic)', () => {
        expect(mcpJson.tools.length).toBe(5);
        const dynNames = [...MCP_SRC.matchAll(/name:\s*'(free2aitools_[a-z_]+)'/g)].map((m) => m[1]);
        expect([...new Set(dynNames)].length).toBe(5);
    });
    it('OpenAPI path set unchanged: exactly the 10 declared endpoints', () => {
        // 9 /api/v1/* + /api/mcp. Lock the count so a contract-only PR cannot
        // silently add/remove an endpoint.
        const paths = Object.keys(schema.paths).sort();
        expect(paths).toContain('/api/v1/search');
        expect(paths).toContain('/api/mcp');
        expect(paths.length).toBe(10);
    });
});
