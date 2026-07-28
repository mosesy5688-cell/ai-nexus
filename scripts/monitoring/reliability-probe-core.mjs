/**
 * D-2026-0717-345 P1a — external synthetic reliability probe: PURE CORE.
 * Network-injected, side-effect-free helpers, unit-testable with a mocked fetch; the
 * runner (reliability-probe.mjs) wires real fetch + env + artifact I/O. Read-only: no
 * R2 write, no Factory, no user data. Three-state: a target that did not execute OR
 * lacks evidence is UNKNOWN, NEVER PASS. Anti-vacuity (D-346): a degraded-but-200
 * service must FAIL, so the semantic asserts check a real contract marker below.
 *
 * PROBE-OBS-01 (schema 2) — TRANSPORT EVIDENCE. The probe previously recorded only
 * that a body read did not finish inside the deadline, which cannot discriminate
 * between the co-equal candidate causes of an incomplete read: a Cloudflare
 * edge/cache/stream anomaly, an origin-to-edge or SSR stream termination anomaly, a
 * Node/Undici transport interaction, a compression or framing anomaly, or another
 * intermediary-path anomaly. This module now records, per target, the response-header
 * evidence available the moment headers arrive and BOUNDED body-read evidence
 * (incremental byte count + incremental SHA-256 + a bounded prefix/suffix) that is
 * preserved even when the read is aborted. No candidate cause is preferred here; the
 * fields exist so a later comparison can be made from recorded facts.
 */
import { createHash } from 'node:crypto';

export const PROBE_SCHEMA_VERSION = 2;

/**
 * The EXACT public response headers captured into evidence. This is a frozen pull
 * list: `snapshotResponseHeaders` reads headers BY NAME from this constant and never
 * enumerates/serializes a response's header collection, so no header outside this
 * list (notably `set-cookie`, `cookie`, `authorization`, `proxy-authorization`, or
 * any credential/token header) can reach the artifact. A header that is absent stays
 * null and is NEVER substituted with an assumed value.
 */
export const RESPONSE_HEADER_ALLOWLIST = Object.freeze([
    'cf-ray', 'cf-cache-status', 'age', 'cache-control', 'content-type',
    'content-length', 'content-encoding', 'transfer-encoding', 'etag', 'vary',
    'server', 'cf-mitigated',
]);

/** Max bytes retained per edge (prefix AND suffix) in the evidence artifact. */
export const BODY_EVIDENCE_EDGE_BYTES = 512;

/**
 * Ceiling on bytes retained in memory to hand a COMPLETE body to the existing
 * assertions. Evidence (count/hash/prefix/suffix) stays bounded regardless; this only
 * bounds the assertion buffer. Past it the retained buffers are RELEASED, the record
 * discloses `assertion_body_overflowed`, and the body-dependent assertions evaluate to
 * a NAMED null -> UNKNOWN (never a laundered PASS, and never a transport failure).
 * This is a real limit, not an unreachable one: no claim is made that a future probed
 * response stays under it, which is exactly why the overflow is disclosed.
 */
export const MAX_ASSERTION_BODY_BYTES = 32 * 1024 * 1024;

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
 * Snapshot ONLY `RESPONSE_HEADER_ALLOWLIST`, by name, into a plain object. An absent
 * header is null; it is never turned into `HIT`, `MISS`, `BYPASS`, `chunked` or any
 * other assumed value. Callers must only invoke this AFTER headers actually arrived —
 * a target whose headers never arrived keeps `response_headers: null` so the artifact
 * cannot be misread as "these headers were observed empty".
 */
export function snapshotResponseHeaders(headers) {
    const get = headers && typeof headers.get === 'function' ? (n) => headers.get(n) : () => null;
    const out = {};
    for (const name of RESPONSE_HEADER_ALLOWLIST) {
        const v = get(name);
        out[name] = v == null ? null : String(v);
    }
    return out;
}

/**
 * Derive the separately-addressable transport fields from an allowlist snapshot.
 * Every one degrades to null when its source header is absent or unparseable: a
 * missing `cf-cache-status` stays null (NOT an inferred disposition) and a missing
 * `age` stays null (NOT 0). `cf_colo_suffix` is parsed from the cf-ray trailer only;
 * it is a Cloudflare colo token and is unrelated to any CI runner region.
 */
export function deriveTransportEvidence(snapshot) {
    const s = snapshot || {};
    const ray = s['cf-ray'] == null ? null : String(s['cf-ray']);
    const coloMatch = ray ? /-([A-Za-z]{3})\s*$/.exec(ray) : null;
    const ageRaw = s.age == null ? null : String(s.age).trim();
    return {
        cf_ray: ray,
        cf_colo_suffix: coloMatch ? coloMatch[1].toUpperCase() : null,
        cf_cache_status: s['cf-cache-status'] == null ? null : String(s['cf-cache-status']),
        age_seconds: ageRaw && /^\d+$/.test(ageRaw) ? Number(ageRaw) : null,
    };
}

/**
 * Zeroed body-read evidence. `timeout_ms` is the ONE deadline that covers headers AND
 * the full body read. All fields start at "nothing observed yet" so an abort at any
 * point leaves a truthful partial record rather than a fabricated one.
 */
export function newBodyEvidence(timeoutMs) {
    return {
        body_started: false,
        body_complete: false,
        body_bytes_received: 0,
        body_sha256_received: null,
        body_prefix_base64: null,
        body_suffix_base64: null,
        body_evidence_truncated: false,
        // Stable shape: present and false BEFORE any body is read, so absence of the
        // field never has to be interpreted, and the limit is null until it applies.
        assertion_body_overflowed: false,
        assertion_body_limit_bytes: null,
        failure_phase: null,
        timed_out: false,
        timeout_ms: timeoutMs == null ? null : timeoutMs,
    };
}

/** Normalize a stream chunk to a Buffer without copying when it is already bytes. */
function toBuffer(chunk) {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
    return Buffer.from(String(chunk), 'utf8');
}

/**
 * Bounded recorder: counts every byte, hashes every byte incrementally, and retains
 * ONLY a bounded prefix + a rolling bounded suffix for the artifact.
 *
 * Memory, stated precisely: the STEADY retained evidence is O(edgeBytes) regardless of
 * body size; PROCESSING transiently also holds the current transport chunk (and, in
 * the non-streaming fallback, whatever whole value that implementation itself
 * allocates before handing it here); the SEPARATE assertion buffer is capped by
 * maxRetain and is RELEASED the moment the cap is exceeded. No claim is made that
 * total process memory is independent of body size for an arbitrary implementation.
 */
function makeBodyRecorder(ev, edgeBytes, maxRetain) {
    const hash = createHash('sha256');
    let prefix = Buffer.alloc(0);
    let suffix = Buffer.alloc(0);
    let retained = [];
    let retainedBytes = 0;
    let overflow = false;
    let finalized = false;
    return {
        chunk(raw) {
            const buf = toBuffer(raw);
            if (buf.length === 0) return;
            hash.update(buf);
            ev.body_bytes_received += buf.length;
            if (prefix.length < edgeBytes) prefix = Buffer.concat([prefix, buf.subarray(0, edgeBytes - prefix.length)]);
            const merged = Buffer.concat([suffix, buf]);
            suffix = merged.length > edgeBytes ? Buffer.from(merged.subarray(merged.length - edgeBytes)) : merged;
            if (overflow) return;
            // SF-1: retain an OWNED SNAPSHOT, never an alias of transport memory.
            // toBuffer() may hand back a VIEW over a buffer the transport still owns
            // and is free to overwrite before the stream ends. Retaining that view
            // would let the assertions run against bytes that were never delivered
            // while body_sha256_received attests the bytes that WERE delivered -- a
            // silent divergence between the hash the artifact swears to and the bytes
            // that produced the verdict. Copy here so assertion input is provably the
            // same delivered byte sequence the hash covers. Bounded: the copy is
            // charged against the SAME maxRetain budget checked immediately below,
            // so this adds no duplication beyond the existing retention contract.
            if (retainedBytes + buf.length > maxRetain) {
                // RELEASE the retained assertion buffers and DISCLOSE the overflow.
                // Byte counting, hashing and prefix/suffix collection continue in
                // full above this line: overflow costs the assertion body, never the
                // transport evidence this probe exists to capture.
                overflow = true;
                retained = [];
                retainedBytes = 0;
                ev.assertion_body_overflowed = true;
                return;
            }
            retained.push(Buffer.from(buf)); // owned snapshot (SF-1), not the view
            retainedBytes += buf.length;
        },
        overflowed() { return overflow; },
        /** Idempotent: runs in a finally so an ABORT still writes what was collected. */
        finalize() {
            if (finalized) return;
            finalized = true;
            // Only hash bytes that actually arrived: 0 bytes stays null so the record
            // cannot be misread as "an empty document was delivered and hashed".
            if (ev.body_bytes_received > 0) ev.body_sha256_received = hash.digest('hex');
            ev.body_prefix_base64 = prefix.length ? prefix.toString('base64') : null;
            ev.body_suffix_base64 = suffix.length ? suffix.toString('base64') : null;
            ev.body_evidence_truncated = ev.body_bytes_received > prefix.length + suffix.length;
        },
        assembled() { return overflow ? null : Buffer.concat(retained, retainedBytes); },
    };
}

/**
 * Read the body under the caller's already-armed deadline while mutating `ev` in
 * place, so an abort mid-read leaves every byte/hash/prefix/suffix fact collected so
 * far in the record. Returns the COMPLETE decoded body for the existing assertions
 * when the read finishes (text -> string, arraybuffer -> ArrayBuffer), else null.
 *
 * Byte accounting note: bytes are counted as delivered to this consumer, i.e. AFTER
 * any content decoding the transport performed, so `body_bytes_received` is not
 * expected to equal a `content-length` that describes an encoded payload. Both are
 * recorded separately rather than reconciled here.
 */
export async function readBodyWithEvidence(res, spec, ev, opts) {
    const o = opts || {};
    const pos = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
    const edge = pos(o.edgeBytes, BODY_EVIDENCE_EDGE_BYTES);
    const maxRetain = pos(o.maxAssertionBodyBytes, MAX_ASSERTION_BODY_BYTES);
    const wantsBuffer = spec.readBody === 'arraybuffer';
    // Unchanged pre-existing contract: a non-206 index response is a full ~26MB blob
    // and is NEVER read (see the index_coherence spec) -> UNKNOWN, not a huge read.
    if (spec.readBody === false || (wantsBuffer && res.status !== 206)) return null;
    ev.body_started = true;
    ev.assertion_body_limit_bytes = maxRetain; // the limit ACTUALLY applied to this read
    const rec = makeBodyRecorder(ev, edge, maxRetain);
    try {
        const stream = res.body && typeof res.body.getReader === 'function' ? res.body : null;
        if (!stream) {
            // Response without a byte stream (mocks / non-streaming impls): read whole,
            // then record the same bounded evidence over its bytes. The retention cap
            // applies IDENTICALLY here -- an over-limit body is never handed to the
            // assertions on this path either, and the overflow is disclosed, not
            // silently bypassed. (The non-streaming implementation may itself have
            // allocated the whole value before we ever see it; that is its allocation,
            // and it is exactly why no unqualified memory claim is made.)
            const whole = wantsBuffer ? await res.arrayBuffer() : await res.text();
            if (whole != null) rec.chunk(wantsBuffer ? whole : Buffer.from(String(whole), 'utf8'));
            ev.body_complete = true;
            return rec.overflowed() ? null : whole;
        }
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) rec.chunk(value);
        }
        ev.body_complete = true;
    } finally {
        rec.finalize();
    }
    const assembled = rec.assembled();
    if (assembled == null) return null; // past the retention cap: no body for assertions
    if (!wantsBuffer) return assembled.toString('utf8');
    return assembled.buffer.slice(assembled.byteOffset, assembled.byteOffset + assembled.byteLength);
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
        runner: m.runner || null,
        node: m.node || null,
    };
}

/**
 * TOTAL, never-throwing body parse with THREE distinguishable outcomes:
 *   ok === null   body UNAVAILABLE  - no body string reached the assertions (assertion
 *                                     retention overflowed, or none was read). Parsing
 *                                     was not attempted; body-dependent assertions
 *                                     must evaluate to a NAMED null -> UNKNOWN.
 *   ok === false  body present but MALFORMED JSON - parse failed.
 *   ok === true   body present and PARSED. `value` may legitimately be the JSON literal
 *                                     `null` (or a number/string), which is a SUCCESSFUL
 *                                     parse of a document that simply lacks the required
 *                                     fields -> the ordinary contract verdict, normally
 *                                     FAIL. `obj` is the parsed value ONLY when it is a
 *                                     non-null object, so every dereference below is
 *                                     null-safe without a per-site guard and a literal
 *                                     `null` can never raise a TypeError.
 */
function tryJson(body) {
    if (typeof body !== 'string') return { ok: null, value: null, obj: null };
    try {
        const value = JSON.parse(body);
        return { ok: true, value, obj: value !== null && typeof value === 'object' ? value : null };
    } catch {
        return { ok: false, value: null, obj: null };
    }
}

/** Narrow a possibly-absent nested field to a non-null object, else null. */
function objField(obj, key) {
    const v = obj ? obj[key] : null;
    return v !== null && typeof v === 'object' ? v : null;
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
                // `served_build_id` is recorded VERBATIM. Its hyphen-delimited parts
                // are NOT parsed anywhere in this package; no meaning is derived here.
                const j = tryJson(body);
                if (res.status === 200 && j.obj) ctx.served_build_id = j.obj.served_build_id ?? null;
                const state = j.obj ? j.obj.manifest_state : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'json_parses', ok: j.ok === true ? true : null },
                    { name: 'manifest_state_valid', ok: j.ok === true ? ['loaded', 'fallback', 'unavailable'].includes(state) : null },
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
                const arr = j.obj && Array.isArray(j.obj.results) ? j.obj.results : null;
                const first = arr && arr.length > 0 ? arr[0] : null;
                const firstId = first && typeof first.id === 'string' && first.id.length > 0 ? first.id : null;
                if (firstId) ctx.entity_id = firstId;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'results_nonempty_with_id', ok: j.ok === true ? !!firstId : null },
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
                const entity = objField(j.obj, 'entity');
                const returnedId = entity ? entity.id : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'entity_id_echoes_request', ok: j.ok === true ? returnedId === id : null },
                ];
            },
        },
        {
            name: 'invalid_id_404', method: 'GET',
            path: '/api/v1/entity/__reliability_probe_invalid_id__',
            assert(res) {
                // DELIBERATELY status-only. This contract does not depend on body
                // content, so it stays evaluable (and may PASS) even when the
                // assertion body was released on retention overflow. That is a
                // designed property of a status-only contract, NOT an accidental
                // exception to the overflow rule -- it is asserted as such in tests.
                return [{ name: 'status_404', ok: res.status === 404 }];
            },
        },
        {
            name: 'openapi', method: 'GET', path: '/openapi.json',
            assert(res, body) {
                const j = tryJson(body);
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'openapi_field_present', ok: j.ok === true ? typeof (j.obj ? j.obj.openapi : null) === 'string' : null },
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
                const server = objField(objField(j.obj, 'result'), 'serverInfo');
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'serverInfo_present', ok: j.ok === true ? !!(server && server.name) : null },
                ];
            },
        },
        {
            name: 'mcp_tools_list', method: 'POST', path: '/api/mcp',
            init: () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }),
            assert(res, body) {
                const j = tryJson(body);
                const result = objField(j.obj, 'result');
                const tools = result ? result.tools : null;
                return [
                    { name: 'status_200', ok: res.status === 200 },
                    { name: 'tools_nonempty_array', ok: j.ok === true ? Array.isArray(tools) && tools.length > 0 : null },
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
 * TTFB, guardian/origin time, HTTP status, transport evidence, semantic assertions,
 * three-state). A transport throw = missing evidence -> UNKNOWN (never a masked PASS);
 * a violated assertion on an EXECUTED response -> FAIL. Timeout (D-346): ONE deadline
 * (deps.timeoutMs, default 30s) covers BOTH the response headers AND the full body
 * read, cleared only AFTER the body is read or the op aborts — it is NOT cleared when
 * headers arrive, so a body that never completes still aborts at the deadline.
 *
 * PROBE-OBS-01: the header snapshot + derived transport fields are taken immediately
 * after headers arrive, and body evidence mutates this record in place, so a body
 * abort preserves everything observed before it. A body timeout after an HTTP 200
 * remains UNKNOWN (incomplete transport evidence); it is NOT relabelled FAIL. No
 * retry, no cache-busting request, and no extra request is issued anywhere.
 *
 * Deadline truth does NOT depend on the transport honouring AbortSignal. The phase is
 * captured AT THE INSTANT the deadline fires (never inferred from later state), and
 * `timed_out` reflects that the timer fired on EVERY exit path, not only inside catch.
 * A transport that ignores the abort and completes afterwards therefore still yields
 * UNKNOWN with timed_out=true: a later body_complete=true is kept as an eventual-
 * completion FACT, and it does not erase the missed-deadline verdict.
 */
export async function runTarget(spec, deps) {
    const clock = deps.clock || (() => Date.now());
    const ctx = deps.ctx || {};
    const timeoutMs = deps.timeoutMs || 30000;
    const makeController = deps.abortFactory || (() => new AbortController());
    const url = spec.url ? spec.url({ ...deps, ctx }) : `${deps.baseUrl}${spec.path}`;
    const rec = {
        target: spec.name, url, method: spec.method || 'GET',
        headers_received: false, response_url: null, redirected: null,
        http_status: null, total_ms: null, ttfb_ms: null, guardian_ms: null,
        // Populated ONLY once headers arrive; null here means "never observed".
        response_headers: null, cf_ray: null, cf_colo_suffix: null,
        cf_cache_status: null, age_seconds: null,
        ...newBodyEvidence(timeoutMs),
        assertions: [], state: 'UNKNOWN', error: null,
    };
    let executed = false;
    let timerFired = false;
    let deadlinePhase = null;
    let assertionFaulted = false;
    const ac = makeController();
    const timer = setTimeout(() => {
        timerFired = true;
        // Phase captured HERE, at the firing instant -- not reconstructed afterwards
        // from a record the transport may keep mutating if it ignores the abort.
        deadlinePhase = !rec.headers_received ? 'headers' : (rec.body_complete ? null : 'body');
        try { ac.abort(new Error(`probe timeout after ${timeoutMs}ms`)); } catch { /* noop */ }
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
        const baseInit = spec.init ? spec.init({ ...deps, ctx }) : {};
        const init = { ...(baseInit || {}), signal: ac.signal };
        const t0 = clock();
        const res = await deps.fetchImpl(url, init);
        rec.ttfb_ms = clock() - t0; // fetch resolves on response headers ~= first byte
        rec.headers_received = true;
        rec.http_status = res.status;
        rec.response_url = typeof res.url === 'string' && res.url ? res.url : null;
        rec.redirected = typeof res.redirected === 'boolean' ? res.redirected : null;
        rec.response_headers = snapshotResponseHeaders(res.headers);
        Object.assign(rec, deriveTransportEvidence(rec.response_headers));
        rec.guardian_ms = parseGuardianTime(res.headers);
        let body = null;
        try {
            // Read stays UNDER the same deadline; a hung body aborts, keeping evidence.
            body = await readBodyWithEvidence(res, spec, rec, { edgeBytes: deps.bodyEdgeBytes, maxAssertionBodyBytes: deps.maxAssertionBodyBytes });
        } finally {
            // The transport deadline covers headers AND the full body operation, and is
            // cleared the moment that operation resolves or rejects: never earlier
            // (headers do NOT clear it) and never later, so synchronous assertion work
            // below can neither be charged to nor redefine the transport deadline.
            clearTimeout(timer);
        }
        rec.total_ms = clock() - t0;
        executed = true;
        try {
            rec.assertions = spec.assert(res, body, ctx) || [];
        } catch (assertErr) {
            // SF-2: the body operation ALREADY resolved (the deadline is cleared and
            // body_complete is settled) before this line runs, so a throw here is an
            // ASSERTION-phase fault and can never be a transport body failure. It is
            // caught HERE rather than falling through to the transport catch below,
            // which would mislabel it failure_phase='body' and make the artifact
            // accuse the transport of a fault that provably happened after delivery.
            rec.error = assertErr && assertErr.message ? String(assertErr.message) : String(assertErr);
            rec.assertions = [];
            executed = false; // no usable verdict -> UNKNOWN, never a fabricated FAIL
            assertionFaulted = true;
        }
    } catch (e) {
        rec.error = e && e.message ? String(e.message) : String(e);
        executed = false; // no response / aborted = missing evidence
        rec.failure_phase = rec.headers_received ? 'body' : 'headers';
    } finally {
        clearTimeout(timer);
        // EVERY exit path, not just catch: whether the transport honoured the abort or
        // ignored it and completed, a fired deadline is recorded as a fired deadline.
        rec.timed_out = timerFired;
    }
    rec.state = classifyState(executed, rec.assertions);
    // An assertion violated on a COMPLETED response is a distinct phase from a
    // transport failure: FAIL here means the service answered and broke a contract.
    if (rec.state === 'FAIL' || assertionFaulted) rec.failure_phase = 'assertion';
    if (rec.timed_out) {
        // The deadline expired before the operation finished. The evidence for this
        // target is incomplete-by-deadline, so it is UNKNOWN: never PASS, and not
        // upgraded to FAIL either (a deadline-compromised observation must not be used
        // to accuse the service of a contract violation). body_complete may remain true
        // as an eventual-completion fact; the phase is the one captured at fire time.
        rec.state = 'UNKNOWN';
        rec.failure_phase = deadlinePhase;
    }
    return rec;
}
