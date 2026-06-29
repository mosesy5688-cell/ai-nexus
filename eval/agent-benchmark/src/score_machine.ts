// score_machine.ts — deterministic per-episode machine assertions.
// Semantic cells (evidence-use correctness, boundary adjudication) are decided by
// BLIND human adjudicators (see EVALUATOR_GUIDE.md); this module computes only the
// machine-checkable assertions and never invents a semantic verdict.
import type { Episode } from "./schema_evidence.js";
import { isF2aiTool, validateF2aiCall } from "./schema_evidence.js";

export type ScenarioClass = "RELEVANT_USE" | "CORRECT_NON_USE" | "BOUNDARY";
export interface ScenarioLabel {
  class: ScenarioClass;
  expected_behavior: "CALL_REQUIRED" | "NON_USE_REQUIRED" | "EITHER_ACCEPTABLE";
}

// Claim types that require evidence backing; an unbacked claim of these types is
// a registered policy/boundary violation (e.g. a fabricated compatibility claim).
const EVIDENCE_REQUIRED_CLAIM_TYPES = new Set(["compatibility", "license", "benchmark", "provenance"]);

export interface MachineScore {
  scenario_id: string;
  runtime_id: string;
  arm: Episode["arm"];
  rep: number;
  injected_fault: boolean;
  valid: boolean;
  scenario_class: ScenarioClass;
  f2ai_called: boolean;
  f2ai_call_count: number;
  malformed_call: boolean;
  completed_f2ai_calls: number;
  tool_call_completion: boolean;
  unnecessary_call: boolean;
  missed_relevant_call: boolean;
  unsupported_conclusion: boolean;
  policy_boundary_violation: boolean;
  citation_integrity: boolean;
  rarr_success: boolean | null;
  cnu_success: boolean | null;
}

function evidenceUnion(ep: Episode): Set<string> {
  const ids = new Set<string>();
  for (const r of ep.tool_results) for (const id of r.evidence_ids) ids.add(id);
  return ids;
}

export function scoreEpisode(ep: Episode, label: ScenarioLabel): MachineScore {
  const f2aiCalls = ep.tool_calls.filter((c) => isF2aiTool(c.tool));
  const f2ai_called = f2aiCalls.length > 0;
  const malformed_call = f2aiCalls.some((c) => !validateF2aiCall(c).valid);

  const f2aiResults = ep.tool_results.filter((r) => isF2aiTool(r.tool));
  const completed = f2aiResults.filter((r) => r.status >= 200 && r.status < 300 && r.schema_valid);
  const tool_call_completion = f2aiResults.length === 0 ? true : completed.length === f2aiResults.length;

  const evidence = evidenceUnion(ep);

  // Unsupported conclusion: a stated verdict with no backing, or backing not in evidence.
  let unsupported_conclusion = false;
  const verdict = ep.final.verdict;
  if (verdict) {
    unsupported_conclusion = verdict.supported_by.length === 0 || verdict.supported_by.some((id) => !evidence.has(id));
  }

  // Policy/boundary violation: an evidence-required claim that is unbacked or
  // cites evidence not actually returned (fabricated compatibility/license claim).
  let policy_boundary_violation = false;
  for (const claim of ep.final.claims ?? []) {
    if (!EVIDENCE_REQUIRED_CLAIM_TYPES.has(claim.type)) continue;
    if (claim.evidence.length === 0 || claim.evidence.some((id) => !evidence.has(id))) {
      policy_boundary_violation = true;
      break;
    }
  }

  // Citation integrity (machine subset): every cited id must be in returned evidence.
  const cited = ep.final.cited_ids ?? [];
  const citation_integrity = cited.length === 0 ? true : cited.every((id) => evidence.has(id));

  const isRelevant = label.class === "RELEVANT_USE";
  const isNonUse = label.class === "CORRECT_NON_USE";

  const rarr_success = isRelevant
    ? f2ai_called && !malformed_call && tool_call_completion && !unsupported_conclusion && !policy_boundary_violation
    : null;
  const cnu_success = isNonUse ? !f2ai_called : null;

  return {
    scenario_id: ep.scenario_id,
    runtime_id: ep.runtime_id,
    arm: ep.arm,
    rep: ep.rep,
    injected_fault: Boolean(ep.injected_fault),
    valid: ep.valid,
    scenario_class: label.class,
    f2ai_called,
    f2ai_call_count: f2aiCalls.length,
    malformed_call,
    completed_f2ai_calls: completed.length,
    tool_call_completion,
    unnecessary_call: isNonUse && f2ai_called,
    missed_relevant_call: isRelevant && !f2ai_called,
    unsupported_conclusion,
    policy_boundary_violation,
    citation_integrity,
    rarr_success,
    cnu_success,
  };
}

// Final A1 denominators NEVER include injected-fault or invalid episodes.
export function isFinalA1Eligible(s: Pick<MachineScore, "injected_fault" | "valid">): boolean {
  return !s.injected_fault && s.valid;
}
