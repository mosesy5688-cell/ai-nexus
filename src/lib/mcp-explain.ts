/**
 * MCP free2aitools_explain handler — entity lookup + status-aware result.
 *
 * Extracted from src/pages/api/mcp.ts (B4) to keep that file under the CES
 * Art 5.1 250-line cap. Owns the two B4 behaviors for the explain tool:
 *
 *   1. callEntity propagates the entity endpoint's HTTP STATUS (not just the
 *      JSON body), so a transient 503 ("budget/transient; retry") is no longer
 *      conflated with a genuine 404 ("does not exist").
 *   2. buildExplainResult branches on status: 503 -> an isError tool result that
 *      conveys "transient, retry after Ns" (so the agent retries instead of
 *      hard-coding us out on a flaky lookup of a REAL entity); 404 / other non-
 *      200 -> the legitimate "No entity found" miss; 200 -> the FNI breakdown.
 */

/** Internal entity-endpoint result with the HTTP status preserved. */
export interface EntityCallResult {
    status: number;
    retryAfter: string | null;
    data: any;
}

/** MCP tool-call content payload (text blocks + optional isError flag). */
export interface McpToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

/**
 * Call the internal entity GET handler and surface status + Retry-After.
 * `entityHandler` is the route's GET export; passed in so this module stays
 * decoupled from the page-route import graph (and trivially testable).
 */
export async function callEntity(
    context: any,
    id: string,
    entityHandler: (ctx: any) => Promise<Response>,
): Promise<EntityCallResult> {
    const url = new URL(context.url.href);
    url.pathname = `/api/v1/entity/${encodeURIComponent(id)}`;
    const response = await entityHandler({ ...context, url, params: { id } });
    let data: any = null;
    try { data = await response.json(); } catch { /* non-JSON body -> data stays null */ }
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), data };
}

/** Format the explain tool result from an entity-endpoint call result. */
export function buildExplainResult(id: string, res: EntityCallResult): McpToolResult {
    const e = res.data?.entity;
    if (!e) {
        // B4: status-aware miss. A 503 is a transient/budget miss of a possibly-
        // real entity (retryable) — NOT "does not exist". Keep the two distinct
        // so an agent retries instead of concluding the entity is absent. 404
        // (and any non-200 fallthrough) -> genuine miss = "No entity found".
        if (res.status === 503) {
            const retry = res.retryAfter || '2';
            return {
                isError: true,
                content: [{ type: 'text', text: `Lookup for "${id}" is temporarily unavailable (transient/budget). Retry after ${retry}s.` }],
            };
        }
        return { content: [{ type: 'text', text: `No entity found matching "${id}".` }] };
    }
    const f = e.fni?.factors || {};
    const explanation = {
        id: e.id, name: e.name, type: e.type, author: e.author,
        fni_score: e.fni?.score,
        factors: {
            // V27 honesty sweep: S is a query-time signal; on this static detail
            // surface it is not a per-entity measurement, so the entity API
            // returns null + a note. Carry the note through so null is read as
            // "by-design, scored live" not "missing/error".
            S_semantic: f.semantic ?? null,
            S_semantic_note: f.semantic_note ?? 'query-time baseline; scored live at search; not a per-entity value',
            A_authority: f.authority ?? null,
            P_popularity: f.popularity ?? null,
            R_recency: f.recency ?? null,
            Q_quality: f.quality ?? null,
            formula: 'min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)',
        },
        detail_url: e.links?.detail_url || `https://free2aitools.com/${e.type}s/${e.slug || e.id}`,
    };
    return { content: [{ type: 'text', text: JSON.stringify(explanation, null, 2) }] };
}
