/**
 * L9 GUARDIAN - TIER 1 infrastructure + V6 stats check.
 *
 * Moved out of scripts/sentinel-prod.js unchanged in logic, to keep that file
 * inside the 250-line Art 5.1 limit. The only behavioural change is the one
 * this work order adds everywhere: the tier now runs under a single shared
 * deadline (TIER1_BUDGET_MS) and records each request plus its own duration.
 * Its requests (1 GET, a .gz GET only if that one is not ok, then 4 HEADs, so
 * five or six) were previously un-timed `await fetch` calls, any of which
 * could hang until the job's timeout-minutes killed it - and the report is only
 * written after the checks finish, so such a run produces none.
 *
 * Preserved exactly: the .gz fallback is unconditional on a non-ok primary (it
 * is NOT the Tier-2 "only if the fallback is ok" rule), the pagination-cap
 * comparison, the 1-hour staleness window, and the early FAIL return.
 */

import { TIER1_BUDGET_MS } from './sentinel-budgets.js';
import { timedRequest } from './sentinel-probe.js';

const CATEGORIES = ['text-generation', 'vision-multimedia', 'infrastructure-ops', 'knowledge-retrieval'];

export async function checkInfrastructure({ targetUrl, headers, now = Date.now }) {
    process.stdout.write('   [TIER 1] Infrastructure & V6 Stats... ');
    const startedAt = now();
    // One shared deadline for the whole tier (1 GET + up to 1 .gz GET + 4 HEADs).
    const deadlineAt = startedAt + TIER1_BUDGET_MS;
    const results = {
        name: 'Infra & V6 Stats', status: 'PASS', details: [],
        budgetMs: TIER1_BUDGET_MS, durationMs: 0, requests: []
    };

    try {
        const statsUrl = `${targetUrl}/cache/category_stats.json`;
        let stats = await timedRequest({ role: 'primary', url: statsUrl, headers, deadlineAt });
        results.requests.push(stats.record);

        // A request that never produced a response used to throw out of `await
        // fetch` straight into the catch below. Preserved: no fallback for it.
        if (stats.record.httpStatus === null) throw new Error(stats.record.error);

        // V16.9: .gz Fallback (eligibility and unconditional reassignment unchanged)
        if (!stats.ok) {
            stats = await timedRequest({ role: 'gz-fallback', url: `${statsUrl}.gz`, headers, deadlineAt });
            results.requests.push(stats.record);
            if (stats.record.httpStatus === null) throw new Error(stats.record.error);
        }

        if (!stats.ok) throw new Error(`Stats fetch failed (${stats.record.httpStatus})`);

        // Get stats last modified as a freshness baseline
        const statsLastMod = new Date(stats.response.headers.get('last-modified') || Date.now());

        // 2. Pagination Cap Check (Art 2.4 - No p51)
        for (const cat of CATEGORIES) {
            const p51Url = `${targetUrl}/cache/rankings/${cat}/p51.json`;
            const p51 = await timedRequest({ role: 'primary', url: p51Url, headers, deadlineAt, method: 'HEAD' });
            results.requests.push(p51.record);
            if (p51.record.httpStatus === null) throw new Error(p51.record.error);

            if (p51.record.httpStatus === 200) {
                const p51LastMod = new Date(p51.response.headers.get('last-modified') || 0);
                const isStale = (statsLastMod - p51LastMod) > 1000 * 60 * 60; // Older than 1 hour relative to stats

                if (isStale) {
                    console.warn(`   ⚠️  Stale artifact detected: ${cat}/p51.json (LastModified: ${p51LastMod.toISOString()}). Ignoring.`);
                } else {
                    results.status = 'FAIL';
                    results.error = `Pagination CAP violated: ${cat}/p51.json is FRESH (Art 2.4 Violation). LastModified: ${p51LastMod.toISOString()}.`;
                    console.log('❌ FAIL');
                    results.durationMs = now() - startedAt;
                    return results;
                }
            }
        }

        console.log('✅ OK');
    } catch (err) {
        console.log('❌ FAIL');
        results.status = 'FAIL';
        results.error = err.message;
    }

    results.durationMs = now() - startedAt;
    return results;
}
