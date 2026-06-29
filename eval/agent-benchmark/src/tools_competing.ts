// tools_competing.ts — non-F2AI tools available on EVERY scenario in BOTH arms.
// Fixture-backed and genuinely usable (not crippled). No live calls.
import type { ToolCall, ToolResult } from "./schema_evidence.js";
import { COMPETING_TOOL_NAMES } from "./schema_evidence.js";

export interface ToolDescriptor {
  name: string;
  description: string;
  always_available: boolean;
}

// Neutral, comparable descriptions. None reveals the expected choice.
export const COMPETING_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "answer_directly",
    description: "Answer the user directly from your own knowledge without calling any tool.",
    always_available: true,
  },
  {
    name: "web_search",
    description: "General keyword web search; returns title + snippet + url for matching pages.",
    always_available: true,
  },
  {
    name: "model_catalog_generic",
    description: "Look up basic public model metadata (name, parameters, license, downloads) by keyword.",
    always_available: true,
  },
];

const competingSet = new Set<string>(COMPETING_TOOL_NAMES);
export function isCompetingTool(name: string): boolean {
  return competingSet.has(name);
}

// A small frozen fixture snapshot so competing tools really return useful data
// (proving they are not crippled). Deterministic; offline.
const WEB_SNIPPETS: Record<string, string> = {
  default: "A general overview page with a title, snippet and url.",
  license: "An overview of common open-weight model licenses (Apache-2.0, MIT, community licenses).",
  dataset: "A list of public datasets with brief license notes.",
};
const CATALOG_FIXTURE: Record<string, unknown> = {
  default: { name: "example-open-model", params: "7B", license: "Apache-2.0", downloads: 12345 },
};

export async function fixtureCompetingExecutor(call: ToolCall): Promise<ToolResult> {
  if (call.tool === "answer_directly") {
    return { tool: call.tool, status: 200, schema_valid: true, evidence_ids: [], body: { ack: true } };
  }
  if (call.tool === "web_search") {
    const q = String((call.arguments as { query?: unknown }).query ?? "").toLowerCase();
    const key = q.includes("license") ? "license" : q.includes("dataset") ? "dataset" : "default";
    return {
      tool: call.tool,
      status: 200,
      schema_valid: true,
      evidence_ids: [],
      body: [{ title: "result", snippet: WEB_SNIPPETS[key], url: "https://example.test/page" }],
    };
  }
  if (call.tool === "model_catalog_generic") {
    return { tool: call.tool, status: 200, schema_valid: true, evidence_ids: [], body: CATALOG_FIXTURE.default };
  }
  return { tool: call.tool, status: 400, schema_valid: false, evidence_ids: [], body: { error: "unknown tool" } };
}
