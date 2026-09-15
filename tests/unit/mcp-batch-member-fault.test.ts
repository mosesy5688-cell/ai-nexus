import { describe, it, expect, vi } from 'vitest';

// A faulting batch member must not destroy its SIBLINGS' responses.
//
// This is not the pre-existing null-body defect. Measured at source:
//   - mcp-guard.ts validateRpcShape(null) PASSES a null member: the id is read
//     null-safely, the depth walk does not trip, and `body?.params?.arguments`
//     is undefined, so it returns null (no shape error).
//   - the route's dispatcher then destructures the member unconditionally and
//     throws a TypeError on null.
// Before the fix these tests guard, that rejection escaped the member loop, the
// whole batch rejected, and the route 500'd -- so in [null, {"id":1,...}] the
// VALID request lost the response JSON-RPC 2.0 Sec 5 owes it. On origin/main
// that same input returned a -32601 body. A single null body loses only itself;
// a null batch MEMBER was taking someone else's answer with it. That is a
// failure mode batching would have introduced, which is why it is fixed here
// while the single-body defect below is deliberately left alone.
//
// Sec 5 on the code: -32603 is "Internal error ... Internal JSON-RPC error",
// which is what a dispatch that threw for a reason this layer did not establish
// actually is. -32600 Invalid Request is NOT used: the shape gate passed this
// member, so no shape verdict was reached, and the module deliberately leaves a
// non-Request member on the route's own -32601 rather than reclassifying it.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
// Stub every internal handler mcp.ts statically imports so module load stays
// hermetic (no VFS / R2 / DB). None of them is reached by these cases.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';

async function rpc(payload: unknown) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const res = await POST({ request, url } as any);
    return { res, text: await res.text() };
}

const alone = async (message: unknown) => (await rpc(message)).text;
const LIST_1 = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('a throwing member yields an element instead of failing the batch', () => {
    it('[null, request] -> TWO elements; the request keeps its own answer', async () => {
        const { res, text } = await rpc([null, LIST_1]);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(2);
        // The sibling's element is byte-identical to its solo body: the fault
        // is contained in slot 0 and changes nothing about slot 1.
        expect(JSON.stringify(body[1])).toBe(await alone(LIST_1));
        expect(body[1].id).toBe(1);
        expect(body[1].result.tools).toHaveLength(5);
    });

    it('the faulting member gets -32603 with the shared id normalisation', async () => {
        const { text } = await rpc([null, LIST_1]);
        const body = JSON.parse(text);
        expect(body[0]).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32603, message: 'Internal error' },
        });
        // Key order comes from the one shared rpcError(), like every other
        // element, rather than from a second envelope built here.
        expect(Object.keys(body[0])).toEqual(['jsonrpc', 'id', 'error']);
        // The exception text is not echoed to the caller.
        expect(text).not.toMatch(/TypeError|destructure|property 'id'/);
    });

    it('[null] alone -> one element, not a rejected request', async () => {
        const { res, text } = await rpc([null]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(1);
        expect(body[0].error.code).toBe(-32603);
        expect(body[0].id).toBeNull();
    });

    it('a faulting member does not swallow a NOTIFICATION sibling into an element', async () => {
        // The notification still gets no element, so the array is [fault] only.
        const { text } = await rpc([null, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].error.code).toBe(-32603);
    });

    it('the catch does not over-reach: a scalar member still gets the route -32601', async () => {
        // A scalar does NOT throw -- it reaches the route's unknown-method
        // default. If the catch ever started swallowing ordinary dispatch
        // outcomes, this element would turn into -32603 and fail here.
        const { text } = await rpc([5, LIST_1]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body[0]).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32601, message: 'Method not found: undefined' },
        });
        expect(JSON.stringify(body[1])).toBe(await alone(LIST_1));
    });

    it('a clean batch contains no -32603 at all', async () => {
        const { text } = await rpc([LIST_1, { jsonrpc: '2.0', id: 2, method: 'initialize' }]);
        expect(text).not.toContain('-32603');
        expect(JSON.parse(text)).toHaveLength(2);
    });
});

describe('N1 floor -- the single-body null path is NOT changed by the above', () => {
    it('a null SINGLE body still throws, as it does on origin/main', async () => {
        // DELIBERATE PIN, not an endorsement. The unconditional destructure on a
        // null body is a pre-existing defect with its own track; the member-loop
        // catch is scoped to batch members and must not start answering it. When
        // that track lands, THIS line is the deliberate edit point -- measured on
        // origin/main @92f894a48 and at this head: both throw a TypeError.
        await expect(rpc(null)).rejects.toThrow(TypeError);
    });

    it('a null single body is not answered -32603 by the batch catch', async () => {
        let answered: string | null = null;
        try {
            answered = (await rpc(null)).text;
        } catch { /* expected: it throws, see above */ }
        expect(answered).toBeNull();
    });
});
