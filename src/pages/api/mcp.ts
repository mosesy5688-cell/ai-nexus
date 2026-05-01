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
        description: 'Search and rank AI tools, models, datasets, and papers by FNI score. Returns ranked results.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language search query' },
                limit: { type: 'number', default: 10 },
                type: { type: 'string', enum: ['all', 'model', 'tool', 'dataset', 'paper'] }
            },
            required: ['query']
        }
    },
    {
        name: 'free2aitools_rank',
        description: 'Rank AI tools by FNI score for a given task context. Ideal for AI agents selecting the best tool.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The task to rank tools for' },
                constraints: { type: 'array', items: { type: 'string' } },
                query: { type: 'string' },
                limit: { type: 'number', default: 10 }
            },
            required: ['query']
        }
    },
    {
        name: 'free2aitools_explain',
        description: 'Explain why a specific AI tool received its FNI ranking score. Search by name to get factor breakdown.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Entity name or ID to explain (e.g. "Llama-3")' }
            },
            required: ['id']
        }
    },
    {
        name: 'free2aitools_select_model',
        description: 'Select the best AI model for a task with hardware/license constraints. Returns ranked recommendations with rationale.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'Task name or description (e.g. "text-generation", "code assistant")' },
                constraints: { type: 'object', properties: { max_vram_gb: { type: 'number' }, max_params_b: { type: 'number' }, license: { type: 'string' }, min_context_length: { type: 'number' }, ollama_compatible: { type: 'boolean' }, can_run_local: { type: 'boolean' }, hosted_on: { type: 'string' }, license_type: { type: 'string', enum: ['permissive', 'copyleft', 'non-commercial', 'any'] } } },
                limit: { type: 'number', default: 5 },
                explain: { type: 'boolean', default: true }
            },
            required: ['task']
        }
    },
    {
        name: 'free2aitools_compare',
        description: 'Compare 2-10 AI models side-by-side with FNI factor decomposition.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Model IDs to compare (2-10)' }
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
