import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// A1 -- MCP JSON-RPC conformance on the notification + error-id paths.
//
// Two defects observed live against https://free2aitools.com/api/mcp:
//
//  F1  POST {"jsonrpc":"2.0","method":"notifications/initialized"} returned
//      HTTP 200 with {"jsonrpc":"2.0","error":{"code":-32601,...}}. JSON-RPC 2.0
//      Sec 4.1: "A Notification is a Request object without an "id" member. ...
//      The Server MUST NOT reply to a Notification". MCP Streamable HTTP
//      2025-03-26 (the protocolVersion this server advertises): notification-only
//      input "MUST return HTTP status code 202 Accepted with no body."
//  F2  That error body carried NO id member at all -- jsonrpcError fed a possibly
//      -undefined id straight to JSON.stringify, which DROPS it. JSON-RPC 2.0
//      Sec 5: the id member "is REQUIRED ... If there was an error in detecting
//      the id in the Request object ... it MUST be Null." The guard layer
//      meanwhile emitted id:null, so route and guard disagreed on error shape.
//
// The regression floor for the untouched paths is a byte-exact digest captured
// from origin/main @6dbcddaf2ac9541dd01d4c4a4fe4c11e649d4bc9 BEFORE the fix, so
// any drift in initialize / tools/list content fails here rather than silently
// shipping. N1-N3: tools/list, tools/call and initialize are NOT modified.
//
// The notification gate requires BOTH halves of Sec 4.1: a `notifications/*`
// method AND an ABSENT id member. An id-bearing message is not a notification,
// and Sec 5 ("the Server MUST reply with a Response, except for in the case of
// Notifications") entitles it to a reply, so it must reach the -32601 default.
// A7/A8 below pin both directions of that boundary.

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

describe('A1(a) -- untouched paths stay byte-identical to origin/main', () => {
    it('initialize response is byte-for-byte unchanged', async () => {
        const { res, text, sha256 } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        expect(res.status).toBe(200);
        expect(Buffer.byteLength(text)).toBe(BASELINE.initialize.bytes);
        expect(sha256).toBe(BASELINE.initialize.sha256);
        // N3 spot-check: the advertised transport version governs the 202 rule.
        expect(JSON.parse(text).result.protocolVersion).toBe('2025-03-26');
    });

    it('tools/list response is byte-for-byte unchanged', async () => {
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
});

describe('A1(b)/A2 -- notifications get 202 with no body (Sec 4.1)', () => {
    it('notifications/initialized -> 202, empty body, no -32601', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|Method not found/);
    });

    it('A2 -- an UNKNOWN notifications/* method also yields 202, not -32601', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/xyz' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
    });

    it('A6 -- 202 carries no fabricated success envelope and no Content-Type', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toContain('result');
        // A bodiless response must not claim to carry JSON.
        expect(res.headers.get('content-type')).toBeNull();
        // CORS is still advertised so browser-hosted MCP clients are unaffected.
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('detection is prefix-anchored, not a substring match', async () => {
        // No id, so ONLY the prefix rule can decide: "notifications/" appears
        // mid-method, which is not the reserved namespace -> not a notification.
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'tools/notifications/x' });
        expect(res.status).toBe(200);
        expect(JSON.parse(text).error.code).toBe(-32601);
        expect(JSON.parse(text).id).toBeNull();
    });

    it('a non-string method never crashes the prefix check', async () => {
        // Also id-less, so the typeof guard is the only thing standing between
        // `42` and String.prototype.startsWith.
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 42 });
        expect(res.status).toBe(200);
        expect(JSON.parse(text).error.code).toBe(-32601);
        expect(JSON.parse(text).id).toBeNull();
    });
});

describe('A2 -- error responses always carry an id member (Sec 5)', () => {
    it('unknown method WITH an id echoes that id verbatim', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', id: 99, method: 'unknown/method' });
        expect(res.status).toBe(200);
        expect(text).toContain('"id":99');
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: 99,
            error: { code: -32601, message: 'Method not found: unknown/method' },
        });
    });

    it('unknown method WITHOUT an id emits id:null -- key present, not omitted', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'unknown/method' });
        expect(res.status).toBe(200);
        // The regression being fixed: the key used to be dropped entirely.
        expect(text).toContain('"id":null');
        const body = JSON.parse(text);
        expect(Object.prototype.hasOwnProperty.call(body, 'id')).toBe(true);
        expect(body.id).toBeNull();
        expect(body.error.code).toBe(-32601);
    });

    it('R2 -- route and guard error layers agree on shape', async () => {
        // Route layer (-32601, no id) vs guard layer (-32700 parse error, no id).
        const routeBody = JSON.parse((await rpc({ jsonrpc: '2.0', method: 'unknown/method' })).text);

        const url = new URL('https://free2aitools.com/api/mcp');
        const bad = new Request(url.href, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
        });
        const guardBody = await (await POST({ request: bad, url } as any)).json();

        expect(Object.keys(routeBody)).toEqual(Object.keys(guardBody));
        expect(routeBody.id).toBeNull();
        expect(guardBody.id).toBeNull();
        expect(guardBody.error.code).toBe(-32700);
    });

    it('an explicit id of 0 survives normalisation (?? not ||)', async () => {
        const { text } = await rpc({ jsonrpc: '2.0', id: 0, method: 'unknown/method' });
        expect(JSON.parse(text).id).toBe(0);
    });
});

describe('A7/A8 -- the notification gate needs BOTH halves of Sec 4.1', () => {
    it('A7 -- an id-BEARING notifications/* message is NOT a notification: -32601, id echoed', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', id: 7, method: 'notifications/initialized' });
        // Sec 4.1 defines a Notification as a Request WITHOUT an id member, and
        // Sec 5 requires a Response to every other rpc call. MCP conditions the 202
        // on input that "consists solely of ... responses or notifications", which
        // this is not. So: a reply, not a 202.
        expect(res.status).not.toBe(202);
        expect(res.status).toBe(200);
        expect(text).toContain('"id":7');
        expect(JSON.parse(text)).toEqual({
            jsonrpc: '2.0', id: 7,
            error: { code: -32601, message: 'Method not found: notifications/initialized' },
        });
    });

    it('A7 -- an EXPLICIT null id is still an id member, so still not a notification', async () => {
        // {"id":null} HAS the member. The gate tests `=== undefined`, not nullish,
        // precisely so this case is answered rather than swallowed.
        const { res, text } = await rpc({ jsonrpc: '2.0', id: null, method: 'notifications/xyz' });
        expect(res.status).not.toBe(202);
        expect(res.status).toBe(200);
        expect(JSON.parse(text).error.code).toBe(-32601);
        expect(JSON.parse(text).id).toBeNull();
    });

    it('A8 -- id-less notifications did NOT regress: still 202 with an empty body', async () => {
        for (const method of [
            'notifications/initialized', 'notifications/xyz',
            'notifications/cancelled', 'notifications/progress',
        ]) {
            const { res, text } = await rpc({ jsonrpc: '2.0', method });
            expect(res.status, method).toBe(202);
            expect(text, method).toBe('');
        }
    });

    it('A8 -- the exact reported payload still yields 202, no -32601 anywhere', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|Method not found/);
    });
});
