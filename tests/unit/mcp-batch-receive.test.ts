import { describe, it, expect, vi } from 'vitest';

// MCP batch RECEIVE -- JSON-RPC 2.0 Sec 6 over MCP Streamable HTTP 2025-03-26.
//
// MCP spec 2025-03-26, /basic/index Sec Batching: "MCP implementations MAY
// support sending JSON-RPC batches, but MUST support receiving JSON-RPC
// batches." This server advertises protocolVersion 2025-03-26 in its own
// initialize response, so receiving is a MUST it did not meet: before this
// change an array body -- measured for all-notification, mixed, all-request
// and empty -- returned HTTP 200 {"jsonrpc":"2.0","id":null,"error":{"code":
// -32601,"message":"Method not found: undefined"}}, because the route
// destructured `method` off an Array. That is this file's discriminating
// power: run it against origin/main and 14 of the 16 cases fail on that
// -32601. The 2 that pass are the single-message floor in the last describe,
// which asserts what must NOT change.
//
// The Sec 6 clauses relied on, quoted from https://www.jsonrpc.org/specification:
//   "A Response object SHOULD exist for each Request object, except" ...
//   "there SHOULD NOT be any Response objects for notifications"
//   "the server MUST NOT return an empty Array and should return nothing at all"
//   "If the batch rpc call itself fails to be recognized as an valid JSON or as
//    an Array with at least one value," ... "the response from the Server MUST
//    be a single Response object"  (the section's worked example answers [] with
//    error -32600 "Invalid Request" and id null -- pinned in A4 below).
//
// Sending batches is NOT implemented (Sec Batching makes that a MAY).

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
// Stub every internal handler mcp.ts statically imports so module load stays
// hermetic (no VFS / R2 / DB). No case below reaches a real data path.
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

// The exact bytes a message gets when POSTed on its own. R2 requires a batch
// member's element to be these same bytes, so every parity assertion below
// measures against a live single-send rather than against a literal.
const alone = async (message: unknown) => (await rpc(message)).text;

const NOTIFY = { jsonrpc: '2.0', method: 'notifications/initialized' };
const NOTIFY_2 = { jsonrpc: '2.0', method: 'notifications/progress' };
const LIST_42 = { jsonrpc: '2.0', id: 42, method: 'tools/list' };
const INIT_1 = { jsonrpc: '2.0', id: 1, method: 'initialize' };
const UNKNOWN_9 = { jsonrpc: '2.0', id: 9, method: 'unknown/method' };
const BAD_TOOL_3 = {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'nope', arguments: {} },
};

describe('A1 -- an all-notification batch is accepted with 202 and no body', () => {
    it('two notification members -> 202, empty body, no Content-Type', async () => {
        // Sec 6: with no Response objects to send, "the server MUST NOT return an
        // empty Array and should return nothing at all". Over Streamable HTTP that
        // is the 202 MCP already mandates for input consisting solely of responses
        // or notifications -- the same shape a single notification gets.
        const { res, text } = await rpc([NOTIFY, NOTIFY_2]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|Method not found/);
        // A bodiless response must not claim to carry JSON.
        expect(res.headers.get('content-type')).toBeNull();
        // CORS is still advertised, as on the single-notification 202.
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('the 202 shape matches the single-notification 202 it reuses', async () => {
        const single = await rpc(NOTIFY);
        const batch = await rpc([NOTIFY]);
        expect(batch.res.status).toBe(single.res.status);
        expect(batch.text).toBe(single.text);
        expect(batch.res.headers.get('content-type'))
            .toBe(single.res.headers.get('content-type'));
    });

    it('id-less members of ANY method are notifications here too', async () => {
        // The id-absence rule is the whole test, exactly as for a single message.
        const { res, text } = await rpc([
            { jsonrpc: '2.0', method: 'initialize' },
            { jsonrpc: '2.0', method: 'tools/list' },
            { jsonrpc: '2.0', method: 'unknown/method' },
        ]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
    });
});

describe('A2 -- a mixed batch answers the requests and stays silent on the rest', () => {
    it('[notification, request] -> an ARRAY of exactly one element, id 42', async () => {
        const { res, text } = await rpc([NOTIFY, LIST_42]);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(true);
        // "there SHOULD NOT be any Response objects for notifications"
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe(42);
        expect(body[0].jsonrpc).toBe('2.0');
        expect(body[0].result.tools).toHaveLength(5);
    });

    it('R2 -- that element is byte-identical to the same request sent alone', async () => {
        const { text } = await rpc([NOTIFY, LIST_42]);
        expect(text).toBe(`[${await alone(LIST_42)}]`);
    });

    it('a notification member is not answered even in an erroring batch', async () => {
        const { text } = await rpc([NOTIFY, UNKNOWN_9, NOTIFY_2]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].error.code).toBe(-32601);
        expect(body[0].id).toBe(9);
    });
});

describe('A3 -- an all-request batch answers every member, one for one', () => {
    it('three requests -> three elements with the ids in order', async () => {
        const { res, text } = await rpc([INIT_1, LIST_42, UNKNOWN_9]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(3);
        expect(body.map((r: any) => r.id)).toEqual([1, 42, 9]);
    });

    it('R2 -- the whole array is the members\' solo bodies spliced in order', async () => {
        // Not "equivalent JSON": the exact bytes, concatenated. This is what makes
        // -32601 / -32603 / id echo / id:null normalisation identical by
        // construction rather than by a second implementation.
        const members = [INIT_1, LIST_42, UNKNOWN_9, BAD_TOOL_3];
        const solo = [];
        for (const m of members) solo.push(await alone(m));
        const { text } = await rpc(members);
        expect(text).toBe(`[${solo.join(',')}]`);
    });

    it('R2 -- -32603 from inside tools/call survives as its own element', async () => {
        const { text } = await rpc([BAD_TOOL_3]);
        expect(JSON.parse(text)).toEqual([
            { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Unknown tool: nope' } },
        ]);
    });

    it('R2 -- an explicit null id is a member, answered with id null', async () => {
        // {"id":null} HAS the id member, so it is a request, not a notification --
        // the same `in`-based membership test the single path uses.
        const member = { jsonrpc: '2.0', id: null, method: 'notifications/xyz' };
        const { res, text } = await rpc([member]);
        expect(res.status).not.toBe(202);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].id).toBeNull();
        expect(body[0].error.code).toBe(-32601);
        expect(text).toBe(`[${await alone(member)}]`);
    });

    it('R2 -- an id of 0 survives normalisation inside a batch', async () => {
        const { text } = await rpc([{ jsonrpc: '2.0', id: 0, method: 'unknown/method' }]);
        expect(JSON.parse(text)[0].id).toBe(0);
    });
});

describe('A4 -- an empty array is answered per Sec 6, not with an empty array', () => {
    it('[] -> a SINGLE Response object: -32600 Invalid Request, id null', async () => {
        // "If the batch rpc call itself fails to be recognized as an valid JSON or
        // as an Array with at least one value," ... "the response from the Server
        // MUST be a single Response object". Sec 6's worked example answers [] with
        // code -32600 "Invalid Request" and id null.
        const { res, text } = await rpc([]);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(false);
        expect(body).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32600, message: 'Invalid Request' },
        });
    });
});

describe('G2 -- the size/shape gate binds each member as it binds a lone message', () => {
    it('an over-cap ids[] is rejected per member, not smuggled in by batching', async () => {
        // The route-level G2 sees the ARRAY, whose params is undefined, so it has
        // nothing to check. Without a per-member re-run, a batch member could carry
        // an ids[] far over MAX_IDS_ITEMS=25 that the same message could not carry
        // alone, and the compare fan-out would honour it.
        const member = {
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: {
                name: 'free2aitools_compare',
                arguments: { ids: Array.from({ length: 26 }, (_, i) => `id-${i}`) },
            },
        };
        const { text } = await rpc([member]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].error.code).toBe(-32001);
        expect(body[0].error.data).toEqual({ limit: 'max_ids_items', max: 25 });
        // Byte parity with the same message sent alone.
        expect(text).toBe(`[${await alone(member)}]`);
    });

    it('a clean member in the same batch is still served', async () => {
        const bad = {
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: { name: 'free2aitools_explain', arguments: { id: 'x'.repeat(257) } },
        };
        const { text } = await rpc([bad, UNKNOWN_9]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body[0].error.code).toBe(-32001);
        expect(body[1].error.code).toBe(-32601);
        expect(body[1].id).toBe(9);
    });
});

describe('single-message bodies are untouched by the batch path', () => {
    it('a non-array body never reaches the batch branch', async () => {
        // N1 floor in this file (the byte digests live in
        // mcp-notification-and-error-id.test.ts): a lone request is still a lone
        // object response, never wrapped in an array.
        const { res, text } = await rpc(LIST_42);
        expect(res.status).toBe(200);
        expect(text.startsWith('[')).toBe(false);
        expect(JSON.parse(text).id).toBe(42);
    });

    it('a scalar body is still the -32601 it was, not a batch', async () => {
        const { res, text } = await rpc(5);
        expect(res.status).toBe(200);
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32601, message: 'Method not found: undefined' },
        });
    });
});
