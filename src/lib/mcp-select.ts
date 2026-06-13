/**
 * MCP free2aitools_select_model handler — status-aware result (G-05).
 *
 * Sibling of mcp-search.ts / mcp-compare.ts / mcp-explain.ts. The select_model
 * tool calls the internal POST /api/v1/select handler, which can return an honest
 * retryable 503 when the rankings DB is not yet available (missing
 * partitions.rankings_dbs / pre-pipeline cold path) or a transient VFS miss.
 * Previously mcp.ts read only the JSON body and forwarded it verbatim REGARDLESS
 * of HTTP status — so a transient 503 (a body WITHOUT `entries`) was relayed as a
 * normal successful tool result, training an agent to read a transient as a valid
 * (empty) selection (Founder prohibition: a transient must never masquerade as a
 * successful result).
 *
 * This mirrors the sibling modules: preserve the HTTP STATUS + Retry-After so a
 * 503 propagates as a TRANSIENT tool result (isError + retry hint + the
 * machine-readable reason) instead of a fake-success. A genuine 200 (including a
 * legitimately empty entries array) is returned byte-for-byte unchanged. Any
 * other non-200 throws so mcp.ts's catch reports it via the JSON-RPC error path.
 *
 * Negative-contract boundary (unchanged): this module only maps transport status;
 * it does NOT add selection/verdict/recommendation. The 200 body is the select
 * endpoint's own honest FNI-filtered catalog payload, passed through untouched.
 */
import type { McpToolResult } from './mcp-explain.js';

/** Internal select-endpoint result with the HTTP status preserved. */
export interface SelectCallResult {
    status: number;
    retryAfter: string | null;
    data: any;
}

/**
 * Call the internal select POST handler and surface status + Retry-After.
 * `selectHandler` is the route's POST export, passed in so this module stays
 * decoupled from the page-route import graph (and trivially testable).
 */
export async function callSelectStatus(
    context: any,
    body: { task: any; constraints: any; limit: any; explain: any },
    selectHandler: (ctx: any) => Promise<Response>,
): Promise<SelectCallResult> {
    const fakeReq = new Request(context.url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const response = await selectHandler({ ...context, request: fakeReq });
    let data: any = null;
    try { data = await response.json(); } catch { /* non-JSON body -> data stays null */ }
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), data };
}

/**
 * Format the select_model tool result. A 503 -> transient isError result with a
 * retry hint and the machine-readable reason (NOT a fake-success), so an agent
 * retries instead of concluding it received a valid (empty) selection. A 200 ->
 * the select JSON unchanged (byte-for-byte today's output). Any other non-200
 * throws so mcp.ts's catch reports it via the JSON-RPC error path.
 */
export function buildSelectResult(res: SelectCallResult): McpToolResult {
    if (res.status === 503) {
        const retry = res.retryAfter || '2';
        const reason = res.data?.error ? ` (${res.data.error})` : '';
        return {
            isError: true,
            content: [{ type: 'text', text: `Model selection is temporarily unavailable (transient/budget)${reason}. Retry after ${retry}s.` }],
        };
    }
    if (res.status !== 200) {
        throw new Error(`Select failed: HTTP ${res.status}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
}
