import { describe, it, expect, vi } from 'vitest';

// MCP notification transport -- BRANCH 1 of the notification rule: any Request
// object with NO "id" member is a notification and gets 202 with an empty body.
//
// JSON-RPC 2.0 Sec 4.1: "A Notification is a Request object without an "id"
// member. ... The Server MUST NOT reply to a Notification". MCP Streamable HTTP
// 2025-03-26 (the protocolVersion this server advertises): notification-only
// input "MUST return HTTP status code 202 Accepted with no body."
//
// Both texts draw the line at the ABSENT id and neither mentions the method
// name, so the method is irrelevant here: a bare `initialize` and a bare
// `tools/list` are notifications exactly as `notifications/initialized` is.
// Branches 2 and 3 (id-bearing messages, which are never notifications) and the
// error-body id shape live in mcp-notification-and-error-id.test.ts.
//
// The defect this fixes: POST {"jsonrpc":"2.0","method":"notifications/
// initialized"} used to return HTTP 200 with a -32601 "Method not found" body.

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

describe('branch 1 -- ANY id-less Request object is a notification -> 202', () => {
    it('A1(b) -- notifications/initialized -> 202, empty body, no -32601', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|Method not found/);
    });

    it('A2 -- an unknown notifications/* method also yields 202', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'notifications/xyz' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
    });

    it('A9 -- a bare initialize with NO id -> 202, empty body', async () => {
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'initialize' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        // It must NOT be served the initialize result.
        expect(text).not.toMatch(/protocolVersion|serverInfo/);
    });

    it('A10 -- a bare tools/list with NO id -> 202, empty body', async () => {
        // Pins branch 1 across the tools/* namespace, where a regression would hide.
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'tools/list' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/free2aitools_search|inputSchema/);
    });

    it('A2 (OVERTURNED) -- an id-less UNKNOWN method is a notification, so 202', async () => {
        // This payload previously had to return -32601 with "id":null. Under the
        // id-absence rule it is a notification like any other id-less request and
        // Sec 4.1 forbids replying to it at all. The old expectation is replaced,
        // not kept alongside.
        const { res, text } = await rpc({ jsonrpc: '2.0', method: 'unknown/method' });
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(text).not.toMatch(/-32601|"id":null/);
    });

    it('the method name is irrelevant once the id is absent', async () => {
        // Each of these used to be probed for the `notifications/` prefix rule.
        // With that condition gone they are all simply notifications.
        for (const payload of [
            { jsonrpc: '2.0', method: 'tools/notifications/x' }, // prefix mid-string
            { jsonrpc: '2.0', method: 42 },                      // not even a string
            { jsonrpc: '2.0', method: 'tools/call', params: { name: 'x', arguments: {} } },
            { jsonrpc: '2.0' },                                  // no method at all
        ]) {
            const { res, text } = await rpc(payload);
            expect(res.status, JSON.stringify(payload)).toBe(202);
            expect(text, JSON.stringify(payload)).toBe('');
        }
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
});
