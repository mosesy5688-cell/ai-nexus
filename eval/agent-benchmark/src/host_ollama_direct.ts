// host_ollama_direct.ts — Agent loop #1 (Option A, distinct loop).
// SINGLE-SHOT tool-call loop: one tool round, then a forced finalization turn.
// Transport REST (Ollama OpenAI-compatible). Stateless: no module-level memory,
// so two episodes cannot share state. The model fn is injected (mocked in tests;
// a local Ollama daemon serves it live — never called by the test suite).
import type { Episode, HostContext, StructuredModelFn, ToolCall, ToolResult } from "./schema_evidence.js";

export const HOST_ID = "host_ollama_direct";
export const LOOP_KIND = "single-shot-tool-call";

export async function runOllamaDirectEpisode(ctx: HostContext, infer: StructuredModelFn, maxTurns = 2): Promise<Episode> {
  const messages: unknown[] = [{ role: "user", content: ctx.prompt }];
  const tool_calls: ToolCall[] = [];
  const tool_results: ToolResult[] = [];
  let turns = 0;

  // Turn 1: the model may issue exactly one tool call.
  const first = await infer(messages);
  turns++;
  if (first.action === "final") {
    return finalize(ctx, tool_calls, tool_results, first.final);
  }
  tool_calls.push(first.call);
  const res = await ctx.execute(first.call);
  tool_results.push(res);
  messages.push({ role: "tool", name: first.call.tool, content: JSON.stringify(res.body) });

  // Forced finalization turn (single-shot: no further tool rounds).
  while (turns < maxTurns) {
    const step = await infer(messages);
    turns++;
    if (step.action === "final") return finalize(ctx, tool_calls, tool_results, step.final);
    // Single-shot contract: a second tool request is recorded but not executed;
    // the loop forces a final answer next.
    tool_calls.push(step.call);
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
