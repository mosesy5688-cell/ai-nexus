import { describe, it, expect, vi } from 'vitest';
import {
    readBoundedBody, validateRpcShape, guardAndParse,
    MAX_REQUEST_BYTES, MAX_NESTING_DEPTH, MAX_QUERY_CHARS, MAX_TASK_CHARS,
    MAX_ID_CHARS, MAX_IDS_ITEMS, MAX_CONSTRAINTS_KEYS, MAX_CONSTRAINTS_BYTES, JSON_RPC_ERROR_CODE,
} from '../../src/lib/mcp-guard.js';

// B2 — MCP request/argument size guard (Founder D-178 §D / D-182). The MCP route
// had NO application-layer size/shape guard: an oversized/pathological body was
// parsed in full and dispatched into search/VFS/DB before any limit was consulted.
// These drive the PURE guard (readBoundedBody/validateRpcShape) and the REAL POST
// route with every internal handler mocked, proving rejection precedes any
// handler/DB call and that in-spec requests pass through unchanged. Hermetic.

const enc = (s: string) => new TextEncoder().encode(s);
const streamOf = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
    start(c) { for (const u of chunks) c.enqueue(u); c.close(); },
});
const reqLike = (chunks: Uint8Array[], cl?: string | null) => ({
    headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? (cl ?? null) : null) },
    body: streamOf(chunks),
});
const bytesReq = (s: string, cl?: string | null) =>
    reqLike([enc(s)], cl === undefined ? String(enc(s).byteLength) : cl);
// valid JSON-RPC body padded to an EXACT byte length via an unchecked field.
function exactBody(target: number): string {
    const base = { jsonrpc: '2.0', id: 1, method: 'tools/list', _pad: '' };
    return JSON.stringify({ ...base, _pad: 'x'.repeat(target - enc(JSON.stringify(base)).byteLength) });
}
async function byteErr(req: any) {
    const out = await readBoundedBody(req);
    if (!('error' in out)) throw new Error('expected error');
    const b = await out.error.json();
    return { code: b.error.code, data: b.error.data, id: b.id };
}

describe('G1 readBoundedBody — total byte ceiling', () => {
    it('EXACTLY 65536 accepted; 65537 rejected (-32001/max_request_bytes, id=null)', async () => {
        const ok = exactBody(MAX_REQUEST_BYTES);
        expect(enc(ok).byteLength).toBe(65536);
        const okOut = await readBoundedBody(bytesReq(ok));
        expect('text' in okOut && okOut.text).toBe(ok);
        const e = await byteErr(bytesReq(ok + 'y'));
        expect(e.code).toBe(JSON_RPC_ERROR_CODE);
        expect(e.code).toBe(-32001);
        expect(e.data).toEqual({ limit: 'max_request_bytes', max: 65536 });
        expect(e.id).toBeNull();
    });
    it('absent + false-small Content-Length over cap still rejected via bounded stream', async () => {
        const big = exactBody(MAX_REQUEST_BYTES) + 'zzz';
        expect((await byteErr(reqLike([enc(big)], null))).data.limit).toBe('max_request_bytes');
        expect((await byteErr(reqLike([enc(big)], '10'))).data.limit).toBe('max_request_bytes');
    });
    it('declared-oversize Content-Length -> fast reject, body never read', async () => {
        const reader = { read: vi.fn(), cancel: vi.fn() };
        const e = await byteErr({ headers: { get: () => String(MAX_REQUEST_BYTES + 1) }, body: { getReader: () => reader } });
        expect(e.data.limit).toBe('max_request_bytes');
        expect(reader.read).not.toHaveBeenCalled();
    });
    it('malformed/negative Content-Length falls through to the authoritative read', async () => {
        const small = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect('text' in (await readBoundedBody(bytesReq(small, '-5')))).toBe(true);
        expect('text' in (await readBoundedBody(bytesReq(small, 'NaN')))).toBe(true);
        const e = await byteErr(bytesReq(exactBody(MAX_REQUEST_BYTES) + 'zz', '-1'));
        expect(e.data.limit).toBe('max_request_bytes');
    });
    it('UTF-8 multibyte split across chunk boundaries decodes correctly', async () => {
        const s = '{"q":"café—🚀"}';
        const full = enc(s); const parts: Uint8Array[] = [];
        for (let i = 0; i < full.byteLength; i += 3) parts.push(full.subarray(i, i + 3));
        const out = await readBoundedBody(reqLike(parts, null));
        expect('text' in out && out.text).toBe(s);
        expect(JSON.parse(('text' in out && out.text) as string).q).toBe('café—🚀');
    });
    it('cancels the stream the moment the running total exceeds the cap', async () => {
        const cancel = vi.fn(async () => {}); let calls = 0;
        const reader = {
            read: vi.fn(async () => (++calls === 1
                ? { done: false, value: new Uint8Array(MAX_REQUEST_BYTES + 1) }
                : { done: true, value: undefined })),
            cancel,
        };
        await byteErr({ headers: { get: () => null }, body: { getReader: () => reader } });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(calls).toBe(1);
    });
});

describe('guardAndParse — parse error stays -32700 (not -32001)', () => {
    it('malformed JSON within the byte limit + empty body -> -32700', async () => {
        const bad = await guardAndParse(bytesReq('{ not json '));
        expect((await (bad as any).error.json()).error.code).toBe(-32700);
        const empty = await guardAndParse(reqLike([], null));
        expect((await (empty as any).error.json()).error.code).toBe(-32700);
    });
});

async function shape(body: any) {
    const r = validateRpcShape(body);
    if (r === null) return null;
    const p = await r.json();
    return { code: p.error.code, data: p.error.data, id: p.id };
}
const nest = (d: number) => { let v: any = 1; for (let i = 0; i < d; i++) v = { a: v }; return v; };
const call = (args: any, id: any = 7) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 't', arguments: args } });

describe('G2 validateRpcShape — depth + string + array + constraints', () => {
    it('depth 8 accepted, depth 9 rejected (max_nesting_depth, id echoed)', async () => {
        expect(await shape({ id: 5, deep: nest(MAX_NESTING_DEPTH - 1) })).toBeNull();
        const e = await shape({ id: 5, deep: nest(MAX_NESTING_DEPTH) });
        expect(e!.data).toEqual({ limit: 'max_nesting_depth', max: 8 });
        expect(e!.id).toBe(5);
    });
    it('query/task/id: boundary accepted, +1 rejected with the right token', async () => {
        expect(await shape(call({ query: 'x'.repeat(MAX_QUERY_CHARS) }))).toBeNull();
        expect((await shape(call({ query: 'x'.repeat(MAX_QUERY_CHARS + 1) })))!.data).toEqual({ limit: 'max_string_len_query', max: 2048 });
        expect(await shape(call({ task: 'x'.repeat(MAX_TASK_CHARS) }))).toBeNull();
        expect((await shape(call({ task: 'x'.repeat(MAX_TASK_CHARS + 1) })))!.data.limit).toBe('max_string_len_task');
        expect(await shape(call({ id: 'x'.repeat(MAX_ID_CHARS) }))).toBeNull();
        const e = await shape(call({ id: 'x'.repeat(MAX_ID_CHARS + 1) }));
        expect(e!.data).toEqual({ limit: 'max_string_len_id', max: 256 });
        expect(e!.id).toBe(7);
    });
    it('ids: 25 accepted, 26 rejected; non-string + over-long element rejected', async () => {
        expect(await shape(call({ ids: Array(MAX_IDS_ITEMS).fill('a') }))).toBeNull();
        expect((await shape(call({ ids: Array(MAX_IDS_ITEMS + 1).fill('a') })))!.data).toEqual({ limit: 'max_ids_items', max: 25 });
        expect((await shape(call({ ids: ['ok', 123] })))!.data.limit).toBe('max_string_len_id');
        expect((await shape(call({ ids: ['ok', 'x'.repeat(MAX_ID_CHARS + 1)] })))!.data.limit).toBe('max_string_len_id');
    });
    it('constraints: >16 keys, >1024 UTF-8 bytes, non-scalar rejected; full scalar accepted', async () => {
        const many: any = {}; for (let i = 0; i <= MAX_CONSTRAINTS_KEYS; i++) many['k' + i] = 1;
        expect((await shape(call({ constraints: many })))!.data).toEqual({ limit: 'max_constraints_keys', max: 16 });
        const wide = 'é'.repeat(MAX_CONSTRAINTS_BYTES); // 2 bytes each -> chars < bytes
        expect(wide.length).toBeLessThan(MAX_CONSTRAINTS_BYTES * 2);
        expect((await shape(call({ constraints: { v: wide } })))!.data).toEqual({ limit: 'max_constraints_bytes', max: 1024 });
        const e = await shape(call({ constraints: { nested: { a: 1 } } }));
        expect(e!.code).toBe(-32001);
        expect(e!.data.limit).toBe('max_constraints_scalar');
        expect(await shape(call({ constraints: { max_vram_gb: 8, license: 'MIT', can_run_local: true } }))).toBeNull();
    });
    it('no reflected attacker content in the error body', async () => {
        const secret = 'ATTACKER_MARKER_' + 'q'.repeat(MAX_QUERY_CHARS + 1);
        const text = await validateRpcShape(call({ query: secret }))!.text();
        expect(text).not.toContain('ATTACKER_MARKER');
        expect(text).toContain('max_string_len_query');
    });
});

// ORDERING + REGRESSION via the REAL POST route, every internal handler mocked.
vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: null } }));
const searchSpy = vi.fn(), selectSpy = vi.fn(), compareSpy = vi.fn(), entitySpy = vi.fn();
vi.mock('../../src/pages/api/search.js', () => ({ GET: (...a: any[]) => searchSpy(...a) }));
vi.mock('../../src/pages/api/v1/select.js', () => ({ POST: (...a: any[]) => selectSpy(...a) }));
vi.mock('../../src/pages/api/v1/compare.js', () => ({ GET: (...a: any[]) => compareSpy(...a) }));
vi.mock('../../src/pages/api/v1/entity/[...id].js', () => ({ GET: (...a: any[]) => entitySpy(...a) }));
import { POST } from '../../src/pages/api/mcp.js';

const ctx = (bodyStr: string) => ({
    request: new Request('https://free2aitools.com/api/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyStr,
    }),
    url: new URL('https://free2aitools.com/api/mcp'),
});
const noHandler = () => {
    for (const s of [searchSpy, selectSpy, compareSpy, entitySpy]) expect(s).not.toHaveBeenCalled();
};

describe('POST route — guard rejects BEFORE any handler/DB dispatch', () => {
    it('oversize tools/call rejected, NO downstream handler invoked', async () => {
        for (const s of [searchSpy, selectSpy, compareSpy, entitySpy]) s.mockClear();
        const huge = JSON.stringify(call({ query: 'x'.repeat(MAX_REQUEST_BYTES) }, 9));
        const b = await (await POST(ctx(huge) as any)).json();
        expect(b.error.code).toBe(-32001);
        expect(b.error.data.limit).toBe('max_request_bytes');
        noHandler();
    });
    it('over-structural tools/call (26 ids) rejected pre-dispatch, id echoed, no handler', async () => {
        for (const s of [searchSpy, selectSpy, compareSpy, entitySpy]) s.mockClear();
        const over = JSON.stringify(call({ ids: Array(26).fill('a') }, 42));
        const b = await (await POST(ctx(over) as any)).json();
        expect(b.error.code).toBe(-32001);
        expect(b.error.data.limit).toBe('max_ids_items');
        expect(b.id).toBe(42);
        noHandler();
    });
});

describe('POST route — in-spec requests pass through unchanged', () => {
    it('initialize + tools/list are no-ops for the guard', async () => {
        const init = await (await POST(ctx(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as any)).json();
        expect(init.result.serverInfo.name).toBe('free2aitools');
        const list = await (await POST(ctx(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any)).json();
        expect(list.result.tools).toHaveLength(5);
    });
    it('in-spec search + 25-id compare DO reach their (mocked) handlers', async () => {
        searchSpy.mockClear(); compareSpy.mockClear();
        searchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
        compareSpy.mockResolvedValueOnce(new Response(JSON.stringify({ entities: [] }), { status: 200 }));
        const tcall = (name: string, args: any, id: number) =>
            JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
        await POST(ctx(tcall('free2aitools_search', { query: 'code generation' }, 3)) as any);
        await POST(ctx(tcall('free2aitools_compare', { ids: Array(MAX_IDS_ITEMS).fill('hf-model--x') }, 4)) as any);
        expect(searchSpy).toHaveBeenCalledTimes(1); // 25 ids is in-spec; guard pass-through
        expect(compareSpy).toHaveBeenCalledTimes(1);
    });
});

describe('guard — deterministic across 3 runs', () => {
    it('identical results', async () => {
        const sig = async () => JSON.stringify([
            await shape(call({ query: 'x'.repeat(MAX_QUERY_CHARS + 1) })),
            await shape(call({ ids: Array(26).fill('a') })),
            await byteErr(bytesReq(exactBody(MAX_REQUEST_BYTES) + 'z')),
        ]);
        const r1 = await sig(), r2 = await sig(), r3 = await sig();
        expect(r1).toBe(r2);
        expect(r2).toBe(r3);
    });
});
