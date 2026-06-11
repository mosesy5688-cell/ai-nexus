import { describe, it, expect, vi } from 'vitest';

// B8 — MCP free2aitools_search + free2aitools_rank status propagation. Both tools
// call the internal /api/search handler, which can now return an honest retryable
// 503 when a search tier exhausts its budget. Previously mcp.ts forwarded the JSON
// body verbatim, so a 503 (a body WITHOUT `results`) was relayed as a non-error
// tool result -> an agent reads a transient as "no matches" (a transient must
// never masquerade as an empty result). We mock the search handler to return
// controlled statuses and assert:
// 503 -> transient isError + retry hint (NOT thrown, NOT empty-masquerade);
// 200 (incl. a genuinely empty results array) -> JSON unchanged, no isError.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));

// MCP statically imports the search handler; mock it so we control the Response.
const searchResponder = vi.fn();
vi.mock('../../src/pages/api/search.js', () => ({ GET: (...a: any[]) => searchResponder(...a) }));
// Other internal handlers MCP imports — stub so module load does not pull real VFS.
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';

function toolReq(name: string, args: any) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { request, url };
}

async function callTool(name: string, args: any) {
    const res = await POST(toolReq(name, args) as any);
    return res.json();
}

const transient503 = () => new Response(
    JSON.stringify({ error: 'Search temporarily unavailable (transient/budget); retry later', transient: true, reason: 'cluster_fallback_budget', tier: 'cluster_fallback' }),
    { status: 503, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' } },
);

describe('MCP free2aitools_search — transient propagation', () => {
    it('503 -> isError + retry hint + reason, NOT thrown, NOT empty-masquerade', async () => {
        searchResponder.mockResolvedValueOnce(transient503());
        const body = await callTool('free2aitools_search', { query: 'rare term' });
        expect(body.error).toBeUndefined();              // NOT a JSON-RPC -32603 throw
        expect(body.result.isError).toBe(true);
        const text = body.result.content[0].text;
        expect(text).toMatch(/temporarily unavailable|transient/i);
        expect(text).toMatch(/retry after 2s/i);
        expect(text).toMatch(/cluster_fallback_budget/);
        // MUST NOT look like a clean empty result.
        expect(text).not.toMatch(/"results"\s*:\s*\[\s*\]/);
    });

    it('200 with a GENUINELY empty results array -> returned unchanged, NOT isError', async () => {
        searchResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ results: [], total_count: 0, tier: 'empty' }), { status: 200 },
        ));
        const body = await callTool('free2aitools_search', { query: 'genuinely-no-match' });
        const parsed = JSON.parse(body.result.content[0].text);
        expect(parsed.results).toEqual([]);              // a real empty IS a valid result
        expect(parsed.tier).toBe('empty');
        expect(body.result.isError).toBeUndefined();
    });

    it('200 with results -> internal _score/_dbSort/_source stripped', async () => {
        searchResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ results: [{ id: 'a', _score: 9, _dbSort: 1, _source: 'x' }], tier: 'inverted_index' }), { status: 200 },
        ));
        const body = await callTool('free2aitools_search', { query: 'llama' });
        const parsed = JSON.parse(body.result.content[0].text);
        expect(parsed.results[0]).toEqual({ id: 'a' });  // internal fields gone
        expect(body.result.isError).toBeUndefined();
    });

    it('a non-503 error status still throws -> JSON-RPC error path', async () => {
        searchResponder.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
        const body = await callTool('free2aitools_search', { query: 'x' });
        expect(body.result).toBeUndefined();
        expect(body.error.code).toBe(-32603);
        expect(body.error.message).toMatch(/HTTP 500/);
    });
});

describe('MCP free2aitools_rank — same transient propagation (rank IS keyword search)', () => {
    it('503 -> isError + retry hint, NOT empty-masquerade', async () => {
        searchResponder.mockResolvedValueOnce(transient503());
        const body = await callTool('free2aitools_rank', { query: 'text generation', task: 'coding' });
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/retry after 2s/i);
    });

    it('200 empty -> unchanged, NOT isError', async () => {
        searchResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ results: [], tier: 'empty' }), { status: 200 },
        ));
        const body = await callTool('free2aitools_rank', { query: 'nope' });
        expect(body.result.isError).toBeUndefined();
        expect(JSON.parse(body.result.content[0].text).results).toEqual([]);
    });
});
