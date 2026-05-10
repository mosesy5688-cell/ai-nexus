/**
 * V∞ Phase 3.5: MCP Protocol Server (Streamable HTTP)
 * JSON-RPC 2.0 dispatch — Agent discovery layer for Free2AI.
 * 5 tools: search, rank, explain, select_model, compare.
 */
import type { APIRoute } from 'astro';
import { GET as searchHandler } from './search.js';
import { POST as selectHandler } from './v1/select.js';
import { GET as compareHandler } from './v1/compare.js';

const SERVER_INFO = { name: 'free2aitools', version: '2.0.0' };
const JSONRPC_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const TOOLS = [
    {
        name: 'free2aitools_search',
        description: 'Search 500K+ AI models, datasets, papers, and tools by keyword. Returns results ranked by FNI (Free2AITools Nexus Index), a 5-factor score combining Semantic relevance, Authority, Popularity, Recency, and Quality. Read-only, no side effects. Use this for broad discovery; use free2aitools_select_model instead when you have specific hardware or license constraints.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language search query (e.g. "code generation", "image segmentation")' },
                limit: { type: 'number', default: 10, description: 'Max results to return (1-20, default 10)' },
                type: { type: 'string', enum: ['all', 'model', 'tool', 'dataset', 'paper'], description: 'Filter by entity type (default: all)' }
            },
            required: ['query']
        }
    },
    {
        name: 'free2aitools_rank',
        description: 'Rank AI entities by FNI score for a specific task. Returns a sorted list with scores and metadata. Read-only, no side effects. Use this when you know the task category and want a ranked list; use free2aitools_search for keyword-based discovery, or free2aitools_select_model when you need hardware-constrained recommendations with rationale.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query describing what to rank (e.g. "text generation", "object detection")' },
                task: { type: 'string', description: 'Optional task context to combine with query for more targeted ranking' },
                limit: { type: 'number', default: 10, description: 'Max results to return (1-20, default 10)' },
                constraints: { type: 'array', items: { type: 'string' }, description: 'Optional keyword filters applied to results' }
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
        description: 'Find the best AI model for a task given hardware and license constraints. Returns ranked recommendations with per-model rationale explaining why each was selected. Read-only, no side effects. Use this when the user specifies VRAM, parameter count, or license requirements; use free2aitools_search for unconstrained keyword search, or free2aitools_rank for task-based ranking without hardware filters.',
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
                        ollama_compatible: { type: 'boolean', description: 'Only models runnable via Ollama' },
                        can_run_local: { type: 'boolean', description: 'Only models that can run locally' },
                        hosted_on: { type: 'string', description: 'Hosting platform filter (e.g. "hf-inference")' }
                    }
                },
                limit: { type: 'number', default: 5, description: 'Max recommendations (1-20, default 5)' },
                explain: { type: 'boolean', default: true, description: 'Include per-model rationale text (default true)' }
            },
            required: ['task']
        }
    },
    {
        name: 'free2aitools_compare',
        description: 'Compare 2-10 AI models side-by-side showing FNI scores, factor breakdown (Semantic, Authority, Popularity, Recency, Quality), specs (params, VRAM, context length), and license. Read-only, no side effects. Use this when the user wants to decide between specific known models; use free2aitools_select_model to discover models first, then compare the top candidates.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Entity IDs to compare (2-10). Use model_id from select_model results or id from search results (e.g. ["hf-model--meta-llama--llama-3-8b", "hf-model--google--gemma-2-27b"])' }
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
            const data = await callSearch(context, { q: args.id, limit: '1' });
            const entity = data.results?.[0];
            if (!entity) {
                return { content: [{ type: 'text', text: `No entity found matching "${args.id}".` }] };
            }
            const explanation = {
                id: entity.id, name: entity.name, type: entity.type,
                fni_score: entity.fni_score, author: entity.author,
                factors: {
                    note: 'FNI V2.0 = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)',
                    S: 'Semantic (ANN cosine similarity, query-time)',
                    A: 'Authority (mesh gravity)',
                    P: 'Popularity (log-compressed metrics)',
                    R: 'Recency (exponential decay)',
                    Q: 'Quality (completeness + utility)'
                },
                detail_url: `https://free2aitools.com/${entity.type}s/${entity.slug || entity.id}`
            };
            return { content: [{ type: 'text', text: JSON.stringify(explanation, null, 2) }] };
        }
        case 'free2aitools_select_model': {
            const selectBody = JSON.stringify({ task: args.task, constraints: args.constraints, limit: args.limit, explain: args.explain });
            const fakeReq = new Request(context.url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: selectBody });
            const res = await selectHandler({ ...context, request: fakeReq });
            const data = await res.json();
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        case 'free2aitools_compare': {
            const ids = Array.isArray(args.ids) ? args.ids.join(',') : args.ids;
            const compareUrl = new URL(context.url.href);
            compareUrl.pathname = '/api/v1/compare';
            compareUrl.searchParams.set('ids', ids);
            const res = await compareHandler({ ...context, url: compareUrl });
            const data = await res.json();
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
