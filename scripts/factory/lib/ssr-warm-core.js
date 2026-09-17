/**
 * Live-SSR warm plan: the URL set, the classification rules and the driver.
 *
 * Extracted from the inline bash loop in the `Purge & Warm CDN` step of
 * .github/workflows/factory-upload.yml. That loop ran
 *   `curl -s -o /dev/null --max-time 20 ... || true`
 * which discarded the status code (no -w), the body (-o /dev/null) and the exit
 * code (|| true). A URL that returned instantly therefore left a log line
 * indistinguishable from one that had been warmed.
 *
 * An earlier revision of this header said "Two changes here" and listed two.
 * WITHDRAWN -- the count went stale as the module grew. The full list:
 *  - `/` and `/ranking` are added, ordered first. They are the two HTML PAGE
 *    checks in the health probe's critical set; ALL FOUR entries in
 *    sentinel-prod.js PAGES are `critical: true`, and the other two are CDN
 *    JSON artifacts rather than SSR page renders. Neither was in the warm list.
 *  - Every attempt is recorded and classified, and the phase prints a summary.
 *  - The phase budget is a COMPLETION deadline, not a start gate: a URL starts
 *    only if a whole slot fits, and the per-URL cap is sized from what remains
 *    (slot accounting lives in ssr-warm-budget.js).
 *  - `--max-time` is emitted as fractional seconds to millisecond precision
 *    (maxTimeArg), never rounded up past the cap it was given -- for any cap of
 *    at least 1ms. Below that maxTimeArg clamps UP to its 1ms floor, because
 *    `--max-time 0` means no timeout at all in libcurl.
 *
 * WHAT A WARM RESULT DOES AND DOES NOT MEAN: a 2xx here proves that THAT ONE
 * request succeeded. It says nothing about other isolates, other regions, other
 * colos or any cache other than the one that served it. Nothing in this module
 * may be read as evidence that the deployment is warm.
 *
 * NON-FATAL BY CONTRACT: this plan never fails the pipeline. Classification is
 * for the log and the step summary only; the caller exits 0 regardless.
 */

export const SSR_ORIGIN_DEFAULT = 'https://free2aitools.com';

/**
 * Warm order is deliberate: the two health-probe HTML page checks go first so
 * that budget pressure drops the least critical target. That pressure is real,
 * not theoretical -- under worst-case slots URL 6 (`/models`) is skipped, and
 * the pre-work-order loop always attempted all four pre-existing URLs.
 */
export const SSR_WARM_PATHS = [
    // Health-probe critical HTML page: Home. ADDED by this work order.
    // (All four PAGES entries are critical; these two are the page renders.)
    '/',
    // Health-probe critical HTML page: Rankings. ADDED by this work order.
    '/ranking',
    // Entity API - forces per-shard getCachedDbConnection + executeSql.
    '/api/v1/entity/meta-llama/Llama-3.1-8B-Instruct',
    '/api/v1/entity/openai-community/gpt2',
    // Detail page - exercises loadEntityStreams -> resolveVfsMetadata SSR.
    '/model/meta-llama/Llama-3.1-8B-Instruct',
    // List page - warms the catalog/list read path.
    '/models'
];


/**
 * Wall-clock budget for the whole warm phase, 100s.
 *
 * CORRECTED: an earlier revision justified this as "the four pre-existing URLs
 * can always still start (4 x 20s = 80s < 100s)". That arithmetic no longer
 * describes the code. A URL's cost is a SLOT (cap + kill grace + spawn
 * overhead), not just its cap, and a URL starts only if a whole MIN_URL_SLOT_MS
 * fits. Under the slot model's own worst case the first four do still start --
 * three worst-case slots are 69s, leaving 31s, far above the 4s minimum -- but
 * that now follows from the slot arithmetic and holds only while the slot
 * assumptions in ssr-warm-budget.js hold. It is not unconditional.
 * Measured 2026-09-16 (single-shot curl, this work order): the six URLs took
 * 41.5s in total (/ 12.90s, /ranking 4.89s, entity 6.06s + 6.70s, model 6.38s,
 * /models 4.58s), so the budget is ~2.4x the observed total.
 */
export const PHASE_BUDGET_MS = 100_000;

// Slot accounting lives in ssr-warm-budget.js, split out to keep this file
// inside the 250-line Art 5.1 limit, and re-exported so callers keep one import
// surface. PER_URL_MAX_TIME_S moved there with it: it is a budget term, and
// keeping it here would have made the two modules import each other.
import { MIN_URL_SLOT_MS, PER_URL_MAX_TIME_S } from './ssr-warm-budget.js';
export {
    PER_URL_MAX_TIME_S, KILL_GRACE_MS, SPAWN_OVERHEAD_MS, MIN_CURL_CAP_MS,
    MIN_URL_SLOT_MS, curlCapForRemaining, subprocessWaitMs
} from './ssr-warm-budget.js';

export const WARM_USER_AGENT = 'User-Agent: Nexus-Warmer/1.0';

/**
 * curl argv for one warm request, capped at `capMs`. Lives here rather than in
 * warm-ssr.js so it is covered by an assertion on the ACTUAL argv instead of a
 * text match on the source -- and because warm-ssr.js carries a shebang, which
 * the test transform cannot parse.
 */
/**
 * curl --max-time for a cap in milliseconds. curl accepts fractional seconds, so
 * the cap is expressed to millisecond precision rather than rounded to a whole
 * second -- exactly, for any cap of at least 1ms; below that it clamps UP to the
 * 1ms floor (see the guard note below).
 *
 * `Math.round(capMs / 1000)` rounded UP past the cap it was handed: a 16,600ms
 * cap became `--max-time 17`, i.e. 400ms MORE than that URL's slot allowed.
 * Rounding is now downward, to the millisecond, so for any cap of at least 1ms
 * the argument cannot exceed it.
 *
 * The floor matters: `--max-time 0` means NO TIMEOUT in libcurl, so a cap that
 * arrived as 0, negative, NaN or Infinity must never reach curl as "0". Those
 * inputs are unreachable today (curlCapForRemaining clamps at MIN_CURL_CAP_MS)
 * but this is an exported function whose stated contract is a bound, so it
 * clamps rather than trusting its caller. SCOPE: this is an argument-precision defect. It did not make the
 * PHASE exceed its budget -- the parent's subprocess wait is computed from capMs
 * (subprocessWaitMs), not from this string, so the outer bound was unaffected.
 */
export function maxTimeArg(capMs) {
    // Integer arithmetic on purpose: dividing by 1000 and formatting a float
    // reintroduces representation error at the boundary this function exists to
    // protect (Number('16.6') * 1000 === 16600.000000000002).
    const ms = Math.max(1, Math.floor(Number.isFinite(capMs) ? capMs : 1));
    const whole = Math.floor(ms / 1000);
    const frac = String(ms % 1000).padStart(3, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : String(whole);
}

export function buildCurlArgs(url, capMs, devNull) {
    return [
        '-s', '-o', devNull,
        '--max-time', maxTimeArg(capMs),
        '-H', WARM_USER_AGENT,
        '-w', '%{http_code} %{time_total}',
        url
    ];
}

/** curl(1) exit 28 = Operation timeout. */
export const CURL_EXIT_OPERATION_TIMEDOUT = 28;

export const WARM_OUTCOMES = ['succeeded', 'http-failure', 'transfer-failure', 'timeout', 'skipped'];

/**
 * Classify one attempt. `curlExit` is curl's process exit code; `httpStatus` is
 * curl's %{http_code} (0 when no response line was received).
 */
export function classifyWarm({ curlExit, httpStatus }) {
    if (curlExit === CURL_EXIT_OPERATION_TIMEDOUT) return 'timeout';
    if (curlExit !== 0) return 'transfer-failure';
    if (typeof httpStatus === 'number' && httpStatus >= 200 && httpStatus < 400) return 'succeeded';
    return 'http-failure';
}

/**
 * Parse curl's `-w '%{http_code} %{time_total}'` write-out. curl prints this
 * line even when it exits non-zero (http_code 000 on a timeout), so the numbers
 * it did manage to report are kept rather than discarded.
 */
export function parseWriteOut(raw) {
    const parts = String(raw || '').trim().split(/\s+/);
    const code = Number.parseInt(parts[0], 10);
    const seconds = Number.parseFloat(parts[1]);
    return {
        httpStatus: Number.isFinite(code) && code > 0 ? code : null,
        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
    };
}

/**
 * Counts per outcome. `total` is records.length; the buckets sum to it only when
 * every record carries one of the five known outcomes (an unknown one lands in
 * `total` and no bucket -- the `if (key)` guard). "always equals", an earlier
 * wording, was false. Producers here only ever emit the five.
 */
export function summarise(records) {
    const summary = { total: records.length, succeeded: 0, httpFailure: 0, transferFailure: 0, timeout: 0, skipped: 0 };
    const bucket = {
        'succeeded': 'succeeded', 'http-failure': 'httpFailure',
        'transfer-failure': 'transferFailure', 'timeout': 'timeout', 'skipped': 'skipped'
    };
    for (const r of records) {
        const key = bucket[r.outcome];
        if (key) summary[key] += 1;
    }
    return summary;
}

export function formatRecord(r) {
    const status = r.httpStatus === null ? '---' : String(r.httpStatus);
    const exit = r.curlExit === null ? '--' : String(r.curlExit);
    return `   [warm] ${r.startedAtUtc} ${r.outcome.padEnd(16)} http=${status.padEnd(3)} exit=${exit.padEnd(3)} ${String(r.durationMs).padStart(6)}ms ${r.url}`;
}

export function formatSummary(s) {
    return `   [warm] summary: total=${s.total} succeeded=${s.succeeded} http-failure=${s.httpFailure} ` +
        `transfer-failure=${s.transferFailure} timeout=${s.timeout} skipped=${s.skipped}`;
}

/**
 * Run the warm plan sequentially. One request per URL.
 *
 * A failed URL does NOT stop the loop: classification is recorded and the next
 * URL is attempted (see the ssr-warm tests).
 *
 * @param {object} o
 * @param {(url: string) => Promise<{curlExit:number, httpStatus:number|null, durationMs:number, error?:string}>} o.execute
 */
export async function runWarmPlan({ urls, budgetMs = PHASE_BUDGET_MS, now = Date.now, execute, log = () => {} }) {
    const startedAt = now();
    const records = [];

    for (const url of urls) {
        const at = now();
        const remainingMs = startedAt + budgetMs - at;
        // Start only if a WHOLE slot still fits. Starting a URL that cannot
        // finish inside the budget is what let the phase overshoot: the budget
        // gated starts but never constrained execution.
        if (remainingMs < MIN_URL_SLOT_MS) {
            const skipped = {
                url, startedAtUtc: new Date(at).toISOString(), durationMs: 0,
                httpStatus: null, curlExit: null, outcome: 'skipped',
                error: `Skipped: ${Math.max(0, remainingMs)}ms left of the ${budgetMs}ms warm phase budget, below the ${MIN_URL_SLOT_MS}ms minimum slot`
            };
            records.push(skipped);
            log(formatRecord(skipped));
            continue;
        }

        let attempt;
        try {
            // Hand the runner what the budget has LEFT so it can size BOTH
            // curl's --max-time and its own subprocess wait from it.
            attempt = await execute(url, remainingMs);
        } catch (err) {
            // execute() is expected to report curl failures as data, not throws.
            // A throw here means the runner itself failed; record it, keep going.
            attempt = { curlExit: -1, httpStatus: null, durationMs: now() - at, error: (err && err.message) || String(err) };
        }

        const record = {
            url,
            startedAtUtc: new Date(at).toISOString(),
            durationMs: typeof attempt.durationMs === 'number' ? attempt.durationMs : (now() - at),
            httpStatus: typeof attempt.httpStatus === 'number' ? attempt.httpStatus : null,
            curlExit: typeof attempt.curlExit === 'number' ? attempt.curlExit : -1,
            outcome: classifyWarm(attempt),
            error: attempt.error || null
        };
        records.push(record);
        log(formatRecord(record));
    }

    return { records, summary: summarise(records) };
}
