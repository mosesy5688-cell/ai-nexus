// scoring.test.ts — L requirements (13) primary rates per runtime,
// (14) pooled cannot override a failing runtime, (15) PASS_WITH_LIMITATIONS
// cannot waive a runtime, (16) thresholds read from frozen limits object,
// (18) fault episodes excluded from final denominators, (19) schema-invalid
// calls detected, (20) unsupported conclusions + boundary handling detectable.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "../src/runner.js";
import { scoreEpisode, type MachineScore, type ScenarioClass } from "../src/score_machine.js";
import { aggregate, computeRuntimeMetrics, type Limits, type RuntimeAggregateInput } from "../src/score_aggregate.js";
import type { Episode } from "../src/schema_evidence.js";
import { validateF2aiCall } from "../src/schema_evidence.js";

const LIMITS = JSON.parse(readFileSync(join(PKG_ROOT, "config", "limits.json"), "utf8")) as Limits;

function mkScore(rt: string, cls: ScenarioClass, success: boolean, o: Partial<MachineScore> = {}): MachineScore {
  const isRel = cls === "RELEVANT_USE";
  const isNon = cls === "CORRECT_NON_USE";
  const f2ai = o.f2ai_called ?? isRel;
  return {
    scenario_id: "s",
    runtime_id: rt,
    arm: "AVAILABLE",
    rep: 0,
    injected_fault: o.injected_fault ?? false,
    valid: o.valid ?? true,
    scenario_class: cls,
    f2ai_called: f2ai,
    f2ai_call_count: f2ai ? 1 : 0,
    malformed_call: o.malformed_call ?? false,
    completed_f2ai_calls: f2ai ? 1 : 0,
    tool_call_completion: true,
    unnecessary_call: isNon && f2ai,
    missed_relevant_call: isRel && !f2ai,
    unsupported_conclusion: o.unsupported_conclusion ?? false,
    policy_boundary_violation: o.policy_boundary_violation ?? false,
    citation_integrity: true,
    rarr_success: isRel ? success : null,
    cnu_success: isNon ? success : null,
  };
}

function runtime(id: string, rarrK: number, cnuK: number, n = 20, faults = 0): RuntimeAggregateInput {
  const scores: MachineScore[] = [];
  for (let i = 0; i < n; i++) scores.push(mkScore(id, "RELEVANT_USE", i < rarrK));
  for (let i = 0; i < n; i++) scores.push(mkScore(id, "CORRECT_NON_USE", i < cnuK));
  for (let i = 0; i < faults; i++) scores.push(mkScore(id, "RELEVANT_USE", false, { injected_fault: true }));
  return { runtime_id: id, evaluated: true, scores, adjudication_complete: true };
}

function mkEpisode(o: Partial<Episode>): Episode {
  return {
    scenario_id: "s",
    runtime_id: "CELL-1",
    arm: "AVAILABLE",
    rep: 0,
    seed: 1,
    session_id: "sid",
    injected_fault: null,
    tool_calls: [],
    tool_results: [],
    final: { text: "ok" },
    valid: true,
    ...o,
  };
}

describe("per-runtime separation + pooled cannot override (L13/L14)", () => {
  it("L13: primary rates are computed independently per runtime", () => {
    const r = aggregate(
      { required_runtime_ids: ["A", "B"], runtimes: [runtime("A", 20, 20), runtime("B", 14, 20)], manifest_valid: true, data_drift: false },
      LIMITS,
    );
    expect(r.per_runtime).toHaveLength(2);
    expect(r.per_runtime[0]!.rarr.lb).not.toBe(r.per_runtime[1]!.rarr.lb);
    expect(r.per_runtime[0]!.primary_pass).toBe(true);
    expect(r.per_runtime[1]!.primary_pass).toBe(false);
  });

  it("L14: a strong pool cannot rescue one failing runtime", () => {
    const r = aggregate(
      {
        required_runtime_ids: ["A", "B", "C"],
        runtimes: [runtime("A", 20, 20), runtime("B", 20, 20), runtime("C", 12, 20)],
        manifest_valid: true,
        data_drift: false,
      },
      LIMITS,
    );
    expect(r.pooled.rarr_lb).toBeGreaterThanOrEqual(LIMITS.primary_floors.rarr_wilson95_lower_bound_min);
    expect(r.state).toBe("A1_FAIL");
  });
});

describe("acceptance-state semantics (L15)", () => {
  const three = () => [runtime("A", 20, 20), runtime("B", 20, 20), runtime("C", 20, 20)];

  it("all required pass cleanly => A1_PASS", () => {
    const r = aggregate({ required_runtime_ids: ["A", "B", "C"], runtimes: three(), manifest_valid: true, data_drift: false }, LIMITS);
    expect(r.state).toBe("A1_PASS");
  });

  it("a bounded non-critical limitation on a passing run => A1_PASS_WITH_LIMITATIONS", () => {
    const rts = three();
    rts[0]!.non_critical_limitation = "one secondary latency metric marginal";
    const r = aggregate({ required_runtime_ids: ["A", "B", "C"], runtimes: rts, manifest_valid: true, data_drift: false }, LIMITS);
    expect(r.state).toBe("A1_PASS_WITH_LIMITATIONS");
  });

  it("L15: a NOT_EVALUATED required runtime can NEVER be waived to PASS_WITH_LIMITATIONS", () => {
    const rts = [runtime("A", 20, 20), runtime("B", 20, 20)];
    rts[0]!.non_critical_limitation = "trying to excuse a missing runtime";
    const r = aggregate({ required_runtime_ids: ["A", "B", "C"], runtimes: rts, manifest_valid: true, data_drift: false }, LIMITS);
    expect(r.state).toBe("A1_INSUFFICIENT");
    expect(r.state).not.toBe("A1_PASS_WITH_LIMITATIONS");
  });
});

describe("thresholds read from frozen limits object (L16)", () => {
  it("flipping the floor in the limits object flips the verdict (no hard-coded threshold)", () => {
    const input = { required_runtime_ids: ["A", "B", "C"], runtimes: [runtime("A", 20, 20), runtime("B", 20, 20), runtime("C", 20, 20)], manifest_valid: true, data_drift: false };
    expect(aggregate(input, LIMITS).state).toBe("A1_PASS");
    const strict: Limits = { ...LIMITS, primary_floors: { ...LIMITS.primary_floors, rarr_wilson95_lower_bound_min: 0.999 } };
    expect(aggregate(input, strict).state).toBe("A1_FAIL");
  });
});

describe("fault episodes excluded from final denominators (L18)", () => {
  it("injected-fault episodes never enter RARR n/k", () => {
    const m = computeRuntimeMetrics(runtime("A", 20, 20, 20, 5), LIMITS);
    expect(m.rarr.n).toBe(20); // 5 injected-fault episodes excluded
    expect(m.rarr.k).toBe(20);
    expect(m.invalid_or_excluded_rate).toBeCloseTo(5 / 45, 3);
  });
});

describe("machine assertions (L19/L20)", () => {
  it("L19: a schema-invalid F2AI call is detected as malformed", () => {
    expect(validateF2aiCall({ tool: "free2aitools_search", arguments: {} }).valid).toBe(false);
    const ep = mkEpisode({ tool_calls: [{ tool: "free2aitools_search", arguments: {} }] });
    const s = scoreEpisode(ep, { class: "RELEVANT_USE", expected_behavior: "CALL_REQUIRED" });
    expect(s.malformed_call).toBe(true);
  });

  it("L20: unsupported conclusions and policy/boundary violations are detectable", () => {
    const unsupported = mkEpisode({ final: { text: "verdict", verdict: { claim: "X beats Y", supported_by: [] } } });
    expect(scoreEpisode(unsupported, { class: "RELEVANT_USE", expected_behavior: "CALL_REQUIRED" }).unsupported_conclusion).toBe(true);

    const fabricated = mkEpisode({ final: { text: "compatible", claims: [{ type: "compatibility", statement: "A works with B", evidence: [] }] } });
    expect(scoreEpisode(fabricated, { class: "RELEVANT_USE", expected_behavior: "CALL_REQUIRED" }).policy_boundary_violation).toBe(true);

    const boundary = mkEpisode({});
    const bs = scoreEpisode(boundary, { class: "BOUNDARY", expected_behavior: "EITHER_ACCEPTABLE" });
    expect(bs.rarr_success).toBeNull();
    expect(bs.cnu_success).toBeNull();
  });
});
