#!/usr/bin/env node
/**
 * Live-SSR warm runner for the `Purge & Warm CDN` step of factory-upload.yml.
 *
 * Still curl, still sequential, still one request per URL with a 20s cap - the
 * only behavioural change is that the status code, the duration and curl's exit
 * code are captured and printed instead of being discarded by `-o /dev/null`
 * and `|| true`.
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
