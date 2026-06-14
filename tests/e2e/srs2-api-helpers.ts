/**
 * SRS-2 API/MCP/Cross-Consumer baseline — shared fetch helpers (Founder-exact).
 *
 * Permanentizes the API/MCP/cross-consumer R0 evidence against DEPLOYED PROD
 * (default https://free2aitools.com, override BASE_URL). REUSES the mature SRS-2A
 * harness rather than duplicating it: the SAME provenance record/CellState model
 * (srs2a-helpers), the SAME bounded transient retry + Retry-After honoring
 * (withTransientRetry), the SAME 429/503 -> INCONCLUSIVE_TRANSIENT classification
 * intent (a transient is NOT a pass, NOT a product defect, NOT a closed cell), and
 * the SAME request-rate control (paceNavigation token-bucket from
 * srs2a-critical-transient). The classifier event taxonomy is NOT re-implemented.
 *
 * This file is API/JSON specific: a fetch wrapper (workers=1 serial, dedup,
 * descriptive UA, <=2 retries), the transient predicate, and a thin assertion
 * helper that maps each API contract check to a record() cell with one of:
 * PASS / PRODUCT_FAILURE (deterministic same-origin 4xx-not-expected/5xx/malformed
 * /wrong-content-type) / INCONCLUSIVE_TRANSIENT (429/503) / HARNESS_FAILURE.
 */
import { BASE_URL, TEST_UA, record, withTransientRetry, type CellState } from './srs2a-helpers';
import { paceNavigation } from './srs2a-critical-transient';
import { corroborate5xx, successAttempt, type AttemptObservation, type Staged5xxProbe } from './srs2-staged-5xx';

export { BASE_URL, TEST_UA, record };

/** A confirmed transient transport status (same gate the SRS-2A classifier uses
 *  for 429/503 -> TRANSIENT/CRITICAL_TRANSIENT; here it routes a cell to
 *  INCONCLUSIVE_TRANSIENT). */
export const isTransient = (s: number): boolean => s === 429 || s === 503;

/** Minimal shape of a Playwright APIResponse we consume (status/headers/body). */
export interface ApiResp {
    status(): number;
    headers(): Record<string, string>;
    text(): Promise<string>;
    json(): Promise<any>;
}
export interface ApiRequest {
    get(url: string, opts?: any): Promise<ApiResp>;
    post(url: string, opts?: any): Promise<ApiResp>;
}

/** Per-URL+method dedup of in-flight identical requests this run (request dedup,
 *  Founder-inherited): two cells probing the same fixed sample share ONE network
 *  fetch instead of issuing a duplicate cold load. Keyed by method+url+body. */
const inflight = new Map<string, Promise<{ resp: ApiResp; retries: number }>>();

/**
 * Shaped fetch: REQUEST-RATE CONTROL pacing (paceNavigation token-bucket, reused
 * from SRS-2A — paces OUR traffic under the CF same-origin limit; never an
 * allowlist, never a CF-limit bypass), request dedup, descriptive UA (requests NO
 * privileged treatment), and the SHARED bounded (<=2) Retry-After retry. Returns
 * the response + retry count for the provenance record.
 */
export async function shapedFetch(
    request: ApiRequest,
    method: 'GET' | 'POST',
    path: string,
    opts: { data?: unknown; headers?: Record<string, string> } = {},
): Promise<{ resp: ApiResp; retries: number }> {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const bodyKey = opts.data ? JSON.stringify(opts.data) : '';
    const key = `${method} ${url} ${bodyKey}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const headers = { 'user-agent': TEST_UA, ...(opts.headers || {}) };
    const run = (async () => {
        await paceNavigation();
        const fn = () => method === 'GET'
            ? request.get(url, { headers, maxRedirects: 0 })
            : request.post(url, { headers: { 'content-type': 'application/json', ...headers }, data: opts.data });
        return withTransientRetry(fn as any, isTransient);
    })();
    inflight.set(key, run as any);
    try { return await run; } finally { inflight.delete(key); }
}

/** Reset the per-run dedup cache (called per cross-consumer sample so a genuine
 *  re-probe is allowed; identical concurrent calls still coalesce within a cell). */
export function resetDedup(): void { inflight.clear(); }

/** Safe JSON parse: a malformed body on a 200 is a DETERMINISTIC same-origin
 *  contract failure (PRODUCT_FAILURE), never silently a pass. */
export async function safeJson(resp: ApiResp): Promise<{ ok: boolean; data: any; raw: string }> {
    const raw = await resp.text();
    try { return { ok: true, data: JSON.parse(raw), raw }; }
    catch { return { ok: false, data: null, raw }; }
}

/** True iff the response Content-Type matches the expected family (json/svg). */
export function contentTypeIs(resp: ApiResp, family: 'json' | 'svg'): boolean {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    return family === 'json' ? ct.includes('application/json') : ct.includes('image/svg');
}

/**
 * Record one API contract cell. A 429/503 is INCONCLUSIVE_TRANSIENT (cell stays
 * UNCLOSED — NOT a pass, NOT a product defect — fully in the artifact and into the
 * P-10 evidence stream); any other deterministic same-origin failure is a
 * PRODUCT_FAILURE; otherwise the caller's `pass` decides PASS vs PRODUCT_FAILURE.
 * `unknownIsTriage` marks an unexpected NON-429 status as HARNESS_FAILURE (triage)
 * rather than asserting a product defect, per the Founder classification.
 */
export function recordApi(
    assertion: string,
    expected: string,
    resp: ApiResp | null,
    pass: boolean,
    extra: { retries?: number; keyFields?: Record<string, unknown>; unknownIsTriage?: boolean } = {},
): CellState {
    const status = resp?.status() ?? 0;
    const h = resp?.headers() ?? {};
    let state: CellState;
    if (resp && isTransient(status)) state = 'INCONCLUSIVE_TRANSIENT';
    else if (pass) state = 'PASS';
    else if (!resp || (extra.unknownIsTriage && status !== 0 && status < 400)) state = 'HARNESS_FAILURE';
    else state = 'PRODUCT_FAILURE';
    record({
        assertion, expected, actual: `status=${status} pass=${pass}`, state, retries: extra.retries,
        keyFields: { status, contentType: h['content-type'], cacheControl: h['cache-control'], retryAfter: h['retry-after'], ...extra.keyFields },
    });
    return state;
}

/** Map a probed response to an AttemptObservation (status + 2xx contract verdict +
 *  retained body metadata; metadata is NEVER suppressed). `shapeOk` is the caller's
 *  contract verdict for a 2xx body. */
export function toAttempt(resp: ApiResp, shapeOk: boolean, raw?: string): AttemptObservation {
    const s = resp.status();
    const meta = { contentType: resp.headers()['content-type'], bodyLen: raw?.length };
    return s >= 200 && s < 300 ? successAttempt(s, shapeOk, meta) : { status: s, bodyMeta: meta };
}

/**
 * STAGED record for an EXPECTED-SUCCESS API cell. The original attempt is observed;
 * on a clean 2xx-with-valid-contract it is a normal PASS (no extra probes). On an
 * UNEXPECTED 5xx it is NEVER immediately PASS, transient, or final PRODUCT_FAILURE —
 * the harness runs the bounded (<=2) GET-only corroboration via `probe` and adjudicates
 * per A/B/D/E. A malformed/schema-violating 2xx is a deterministic contract failure
 * (PRODUCT_FAILURE, stage D). 429/503 stays INCONCLUSIVE_TRANSIENT (inherited). Every
 * attempt's status/body metadata is preserved in the record.
 */
export async function recordApiStaged(
    assertion: string, expected: string, original: ApiResp, shapeOk: boolean,
    probe: Staged5xxProbe, extra: { retries?: number; raw?: string; keyFields?: Record<string, unknown> } = {},
): Promise<CellState> {
    const s0 = original.status();
    if (isTransient(s0)) return recordApi(assertion, expected, original, false, extra);
    const originalAttempt = toAttempt(original, shapeOk, extra.raw);
    // Clean 2xx success with a valid contract -> normal PASS (no extra probes).
    if (s0 >= 200 && s0 < 300 && shapeOk) {
        return recordApi(assertion, expected, original, true, extra);
    }
    // Malformed 2xx OR unexpected 5xx -> staged adjudication (5xx triggers live <=2 probes).
    const verdict = await corroborate5xx(originalAttempt, probe);
    record({
        assertion, expected, actual: `${verdict.classification} :: ${verdict.reason}`, state: verdict.cellState,
        retries: extra.retries,
        keyFields: { event: verdict.classification, productFailure: verdict.productFailure, attempts: verdict.attempts, ...extra.keyFields },
    });
    return verdict.cellState;
}
