import { describe, it, expect, vi } from 'vitest';

// B7 — MCP free2aitools_compare status propagation. The compare tool calls the
// internal /api/v1/compare handler, which can now return an honest retryable 503
// when a cold multi-paper fan-out exhausts its wall-clock budget / fan-out cap.
// Previously mcp.ts did `if (!res.ok) throw` -> a generic JSON-RPC -32603 error
// (or a dead connection before the budget existed). We mock the compare handler
// to return controlled statuses and assert: 503 -> transient isError + retry hint
// (NOT a thrown error), 200 -> the comparison JSON unchanged.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));

// MCP statically imports the compare handler; mock it so we control the Response.
const compareResponder = vi.fn();
vi.mock('../../src/pages/api/v1/compare.js', () => ({
    GET: (...args: any[]) => compareResponder(...args),
}));
// Other internal handlers MCP imports — stub so module load does not pull real VFS.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';

function compareRequest(ids: string[]) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: 'free2aitools_compare', arguments: { ids } },
        }),
    });
    return { request, url };
}

async function callCompareTool(ids: string[]) {
    const res = await POST(compareRequest(ids) as any);
    return res.json();
}

describe('MCP free2aitools_compare — status propagation', () => {
    it('503 from compare endpoint -> transient isError + retry hint, NOT a thrown JSON-RPC error', async () => {
        compareResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({
                error: 'Comparison inconclusive (transient/budget); retry later',
                resolved: ['a'], pending: ['2604.22294', '2604.99999'], reason: 'budget',
            }),
            { status: 503, headers: { 'Retry-After': '2' } },
        ));
        const body = await callCompareTool(['a', '2604.22294', '2604.99999']);
        // MUST be a successful JSON-RPC result (NOT error: -32603) carrying isError.
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
        const text = body.result.content[0].text;
        expect(text).toMatch(/transient|temporarily unavailable/i);
        expect(text).toMatch(/retry after 2s/i);
        // Honest partial signal: the pending ids surface so an agent retries only them.
        expect(text).toMatch(/2604\.22294/);
    });

    it('503 with no Retry-After -> sane default retry hint', async () => {
        compareResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'inconclusive', resolved: [], pending: ['x', 'y'] }),
            { status: 503 },
        ));
        const body = await callCompareTool(['x', 'y']);
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/retry after 2s/i);
    });

    it('200 -> comparison JSON unchanged (envelope shape preserved, no isError)', async () => {
        const payload = {
            version: 'fni_v2.0',
            entities: [{ id: 'a', found: true }, { id: 'b', found: true }],
            meta: { elapsed_ms: 12, found: 2, requested: 2 },
        };
        compareResponder.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
        const body = await callCompareTool(['a', 'b']);
        const parsed = JSON.parse(body.result.content[0].text);
        expect(parsed.version).toBe('fni_v2.0');
        expect(parsed.entities).toHaveLength(2);
        expect(body.result.isError).toBeUndefined();
    });

    it('non-503 error status still throws -> reported via JSON-RPC error path', async () => {
        compareResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'Internal error' }), { status: 500 },
        ));
        const body = await callCompareTool(['a', 'b']);
        // mcp.ts catch -> -32603 with the HTTP-status message.
        expect(body.result).toBeUndefined();
        expect(body.error.code).toBe(-32603);
        expect(body.error.message).toMatch(/HTTP 500/);
    });
});
