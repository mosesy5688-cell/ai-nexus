import { describe, it, expect, vi } from 'vitest';

// How a batch MEMBER is classified -- rules 2 and 3, moved VERBATIM out of
// mcp-batch-member-admission.test.ts when that file reached 246/250 lines. The
// case names and assertions are unchanged; only the file boundary moved.
//
//   2. An id-less OBJECT member is a notification and gets no element -- even
//      when it is garbage like JSON-RPC 2.0 Sec 6's own `{"foo":"boo"}`. That is
//      parity with sending it alone, and it means an all-garbage batch is
//      answered with 202 and silence. Deliberate; pinned here so it cannot be
//      "fixed" by accident, and so the silence is visible in the test names.
//   3. A NESTED ARRAY member is NOT a notification -- the one live reason the
//      `!Array.isArray` exclusion in isNotification is load-bearing at this head,
//      isNotification is called in THREE places, each for a different job:
//      mcp.ts classifies the whole single message; the batch PRE-PASS asks
//      body.every(isNotification) to pick the refusal arm; the batch LOOP asks
//      it per member to decide whether that member contributes an element. A
//      top-level array reaches NONE of them as an array, because dispatchRpc
//      intercepts it first -- which is why the exclusion's live job is the
//      NESTED member.
//      Measured: with the exclusion
//      removed, the ONLY behavioural failures anywhere in the unit+srs1 suites
//      are the two `rule 3` cases below.

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

describe('rule 2 -- an id-less object member is a notification, garbage included', () => {
    it('Sec 6\'s own {"foo":"boo"} member -> 202, empty body, no element', async () => {
        const { res, text } = await rpc([{ foo: 'boo' }]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
    });

    it('an ALL-GARBAGE batch is answered with silence, not -32601', async () => {
        // origin/main answered this with a visible -32601. This is the one input
        // class this PR makes LESS diagnosable, and it is deliberate: it is exact
        // parity with sending any of those members alone.
        const { res, text } = await rpc([{ a: 1 }, { b: 2 }, { c: 3 }]);
        expect(res.status).toBe(202);
        expect(text).toBe('');
    });

    it('a garbage member does not suppress an id-bearing sibling', async () => {
        const { res, text } = await rpc([{ foo: 'boo' }, { jsonrpc: '2.0', id: 5, method: 'unknown/x' }]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0].id).toBe(5);
        expect(body[0].error.code).toBe(-32601);
    });
});

describe('rule 3 -- a nested ARRAY member is not swallowed as a notification', () => {
    it('[[]] -> one -32601 element, not a 202', async () => {
        // Guards the `!Array.isArray` exclusion in isNotification. Remove it and
        // this becomes 202 with an empty body: the member disappears silently.
        const { res, text } = await rpc([[]]);
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(202);
        const body = JSON.parse(text);
        expect(body).toHaveLength(1);
        expect(body[0]).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32601, message: 'Method not found: undefined' },
        });
    });

    it('a nested array member inside a larger batch keeps BOTH elements', async () => {
        const { res, text } = await rpc([[], { jsonrpc: '2.0', id: 5, method: 'unknown/x' }]);
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(2);
        expect(body[0].error.code).toBe(-32601);
        expect(body[0].id).toBeNull();
        expect(body[1].id).toBe(5);
    });
});
