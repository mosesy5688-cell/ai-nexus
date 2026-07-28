/**
 * D-2026-0717-345 P1a — reliability probe unit + CLI tests (no external network).
 *
 * Locks: three-state PASS/FAIL/UNKNOWN (missing/non-executed = UNKNOWN, never PASS);
 * anti-vacuity (D-346) — a degraded-but-200 homepage/search/entity now FAILs; guardian
 * time vs external TTFB; the timeout covers the FULL body read; the CLI exits 0/1/2;
 * and a crash still writes minimal UNKNOWN evidence before exiting 2. CLI tests drive
 * the REAL runner against a LOCAL mock http server / an unreachable host, never the
 * internet, and pin the exact request trace that runner actually issues.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — JS ESM helper module (no .d.ts); tested for its runtime contract.
import * as core from '../../scripts/monitoring/reliability-probe-core.mjs';

const {
    classifyState, overallVerdict, parseGuardianTime, parseIndexBuildId,
    buildCrashEvidence, buildTargetSpecs, runTarget, HOMEPAGE_MARKER,
    PROBE_SCHEMA_VERSION, BODY_EVIDENCE_EDGE_BYTES, MAX_ASSERTION_BODY_BYTES,
} = core as any;
function mockRes({ status = 200, headers = {} as Record<string, string>, text = '', arrayBuffer = null as ArrayBuffer | null } = {}) {
    const lower: Record<string, string> = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    return { status, headers: { get: (n: string) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
        text: async () => text, arrayBuffer: async () => arrayBuffer };
}
const seqClock = (v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };
function makeIndexHeader(buildId: string, version = 3): ArrayBuffer {
    const enc = new TextEncoder().encode(buildId); const ab = new ArrayBuffer(32 + enc.length); const dv = new DataView(ab);
    'IDIX'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint16(4, version, true); dv.setUint32(8, 1, true); dv.setUint16(24, enc.length, true); // keyCount nonzero
    new Uint8Array(ab, 32, enc.length).set(enc);
    return ab;
}
const spec = (name: string) => buildTargetSpecs().find((s: any) => s.name === name);
const run = (name: string, deps: any) => runTarget(spec(name), { baseUrl: 'https://x.test', ...deps });
describe('classifyState — three-state (missing evidence -> UNKNOWN, never PASS)', () => {
    it('not executed -> UNKNOWN', () => expect(classifyState(false, [{ ok: true }])).toBe('UNKNOWN'));
    it('empty assertion set -> UNKNOWN', () => expect(classifyState(true, [])).toBe('UNKNOWN'));
    it('all held -> PASS', () => expect(classifyState(true, [{ ok: true }, { ok: true }])).toBe('PASS'));
    it('any violated -> FAIL', () => expect(classifyState(true, [{ ok: true }, { ok: false }])).toBe('FAIL'));
    it('un-evaluable (null, no false) -> UNKNOWN not PASS', () => expect(classifyState(true, [{ ok: true }, { ok: null }])).toBe('UNKNOWN'));
    it('a false outranks a null -> FAIL', () => expect(classifyState(true, [{ ok: null }, { ok: false }])).toBe('FAIL'));
});
describe('overallVerdict + crash evidence', () => {
    it('empty -> UNKNOWN', () => expect(overallVerdict([])).toBe('UNKNOWN'));
    it('all PASS -> PASS', () => expect(overallVerdict([{ state: 'PASS' }, { state: 'PASS' }])).toBe('PASS'));
    it('any FAIL -> FAIL (even with UNKNOWN)', () => expect(overallVerdict([{ state: 'PASS' }, { state: 'UNKNOWN' }, { state: 'FAIL' }])).toBe('FAIL'));
    it('UNKNOWN present, no FAIL -> UNKNOWN (never laundered to PASS)', () => expect(overallVerdict([{ state: 'PASS' }, { state: 'UNKNOWN' }])).toBe('UNKNOWN'));
    it('buildCrashEvidence -> overall UNKNOWN + crashed + NO fabricated schedule', () => {
        const ev = buildCrashEvidence(new Error('boom'), { base_host: 'h', cron: '*/15 * * * *' });
        expect([ev.overall, ev.crashed, ev.scheduled_utc, ev.schedule_delay_ms]).toEqual(['UNKNOWN', true, null, null]);
        expect(ev.error).toContain('boom');
    });
    it('buildCrashEvidence -> LITERAL schema 2, no targets, run identity passed through', () => {
        const ev = buildCrashEvidence(new Error('x'), { runner: { os: 'Linux', arch: 'X64' }, node: { version: 'v24.0.0' } });
        expect([ev.schema_version, ev.targets.length, ev.runner.os, ev.node.version]).toEqual([2, 0, 'Linux', 'v24.0.0']);
        const bare = buildCrashEvidence(new Error('x'), {}); // no metadata -> nulls, never PASS
        expect([bare.overall, bare.runner, bare.node, bare.github]).toEqual(['UNKNOWN', null, null, null]);
    });
});
describe('parse helpers + advertised constants', () => {
    // Pinned to INDEPENDENT LITERALS: drifting a constant must redden HERE rather than
    // silently redefining what every other assertion in both suites claims to check.
    it('schema version, edge bytes, retention cap and homepage marker', () => {
        expect([PROBE_SCHEMA_VERSION, BODY_EVIDENCE_EDGE_BYTES, MAX_ASSERTION_BODY_BYTES]).toEqual([2, 512, 33554432]);
        expect(HOMEPAGE_MARKER).toBe('The Open-Source AI Registry');
    });
    it('guardian "12.34ms" -> 12.34', () => expect(parseGuardianTime({ get: () => '12.34ms' })).toBe(12.34));
    it('guardian absent/junk -> null', () => expect([parseGuardianTime({ get: () => null }), parseGuardianTime({ get: () => 'n/a' })]).toEqual([null, null]));
    it('index v3 header -> build_id', () => expect(parseIndexBuildId(makeIndexHeader('run-29497071238'))).toBe('run-29497071238'));
    it('index v2 (no token) -> null', () => expect(parseIndexBuildId(makeIndexHeader('run-x', 2))).toBe(null));
    it('index bad magic -> null', () => { const ab = makeIndexHeader('run-x'); new DataView(ab).setUint8(0, 90); expect(parseIndexBuildId(ab)).toBe(null); });
    it('index too short -> null', () => expect(parseIndexBuildId(new ArrayBuffer(8))).toBe(null));
});
describe('runTarget — record shape, guardian/TTFB, timeout-covers-body', () => {
    it('full record shape + PASS on healthy Health, threads served_build_id', async () => {
        const ctx: any = {};
        const rec = await run('health', { fetchImpl: async () => mockRes({ status: 200, headers: { 'x-guardian-time': '3.50ms' }, text: JSON.stringify({ manifest_state: 'loaded', served_build_id: 'run-123' }) }), clock: seqClock([100, 105, 112]), ctx });
        // Schema-2 record shape lock (PROBE-OBS-01 transport evidence included).
        expect(Object.keys(rec).sort()).toEqual([
            'age_seconds', 'assertions', 'body_bytes_received', 'body_complete', 'body_evidence_truncated',
            'body_prefix_base64', 'body_sha256_received', 'body_started', 'body_suffix_base64', 'cf_cache_status',
            'cf_colo_suffix', 'cf_ray', 'error', 'failure_phase', 'guardian_ms', 'headers_received', 'http_status',
            'method', 'redirected', 'response_headers', 'response_url', 'state', 'target', 'timed_out',
            'timeout_ms', 'total_ms', 'ttfb_ms', 'url',
            'assertion_body_overflowed', 'assertion_body_limit_bytes',
        ].sort());
        expect([rec.target, rec.url, rec.http_status, rec.state]).toEqual(['health', 'https://x.test/api/v1/health', 200, 'PASS']);
        expect([rec.ttfb_ms, rec.total_ms, rec.guardian_ms, ctx.served_build_id]).toEqual([5, 12, 3.5, 'run-123']); // guardian = header, NOT timing
    });
    it('transport throw = missing evidence -> UNKNOWN (never PASS), error recorded', async () => {
        const rec = await run('health', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, ctx: {} });
        expect([rec.state, rec.http_status]).toEqual(['UNKNOWN', null]);
        expect(rec.error).toContain('ECONNREFUSED');
    });
    it('200 unparseable body -> UNKNOWN; wrong status -> FAIL', async () => {
        const unk = await run('health', { fetchImpl: async () => mockRes({ status: 200, text: '<html>not json' }), ctx: {} });
        const fail = await run('health', { fetchImpl: async () => mockRes({ status: 500, text: 'err' }), ctx: {} });
        expect([unk.state, fail.state]).toEqual(['UNKNOWN', 'FAIL']);
    });
    it('timeout covers the BODY read: headers arrive but body hangs -> abort -> UNKNOWN', async () => {
        const ac = new AbortController();
        const rec = await run('homepage', {
            timeoutMs: 20, abortFactory: () => ac,
            fetchImpl: (_u: string, init: any) => Promise.resolve({ status: 200, headers: { get: () => null }, text: () => new Promise((_r, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted by timeout'))); }) }),
            ctx: {},
        });
        expect([rec.state, rec.http_status]).toEqual(['UNKNOWN', 200]); // headers DID arrive; body read still under deadline
        expect(rec.error).toMatch(/abort/i);
    });
});
describe('runTarget — anti-vacuity semantics (a degraded-but-200 must NOT pass)', () => {
    it('search: results[] with a valid id -> PASS + threads entity_id', async () => {
        const ctx: any = {};
        const rec = await run('search', { fetchImpl: async () => mockRes({ status: 200, text: JSON.stringify({ results: [{ id: 'e1' }] }) }), searchQuery: 'llama', ctx });
        expect([rec.state, ctx.entity_id]).toEqual(['PASS', 'e1']);
        expect(rec.url).toContain('/api/v1/search?q=llama');
    });
    it('search: EMPTY results[] or non-array (degraded 200) -> FAIL (was PASS pre-D346)', async () => {
        const empty = await run('search', { fetchImpl: async () => mockRes({ status: 200, text: JSON.stringify({ results: [] }) }), searchQuery: 'q', ctx: {} });
        const notArr = await run('search', { fetchImpl: async () => mockRes({ status: 200, text: JSON.stringify({ results: 'nope' }) }), searchQuery: 'q', ctx: {} });
        expect([empty.state, notArr.state]).toEqual(['FAIL', 'FAIL']);
    });
    it('entity: returned id EQUALS requested -> PASS; {} + 200 -> FAIL; no id -> UNKNOWN', async () => {
        const pass = await run('entity', { fetchImpl: async () => mockRes({ status: 200, text: JSON.stringify({ entity: { id: 'e1' } }) }), ctx: { entity_id: 'e1' } });
        const degraded = await run('entity', { fetchImpl: async () => mockRes({ status: 200, text: '{}' }), ctx: { entity_id: 'e1' } }); // was PASS pre-D346
        const noId = await run('entity', { fetchImpl: async () => mockRes({ status: 200, text: '{}' }), ctx: {} });
        expect([pass.state, degraded.state, noId.state]).toEqual(['PASS', 'FAIL', 'UNKNOWN']);
    });
    it('homepage: contract marker present -> PASS; 200 marker ABSENT (blank/error shell) -> FAIL', async () => {
        const ok = await run('homepage', { fetchImpl: async () => mockRes({ status: 200, text: `<title>${HOMEPAGE_MARKER}</title>` }), ctx: {} });
        const bad = await run('homepage', { fetchImpl: async () => mockRes({ status: 200, text: '<html>maintenance</html>' }), ctx: {} }); // was PASS pre-D346
        expect([ok.state, bad.state]).toEqual(['PASS', 'FAIL']);
    });
    it('invalid_id_404: 404 -> PASS; 200 -> FAIL', async () => {
        const ok = await run('invalid_id_404', { fetchImpl: async () => mockRes({ status: 404, text: '' }), ctx: {} });
        const bad = await run('invalid_id_404', { fetchImpl: async () => mockRes({ status: 200, text: '{}' }), ctx: {} });
        expect([ok.state, bad.state]).toEqual(['PASS', 'FAIL']);
    });
    it('mcp_tools_list: non-empty tools array -> PASS (POST)', async () => {
        const rec = await run('mcp_tools_list', { fetchImpl: async () => mockRes({ status: 200, text: JSON.stringify({ result: { tools: [{ name: 't' }] } }) }), ctx: {} });
        expect([rec.method, rec.state]).toEqual(['POST', 'PASS']);
    });
    it('index_coherence: 206 match -> PASS; mismatch -> FAIL; 200 (no 26MB read) -> UNKNOWN', async () => {
        const base = { indexUrl: 'https://cdn.test/data/id-index.bin' };
        const pass = await run('index_coherence', { ...base, fetchImpl: async () => mockRes({ status: 206, arrayBuffer: makeIndexHeader('run-9') }), ctx: { served_build_id: 'run-9' } });
        const fail = await run('index_coherence', { ...base, fetchImpl: async () => mockRes({ status: 206, arrayBuffer: makeIndexHeader('run-8') }), ctx: { served_build_id: 'run-9' } });
        let bodyRead = false;
        const unk = await run('index_coherence', { ...base, fetchImpl: async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0); } }), ctx: { served_build_id: 'run-9' } });
        expect([pass.state, fail.state, unk.state, bodyRead, pass.url]).toEqual(['PASS', 'FAIL', 'UNKNOWN', false, 'https://cdn.test/data/id-index.bin']);
    });
});
// ── CLI: real runner, real exit codes, against a LOCAL mock server / unreachable ──
const RUNNER = fileURLToPath(new URL('../../scripts/monitoring/reliability-probe.mjs', import.meta.url));
function idxHeaderBuf(buildId: string): Buffer {
    const enc = Buffer.from(buildId, 'utf8'); const buf = Buffer.alloc(32 + enc.length);
    buf.write('IDIX', 0, 'ascii'); buf.writeUInt16LE(3, 4); buf.writeUInt32LE(1, 8); buf.writeUInt16LE(enc.length, 24); enc.copy(buf, 32);
    return buf;
}
// A unique loopback-only sentinel: the mock homepage sets it as a REAL Set-Cookie header,
// so the test below proves via the real runner+artifact that neither name nor value leaks.
const COOKIE_SENTINEL = 'probe-obs-01-setcookie-sentinel-3f9a2c7d';
function startMockServer(opts: { healthStatus?: number } = {}) {
    const build = 'run-mock-1';
    const trace: string[] = []; // method + path + query of every request ACTUALLY received
    return new Promise<{ base: string; indexUrl: string; trace: string[]; close: () => void }>((resolve) => {
        const srv = createServer((req, res) => {
            const u = new URL(req.url || '/', 'http://x'); const p = u.pathname;
            trace.push(`${req.method} ${p}${u.search}`);
            const json = (o: any, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (p === '/api/v1/health') return (opts.healthStatus && opts.healthStatus !== 200) ? (res.writeHead(opts.healthStatus), res.end('err')) : json({ manifest_state: 'loaded', served_build_id: build });
            if (p === '/api/v1/search') return json({ results: [{ id: 'mock-entity-1' }] });
            if (p === '/api/v1/entity/mock-entity-1') return json({ entity: { id: 'mock-entity-1' } });
            if (p.startsWith('/api/v1/entity/')) return json({ error: 'nf' }, 404);
            if (p === '/openapi.json') return json({ openapi: '3.0.3' });
            if (p === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${COOKIE_SENTINEL}; Path=/; HttpOnly` }); return res.end(`<title>${HOMEPAGE_MARKER}</title>`); }
            if (p === '/data/id-index.bin') { res.writeHead(206, { 'content-range': 'bytes 0-255/26000000' }); return res.end(idxHeaderBuf(build)); }
            if (p === '/api/mcp') { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { let m: any = {}; try { m = JSON.parse(d); } catch { /* noop */ } return m.method === 'tools/list' ? json({ result: { tools: [{ name: 't' }] } }) : json({ result: { serverInfo: { name: 'f2ai-mcp' } } }); }); return; }
            json({ error: 'nf' }, 404);
        });
        srv.listen(0, '127.0.0.1', () => { const base = `http://127.0.0.1:${(srv.address() as any).port}`; resolve({ base, indexUrl: `${base}/data/id-index.bin`, trace, close: () => srv.close() }); });
    });
}
function runProbe(extra: Record<string, string>): Promise<{ code: number | null; evidence: any }> {
    const out = join(mkdtempSync(join(tmpdir(), 'probe-')), 'evidence.json');
    return new Promise((resolve) => {
        spawn(process.execPath, [RUNNER, out], { env: { ...process.env, PROBE_TIMEOUT_MS: '4000', ...extra }, stdio: 'ignore' })
            .on('close', (code) => resolve({ code, evidence: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null }));
    });
}
describe('reliability-probe CLI — honest three-state exit codes + crash evidence', () => {
    it('all targets healthy -> exit 0 (PASS)', async () => {
        const srv = await startMockServer();
        try { const { code, evidence } = await runProbe({ PROBE_BASE_URL: srv.base, PROBE_INDEX_URL: srv.indexUrl }); expect([code, evidence.overall]).toEqual([0, 'PASS']); }
        finally { srv.close(); }
    });
    // SF-B: the REAL spawned runner, driven through a genuine non-PASS target, must
    // issue EXACTLY these nine loopback requests. Pinned as an INDEPENDENT LITERAL --
    // never derived from buildTargetSpecs(). A runner-loop retry (re-running a target
    // whose state is not PASS) would add a request and discard the first failure, so
    // this is the behaviour-level guard against verdict laundering in the runner.
    const CLI_TRACE = ['GET /api/v1/health', 'GET /api/v1/search?q=llama',
        'GET /api/v1/entity/mock-entity-1', 'GET /api/v1/entity/__reliability_probe_invalid_id__',
        'GET /openapi.json', 'GET /', 'POST /api/mcp', 'POST /api/mcp', 'GET /data/id-index.bin'];
    it('a target returns 500 -> exit 1 (FAIL) and the runner issues EXACTLY nine requests, no retry', async () => {
        const srv = await startMockServer({ healthStatus: 500 });
        try {
            const { code, evidence } = await runProbe({ PROBE_BASE_URL: srv.base, PROBE_INDEX_URL: srv.indexUrl });
            expect([code, evidence.overall]).toEqual([1, 'FAIL']);
            expect(srv.trace).toEqual(CLI_TRACE); // exact order, exact count, exact methods
            expect([srv.trace.length, srv.trace.filter((t) => t === 'POST /api/mcp').length]).toEqual([9, 2]);
            expect(srv.trace.filter((t) => t.startsWith('GET /api/v1/health')).length).toBe(1); // NOT retried
            for (const t of srv.trace) expect(t).not.toMatch(/[?&](_|cb|cachebust|nocache|bust|ts|v)=/i);
            // The FIRST health failure is retained as FAIL, not replaced by a 2nd attempt.
            const health = evidence.targets.filter((t: any) => t.target === 'health');
            expect([health.length, health[0].state, health[0].http_status]).toEqual([1, 'FAIL', 500]);
            expect(evidence.targets.length).toBe(9);
        } finally { srv.close(); }
    });
    it('unreachable host -> exit 2 (UNKNOWN) + evidence still written, schedule NOT fabricated', async () => {
        const { code, evidence } = await runProbe({ PROBE_BASE_URL: 'http://127.0.0.1:1', PROBE_INDEX_URL: 'http://127.0.0.1:1/x', PROBE_TIMEOUT_MS: '1500' });
        expect([code, evidence.overall, evidence.scheduled_utc, evidence.schedule_delay_ms]).toEqual([2, 'UNKNOWN', null, null]);
    });
    it('harness crash -> writes minimal UNKNOWN evidence THEN exits 2 (never nothing)', async () => {
        const { code, evidence } = await runProbe({ PROBE_FORCE_CRASH: '1' });
        expect(evidence).not.toBe(null);
        expect([code, evidence.overall, evidence.crashed]).toEqual([2, 'UNKNOWN', true]);
        expect(evidence.schema_version).toBe(2); // literal, NOT the imported constant
    });
    it('a loopback Set-Cookie sentinel never reaches the written evidence artifact', async () => {
        const srv = await startMockServer();
        try {
            // Real runner, real artifact, loopback only -- no external network request.
            const { code, evidence } = await runProbe({ PROBE_BASE_URL: srv.base, PROBE_INDEX_URL: srv.indexUrl });
            const serialized = JSON.stringify(evidence);
            expect([code, evidence.overall, evidence.schema_version]).toEqual([0, 'PASS', 2]);
            expect(serialized).not.toContain(COOKIE_SENTINEL);        // no cookie VALUE
            expect(serialized.toLowerCase()).not.toContain('set-cookie'); // no header NAME
            const home = evidence.targets.find((t: any) => t.target === 'homepage');
            expect(home.response_headers['content-type']).toBe('text/html'); // allowlist still captured
            expect(home.assertion_body_overflowed).toBe(false);
        } finally { srv.close(); }
    });
});
