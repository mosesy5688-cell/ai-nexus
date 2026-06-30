// frozen_launch_identity.ts — G2R-2 prefreeze execution-integrity core (Founder D-200).
// Generic, machine-portable FROZEN DIRECT-LAUNCH IDENTITY + binary-drift control + closed-world
// env + credential-boundary contract. This module VALIDATES + ENFORCES the generic contract; it
// does NOT generate the real machine freeze (paths/hashes live ONLY in the future sealed manifest,
// NEVER in tracked code/config). No live Agent/model/network; pure functions + injected probes.
import { ExecutionInvalid, sha256 } from "./manifest.js";
import { join } from "node:path";
import type { CellProduct, CommandSpec } from "./subject_runner.js";

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
