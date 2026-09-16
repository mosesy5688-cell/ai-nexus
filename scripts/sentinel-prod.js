/**
 * ------------------------------------------------------------------
 * L9 GUARDIAN - GLOBAL HEALTH SENTINEL (V16.8 Consolidated)
 * ------------------------------------------------------------------
 * Instrumentation note: every logical check now records its own duration and
 * runs under an explicit, enforced budget (scripts/lib/sentinel-budgets.js).
 * Tier-2 page checks additionally record the primary request and the `.gz`
 * fallback separately (scripts/lib/sentinel-probe.js).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    PER_CHECK_BUDGET_MS, TIER2_TOTAL_BUDGET_MS,
    assertBudgetsLeaveReportReserve, budgetManifest
} from './lib/sentinel-budgets.js';
import { probePage, notRunCheck } from './lib/sentinel-probe.js';
import { checkInfrastructure } from './lib/sentinel-infra.js';

// Fail fast at import time if the configured budgets could not leave the
// 3-minute report/upload reserve inside the 10-minute job.
assertBudgetsLeaveReportReserve();

// Resolve paths
const __filename = new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TARGET_URL = (process.argv[2] || 'https://free2aitools.com').replace(/\/$/, '');
const IS_EXPORT = process.argv.includes('--export');

const HEADERS = {
    'User-Agent': 'Free2AITools-Sentinel/2.0 (ConsolidatedHealth; +http://free2aitools.com)',
    'Accept': 'text/html,application/json'
};

function computeTotalHash(manifest) {
    if (!manifest.batches) return null;
    const batchHashes = manifest.batches
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map(b => b.hash || '')
        .join('');
    return `sha256:${crypto.createHash('sha256').update(batchHashes).digest('hex')}`;
}

async function checkBackendIntegrity() {
    process.stdout.write('   [TIER 0] Backend Integrity Check... ');
    const startedAt = Date.now();
    const results = { name: 'Manifest Integrity', status: 'PASS', details: [], durationMs: 0 };

    try {
        const manifestPath = path.join(ROOT_DIR, 'data', 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            console.log('⚪ SKIP (No local manifest)');
            results.status = 'SKIP';
            results.durationMs = Date.now() - startedAt;
            return results;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        // Flexible status check: Pass if batches exist, even if "status" field is missing (Legacy support)
        if (manifest.status && manifest.status !== 'complete') {
            throw new Error(`Incomplete status: ${manifest.status}`);
        }
        if (!manifest.batches && !manifest.total_entities) {
            throw new Error('Manifest lacks required data fields (batches/entities)');
        }

        const computed = computeTotalHash(manifest);
        if (manifest.checksum?.total_hash && manifest.checksum.total_hash !== computed) {
            throw new Error('Hash mismatch! Data corruption detected.');
        }

        console.log('✅ OK');
        results.details.push(`Entities: ${manifest.output?.total_entities || manifest.total_entities || 0}`);
    } catch (err) {
        console.log('❌ FAIL');
        results.status = 'FAIL';
        results.error = err.message;
    }

    results.durationMs = Date.now() - startedAt;
    return results;
}

const PAGES = [
    { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
    { url: '/ranking', name: 'Rankings', text: 'AI Ecosystem Rankings', critical: true },
    { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
    { url: '/cache/search-core.json', name: 'Search Index', minSize: 1000, critical: true }
];

function describe(check) {
    const via = check.usedResponse === 'gz-fallback' ? ' via .gz fallback' : '';
    return check.status === 'PASS'
        ? `✅ OK (${check.durationMs}ms${via})`
        : `❌ FAIL (${check.error}) [${check.durationMs}ms, ${check.outcome}]`;
}

async function runTier2(finalReport) {
    console.log('   [TIER 2] Frontend Smoke Tests:');
    const tierStartedAt = Date.now();
    const tierDeadlineAt = tierStartedAt + TIER2_TOTAL_BUDGET_MS;

    for (const page of PAGES) {
        process.stdout.write(`      - ${page.name.padEnd(20)} `);
        const remaining = tierDeadlineAt - Date.now();
        if (remaining <= 0) {
            // Not run, and therefore not asserted healthy. Recorded as FAIL with
            // an explicit not-run outcome so a skipped check can never read as a pass.
            const skipped = notRunCheck(page, TIER2_TOTAL_BUDGET_MS);
            console.log(`❌ FAIL (${skipped.error})`);
            finalReport.results.push(skipped);
            if (page.critical) finalReport.healthy = false;
            continue;
        }
        // Clamped so the per-check budget can never push the tier past its total.
        const budgetMs = Math.min(PER_CHECK_BUDGET_MS, remaining);
        const check = await probePage({ baseUrl: TARGET_URL, page, headers: HEADERS, budgetMs });
        console.log(describe(check));
        finalReport.results.push(check);
        if (check.status === 'FAIL' && page.critical) finalReport.healthy = false;
    }

    finalReport.tier2DurationMs = Date.now() - tierStartedAt;
}

function emitReport(finalReport) {
    if (!finalReport.healthy) {
        console.log('\n🚨 FAILURES DETECTED:');
        finalReport.results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`   - ${r.name}: ${r.error}`);
        });
    }

    if (IS_EXPORT) {
        fs.writeFileSync('health-report.json', JSON.stringify(finalReport, null, 2));
    }

    console.log(`\nOVERALL STATUS: ${finalReport.healthy ? '🎉 HEALTHY' : '🔥 DEGRADED'}\n`);
    process.exit(finalReport.healthy ? 0 : 1);
}

async function runAudit() {
    process.stdout.write(`\n🛡️  GLOBAL HEALTH SENTINEL - Running for: ${TARGET_URL}\n`);
    const auditStartedAt = Date.now();

    const finalReport = {
        timestamp: new Date().toISOString(),
        target: TARGET_URL,
        // Identifies the CHECKING script only. It is NEVER used as the version of
        // any response; per-request `responseVersion` is 'unknown' when the
        // response carries no deploy identifier.
        probe: {
            commit: process.env.GITHUB_SHA || 'unknown',
            runId: process.env.GITHUB_RUN_ID || 'unknown',
            note: 'Identifies this checking script, not the served version.'
        },
        budgets: budgetManifest(),
        results: [],
        healthy: true
    };

    try {
        const integrity = await checkBackendIntegrity();
        finalReport.results.push(integrity);

        const infra = await checkInfrastructure({ targetUrl: TARGET_URL, headers: HEADERS });
        finalReport.results.push(infra);

        await runTier2(finalReport);

        if (integrity.status === 'FAIL' || infra.status === 'FAIL') finalReport.healthy = false;
    } catch (err) {
        // The report is produced even when the audit itself throws.
        finalReport.healthy = false;
        finalReport.results.push({ name: 'Audit Execution', status: 'FAIL', error: `Audit aborted: ${err.message}` });
    } finally {
        finalReport.auditDurationMs = Date.now() - auditStartedAt;
        emitReport(finalReport);
    }
}

runAudit();
