// host_mcp_client.ts — Agent loop #2 (Option A, distinct loop).
// STREAMABLE-HTTP MCP agent loop: tools/list then a multi-turn tools/call loop
// until the model finalizes or max turns is reached. Transport MCP. Distinct
// model FAMILY (Llama-3.1) per matrix.json. Stateless across episodes.
import type { Episode, HostContext, StructuredModelFn, ToolCall, ToolResult } from "./schema_evidence.js";

export const HOST_ID = "host_mcp_client";
export const LOOP_KIND = "mcp-agent-loop";

export async function runMcpAgentEpisode(ctx: HostContext, infer: StructuredModelFn, maxTurns = 4): Promise<Episode> {
  // MCP framing: a tools/list advertisement precedes the agent turns.
  const messages: unknown[] = [
    { role: "system", content: "mcp:tools/list" },
    { role: "tools", content: ctx.tools.map((t) => ({ name: t.name, description: t.description })) },
    { role: "user", content: ctx.prompt },
  ];
  const tool_calls: ToolCall[] = [];
  const tool_results: ToolResult[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const step = await infer(messages);
    if (step.action === "final") return finalize(ctx, tool_calls, tool_results, step.final);
    // tools/call round-trip (JSON-RPC framing over the streamable-http transport).
    tool_calls.push(step.call);
    const res = await ctx.execute(step.call);
    tool_results.push(res);
    messages.push({ role: "assistant", content: { mcp: "tools/call", call: step.call } });
    messages.push({ role: "tool", name: step.call.tool, content: JSON.stringify(res.body) });
  }
  return finalize(ctx, tool_calls, tool_results, { text: "(no final answer emitted)" }, "max_agent_turns_reached_without_final");
}

function finalize(
  ctx: HostContext,
  tool_calls: ToolCall[],
  tool_results: ToolResult[],
  final: Episode["final"],
  invalidReason?: string,
): Episode {
  return {
    scenario_id: ctx.scenario_id,
    runtime_id: ctx.runtime_id,
    arm: ctx.arm,
    rep: ctx.rep,
    seed: ctx.seed,
    session_id: ctx.session_id,
    injected_fault: ctx.injected_fault ?? null,
    tool_calls,
    tool_results,
    final,
    valid: invalidReason === undefined,
    ...(invalidReason ? { invalid_reason: invalidReason } : {}),
  };
}

// Thin in-repo streamable-http MCP client for the LIVE path only (no external
// MCP dependency). NEVER invoked by the test suite. JSON-RPC 2.0 over HTTP POST.
export class StreamableHttpMcpClient {
  private id = 0;
  constructor(private endpoint: string, private protocolVersion = "2025-03-26") {}

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": this.protocolVersion },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    return res.json();
  }

  listTools(): Promise<unknown> {
    return this.rpc("tools/list", {});
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args });
  }
}

export function liveMcpExecutor(client: StreamableHttpMcpClient): (call: ToolCall) => Promise<ToolResult> {
  return async (call: ToolCall): Promise<ToolResult> => {
    const body = (await client.callTool(call.tool, call.arguments)) as Record<string, unknown>;
    const result = (body?.result ?? null) as { entities?: unknown[] } | null;
    const ids: string[] = [];
    for (const e of result?.entities ?? []) {
      const trail = (e as { source_trail?: unknown }).source_trail;
      if (Array.isArray(trail)) for (const t of trail) if (typeof t === "string") ids.push(t);
    }
    return { tool: call.tool, status: result ? 200 : 500, schema_valid: result !== null, evidence_ids: ids, body };
  };
}
