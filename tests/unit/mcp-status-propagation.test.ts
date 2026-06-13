import { describe, it, expect, vi } from 'vitest';

// B4 — MCP callEntity status propagation. The MCP `free2aitools_explain` tool
// calls the internal entity endpoint. Previously it read only `data.entity` and
// reported BOTH a genuine 404 and a transient 503 as "No entity found", so a
// flaky lookup of a REAL entity trained agents to conclude it does not exist.
// We mock the entity handler to return controlled statuses and assert explain
// keeps the two distinct: 503 -> transient + retry, 404 -> genuine miss, 200 ->
// the FNI breakdown.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));

// The MCP module statically imports the entity handler; mock it so we control
// the Response (status + headers) callEntity receives.
const entityResponder = vi.fn();
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({
    GET: (...args: any[]) => entityResponder(...args),
}));
// G-05: same controlled-Response mock for the select POST handler so we can
// assert select_model maps a transient 503 into isError (and 200 stays normal).
const selectResponder = vi.fn();
vi.mock('../../src/pages/api/v1/select.js', () => ({
    POST: (...args: any[]) => selectResponder(...args),
}));
// Other internal handlers MCP imports — stub so module load does not pull real VFS.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';

function explainRequest(id: string) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'free2aitools_explain', arguments: { id } },
        }),
    });
    return { request, url };
}

async function callExplain(id: string) {
    const res = await POST(explainRequest(id) as any);
    const body = await res.json();
    return body.result;
}

describe('MCP free2aitools_explain — status propagation', () => {
    it('503 from entity endpoint -> transient + Retry-After, NOT "No entity found"', async () => {
        entityResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'Lookup inconclusive (transient/budget); retry later' }),
            { status: 503, headers: { 'Retry-After': '2' } },
        ));
        const result = await callExplain('vllm-project--vllm');
        const text = result.content[0].text;
        expect(result.isError).toBe(true);
        expect(text).toMatch(/transient|temporarily unavailable/i);
        expect(text).toMatch(/retry after 2s/i);
        // MUST NOT be conflated with a genuine miss.
        expect(text).not.toMatch(/No entity found/i);
    });

    it('503 with no Retry-After header -> falls back to a sane retry hint', async () => {
        entityResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'inconclusive' }), { status: 503 },
        ));
        const result = await callExplain('some--entity');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/retry after 2s/i);
    });

    it('404 from entity endpoint -> genuine "No entity found"', async () => {
        entityResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'Entity not found: ghost' }), { status: 404 },
        ));
        const result = await callExplain('ghost');
        const text = result.content[0].text;
        expect(text).toMatch(/No entity found matching "ghost"/i);
        // A genuine miss is NOT an error result.
        expect(result.isError).toBeUndefined();
    });

    it('200 with an entity -> FNI factor breakdown (no miss/transient text)', async () => {
        entityResponder.mockResolvedValueOnce(new Response(JSON.stringify({
            version: 'fni_v2.0',
            entity: {
                id: 'hf-model--meta-llama--llama-3-8b', name: 'Llama-3-8B', type: 'model',
                author: 'meta-llama', slug: 'meta-llama--llama-3-8b',
                fni: { score: 48.3, factors: { authority: 60, popularity: 70, recency: 50, quality: 80 } },
                links: { detail_url: 'https://free2aitools.com/models/meta-llama--llama-3-8b' },
            },
        }), { status: 200 }));
        const result = await callExplain('hf-model--meta-llama--llama-3-8b');
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.id).toBe('hf-model--meta-llama--llama-3-8b');
        expect(parsed.fni_score).toBe(48.3);
        expect(parsed.factors.A_authority).toBe(60);
        expect(result.isError).toBeUndefined();
    });
});

// G-05 — MCP callSelect status propagation. The MCP `free2aitools_select_model`
// tool calls the internal /api/v1/select POST handler, which can emit a 503 when
// the rankings DB is not yet available (missing partitions.rankings_dbs /
// pre-pipeline cold path). Previously mcp.ts read only the JSON body and
// forwarded it REGARDLESS of status, so a transient 503 was laundered into a
// normal successful tool result. We mock the select handler to return controlled
// statuses and assert select_model now keeps the two distinct: 503 -> isError +
// retry (consistent with search/compare/explain), 200 -> the unchanged payload.

function selectRequest(task: string) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'free2aitools_select_model', arguments: { task } },
        }),
    });
    return { request, url };
}

async function callSelect(task: string) {
    const res = await POST(selectRequest(task) as any);
    const body = await res.json();
    return body.result;
}

describe('MCP free2aitools_select_model — status propagation (G-05)', () => {
    it('503 from select endpoint -> transient isError + Retry-After, NOT a fake-success', async () => {
        selectResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'Rankings data not yet available. Retry after next pipeline run.' }),
            { status: 503, headers: { 'Retry-After': '5' } },
        ));
        const result = await callSelect('text-generation');
        const text = result.content[0].text;
        expect(result.isError).toBe(true);
        expect(text).toMatch(/transient|temporarily unavailable/i);
        expect(text).toMatch(/retry after 5s/i);
        // Machine-readable reason preserved.
        expect(text).toMatch(/Rankings data not yet available/i);
    });

    it('503 with no Retry-After header -> falls back to a sane retry hint', async () => {
        selectResponder.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'transient' }), { status: 503 },
        ));
        const result = await callSelect('image-classification');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/retry after 2s/i);
    });

    it('200 -> select payload returned byte-for-byte unchanged (no isError)', async () => {
        const payload = {
            version: 'fni_v2.0',
            task_interpreted: 'text-generation',
            total_candidates: 1,
            entries: [{ rank: 1, model_id: 'hf-model--meta-llama--llama-3-8b', name: 'Llama-3-8B', fni_score: 48.3 }],
            meta: { elapsed_ms: 3 },
        };
        selectResponder.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
        const result = await callSelect('text-generation');
        // Byte-for-byte: same serialization the legacy branch produced.
        expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
        expect(result.isError).toBeUndefined();
    });

    it('200 with a legitimately empty entries array is NOT an error', async () => {
        const payload = { version: 'fni_v2.0', task_interpreted: 'x', total_candidates: 0, entries: [], meta: {} };
        selectResponder.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
        const result = await callSelect('obscure-task');
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text).entries).toEqual([]);
    });
});
