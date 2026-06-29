// antivacuity.test.ts — L requirement (21): the scoring gate must DETECT
// deliberately corrupted results. A forced/illegal F2AI call on a NON-USE
// scenario must score as unnecessary_call; a fabricated-compatibility verdict
// must trip policy_boundary_violation; corrupted scoring input must turn the
// gate RED. A gate that passes corrupted input is VACUOUS = FAIL. Fixtures only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT, buildEpisodeContext } from "../src/runner.js";
import { runOllamaDirectEpisode } from "../src/host_ollama_direct.js";
import { makeFixtureF2aiExecutor } from "../src/tools_f2a.js";
import { scoreEpisode, type MachineScore, type ScenarioClass } from "../src/score_machine.js";
import { aggregate, type Limits, type RuntimeAggregateInput } from "../src/score_aggregate.js";
import type { StructuredStep } from "../src/schema_evidence.js";

const LIMITS = JSON.parse(readFileSync(join(PKG_ROOT, "config", "limits.json"), "utf8")) as Limits;

function mkScore(rt: string, cls: ScenarioClass, success: boolean, o: Partial<MachineScore> = {}): MachineScore {
  const isRel = cls === "RELEVANT_USE";
  const isNon = cls === "CORRECT_NON_USE";
  const f2ai = o.f2ai_called ?? (isNon ? false : isRel);
  return {
    scenario_id: "s",
    runtime_id: rt,
    arm: "AVAILABLE",
    rep: 0,
    injected_fault: false,
    valid: true,
    scenario_class: cls,
    f2ai_called: f2ai,
    f2ai_call_count: f2ai ? 1 : 0,
    malformed_call: false,
    completed_f2ai_calls: f2ai ? 1 : 0,
    tool_call_completion: true,
    unnecessary_call: isNon && f2ai,
    missed_relevant_call: isRel && !f2ai,
    unsupported_conclusion: false,
    policy_boundary_violation: o.policy_boundary_violation ?? false,
    citation_integrity: true,
    rarr_success: isRel ? success : null,
    cnu_success: isNon ? success : null,
  };
}

describe("anti-vacuity: corrupted results are detected (L21)", () => {
  it("a FORCED F2AI call on a NON-USE scenario scores as unnecessary_call (not a pass)", async () => {
    const exec = makeFixtureF2aiExecutor();
    const steps: StructuredStep[] = [
      { action: "call", call: { tool: "free2aitools_search", arguments: { query: "anything" } } },
      { action: "final", final: { text: "the answer is 42" } },
    ];
    let i = 0;
    const infer = async () => steps[i++]!;
    const ctx = buildEpisodeContext(
      { scenarioId: "EV-N-01", runtimeId: "CELL-1", arm: "AVAILABLE", rep: 0, seed: 1, prompt: "What is 18% of 2450?" },
      exec,
    );
    const ep = await runOllamaDirectEpisode(ctx, infer);
    const s = scoreEpisode(ep, { class: "CORRECT_NON_USE", expected_behavior: "NON_USE_REQUIRED" });
    expect(s.f2ai_called).toBe(true);
    expect(s.unnecessary_call).toBe(true);
    expect(s.cnu_success).toBe(false);
  });

  it("a runtime that always makes unnecessary NON-USE calls turns the gate RED", () => {
    const rt: RuntimeAggregateInput = { runtime_id: "A", evaluated: true, adjudication_complete: true, scores: [] };
    for (let n = 0; n < 20; n++) rt.scores.push(mkScore("A", "RELEVANT_USE", true));
    for (let n = 0; n < 20; n++) rt.scores.push(mkScore("A", "CORRECT_NON_USE", false, { f2ai_called: true }));
    const dup = (id: string) => ({ ...rt, runtime_id: id, scores: rt.scores.map((s) => ({ ...s, runtime_id: id })) });
    const r = aggregate({ required_runtime_ids: ["A", "B", "C"], runtimes: [dup("A"), dup("B"), dup("C")], manifest_valid: true, data_drift: false }, LIMITS);
    expect(r.state).toBe("A1_FAIL");
  });

  it("fabricated compatibility verdicts trip policy_boundary_violation and fail the gate", () => {
    const fabricated = scoreEpisode(
      {
        scenario_id: "s", runtime_id: "A", arm: "AVAILABLE", rep: 0, seed: 1, session_id: "x",
        injected_fault: null, tool_calls: [], tool_results: [],
        final: { text: "A is fully compatible with B", claims: [{ type: "compatibility", statement: "A works with B", evidence: [] }] },
        valid: true,
      },
      { class: "RELEVANT_USE", expected_behavior: "CALL_REQUIRED" },
    );
    expect(fabricated.policy_boundary_violation).toBe(true);

    const rt: RuntimeAggregateInput = { runtime_id: "A", evaluated: true, adjudication_complete: true, scores: [] };
    for (let n = 0; n < 20; n++) rt.scores.push(mkScore("A", "RELEVANT_USE", true, n < 3 ? { policy_boundary_violation: true } : {}));
    for (let n = 0; n < 20; n++) rt.scores.push(mkScore("A", "CORRECT_NON_USE", true));
    const dup = (id: string) => ({ ...rt, runtime_id: id, scores: rt.scores.map((s) => ({ ...s, runtime_id: id })) });
    const r = aggregate({ required_runtime_ids: ["A", "B", "C"], runtimes: [dup("A"), dup("B"), dup("C")], manifest_valid: true, data_drift: false }, LIMITS);
    expect(r.per_runtime[0]!.policy_boundary_violation_rate).toBeGreaterThan(LIMITS.mandatory_integrity_gates.policy_boundary_violation_rate_max);
    expect(r.state).toBe("A1_FAIL");
  });

  it("a corrupted-scoring signal forces EXECUTION_INVALID, never a silent pass", () => {
    const clean = (id: string): RuntimeAggregateInput => {
      const scores: MachineScore[] = [];
      for (let n = 0; n < 20; n++) scores.push(mkScore(id, "RELEVANT_USE", true));
      for (let n = 0; n < 20; n++) scores.push(mkScore(id, "CORRECT_NON_USE", true));
      return { runtime_id: id, evaluated: true, adjudication_complete: true, scores };
    };
    const base = { required_runtime_ids: ["A", "B", "C"], runtimes: [clean("A"), clean("B"), clean("C")], manifest_valid: true, data_drift: false };
    expect(aggregate(base, LIMITS).state).toBe("A1_PASS");
    const corrupt = aggregate({ ...base, scoring_corrupted: true }, LIMITS);
    expect(corrupt.state).toBe("EXECUTION_INVALID");
    expect(corrupt.state).not.toBe("A1_PASS");
  });
});
