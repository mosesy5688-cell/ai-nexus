#!/usr/bin/env node
/**
 * Live-SSR warm runner for the `Purge & Warm CDN` step of factory-upload.yml.
 *
 * Still curl, still sequential, still one request per URL. The cap is still 20s
 * whenever at least 23s of the phase budget remains (one worst-case slot);
 * below that it is smaller, down to a 1s floor. An earlier DRAFT of this line --
 * never committed; no commit contains it -- said "whenever the phase budget has
 * a full slot left", which is wrong: a full slot is MIN_URL_SLOT_MS = 4,000ms,
 * and curlCapForRemaining(5000) is 2,000ms.
 *
 * An earlier revision of this header said "the only behavioural change is that
 * the status code, the duration and curl's exit code are captured". WITHDRAWN:
 * that was never the only one. The complete list of behavioural changes against
 * the inline bash loop this replaced:
 *   1. `/` and `/ranking` are warmed as well (ssr-warm-core.js SSR_WARM_PATHS),
 *      and the order puts them first;
 *   2. status code, duration and curl exit code are captured and summarised
 *      instead of being discarded by `-o /dev/null` and `|| true`;
 *   3. a URL starts only if a whole MIN_URL_SLOT_MS still fits in the phase
 *      budget; otherwise it is recorded as `skipped` (ssr-warm-budget.js);
 *   4. the per-URL cap is sized from what the budget has left, so it can be
 *      below 20s, and it is passed as exact fractional seconds rather than
 *      rounded to a whole second;
 *   5. the subprocess wait is derived from that same cap and uses
 *      `killSignal: 'SIGKILL'`, because the default SIGTERM bounds nothing;
 *   6. the output sink is `os.devNull` rather than a literal '/dev/null';
 *   7. SSR_WARM_BUDGET_MS can override the phase budget (test seam; production
 *      sets it nowhere);
 *   8. the origin is env-overridable -- `process.env.SSR_ORIGIN` with a
 *      trailing-slash strip -- where the bash loop held it in a shell local.
 *      This is the seam the entry-point test uses to reach 127.0.0.1.
 * Unchanged: sequential execution, one request per URL, and non-fatality.
 *
 * NON-FATAL: this process always exits 0. It does not gate publication, and it
 * must never be able to. The workflow keeps its `|| true` as a second guard.
 *
 * A 2xx recorded here proves that one request succeeded. It is not evidence
 * that any other isolate, region, colo or cache is warm.
 */

import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import os from 'os';
import {
    SSR_ORIGIN_DEFAULT, SSR_WARM_PATHS, PER_URL_MAX_TIME_S, PHASE_BUDGET_MS, KILL_GRACE_MS,
    runWarmPlan, formatSummary, parseWriteOut, buildCurlArgs,
    curlCapForRemaining, subprocessWaitMs
} from './lib/ssr-warm-core.js';

/**
 * SIGKILL, not the documented default SIGTERM. Node: "When a timeout has been
 * encountered and killSignal is sent, the method won't return until the process
 * has completely exited... If the child process intercepts and handles the
 * SIGTERM signal and does not exit, the parent process will still wait until
 * the child process has exited." SIGTERM therefore bounds nothing; POSIX
 * signal(7) specifies SIGKILL cannot be caught, blocked or ignored.
 * On Windows there are no POSIX signals - Node terminates the process whatever
 * the signal name - so the bound holds there for a different reason.
 */
const KILL_SIGNAL = 'SIGKILL';

function curlWarm(url, remainingMs = PHASE_BUDGET_MS) {
    const startedAt = Date.now();
    // BOTH of curl's own clock and the parent's subprocess wait are sized from
    // what the phase budget has left; see the slot accounting in ssr-warm-core.
    // With a full budget the cap is the unchanged 20s.
    // os.devNull, not a literal '/dev/null'. On the ubuntu-latest runner the two
    // are identical; when this runner is exercised locally on Windows the literal
    // makes curl exit 23 (CURLE_WRITE_ERROR) on every URL. The old inline loop
    // could not have shown that - `|| true` discarded the exit code entirely.
    const capMs = curlCapForRemaining(remainingMs);
    const args = buildCurlArgs(url, capMs, os.devNull);
    try {
        const out = execFileSync('curl', args, {
            encoding: 'utf8',
            timeout: subprocessWaitMs(capMs),
            killSignal: KILL_SIGNAL
        });
        const parsed = parseWriteOut(out);
        return {
            curlExit: 0,
            httpStatus: parsed.httpStatus,
            durationMs: parsed.durationMs === null ? Date.now() - startedAt : parsed.durationMs
        };
    } catch (err) {
        // curl still writes the -w line on most failures (http_code 000 on its
        // own timeout), so keep whatever it managed to report. On the SIGKILL
        // path it printed nothing - that is recorded, not guessed at.
        const parsed = parseWriteOut(err && err.stdout);
        const killed = err && err.signal === KILL_SIGNAL;
        return {
            curlExit: typeof err?.status === 'number' ? err.status : -1,
            httpStatus: parsed.httpStatus,
            durationMs: parsed.durationMs === null ? Date.now() - startedAt : parsed.durationMs,
            error: killed
                ? `curl exceeded its ${capMs}ms cap and was ${KILL_SIGNAL}ed after a ${KILL_GRACE_MS}ms grace (no write-out captured)`
                : ((err && err.message) || String(err))
        };
    }
}

/**
 * Phase budget. SSR_WARM_BUDGET_MS exists so the entry-point test can drive the
 * budget path as a real process without a 100-second test; production sets it
 * nowhere and gets PHASE_BUDGET_MS.
 */
function phaseBudgetMs() {
    const raw = Number.parseInt(process.env.SSR_WARM_BUDGET_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : PHASE_BUDGET_MS;
}

async function main() {
    const origin = (process.env.SSR_ORIGIN || SSR_ORIGIN_DEFAULT).replace(/\/$/, '');
    const urls = SSR_WARM_PATHS.map(p => `${origin}${p}`);
    const budgetMs = phaseBudgetMs();

    console.log(`🔥 Live-SSR warm: ${urls.length} URLs, ${PER_URL_MAX_TIME_S}s per URL, ${budgetMs}ms phase budget.`);
    const { summary } = await runWarmPlan({ urls, budgetMs, execute: curlWarm, log: line => console.log(line) });
    console.log(formatSummary(summary));
    console.log('   [warm] Each result above describes ONE request. It is not evidence that other isolates, regions or caches are warm.');
    console.log('✅ SSR warm phase complete (non-fatal: this step never gates publication).');
}

// Entry-point guard: importing this module (tests, tooling) must never fire
// real curls at production. Only a direct `node scripts/factory/warm-ssr.js` runs.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    main().catch(err => {
        console.log(`⚠️ SSR warm phase error (non-fatal): ${(err && err.message) || err}`);
    }).finally(() => {
        process.exitCode = 0;
    });
}

export { curlWarm, main };
