// schema_evidence.ts — evidence/episode schemas + F2AI call validation.
// No live calls; pure validation used by hosts, scorer and tests.
import { z } from "zod";

export const ARMS = ["CONTROL", "AVAILABLE"] as const;
export type Arm = (typeof ARMS)[number];

export const F2AI_TOOL_NAMES = [
  "free2aitools_search",
  "free2aitools_rank",
  "free2aitools_explain",
  "free2aitools_select_model",
  "free2aitools_compare",
] as const;
export type F2aiToolName = (typeof F2AI_TOOL_NAMES)[number];

export const COMPETING_TOOL_NAMES = [
  "answer_directly",
  "web_search",
  "model_catalog_generic",
] as const;

const f2aiSet = new Set<string>(F2AI_TOOL_NAMES);
export function isF2aiTool(name: string): boolean {
  return f2aiSet.has(name);
}

// Per-tool argument schemas used for malformed_call detection (machine assertion).
export const F2AI_ARG_SCHEMAS: Record<F2aiToolName, z.ZodTypeAny> = {
  free2aitools_search: z.object({ query: z.string().min(1), limit: z.number().int().positive().optional() }).strict(),
  free2aitools_rank: z.object({ task: z.string().min(1), limit: z.number().int().positive().optional() }).strict(),
  free2aitools_explain: z.object({ canonical_id: z.string().min(1) }).strict(),
  free2aitools_select_model: z.object({ requirements: z.string().min(1) }).strict(),
  free2aitools_compare: z.object({ canonical_ids: z.array(z.string().min(1)).min(2) }).strict(),
};

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  status: number; // HTTP-style status; 0 = transport failure
  schema_valid: boolean; // did the RESPONSE body parse against the expected shape
  evidence_ids: string[]; // canonical ids / source_trail ids present in the response
  body?: unknown;
}

// What an episode finally asserts (subset machine-checkable; rest adjudicated).
export interface FinalAssertion {
  text: string;
  cited_ids?: string[]; // evidence ids the answer claims to rely on
  verdict?: { claim: string; supported_by: string[] };
  claims?: Array<{ type: string; statement: string; evidence: string[] }>;
}

export interface Episode {
  scenario_id: string;
  runtime_id: string;
  arm: Arm;
  rep: number;
  seed: number;
  session_id: string; // MUST be unique per episode (fresh session)
  injected_fault?: string | null; // set only for qualification fault episodes
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  final: FinalAssertion;
  valid: boolean;
  invalid_reason?: string;
}

export const EpisodeSchema = z.object({
  scenario_id: z.string().min(1),
  runtime_id: z.string().min(1),
  arm: z.enum(ARMS),
  rep: z.number().int().nonnegative(),
  seed: z.number().int(),
  session_id: z.string().min(1),
  injected_fault: z.string().nullable().optional(),
  tool_calls: z.array(z.object({ tool: z.string(), arguments: z.record(z.unknown()) })),
  tool_results: z.array(
    z.object({
      tool: z.string(),
      status: z.number(),
      schema_valid: z.boolean(),
      evidence_ids: z.array(z.string()),
      body: z.unknown().optional(),
    }),
  ),
  final: z.object({
    text: z.string(),
    cited_ids: z.array(z.string()).optional(),
    verdict: z.object({ claim: z.string(), supported_by: z.array(z.string()) }).optional(),
    claims: z
      .array(z.object({ type: z.string(), statement: z.string(), evidence: z.array(z.string()) }))
      .optional(),
  }),
  valid: z.boolean(),
  invalid_reason: z.string().optional(),
});

export interface CallValidation {
  valid: boolean;
  errors: string[];
}

// Shared host contract. Each host_*.ts is a materially-distinct agent loop but
// consumes the same fresh-session context. `execute` runs a tool call (fixture
// in tests, live otherwise). `sessionId` is unique per episode (no shared state).
export interface HostContext {
  scenario_id: string;
  runtime_id: string;
  arm: Arm;
  rep: number;
  seed: number;
  session_id: string;
  prompt: string;
  tools: { name: string; description: string }[];
  injected_fault?: string | null;
  execute: (call: ToolCall) => Promise<ToolResult>;
}

// Loop-shaped model decisions (mocked in tests; a local model serves them live).
export type StructuredStep = { action: "call"; call: ToolCall } | { action: "final"; final: FinalAssertion };
export type StructuredModelFn = (messages: unknown[]) => Promise<StructuredStep>;
export type ReactModelFn = (transcript: string) => Promise<string>;

// Detects schema-invalid F2AI arguments (drives malformed_call_rate).
export function validateF2aiCall(call: ToolCall): CallValidation {
  if (!isF2aiTool(call.tool)) {
    return { valid: false, errors: [`not an f2ai tool: ${call.tool}`] };
  }
  const schema = F2AI_ARG_SCHEMAS[call.tool as F2aiToolName];
  const parsed = schema.safeParse(call.arguments);
  if (parsed.success) return { valid: true, errors: [] };
  return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
