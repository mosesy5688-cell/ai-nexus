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
 * Two changes here:
 *  - `/` and `/ranking` are added. They are the two page checks the health
 *    probe (scripts/sentinel-prod.js) treats as critical, and neither was in
 *    the warm list.
 *  - Every attempt is recorded and classified, and the phase prints a summary.
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
 * Warm order is deliberate. The two health-probe critical pages go first so
 * that, if the phase budget bites, what gets dropped is the least critical
 * target rather than the pages the probe will check.
 */
export const SSR_WARM_PATHS = [
    // Health-probe critical page: Home. ADDED by this work order.
    '/',
    // Health-probe critical page: Rankings. ADDED by this work order.
    '/ranking',
    // Entity API - forces per-shard getCachedDbConnection + executeSql.
    '/api/v1/entity/meta-llama/Llama-3.1-8B-Instruct',
    '/api/v1/entity/openai-community/gpt2',
    // Detail page - exercises loadEntityStreams -> resolveVfsMetadata SSR.
    '/model/meta-llama/Llama-3.1-8B-Instruct',
    // List page - warms the catalog/list read path.
    '/models'
];

/** Unchanged from the previous inline loop: one request per URL, 20s cap each. */
export const PER_URL_MAX_TIME_S = 20;

/**
 * Wall-clock budget for the whole warm phase. 100s, chosen so the four
 * pre-existing URLs can always still start (4 x 20s = 80s < 100s) while the
 * worst case grows by 20s rather than by 40s: URLs 1-5 can each burn their full
 * 20s cap, after which the 6th is recorded as skipped.
 * Measured 2026-09-16 (single-shot curl, this work order): the six URLs took
 * 41.5s in total (/ 12.90s, /ranking 4.89s, entity 6.06s + 6.70s, model 6.38s,
 * /models 4.58s), so the budget is ~2.4x the observed total.
 */
export const PHASE_BUDGET_MS = 100_000;

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

/** Counts per outcome. `total` always equals the sum of the five buckets. */
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
        if (at - startedAt >= budgetMs) {
            const skipped = {
                url, startedAtUtc: new Date(at).toISOString(), durationMs: 0,
                httpStatus: null, curlExit: null, outcome: 'skipped',
                error: `Skipped: the ${budgetMs}ms warm phase budget was already spent`
            };
            records.push(skipped);
            log(formatRecord(skipped));
            continue;
        }

        let attempt;
        try {
            attempt = await execute(url);
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
