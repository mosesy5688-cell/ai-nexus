/**
 * L9 GUARDIAN - explicit probe budgets for scripts/sentinel-prod.js.
 *
 * WHY these exist at all: before this module every sentinel request was an
 * un-timed `await fetch(url)`. A hung origin could hold a check open until the
 * Global Health Monitor job hit its 10-minute `timeout-minutes`. The script
 * writes health-report.json only AFTER the checks finish (see emitReport), so a
 * run killed mid-check produces no report for the upload step to take. These
 * constants bound the audit's own NETWORK wait so the network checks always
 * finish. Tier 0 is local filesystem work and is unbudgeted (see
 * sentinel-prod.js); it is not covered by any constant here.
 *
 * PROVENANCE, per constant -- an earlier revision of this line read "Every
 * number below is PM-set", which contradicted a flag 34 lines further down.
 * WITHDRAWN, and the replacement is itemised rather than totalled, because an
 * uncommitted draft of this correction ("MOST are PM-set; TIER1 is not") still
 * mis-totalled:
 *   PER_CHECK_BUDGET_MS, TIER2_TOTAL_BUDGET_MS, REPORT_RESERVE_MS - PM-set.
 *   TIER1_BUDGET_MS      - mine, introduced with a measured argument.
 *   JOB_TIMEOUT_MS       - neither: it MIRRORS `timeout-minutes: 10` in
 *                          global-health-monitor.yml and must track it.
 *   AUDIT_NETWORK_BUDGET_MS - derived, set by nobody.
 *
 * The PM-set ones and mine are adjustable ONLY with a named, measured argument;
 * the measurement each rests on is recorded next to it. JOB_TIMEOUT_MS is not
 * adjustable on that basis at all - it follows the workflow.
 *
 * SCOPE NOTE (what these bounds do NOT cover): they bound only the time this
 * SCRIPT spends waiting on the network. Checkout, `npm ci`, artifact upload and
 * runner scheduling are outside the script and are not bounded here.
 */

/**
 * Per-check budget for one Tier-2 page check. Covers the main request PLUS the
 * `.gz` fallback PLUS the body read, combined - one deadline for the whole
 * check, never a fresh timer per request.
 *
 * PM-set at 45s. Measured against production 2026-09-16 (single-shot curl, this
 * work order): the slowest combined check today is Trending JSON at 13.41s
 * (primary 404 in 4.08s + .gz 200 in 9.33s); Home was 12.90s single-request.
 * 45s is therefore ~3.4x the slowest combined check measured, and it sits well
 * below Cloudflare's DOCUMENTED default Proxy Read Timeout of 125s, so a hung
 * origin is recorded as a PROBE timeout instead of waiting on the CDN. This
 * zone's actual read-timeout configuration has not been measured; 125s is the
 * documented default, not an observation of this zone.
 */
export const PER_CHECK_BUDGET_MS = 45_000;

/**
 * Total budget for Tier 2 (all four page checks). PM-set at 150s.
 * Measured 2026-09-16: the four checks summed to 43.02s.
 */
export const TIER2_TOTAL_BUDGET_MS = 150_000;

/**
 * Total budget for Tier 1 (infra + V6 stats: 1 GET, a .gz GET only if the first
 * returned a complete non-ok HTTP response, then 4 HEADs - five or six requests).
 *
 * NOT in the PM's named list; introduced here with a measured argument because
 * the "whole audit" bound below is unenforceable while any tier can hang
 * without limit. Measured 2026-09-16 (single-shot): category_stats.json 404 in
 * 3.33s + .gz 200 in 5.13s + p51 HEAD 4.21s x4 = ~25.3s. 90s is ~3.6x that.
 */
export const TIER1_BUDGET_MS = 90_000;

/** `timeout-minutes: 10` on the health-audit job in global-health-monitor.yml. */
export const JOB_TIMEOUT_MS = 600_000;

/** Reserve for report output + artifact upload: at least 3 minutes (PM-set). */
export const REPORT_RESERVE_MS = 180_000;

/** Worst-case network wait this script can spend: Tier 1 + Tier 2. */
export const AUDIT_NETWORK_BUDGET_MS = TIER1_BUDGET_MS + TIER2_TOTAL_BUDGET_MS;

/**
 * Enforce the "leave at least 3 minutes of the 10-minute job" rule as an
 * invariant rather than as prose. Throws if the configured budgets could not
 * leave the reserve. Called at import time by sentinel-prod.js.
 *
 * Bounds ONE dimension only: this script's own network wait. It cannot and does
 * not bound checkout / npm ci / upload.
 */
export function assertBudgetsLeaveReportReserve({
    auditMs = AUDIT_NETWORK_BUDGET_MS,
    jobMs = JOB_TIMEOUT_MS,
    reserveMs = REPORT_RESERVE_MS
} = {}) {
    const allowed = jobMs - reserveMs;
    if (auditMs > allowed) {
        throw new Error(
            `Sentinel budget invariant violated: audit network budget ${auditMs}ms > ` +
            `${allowed}ms (job ${jobMs}ms - report reserve ${reserveMs}ms)`
        );
    }
    return { auditMs, allowed, reserveMs };
}

/** Budget block embedded in health-report.json so the artifact is self-describing. */
export function budgetManifest() {
    return {
        perCheckMs: PER_CHECK_BUDGET_MS,
        tier1TotalMs: TIER1_BUDGET_MS,
        tier2TotalMs: TIER2_TOTAL_BUDGET_MS,
        auditNetworkMs: AUDIT_NETWORK_BUDGET_MS,
        jobTimeoutMs: JOB_TIMEOUT_MS,
        reportReserveMs: REPORT_RESERVE_MS
    };
}
