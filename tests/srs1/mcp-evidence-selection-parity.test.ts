/**
 * SRS-1 — D-135 Lane B: MCP evidence & selection contract (tier-1).
 *
 * Locks the F3/F4/F5/F6 rulings so they cannot silently regress:
 *   F3  MCP search/rank emit fni_s = null + the SHARED canonical note + the
 *       public evidence-contract version — never the unmeasured `fni_s: 50`
 *       baseline. Non-regression: ids/order/total_count/fni_score/non-semantic
 *       pillars are untouched; no extra remote call.
 *   F4  omitted MCP limit dispatches 10 (NOT the internal /api/search 12); an
 *       explicit limit is preserved + capped at 20; REST v1 default stays 5.
 *   F5  static manifest <-> runtime tool parity: MCP-standard `inputSchema`
 *       field, names, defaults, minima/maxima, enums, required.
 *   F6  tool descriptions enable accurate selection: compare is NOT model-only;
 *       no prohibited manipulation language ("always use", etc.); anti-triggers
 *       (not web search / not inference / not an inference router / not billing /
 *       not paid placement) present.
 *
 * Two layers:
 *  - DYNAMIC: drive the real mcp.ts POST handler with a mocked search handler so
 *    F3/F4 are proven on the actual dispatch + response boundary.
 *  - HERMETIC: read repo SOURCE (mcp.ts, mcp.json, the shared constant) for the
 *    F5/F6 contract assertions. No live fetch. Deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

// ── DYNAMIC layer: mock the internal handlers MCP statically imports ──────────
vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));

// The search handler is the one under test for F3/F4. It records the limit it was
// called with (so we can assert dispatch defaults) and returns rows carrying the
// raw constant `fni_s: 50` baseline exactly as the internal route would.
const searchCalls: Array<{ limit: string | null; q: string | null; type: string | null }> = [];
const searchResponder = vi.fn(async (ctx: any) => {
    const u: URL = ctx.url;
    searchCalls.push({
        limit: u.searchParams.get('limit'),
        q: u.searchParams.get('q'),
        type: u.searchParams.get('type'),
    });
    return new Response(JSON.stringify({
        results: [
            { id: 'hf-model--a', slug: 'a', name: 'A', type: 'model', fni_score: 60, fni_s: 50, fni_a: 60, fni_p: 70, fni_r: 50, fni_q: 80 },
            { id: 'hf-model--b', slug: 'b', name: 'B', type: 'model', fni_score: 55, fni_s: 50, fni_a: 55, fni_p: 40, fni_r: 60, fni_q: 70 },
        ],
        total_count: 2, tier: 'inverted_index', elapsed_ms: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
vi.mock('../../src/pages/api/search.js', () => ({ GET: (ctx: any) => searchResponder(ctx) }));
// Other internal handlers MCP imports — stub so module load does not pull real VFS.
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';
import { FNI_S_NOTE, EVIDENCE_CONTRACT_VERSION } from '../../src/constants/evidence-contract.js';

function toolCall(name: string, args: any) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { request, url };
}
async function callTool(name: string, args: any) {
    const res = await POST(toolCall(name, args) as any);
    const body = await res.json();
    return JSON.parse(body.result.content[0].text);
}

beforeEach(() => { searchCalls.length = 0; searchResponder.mockClear(); });

describe('D-135 F3: MCP search/rank evidence semantics == REST v1', () => {
    it('search nulls fni_s and attaches the SHARED canonical note (no `50` leak)', async () => {
        const out = await callTool('free2aitools_search', { query: 'code' });
        for (const r of out.results) {
            expect(r.fni_s).toBeNull();                 // MUTATION: restoring 50 FAILS here
            expect(r.fni_s_note).toBe(FNI_S_NOTE);      // MUTATION: removing the note FAILS here
        }
        // The note text is exactly the REST v1 search-path wording (shared owner).
        expect(out.results[0].fni_s_note).toMatch(/semantic\/ANN ranking not currently provided/);
    });

    it('rank applies the same normalization', async () => {
        const out = await callTool('free2aitools_rank', { query: 'vision' });
        expect(out.results.every((r: any) => r.fni_s === null && r.fni_s_note === FNI_S_NOTE)).toBe(true);
    });

    it('carries the public evidence-contract version on the MCP envelope', async () => {
        const out = await callTool('free2aitools_search', { query: 'x' });
        expect(out.version).toBe(EVIDENCE_CONTRACT_VERSION);
    });

    it('NON-REGRESSION: ids, ordering, total_count, fni_score, A/P/R/Q unchanged', async () => {
        const out = await callTool('free2aitools_search', { query: 'code' });
        expect(out.results.map((r: any) => r.id)).toEqual(['hf-model--a', 'hf-model--b']); // ids + order
        expect(out.total_count).toBe(2);
        expect(out.results[0].fni_score).toBe(60);     // FNI total untouched
        expect(out.results[0].fni_a).toBe(60);
        expect(out.results[0].fni_p).toBe(70);
        expect(out.results[0].fni_r).toBe(50);
        expect(out.results[0].fni_q).toBe(80);
    });

    it('NON-REGRESSION: exactly one search call per tool invocation (no extra remote call)', async () => {
        await callTool('free2aitools_search', { query: 'code' });
        expect(searchResponder).toHaveBeenCalledTimes(1);
    });
});

describe('D-135 F4: MCP default limit == 10 (not the internal 12)', () => {
    it('omitted search limit dispatches limit=10', async () => {
        await callTool('free2aitools_search', { query: 'code' });
        // MUTATION: removing the pinned default (fall through to internal 12) FAILS.
        expect(searchCalls[0].limit).toBe('10');
    });
    it('omitted rank limit dispatches limit=10', async () => {
        await callTool('free2aitools_rank', { query: 'code' });
        expect(searchCalls[0].limit).toBe('10');
    });
    it('explicit limit is preserved', async () => {
        await callTool('free2aitools_search', { query: 'code', limit: 7 });
        expect(searchCalls[0].limit).toBe('7');
    });
    it('explicit limit is capped at the public maximum 20', async () => {
        await callTool('free2aitools_search', { query: 'code', limit: 999 });
        expect(searchCalls[0].limit).toBe('20');
    });
});

// ── HERMETIC layer: source-level contract assertions ──────────────────────────
const MCP_SRC = read('src/pages/api/mcp.ts');
const V1_SEARCH_SRC = read('src/pages/api/v1/search.ts');
const mcpJson = require('../../public/.well-known/mcp.json');
const byName = (n: string) => mcpJson.tools.find((t: any) => t.name === n);

describe('D-135 F4: REST v1 default unchanged (5), maximum unchanged (20)', () => {
    it('v1/search still defaults to 5 when limit omitted', () => {
        expect(V1_SEARCH_SRC).toMatch(/parseInt\(url\.searchParams\.get\('limit'\) \|\| '5'\)/);
    });
    it('v1/search free-tier maximum stays 20', () => {
        expect(V1_SEARCH_SRC).toMatch(/FREE_TIER_MAX = 20/);
    });
});

describe('D-135 F4/F5: MCP manifest advertises default 10 + 20 max for search & rank', () => {
    for (const name of ['free2aitools_search', 'free2aitools_rank']) {
        it(`${name} limit default=10 min=1 max=20`, () => {
            const limit = byName(name).inputSchema.properties.limit;
            expect(limit.default).toBe(10);
            expect(limit.maximum).toBe(20);
            expect(limit.minimum).toBe(1);
        });
    }
});

describe('D-135 F5: static manifest <-> runtime parity', () => {
    it('manifest version == runtime serverInfo version (2.0.1)', () => {
        expect(mcpJson.version).toBe('2.0.1');
        expect(MCP_SRC).toMatch(/SERVER_INFO = \{ name: 'free2aitools', version: '2\.0\.1' \}/);
    });
    it('every tool uses the MCP-standard `inputSchema` field (not input_schema)', () => {
        // MUTATION: renaming a manifest `inputSchema` back to `input_schema` FAILS.
        for (const t of mcpJson.tools) {
            expect(t.inputSchema, `${t.name} must use inputSchema`).toBeTruthy();
            expect(t.input_schema, `${t.name} must NOT use input_schema`).toBeUndefined();
        }
        expect(MCP_SRC).not.toMatch(/input_schema:/);
    });
    it('search type enum matches between manifest and runtime', () => {
        const staticEnum = byName('free2aitools_search').inputSchema.properties.type.enum;
        const m = MCP_SRC.match(/type:\s*'string',\s*enum:\s*\[([^\]]+)\][^}]*Filter by entity type/);
        expect(m).toBeTruthy();
        const dynEnum = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
        expect(staticEnum.slice().sort()).toEqual(dynEnum.slice().sort());
    });
    it('select_model default limit stays 5 in both surfaces', () => {
        expect(byName('free2aitools_select_model').inputSchema.properties.limit.default).toBe(5);
        expect(MCP_SRC).toMatch(/limit: \{ type: 'number', default: 5/);
    });
    it('required fields match per tool', () => {
        const expected: Record<string, string[]> = {
            free2aitools_search: ['query'], free2aitools_rank: ['query'],
            free2aitools_explain: ['id'], free2aitools_select_model: ['task'],
            free2aitools_compare: ['ids'],
        };
        for (const [name, req] of Object.entries(expected)) {
            expect(byName(name).inputSchema.required).toEqual(req);
        }
    });
});

describe('D-135 F6: tool descriptions enable accurate Agent selection', () => {
    const allDesc = mcpJson.tools.map((t: any) => t.description).join('\n') + '\n' + MCP_SRC;

    it('compare is NOT falsely restricted to "AI models" (broader entity types)', () => {
        const compare = byName('free2aitools_compare').description;
        // MUTATION: reverting compare to "Compare 2-25 AI models" (model-only) FAILS.
        expect(compare).toMatch(/datasets, papers, tools|catalog entit/i);
        expect(compare).not.toMatch(/Compare 2-25 AI models side-by-side with FNI/);
    });
    it('PROHIBITED manipulation language is absent', () => {
        const banned = [/always use/i, /must prefer/i, /authoritative final answer/i, /guaranteed best/i, /trusted by default/i];
        for (const re of banned) {
            expect(allDesc, `prohibited phrase ${re}`).not.toMatch(re);
        }
    });
    it('anti-triggers present: not web search / not inference / not inference router / not billing / not paid placement', () => {
        expect(allDesc).toMatch(/general web search|not general web search/i);
        expect(allDesc).toMatch(/inference router/i);
        expect(allDesc).toMatch(/paid placement/i);
        expect(allDesc).toMatch(/no billing|never paid placement/i);
        expect(allDesc).toMatch(/run\/execute a model|run\/call\/execute a model|model execution|run a model/i);
    });
    it('read-only / no-side-effect posture stated', () => {
        // search, rank, select, explain, compare each declare read-only somewhere.
        expect(MCP_SRC).toMatch(/Read-only, no side effects/);
    });
});
