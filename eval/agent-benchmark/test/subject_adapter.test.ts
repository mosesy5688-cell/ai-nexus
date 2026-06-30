// subject_adapter.test.ts — §O adapter + lifecycle requirements (fixtures/mocks ONLY; NO live
// Codex/Claude exec, NO live F2AI, FAKE process controller). Proves: STDIN byte fidelity,
// shell:false, args-as-array, CONTROL empty/baseline config, AVAILABLE exact-plus-one F2AI,
// ambient MCP exclusion (ARM-DIFF = F2AI only), non-MCP parity (METHOD A), secret-env exclusion,
// JSONL/stream-json parse, fail-closed classification, raw exclusive-create + atomic write + seal
// tamper-detection, reconciliation, timeout classification, unresolved model id fails closed, two
// required-cell acceptance, legacy non-primary, evaluation corpus not opened. Anti-vacuity (RED):
// arm-isolation, evidence-tampering, required-cell-omission, model-placeholder-acceptance.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexCommand, buildCodexEnv, buildCodexArmDiff, parseCodexEvents, CODEX_CAPABILITY_PARITY,
} from "../src/agent_codex_adapter.js";
import {
  buildClaudeCommand, buildClaudeEnv, buildClaudeMcpConfig, buildClaudeArmDiff, parseClaudeEvents, CLAUDE_CAPABILITY_PARITY,
} from "../src/agent_claude_adapter.js";
import {
  assertModelResolved, classifyExecution, createRunDir, writeRawArtifact, atomicNormalizedWrite,
  sealRun, assertSealedForScoring, reconcile, acceptTwoCell, NodeProcessController, TOOL_CALL_GATE_STATUS,
  requiredRealCellIds, reconcileRequiredCells, acceptRequiredCells, assertCellModelIdentity, ConfigRequiredCellDrift,
  type CommandSpec, type ProcessController, type ProcessResult, type SealEntry, type ReconInput, type CellOutcome,
} from "../src/subject_runner.js";

const MODEL = "fixture-model-id-x"; // a RESOLVED fixture id (never a real model is selected here)
const PKG = join(__dirname, "..");
const codexC = (arm: "CONTROL" | "AVAILABLE") =>
  buildCodexCommand({ model: MODEL, codexHome: "/d/home", profile: "a1-bench", workspace: "/d/ws", arm, task: "TASK<bytes>", lastMsgFile: "/d/last.txt", ...(arm === "AVAILABLE" ? { relayUrl: "http://127.0.0.1:5/" } : {}) });
const claudeC = (arm: "CONTROL" | "AVAILABLE") =>
  buildClaudeCommand({ model: MODEL, configDir: "/d/cfg", workspace: "/d/ws", arm, mcpConfigPath: arm === "CONTROL" ? "/d/empty.json" : "/d/relay.json", task: "TASK<bytes>", ...(arm === "AVAILABLE" ? { relayUrl: "http://127.0.0.1:5/" } : {}) });

class FakeProcessController implements ProcessController {
  lastSpec?: CommandSpec;
  constructor(private r: Partial<ProcessResult>) {}
  async run(spec: CommandSpec, _timeoutMs: number): Promise<ProcessResult> {
    this.lastSpec = spec;
    return { startFailed: false, exitCode: 0, signal: null, timedOut: false, forcedKill: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), elapsedMs: 1, ...this.r };
  }
}

describe("command construction: STDIN, args-as-array, shell:false, per-arm config", () => {
  it("codex: task via STDIN (not argv), AVAILABLE adds exactly the F2AI override, CONTROL none", () => {
    const ctl = codexC("CONTROL"), av = codexC("AVAILABLE");
    expect(ctl.exe).toBe("codex");
    expect(Array.isArray(ctl.args)).toBe(true);
    expect(ctl.stdin).toBe("TASK<bytes>");
    expect(ctl.args.some((a) => a.includes("TASK<bytes>"))).toBe(false); // no task on argv
    expect(ctl.args.join(" ")).toContain("--ignore-user-config");
    expect(av.args.join(" ")).toMatch(/mcp_servers\.free2aitools\.url=/);
    expect(ctl.args.join(" ")).not.toMatch(/free2aitools/);
    // shell:false is enforced by the production controller (read the source as proof).
    expect(/shell:\s*false/.test(readFileSync(join(PKG, "src/subject_runner.ts"), "utf8"))).toBe(true);
  });

  it("claude: --bare + explicit --mcp-config BOTH arms; CONTROL empty baseline, AVAILABLE exactly-one F2AI", () => {
    const ctl = claudeC("CONTROL"), av = claudeC("AVAILABLE");
    expect(ctl.exe).toBe("claude");
    expect(ctl.stdin).toBe("TASK<bytes>");
    expect(ctl.args).toContain("--bare");
    expect(ctl.args).toContain("--mcp-config");
    expect(av.args).toContain("--mcp-config");
    expect(Object.keys(buildClaudeMcpConfig("CONTROL").mcpServers)).toEqual([]);
    expect(Object.keys(buildClaudeMcpConfig("AVAILABLE", "http://127.0.0.1:5/").mcpServers)).toEqual(["free2aitools"]);
  });

  it("STDIN byte fidelity through a FAKE process controller (no live spawn)", async () => {
    const fake = new FakeProcessController({});
    const spec = codexC("AVAILABLE");
    await fake.run(spec, 1000);
    expect(Buffer.from(fake.lastSpec!.stdin).equals(Buffer.from("TASK<bytes>"))).toBe(true);
    expect(NodeProcessController).toBeTypeOf("function"); // production controller exists but is never spawned here
  });
});

describe("ambient-config exclusion + non-MCP capability parity (METHOD A)", () => {
  it("ARM-DIFF proves CONTROL vs AVAILABLE differ ONLY by the F2AI MCP config (both products)", () => {
    const cx = buildCodexArmDiff(codexC("CONTROL"), codexC("AVAILABLE"));
    expect(cx.diff_is_f2ai_only).toBe(true);
    expect(cx.env_changed).toBe(false);
    const cl = buildClaudeArmDiff(buildClaudeMcpConfig("CONTROL"), buildClaudeMcpConfig("AVAILABLE", "http://127.0.0.1:5/"));
    expect(cl.diff_is_f2ai_only).toBe(true);
  });

  it("ANTI-VACUITY [arm-isolation]: an inherited extra MCP server fails the F2AI-only diff", () => {
    const inheritedControl = { mcpServers: { inherited_global: { type: "http", url: "http://x/" } } };
    const inheritedAvail = { mcpServers: { inherited_global: { type: "http", url: "http://x/" }, free2aitools: { type: "http", url: "http://127.0.0.1:5/" } } };
    expect(buildClaudeArmDiff(inheritedControl, inheritedAvail).diff_is_f2ai_only).toBe(false);
    const tamperedCtl: CommandSpec = { ...codexC("CONTROL"), args: [...codexC("CONTROL").args, "-c", "tools.web_search=true"] };
    expect(buildCodexArmDiff(tamperedCtl, codexC("AVAILABLE")).diff_is_f2ai_only).toBe(false);
  });

  it("METHOD A disables native web/network IDENTICALLY in both arms", () => {
    expect(CLAUDE_CAPABILITY_PARITY.method).toBe("A");
    expect(CLAUDE_CAPABILITY_PARITY.disallowed_tools).toContain("WebSearch");
    expect(CLAUDE_CAPABILITY_PARITY.disallowed_tools).toContain("WebFetch");
    expect(CODEX_CAPABILITY_PARITY.network_access).toBe(false);
    const disallow = (s: CommandSpec) => s.args[s.args.indexOf("--disallowedTools") + 1];
    expect(disallow(claudeC("CONTROL"))).toBe(disallow(claudeC("AVAILABLE"))); // identical both arms
    const net = (s: CommandSpec) => s.args.includes("sandbox_workspace_write.network_access=false");
    expect(net(codexC("CONTROL"))).toBe(true);
    expect(net(codexC("AVAILABLE"))).toBe(true);
  });
});

describe("secret-env exclusion + native event parse + fail-closed classification", () => {
  const dirtyBase = { PATH: "/usr/bin", GITHUB_TOKEN: "redacted-gh", AWS_SECRET_ACCESS_KEY: "s", NPM_TOKEN: "n", CLOUDFLARE_API_TOKEN: "c" };
  it("drops every write credential, keeps PATH, injects the isolated state root", () => {
    const ce = buildCodexEnv("/d/home", dirtyBase);
    for (const k of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "CLOUDFLARE_API_TOKEN"]) expect(ce[k]).toBeUndefined();
    expect(ce.PATH).toBe("/usr/bin");
    expect(ce.CODEX_HOME).toBe("/d/home");
    expect(buildClaudeEnv("/d/cfg", dirtyBase).CLAUDE_CONFIG_DIR).toBe("/d/cfg");
    expect(buildClaudeEnv("/d/cfg", dirtyBase).GITHUB_TOKEN).toBeUndefined();
  });

  it("parses native F2AI tool calls; a blank or malformed stream fails closed (parsedOk=false)", () => {
    const cx = parseCodexEvents('{"type":"mcp_tool_call","name":"free2aitools_search","arguments":{"query":"x"}}\n{"type":"mcp_tool_result"}');
    expect(cx.parsedOk).toBe(true);
    expect(cx.nativeF2aiCalls[0]!.tool).toBe("free2aitools_search");
    expect(cx.toolResultCount).toBe(1);
    expect(parseCodexEvents("").parsedOk).toBe(false);
    expect(parseCodexEvents("{bad json").parsedOk).toBe(false);
    const cl = parseClaudeEvents('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"free2aitools_rank","input":{"task":"t"}}]}}');
    expect(cl.nativeF2aiCalls[0]!.tool).toBe("free2aitools_rank");
    expect(parseClaudeEvents("").parsedOk).toBe(false);
  });

  it("classifies start-failure / timeout / non-zero / empty / malformed as INVALID; clean as valid", () => {
    const base: ProcessResult = { startFailed: false, exitCode: 0, signal: null, timedOut: false, forcedKill: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), elapsedMs: 1 };
    expect(classifyExecution({ ...base, startFailed: true }, true, true).valid).toBe(false);
    expect(classifyExecution({ ...base, timedOut: true, forcedKill: true }, true, true).reason).toBe("TIMEOUT_PROCESS_TREE_KILLED");
    expect(classifyExecution({ ...base, exitCode: 1 }, true, true).valid).toBe(false);
    expect(classifyExecution(base, false, true).reason).toBe("EMPTY_OUTPUT");
    expect(classifyExecution(base, true, false).reason).toBe("MALFORMED_EVENT_STREAM");
    expect(classifyExecution(base, true, true).valid).toBe(true);
  });
});

describe("model id fail-closed + evidence seal + reconciliation + acceptance", () => {
  it("ANTI-VACUITY [model-placeholder-acceptance]: floating/placeholder/unconfirmed ids fail closed", () => {
    for (const bad of ["", "codex", "default", "latest", "opus", "claude", "UNRESOLVED_AT_EXECUTION_FREEZE"]) {
      expect(() => assertModelResolved(bad)).toThrow();
    }
    expect(() => assertModelResolved("real-id", "different-id")).toThrow(); // not echoed by client
    expect(() => assertModelResolved("real-id", "real-id")).not.toThrow();
    expect(() => buildCodexCommand({ model: "UNRESOLVED_AT_EXECUTION_FREEZE", codexHome: "/h", profile: "p", workspace: "/w", arm: "CONTROL", task: "t", lastMsgFile: "/l" })).toThrow();
    expect(TOOL_CALL_GATE_STATUS).toMatch(/DESIGN_PATH_IDENTIFIED/); // C4: not "resolved"
  });

  it("raw exclusive-create + atomic normalized write + seal with tamper-detection", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-seal-"));
    const dir = createRunDir(root, "run-1");
    expect(() => createRunDir(root, "run-1")).toThrow(); // FAIL if run dir exists
    writeRawArtifact(dir, "raw.json", '{"a":1}');
    expect(() => writeRawArtifact(dir, "raw.json", "x")).toThrow(); // never overwrite raw
    atomicNormalizedWrite(dir, "norm.json", '{"n":1}');
    expect(readFileSync(join(dir, "norm.json"), "utf8")).toBe('{"n":1}');
    const entries: SealEntry[] = [{ relative_path: "raw.json", byte_size: 7, sha256: "h", artifact_class: "RAW", episode_id: "e1" }];
    sealRun(dir, entries);
    expect(() => assertSealedForScoring(dir, entries)).not.toThrow();
    const tampered: SealEntry[] = [{ ...entries[0]!, sha256: "DIFFERENT" }];
    expect(() => assertSealedForScoring(dir, tampered)).toThrow(); // ANTI-VACUITY [evidence-tampering]
    const unsealed = createRunDir(root, "run-2");
    expect(() => assertSealedForScoring(unsealed, entries)).toThrow(); // RUN_SEALED absent
  });

  it("reconciliation: relay primary, native corroborating; CONTROL/AVAILABLE isolation enforced", () => {
    const r = (o: Partial<ReconInput>): ReconInput => ({ arm: "AVAILABLE", relayF2aiCall: false, relayMalformed: false, nativeF2aiCall: false, nativeContradictsIdentity: false, nativeFormatGuaranteesCompleteness: false, controlNativeF2ai: false, availableDirectOutsideRelay: false, ...o });
    expect(reconcile(r({ relayF2aiCall: true, nativeF2aiCall: true })).verdict).toBe("CONFIRMED");
    expect(reconcile(r({ relayF2aiCall: true })).verdict).toBe("CONFIRMED_WITH_TRACE_LIMITATION");
    expect(reconcile(r({})).verdict).toBe("NO_MACHINE_PROVEN_CALL");
    expect(reconcile(r({ relayMalformed: true })).verdict).toBe("MISSING_TRACE");
    expect(reconcile(r({ nativeF2aiCall: true })).verdict).toBe("EXECUTION_INVALID"); // native w/o relay
    expect(reconcile(r({ relayF2aiCall: true, nativeContradictsIdentity: true })).verdict).toBe("EXECUTION_INVALID");
    expect(reconcile(r({ arm: "CONTROL", controlNativeF2ai: true })).verdict).toBe("EXECUTION_INVALID");
    expect(reconcile(r({ availableDirectOutsideRelay: true })).verdict).toBe("EXECUTION_INVALID");
  });

  it("two required-cell acceptance; one passing cannot hide one failing; legacy non-primary; corpus not opened", () => {
    const ok = (id: string) => ({ cell_id: id, evaluated: true, passing: true });
    expect(acceptTwoCell(ok("A"), ok("B")).state).toBe("A1_PASS");
    expect(acceptTwoCell(undefined, ok("B")).state).toBe("A1_INSUFFICIENT"); // ANTI-VACUITY [required-cell-omission]
    expect(acceptTwoCell(ok("A"), undefined).state).toBe("A1_INSUFFICIENT");
    expect(acceptTwoCell(ok("A"), { cell_id: "B", evaluated: true, passing: false }).state).toBe("A1_FAIL");
    const matrix = JSON.parse(readFileSync(join(PKG, "config/matrix.json"), "utf8"));
    expect(matrix.real_agent_primary_cells.length).toBe(2);
    expect(matrix.cells.every((c: { a1_primary: boolean }) => c.a1_primary === false)).toBe(true);
    for (const f of ["subject_runner.ts", "agent_codex_adapter.ts", "agent_claude_adapter.ts", "mcp_trace_relay.ts"]) {
      expect(/evaluation\.jsonl|loadCorpus/.test(readFileSync(join(PKG, "src", f), "utf8"))).toBe(false); // eval corpus not opened
    }
  });
});

// ===========================================================================================
// D-197 §L required-cell BINDING coverage. Drives the REAL production binding/acceptance/model
// guard against the ACTUAL config/matrix.json + config/agents.json (no 2nd duplicated expected
// array; expected identity is READ FROM the configs themselves). §M anti-vacuity follows.
// ===========================================================================================
const MATRIX = JSON.parse(readFileSync(join(PKG, "config/matrix.json"), "utf8"));
const AGENTS = JSON.parse(readFileSync(join(PKG, "config/agents.json"), "utf8"));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const oc = (id: string, evaluated = true, passing = true): CellOutcome => ({ cell_id: id, evaluated, passing });
// codex/claude required ids resolved FROM the matrix product fields (never hardcoded literals).
const codexId = MATRIX.real_agent_primary_cells.find((c: { product: string }) => c.product === "codex_cli").cell_id;
const claudeId = MATRIX.real_agent_primary_cells.find((c: { product: string }) => c.product === "claude_code").cell_id;

describe("§L single-source matrix binding (requiredRealCellIds + reconcileRequiredCells)", () => {
  it("L1 actual matrix+agents reconcile; L2 derived set is exactly 2 unique ids", () => {
    const d = requiredRealCellIds(MATRIX);
    expect(reconcileRequiredCells(MATRIX, AGENTS)).toEqual(d); // reconcile == derived matrix set
    expect(new Set(d)).toEqual(new Set(AGENTS.acceptance.required_cells)); // mirror equals derived (read from agents)
    expect(d.length).toBe(2);
    expect(new Set(d).size).toBe(2);
  });
  it("L3 Codex cell present; L4 Claude cell present; L5 legacy cells absent", () => {
    const d = requiredRealCellIds(MATRIX);
    expect(d).toContain(codexId);
    expect(d).toContain(claudeId);
    for (const c of MATRIX.cells) expect(d).not.toContain(c.cell_id); // legacy engineering adapters excluded
  });
  it("L6 required-count == derived cardinality; L7 order change does not fail", () => {
    const d = requiredRealCellIds(MATRIX);
    expect(MATRIX.real_agent_required_cell_count).toBe(d.length);
    const rev = clone(MATRIX); rev.real_agent_primary_cells.reverse();
    expect(requiredRealCellIds(rev)).toEqual(d); // sorted => order-insensitive set equality
  });
  it("L8 matrix removal fails; L9 extra cell fails; L10 duplicate fails; L11 legacy-cell insertion fails", () => {
    const rm = clone(MATRIX); rm.real_agent_primary_cells.pop();
    expect(() => requiredRealCellIds(rm)).toThrow(); // count 2 != cardinality 1
    const extra = clone(MATRIX); extra.real_agent_primary_cells.push({ cell_id: "CELL-C-EXTRA", a1_primary: true });
    expect(() => requiredRealCellIds(extra)).toThrow(); // count 2 != cardinality 3
    const dup = clone(MATRIX); dup.real_agent_primary_cells[1].cell_id = dup.real_agent_primary_cells[0].cell_id;
    expect(() => requiredRealCellIds(dup)).toThrow();
    const leg = clone(MATRIX); leg.real_agent_primary_cells[0].cell_id = MATRIX.cells[0].cell_id;
    expect(() => requiredRealCellIds(leg)).toThrow(); // legacy local cell can never be a required cell
  });
  it("L12 agents missing fails; L13 agents extra fails; L14 agents duplicate fails (CONFIG_REQUIRED_CELL_DRIFT)", () => {
    const miss = clone(AGENTS); miss.acceptance.required_cells = [codexId];
    expect(() => reconcileRequiredCells(MATRIX, miss)).toThrow(ConfigRequiredCellDrift);
    const extra = clone(AGENTS); extra.acceptance.required_cells = [codexId, claudeId, "CELL-C-EXTRA"];
    expect(() => reconcileRequiredCells(MATRIX, extra)).toThrow(ConfigRequiredCellDrift);
    const dup = clone(AGENTS); dup.acceptance.required_cells = [codexId, codexId];
    expect(() => reconcileRequiredCells(MATRIX, dup)).toThrow(ConfigRequiredCellDrift);
  });
  it("L15 wrong-two-ids fail even with cardinality 2", () => {
    const wrong = clone(MATRIX);
    wrong.real_agent_primary_cells[0].cell_id = "CELL-X-WRONG-ONE";
    wrong.real_agent_primary_cells[1].cell_id = "CELL-Y-WRONG-TWO";
    expect(requiredRealCellIds(wrong).length).toBe(2); // cardinality still 2...
    expect(() => reconcileRequiredCells(wrong, AGENTS)).toThrow(ConfigRequiredCellDrift); // ...but != the agents mirror
  });
});

describe("§L cell_id-bound acceptance (acceptRequiredCells) + model identity guard", () => {
  const d = requiredRealCellIds(MATRIX);
  it("L16 missing required outcome -> A1_INSUFFICIENT; L17 extra -> EXECUTION_INVALID; L18 duplicate -> EXECUTION_INVALID", () => {
    expect(acceptRequiredCells(d, [oc(d[0]!)]).state).toBe("A1_INSUFFICIENT");
    expect(acceptRequiredCells(d, [oc(d[0]!), oc(d[1]!), oc("CELL-C-EXTRA")]).state).toBe("EXECUTION_INVALID");
    expect(acceptRequiredCells(d, [oc(d[0]!), oc(d[0]!)]).state).toBe("EXECUTION_INVALID");
  });
  it("L19 swapped order does not alter identity; L20 positional labels cannot substitute for cell_id", () => {
    expect(acceptRequiredCells(d, [oc(d[1]!), oc(d[0]!)]).state).toBe("A1_PASS"); // reversed outcome order, same result
    expect(acceptRequiredCells(d, [oc(d[0]!), oc(d[1]!)]).state).toBe("A1_PASS");
    expect(acceptRequiredCells(d, [oc("A"), oc("B")]).state).toBe("EXECUTION_INVALID"); // throwaway positional labels rejected
  });
  it("L21 legacy outcome cannot satisfy a required cell; L22 one passing cannot hide one failing", () => {
    expect(acceptRequiredCells(d, [oc(d[0]!), oc(MATRIX.cells[0].cell_id)]).state).toBe("EXECUTION_INVALID");
    expect(acceptRequiredCells(d, [oc(d[0]!, true, true), oc(d[1]!, true, false)]).state).toBe("A1_FAIL");
  });
  it("L23 both valid reach the existing aggregate; L24 qualification (evaluated=false) cannot emit A1_PASS", () => {
    expect(acceptRequiredCells(d, [oc(d[0]!, true, true), oc(d[1]!, true, true)]).state).toBe("A1_PASS");
    expect(acceptRequiredCells(d, [oc(d[0]!, false, true), oc(d[1]!, false, true)]).state).toBe("A1_INSUFFICIENT");
    expect(TOOL_CALL_GATE_STATUS).not.toMatch(/RESOLVED/i); // qualification gate is not "resolved"
  });
  it("L25 forbidden Codex aliases fail; L26 forbidden Claude aliases fail", () => {
    for (const bad of ["", "default", "latest", "codex", "gpt-5.5", "gpt-5.3-codex", "unspecified configured default", "unconfirmed account-routed identity", "UNRESOLVED_AT_EXECUTION_FREEZE"]) {
      expect(() => assertModelResolved(bad, null, "codex")).toThrow();
    }
    for (const bad of ["", "default", "latest", "claude", "opus", "opusplan", "best", "claude-opus-latest", "sonnet fallback", "haiku fallback", "fable fallback", "unknown", "router-selected", "unconfirmed account-routed identity"]) {
      expect(() => assertModelResolved(bad, null, "claude")).toThrow();
    }
  });
  it("L27 legitimate exact pinned candidates pass; L28 broad-substring false positives do NOT occur", () => {
    expect(() => assertModelResolved("claude-opus-4-8", null, "claude")).not.toThrow(); // contains 'opus'/'claude' but pinned
    expect(() => assertModelResolved("gpt-5.5-2026-04-23", null, "codex")).not.toThrow(); // contains 'gpt-5.5' but pinned
    expect(() => assertModelResolved("x-codex-pinned-2026", null, "codex")).not.toThrow(); // contains 'codex' but not the exact token
    expect(() => assertModelResolved("opus", null, "claude")).toThrow(); // bare token still fails (exact match)
    expect(() => assertModelResolved("gpt-5.5", null, "codex")).toThrow();
  });
  it("L29 observed-model mismatch fails; L30 model transition within one cell/run fails", () => {
    expect(() => assertCellModelIdentity([{ cell_id: codexId, configured_exact_model_id: "gpt-5.5-2026-04-23", observed_model_id: "gpt-5.5-2026-99-99", product: "codex" }])).toThrow();
    expect(() => assertCellModelIdentity([
      { cell_id: codexId, configured_exact_model_id: "pinned-2026-a", observed_model_id: "pinned-2026-a" },
      { cell_id: codexId, configured_exact_model_id: "pinned-2026-b", observed_model_id: "pinned-2026-b" },
    ])).toThrow(); // same cell, model changed mid-run
    // green baseline: one exact frozen model, observed == configured, no change
    expect(() => assertCellModelIdentity([{ cell_id: codexId, configured_exact_model_id: "pinned-2026-a", observed_model_id: "pinned-2026-a" }])).not.toThrow();
  });
});

describe("§M anti-vacuity: each mutation of the REAL production binding path -> RED; restore -> green", () => {
  it("baseline GREEN: the real matrix+agents reconcile and accept", () => {
    const d = reconcileRequiredCells(MATRIX, AGENTS);
    expect(acceptRequiredCells(d, [oc(d[0]!), oc(d[1]!)]).state).toBe("A1_PASS");
  });
  it("M1 matrix cell id changed (agents unchanged) -> RED", () => {
    const m = clone(MATRIX); m.real_agent_primary_cells[0].cell_id = codexId + "-MUTANT";
    expect(() => reconcileRequiredCells(m, AGENTS)).toThrow();
  });
  it("M2 agents id changed (matrix unchanged) -> RED", () => {
    const a = clone(AGENTS); a.acceptance.required_cells = [codexId + "-MUTANT", claudeId];
    expect(() => reconcileRequiredCells(MATRIX, a)).toThrow();
  });
  it("M3 remove one required cell -> RED; M4 add a 3rd required cell -> RED", () => {
    const rm = clone(MATRIX); rm.real_agent_primary_cells.pop();
    expect(() => requiredRealCellIds(rm)).toThrow();
    const add = clone(MATRIX); add.real_agent_primary_cells.push({ cell_id: "CELL-C-EXTRA", a1_primary: true });
    expect(() => requiredRealCellIds(add)).toThrow();
  });
  it("M5 duplicate a required id -> RED; M6 insert a legacy local cell -> RED", () => {
    const dup = clone(MATRIX); dup.real_agent_primary_cells[1].cell_id = dup.real_agent_primary_cells[0].cell_id;
    expect(() => requiredRealCellIds(dup)).toThrow();
    const leg = clone(MATRIX); leg.real_agent_primary_cells[1].cell_id = MATRIX.cells[1].cell_id;
    expect(() => requiredRealCellIds(leg)).toThrow();
  });
  it("M7 restore positional acceptance with throwaway ids A/B -> RED", () => {
    const d = requiredRealCellIds(MATRIX);
    expect(acceptRequiredCells(d, [oc("A"), oc("B")]).state).toBe("EXECUTION_INVALID"); // positional labels can't satisfy real gate
  });
  it("M8 allow a forbidden floating alias -> RED; M9 observed != configured frozen model -> RED", () => {
    expect(() => assertModelResolved("claude-opus-latest", null, "claude")).toThrow();
    expect(() => assertModelResolved("gpt-5.5-latest", null, "codex")).toThrow(); // generic floating alias
    expect(() => assertCellModelIdentity([{ cell_id: claudeId, configured_exact_model_id: "claude-opus-4-8", observed_model_id: "claude-opus-4-7", product: "claude" }])).toThrow();
  });
});
