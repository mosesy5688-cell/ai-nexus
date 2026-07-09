// subject_adapter.test.ts — adapter/lifecycle (fixtures/mocks ONLY; NO live exec/F2AI/model/network; FAKE controller) + D-197 §L/§M required-cell binding/anti-vacuity + D-200 §H direct-launch (frozen abs exe, NEVER PATH-name)/shell:false/STDIN/§K closed-world env. Tables drive §L/§M.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
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
  type CommandSpec, type ProcessController, type ProcessResult, type SealEntry, type ReconInput, type CellOutcome, type A1Acceptance,
} from "../src/subject_runner.js";
import { buildClosedWorldEnv, type FrozenLaunchIdentity } from "../src/frozen_launch_identity.js";

const MODEL = "fixture-model-id-x"; // a RESOLVED fixture id (never a real model is selected here)
const PKG = join(__dirname, "..");
const NODE_EXE = "C:\\frozen\\node\\node.exe", CODEX_JS = "C:\\frozen\\codex\\bin\\codex.js", CLAUDE_EXE = "C:\\frozen\\claude\\claude.exe", HX = "f".repeat(64); // SYNTHETIC test-only fixtures (NOT real machine paths/hashes)
const mkId = (exe: string, prefix: string[], entry?: string): FrozenLaunchIdentity => ({ cell_id: "C", platform: "win32", product: prefix.length ? "codex" : "claude", package_name: "p", package_version: "1.0.0", executable_path: exe, executable_sha256: HX, prefix_args: prefix, entrypoint_path: entry, entrypoint_sha256: entry ? HX : undefined, package_root: "C:\\frozen", package_tree_manifest: [{ relative_path: "a", byte_length: 1, sha256: HX, artifact_class: "js_bundle" }], package_tree_manifest_sha256: HX, resolved_at_utc: "2026-06-30T00:00:00Z", client_version_output: "v", client_version_output_sha256: HX, shell: false });
const CODEX_ID = mkId(NODE_EXE, [CODEX_JS], CODEX_JS), CLAUDE_ID = mkId(CLAUDE_EXE, []), ENV = buildClosedWorldEnv({ home: "C:\\d\\home", tempDir: "C:\\d\\tmp", minimalPath: "C:\\frozen\\node", clientConfigVar: "CODEX_HOME", clientConfigDir: "C:\\d\\ch" });
const codexC = (arm: "CONTROL" | "AVAILABLE") =>
  buildCodexCommand({ model: MODEL, identity: CODEX_ID, env: ENV, profile: "a1-bench", workspace: "/d/ws", arm, task: "TASK<bytes>", lastMsgFile: "/d/last.txt", ...(arm === "AVAILABLE" ? { relayUrl: "http://127.0.0.1:5/" } : {}) });
const claudeC = (arm: "CONTROL" | "AVAILABLE") =>
  buildClaudeCommand({ model: MODEL, identity: CLAUDE_ID, env: ENV, workspace: "/d/ws", arm, mcpConfigPath: arm === "CONTROL" ? "/d/empty.json" : "/d/relay.json", task: "TASK<bytes>", ...(arm === "AVAILABLE" ? { relayUrl: "http://127.0.0.1:5/" } : {}) });
class FakeProcessController implements ProcessController {
  lastSpec?: CommandSpec;
  constructor(private r: Partial<ProcessResult>) {}
  async run(spec: CommandSpec, _timeoutMs: number): Promise<ProcessResult> {
    this.lastSpec = spec;
    return { startFailed: false, exitCode: 0, signal: null, timedOut: false, forcedKill: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), elapsedMs: 1, ...this.r };
  }
}
// D-197 §L/§M shared fixtures: the ACTUAL configs + identity READ FROM them (never hardcoded literals).
const MATRIX = JSON.parse(readFileSync(join(PKG, "config/matrix.json"), "utf8"));
const AGENTS = JSON.parse(readFileSync(join(PKG, "config/agents.json"), "utf8"));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const oc = (id: string, evaluated = true, passing = true): CellOutcome => ({ cell_id: id, evaluated, passing });
const codexId = MATRIX.real_agent_primary_cells.find((c: { product: string }) => c.product === "codex_cli").cell_id;
const claudeId = MATRIX.real_agent_primary_cells.find((c: { product: string }) => c.product === "claude_code").cell_id;

describe("command construction: STDIN, args-as-array, shell:false, per-arm config", () => {
  it("codex: task via STDIN (not argv), AVAILABLE adds exactly the F2AI override, CONTROL none", () => {
    const ctl = codexC("CONTROL"), av = codexC("AVAILABLE");
    expect(ctl.exe).toBe(NODE_EXE); expect(ctl.args[0]).toBe(CODEX_JS); expect(ctl.args.slice(1, 3)).toEqual(["exec", "-"]); expect(ctl.shell).toBe(false); // #6/#8/#11 frozen node+codex.js tuple, shell:false, benchmark args preserved after the prefix
    expect(Array.isArray(ctl.args)).toBe(true);
    expect(ctl.stdin).toBe("TASK<bytes>");
    expect(ctl.args.some((a) => a.includes("TASK<bytes>"))).toBe(false); // no task on argv
    expect(ctl.args.join(" ")).toContain("--ignore-user-config");
    expect(av.args.join(" ")).toMatch(/mcp_servers\.free2aitools\.url=/);
    expect(ctl.args.join(" ")).not.toMatch(/free2aitools/);
    expect(/shell:\s*false/.test(readFileSync(join(PKG, "src/subject_runner.ts"), "utf8"))).toBe(true);
  });
  it("claude: --bare + explicit --mcp-config BOTH arms; CONTROL empty baseline, AVAILABLE exactly-one F2AI", () => {
    const ctl = claudeC("CONTROL"), av = claudeC("AVAILABLE");
    expect(ctl.exe).toBe(CLAUDE_EXE); expect(ctl.args[0]).toBe("-p"); expect(ctl.shell).toBe(false); // #7/#8 frozen native claude exe (no node prefix), shell:false; existing claude benchmark args preserved (--bare/--mcp-config below)
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
    expect(Buffer.from(fake.lastSpec!.stdin).equals(Buffer.from("TASK<bytes>"))).toBe(true); expect(fake.lastSpec!.exe).toBe(NODE_EXE); // #12 the EXACT frozen abs exe reaches the controller
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

describe("model id fail-closed + evidence seal + reconciliation + MATRIX-bound acceptance", () => {
  it("ANTI-VACUITY [model-placeholder-acceptance]: floating/placeholder/unconfirmed ids fail closed", () => {
    for (const bad of ["", "codex", "default", "latest", "opus", "claude", "UNRESOLVED_AT_EXECUTION_FREEZE"]) {
      expect(() => assertModelResolved(bad)).toThrow();
    }
    expect(() => assertModelResolved("real-id", "different-id")).toThrow(); // not echoed by client
    expect(() => assertModelResolved("real-id", "real-id")).not.toThrow();
    expect(() => buildCodexCommand({ model: "UNRESOLVED_AT_EXECUTION_FREEZE", identity: CODEX_ID, env: ENV, profile: "p", workspace: "/w", arm: "CONTROL", task: "t", lastMsgFile: "/l" })).toThrow();
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
  it("acceptTwoCell is MATRIX-BOUND; positional throwaway ids cannot pass; one passing cannot hide one failing; legacy non-primary; corpus not opened", () => {
    expect(acceptTwoCell(MATRIX, AGENTS, oc(codexId), oc(claudeId)).state).toBe("A1_PASS"); // matrix-derived ids pass
    expect(acceptTwoCell(MATRIX, AGENTS, oc("A"), oc("B")).state).toBe("EXECUTION_INVALID"); // ANTI-VACUITY [positional-loophole]
    expect(acceptTwoCell(MATRIX, AGENTS, undefined, oc(claudeId)).state).toBe("A1_INSUFFICIENT"); // required Codex cell missing
    expect(acceptTwoCell(MATRIX, AGENTS, oc(codexId), undefined).state).toBe("A1_INSUFFICIENT");
    expect(acceptTwoCell(MATRIX, AGENTS, oc(codexId), oc(claudeId, true, false)).state).toBe("A1_FAIL"); // one passing cannot hide one failing
    expect(MATRIX.real_agent_primary_cells.length).toBe(2);
    expect(MATRIX.cells.every((c: { a1_primary: boolean }) => c.a1_primary === false)).toBe(true);
    for (const f of ["subject_runner.ts", "agent_codex_adapter.ts", "agent_claude_adapter.ts", "mcp_trace_relay.ts"])
      expect(/evaluation\.jsonl|loadCorpus/.test(readFileSync(join(PKG, "src", f), "utf8"))).toBe(false); // eval corpus not opened
  });
});

// D-197 §L required-cell BINDING + §M anti-vacuity (table-driven; REAL production binding/acceptance/
// model guard vs the ACTUAL configs; identity read FROM the configs; mutate real config -> RED/throw).
describe("§L/§M required-cell matrix binding", () => {
  const d = requiredRealCellIds(MATRIX);
  it("§L1-7 derive: reconcile==derived mirror, 2 unique ids, codex+claude present, legacy absent, count==card, order-insensitive; gate not resolved", () => {
    expect(reconcileRequiredCells(MATRIX, AGENTS)).toEqual(d); // reconcile == derived matrix set
    expect(new Set(d)).toEqual(new Set(AGENTS.acceptance.required_cells)); // mirror equals derived (read from agents)
    expect(d.length).toBe(2); expect(new Set(d).size).toBe(2);
    expect(d).toContain(codexId); expect(d).toContain(claudeId);
    for (const c of MATRIX.cells) expect(d).not.toContain(c.cell_id); // legacy engineering adapters excluded
    expect(MATRIX.real_agent_required_cell_count).toBe(d.length);
    const rev = clone(MATRIX); rev.real_agent_primary_cells.reverse();
    expect(requiredRealCellIds(rev)).toEqual(d); // sorted => order-insensitive set equality
    expect(TOOL_CALL_GATE_STATUS).not.toMatch(/RESOLVED/i); // qualification gate is not "resolved"
  });
  it("§L15 wrong-two-ids: cardinality 2 but != the agents mirror still drifts", () => {
    const w = clone(MATRIX); w.real_agent_primary_cells[0].cell_id = "CELL-X1"; w.real_agent_primary_cells[1].cell_id = "CELL-X2";
    expect(requiredRealCellIds(w).length).toBe(2); // cardinality still 2...
    expect(() => reconcileRequiredCells(w, AGENTS)).toThrow(ConfigRequiredCellDrift); // ...but != mirror
  });
  const DRIFT_FAIL: Array<[string, () => unknown, unknown]> = [
    ["§L8/§M3 matrix removal", () => { const m = clone(MATRIX); m.real_agent_primary_cells.pop(); return requiredRealCellIds(m); }, Error],
    ["§L9/§M4 matrix extra 3rd cell", () => { const m = clone(MATRIX); m.real_agent_primary_cells.push({ cell_id: "CELL-C-EXTRA", a1_primary: true }); return requiredRealCellIds(m); }, Error],
    ["§L10/§M5 matrix duplicate id", () => { const m = clone(MATRIX); m.real_agent_primary_cells[1].cell_id = m.real_agent_primary_cells[0].cell_id; return requiredRealCellIds(m); }, Error],
    ["§L11/§M6 legacy cell inserted at idx0", () => { const m = clone(MATRIX); m.real_agent_primary_cells[0].cell_id = MATRIX.cells[0].cell_id; return requiredRealCellIds(m); }, Error],
    ["§M6b legacy cell inserted at idx1", () => { const m = clone(MATRIX); m.real_agent_primary_cells[1].cell_id = MATRIX.cells[1].cell_id; return requiredRealCellIds(m); }, Error],
    ["§L12 agents missing cell", () => { const a = clone(AGENTS); a.acceptance.required_cells = [codexId]; return reconcileRequiredCells(MATRIX, a); }, ConfigRequiredCellDrift],
    ["§L13 agents extra cell", () => { const a = clone(AGENTS); a.acceptance.required_cells = [codexId, claudeId, "CELL-C-EXTRA"]; return reconcileRequiredCells(MATRIX, a); }, ConfigRequiredCellDrift],
    ["§L14 agents duplicate cell", () => { const a = clone(AGENTS); a.acceptance.required_cells = [codexId, codexId]; return reconcileRequiredCells(MATRIX, a); }, ConfigRequiredCellDrift],
    ["§M1 matrix id changed, agents unchanged", () => { const m = clone(MATRIX); m.real_agent_primary_cells[0].cell_id = codexId + "-MUT"; return reconcileRequiredCells(m, AGENTS); }, ConfigRequiredCellDrift],
    ["§M2 agents id changed, matrix unchanged", () => { const a = clone(AGENTS); a.acceptance.required_cells = [codexId + "-MUT", claudeId]; return reconcileRequiredCells(MATRIX, a); }, ConfigRequiredCellDrift],
  ];
  it.each(DRIFT_FAIL)("drift fails closed: %s", (_n, fn, err) => { expect(fn).toThrow(err as never); });
  const ACC: Array<[string, string[], CellOutcome[], A1Acceptance]> = [
    ["§L16 missing required -> INSUFFICIENT", d, [oc(d[0]!)], "A1_INSUFFICIENT"],
    ["§L17 extra unknown -> INVALID", d, [oc(d[0]!), oc(d[1]!), oc("CELL-C-EXTRA")], "EXECUTION_INVALID"],
    ["§L18 duplicate -> INVALID", d, [oc(d[0]!), oc(d[0]!)], "EXECUTION_INVALID"],
    ["§L19 swapped order -> PASS (identity by cell_id)", d, [oc(d[1]!), oc(d[0]!)], "A1_PASS"],
    ["§L20/§M7 positional A/B -> INVALID", d, [oc("A"), oc("B")], "EXECUTION_INVALID"],
    ["§L21 legacy outcome -> INVALID", d, [oc(d[0]!), oc(MATRIX.cells[0].cell_id)], "EXECUTION_INVALID"],
    ["§L22 one failing not hidden -> FAIL", d, [oc(d[0]!), oc(d[1]!, true, false)], "A1_FAIL"],
    ["§L23 both valid -> PASS (aggregate)", d, [oc(d[0]!), oc(d[1]!)], "A1_PASS"],
    ["§L24 qualification evaluated=false -> INSUFFICIENT", d, [oc(d[0]!, false), oc(d[1]!, false)], "A1_INSUFFICIENT"],
  ];
  it.each(ACC)("acceptRequiredCells (cell_id identity) %s", (_n, req, outs, exp) => { expect(acceptRequiredCells(req, outs).state).toBe(exp); });
  const MODEL_FAIL_CODEX = ["", "default", "latest", "codex", "gpt-5.5", "gpt-5.3-codex", "unspecified configured default", "unconfirmed account-routed identity", "UNRESOLVED_AT_EXECUTION_FREEZE"];
  const MODEL_FAIL_CLAUDE = ["", "default", "latest", "claude", "opus", "opusplan", "best", "claude-opus-latest", "sonnet fallback", "haiku fallback", "fable fallback", "unknown", "router-selected", "unconfirmed account-routed identity"];
  const MODEL_PASS: Array<[string, "codex" | "claude"]> = [["claude-opus-4-8", "claude"], ["gpt-5.5-2026-04-23", "codex"], ["x-codex-pinned-2026", "codex"]];
  it.each(MODEL_FAIL_CODEX)("§L25 forbidden codex alias '%s' fails (exact-token)", (id) => { expect(() => assertModelResolved(id, null, "codex")).toThrow(); });
  it.each(MODEL_FAIL_CLAUDE)("§L26 forbidden claude alias '%s' fails (exact-token)", (id) => { expect(() => assertModelResolved(id, null, "claude")).toThrow(); });
  it.each(MODEL_PASS)("§L27/§L28 pinned id '%s' passes (no broad-substring false positive)", (id, p) => { expect(() => assertModelResolved(id, null, p)).not.toThrow(); });
  it("§L29 observed!=configured fails; §L30 mid-run model transition fails; green when frozen", () => {
    const o = (conf: string, seen: string, p?: "codex" | "claude") => [{ cell_id: codexId, configured_exact_model_id: conf, observed_model_id: seen, product: p }];
    expect(() => assertCellModelIdentity(o("gpt-5.5-2026-04-23", "gpt-5.5-2026-99-99", "codex"))).toThrow(); // L29 observed mismatch
    expect(() => assertCellModelIdentity([...o("pinned-a", "pinned-a"), { cell_id: codexId, configured_exact_model_id: "pinned-b", observed_model_id: "pinned-b" }])).toThrow(); // L30 transition
    expect(() => assertCellModelIdentity(o("pinned-a", "pinned-a"))).not.toThrow(); // green: one frozen model observed exactly
  });
  it("§M baseline GREEN; §M8 floating alias rejected; §M9 observed!=configured frozen model rejected", () => {
    const dd = reconcileRequiredCells(MATRIX, AGENTS);
    expect(acceptRequiredCells(dd, [oc(dd[0]!), oc(dd[1]!)]).state).toBe("A1_PASS"); // real configs reconcile + accept
    expect(() => assertModelResolved("claude-opus-latest", null, "claude")).toThrow(); // M8
    expect(() => assertModelResolved("gpt-5.5-latest", null, "codex")).toThrow(); // M8 generic floating alias
    expect(() => assertCellModelIdentity([{ cell_id: claudeId, configured_exact_model_id: "claude-opus-4-8", observed_model_id: "claude-opus-4-7", product: "claude" }])).toThrow(); // M9
  });
});
