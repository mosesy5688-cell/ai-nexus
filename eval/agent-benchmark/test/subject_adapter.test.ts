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
  type CommandSpec, type ProcessController, type ProcessResult, type SealEntry, type ReconInput,
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
