/**
 * PROBE-OBS-01 — reliability probe TRANSPORT-EVIDENCE tests (no external network).
 * Companion to reliability-probe.test.ts (split for the CES 250-line ceiling). Locks
 * the schema-2 instrumentation that lets a later comparison tell an UNKNOWN apart:
 * zero bytes vs a partial document vs the same bytes+hash as a healthy response that
 * never completed transport. Encodes NO preference among the co-equal candidate
 * causes. Contracts are pinned to INDEPENDENT LITERALS, so drifting one reddens.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-ignore — JS ESM helper module (no .d.ts); tested for its runtime contract.
import * as core from '../../scripts/monitoring/reliability-probe-core.mjs';

// Constant pinning and crash-evidence live in the sibling file with the other
// pure-helper contracts; this file owns per-target transport evidence.
const { runTarget, buildTargetSpecs, snapshotResponseHeaders, deriveTransportEvidence, RESPONSE_HEADER_ALLOWLIST } = core as any;

// Independent literals. NOT derived from the module under test.
const MARKER = 'The Open-Source AI Registry';
const ALLOWED = ['cf-ray', 'cf-cache-status', 'age', 'cache-control', 'content-type', 'content-length',
    'content-encoding', 'transfer-encoding', 'etag', 'vary', 'server', 'cf-mitigated'];
const SECRETS = { 'set-cookie': 'sid=abc; Secure', cookie: 'sid=abc', authorization: 'Bearer token-value', 'proxy-authorization': 'Basic zzz', 'x-github-token': 'gh-token-value' };
const CF = { 'cf-ray': '9a1b2c3d4e5f6a7b-DFW', 'cf-cache-status': 'DYNAMIC', 'content-type': 'text/html' };
const CAP = { maxAssertionBodyBytes: 8 };
const HEALTH_BODY = '{"manifest_state":"loaded","served_build_id":"run-1"}';
const spec = (n: string) => buildTargetSpecs().find((s: any) => s.name === n);
const run = (n: string, deps: any) => runTarget(spec(n), { baseUrl: 'https://x.test', ...deps });
const runSpec = (s: any, deps: any) => runTarget(s, { baseUrl: 'https://x.test', ctx: {}, ...deps });
const hdrs = (h: Record<string, string>) => {
    const low: Record<string, string> = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (n: string) => (n.toLowerCase() in low ? low[n.toLowerCase()] : null) };
};
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (bs: Uint8Array[]) => { const h = createHash('sha256'); for (const b of bs) h.update(Buffer.from(b)); return h.digest('hex'); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
/** Byte stream yielding `chunks`, then ending, or hanging until `hang.signal` aborts. */
function stream(chunks: Uint8Array[], hang: { signal?: AbortSignal } | null) {
    let i = 0;
    const boom = (rej: any) => rej(new Error('The operation was aborted'));
    const read = () => (i < chunks.length ? Promise.resolve({ done: false, value: chunks[i++] })
        : !hang ? Promise.resolve({ done: true, value: undefined })
            : new Promise((_r, rej) => (hang.signal!.aborted ? boom(rej) : hang.signal!.addEventListener('abort', () => boom(rej)))));
    return { getReader: () => ({ read }) };
}
const streamed = (body: string, extra: any = {}) => async () => ({ status: 200, headers: hdrs(CF), body: stream([bytes(body)], null), ...extra });
const whole = (body: string, extra: any = {}) => async () => ({ status: 200, headers: hdrs(CF), text: async () => body, ...extra });

describe('a COMPLETE body populates every evidence field (cases A, I)', () => {
    const html = `<html><title>${MARKER}</title><body>ok</body></html>`;
    it('A: body_complete, byte count + sha over every byte, prefix/suffix, PASS preserved', async () => {
        const rec = await run('homepage', {
            fetchImpl: async () => ({ status: 200, url: 'https://x.test/', redirected: false, headers: hdrs({ ...CF, 'x-guardian-time': '7.25ms' }), body: stream([bytes(html)], null) }),
            clock: (() => { const v = [0, 12, 40]; let i = 0; return () => v[Math.min(i++, 2)]; })(), ctx: {},
        });
        expect([rec.state, rec.http_status, rec.headers_received, rec.body_started, rec.body_complete]).toEqual(['PASS', 200, true, true, true]);
        expect([rec.body_bytes_received, rec.body_sha256_received]).toEqual([bytes(html).length, sha([bytes(html)])]);
        expect(b64(rec.body_prefix_base64)).toBe(html);
        expect([rec.body_evidence_truncated, rec.failure_phase, rec.timed_out, rec.timeout_ms]).toEqual([false, null, false, 30000]);
        expect([rec.assertion_body_overflowed, rec.assertion_body_limit_bytes]).toEqual([false, 33554432]);
        expect([rec.response_url, rec.redirected]).toEqual(['https://x.test/', false]);
        // I: guardian_ms is the origin header; ttfb_ms is the external clock.
        expect([rec.guardian_ms, rec.ttfb_ms, rec.total_ms]).toEqual([7.25, 12, 40]);
    });
    // SF-1: assertion bytes must be an OWNED SNAPSHOT of the bytes the hash attests.
    it('a transport reusing ONE backing buffer cannot make assertions see undelivered bytes', async () => {
        const backing = new Uint8Array(4); // one buffer, overwritten between reads
        backing.set(bytes('AAAA'));
        let n = 0;
        const body = { getReader: () => ({ read: async () => {
            if (n++ === 0) return { done: false, value: backing };
            if (n === 2) { backing.set(bytes('BBBB')); return { done: false, value: backing }; }
            return { done: true, value: undefined };
        } }) };
        let seen: unknown = 'unset';
        const probe = { name: 'sf1', method: 'GET', path: '/', assert: (_r: any, b: any) => { seen = b; return [{ name: 'body_seen', ok: b === 'AAAABBBB' }]; } };
        const rec = await runSpec(probe, { fetchImpl: async () => ({ status: 200, headers: hdrs(CF), body }) });
        // Delivered sequence was AAAA then BBBB; count, hash and prefix attest exactly that.
        expect([rec.body_bytes_received, rec.body_sha256_received]).toEqual([8, sha([bytes('AAAA'), bytes('BBBB')])]);
        expect(b64(rec.body_prefix_base64)).toBe('AAAABBBB');
        expect(seen).toBe('AAAABBBB'); expect(seen).not.toBe('BBBBBBBB'); // == hashed delivered bytes; aliasing mode excluded
        expect([rec.state, rec.body_complete]).toEqual(['PASS', true]);
    });
    it('SF-2: assert throwing AFTER a completed body is an ASSERTION fault, never a body failure', async () => {
        const probe = { name: 'sf2', method: 'GET', path: '/', assert: () => { throw new TypeError('deliberate assert fault'); } };
        const rec = await runSpec(probe, { fetchImpl: async () => ({ status: 200, headers: hdrs(CF), body: stream([bytes('ok')], null) }) });
        expect([rec.state, rec.body_complete, rec.failure_phase, rec.timed_out]).toEqual(['UNKNOWN', true, 'assertion', false]);
        expect(rec.error).toContain('deliberate assert fault'); expect([rec.body_bytes_received, rec.assertions.length]).toEqual([2, 0]);
    });
});
describe('incomplete transport keeps UNKNOWN and keeps what it collected (B, C, D)', () => {
    // B and C also carry the proof that the deadline is NOT cleared merely because
    // headers arrived: headers land first, then the hung body is aborted by the timer.
    async function timedOutBody(chunks: Uint8Array[], extra: any = {}) {
        const ac = new AbortController();
        return run('homepage', { timeoutMs: 20, abortFactory: () => ac, ctx: {}, ...extra,
            fetchImpl: async () => ({ status: 200, url: 'https://x.test/', redirected: false, headers: hdrs(CF), body: stream(chunks, { signal: ac.signal }) }) });
    }
    it('B: ZERO body bytes then timeout -> UNKNOWN, failure_phase=body, header/cf evidence preserved', async () => {
        const rec = await timedOutBody([]);
        expect([rec.state, rec.http_status, rec.headers_received]).toEqual(['UNKNOWN', 200, true]);
        expect([rec.body_started, rec.body_complete, rec.body_bytes_received, rec.body_sha256_received]).toEqual([true, false, 0, null]);
        expect([rec.failure_phase, rec.timed_out, rec.timeout_ms]).toEqual(['body', true, 20]);
        expect(rec.state).not.toBe('FAIL'); // not relabelled to make the run redder
        expect([rec.cf_ray, rec.cf_colo_suffix, rec.cf_cache_status]).toEqual(['9a1b2c3d4e5f6a7b-DFW', 'DFW', 'DYNAMIC']); expect(rec.response_headers['content-type']).toBe('text/html');
    });
    it('C: PARTIAL bytes then timeout -> UNKNOWN with the partial count/hash/prefix/suffix', async () => {
        const parts = [bytes('ABCDEFGH'), bytes('IJKLMNOP')];
        const rec = await timedOutBody(parts, { bodyEdgeBytes: 4 });
        expect([rec.state, rec.body_complete, rec.body_bytes_received]).toEqual(['UNKNOWN', false, 16]);
        expect(rec.body_sha256_received).toBe(sha(parts)); // hashed incrementally, pre-abort
        expect([b64(rec.body_prefix_base64), b64(rec.body_suffix_base64)]).toEqual(['ABCD', 'MNOP']);
        expect([rec.body_evidence_truncated, rec.failure_phase, rec.timed_out]).toEqual([true, 'body', true]);
    });
    it('D: timeout BEFORE headers -> UNKNOWN, no header snapshot, no cf fields invented', async () => {
        const ac = new AbortController();
        const rec = await run('homepage', { timeoutMs: 15, abortFactory: () => ac, ctx: {},
            fetchImpl: (_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('The operation was aborted')))) });
        expect([rec.state, rec.headers_received, rec.http_status, rec.response_headers]).toEqual(['UNKNOWN', false, null, null]);
        expect([rec.cf_ray, rec.cf_colo_suffix, rec.cf_cache_status, rec.age_seconds]).toEqual([null, null, null, null]);
        expect([rec.response_url, rec.redirected, rec.body_started, rec.body_bytes_received]).toEqual([null, null, false, 0]);
        expect([rec.failure_phase, rec.timed_out, rec.assertion_body_limit_bytes]).toEqual(['headers', true, null]);
    });
});
describe('derived fields are parsed not assumed; the allowlist is the whole surface (E, F, G)', () => {
    it('E/F: cf-ray raw + colo parsed; absent cf-cache-status/age stay null with nothing inferred', () => {
        const d = deriveTransportEvidence(snapshotResponseHeaders(hdrs({ 'cf-ray': '8f0e1d2c3b4a5968-lhr' }))); expect([d.cf_ray, d.cf_colo_suffix]).toEqual(['8f0e1d2c3b4a5968-lhr', 'LHR']);
        const bare = deriveTransportEvidence(snapshotResponseHeaders(hdrs({ 'cf-ray': '8f0e1d2c3b4a5968' })));
        expect([bare.cf_ray, bare.cf_colo_suffix]).toEqual(['8f0e1d2c3b4a5968', null]); // no colo trailer
        const snap = snapshotResponseHeaders(hdrs({ 'content-type': 'text/html' })); const absent = deriveTransportEvidence(snap);
        expect([snap['cf-cache-status'], snap.age, absent.cf_cache_status, absent.age_seconds]).toEqual([null, null, null, null]);
        expect([deriveTransportEvidence({ age: '42' }).age_seconds, deriveTransportEvidence({ age: 'soon' }).age_seconds]).toEqual([42, null]);
    });
    it('G: allowlist IS those twelve public headers; no secret name or VALUE reaches a snapshot', () => {
        expect([...RESPONSE_HEADER_ALLOWLIST]).toEqual(ALLOWED);
        for (const k of ['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'x-guardian-time']) expect([...RESPONSE_HEADER_ALLOWLIST]).not.toContain(k);
        const snap = snapshotResponseHeaders(hdrs({ ...SECRETS, 'cf-ray': 'r-DFW', server: 'cloudflare', etag: 'W/"1"' }));
        expect(Object.keys(snap).sort()).toEqual([...ALLOWED].sort());
        expect(snap['content-encoding']).toBe(null); // absent stays absent, not "identity"
        for (const k of Object.keys(SECRETS)) expect(k in snap).toBe(false);
        const ser = JSON.stringify(snap); expect(ser).not.toContain('x-guardian-time');
        for (const v of Object.values(SECRETS)) expect(ser).not.toContain(v);
    });
    it('G: end-to-end, a record carries the allowlist only, and guardian stays its own field', async () => {
        const rec = await run('openapi', { ctx: {}, fetchImpl: streamed('{"openapi":"3.0.3"}', { headers: hdrs({ ...SECRETS, ...CF, 'x-guardian-time': '2.5ms' }) }) });
        expect(Object.keys(rec.response_headers).sort()).toEqual([...ALLOWED].sort());
        expect(JSON.stringify(rec)).not.toContain('Bearer token-value');
        expect([rec.state, rec.guardian_ms]).toEqual(['PASS', 2.5]);
    });
});
describe('a COMPLETED response takes the ordinary contract verdict (H, JSON literal null)', () => {
    it('H: complete body, marker absent -> FAIL (not UNKNOWN) with failure_phase=assertion', async () => {
        const body = bytes('<html>maintenance</html>'); const rec = await run('homepage', { ctx: {}, fetchImpl: async () => ({ status: 200, headers: hdrs(CF), body: stream([body], null) }) });
        expect([rec.state, rec.body_complete, rec.failure_phase, rec.timed_out]).toEqual(['FAIL', true, 'assertion', false]);
        expect([rec.body_bytes_received, rec.body_sha256_received]).toEqual([body.length, sha([body])]);
        // A completed body is still handed WHOLE to the assertions across chunk splits.
        const parts = [bytes(`<html><title>${MARKER.slice(0, 6)}`), bytes(`${MARKER.slice(6)}</title>`)];
        const split = await run('homepage', { ctx: {}, bodyEdgeBytes: 4, fetchImpl: async () => ({ status: 200, headers: hdrs(CF), body: stream(parts, null) }) });
        expect([split.state, split.body_evidence_truncated]).toEqual(['PASS', true]);
    });
    it('a JSON literal null body does NOT throw; absent required field -> FAIL, phase=assertion', async () => {
        for (const impl of [streamed('null'), whole('null')]) {
            const rec = await run('health', { ctx: {}, fetchImpl: impl });
            expect([rec.error, rec.body_complete, rec.assertion_body_overflowed]).toEqual([null, true, false]); expect([rec.state, rec.failure_phase]).toEqual(['FAIL', 'assertion']);
            expect(rec.assertions.map((a: any) => [a.name, a.ok])).toEqual([['status_200', true], ['json_parses', true], ['manifest_state_valid', false]]);
        }
        // MALFORMED json is a DIFFERENT case and keeps its pre-existing UNKNOWN treatment.
        const bad = await run('health', { ctx: {}, fetchImpl: streamed('<html>not json') });
        expect([bad.state, bad.error, bad.assertions[1].ok]).toEqual(['UNKNOWN', null, null]);
    });
});
describe('assertion-retention overflow is explicit and is NEVER a transport failure', () => {
    const JSON_TARGETS: Array<[string, string, any]> = [['health', HEALTH_BODY, {}], ['openapi', '{"openapi":"3.0.3"}', {}],
        ['search', '{"results":[{"id":"e1"}]}', { searchQuery: 'llama' }], ['entity', '{"entity":{"id":"e1"}}', { ctx: { entity_id: 'e1' } }],
        ['mcp_initialize', '{"result":{"serverInfo":{"name":"f2ai"}}}', {}], ['mcp_tools_list', '{"result":{"tools":[{"name":"t"}]}}', {}]];
    it('streamed body over a tiny cap -> disclosed overflow, NAMED null, UNKNOWN, no transport failure', async () => {
        const rec = await run('health', { ctx: {}, ...CAP, fetchImpl: streamed(HEALTH_BODY) });
        expect([rec.assertion_body_overflowed, rec.assertion_body_limit_bytes]).toEqual([true, 8]);
        expect([rec.body_complete, rec.timed_out, rec.failure_phase, rec.error]).toEqual([true, false, null, null]);
        expect(rec.body_bytes_received).toBe(bytes(HEALTH_BODY).length);   // counting continued in full
        expect(rec.body_sha256_received).toBe(sha([bytes(HEALTH_BODY)]));  // hashing continued in full
        expect(rec.state).toBe('UNKNOWN');
        expect(rec.assertions.map((a: any) => [a.name, a.ok])).toEqual([['status_200', true], ['json_parses', null], ['manifest_state_valid', null]]);
    });
    it('the NON-STREAM fallback applies the same cap and never hands over the whole body', async () => {
        const rec = await run('health', { ctx: {}, ...CAP, fetchImpl: whole(HEALTH_BODY) });
        expect([rec.assertion_body_overflowed, rec.body_complete, rec.failure_phase, rec.state]).toEqual([true, true, null, 'UNKNOWN']);
        expect(rec.assertions.map((a: any) => a.ok)).toEqual([true, null, null]); // body was NOT handed over
        expect(rec.body_bytes_received).toBe(bytes(HEALTH_BODY).length);
    });
    it('all six JSON-consuming targets stay non-throwing on overflow, on BOTH read paths', async () => {
        for (const [name, body, extra] of JSON_TARGETS) {
            for (const impl of [streamed(body), whole(body)]) {
                const rec = await run(name, { ctx: {}, searchQuery: 'q', ...extra, ...CAP, fetchImpl: impl });
                expect([name, rec.error, rec.failure_phase, rec.assertion_body_overflowed, rec.state]).toEqual([name, null, null, true, 'UNKNOWN']);
                expect(rec.assertions.length).toBeGreaterThan(0);                      // never an empty list
                for (const a of rec.assertions) expect(typeof a.name).toBe('string');  // always NAMED
            }
        }
    });
    it('the status-only invalid_id_404 contract is body-independent and still PASSes after overflow', async () => {
        const rec = await run('invalid_id_404', { ctx: {}, ...CAP, fetchImpl: async () => ({ status: 404, headers: hdrs(CF), body: stream([bytes('x'.repeat(200))], null) }) });
        // By design, not an accidental exception: a status-only contract needs no body.
        expect([rec.assertion_body_overflowed, rec.state, rec.failure_phase]).toEqual([true, 'PASS', null]);
    });
});
describe('exact request shape and deadline truth (K, F-12)', () => {
    const SEQUENCE = ['https://x.test/api/v1/health', 'https://x.test/api/v1/search?q=llama',
        'https://x.test/api/v1/entity/e1', 'https://x.test/api/v1/entity/__reliability_probe_invalid_id__',
        'https://x.test/openapi.json', 'https://x.test/', 'https://x.test/api/mcp', 'https://x.test/api/mcp',
        'https://cdn.test/data/id-index.bin'];
    it('K: nine requests, exact order, one per spec, two MCP posts, no retry (2xx/404/5xx exercised)', async () => {
        const calls: string[] = []; const statuses: number[] = [];
        // SF-3: a 5xx IS exercised, so a status-CONDITIONAL retry breaks the shape too,
        // not only an unconditional one. Trigger classes actually exercised: 2xx, 404, 5xx.
        const deps = { baseUrl: 'https://x.test', indexUrl: 'https://cdn.test/data/id-index.bin', searchQuery: 'llama', ctx: {},
            fetchImpl: async (u: string) => {
                calls.push(u);
                const b = u.includes('/api/v1/search') ? '{"results":[{"id":"e1"}]}' : u.includes('/entity/e1') ? '{"entity":{"id":"e1"}}' : '{}';
                const status = u.includes('__reliability_probe_invalid_id__') ? 404 : u.endsWith('/openapi.json') ? 503 : 200;
                statuses.push(status);
                return { status, headers: hdrs(CF), body: stream([bytes(b)], null), arrayBuffer: async () => new ArrayBuffer(0) };
            } };
        const specs = buildTargetSpecs();
        for (const s of specs) await runTarget(s, deps);
        expect([statuses.filter((s) => s >= 500), statuses.filter((s) => s === 404)]).toEqual([[503], [404]]); // 5xx + 4xx trigger classes live
        expect(calls).toEqual(SEQUENCE);                       // exact order, exact URLs
        expect([calls.length, specs.length]).toEqual([9, 9]);  // exactly one request per target spec
        expect(calls.filter((u) => u.endsWith('/api/mcp')).length).toBe(2); // the intentional pair
        expect(new Set(calls.filter((u) => !u.endsWith('/api/mcp'))).size).toBe(7); // no other duplicate
        for (const u of calls) expect(u).not.toMatch(/[?&](_|cb|cachebust|nocache|bust|t|ts|v)=/i);
        expect([...new Set(calls.map((u) => new URL(u).host))].sort()).toEqual(['cdn.test', 'x.test']);
    });
    it('F-12: transport IGNORES abort and completes late -> UNKNOWN, timed_out=true, never PASS', async () => {
        const ac = new AbortController();
        const rec = await run('homepage', { timeoutMs: 10, abortFactory: () => ac, ctx: {},
            // Never observes the signal, then completes a perfectly valid body.
            fetchImpl: async () => ({ status: 200, headers: hdrs(CF), body: { getReader: () => { let sent = false; return { read: async () => { await sleep(40); if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: bytes(`<title>${MARKER}</title>`) }; } }; } } }) });
        expect([rec.state, rec.timed_out, rec.failure_phase]).toEqual(['UNKNOWN', true, 'body']);
        expect([rec.headers_received, rec.body_complete]).toEqual([true, true]); // eventual facts kept
    });
    it('F-12: the phase is the one captured WHEN THE TIMER FIRED, not inferred from later state', async () => {
        const ac = new AbortController();
        const rec = await run('homepage', { timeoutMs: 10, abortFactory: () => ac, ctx: {},
            // Headers had NOT arrived when the deadline fired; everything lands after.
            fetchImpl: async () => { await sleep(40); return { status: 200, headers: hdrs(CF), body: stream([bytes(`<title>${MARKER}</title>`)], null) }; } });
        expect([rec.timed_out, rec.failure_phase, rec.state]).toEqual([true, 'headers', 'UNKNOWN']);
        expect([rec.headers_received, rec.body_complete]).toEqual([true, true]); // later facts kept
    });
});
