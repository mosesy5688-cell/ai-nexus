/**
 * SRS-2 MCP baseline — JSON-RPC 2.0 client + contract assertions (Founder-exact).
 *
 * A thin MCP client over the SAME shaped fetch (srs2-api-helpers: pacing, dedup,
 * descriptive UA, <=2 Retry-After retries) and the SAME provenance record/CellState
 * model (srs2a-helpers). Does NOT re-implement the SRS-2A classifier; a 429/503 on
 * the MCP endpoint is INCONCLUSIVE_TRANSIENT exactly like the REST cells.
 *
 * MCP transport: POST /api/mcp, JSON-RPC 2.0. The deployed MCP maps an underlying
 * transient 503 to a tool RESULT with `isError:true` + retry-hint text (NOT a
 * JSON-RPC error); a genuine miss (e.g. explain 404) is a NON-error result; any
 * other non-200 underlying status surfaces as a structured JSON-RPC error
 * (code -32603). The static manifest is /.well-known/mcp.json. The 5 tool names
 * are locked: free2aitools_{search,rank,explain,select_model,compare}.
 */
import { shapedFetch, safeJson, recordApi, record, type ApiRequest } from './srs2-api-helpers';

export const MCP_PATH = '/api/mcp';
export const MCP_MANIFEST_PATH = '/.well-known/mcp.json';

/** The Founder-locked 5-tool set (static manifest <-> dynamic tools/list parity). */
export const MCP_TOOLS = [
    'free2aitools_search', 'free2aitools_rank', 'free2aitools_explain',
    'free2aitools_select_model', 'free2aitools_compare',
] as const;

/** Terms that would indicate model-pick / verdict / recommendation / routing drift
 *  in a tool's OUTPUT text (negative contract — the discovery layer must NOT decide
 *  for the caller). Presence in a tool-result text = PRODUCT_FAILURE. The neutral
 *  factual FNI summary ("not a selection verdict") is explicitly allowed because it
 *  states the negative; we match decisive phrasing, not the disclaimer. */
export const DRIFT_TERMS = [
    'we recommend', 'you should use', 'best choice', 'the winner is',
    'i recommend', 'our recommendation', 'routing decision', 'i suggest you',
    'the right model for you', 'optimal choice is',
];

let rpcId = 0;

export interface RpcResult { status: number; body: any; retries: number; resp: any; }

/** Issue one JSON-RPC call over the shaped MCP transport. */
export async function rpc(request: ApiRequest, method: string, params?: unknown): Promise<RpcResult> {
    const id = ++rpcId;
    const { resp, retries } = await shapedFetch(request, 'POST', MCP_PATH, { data: { jsonrpc: '2.0', id, method, params } });
    const parsed = await safeJson(resp);
    return { status: resp.status(), body: parsed.data, retries, resp };
}

/** Convenience: a tools/call for one tool with arguments. */
export function callTool(request: ApiRequest, name: string, args: Record<string, unknown>): Promise<RpcResult> {
    return rpc(request, 'tools/call', { name, arguments: args });
}

/** Extract the concatenated text of a tool result's content array (or ''). */
export function toolText(r: RpcResult): string {
    const content = r.body?.result?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((c: any) => c && c.type === 'text').map((c: any) => c.text || '').join('\n');
}

/** True iff the JSON-RPC envelope is a well-formed success ({jsonrpc,id,result}). */
export function isRpcSuccess(r: RpcResult): boolean {
    return r.status === 200 && r.body?.jsonrpc === '2.0' && r.body?.result !== undefined && r.body?.error === undefined;
}

/** True iff the JSON-RPC envelope is a well-formed structured error ({error{code,message}}). */
export function isRpcError(r: RpcResult): boolean {
    const e = r.body?.error;
    return r.body?.jsonrpc === '2.0' && !!e && typeof e.code === 'number' && typeof e.message === 'string';
}

/** True iff the tool result carries isError:true (transient/failure tool result). */
export function isToolError(r: RpcResult): boolean {
    return r.body?.result?.isError === true;
}

/** No model-pick / verdict / recommendation / routing language in the output text. */
export function hasDrift(text: string): boolean {
    const t = text.toLowerCase();
    return DRIFT_TERMS.some((d) => t.includes(d));
}

/**
 * Record one MCP cell. A 429/503 transport status -> INCONCLUSIVE_TRANSIENT (cell
 * UNCLOSED). An underlying-transient tool result (isError:true with a 503/retry
 * hint) is ALSO surfaced as INCONCLUSIVE_TRANSIENT — it is a transient, not a clean
 * pass and not a product defect. Otherwise `pass` decides PASS vs PRODUCT_FAILURE.
 */
export function recordMcp(
    assertion: string, expected: string, r: RpcResult, pass: boolean,
    extra: { transientTool?: boolean; keyFields?: Record<string, unknown> } = {},
): void {
    if (r.status === 429 || r.status === 503 || extra.transientTool) {
        record({ assertion, expected, actual: `mcp transient status=${r.status} isError=${isToolError(r)}`, state: 'INCONCLUSIVE_TRANSIENT', retries: r.retries, keyFields: { status: r.status, ...extra.keyFields } });
        return;
    }
    recordApi(assertion, expected, r.resp, pass, { retries: r.retries, keyFields: extra.keyFields });
}

/** Pattern naming an underlying transient/budget upstream condition (the deployed
 *  MCP maps an upstream 503 to isError:true with a retry hint; an upstream 500 from
 *  a cold/budget-bailed select surfaces as a JSON-RPC -32603 naming the status). */
const TRANSIENT_HINT = /50[03]|retry|transient|temporarily|rate.?limit|unavailable|budget|cold|inconclusive/i;

/** Detect an underlying-transient signal: (a) a tool result with isError:true whose
 *  text names a transient hint, OR (b) a structured JSON-RPC -32603 error whose
 *  message names an upstream 500/503/budget condition. Both are INCONCLUSIVE
 *  (cell UNCLOSED), NOT a clean pass and NOT a deterministic product defect. A
 *  deterministic JSON-RPC error (e.g. -32601/-32700) is NOT transient. */
export function isTransientToolResult(r: RpcResult): boolean {
    if (isToolError(r) && TRANSIENT_HINT.test(toolText(r))) return true;
    const e = r.body?.error;
    return !!e && e.code === -32603 && typeof e.message === 'string' && TRANSIENT_HINT.test(e.message);
}
