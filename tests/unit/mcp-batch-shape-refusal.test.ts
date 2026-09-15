import { describe, it, expect, vi } from 'vitest';

// S5 -- what happens when the G2 shape gate refuses a batch MEMBER.
//
// Before this fix, a shape-refused member always contributed its -32001 element,
// including when the member was a NOTIFICATION. Two things were wrong with that:
//
//   * JSON-RPC 2.0 Sec 4.1 -- "The Server MUST NOT reply to a Notification" --
//     was broken by handing a notification an error element;
//   * MCP 2025-03-26 /basic/transports rule 4 says that for input consisting
//     solely of notifications, a server that "cannot accept the input ... MUST
//     return an HTTP error status code (e.g., 400 Bad Request)". An
//     all-notification batch with a refused member answered 200 with a
//     151-byte array instead.
//
// The rule now: element production is decided from the ORIGINAL member's
// classification, never from the response. A request whose id could not be
// detected also answers with `id: null`, so filtering the output on id-nullness
// or on an error code would delete a response Sec 5 owes a caller -- the last
// describe here is the case that would break if anyone tried it.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
// Stub every internal handler mcp.ts statically imports so module load stays
// hermetic (no VFS / R2 / DB). None of them is reached by these cases.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';
import { dispatchRpc } from '../../src/lib/mcp-batch.js';
import { MAX_ID_CHARS, MAX_IDS_ITEMS } from '../../src/lib/mcp-guard.js';

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

// A member the G2 gate refuses: args.id longer than MAX_ID_CHARS.
const overLongId = (id?: number | null) => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method: 'tools/call',
    params: { name: 'free2aitools_explain', arguments: { id: 'x'.repeat(MAX_ID_CHARS + 1) } },
});
// A second refusable shape, so the rule is not pinned to one cap.
const overCountIds = (id?: number) => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method: 'tools/call',
    params: {
        name: 'free2aitools_compare',
        arguments: { ids: Array.from({ length: MAX_IDS_ITEMS + 1 }, (_, i) => `id-${i}`) },
    },
});
const cleanNotification = (i: number) => ({ jsonrpc: '2.0', method: `notifications/n${i}` });
const request = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });

describe('row 2 -- all-notification input with a shape-refused member -> 400', () => {
    it('one refused notification -> HTTP 400, empty body, CORS preserved', async () => {
        const { res, text } = await rpc([overLongId()]);
        expect(res.status).toBe(400);
        expect(text).toBe('');
        expect(res.headers.get('content-type')).toBeNull();
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('refused alongside clean notifications -> still 400, still empty', async () => {
        const { res, text } = await rpc([cleanNotification(1), overCountIds(), cleanNotification(2)]);
        expect(res.status).toBe(400);
        expect(text).toBe('');
        expect(text).not.toContain('-32001');
    });

    it('the refusal is decided BEFORE dispatch -- counted, not inferred', async () => {
        // Row 2 requires the admission decision to complete first. A gate that
        // ran inside the loop would return the same status having already
        // executed the clean members, so the call count is the assertion.
        const spy = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        const res = await dispatchRpc([cleanNotification(1), overLongId(), cleanNotification(2)], spy);
        expect(spy).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledTimes(0);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('');
    });

    it('a clean all-notification batch is untouched by the new branch -> 202', async () => {
        const { res, text } = await rpc([cleanNotification(1), cleanNotification(2)]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(res.headers.get('content-type')).toBeNull();
    });
});

describe('row 3 -- in a MIXED batch the refused notification just disappears', () => {
    it('the notification produces no element and the request keeps its answer', async () => {
        const { res, text } = await rpc([overLongId(), request(5)]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(true);
        // One element, not two: the notification's -32001 is gone.
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe(5);
        expect(body[0].result.tools).toHaveLength(5);
        expect(text).not.toContain('-32001');
    });

    it('every request keeps its own response when several share the batch', async () => {
        const { text } = await rpc([request(1), overCountIds(), request(2), cleanNotification(9)]);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body.map((r: any) => r.id)).toEqual([1, 2]);
        expect(text).not.toContain('-32001');
    });

    it('the whole batch is NOT turned into a 400 by one refused notification', async () => {
        // Explicitly not authorised, and explicitly not done: the request-bearing
        // arm keeps rule 5's 200 + one JSON body.
        const { res } = await rpc([overLongId(), request(5)]);
        expect(res.status).not.toBe(400);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
    });
});

describe('row 4 -- a shape-refused REQUEST keeps its error response and its id', () => {
    it('an id-bearing refused member still gets -32001 WITH its id', async () => {
        const { res, text } = await rpc([overLongId(7), request(5)]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body[0].id).toBe(7);
        expect(body[0].error.code).toBe(-32001);
        expect(body[1].id).toBe(5);
    });

    it('a refused request ALONE still answers -32001, not 400', async () => {
        const { res, text } = await rpc([overLongId(7)]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe(7);
        expect(body[0].error.code).toBe(-32001);
    });

    it('a refused request whose id is explicitly null is NOT swallowed', async () => {
        // The trap the rule guards: this member answers with `id: null`, exactly
        // like a notification's refusal would. It is a REQUEST -- {"id":null} has
        // the id member -- so it must keep its element. Anything that filtered
        // the response on id-nullness would delete it here.
        const { res, text } = await rpc([overLongId(null), request(5)]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body[0].id).toBeNull();
        expect(body[0].error.code).toBe(-32001);
        expect(body[1].id).toBe(5);
    });
});
