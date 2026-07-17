/**
 * D-2026-0717-345 P1a — external synthetic reliability probe: RUNNER (CLI).
 *
 * Read-only, black-box. GETs Homepage / Health / Search / a discovered stable
 * Entity / an invalid-id 404 / OpenAPI, POSTs MCP initialize + tools/list, and a
 * public Range read of the id-index header to compare its build_id against the
 * served manifest build_id (freshness/coherence). Emits one structured JSON
 * evidence record (external total + TTFB + origin/guardian time + HTTP + semantic
 * assertions + served build + UTC) and a PASS/FAIL/UNKNOWN verdict per target and
 * overall. Anti-vacuity (D-346): the semantic asserts FAIL a degraded-but-200
 * service; per-request timeout covers headers AND the full body read.
 *
 * Schedule honesty (D-346): we do NOT fabricate a per-run scheduled time. Each run
 * records only the cron expression, the run id, and actual_start_utc. Slot-coverage
 * (a missing 15-min slot = UNKNOWN) is analyzed OFFLINE from Actions run history.
 *
 * MUST NOT: write to R2, trigger Factory, collect user/adoption data, or auto-rerun
 * to mask a first failure. The GHA workflow uploads the JSON as a >=35-day artifact.
 *
 * Exit code: 0 only on overall PASS; 1 on FAIL; 2 on UNKNOWN (never treat a
 * not-executed / missing-evidence / crashed run as success). A harness crash still
 * writes a minimal UNKNOWN evidence artifact before exiting 2 (never nothing).
 *
 * Usage: node reliability-probe.mjs [outputPath]
 */
import { writeFileSync } from 'node:fs';
import {
    PROBE_SCHEMA_VERSION, buildTargetSpecs, runTarget, overallVerdict, buildCrashEvidence,
} from './reliability-probe-core.mjs';

const BASE_URL = (process.env.PROBE_BASE_URL || 'https://free2aitools.com').replace(/\/+$/, '');
const SEARCH_Q = process.env.PROBE_SEARCH_Q || 'llama';
const ENTITY_ID = process.env.PROBE_ENTITY_ID || '';
const INDEX_URL = process.env.PROBE_INDEX_URL || 'https://cdn.free2aitools.com/data/id-index.bin';
const SCHEDULE_CRON = process.env.PROBE_SCHEDULE_CRON || '';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || '30000');
const OUTPUT_PATH = process.argv[2] || 'probe-evidence.json';

/**
 * Deterministic prompt exit on every platform. fetch's keep-alive sockets keep the
 * loop alive (so plain process.exitCode would hang against a live host), while an
 * abrupt process.exit() while those sockets are open can trip a libuv teardown
 * assertion on Windows. Best-effort: close the shared global dispatcher (undici is
 * present under npm; absent on a bare CI checkout, Linux process.exit is already
 * clean), THEN exit with the three-state code. Never changes the verdict.
 */
async function finishWith(code) {
    try {
        const { getGlobalDispatcher } = await import('undici');
        await getGlobalDispatcher().close();
    } catch { /* undici not importable -> rely on process.exit */ }
    process.exit(code);
}

/** Non-verdict metadata shared by the normal record and the crash-evidence record. */
function runMeta(runUtc) {
    return {
        run_utc: runUtc,
        base_host: BASE_URL,
        cron: SCHEDULE_CRON || null,
        github: {
            run_id: process.env.GITHUB_RUN_ID || null,
            run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
            event_name: process.env.GITHUB_EVENT_NAME || null,
        },
    };
}

async function main() {
    const actualStart = new Date().toISOString();

    // Test-only fault injection (read-only, no data effect): forces the harness
    // crash path so the "crash writes UNKNOWN evidence then exits 2" contract is
    // verifiable end-to-end. Never set in the scheduled/dispatch workflow.
    if (process.env.PROBE_FORCE_CRASH === '1') throw new Error('forced crash (PROBE_FORCE_CRASH test fault injection)');

    // ctx threads discovered evidence (served_build_id from Health, entity_id from
    // Search) into later targets. An explicit PROBE_ENTITY_ID seeds it directly.
    const ctx = {};
    if (ENTITY_ID) ctx.entity_id = ENTITY_ID;

    const deps = {
        fetchImpl: (url, init) => fetch(url, init),
        timeoutMs: TIMEOUT_MS,
        baseUrl: BASE_URL,
        searchQuery: SEARCH_Q,
        entityId: ENTITY_ID,
        indexUrl: INDEX_URL,
        clock: () => performance.now(),
        ctx,
    };

    const targets = [];
    for (const spec of buildTargetSpecs()) {
        // Sequential (not parallel) so ctx dependencies resolve in order and so the
        // probe stays gentle on the live host. No retry/rerun anywhere.
        targets.push(await runTarget(spec, deps));
    }

    const overall = overallVerdict(targets);
    const meta = runMeta(actualStart);
    const record = {
        schema_version: PROBE_SCHEMA_VERSION,
        run_utc: actualStart,
        base_host: BASE_URL,
        index_url: INDEX_URL,
        cron: SCHEDULE_CRON || null,
        // NOT fabricated: we never floor actual-start to a synthetic scheduled tick
        // (that under-reports delays > 15 min). Slot coverage is an offline analysis.
        scheduled_utc: null,
        schedule_delay_ms: null,
        actual_start_utc: actualStart,
        served_build_id: ctx.served_build_id ?? null,
        overall,
        targets,
        github: meta.github,
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(record, null, 2));

    const line = (t) => `  ${t.state.padEnd(7)} ${t.target.padEnd(16)} http=${t.http_status} total=${t.total_ms == null ? '-' : Math.round(t.total_ms)}ms guardian=${t.guardian_ms == null ? '-' : t.guardian_ms}ms${t.error ? ' err=' + t.error : ''}`;
    console.log(`[reliability-probe] base=${BASE_URL} overall=${overall} served_build_id=${record.served_build_id}`);
    for (const t of targets) console.log(line(t));
    console.log(`[reliability-probe] evidence written to ${OUTPUT_PATH}`);

    // Honest three-state exit: PASS=0, FAIL=1, UNKNOWN=2. UNKNOWN is never success.
    await finishWith(overall === 'PASS' ? 0 : overall === 'FAIL' ? 1 : 2);
}

main().catch(async (e) => {
    // A harness-level crash produced no verdict -> UNKNOWN. Write a minimal UNKNOWN
    // evidence artifact FIRST (a crash must not leave nothing), THEN exit 2.
    try {
        writeFileSync(OUTPUT_PATH, JSON.stringify(buildCrashEvidence(e, runMeta(new Date().toISOString())), null, 2));
    } catch (writeErr) {
        console.error('[reliability-probe] failed to write crash evidence:', writeErr && writeErr.message ? writeErr.message : writeErr);
    }
    console.error('[reliability-probe] fatal:', e && e.stack ? e.stack : e);
    await finishWith(2);
});
