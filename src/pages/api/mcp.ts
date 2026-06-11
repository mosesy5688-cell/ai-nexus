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

const SERVER_INFO = { name: 'free2aitools', version: '2.0.0' };

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
        description: 'Search the Free2AITools catalog of AI models, datasets, papers, and tools by keyword. Returns results ranked by FNI (Free2AITools Nexus Index), a 5-factor score combining Semantic relevance, Authority, Popularity, Recency, and Quality. Read-only, no side effects. Use this for broad discovery; use free2aitools_select_model instead when you have specific hardware or license constraints.',
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
        description: 'Keyword-search AI entities using the task text as query input. Returns FNI-ranked catalog entries. Does not perform task-fit recommendation or compatibility analysis. Read-only, no side effects. Use free2aitools_search for keyword-based discovery, or free2aitools_select_model to apply hardware/license metadata filters.',
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
        description: 'Explain why a specific entity received its FNI ranking score by showing the 5-factor breakdown: Semantic (S), Authority (A), Popularity (P), Recency (R), Quality (Q). FNI = 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q. Read-only. Use this after search or rank to understand why an entity scored high or low; use free2aitools_compare instead for side-by-side differences between multiple entities.',
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
        description: 'Filter the Free2AITools catalog by declared metadata and return FNI-ranked entries. Constraints are metadata/heuristic filters, not verified compatibility analysis. The caller is responsible for final model selection. Read-only, no side effects. Use free2aitools_search for unconstrained keyword search, or free2aitools_rank for keyword-based ranking without metadata filters.',
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
        description: 'Compare 2-25 AI models side-by-side showing FNI scores, factor breakdown (Semantic, Authority, Popularity, Recency, Quality), specs (params, VRAM, context length), and license. Read-only, no side effects. Cold upper-range multi-paper requests may return a transient 503 (retry after the indicated delay). Use this when the user wants to decide between specific known models; use free2aitools_select_model to discover models first, then compare the top candidates.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Entity IDs to compare (2-25). Use model_id from select_model results or id from search results (e.g. ["hf-model--meta-llama--llama-3-8b", "hf-model--google--gemma-2-27b"])' }
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

/** Call internal search handler and return parsed results */
async function callSearch(context: any, params: Record<string, string>): Promise<any> {
    const url = new URL(context.url.href);
    url.pathname = '/api/search';
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await searchHandler({ ...context, url });
    return response.json();
}

async function handleToolCall(context: any, toolName: string, args: any) {
    switch (toolName) {
        case 'free2aitools_search': {
            const searchParams: Record<string, string> = { q: args.query || '' };
            if (args.limit) searchParams.limit = String(Math.min(args.limit, 20));
            if (args.type && args.type !== 'all') searchParams.type = args.type;
            const data = await callSearch(context, searchParams);
            if (data.results) data.results.forEach((r: any) => { delete r._dbSort; delete r._score; delete r._source; });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'free2aitools_rank': {
            const query = args.task ? `${args.task} ${args.query || ''}`.trim() : (args.query || '');
            const searchParams: Record<string, string> = { q: query };
            if (args.limit) searchParams.limit = String(Math.min(args.limit, 20));
            const data = await callSearch(context, searchParams);
            if (data.results) data.results.forEach((r: any) => { delete r._dbSort; delete r._score; delete r._source; });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'free2aitools_explain': {
            // V27.10: exact-match by id via entity endpoint instead of fuzzy
            // keyword search. Previously callSearch(q=args.id) failed to match
            // slug-form ids reliably (e.g. "vllm-project--vllm" returned "no
            // entity found" because keyword search tokenized the slug).
            // B4: callEntity preserves the HTTP status so buildExplainResult can
            // keep a transient 503 distinct from a genuine 404 (see mcp-explain.ts).
            const res = await callEntity(context, args.id, (ctx: any) => entityHandler(ctx));
            return buildExplainResult(args.id, res);
        }
        case 'free2aitools_select_model': {
            const selectBody = JSON.stringify({ task: args.task, constraints: args.constraints, limit: args.limit, explain: args.explain });
            const fakeReq = new Request(context.url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: selectBody });
            const res = await selectHandler({ ...context, request: fakeReq });
            const data = await res.json();
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'free2aitools_compare': {
            // B7: callCompare preserves the HTTP status so a transient/budget 503
            // (cold multi-paper fan-out) propagates as an isError + retry hint
            // instead of a thrown generic error / dead connection. Any other
            // non-200 still throws -> the JSON-RPC error path below reports it.
            const ids = Array.isArray(args.ids) ? args.ids.join(',') : args.ids;
            const res = await callCompare(context, ids, (ctx: any) => compareHandler(ctx));
            return buildCompareResult(res);
        }
        default:
            throw new Error(`Unknown tool: ${toolName}`);
    }
}

export const POST: APIRoute = async (context) => {
    let body: any;
    try { body = await context.request.json(); } catch {
        return jsonrpcError(null, -32700, 'Parse error');
    }

    const { id, method, params } = body;

    switch (method) {
        case 'initialize':
            return jsonrpc(id, {
                protocolVersion: '2025-03-26',
                serverInfo: SERVER_INFO,
                instructions: SERVER_BOUNDARY,
                capabilities: { tools: {} }
            });

        case 'tools/list':
            return jsonrpc(id, { tools: TOOLS });

        case 'tools/call': {
            const toolName = params?.name;
            const args = params?.arguments || {};
            try {
                const result = await handleToolCall(context, toolName, args);
                return jsonrpc(id, result);
            } catch (e: any) {
                return jsonrpcError(id, -32603, e.message);
            }
        }

        default:
            return jsonrpcError(id, -32601, `Method not found: ${method}`);
    }
};

export const OPTIONS: APIRoute = async () => {
    return new Response(null, { status: 204, headers: JSONRPC_HEADERS });
};
