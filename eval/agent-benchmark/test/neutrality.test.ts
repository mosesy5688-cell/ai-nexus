// neutrality.test.ts — L requirements (7) fresh-session isolation,
// (8) deterministic seeded ordering, (9) strict arm separation, (10) no F2AI in
// ARM-CONTROL, (11) F2AI optional/not-forced in ARM-AVAILABLE, (12) competing
// tools present+usable, (17) qualification/evaluation corpora cannot cross-load,
// plus scenario / tool-description neutrality. Fixtures only; no live call.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildToolset,
  buildEpisodeContext,
  seededOrder,
  assertFreshSessions,
  makeSessionId,
  loadCorpus,
  assertNoCrossLoad,
  loadJson,
  PKG_ROOT,
} from "../src/runner.js";
import { isF2aiTool } from "../src/schema_evidence.js";
import { runOllamaDirectEpisode } from "../src/host_ollama_direct.js";
import { fixtureCompetingExecutor } from "../src/tools_competing.js";
import { ExecutionInvalid } from "../src/manifest.js";

const exec = fixtureCompetingExecutor;

describe("arm separation + competing toolset (L9/L10/L11/L12)", () => {
  it("L10: ARM-CONTROL has no F2AI tool", () => {
    const control = buildToolset("CONTROL");
    expect(control.some((t) => isF2aiTool(t.name))).toBe(false);
    expect(control.length).toBe(3);
  });

  it("L11+L12: ARM-AVAILABLE keeps all competing tools and adds F2AI (optional, not forced)", () => {
    const avail = buildToolset("AVAILABLE");
    for (const name of ["answer_directly", "web_search", "model_catalog_generic"]) {
      expect(avail.some((t) => t.name === name)).toBe(true);
    }
    expect(avail.some((t) => isF2aiTool(t.name))).toBe(true);
    // F2AI is never the ONLY able tool: >=3 non-F2AI alternatives remain present.
    expect(avail.filter((t) => !isF2aiTool(t.name)).length).toBeGreaterThanOrEqual(3);
  });

  it("L12: competing tools genuinely return usable data (not crippled)", async () => {
    const ws = await exec({ tool: "web_search", arguments: { query: "license" } });
    expect(ws.status).toBe(200);
    expect(Array.isArray(ws.body)).toBe(true);
    const cat = await exec({ tool: "model_catalog_generic", arguments: { keyword: "llm" } });
    expect(cat.status).toBe(200);
    expect(cat.body).toBeTruthy();
  });

  it("L9: a scenario yields distinct toolsets per arm and a fixed arm per episode", () => {
    const ctlTools = buildToolset("CONTROL").map((t) => t.name);
    const avTools = buildToolset("AVAILABLE").map((t) => t.name);
    expect(avTools.length).toBeGreaterThan(ctlTools.length);
    const ep = buildEpisodeContext(
      { scenarioId: "EV-R-01", runtimeId: "CELL-1", arm: "CONTROL", rep: 0, seed: 1, prompt: "x" },
      exec,
    );
    expect(ep.arm).toBe("CONTROL");
    expect(ep.tools.some((t) => isF2aiTool(t.name))).toBe(false);
  });
});

describe("fresh-session isolation (L7)", () => {
  it("session ids are unique per episode and statelessness holds across episodes", async () => {
    const ids: string[] = [];
    for (const arm of ["CONTROL", "AVAILABLE"] as const) {
      for (let rep = 0; rep < 2; rep++) {
        ids.push(makeSessionId("EV-R-01", "CELL-1", arm, rep));
      }
    }
    expect(() => assertFreshSessions(ids)).not.toThrow();
    expect(() => assertFreshSessions([...ids, ids[0]!])).toThrow(ExecutionInvalid);

    const infer = async () => ({ action: "final", final: { text: "hi" } }) as const;
    const c1 = buildEpisodeContext({ scenarioId: "S1", runtimeId: "CELL-1", arm: "AVAILABLE", rep: 0, seed: 1, prompt: "a" }, exec);
    const ep1 = await runOllamaDirectEpisode(c1, infer);
    const c2 = buildEpisodeContext({ scenarioId: "S1", runtimeId: "CELL-1", arm: "AVAILABLE", rep: 1, seed: 2, prompt: "a" }, exec);
    const ep2 = await runOllamaDirectEpisode(c2, infer);
    expect(ep1.session_id).not.toBe(ep2.session_id);
    // No tool output / memory carries over: a fresh episode starts empty.
    expect(ep2.tool_calls.length).toBe(0);
    expect(ep2.tool_results.length).toBe(0);
  });
});

describe("deterministic seeded ordering (L8)", () => {
  it("same seed => identical order; different seed may differ; always a permutation", () => {
    const items = Array.from({ length: 36 }, (_, i) => i);
    const a = seededOrder(12345, items);
    const b = seededOrder(12345, items);
    expect(a).toEqual(b);
    const c = seededOrder(99999, items);
    expect(c).not.toEqual(a); // overwhelmingly likely for n=36
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });
});

describe("scenario + tool-description neutrality", () => {
  const evalItems = loadCorpus("evaluation");
  const tools = loadJson<{ competing_tools: { description: string }[]; f2ai_tools: { description: string }[] }>(
    join(PKG_ROOT, "config", "tools.json"),
  );
  const labels = loadJson<{ labels: Record<string, Record<string, unknown>> }>(
    join(PKG_ROOT, "corpus", "labels.manifest.json"),
  );

  it("no prompt names Free2AITools or leaks its class/expected tool", () => {
    const banned = /free2ai|f2ai|free2aitools|call_required|non_use_required|relevant_use|boundary|expected/i;
    for (const it of evalItems) expect(banned.test(it.prompt), `prompt ${it.id}`).toBe(false);
    expect(evalItems.length).toBe(36);
  });

  it("tool descriptions reveal no expected choice or answer", () => {
    const leak = /benchmark|expected|you must call|correct answer|always use this|preferred tool/i;
    for (const t of [...tools.competing_tools, ...tools.f2ai_tools]) expect(leak.test(t.description)).toBe(false);
  });

  it("task_success and f2ai_selection are separate, non-circular variables", () => {
    for (const [id, l] of Object.entries(labels.labels)) {
      expect(Object.prototype.hasOwnProperty.call(l, "task_success_rubric"), id).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(l, "f2ai_selection_expected"), id).toBe(true);
      // For RELEVANT-USE, a competing tool may still earn task-success credit.
      if (l.class === "RELEVANT_USE") expect(l.competing_tool_can_succeed).toBe(true);
    }
  });
});

describe("qualification vs evaluation cross-load (L17)", () => {
  it("real corpora are disjoint and load cleanly", () => {
    const ev = loadCorpus("evaluation");
    const ql = loadCorpus("qualification");
    expect(() => assertNoCrossLoad(ev, ql)).not.toThrow();
  });

  it("a qualification item leaked into the evaluation file fails closed", () => {
    const root = join(tmpdir(), `a1-xload-${Date.now()}`);
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "evaluation.jsonl"), JSON.stringify({ id: "QUAL-F-01", prompt: "x", is_qualification: true }) + "\n");
    expect(() => loadCorpus("evaluation", root)).toThrow(ExecutionInvalid);
    rmSync(root, { recursive: true, force: true });
  });
});
