/**
 * L9 GUARDIAN - TIER 1 infrastructure + V6 stats check.
 *
 * Moved out of scripts/sentinel-prod.js to keep that file inside the 250-line
 * Art 5.1 limit. An earlier revision of this header said the move was "unchanged
 * in logic" and that the shared deadline was "the only behavioural change".
 * BOTH ARE WITHDRAWN -- E-G1-01 is precisely a logic change that shipped under
 * those words. What actually differs from the pre-work-order Tier 1:
 *   1. the tier runs under a single shared deadline (TIER1_BUDGET_MS) and
 *      records each request plus its own duration;
 *   2. the stats GET now READS ITS BODY (timedRequest does, for any ok GET),
 *      which the original never did -- see the note below;
 *   3. fallback ELIGIBILITY changed (E-G1-01, detailed at the call site);
 *   4. the p51 decisions are outcome-based rather than status-based;
 *   5. a non-HTTP stats failure reports its own error text instead of the
 *      legacy "Stats fetch failed (<status>)" wording.
 *
 * Consequence of (2), recorded because it is a real divergence: the body is
 * never used -- only response headers are -- yet it creates a failure mode the
 * original could not have, and a slow body can consume the tier budget so the
 * p51 HEADs never run. That path is FAIL-CLOSED (the tier reports FAIL, so no
 * false health is asserted) but it loses pagination-cap coverage the original
 * had. Removing the read is a named follow-up design item, NOT a one-line
 * change: timedRequest has no readBody parameter today, and adding one needs
 * response-body release and test adjustments.
 * Its requests (1 GET, a .gz GET only if that one returned a COMPLETE non-ok
 * HTTP response, then 4 HEADs, so five or six) were previously un-timed calls, any of which
 * could hang until the job's timeout-minutes killed it - and the report is only
 * written after the checks finish, so such a run produces none.
 *
 * Preserved exactly: the UNCONDITIONAL REASSIGNMENT of `stats` to the fallback
 * once one is issued (this is NOT the Tier-2 "only if the fallback is ok" rule),
 * the 1-hour staleness window, the cap's FAIL message and the early FAIL return.
 * The pagination-cap COMPARISON was in this list and has been removed from it:
 * item 4 above changes how the p51 responses are admitted to that comparison,
 * so "preserved exactly" was self-contradictory across 17 lines. The comparison
 * itself -- the 1-hour arithmetic and the FRESH/stale verdict -- is untouched.
 *
 * CHANGED (E-G1-01): fallback ELIGIBILITY. It was `!stats.ok`, which fired on a
 * 200 whose body then failed; it is now `isFallbackEligible`, a complete non-ok
 * HTTP response. An earlier revision of this header claimed the eligibility was
 * "preserved exactly" -- that was false and is withdrawn here.
 */

import { TIER1_BUDGET_MS } from './sentinel-budgets.js';
import { timedRequest, isFallbackEligible } from './sentinel-probe.js';

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

        // V16.9 .gz fallback. ELIGIBILITY IS A COMPLETE NON-OK HTTP RESPONSE --
        // the same predicate Tier 2 uses, and the fix for E-G1-01.
        //
        // `!stats.ok` conflated an HTTP failure with a BODY-read failure.
        // timedRequest sets httpStatus when HEADERS arrive and only then reads
        // the body, so a 200 whose body then fails leaves ok = false with
        // httpStatus = 200. That fired a .gz fallback the baseline never fired,
        // and -- worse than the Tier-2 case -- the fallback's Last-Modified then
        // became the freshness BASIS for the pagination-cap check below. On the
        // operator's fixture a real Art 2.4 violation was reported as PASS with
        // all four p51 artifacts dismissed as "stale".
        //
        // A body transfer failure or a probe timeout now keeps FAIL, its own
        // reason, and its request evidence, and gets NO fallback.
        //
        // "No fallback" matches the pre-work-order baseline. THE VERDICT DOES
        // NOT: that baseline never called `await res.text()` here, so it would
        // have accepted the headers and gone on to the p51 loop -- on the
        // E-G1-01 fixture it PASSED the stats step and FAILED later on the cap.
        // This build FAILS at the stats step instead. That is a deliberate
        // fail-loud divergence, caused by the body read added in this work
        // order, and it is the same divergence disclosed for the .gz path.
        if (isFallbackEligible(stats.record)) {
            stats = await timedRequest({ role: 'gz-fallback', url: `${statsUrl}.gz`, headers, deadlineAt });
            results.requests.push(stats.record);
        }

        if (!stats.ok) {
            // Only a real HTTP status keeps the legacy wording; anything else
            // reports what actually happened rather than "Stats fetch failed (200)".
            throw new Error(isFallbackEligible(stats.record)
                ? `Stats fetch failed (${stats.record.httpStatus})`
                : stats.record.error);
        }

        // Get stats last modified as a freshness baseline
        const statsLastMod = new Date(stats.response.headers.get('last-modified') || Date.now());

        // 2. Pagination Cap Check (Art 2.4 - No p51)
        for (const cat of CATEGORIES) {
            const p51Url = `${targetUrl}/cache/rankings/${cat}/p51.json`;
            const p51 = await timedRequest({ role: 'primary', url: p51Url, headers, deadlineAt, method: 'HEAD' });
            results.requests.push(p51.record);
            // Outcome-based, not status-based. These HEADs cannot currently have
            // a post-header failure (timedRequest skips the body for HEAD), but
            // that invariant lives in another module and nothing pins it. Keying
            // on outcome means the cap check cannot silently re-acquire E-G1-01
            // if a body phase is ever added here.
            if (p51.record.outcome !== 'ok' && p51.record.outcome !== 'http-error') {
                throw new Error(p51.record.error);
            }

            if (p51.record.outcome === 'ok' && p51.record.httpStatus === 200) {
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
