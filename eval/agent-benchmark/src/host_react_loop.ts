// host_react_loop.ts — Agent loop #3 (Option A, distinct loop; the one narrow
// additional local Agent-host adapter authorized for §C third-runtime
// independence). ReAct-style multi-turn TEXT protocol (Thought/Action/Observation)
// driving tool dispatch from parsed text. Transport SDK (entity surface). Distinct
// model FAMILY (Mistral) per matrix.json. Stateless across episodes.
import type { Episode, FinalAssertion, HostContext, ReactModelFn, ToolCall, ToolResult } from "./schema_evidence.js";

export const HOST_ID = "host_react_loop";
export const LOOP_KIND = "react-multi-turn";

// Parses a ReAct step: `Action: <tool> <json-args>` or `Final: <text>`.
export function parseReactStep(text: string): { action: "call"; call: ToolCall } | { action: "final"; final: FinalAssertion } {
  const finalMatch = /(?:^|\n)\s*Final:\s*([\s\S]*)$/i.exec(text);
  if (finalMatch) {
    const raw = finalMatch[1]!.trim();
    const parsed = tryJson(raw);
    if (parsed && typeof parsed === "object") return { action: "final", final: parsed as FinalAssertion };
    return { action: "final", final: { text: raw } };
  }
  const actMatch = /(?:^|\n)\s*Action:\s*([a-z0-9_]+)\s*([\s\S]*)$/i.exec(text);
  if (actMatch) {
    const tool = actMatch[1]!;
    const args = (tryJson(actMatch[2]!.trim()) as Record<string, unknown> | null) ?? {};
    return { action: "call", call: { tool, arguments: args } };
  }
  // No parseable action => treat the whole text as a direct (final) answer.
  return { action: "final", final: { text: text.trim() } };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function runReactEpisode(ctx: HostContext, infer: ReactModelFn, maxTurns = 6): Promise<Episode> {
  let transcript = `Task: ${ctx.prompt}\nTools: ${ctx.tools.map((t) => t.name).join(", ")}\n`;
  const tool_calls: ToolCall[] = [];
  const tool_results: ToolResult[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const text = await infer(transcript);
    const step = parseReactStep(text);
    if (step.action === "final") return finalize(ctx, tool_calls, tool_results, step.final);
    tool_calls.push(step.call);
    const res = await ctx.execute(step.call);
    tool_results.push(res);
    transcript += `\nThought->Action: ${step.call.tool}\nObservation: ${JSON.stringify(res.body)}\n`;
  }
  return finalize(ctx, tool_calls, tool_results, { text: "(no final answer emitted)" }, "max_agent_turns_reached_without_final");
}

function finalize(
  ctx: HostContext,
  tool_calls: ToolCall[],
  tool_results: ToolResult[],
  final: FinalAssertion,
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
