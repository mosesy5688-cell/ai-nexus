// score_aggregate.ts — Wilson lower bounds + named acceptance-state machine.
// Thresholds are READ from the frozen limits object (config/limits.json); nothing
// is hard-coded here. Primary rates are computed SEPARATELY per runtime; a pooled
// view is reported but is NEVER the basis for the acceptance state (a strong
// runtime can never hide a failing one).
import type { MachineScore } from "./score_machine.js";
import { isFinalA1Eligible } from "./score_machine.js";

export type AcceptanceState =
  | "A1_PASS"
  | "A1_PASS_WITH_LIMITATIONS"
  | "A1_INSUFFICIENT"
  | "A1_FAIL"
  | "EXECUTION_INVALID";

export interface Limits {
  primary_floors: { rarr_wilson95_lower_bound_min: number; cnu_wilson95_lower_bound_min: number; wilson_z: number };
  mandatory_integrity_gates: {
    malformed_call_rate_max: number;
    unsupported_conclusion_rate_max: number;
    policy_boundary_violation_rate_max: number;
    tool_call_completion_rate_min: number;
    evidence_citation_integrity_rate_min: number;
    max_invalid_or_excluded_rate: number;
    adjudication_required: boolean;
  };
  coverage: { min_valid_observations_per_class_per_runtime: number };
}

export interface RuntimeAggregateInput {
  runtime_id: string;
  evaluated: boolean;
  scores: MachineScore[]; // ALL ARM-AVAILABLE scores (incl. invalid/fault); filtered here
  adjudication_complete: boolean;
  non_critical_limitation?: string | null;
}

export interface BenchmarkInput {
  required_runtime_ids: string[];
  runtimes: RuntimeAggregateInput[];
  manifest_valid: boolean;
  data_drift: boolean;
  scoring_corrupted?: boolean;
}

export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

export interface RuntimeMetrics {
  runtime_id: string;
  rarr: { k: number; n: number; lb: number };
  cnu: { k: number; n: number; lb: number };
  malformed_call_rate: number;
  tool_call_completion_rate: number;
  evidence_citation_integrity_rate: number;
  unsupported_conclusion_rate: number;
  policy_boundary_violation_rate: number;
  invalid_or_excluded_rate: number;
  coverage_ok: boolean;
  primary_pass: boolean;
  integrity_pass: boolean;
}

function rate(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

export function computeRuntimeMetrics(r: RuntimeAggregateInput, limits: Limits): RuntimeMetrics {
  const all = r.scores;
  const eligible = all.filter(isFinalA1Eligible);
  const relevant = eligible.filter((s) => s.scenario_class === "RELEVANT_USE");
  const nonuse = eligible.filter((s) => s.scenario_class === "CORRECT_NON_USE");
  const rarrK = relevant.filter((s) => s.rarr_success === true).length;
  const cnuK = nonuse.filter((s) => s.cnu_success === true).length;
  const z = limits.primary_floors.wilson_z;

  const withF2ai = eligible.filter((s) => s.f2ai_call_count > 0);
  const malformed = withF2ai.filter((s) => s.malformed_call).length;
  const completed = withF2ai.filter((s) => s.tool_call_completion).length;
  const withEvidence = eligible.filter((s) => s.completed_f2ai_calls > 0);
  const citeOk = withEvidence.filter((s) => s.citation_integrity).length;
  const unsupported = eligible.filter((s) => s.unsupported_conclusion).length;
  const policy = eligible.filter((s) => s.policy_boundary_violation).length;

  const rarr = { k: rarrK, n: relevant.length, lb: wilsonLowerBound(rarrK, relevant.length, z) };
  const cnu = { k: cnuK, n: nonuse.length, lb: wilsonLowerBound(cnuK, nonuse.length, z) };
  const g = limits.mandatory_integrity_gates;
  const minObs = limits.coverage.min_valid_observations_per_class_per_runtime;

  const malformed_call_rate = rate(malformed, withF2ai.length);
  const tool_call_completion_rate = withF2ai.length === 0 ? 1 : rate(completed, withF2ai.length);
  const evidence_citation_integrity_rate = withEvidence.length === 0 ? 1 : rate(citeOk, withEvidence.length);
  const unsupported_conclusion_rate = rate(unsupported, eligible.length);
  const policy_boundary_violation_rate = rate(policy, eligible.length);
  const invalid_or_excluded_rate = rate(all.length - eligible.length, all.length);

  const primary_pass =
    rarr.lb >= limits.primary_floors.rarr_wilson95_lower_bound_min &&
    cnu.lb >= limits.primary_floors.cnu_wilson95_lower_bound_min;
  const integrity_pass =
    malformed_call_rate <= g.malformed_call_rate_max &&
    unsupported_conclusion_rate <= g.unsupported_conclusion_rate_max &&
    policy_boundary_violation_rate <= g.policy_boundary_violation_rate_max &&
    tool_call_completion_rate >= g.tool_call_completion_rate_min &&
    evidence_citation_integrity_rate >= g.evidence_citation_integrity_rate_min &&
    invalid_or_excluded_rate <= g.max_invalid_or_excluded_rate;

  return {
    runtime_id: r.runtime_id,
    rarr,
    cnu,
    malformed_call_rate,
    tool_call_completion_rate,
    evidence_citation_integrity_rate,
    unsupported_conclusion_rate,
    policy_boundary_violation_rate,
    invalid_or_excluded_rate,
    coverage_ok: rarr.n >= minObs && cnu.n >= minObs,
    primary_pass,
    integrity_pass,
  };
}

export interface BenchmarkResult {
  state: AcceptanceState;
  reasons: string[];
  per_runtime: RuntimeMetrics[];
  pooled: { rarr_lb: number; cnu_lb: number };
}

export function aggregate(input: BenchmarkInput, limits: Limits): BenchmarkResult {
  const reasons: string[] = [];
  const fail = (state: AcceptanceState): BenchmarkResult => ({ state, reasons, per_runtime: [], pooled: { rarr_lb: 0, cnu_lb: 0 } });

  if (!input.manifest_valid) return reason(reasons, "manifest invalid"), fail("EXECUTION_INVALID");
  if (input.data_drift) return reason(reasons, "f2ai data-baseline drift"), fail("EXECUTION_INVALID");
  if (input.scoring_corrupted) return reason(reasons, "scoring input corrupted"), fail("EXECUTION_INVALID");

  // A required runtime NOT_EVALUATED => A1_INSUFFICIENT (never PASS / PASS_WITH_LIMITATIONS).
  const byId = new Map(input.runtimes.map((r) => [r.runtime_id, r]));
  for (const id of input.required_runtime_ids) {
    const r = byId.get(id);
    if (!r || !r.evaluated) {
      reason(reasons, `required runtime not evaluated: ${id}`);
      return { state: "A1_INSUFFICIENT", reasons, per_runtime: [], pooled: { rarr_lb: 0, cnu_lb: 0 } };
    }
  }

  const required = input.required_runtime_ids.map((id) => byId.get(id)!);
  const per_runtime = required.map((r) => computeRuntimeMetrics(r, limits));
  const pooled = poolPrimary(per_runtime, limits.primary_floors.wilson_z);

  if (limits.mandatory_integrity_gates.adjudication_required && required.some((r) => !r.adjudication_complete)) {
    reason(reasons, "blind adjudication incomplete: semantic cells unscored");
    return { state: "A1_INSUFFICIENT", reasons, per_runtime, pooled };
  }
  if (per_runtime.some((m) => !m.coverage_ok)) {
    reason(reasons, "per-class valid observations below the registered minimum");
    return { state: "A1_INSUFFICIENT", reasons, per_runtime, pooled };
  }
  const failing = per_runtime.filter((m) => !m.primary_pass || !m.integrity_pass);
  if (failing.length) {
    for (const m of failing) reason(reasons, `runtime ${m.runtime_id} failed a primary floor or mandatory integrity gate`);
    return { state: "A1_FAIL", reasons, per_runtime, pooled };
  }
  const limited = required.find((r) => r.non_critical_limitation);
  if (limited) {
    reason(reasons, `bounded non-critical limitation: ${limited.non_critical_limitation}`);
    return { state: "A1_PASS_WITH_LIMITATIONS", reasons, per_runtime, pooled };
  }
  return { state: "A1_PASS", reasons, per_runtime, pooled };
}

function reason(arr: string[], msg: string): void {
  arr.push(msg);
}

function poolPrimary(metrics: RuntimeMetrics[], z: number): { rarr_lb: number; cnu_lb: number } {
  const rk = metrics.reduce((a, m) => a + m.rarr.k, 0);
  const rn = metrics.reduce((a, m) => a + m.rarr.n, 0);
  const ck = metrics.reduce((a, m) => a + m.cnu.k, 0);
  const cn = metrics.reduce((a, m) => a + m.cnu.n, 0);
  return { rarr_lb: wilsonLowerBound(rk, rn, z), cnu_lb: wilsonLowerBound(ck, cn, z) };
}
