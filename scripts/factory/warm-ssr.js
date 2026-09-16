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
    SSR_ORIGIN_DEFAULT, SSR_WARM_PATHS, PER_URL_MAX_TIME_S, PHASE_BUDGET_MS,
    runWarmPlan, formatSummary, parseWriteOut
} from './lib/ssr-warm-core.js';

const USER_AGENT = 'User-Agent: Nexus-Warmer/1.0';

function curlWarm(url) {
    const startedAt = Date.now();
    // os.devNull, not a literal '/dev/null'. On the ubuntu-latest runner the two
    // are identical; when this runner is exercised locally on Windows the literal
    // makes curl exit 23 (CURLE_WRITE_ERROR) on every URL. The old inline loop
    // could not have shown that - `|| true` discarded the exit code entirely.
    const args = [
        '-s', '-o', os.devNull,
        '--max-time', String(PER_URL_MAX_TIME_S),
        '-H', USER_AGENT,
        '-w', '%{http_code} %{time_total}',
        url
    ];
    try {
        const out = execFileSync('curl', args, {
            encoding: 'utf8',
            // Hard stop if curl itself wedges past its own --max-time.
            timeout: (PER_URL_MAX_TIME_S + 10) * 1000
        });
        const parsed = parseWriteOut(out);
        return {
            curlExit: 0,
            httpStatus: parsed.httpStatus,
            durationMs: parsed.durationMs === null ? Date.now() - startedAt : parsed.durationMs
        };
    } catch (err) {
        // curl still writes the -w line on failure (http_code 000 on a timeout),
        // so keep whatever it managed to report rather than discarding it.
        const parsed = parseWriteOut(err && err.stdout);
        return {
            curlExit: typeof err?.status === 'number' ? err.status : -1,
            httpStatus: parsed.httpStatus,
            durationMs: parsed.durationMs === null ? Date.now() - startedAt : parsed.durationMs,
            error: (err && err.message) || String(err)
        };
    }
}

async function main() {
    const origin = (process.env.SSR_ORIGIN || SSR_ORIGIN_DEFAULT).replace(/\/$/, '');
    const urls = SSR_WARM_PATHS.map(p => `${origin}${p}`);

    console.log(`🔥 Live-SSR warm: ${urls.length} URLs, ${PER_URL_MAX_TIME_S}s per URL, ${PHASE_BUDGET_MS}ms phase budget.`);
    const { summary } = await runWarmPlan({ urls, execute: curlWarm, log: line => console.log(line) });
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
