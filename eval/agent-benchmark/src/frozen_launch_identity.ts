// frozen_launch_identity.ts — G2R-2 prefreeze execution-integrity core (Founder D-200).
// Generic, machine-portable FROZEN DIRECT-LAUNCH IDENTITY + binary-drift control + closed-world
// env + credential-boundary contract. This module VALIDATES + ENFORCES the generic contract; it
// does NOT generate the real machine freeze (paths/hashes live ONLY in the future sealed manifest,
// NEVER in tracked code/config). No live Agent/model/network; pure functions + injected probes.
import { ExecutionInvalid, sha256 } from "./manifest.js";
import { join } from "node:path";
import type { CellProduct, CommandSpec } from "./subject_runner.js";
import { reconcileRequiredCells, acceptRequiredCells } from "./subject_runner.js";

// §F/§G package-tree artifact classes. NEVER silently excludable vs the ONLY explicitly excludable.
export type ArtifactClass =
  | "native_binary" | "js_bundle" | "wasm" | "package_json" | "schema" | "runtime_resource"
  | "dylib" | "model_routing_config" | "temp_log" | "updater_state" | "mutable_credential" | "other";
export const NEVER_EXCLUDE: ArtifactClass[] = ["native_binary", "js_bundle", "wasm", "package_json", "schema", "runtime_resource", "dylib", "model_routing_config"];
export const EXPLICIT_EXCLUDE: ArtifactClass[] = ["temp_log", "updater_state", "mutable_credential"];
export interface PackageTreeEntry { relative_path: string; byte_length: number; sha256: string; artifact_class: ArtifactClass; }

// §F generic frozen launch identity. executable_path is ABSOLUTE; shell is the literal false.
export interface FrozenLaunchIdentity {
  cell_id: string; platform: string; product: CellProduct; package_name: string; package_version: string;
  executable_path: string; executable_sha256: string; prefix_args: string[];
  entrypoint_path?: string; entrypoint_sha256?: string; package_root: string;
  package_tree_manifest: PackageTreeEntry[]; package_tree_manifest_sha256: string;
  resolved_at_utc: string; client_version_output: string; client_version_output_sha256: string; shell: false;
}

// §H exe validator: REJECT a PATH command name / relative path / .ps1/.cmd/.bat launcher shim.
const LAUNCHER_EXT = /\.(ps1|cmd|bat)$/i;
const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
export function assertDirectExe(exe: string): void {
  const p = (exe ?? "").trim();
  if (!p) throw new ExecutionInvalid("LAUNCH_EXE_EMPTY");
  if (LAUNCHER_EXT.test(p)) throw new ExecutionInvalid(`LAUNCH_EXE_LAUNCHER_SHIM:${p}`);
  if (!ABS_PATH.test(p)) throw new ExecutionInvalid(`LAUNCH_EXE_NOT_ABSOLUTE:${p}`);
}

// §H direct-launch resolution: emit the resolved tuple (frozen abs exe + prefix args). The entrypoint,
// where applicable, MUST be the first prefix arg (Codex node->codex.js; Claude native exe, no prefix).
export interface ResolvedDirectLaunch { exe: string; prefixArgs: string[]; }
export function resolveDirectLaunch(id: FrozenLaunchIdentity): ResolvedDirectLaunch {
  assertDirectExe(id.executable_path);
  for (const a of id.prefix_args) if (typeof a !== "string" || !a.trim()) throw new ExecutionInvalid("LAUNCH_PREFIX_ARG_INVALID");
  if (id.entrypoint_path && id.prefix_args[0] !== id.entrypoint_path) throw new ExecutionInvalid("LAUNCH_ENTRYPOINT_NOT_FIRST_PREFIX_ARG");
  return { exe: id.executable_path, prefixArgs: [...id.prefix_args] };
}

// §H every production CommandSpec invariant: ABSOLUTE exe, shell:false, string arg-array (no shell string).
export function assertProductionCommandSpec(spec: CommandSpec): void {
  assertDirectExe(spec.exe);
  if (spec.shell !== false) throw new ExecutionInvalid("LAUNCH_SHELL_NOT_FALSE");
  if (!Array.isArray(spec.args)) throw new ExecutionInvalid("LAUNCH_ARGS_NOT_ARRAY");
  for (const a of spec.args) if (typeof a !== "string") throw new ExecutionInvalid("LAUNCH_ARG_NOT_STRING");
}

// §G deterministic, separately-hashed package-tree manifest. Sorted + closed-class; unknown class fails.
export function packageTreeHash(m: PackageTreeEntry[]): string {
  return sha256(JSON.stringify([...m].map((e) => [e.relative_path, e.byte_length, e.sha256, e.artifact_class])));
}
export function assertPackageTreeContract(id: FrozenLaunchIdentity): void {
  const m = id.package_tree_manifest;
  if (!Array.isArray(m) || m.length === 0) throw new ExecutionInvalid("PKG_TREE_EMPTY");
  for (let i = 1; i < m.length; i++) if (!(m[i - 1]!.relative_path < m[i]!.relative_path)) throw new ExecutionInvalid("PKG_TREE_NOT_SORTED_OR_DUP");
  for (const e of m) {
    if (typeof e.relative_path !== "string" || !e.relative_path) throw new ExecutionInvalid("PKG_TREE_BAD_PATH");
    if (typeof e.byte_length !== "number" || e.byte_length < 0) throw new ExecutionInvalid("PKG_TREE_BAD_LEN");
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new ExecutionInvalid("PKG_TREE_BAD_HASH");
    if (!NEVER_EXCLUDE.includes(e.artifact_class) && !EXPLICIT_EXCLUDE.includes(e.artifact_class) && e.artifact_class !== "other")
      throw new ExecutionInvalid(`PKG_TREE_UNKNOWN_CLASS:${e.artifact_class}`);
  }
  if (id.package_tree_manifest_sha256 !== packageTreeHash(m)) throw new ExecutionInvalid("PKG_TREE_MANIFEST_HASH_MISMATCH");
}

// §I/§J drift control. A DriftProbe is the disk-observed state (produced by an injected reader in
// production; constructed directly in tests). Any mismatch => CLIENT_BINARY_DRIFT = EXECUTION_INVALID
// = WHOLE_RUN_ABORT, NOT retryable / A1_FAIL / A1_INSUFFICIENT / PASS_WITH_LIMITATIONS / warning.
export type DriftTiming = "preflight" | "before-run" | "before-every-process-invocation" | "after-every-process-exit" | "before-seal";
export const DRIFT_TIMINGS: DriftTiming[] = ["preflight", "before-run", "before-every-process-invocation", "after-every-process-exit", "before-seal"];
export interface DriftProbe { exeHash: string; entrypointHash?: string; packageTreeHash: string; packageVersion: string; clientVersionOutput: string; }
export class ClientBinaryDrift extends ExecutionInvalid {
  readonly client_binary_drift = true; readonly whole_run_abort = true; readonly retryable = false;
  constructor(public timing: DriftTiming, public field: string) { super(`CLIENT_BINARY_DRIFT@${timing}: ${field}`); this.name = "ClientBinaryDrift"; }
}
export interface LaunchVerification { timing: DriftTiming; verified_at_monotonic: number; verified_manifest_hash: string; }
// §J TOCTOU: hash-pin re-verify of exe + entrypoint + package-tree + version + client-version vs the
// frozen tuple, at any of the five timings. Records the verification monotonic clock + manifest hash.
export function verifyFrozenLaunch(id: FrozenLaunchIdentity, probe: DriftProbe, timing: DriftTiming): LaunchVerification {
  const fail = (f: string): never => { throw new ClientBinaryDrift(timing, f); };
  assertDirectExe(id.executable_path);
  assertPackageTreeContract(id);
  if (probe.exeHash !== id.executable_sha256) fail("EXE_HASH");
  if (id.entrypoint_sha256 && probe.entrypointHash !== id.entrypoint_sha256) fail("ENTRYPOINT_HASH");
  if (probe.packageTreeHash !== id.package_tree_manifest_sha256) fail("PACKAGE_TREE_HASH");
  if (probe.packageVersion !== id.package_version) fail("PACKAGE_VERSION");
  if (probe.clientVersionOutput !== id.client_version_output) fail("CLIENT_VERSION_OUTPUT");
  return { timing, verified_at_monotonic: performance.now(), verified_manifest_hash: id.package_tree_manifest_sha256 };
}

// §K closed-world env: built ONLY from a frozen allowlist with disposable values (NEVER process.env /
// inherited PATH / HOME / secrets / proxy / MCP). CONTROL and AVAILABLE share one byte-equivalent env;
// the F2AI arm difference belongs ONLY in the isolated MCP config, never as an env-secret difference.
const ENV_KEY_SECRET = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|GITHUB|GH_|NPM|CLOUDFLARE|CF_|AWS_|GOOGLE|AZURE|OPENAI|ANTHROPIC|SSH_AUTH_SOCK|GIT_ASKPASS|PROXY|MCP|GATEWAY)/i;
export interface FrozenEnvSpec { home: string; tempDir: string; minimalPath: string; clientConfigVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR"; clientConfigDir: string; }
export function buildClosedWorldEnv(s: FrozenEnvSpec): Record<string, string> {
  const env: Record<string, string> = {
    HOME: s.home, USERPROFILE: s.home, HOMEDRIVE: "C:", HOMEPATH: "\\frozen\\home",
    APPDATA: join(s.home, "AppData", "Roaming"), LOCALAPPDATA: join(s.home, "AppData", "Local"),
    TEMP: s.tempDir, TMP: s.tempDir, PATH: s.minimalPath, [s.clientConfigVar]: s.clientConfigDir,
  };
  for (const k of Object.keys(env)) if (ENV_KEY_SECRET.test(k)) throw new ExecutionInvalid(`ENV_DISPOSABLE_KEY_MATCHES_SECRET_DENY:${k}`);
  return env;
}

// §L credential boundary: NON-secret interface only. This PR never reads/copies/models credential
// VALUES, never places a credential path in tracked JSON, never emits token-shaped data.
export interface CredentialBoundary { capsule_external_to_evidence: true; projected_credential_location: string; excluded_from_sealing: true; leakage_invalidates: true; }

// §O Codex direct public-F2AI control. NOT "BLOCKED=YES": native web is not assumed absent; all native
// + relay events are captured; every accepted F2AI tool use must appear in the relay; any native F2AI
// access OUTSIDE the relay invalidates the episode; an unobservable native channel blocks qualification.
export const CODEX_DIRECT_PUBLIC_F2AI_CONTROL = "MACHINE_DETECTABLE_INVALIDATE_ON_USE" as const;
export const CODEX_NETWORK_CONTROL = {
  control: CODEX_DIRECT_PUBLIC_F2AI_CONTROL, native_web_assumed_absent: false, all_native_and_relay_events_captured: true,
  accepted_f2ai_tool_use_must_appear_in_relay: true, native_f2ai_outside_relay_invalidates_episode: true,
  unobservable_native_external_access_blocks_qualification: true, runtime_proof: "G2R-3",
} as const;

// D-200 §M/§N acceptance-authority pointer binding. The TRACKED config pointer (agents.json +
// matrix.json) holds STABLE repository metadata ONLY (source_path + exported_symbol_name +
// authority_role) — NO commit SHA / machine path / hash (those belong to the future sealed manifest).
// The RUNTIME descriptor is DERIVED from the actual exported functions (reconcileRequiredCells +
// acceptRequiredCells, the matrix-bound runtime authority); acceptTwoCell is NO LONGER the authority.
export const ACCEPTANCE_AUTHORITY_ROLE = "MATRIX_BOUND_RUNTIME_ACCEPTANCE_AUTHORITY";
const FORBIDDEN_AUTHORITY_SYMBOL = "acceptTwoCell";
export interface AcceptanceAuthorityPointer { source_path: string; exported_symbol_name: string[]; authority_role: string; }
export interface AcceptanceAuthorityDescriptor { source_path: string; authority_role: string; exported: Record<string, unknown>; }
export interface FrozenAuthorityManifest { main_sha: string; source_file_sha256: string; }
// Runtime descriptor bound to the REAL functions (binding is proven by compilation: a rename/removal
// breaks the import). Documentation text is NEVER the proof — this object is.
export const ACCEPTANCE_AUTHORITY: AcceptanceAuthorityDescriptor = {
  source_path: "src/subject_runner.ts", authority_role: ACCEPTANCE_AUTHORITY_ROLE,
  exported: { reconcileRequiredCells, acceptRequiredCells },
};
export class AcceptanceAuthorityPointerDrift extends ExecutionInvalid {
  constructor(reason: string) { super(`ACCEPTANCE_AUTHORITY_POINTER_DRIFT: ${reason}`); this.name = "AcceptanceAuthorityPointerDrift"; }
}
function readAuthorityPointer(cfg: unknown, where: string): AcceptanceAuthorityPointer {
  const p = (cfg as { acceptance_authority_pointer?: unknown } | null)?.acceptance_authority_pointer as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") throw new AcceptanceAuthorityPointerDrift(`${where} pointer missing/malformed`);
  const { source_path, exported_symbol_name, authority_role } = p;
  if (typeof source_path !== "string" || !source_path) throw new AcceptanceAuthorityPointerDrift(`${where} source_path missing`);
  if (typeof authority_role !== "string" || !authority_role) throw new AcceptanceAuthorityPointerDrift(`${where} authority_role missing`);
  if (!Array.isArray(exported_symbol_name) || !exported_symbol_name.length) throw new AcceptanceAuthorityPointerDrift(`${where} exported_symbol_name missing`);
  const seen = new Set<string>();
  for (const s of exported_symbol_name) {
    if (typeof s !== "string" || !s) throw new AcceptanceAuthorityPointerDrift(`${where} malformed symbol entry`);
    if (s === FORBIDDEN_AUTHORITY_SYMBOL) throw new AcceptanceAuthorityPointerDrift(`${where} names stale ${FORBIDDEN_AUTHORITY_SYMBOL}`);
    if (seen.has(s)) throw new AcceptanceAuthorityPointerDrift(`${where} duplicate pointer symbol ${s}`);
    seen.add(s);
  }
  return { source_path, exported_symbol_name: [...seen], authority_role };
}
function samePointer(a: AcceptanceAuthorityPointer, b: AcceptanceAuthorityPointer): boolean {
  return a.source_path === b.source_path && a.authority_role === b.authority_role &&
    [...a.exported_symbol_name].sort().join("|") === [...b.exported_symbol_name].sort().join("|");
}
// §N preflight reconcile: tracked agents pointer + tracked matrix pointer + the actual runtime
// descriptor (+ optional sealed manifest). FAILS CLOSED on acceptTwoCell named / missing symbol /
// wrong source path / one config stale / extra-or-missing symbol / duplicate / malformed pointer /
// non-exported symbol / (manifest) different main SHA / source-file hash != current source bytes.
export function reconcileAcceptanceAuthority(
  agents: unknown, matrix: unknown, runtime: AcceptanceAuthorityDescriptor = ACCEPTANCE_AUTHORITY,
  manifest?: FrozenAuthorityManifest, currentMainSha?: string, currentSourceHash?: string,
): AcceptanceAuthorityPointer {
  const ap = readAuthorityPointer(agents, "agents.json"), mp = readAuthorityPointer(matrix, "matrix.json");
  if (!samePointer(ap, mp)) throw new AcceptanceAuthorityPointerDrift("agents/matrix pointer disagree (one config stale)");
  if (ap.source_path !== runtime.source_path) throw new AcceptanceAuthorityPointerDrift("pointer source_path != runtime descriptor");
  if (ap.authority_role !== runtime.authority_role) throw new AcceptanceAuthorityPointerDrift("pointer authority_role != runtime descriptor");
  const runtimeSyms = Object.keys(runtime.exported);
  for (const s of ap.exported_symbol_name) {
    if (!(s in runtime.exported)) throw new AcceptanceAuthorityPointerDrift(`pointer names non-exported/unknown symbol ${s}`);
    if (typeof runtime.exported[s] !== "function") throw new AcceptanceAuthorityPointerDrift(`pointer symbol ${s} is not a runtime function`);
  }
  if (runtimeSyms.length !== ap.exported_symbol_name.length || runtimeSyms.some((s) => !ap.exported_symbol_name.includes(s)))
    throw new AcceptanceAuthorityPointerDrift("extra/missing acceptance-authority symbol vs runtime descriptor");
  if (manifest) {
    if (typeof currentMainSha === "string" && manifest.main_sha !== currentMainSha) throw new AcceptanceAuthorityPointerDrift("frozen manifest main SHA mismatch");
    if (typeof currentSourceHash === "string" && manifest.source_file_sha256 !== currentSourceHash) throw new AcceptanceAuthorityPointerDrift("frozen authority-file hash != current source bytes");
  }
  return ap;
}
