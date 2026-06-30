// frozen_launch_identity.test.ts — G2R-2 prefreeze execution-integrity (D-200 §E-§L,§O) coverage.
// fixtures/mocks ONLY; NO live Agent / model / network / spawn. SYNTHETIC, portable, test-only frozen
// paths + clearly-fake hashes (NEVER a real machine path/hash — those live ONLY in the sealed manifest).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDirectExe, resolveDirectLaunch, assertProductionCommandSpec, assertPackageTreeContract, packageTreeHash,
  verifyFrozenLaunch, buildClosedWorldEnv, ClientBinaryDrift, NEVER_EXCLUDE, EXPLICIT_EXCLUDE, DRIFT_TIMINGS,
  CODEX_DIRECT_PUBLIC_F2AI_CONTROL, CODEX_NETWORK_CONTROL,
  reconcileAcceptanceAuthority, ACCEPTANCE_AUTHORITY, ACCEPTANCE_AUTHORITY_ROLE, AcceptanceAuthorityPointerDrift,
  type FrozenLaunchIdentity, type DriftProbe, type CredentialBoundary,
} from "../src/frozen_launch_identity.js";
import { NodeProcessController, assertModelResolved } from "../src/subject_runner.js";

const PKG = join(__dirname, "..");
const NODE = "C:\\frozen\\node\\node.exe", CODEX_JS = "C:\\frozen\\codex\\bin\\codex.js", CLAUDE = "C:\\frozen\\claude\\claude.exe";
const NODE_SHA = "1".repeat(64), CODEX_SHA = "2".repeat(64), CLAUDE_SHA = "3".repeat(64), CVO_SHA = "4".repeat(64);
const TREE = [
  { relative_path: "bin/codex.js", byte_length: 10, sha256: "a".repeat(64), artifact_class: "js_bundle" as const },
  { relative_path: "package.json", byte_length: 5, sha256: "b".repeat(64), artifact_class: "package_json" as const },
];
const TREE_SHA = packageTreeHash(TREE);
const codexId: FrozenLaunchIdentity = { cell_id: "CELL-A-CODEX-CLI", platform: "win32", product: "codex", package_name: "@openai/codex", package_version: "0.139.0", executable_path: NODE, executable_sha256: NODE_SHA, prefix_args: [CODEX_JS], entrypoint_path: CODEX_JS, entrypoint_sha256: CODEX_SHA, package_root: "C:\\frozen\\codex", package_tree_manifest: TREE, package_tree_manifest_sha256: TREE_SHA, resolved_at_utc: "2026-06-30T00:00:00Z", client_version_output: "codex-cli 0.139.0", client_version_output_sha256: CVO_SHA, shell: false };
const claudeId: FrozenLaunchIdentity = { ...codexId, cell_id: "CELL-B-CLAUDE-CODE-OPUS", product: "claude", package_name: "@anthropic-ai/claude-code", package_version: "2.1.196", executable_path: CLAUDE, executable_sha256: CLAUDE_SHA, prefix_args: [], entrypoint_path: undefined, entrypoint_sha256: undefined, client_version_output: "2.1.196 (Claude Code)" };
const goodProbe: DriftProbe = { exeHash: NODE_SHA, entrypointHash: CODEX_SHA, packageTreeHash: TREE_SHA, packageVersion: "0.139.0", clientVersionOutput: "codex-cli 0.139.0" };
const AGENTS_RAW = readFileSync(join(PKG, "config/agents.json"), "utf8"), MATRIX_RAW = readFileSync(join(PKG, "config/matrix.json"), "utf8");
const MATRIX = JSON.parse(MATRIX_RAW), AGENTS = JSON.parse(AGENTS_RAW);

describe("§H direct-launch identity + arg-array + shell:false", () => {
  it("#1-#5 reject PATH command name / relative path / .ps1 / .cmd / .bat", () => {
    for (const bad of ["codex", "claude", "node"]) expect(() => assertDirectExe(bad)).toThrow(); // #1 PATH-name (no abs path)
    for (const bad of ["./codex", "bin/codex.js", "..\\codex.js"]) expect(() => assertDirectExe(bad)).toThrow(); // #2 relative
    expect(() => assertDirectExe("C:\\nvm4w\\nodejs\\codex.ps1")).toThrow(); // #3 .ps1 shim
    expect(() => assertDirectExe("C:\\x\\codex.cmd")).toThrow(); // #4
    expect(() => assertDirectExe("C:\\x\\codex.bat")).toThrow(); // #5
    expect(() => assertDirectExe(NODE)).not.toThrow();
  });
  it("#6/#7/#10/#11 direct tuples accepted; args arrays; codex prefix (codex.js) preserved", () => {
    const cx = resolveDirectLaunch(codexId); expect(cx.exe).toBe(NODE); expect(cx.prefixArgs).toEqual([CODEX_JS]); // #6/#11
    const cl = resolveDirectLaunch(claudeId); expect(cl.exe).toBe(CLAUDE); expect(cl.prefixArgs).toEqual([]); // #7 native claude, no node prefix
    expect(Array.isArray(cx.prefixArgs)).toBe(true); // #10
    expect(() => resolveDirectLaunch({ ...codexId, prefix_args: ["C:\\other.js"] })).toThrow(); // entrypoint must be first prefix arg
  });
  it("#8 assertProductionCommandSpec enforces abs exe + shell:false + string arg-array", () => {
    expect(() => assertProductionCommandSpec({ exe: "codex", args: [], env: {}, stdin: "", shell: false })).toThrow(); // PATH name
    expect(() => assertProductionCommandSpec({ exe: NODE, args: [CODEX_JS], env: {}, stdin: "", shell: true as unknown as false })).toThrow(); // shell != false
    expect(() => assertProductionCommandSpec({ exe: NODE, args: [CODEX_JS], env: {}, stdin: "", shell: false })).not.toThrow();
  });
});

describe("§G package-tree contract + §I/§J drift control", () => {
  it("§G sorted + separately hashed; native binaries/wasm/schema NEVER silently excluded; closed class", () => {
    expect(() => assertPackageTreeContract(codexId)).not.toThrow();
    for (const c of ["native_binary", "js_bundle", "wasm", "package_json", "schema", "runtime_resource", "dylib", "model_routing_config"]) expect(NEVER_EXCLUDE).toContain(c);
    for (const c of ["temp_log", "updater_state", "mutable_credential"]) expect(EXPLICIT_EXCLUDE).toContain(c); // ONLY these are excludable, by an explicit named rule
    expect(() => assertPackageTreeContract({ ...codexId, package_tree_manifest: [...TREE].reverse() })).toThrow(); // not sorted
    expect(() => assertPackageTreeContract({ ...codexId, package_tree_manifest_sha256: "0".repeat(64) })).toThrow(); // manifest hash mismatch
  });
  it("#13-#16/#20 exe/entrypoint/tree/version mismatch aborts; unchanged frozen tuple passes; all five timings accepted", () => {
    expect(verifyFrozenLaunch(codexId, goodProbe, "preflight").verified_manifest_hash).toBe(TREE_SHA); // #20
    for (const t of DRIFT_TIMINGS) expect(() => verifyFrozenLaunch(codexId, goodProbe, t)).not.toThrow();
    expect(() => verifyFrozenLaunch(codexId, { ...goodProbe, exeHash: "9".repeat(64) }, "before-run")).toThrow(ClientBinaryDrift); // #13
    expect(() => verifyFrozenLaunch(codexId, { ...goodProbe, entrypointHash: "9".repeat(64) }, "before-run")).toThrow(ClientBinaryDrift); // #14
    expect(() => verifyFrozenLaunch(codexId, { ...goodProbe, packageTreeHash: "9".repeat(64) }, "before-run")).toThrow(ClientBinaryDrift); // #15
    expect(() => verifyFrozenLaunch(codexId, { ...goodProbe, packageVersion: "0.140.0" }, "before-run")).toThrow(ClientBinaryDrift); // #16
  });
  it("CLIENT_BINARY_DRIFT = EXECUTION_INVALID + WHOLE_RUN_ABORT, NOT retryable / A1_FAIL / A1_INSUFFICIENT / warning", () => {
    try { verifyFrozenLaunch(codexId, { ...goodProbe, exeHash: "9".repeat(64) }, "before-run"); throw new Error("expected drift"); }
    catch (e) { expect(e).toBeInstanceOf(ClientBinaryDrift); const d = e as ClientBinaryDrift; expect(d.code).toBe("EXECUTION_INVALID"); expect(d.whole_run_abort).toBe(true); expect(d.retryable).toBe(false); }
  });
  it("#17 pre-run drift aborts BEFORE spawn (production NodeProcessController, no child spawned)", () => {
    const spec = { exe: NODE, args: [CODEX_JS, "--version"], env: {}, stdin: "", shell: false as const, verifyBeforeSpawn: () => verifyFrozenLaunch(codexId, { ...goodProbe, exeHash: "9".repeat(64) }, "before-every-process-invocation") };
    expect(() => new NodeProcessController().run(spec, 50)).toThrow(ClientBinaryDrift); // throws before reaching spawn()
  });
  it("#18/#19 drift between/after an episode aborts the WHOLE run; no further episode starts", () => {
    const good = goodProbe, drift = { ...goodProbe, exeHash: "9".repeat(64) };
    let starts = 0;
    const run = (eps: Array<[DriftProbe, DriftProbe]>): void => { for (const [b, a] of eps) { verifyFrozenLaunch(codexId, b, "before-every-process-invocation"); starts++; verifyFrozenLaunch(codexId, a, "after-every-process-exit"); } };
    starts = 0; expect(() => run([[good, good], [drift, good]])).toThrow(ClientBinaryDrift); expect(starts).toBe(1); // #18 next episode pre-spawn drift -> abort after 1 completed
    starts = 0; expect(() => run([[good, drift], [good, good]])).toThrow(ClientBinaryDrift); expect(starts).toBe(1); // #19 post-exit drift on ep1 -> ep2 never starts (ep1 preserved as evidence)
  });
});

describe("§K closed-world env + §L credential boundary + §O Codex control + qualification floor", () => {
  it("#33/#34/#35/#36/#37 no inherited secrets/proxy, minimal PATH, disposable Windows vars, CONTROL==AVAILABLE", () => {
    const saved = { ...process.env };
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "CLOUDFLARE_API_TOKEN", "CF_API_KEY", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET", "SSH_AUTH_SOCK", "GIT_ASKPASS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "ACME_MCP_GATEWAY"]) process.env[k] = "leak";
    process.env.PATH = "C:\\broad\\user\\path;C:\\windows;C:\\Users\\me\\bin";
    const spec = { home: "C:\\d\\h", tempDir: "C:\\d\\t", minimalPath: "C:\\frozen\\node", clientConfigVar: "CODEX_HOME" as const, clientConfigDir: "C:\\d\\ch" };
    const env = buildClosedWorldEnv(spec);
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "CLOUDFLARE_API_TOKEN", "CF_API_KEY", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET", "SSH_AUTH_SOCK", "GIT_ASKPASS", "ACME_MCP_GATEWAY"]) expect(env[k]).toBeUndefined(); // #33
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) expect(env[k]).toBeUndefined(); // #34
    expect(env.PATH).toBe("C:\\frozen\\node"); expect(env.PATH).not.toContain("broad"); // #35 minimal PATH (not the broad user PATH)
    for (const k of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "CODEX_HOME"]) expect(env[k]).toBeDefined(); // #36
    expect(buildClosedWorldEnv({ ...spec, clientConfigVar: "CLAUDE_CONFIG_DIR" }).CLAUDE_CONFIG_DIR).toBeDefined();
    expect(JSON.stringify(buildClosedWorldEnv(spec))).toBe(JSON.stringify(env)); // #37 CONTROL==AVAILABLE byte-equivalent (same spec)
    process.env = saved;
  });
  it("§L credential boundary is NON-secret; §O Codex control = MACHINE_DETECTABLE_INVALIDATE_ON_USE (not BLOCKED=YES)", () => {
    const cb: CredentialBoundary = { capsule_external_to_evidence: true, projected_credential_location: "$CODEX_HOME/auth.json", excluded_from_sealing: true, leakage_invalidates: true };
    expect(cb.excluded_from_sealing).toBe(true); expect(cb.leakage_invalidates).toBe(true);
    expect(CODEX_DIRECT_PUBLIC_F2AI_CONTROL).toBe("MACHINE_DETECTABLE_INVALIDATE_ON_USE");
    expect(CODEX_NETWORK_CONTROL.native_web_assumed_absent).toBe(false); expect(CODEX_NETWORK_CONTROL.native_f2ai_outside_relay_invalidates_episode).toBe(true);
  });
  it("#21/#22/#23 tracked config has NO absolute local exe path / binary hash / credential path", () => {
    for (const raw of [AGENTS_RAW, MATRIX_RAW]) {
      expect(raw).not.toMatch(/\.exe|\.dll|\.node\b|\.ps1|\.cmd|\.bat/i); // #21 no local binary / launcher file
      expect(raw).not.toMatch(/[A-Za-z]:\\/); // #21 no Windows drive path
      expect(raw).not.toMatch(/\b[0-9a-f]{64}\b/); // #22 no 64-hex binary hash
      expect(raw).not.toMatch(/auth\.json|credentials\.json|id_rsa|\bsk-[a-z0-9]/i); // #23 no credential artifact
    }
  });
  it("#38/#39 no model process / network: the synthetic frozen exe is never spawned and the suite issues no fetch", () => {
    const spec = { exe: NODE, args: [CODEX_JS, "--version"], env: {}, stdin: "", shell: false as const, verifyBeforeSpawn: () => verifyFrozenLaunch(codexId, { ...goodProbe, packageVersion: "9.9.9" }, "before-every-process-invocation") };
    expect(() => new NodeProcessController().run(spec, 50)).toThrow(ClientBinaryDrift); // aborts pre-spawn; no child, no model, no network
  });
  it("#40 qualification still cannot emit A1_PASS: frozen primary cells are UNRESOLVED + ready_for_run=false", () => {
    for (const c of MATRIX.real_agent_primary_cells) { expect(c.ready_for_run).toBe(false); expect(c.model_id).toBe("UNRESOLVED_AT_EXECUTION_FREEZE"); }
    for (const c of AGENTS.cells) { expect(c.ready_for_run).toBe(false); expect(() => assertModelResolved(c.model_id, null, c.product === "codex_cli" ? "codex" : "claude")).toThrow(); }
  });
});

// D-200 §M/§N acceptance-authority pointer binding (Commit B): tracked agents.json + matrix.json
// pointers reconciled against the ACTUAL runtime descriptor (reconcileRequiredCells/acceptRequiredCells).
describe("§M/§N acceptance-authority pointer binding", () => {
  const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
  it("#24/#25/#32 agents + matrix pointers name the CURRENT authority and reconcile with the runtime descriptor", () => {
    const p = reconcileAcceptanceAuthority(AGENTS, MATRIX); // real configs + real runtime descriptor (default)
    expect([...p.exported_symbol_name].sort()).toEqual(["acceptRequiredCells", "reconcileRequiredCells"]);
    expect(AGENTS.acceptance_authority_pointer.exported_symbol_name).toContain("reconcileRequiredCells"); // #24
    expect(MATRIX.acceptance_authority_pointer.exported_symbol_name).toContain("acceptRequiredCells"); // #25
    expect(Object.keys(ACCEPTANCE_AUTHORITY.exported).sort()).toEqual(["acceptRequiredCells", "reconcileRequiredCells"]); // #32 derived from the REAL functions
    expect(p.authority_role).toBe(ACCEPTANCE_AUTHORITY_ROLE);
  });
  it("#26 agents/matrix mismatch; #27 stale acceptTwoCell; #28 nonexistent symbol; #29 source-path mismatch all fail closed", () => {
    const m1 = clone(MATRIX); m1.acceptance_authority_pointer.exported_symbol_name = ["reconcileRequiredCells"];
    expect(() => reconcileAcceptanceAuthority(AGENTS, m1)).toThrow(AcceptanceAuthorityPointerDrift); // #26 one config stale
    const a2 = clone(AGENTS), m2 = clone(MATRIX); a2.acceptance_authority_pointer.exported_symbol_name = ["acceptTwoCell"]; m2.acceptance_authority_pointer.exported_symbol_name = ["acceptTwoCell"];
    expect(() => reconcileAcceptanceAuthority(a2, m2)).toThrow(/acceptTwoCell/); // #27 stale legacy authority named
    const a3 = clone(AGENTS), m3 = clone(MATRIX); a3.acceptance_authority_pointer.exported_symbol_name = ["reconcileRequiredCells", "acceptRequiredCells", "noSuchFn"]; m3.acceptance_authority_pointer.exported_symbol_name = ["reconcileRequiredCells", "acceptRequiredCells", "noSuchFn"];
    expect(() => reconcileAcceptanceAuthority(a3, m3)).toThrow(AcceptanceAuthorityPointerDrift); // #28 non-exported symbol
    const a4 = clone(AGENTS), m4 = clone(MATRIX); a4.acceptance_authority_pointer.source_path = "src/wrong.ts"; m4.acceptance_authority_pointer.source_path = "src/wrong.ts";
    expect(() => reconcileAcceptanceAuthority(a4, m4)).toThrow(/source_path/); // #29
  });
  it("#30 frozen main-SHA mismatch; #31 frozen source-file hash mismatch; consistent manifest passes", () => {
    const man = { main_sha: "abc123def456", source_file_sha256: "d".repeat(64) };
    expect(() => reconcileAcceptanceAuthority(AGENTS, MATRIX, ACCEPTANCE_AUTHORITY, man, "a-different-main-sha")).toThrow(/main SHA/); // #30
    expect(() => reconcileAcceptanceAuthority(AGENTS, MATRIX, ACCEPTANCE_AUTHORITY, man, "abc123def456", "e".repeat(64))).toThrow(/source bytes/); // #31
    expect(() => reconcileAcceptanceAuthority(AGENTS, MATRIX, ACCEPTANCE_AUTHORITY, man, "abc123def456", "d".repeat(64))).not.toThrow(); // consistent
  });
  it("§N missing / malformed / duplicate pointer fails closed", () => {
    expect(() => reconcileAcceptanceAuthority({}, MATRIX)).toThrow(AcceptanceAuthorityPointerDrift); // missing pointer
    const a = clone(AGENTS), m = clone(MATRIX); a.acceptance_authority_pointer.exported_symbol_name = ["reconcileRequiredCells", "reconcileRequiredCells"]; m.acceptance_authority_pointer.exported_symbol_name = ["reconcileRequiredCells", "reconcileRequiredCells"];
    expect(() => reconcileAcceptanceAuthority(a, m)).toThrow(/duplicate/); // duplicate pointer symbol
  });
});
