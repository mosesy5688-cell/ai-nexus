/**
 * V∞ Phase 3.5: MCP Protocol Server (Streamable HTTP)
 * JSON-RPC 2.0 dispatch — Agent discovery layer for Free2AI.
 * 5 tools: search, rank, explain, select_model, compare.
 */
import type { APIRoute } from 'astro';
import { GET as searchHandler } from './search.js';
import { POST as selectHandler } from './v1/select.js';
import { GET as compareHandler } from './v1/compare.js';
import { GET as entityHandler } from './v1/entity/[...id].js';
import { callEntity, buildExplainResult } from '../../lib/mcp-explain.js';
import { callCompare, buildCompareResult } from '../../lib/mcp-compare.js';
import { callSearchStatus, buildSearchResult } from '../../lib/mcp-search.js';
import { callSelectStatus, buildSelectResult } from '../../lib/mcp-select.js';
// Route-local Adoption Telemetry (DEFAULT-OFF, fail-open, #2218-safe). Imported
// ONLY here + datasets.ts; NEVER from middleware. Does not name the AE binding.
import { emitRoute, extractTelemetryEnv } from '../../lib/telemetry/route-telemetry';
import { mcpToolToOperation, hostFromReferer, isBotUa } from '../../lib/telemetry/route-classify';
import type { McpTool } from '../../lib/telemetry/vocab';

// D-135: MCP server version. F3 changed MCP evidence semantics (search/rank now
// emit fni_s=null + note, not the unmeasured `50`), so bumped 2.0.0 -> 2.0.1.
// Owner = here + public/.well-known/mcp.json only (NOT OpenAPI/SDK/root package).
const SERVER_INFO = { name: 'free2aitools', version: '2.0.1' };

// F4: advertised default result limit for MCP search + rank, pinned so an omitted
// limit does NOT inherit the internal /api/search fallback of 12 (max stays 20).
const MCP_SEARCH_DEFAULT_LIMIT = '10';

// Negative-contract boundary (N1-N4): Free2AITools is a structured discovery,
// evidence, and identity layer for AI agents. Surfaced in initialize.instructions
// so callers know the limits of what this server does before reasoning over it.
const SERVER_BOUNDARY = 'Discovery layer only: returns FNI-ranked catalog data and evidence for the calling agent to reason over. Does not perform compatibility analysis (hardware/framework fields are stored heuristics). Does not execute, plan, or recommend workflows. Does not select or decide on behalf of the caller. Does not currently provide live semantic/ANN ranking.';
const JSONRPC_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const TOOLS = [
    {
        name: 'free2aitools_search',
        description: 'Keyword discovery over the Free2AITools catalog of AI models, datasets, papers, and tools. Returns matching catalog entries (metadata) ranked by FNI (Free2AITools Nexus Index), a 5-factor score: Semantic relevance, Authority, Popularity, Recency, Quality. The Semantic factor is a query-time baseline, not a live per-entity measurement (fni_s is returned null with a note). USE WHEN you need to discover which AI entities exist for a topic or keyword. DO NOT USE for general web search, to run/call/execute a model, to get a generated or inferred answer, or to route to an inference provider — this returns catalog metadata only, for the calling agent to reason over and decide on. Free discovery catalog: results are FNI-ranked, never paid placement / sponsored, and there is no billing or payment. Read-only, no side effects. May return a retryable transient 503 under cold-path or fallback budget limits; retry according to Retry-After. Use free2aitools_select_model instead when you have specific hardware or license constraints.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language search query (e.g. "code generation", "image segmentation")' },
                limit: { type: 'number', default: 10, description: 'Max results to return (1-20, default 10)' },
                type: { type: 'string', enum: ['all', 'model', 'tool', 'dataset', 'paper', 'benchmark'], description: 'Filter by entity type (default: all)' }
            },
            required: ['query']
        }
    },
    {
        name: 'free2aitools_rank',
        description: 'Keyword-search AI entities using the task/query text as input and return FNI-ranked catalog entries. Mechanically this is the same keyword search as free2aitools_search with the task text folded into the query; it does NOT perform task-fit recommendation, compatibility analysis, model inference, or model execution, and it is NOT an inference router. USE WHEN you have task text and want catalog entries ordered by FNI. The caller makes the final selection; results are never paid placement and there is no billing. Read-only, no side effects. May return a retryable transient 503 under cold-path or fallback budget limits; retry according to Retry-After. Use free2aitools_search for plain keyword discovery, or free2aitools_select_model to apply hardware/license metadata filters.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query describing what to rank (e.g. "text generation", "object detection")' },
                task: { type: 'string', description: 'Optional task context to combine with query for more targeted ranking' },
                limit: { type: 'number', default: 10, description: 'Max results to return (1-20, default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'free2aitools_explain',
        description: 'Explain why one specific entity received its FNI score, returning the 5-factor breakdown: Semantic (S), Authority (A), Popularity (P), Recency (R), Quality (Q). FNI = 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q (the S factor is a baseline, surfaced with a caveat, not a measured per-entity value). USE WHEN you already have one entity id (from a search/rank/select result) and want its score rationale. DO NOT USE to search/discover entities, to run a model, or to get a recommendation — this only describes scoring evidence for the caller to interpret. Read-only, no side effects, no billing. Use free2aitools_compare instead for side-by-side differences across multiple entities.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Entity name or ID to explain (e.g. "Llama-3", "hf-model--meta-llama--llama-3-8b")' }
            },
            required: ['id']
        }
    },
    {
        name: 'free2aitools_select_model',
        description: 'Filter the Free2AITools catalog by declared hardware/license metadata and return FNI-ranked candidate entries. USE WHEN you have concrete constraints (VRAM, params, license, context length, local-runnability) and want candidates narrowed by them. Constraints are metadata/heuristic filters over stored fields, NOT verified compatibility analysis, model inference, or model execution; this tool does not decide for you and is not an inference router. The caller is responsible for the final selection. Results are FNI-ranked, never paid placement, with no billing. Read-only, no side effects. Use free2aitools_search for unconstrained keyword discovery, or free2aitools_rank for keyword ranking without metadata filters.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'Task name or natural language description (e.g. "text-generation", "code assistant", "image classification")' },
                constraints: {
                    type: 'object', description: 'Hardware and license filters (all optional)',
                    properties: {
                        max_vram_gb: { type: 'number', description: 'Maximum GPU VRAM in GB (e.g. 8, 24)' },
                        max_params_b: { type: 'number', description: 'Maximum model parameters in billions' },
                        license: { type: 'string', description: 'Specific license (e.g. "Apache-2.0", "MIT")' },
                        license_type: { type: 'string', enum: ['permissive', 'copyleft', 'non-commercial', 'any'], description: 'License category filter' },
                        min_context_length: { type: 'number', description: 'Minimum context window in tokens' },
                        ollama_compatible: { type: 'boolean', description: 'Heuristic filter on stored metadata (GGUF indicators). Does not verify actual Ollama runtime compatibility on the caller hardware.' },
                        can_run_local: { type: 'boolean', description: 'Heuristic local-runnability filter based on stored metadata such as model size and GGUF indicators. Does not verify actual runtime compatibility on the caller hardware or framework.' },
                        hosted_on: { type: 'string', description: 'Hosting platform filter (e.g. "hf-inference")' }
                    }
                },
                limit: { type: 'number', default: 5, description: 'Max entries returned (1-20, default 5)' },
                explain: { type: 'boolean', default: true, description: 'Include per-entry fni_summary (factual FNI factor/spec facts) and caveats in the response (default true)' }
            },
            required: ['task']
        }
    },
    {
        name: 'free2aitools_compare',
        description: 'Compare 2-25 AI catalog entities side-by-side — any catalog entity type (models, datasets, papers, tools), not models only — showing FNI scores, factor breakdown (Semantic, Authority, Popularity, Recency, Quality), specs (params, VRAM, context length) where applicable, and license. USE WHEN you already have 2+ specific entity ids and want a structured side-by-side. DO NOT USE to discover entities, to run/execute a model, or to get a recommendation; the tool presents comparison facts for the caller to decide on, is not an inference router, and returns no paid placement. Read-only, no side effects, no billing. Cold upper-range multi-paper requests may return a transient 503 (retry after the indicated delay). Use free2aitools_select_model or free2aitools_search to discover candidates first, then compare the top ones.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Catalog entity IDs to compare (2-25), any entity type. Use the id from search/rank/select_model results verbatim (e.g. ["hf-model--meta-llama--llama-3-8b", "arxiv--2401.00001"])' }
            },
            required: ['ids']
        }
    }
];

function jsonrpc(id: any, result: any) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: JSONRPC_HEADERS });
}

function jsonrpcError(id: any, code: number, message: string) {
    return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
        { headers: JSONRPC_HEADERS }
    );
}

async function handleToolCall(context: any, toolName: string, args: any) {
    switch (toolName) {
        case 'free2aitools_search': {
            // B8: callSearchStatus preserves the HTTP status (transient 503 ->
            // isError + retry, not a fake-empty result). F4: pin the advertised
            // default 10 so an omitted limit does not fall through to the internal 12.
            const searchParams: Record<string, string> = { q: args.query || '', limit: MCP_SEARCH_DEFAULT_LIMIT };
            if (args.limit) searchParams.limit = String(Math.min(args.limit, 20));
            if (args.type && args.type !== 'all') searchParams.type = args.type;
            const res = await callSearchStatus(context, searchParams, (ctx: any) => searchHandler(ctx));
            return buildSearchResult(res);
        }
        case 'free2aitools_rank': {
            // B8: same transient propagation as search — rank IS keyword search.
            const query = args.task ? `${args.task} ${args.query || ''}`.trim() : (args.query || '');
            // F4: same advertised default 10 as search (not the internal 12).
            const searchParams: Record<string, string> = { q: query, limit: MCP_SEARCH_DEFAULT_LIMIT };
            if (args.limit) searchParams.limit = String(Math.min(args.limit, 20));
            const res = await callSearchStatus(context, searchParams, (ctx: any) => searchHandler(ctx));
            return buildSearchResult(res);
        }
        case 'free2aitools_explain': {
            // V27.10: exact-match by id via entity endpoint (not fuzzy keyword
            // search, which tokenized slug-form ids). B4: callEntity preserves the
            // HTTP status so a transient 503 stays distinct from a genuine 404.
            const res = await callEntity(context, args.id, (ctx: any) => entityHandler(ctx));
            return buildExplainResult(args.id, res);
        }
        case 'free2aitools_select_model': {
            // G-05: callSelectStatus preserves the HTTP status so a transient 503
            // (rankings DB cold path) propagates as isError + retry hint instead of
            // being laundered into a normal result; the 200 body passes through
            // unchanged. Transport-status mapping only — no capability added, the
            // negative-contract boundary (no selection/verdict) is untouched.
            const res = await callSelectStatus(
                context,
                { task: args.task, constraints: args.constraints, limit: args.limit, explain: args.explain },
                (ctx: any) => selectHandler(ctx),
            );
            return buildSelectResult(res);
        }
        case 'free2aitools_compare': {
            // B7: callCompare preserves the HTTP status so a transient/budget 503
            // (cold multi-paper fan-out) propagates as isError + retry hint; any
            // other non-200 throws -> the JSON-RPC error path below reports it.
            const ids = Array.isArray(args.ids) ? args.ids.join(',') : args.ids;
            const res = await callCompare(context, ids, (ctx: any) => compareHandler(ctx));
            return buildCompareResult(res);
        }
        default:
            throw new Error(`Unknown tool: ${toolName}`);
    }
}

// Route-local telemetry recorder. DEFAULT-OFF, fail-open, NON-BLOCKING: emits a
// closed low-cardinality event (surface + closed tool enum + coarse status) to a
// write adapter that no-ops unless enabled & bound. NEVER alters the serve path;
// failures are swallowed in emitRoute. Audience/referer derive from already-read
// header VALUES (never stored raw); NO request body/args are recorded.
function recordMcp(
    context: any,
    surface: 'mcp.initialize' | 'mcp.tools_call',
    operation: McpTool | null,
    status: number,
): void {
    try {
        const headers = context?.request?.headers;
        emitRoute(extractTelemetryEnv(context?.locals), {
            surface, status, operation, cacheClass: 'none',
            refererHost: hostFromReferer(headers?.get?.('referer')),
            audience: { isMcpClient: true, isBot: isBotUa(headers?.get?.('user-agent')) },
        });
    } catch { /* fail-open: telemetry never touches the serve path */ }
}

export const POST: APIRoute = async (context) => {
    let body: any;
    try { body = await context.request.json(); } catch {
        return jsonrpcError(null, -32700, 'Parse error');
    }

    const { id, method, params } = body;

    switch (method) {
        case 'initialize': {
            const response = jsonrpc(id, {
                protocolVersion: '2025-03-26',
                serverInfo: SERVER_INFO,
                instructions: SERVER_BOUNDARY,
                capabilities: { tools: {} }
            });
            recordMcp(context, 'mcp.initialize', null, response.status);
            return response;
        }

        case 'tools/list':
            return jsonrpc(id, { tools: TOOLS });

        case 'tools/call': {
            const toolName = params?.name;
            const args = params?.arguments || {};
            const operation = mcpToolToOperation(toolName);
            try {
                const result = await handleToolCall(context, toolName, args);
                const response = jsonrpc(id, result);
                recordMcp(context, 'mcp.tools_call', operation, response.status);
                return response;
            } catch (e: any) {
                const response = jsonrpcError(id, -32603, e.message);
                recordMcp(context, 'mcp.tools_call', operation, response.status);
                return response;
            }
        }

        default:
            return jsonrpcError(id, -32601, `Method not found: ${method}`);
    }
};

export const OPTIONS: APIRoute = async () => {
    return new Response(null, { status: 204, headers: JSONRPC_HEADERS });
};
