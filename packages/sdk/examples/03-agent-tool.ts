/**
 * Example 7: an Agent tool wrapper.
 *
 * The wrapper exposes the SDK as an agent-callable "tool" that RETURNS evidence
 * and candidates. It deliberately does NOT pick a winner or assert "best" — the
 * agent (the caller) reasons over the returned evidence and makes the final
 * decision. Errors are surfaced honestly, never masked as empty results.
 */
import { Free2AIClient, Free2AIError } from "../src/index.js";

const client = new Free2AIClient();

/** A minimal tool definition shape (provider-agnostic). */
export const discoverModelsTool = {
  name: "free2aitools_discover_models",
  description:
    "Retrieve candidate AI models with FNI evidence for a task. Returns evidence " +
    "and rankings for the caller to reason over; it does NOT choose the best model " +
    "or guarantee compatibility.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "What the model needs to do." },
      max_vram_gb: { type: "number" },
      limit: { type: "number", minimum: 1, maximum: 20 },
    },
    required: ["task"],
  },
} as const;

export interface DiscoverInput {
  task: string;
  max_vram_gb?: number;
  limit?: number;
}

/** Execute the tool. Returns a structured, caller-final-decision payload. */
export async function runDiscoverModels(input: DiscoverInput): Promise<unknown> {
  try {
    const res = await client.select({
      task: input.task,
      constraints: input.max_vram_gb ? { max_vram_gb: input.max_vram_gb } : undefined,
      limit: input.limit ?? 5,
      explain: true,
    });
    return {
      status: "ok",
      task_interpreted: res.task_interpreted,
      // Evidence for the agent to weigh. Caveats preserved verbatim.
      candidates: res.entries.map((e) => ({
        rank: e.rank,
        id: e.model_id,
        name: e.name,
        fni_score: e.fni_score,
        caveats: e.caveats ?? [],
      })),
      note: "Evidence only. The agent makes the final decision; not a recommendation.",
    };
  } catch (err) {
    // Honest failure: surface the typed error, never an empty success.
    if (err instanceof Free2AIError) {
      return { status: "error", http_status: err.status, message: err.message };
    }
    throw err;
  }
}
