/**
 * D-2026-0717-345 P1a — external synthetic reliability probe: PURE CORE.
 * Network-injected, side-effect-free helpers, unit-testable with a mocked fetch; the
 * runner (reliability-probe.mjs) wires real fetch + env + artifact I/O. Read-only: no
 * R2 write, no Factory, no user data. Three-state: a target that did not execute OR
 * lacks evidence is UNKNOWN, NEVER PASS. Anti-vacuity (D-346): a degraded-but-200
 * service must FAIL, so the semantic asserts check a real contract marker below.
 */

export const PROBE_SCHEMA_VERSION = 1;

// A STABLE Free2AITools homepage contract marker (the registry's title tagline).
// The homepage target asserts it is PRESENT, so a blank/degraded 200 shell FAILS.
export const HOMEPAGE_MARKER = 'The Open-Source AI Registry';

/** Parse the middleware `X-Guardian-Time` header ("12.34ms") -> number ms, or null. */
export function parseGuardianTime(headers) {
    const raw = headers && typeof headers.get === 'function' ? headers.get('x-guardian-time') : null;
    if (!raw) return null;
    const n = parseFloat(String(raw).replace(/ms$/i, '').trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Three-state from assertions [{ ok }] (true=held / false=violated / null=missing
 * evidence). Not-executed or empty = UNKNOWN; any violation = FAIL; a null with no
 * violation = UNKNOWN (never laundered to PASS); all-held = PASS.
 */
export function classifyState(executed, assertions) {
    if (!executed) return 'UNKNOWN';
    if (!Array.isArray(assertions) || assertions.length === 0) return 'UNKNOWN';
    if (assertions.some((a) => a && a.ok === false)) return 'FAIL';
    if (assertions.some((a) => !a || a.ok == null)) return 'UNKNOWN';
    return 'PASS';
}

/** Overall verdict: PASS iff EVERY target PASS; FAIL if any FAIL; else UNKNOWN. */
export function overallVerdict(records) {
    if (!Array.isArray(records) || records.length === 0) return 'UNKNOWN';
    if (records.some((r) => r.state === 'FAIL')) return 'FAIL';
    if (records.some((r) => r.state !== 'PASS')) return 'UNKNOWN';
    return 'PASS';
}

/**
 * Parse a data/id-index.bin header (public Range read) -> stamped build_id or null.
 * Mirrors src/lib/id-index-reader.ts parseHeader: magic "IDIX", version>=3 carries
 * buildIdLen@24 + the build_id UTF-8 string at offset 32. Degrades to null, no throw.
 */
export function parseIndexBuildId(ab) {
    if (!ab || ab.byteLength < 32) return null;
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'IDIX') return null;
    const version = dv.getUint16(4, true);
    if (version < 3) return null; // v2 has no build_id token
    const len = dv.getUint16(24, true);
    if (len <= 0 || 32 + len > dv.byteLength) return null;
    try {
        return new TextDecoder().decode(new Uint8Array(ab, 32, len)) || null;
    } catch {
        return null;
    }
}

/**
 * Minimal evidence for a HARNESS-level crash: no per-target verdicts, so overall is
 * UNKNOWN (a crash is NEVER a PASS). The runner writes this BEFORE process.exit(2)
 * so a crashed probe still leaves an artifact, not nothing. No fabricated schedule.
 */
export function buildCrashEvidence(err, meta) {
    const m = meta || {};
    return {
        schema_version: PROBE_SCHEMA_VERSION,
        run_utc: m.run_utc || new Date().toISOString(),
        base_host: m.base_host || null,
        cron: m.cron || null,
        scheduled_utc: null,
        schedule_delay_ms: null,
        served_build_id: null,
        overall: 'UNKNOWN',
        crashed: true,
        error: err && err.message ? String(err.message) : String(err),
        targets: [],
        github: m.github || null,
    };
}

/** Try JSON.parse; return { ok, value } without throwing. */
function tryJson(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false, value: null };
    }
}

/**
 * Ordered target specs. `assert(res, body, ctx)` returns an assertion list and may
 * thread evidence through `ctx` (served_build_id, entity_id) to later targets.
 * `readBody`: 'text' (default) | 'arraybuffer' | false; `url(deps)` overrides path.
 */
export function buildTargetSpecs() {
    return [
        {
            name: 'health', method: 'GET', path: '/api/v1/health',
            assert(res, body, ctx) {
                const j = tryJson(body);
                if (res.status === 200 && j.ok) ctx.served_build_id = j.value.served_build_id ?? null;
                const state = j.ok ? j.value.manifest_state : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'json_parses', ok: j.ok ? true : null },
                    { name: 'manifest_state_valid', ok: j.ok ? ['loaded', 'fallback', 'unavailable'].includes(state) : null },
                ];
            },
        },
        {
            name: 'search', method: 'GET',
            url: (d) => `${d.baseUrl}/api/v1/search?q=${encodeURIComponent(d.searchQuery)}`,
            assert(res, body, ctx) {
                // Anti-vacuity: require >=1 result with a valid non-empty string id;
                // an empty results[] (a degraded-but-200 response) must NOT pass.
                const j = tryJson(body);
                const arr = j.ok && Array.isArray(j.value.results) ? j.value.results : null;
                const first = arr && arr[0];
                const firstId = first && typeof first.id === 'string' && first.id.length > 0 ? first.id : null;
                if (firstId) ctx.entity_id = firstId;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'results_nonempty_with_id', ok: j.ok ? !!firstId : null },
                ];
            },
        },
        {
            name: 'entity', method: 'GET',
            url: (d) => {
                const id = d.entityId || (d.ctx && d.ctx.entity_id);
                return id ? `${d.baseUrl}/api/v1/entity/${encodeURIComponent(id)}` : `${d.baseUrl}/api/v1/entity/`;
            },
            assert(res, body, ctx) {
                // Anti-vacuity: returned entity id MUST equal the requested id; a
                // `{}` + 200 (no entity) is degraded -> FAIL, never PASS.
                const id = ctx.entity_id || null;
                if (!id) return [{ name: 'entity_id_available', ok: null }];
                const j = tryJson(body);
                const returnedId = j.ok && j.value.entity ? j.value.entity.id : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'entity_id_echoes_request', ok: j.ok ? returnedId === id : null },
                ];
            },
        },
        {
            name: 'invalid_id_404', method: 'GET',
            path: '/api/v1/entity/__reliability_probe_invalid_id__',
            assert(res) {
                return [{ name: 'status_404', ok: res.status === 404 }];
            },
        },
        {
            name: 'openapi', method: 'GET', path: '/openapi.json',
            assert(res, body) {
                const j = tryJson(body);
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'openapi_field_present', ok: j.ok ? typeof j.value.openapi === 'string' : null },
                ];
            },
        },
        {
            name: 'homepage', method: 'GET', path: '/',
            assert(res, body) {
                // Anti-vacuity: require the brand contract marker, NOT just non-empty.
                const hasMarker = typeof body === 'string' && body.includes(HOMEPAGE_MARKER);
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'home_contract_marker', ok: typeof body === 'string' ? hasMarker : null },
                ];
            },
        },
        {
            name: 'mcp_initialize', method: 'POST', path: '/api/mcp',
            init: () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }),
            assert(res, body) {
                const j = tryJson(body);
                const server = j.ok && j.value.result ? j.value.result.serverInfo : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'serverInfo_present', ok: j.ok ? !!(server && server.name) : null },
                ];
            },
        },
        {
            name: 'mcp_tools_list', method: 'POST', path: '/api/mcp',
            init: () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }),
            assert(res, body) {
                const j = tryJson(body);
                const tools = j.ok && j.value.result ? j.value.result.tools : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'tools_nonempty_array', ok: j.ok ? Array.isArray(tools) && tools.length > 0 : null },
                ];
            },
        },
        {
            name: 'index_coherence', method: 'GET',
            url: (d) => d.indexUrl,
            init: () => ({ headers: { Range: 'bytes=0-255' } }),
            readBody: 'arraybuffer',
            assert(res, body, ctx) {
                // Only a 206 is trusted; a 200 = full ~26MB blob (never read) -> UNKNOWN.
                if (res.status !== 206) return [{ name: 'range_read_supported', ok: null }];
                const indexBuildId = parseIndexBuildId(body);
                const served = ctx.served_build_id || null;
                const ok = !indexBuildId || !served ? null : indexBuildId === served;
                return [{ name: 'index_manifest_coherent', ok, index_build_id: indexBuildId, served_build_id: served }];
            },
        },
    ];
}

/**
 * Execute ONE target against an injected fetch -> structured record (external total +
 * TTFB, guardian/origin time, HTTP status, semantic assertions, three-state). A
 * transport throw = missing evidence -> UNKNOWN (never a masked PASS); a violated
 * assertion -> FAIL. Timeout (D-346): ONE deadline (deps.timeoutMs, default 30s)
 * covers BOTH the response headers AND the full (size-bounded) body read, cleared
 * only AFTER the body is read or the op aborts (previously it cleared on headers, so
 * a hung body could run to the 10-min workflow cap — now it cannot).
 */
export async function runTarget(spec, deps) {
    const clock = deps.clock || (() => Date.now());
    const ctx = deps.ctx || {};
    const timeoutMs = deps.timeoutMs || 30000;
    const makeController = deps.abortFactory || (() => new AbortController());
    const url = spec.url ? spec.url({ ...deps, ctx }) : `${deps.baseUrl}${spec.path}`;
    const rec = {
        target: spec.name, url, method: spec.method || 'GET',
        http_status: null, total_ms: null, ttfb_ms: null, guardian_ms: null,
        assertions: [], state: 'UNKNOWN', error: null,
    };
    let executed = false;
    const ac = makeController();
    const timer = setTimeout(() => { try { ac.abort(new Error(`probe timeout after ${timeoutMs}ms`)); } catch { /* noop */ } }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
        const baseInit = spec.init ? spec.init({ ...deps, ctx }) : {};
        const init = { ...(baseInit || {}), signal: ac.signal };
        const t0 = clock();
        const res = await deps.fetchImpl(url, init);
        rec.ttfb_ms = clock() - t0; // fetch resolves on response headers ~= first byte
        rec.http_status = res.status;
        rec.guardian_ms = parseGuardianTime(res.headers);
        let body = null; // read stays UNDER the same deadline: a hung body aborts
        if (spec.readBody === 'arraybuffer') {
            body = res.status === 206 ? await res.arrayBuffer() : null;
        } else if (spec.readBody !== false) {
            body = await res.text();
        }
        rec.total_ms = clock() - t0;
        executed = true;
        rec.assertions = spec.assert(res, body, ctx) || [];
    } catch (e) {
        rec.error = e && e.message ? String(e.message) : String(e);
        executed = false; // no response / aborted = missing evidence
    } finally {
        clearTimeout(timer);
    }
    rec.state = classifyState(executed, rec.assertions);
    return rec;
}
