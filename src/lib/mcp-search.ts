/**
 * MCP free2aitools_search + free2aitools_rank handler — status-aware result (B8).
 *
 * Sibling of mcp-compare.ts / mcp-explain.ts. Both tools call the internal
 * /api/search GET handler, which (B8) can now return an honest retryable 503 when
 * a search tier exhausts its wall-clock/op budget (term-index, cold-shard
 * hydration, or the Tier-2 cluster fallback). Previously mcp.ts read only the
 * JSON body and forwarded it verbatim — so a 503 (a body WITHOUT `results`) was
 * relayed as a non-error tool result, training an agent to read a transient as
 * "no results" (Founder prohibition: a transient must never masquerade as an
 * empty result).
 *
 * This mirrors mcp-compare.ts: preserve the HTTP STATUS + Retry-After so a 503
 * propagates as a TRANSIENT tool result (isError + retry hint) instead of a fake
 * empty/result. A genuine 200 (including a legitimately empty results array) is
 * returned unchanged. Any other non-200 throws so mcp.ts's catch reports it.
 */
import type { McpToolResult } from './mcp-explain.js';
// D-135 (F3): same shared owner REST v1 /api/v1/search uses. MCP search/rank
// dispatch goes straight to the internal /api/search (bypassing the v1 wrapper),
// so the raw rows still carry the constant `fni_s: 50` baseline with no caveat.
// Normalize here at the MCP response boundary so MCP matches REST v1 evidence
// semantics (fni_s = null + canonical note) WITHOUT a divergent hard-coded copy.
import { normalizeSearchEvidence, EVIDENCE_CONTRACT_VERSION } from '../constants/evidence-contract.js';

/** Internal search-endpoint result with the HTTP status preserved. */
export interface SearchCallResult {
    status: number;
    retryAfter: string | null;
    data: any;
}

/**
 * Call the internal search GET handler and surface status + Retry-After.
 * `searchHandler` is the route's GET export, passed in so this module stays
 * decoupled from the page-route import graph (and trivially testable).
 */
export async function callSearchStatus(
    context: any,
    params: Record<string, string>,
    searchHandler: (ctx: any) => Promise<Response>,
): Promise<SearchCallResult> {
    const url = new URL(context.url.href);
    url.pathname = '/api/search';
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await searchHandler({ ...context, url });
    let data: any = null;
    try { data = await response.json(); } catch { /* non-JSON body -> data stays null */ }
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), data };
}

/**
 * Format a search/rank tool result. A 503 -> transient isError result with a
 * retry hint and the machine-readable reason (NOT a fake-empty result), so an
 * agent retries instead of concluding "no matches". A 200 -> the search JSON
 * unchanged (internal _dbSort/_score/_source stripped), even when `results` is a
 * genuinely empty array (a real empty search is NOT an error). Any other non-200
 * throws so mcp.ts's catch reports it via the JSON-RPC error path.
 */
export function buildSearchResult(res: SearchCallResult): McpToolResult {
    if (res.status === 503) {
        const retry = res.retryAfter || '2';
        const reason = res.data?.reason ? ` (${res.data.reason})` : '';
        return {
            isError: true,
            content: [{ type: 'text', text: `Search is temporarily unavailable (transient/budget)${reason}. Retry after ${retry}s.` }],
        };
    }
    if (res.status !== 200) {
        throw new Error(`Search failed: HTTP ${res.status}`);
    }
    const data = res.data || {};
    if (Array.isArray(data.results)) {
        // F3: strip internal sort fields AND normalize the Semantic-evidence
        // fields so MCP never presents the unmeasured `fni_s: 50` baseline as a
        // measured value. IDs, ordering, total_count, fni_score, and the
        // non-semantic pillars (A/P/R/Q) are untouched — no re-rank, no remote
        // call, no synthetic replacement score.
        for (const r of data.results) {
            delete r._dbSort; delete r._score; delete r._source;
            normalizeSearchEvidence(r);
        }
    }
    // Carry the public evidence-contract version on the MCP envelope so an Agent
    // sees the same version tag REST v1 attaches (the internal /api/search body
    // has none). Non-destructive: spread the data after `version` so any existing
    // body field wins if a future internal route ever sets its own `version`.
    const payload = { version: EVIDENCE_CONTRACT_VERSION, ...data };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
