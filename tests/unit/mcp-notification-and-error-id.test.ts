import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// MCP JSON-RPC conformance -- BRANCHES 2 and 3 of the notification rule, plus
// the error-body id shape. Branch 1 (id-less input -> 202) is pinned in
// mcp-notification-202.test.ts.
//
//   branch 2  id present AND a notifications/* method -> -32601, id echoed.
//   branch 3  id present, any other method -> byte-identical to before this PR.
//
// An id-BEARING message is never a notification: Sec 4.1 defines a Notification
// as "a Request object without an "id" member", and Sec 5 says "the Server MUST
// reply with a Response, except for in the case of Notifications".
//
// F2, fixed here: error bodies could omit `id` entirely. jsonrpcError fed a
// possibly-undefined id straight to JSON.stringify, which DROPS it, while the
// guard layer emitted id:null -- so the two layers disagreed on error shape.
// Sec 5: the id member "is REQUIRED ... If there was an error in detecting the
// id in the Request object ... it MUST be Null."
//
// The branch-3 regression floor is a byte-exact digest captured from origin/main
// @6dbcddaf2ac9541dd01d4c4a4fe4c11e649d4bc9 BEFORE the fix. Those digests are
// for ID-BEARING initialize / tools/list calls, which branch 3 leaves untouched.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
// Stub every internal handler mcp.ts statically imports so module load stays
// hermetic (no VFS / R2 / DB). None of them is reached by these cases.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';

// Byte-exact pre-change baseline (origin/main 6dbcddaf2). Frozen on purpose.
const BASELINE = {
    initialize: { bytes: 515, sha256: '8248f99756ea14710bf1447ba53c91fa4e2e53be3b22e772be73a17f5e3bba70' },
    toolsList: { bytes: 7771, sha256: '805ea749c04ba347ad3ee81db223fb5edfa856d32bd2841b67aab99a805d726f' },
};

async function rpc(payload: unknown) {
    const url = new URL('https://free2aitools.com/api/mcp');
    const request = new Request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const res = await POST({ request, url } as any);
    const text = await res.text();
    return { res, text, sha256: createHash('sha256').update(text).digest('hex') };
}

describe('A1(a) -- branch 3: id-bearing calls stay byte-identical to origin/main', () => {
    it('initialize WITH an id is byte-for-byte unchanged', async () => {
        const { res, text, sha256 } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        expect(res.status).toBe(200);
        expect(Buffer.byteLength(text)).toBe(BASELINE.initialize.bytes);
        expect(sha256).toBe(BASELINE.initialize.sha256);
        // N3 spot-check: the advertised transport version governs the 202 rule.
        expect(JSON.parse(text).result.protocolVersion).toBe('2025-03-26');
    });

    it('tools/list WITH an id is byte-for-byte unchanged', async () => {
        const { res, text, sha256 } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(200);
        expect(Buffer.byteLength(text)).toBe(BASELINE.toolsList.bytes);
        expect(sha256).toBe(BASELINE.toolsList.sha256);
        // N1: still exactly the five advertised tools, same names, same order.
        expect(JSON.parse(text).result.tools.map((t: any) => t.name)).toEqual([
            'free2aitools_search', 'free2aitools_rank', 'free2aitools_explain',
            'free2aitools_select_model', 'free2aitools_compare',
        ]);
    });

    it('tools/call WITH an id still reaches the tool dispatcher', async () => {
        // Unknown tool name -> the -32603 catch inside tools/call, NOT the -32601
        // method default. Proves branch 3 leaves the tools/call path intact.
        const { res, text } = await rpc({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'nope', arguments: {} },
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: 3,
            error: { code: -32603, message: 'Unknown tool: nope' },
        });
    });
});

describe('branch 2 -- an id member means it is NOT a notification', () => {
    it('A7 -- an id-bearing notifications/* message gets -32601 with its id echoed', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', id: 7, method: 'notifications/initialized' });
        // MCP conditions the 202 on input consisting "solely of ... responses or
        // notifications", which this is not. So: a reply, not a 202.
        expect(res.status).not.toBe(202);
        expect(res.status).toBe(200);
        expect(text).toContain('"id":7');
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: 7,
            error: { code: -32601, message: 'Method not found: notifications/initialized' },
        });
    });

    it('A7 -- an EXPLICIT null id is still an id MEMBER, so still not a notification', async () => {
        // {"id":null} HAS the member. Membership is tested with `in`, not by value,
        // precisely so this case is answered rather than swallowed.
        const { res, text } = await rpc({ jsonrpc: '2.0', id: null, method: 'notifications/xyz' });
        expect(res.status).not.toBe(202);
        expect(res.status).toBe(200);
        expect(JSON.parse(text).error.code).toBe(-32601);
        expect(JSON.parse(text).id).toBeNull();
    });

    it('A2 -- an id-bearing unknown method echoes that id verbatim', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', id: 99, method: 'unknown/method' });
        expect(res.status).toBe(200);
        expect(text).toContain('"id":99');
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: 99,
            error: { code: -32601, message: 'Method not found: unknown/method' },
        });
    });

    it('an explicit id of 0 is a member and survives normalisation (?? not ||)', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', id: 0, method: 'unknown/method' });
        expect(res.status).toBe(200);
        expect(JSON.parse(text).id).toBe(0);
    });
});

describe('non-Request-object bodies', () => {
    it('a batch array is no longer the -32601 this file used to pin', async () => {
        // DELIBERATE EDIT, as the superseded assertion here asked for. That
        // assertion pinned the pre-batch behaviour (an array -> -32601 "Method
        // not found: undefined") and said a future batch change had to be an
        // edit at this line. Sec 6 batch RECEIVE is now implemented, so an
        // all-notification array is accepted with 202 and no body. The full
        // batch contract is asserted in mcp-batch-receive.test.ts; this keeps
        // only the fact that the old single-object -32601 is gone.
        const { res, text } = await rpc([
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', method: 'notifications/xyz' },
        ]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|Method not found/);
    });

    it('a scalar body is NOT a Request object: still -32601, never 202', async () => {
        const { res, text } = await rpc(5);
        expect(res.status).not.toBe(202);
        expect(res.status).toBe(200);
        expect(JSON.parse(text).error.code).toBe(-32601);
        expect(JSON.parse(text).id).toBeNull();
    });
});

describe('R2 -- route and guard error layers agree on shape', () => {
    it('both layers emit jsonrpc + id + error, with id present as null', async () => {
        // Route layer: a scalar body reaches the -32601 default with no id.
        // (It used to be a batch array here; an array is now dispatched per
        // Sec 6 and an all-notification one returns 202 with no body at all.)
        const routeBody = JSON.parse((await rpc(5)).text);

        // Guard layer: an unparseable body -> -32700 before any dispatch.
        const url = new URL('https://free2aitools.com/api/mcp');
        const bad = new Request(url.href, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
        });
        const guardBody = await (await POST({ request: bad, url } as any)).json();

        expect(Object.keys(routeBody)).toEqual(Object.keys(guardBody));
        expect(Object.keys(guardBody)).toEqual(['jsonrpc', 'id', 'error']);
        expect(routeBody.id).toBeNull();
        expect(guardBody.id).toBeNull();
        expect(guardBody.error.code).toBe(-32700);
    });
});
