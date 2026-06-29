// tools_f2a.ts — Free2AITools tool descriptors + executors.
// PRESENT only in ARM-AVAILABLE. The LIVE executor performs network I/O and is
// NEVER invoked by the test suite; tests use the fixture executor only.
import type { ToolCall, ToolResult } from "./schema_evidence.js";
import { F2AI_TOOL_NAMES, validateF2aiCall } from "./schema_evidence.js";
import type { ToolDescriptor } from "./tools_competing.js";

// LIVE production descriptions, frozen by hash (config/tools.json records the
// mcp.json version + hash). Must NOT reveal the expected choice or the answer.
export const F2AI_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "free2aitools_search",
    description: "Search the Free2AITools catalog of AI tools, models, datasets and papers by query; returns ranked entities with metadata.",
    always_available: false,
  },
  {
    name: "free2aitools_rank",
    description: "Return a ranked ordering of catalog entities for a task or category, with the ranking signal.",
    always_available: false,
  },
  {
    name: "free2aitools_explain",
    description: "Explain an entity with its evidence chain (provenance and source_trail) by canonical id.",
    always_available: false,
  },
  {
    name: "free2aitools_select_model",
    description: "Recommend candidate models for stated requirements; returns candidates with supporting evidence.",
    always_available: false,
  },
  {
    name: "free2aitools_compare",
    description: "Compare two or more catalog entities across attributes, returning a per-attribute evidence-backed comparison.",
    always_available: false,
  },
];

export type F2aiExecutor = (call: ToolCall) => Promise<ToolResult>;

// Fixture executor: deterministic, offline, returns an evidence-bearing body so
// the scorer's citation/completion checks can run without any live request.
export function makeFixtureF2aiExecutor(seedEvidence: string[] = ["src_trail:1", "src_trail:2"]): F2aiExecutor {
  return async (call: ToolCall): Promise<ToolResult> => {
    const v = validateF2aiCall(call);
    if (!v.valid) {
      // Schema-invalid args still reach the boundary; report a 400, schema_valid false.
      return { tool: call.tool, status: 400, schema_valid: false, evidence_ids: [], body: { error: v.errors } };
    }
    return {
      tool: call.tool,
      status: 200,
      schema_valid: true,
      evidence_ids: [...seedEvidence],
      body: { entities: [{ canonical_id: seedEvidence[0], source_trail: seedEvidence }] },
    };
  };
}

// LIVE executor (NOT used in tests). Performs a single network call against the
// public production surface for the cell's transport. Pacing/retry/limits are
// enforced by the runner from config/limits.json, not here.
export function makeLiveF2aiExecutor(baseUrl: string, transport: "REST" | "SDK" | "MCP"): F2aiExecutor {
  return async (call: ToolCall): Promise<ToolResult> => {
    const v = validateF2aiCall(call);
    if (!v.valid) return { tool: call.tool, status: 400, schema_valid: false, evidence_ids: [], body: { error: v.errors } };
    const url = `${baseUrl}/${transport.toLowerCase()}/${call.tool}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call.arguments),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return { tool: call.tool, status: res.status, schema_valid: false, evidence_ids: [], body: null };
    }
    const ids = extractEvidenceIds(body);
    return { tool: call.tool, status: res.status, schema_valid: ids !== null, evidence_ids: ids ?? [], body };
  };
}

function extractEvidenceIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const entities = (body as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return null;
  const ids: string[] = [];
  for (const e of entities) {
    const trail = (e as { source_trail?: unknown }).source_trail;
    if (Array.isArray(trail)) for (const t of trail) if (typeof t === "string") ids.push(t);
  }
  return ids;
}

export const F2AI_NAMES = F2AI_TOOL_NAMES;
