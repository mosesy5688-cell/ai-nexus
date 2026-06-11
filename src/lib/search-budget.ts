/**
 * Search route budget envelope (B8).
 *
 * /api/search (and its wrappers /api/v1/search + the MCP search/rank path) was
 * the LAST read endpoint with ZERO timeout protection. Its chain is a stack of
 * unbounded async tiers, each able to stall to CF's ~30s wall-clock ceiling and
 * surface as an HTTP-000 dead connection:
 *   1. term-index R2 fetches (fetchAllTermPostings — pure R2 .get(), unbounded);
 *   2. cold VFS opens + SQL in hydrateCandidates / queryShardBatch (serialized by
 *      the global sqlite-engine lock — the wa-sqlite Asyncify guard, untouchable);
 *   3. Tier-2 cluster fallback (the worst class): a zero-inverted-hit query runs
 *      an UNBOUNDED Workers-AI embed + two full .bin R2 GETs, hanging cold AND warm.
 * The route's outer try/catch only catches EXCEPTIONS — a stall is not an
 * exception, so it rides to the ceiling. Live: ~29% of cache-busted daily queries
 * hit 35s/000; rare-term (zero-hit -> fallback) queries hang persistently.
 *
 * This module bounds the whole route the same way the compare (B7) and entity
 * APIs do (src/lib/compare-budget.ts + op-timeout.ts):
 *   - a wall-clock ROUTE budget (SEARCH_BUDGET_MS) checked between tiers,
 *   - per-op firewalls (withOpTimeout from op-timeout.ts) on EVERY async tier, and
 *   - a hard bound on the Tier-2 fallback (it must run under the remaining budget,
 *     never an unbounded embed + full-bin GET).
 * On exhaustion the route returns an HONEST retryable 503 (no-store + Retry-After +
 * machine-readable reason) — never a ride to a dead connection, never a transient
 * masqueraded as a clean empty search result.
 *
 * Like op-timeout.ts, the per-op race does NOT cancel the loser: an in-flight
 * SQLite op must finish so it releases the promise-chain lock via its own
 * `finally` and warms the connection cache for the retry. Force-releasing would
 * reintroduce the Asyncify re-entrancy bug. Leave the global lock alone.
 */
import { withOpTimeout, isOpTimeout } from './op-timeout.js';

export { withOpTimeout, isOpTimeout };

// ── Wall-clock ROUTE budget ──────────────────────────────────────────────────
// Total time the route may spend across ALL tiers before bailing with a 503.
// 6000ms matches compare/entity (COMPARE_BUDGET_MS / PROBE_BUDGET_MS) so every
// cold read path agrees on one ceiling, and the worst-case response stays far
// under CF's ~30s limit. One cold shard open+SQL is ~3.5-4s additive (serialized
// by the global lock); this admits the term-index fetch + ~1 cold shard (or a
// warm fallback) before bailing. Bailing yields a RETRYABLE 503, never a hard
// "no results" miss (a slow/transient tier is not "empty").
export const SEARCH_BUDGET_MS = 6000;

// ── Per-op firewalls ─────────────────────────────────────────────────────────
// Each bounds a SINGLE async op so one stalled op cannot eat the whole budget.
// All <= SEARCH_BUDGET_MS. On timeout the op is NOT cancelled (op-timeout.ts
// header) — it finishes in the background, releasing any SQLite lock / warming
// the cache for the retry.

// term-index R2 .get() per term file — tiny (~600B) objects, but a stalled R2
// range read must still be timed out. Generous enough that a warm/normal fetch
// never trips it.
export const TERM_FETCH_TIMEOUT_MS = 4000;

// A cold shard open OR a single SQL step (hydration / browse). Mirrors compare's
// OP_TIMEOUT_MS (5000): one cold open is ~3.5-4s, so 5s admits a genuine cold
// open while still bounding a truly hung VFS op.
export const SHARD_OP_TIMEOUT_MS = 5000;

// Workers-AI embedding call in Tier-2 fallback. The embed is a network call to
// the AI binding and has hung unbounded in prod; bound it tightly so the
// fallback cannot blow the route budget on the embed alone.
export const EMBED_TIMEOUT_MS = 4000;

// Whole Tier-2 cluster fallback (embed + 2 full .bin R2 GETs + scan). This is the
// MOST dangerous class — a zero-inverted-hit query enters it. Bound the entire
// fallback so it can NEVER run unbounded; if it cannot finish under this (or the
// route budget is already spent), the caller degrades to an honest signal.
export const FALLBACK_TIMEOUT_MS = 5000;

// ── Browse fan-out cap ───────────────────────────────────────────────────────
// Max distinct cold shards the browse path may open in one request. The global
// lock serializes opens, so a large priority+expansion set could queue dozens of
// cold opens behind the lock and ride to the ceiling. 8 cold shards at ~3.5-4s
// each ≈ 28-32s — already the edge — so the route-budget check between steps is
// the primary bound and this cap is the structural belt-and-suspenders. Matches
// compare's MAX_COLD_SHARDS.
export const MAX_BROWSE_SHARDS = 8;

/**
 * Machine-readable transient reasons. A 503 body carries exactly one so an Agent
 * (or the MCP layer) can tell WHICH tier bailed and retry intelligently. Also
 * used as the `degraded_reason` when the route returns a partial/empty result
 * UNDER budget pressure (so a budget-degraded empty is never confused with a
 * genuine empty search result — Founder prohibition: a transient must never
 * masquerade as an empty result).
 */
export type SearchReason =
    | 'term_index_timeout'      // a term-index R2 fetch exceeded its firewall
    | 'cold_shard_timeout'      // a hydration / browse cold open or SQL timed out
    | 'cluster_fallback_budget' // Tier-2 fallback could not run under budget
    | 'embedding_timeout'       // the Workers-AI embed call timed out
    | 'search_budget_exceeded'; // the route wall-clock budget was spent

/**
 * Route-level wall-clock budget tracker. One instance per request; tiers check
 * `remaining()` / `over()` between steps and run their per-op work under
 * `withOpTimeout(..., this.opBudget(cap))` so no op can outlast the route.
 */
export class SearchBudget {
    readonly start: number;
    constructor(start: number = Date.now()) {
        this.start = start;
    }
    /** ms elapsed since the route started. */
    elapsed(): number {
        return Date.now() - this.start;
    }
    /** ms left in the route budget (never negative). */
    remaining(): number {
        return Math.max(0, SEARCH_BUDGET_MS - this.elapsed());
    }
    /** True once the route budget is spent — caller must bail with a 503. */
    over(): boolean {
        return this.elapsed() >= SEARCH_BUDGET_MS;
    }
    /**
     * Per-op deadline = min(op firewall, remaining route budget). Guarantees a
     * single op never outlasts the route even if the firewall alone would.
     * Floor at 1ms so a near-exhausted budget still produces a real timer (a 0ms
     * deadline could resolve before the op even starts) rather than NaN/negative.
     */
    opBudget(opCap: number): number {
        return Math.max(1, Math.min(opCap, this.remaining()));
    }
}

const SEARCH_503_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // NEVER cache a transient: search.ts caches 200s via edgeCache.put, so the
    // 503 path must be no-store at the HTTP layer too (CF edge + any shared proxy)
    // so a transient is never served as a sticky "empty/unavailable" answer.
    'Cache-Control': 'no-store',
};

/**
 * Build the honest retryable 503. `reason` is machine-readable (SearchReason);
 * `tier` echoes where in the pipeline we were so telemetry/clients can correlate.
 * Retry-After defaults to 2s (matches compare/entity). The body is JSON so MCP
 * (mcp-search.ts) and REST clients can both parse the reason.
 */
export function searchTransient503(
    reason: SearchReason,
    tier: string,
    retryAfterSec: string = '2',
): Response {
    return new Response(
        JSON.stringify({
            error: 'Search temporarily unavailable (transient/budget); retry later',
            transient: true,
            reason,
            tier,
        }),
        { status: 503, headers: { ...SEARCH_503_HEADERS, 'Retry-After': retryAfterSec } },
    );
}
