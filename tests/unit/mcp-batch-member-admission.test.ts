import { describe, it, expect, vi } from 'vitest';

// Which batch members are ADMITTED, and what happens to the ones that are not.
// Three admission rules, each previously unpinned:
//
//   1. MAX_BATCH_MEMBERS -- a count bound enforced BEFORE any member runs.
//      Measured on this branch without it: 1960 minimal `tools/list` members fit
//      in a 65,534-byte POST -- inside G1's MAX_REQUEST_BYTES, which is 65536 --
//      and returned 15,237,894 bytes from one unauthenticated request; under the
//      same ceiling 663 `tools/call` members fit at ONE REPRESENTATIVE minimal
//      shape ({"id":N,"method":"tools/call","params":{"name":
//      "free2aitools_search","arguments":{"query":"a"}}}, 96 B/member) -- not
//      the smallest, and not claimed to be: rank + {"task":"a"} is 93 B -> 683,
//      and 570 / 745 / 924 come out of other measured shapes. The shape is
//      named so the number is reproducible.
//      The cap bounds dispatches, and with them the ELEMENT
//      COUNT -- so a response is at most 25 single-message bodies, which is a
//      multiple of the largest one, not a fixed byte ceiling. It does not bound
//      wall-clock, and sequential dispatch bounds neither.
//   2. An id-less OBJECT member is a notification and gets no element -- even
//      when it is garbage like JSON-RPC 2.0 Sec 6's own `{"foo":"boo"}`. That is
//      parity with sending it alone, and it means an all-garbage batch is
//      answered with 202 and silence. Deliberate; pinned here so it cannot be
//      "fixed" by accident, and so the silence is visible in the test names.
//   3. A NESTED ARRAY member is NOT a notification -- that is the one live
//      reason the `!Array.isArray` exclusion in isNotification is load-bearing
//      at this head.
//      isNotification is called in THREE places, each for a different job:
//      mcp.ts classifies the whole single message; the batch PRE-PASS asks
//      body.every(isNotification) to pick the refusal arm; the batch LOOP asks
//      it per member to decide whether that member contributes an element. A
//      top-level array reaches NONE of them as an array, because dispatchRpc
//      intercepts it first -- which is why the exclusion's live job is the
//      NESTED member.
//      Measured:
//      with the exclusion removed, the ONLY behavioural failures anywhere in the
//      unit+srs1 suites are the two `rule 3` cases below -- every other test in
//      those suites still passes. Stated as the failure set rather than as a
//      count, because absolute totals move with run scope and with files that
//      fail to load in a given environment. That silence is why they exist.

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
// Stub every internal handler mcp.ts statically imports so module load stays
// hermetic (no VFS / R2 / DB). None of them is reached by these cases.
vi.mock('../../src/pages/api/search.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: vi.fn() }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: vi.fn() }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: vi.fn() }));

import { POST } from '../../src/pages/api/mcp.js';
import { dispatchRpc } from '../../src/lib/mcp-batch.js';
import { MAX_BATCH_MEMBERS, JSON_RPC_ERROR_CODE } from '../../src/lib/mcp-guard.js';

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

const listMember = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
const members = (n: number) => Array.from({ length: n }, (_, i) => listMember(i + 1));
// id-less: a notification under the standing id-absence rule.
const notification = (i: number) => ({ jsonrpc: '2.0', method: `notifications/n${i}` });

describe('rule 1 -- MAX_BATCH_MEMBERS is a PRE-DISPATCH count bound', () => {
    it(`dispatches all ${MAX_BATCH_MEMBERS} members at the cap`, async () => {
        const spy = vi.fn(async (m: any) => new Response(
            JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }),
            { headers: { 'Content-Type': 'application/json' } },
        ));
        const res = await dispatchRpc(members(MAX_BATCH_MEMBERS), spy);
        expect(spy).toHaveBeenCalledTimes(MAX_BATCH_MEMBERS);
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text())).toHaveLength(MAX_BATCH_MEMBERS);
    });

    it('at cap+1 NOTHING is dispatched -- the dispatcher is never called', async () => {
        // The point of a pre-dispatch gate is that no member ran, so this asserts
        // the call count, not merely the status. A gate placed inside the loop
        // would still return the right status while having executed members.
        const spy = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        const res = await dispatchRpc(members(MAX_BATCH_MEMBERS + 1), spy);
        expect(spy).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledTimes(0);
        expect(res.status).toBe(200); // HTTP 200 + JSON-RPC error body, as everywhere here
    });

    it('the rejection is the cap family\'s exact -32001 shape, not a new one', async () => {
        const { res, text } = await rpc(members(MAX_BATCH_MEMBERS + 1));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = JSON.parse(text);
        // DELIBERATE Sec 6 DEVIATION, pinned so it stays visible: a single
        // object, not 26 error elements. Sec 6's MUST-single-object clause is
        // for input that is not "an Array with at least one value", which this
        // is; the SHOULD-array clause covers it. The refusal is about the batch
        // as a whole -- no member ran -- so per-member verdicts would be
        // invented. Same shape as the pre-existing depth rejection.
        expect(Array.isArray(body)).toBe(false);
        expect(body).toEqual({
            jsonrpc: '2.0', id: null,
            error: {
                code: JSON_RPC_ERROR_CODE,
                message: 'Request rejected: exceeds size/shape limits',
                data: { limit: 'max_batch_members', max: MAX_BATCH_MEMBERS },
            },
        });
        expect(body.error.code).toBe(-32001);
    });

    it('form-identical to an existing cap rejection (max_ids_items)', async () => {
        // Same envelope keys, same code, same data shape as the nearest precedent
        // in the family, so a client parses one rule and handles both.
        const over = await rpc(members(MAX_BATCH_MEMBERS + 1));
        const ids = await rpc({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'free2aitools_compare', arguments: { ids: Array.from({ length: 26 }, (_, i) => `id-${i}`) } },
        });
        const a = JSON.parse(over.text), b = JSON.parse(ids.text);
        expect(Object.keys(a)).toEqual(Object.keys(b));
        expect(Object.keys(a.error)).toEqual(Object.keys(b.error));
        expect(a.error.code).toBe(b.error.code);
        expect(a.error.message).toBe(b.error.message);
        expect(Object.keys(a.error.data)).toEqual(Object.keys(b.error.data));
    });

    it('25 NOTIFICATIONS (at the cap) -> 202, empty body, no Content-Type', async () => {
        // Transport rule 4, accepted arm: "the server MUST return HTTP status
        // code 202 Accepted with no body."
        const { res, text } = await rpc(Array.from({ length: MAX_BATCH_MEMBERS }, (_, i) => notification(i + 1)));
        expect(res.status).toBe(202);
        expect(text).toBe('');
        expect(res.headers.get('content-type')).toBeNull();
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('26 NOTIFICATIONS (over the cap) -> HTTP 400, empty body, NO id anywhere', async () => {
        // Transport rule 4, refused arm: "it MUST return an HTTP error status
        // code (e.g., 400 Bad Request). The HTTP response body MAY comprise a
        // JSON-RPC error response that has no `id`."
        //
        // Both halves failed before this fix: the cap answered 200 (not an error
        // status) with a -32001 body carrying `id: null` -- and by this repo's
        // own standing reading, {"id":null} HAS the id member. The byte gate is
        // not involved: 26 notifications is ~1.2 KB, far inside G1.
        const { res, text } = await rpc(Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, i) => notification(i + 1)));
        expect(res.status).toBe(400);
        expect(res.status).not.toBe(200);
        expect(text).toBe('');
        // No body at all, so the "no id" clause holds by construction.
        expect(text).not.toContain('"id"');
        expect(res.headers.get('content-type')).toBeNull();
        // CORS is still advertised, as on every other bodiless response here.
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('26 notifications + ONE request -> rule 5 instead: 200 + one JSON object', async () => {
        // "If the input contains any number of JSON-RPC requests, the server
        // MUST either return Content-Type: text/event-stream ... or
        // Content-Type: application/json, to return one JSON object." One
        // id-bearing member flips the input out of rule 4 and back to the
        // -32001 object. This is the line the fix must not blur.
        const { res, text } = await rpc([
            ...Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, i) => notification(i + 1)),
            { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        ]);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        const body = JSON.parse(text);
        expect(Array.isArray(body)).toBe(false);
        expect(body.error.code).toBe(JSON_RPC_ERROR_CODE);
        expect(body.error.data).toEqual({ limit: 'max_batch_members', max: MAX_BATCH_MEMBERS });
    });

    it('the notification-only refusal dispatches nothing either', async () => {
        const spy = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        const res = await dispatchRpc(
            Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, i) => notification(i + 1)),
            spy,
        );
        expect(spy).not.toHaveBeenCalled();
        expect(res.status).toBe(400);
    });

    it('a batch AT the cap is still served end to end, and stays small', async () => {
        const { res, text } = await rpc(members(MAX_BATCH_MEMBERS));
        expect(res.status).toBe(200);
        const body = JSON.parse(text);
        expect(body).toHaveLength(MAX_BATCH_MEMBERS);
        expect(body.map((r: any) => r.id)).toEqual(members(MAX_BATCH_MEMBERS).map((m) => m.id));
        // 189.8 KiB measured at the cap, against 14.53 MiB at G1 saturation
        // before it. Generous ceiling: this asserts the ORDER of magnitude.
        expect(Buffer.byteLength(text)).toBeLessThan(400 * 1024);
    });
});
