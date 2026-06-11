/**
 * MCP free2aitools_compare handler — status-aware result (B7).
 *
 * Sibling of mcp-explain.ts. The compare tool calls the internal /api/v1/compare
 * handler, which (B7) can now return an honest retryable 503 when a cold
 * multi-paper fan-out exhausts its wall-clock budget / fan-out cap. Previously
 * mcp.ts did `if (!res.ok) throw` — turning that 503 into a generic JSON-RPC
 * -32603 error (or, before the budget existed, a dead connection). That trains an
 * agent to treat a transient/budget miss as a hard failure.
 *
 * This mirrors mcp-explain.ts's callEntity pattern: preserve the HTTP STATUS and
 * Retry-After so a 503 propagates as a TRANSIENT tool result (isError + retry
 * hint) instead of a thrown generic error. A genuine 4xx/5xx still throws so the
 * existing JSON-RPC error path reports it.
 */
import type { McpToolResult } from './mcp-explain.js';

/** Internal compare-endpoint result with the HTTP status preserved. */
export interface CompareCallResult {
    status: number;
    retryAfter: string | null;
    data: any;
}

/**
 * Call the internal compare GET handler and surface status + Retry-After.
 * `compareHandler` is the route's GET export, passed in so this module stays
 * decoupled from the page-route import graph (and trivially testable).
 */
export async function callCompare(
    context: any,
    ids: string,
    compareHandler: (ctx: any) => Promise<Response>,
): Promise<CompareCallResult> {
    const url = new URL(context.url.href);
    url.pathname = '/api/v1/compare';
    url.searchParams.set('ids', ids);
    const response = await compareHandler({ ...context, url });
    let data: any = null;
    try { data = await response.json(); } catch { /* non-JSON body -> data stays null */ }
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), data };
}

/**
 * Format the compare tool result. A 503 -> transient isError result with a retry
 * hint (and the honest resolved/pending split when present), NOT a throw. Any
 * other non-200 throws so mcp.ts's catch reports it via the JSON-RPC error path.
 * A 200 returns the comparison JSON unchanged (envelope shape preserved).
 */
export function buildCompareResult(res: CompareCallResult): McpToolResult {
    if (res.status === 503) {
        const retry = res.retryAfter || '2';
        const pending = Array.isArray(res.data?.pending) ? res.data.pending : null;
        const partial = pending && pending.length
            ? ` Pending ids: ${pending.join(', ')}.`
            : '';
        return {
            isError: true,
            content: [{ type: 'text', text: `Comparison is temporarily unavailable (transient/budget). Retry after ${retry}s.${partial}` }],
        };
    }
    if (res.status !== 200) {
        throw new Error(`Compare failed: HTTP ${res.status}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
}
