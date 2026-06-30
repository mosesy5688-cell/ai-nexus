// subject_runner.ts — episode LIFECYCLE/ORCHESTRATION for the HARNESS_DRIVEN_NON_INTERACTIVE
// real-Agent cells (D-193 P1/P3/P7). Owns: immutable input record, Windows-safe process spawn
// (shell:false, STDIN, monotonic timeout, process-tree kill via an injectable controller),
// RAW capture, fail-closed classification, evidence seal (exclusive-create + atomic +
// RUN_SEALED), relay-vs-native reconciliation, two required-cell acceptance, and a fail-closed
// model-id guard. NO live Agent/F2AI here; tests inject a fake process controller + mock data.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Arm } from "./schema_evidence.js";
import { ExecutionInvalid, sha256 } from "./manifest.js";

// D-194 C4: the tool-call gate is a DESIGN PATH, not "resolved".
export const TOOL_CALL_GATE_STATUS = "DESIGN_PATH_IDENTIFIED|IMPLEMENTATION_PENDING|QUALIFICATION_PENDING";

export interface EpisodeInputRecord {
  run_id: string; episode_id: string; cell_id: string; arm: Arm; scenario_id: string;
  rep_index: number; seeded_order_position: number; exact_neutral_task_text: string;
  task_text_sha256: string; prompt_wrapper_version: string; prompt_wrapper_sha256: string;
  agent_cli_version: string; exact_model_id: string; config_profile_hash: string;
  mcp_config_hash: string; disposable_workspace_fingerprint: string; harness_main_sha: string;
  execution_utc: string;
}

// Build the IMMUTABLE per-episode input record (D-193 P2). The Agent receives ONLY the neutral
// task + one frozen wrapper; arm name / relevance class / expected tool are NEVER recorded here.
export function buildInputRecord(
  a: Omit<EpisodeInputRecord, "episode_id" | "task_text_sha256" | "prompt_wrapper_sha256"> & { prompt_wrapper: string },
): EpisodeInputRecord {
  const { prompt_wrapper, ...rest } = a;
  return {
    ...rest,
    episode_id: sha256(`${a.cell_id}|${a.arm}|${a.scenario_id}|rep${a.rep_index}`).slice(0, 24),
    task_text_sha256: sha256(a.exact_neutral_task_text),
    prompt_wrapper_sha256: sha256(prompt_wrapper),
  };
}

export interface CommandSpec { exe: string; args: string[]; env: Record<string, string>; stdin: string; }
export interface ProcessResult {
  startFailed: boolean; exitCode: number | null; signal: string | null;
  timedOut: boolean; forcedKill: boolean; stdout: Buffer; stderr: Buffer; elapsedMs: number;
}
// Abstraction so process-tree termination + start-failure are testable with a FAKE controller.
export interface ProcessController { run(spec: CommandSpec, timeoutMs: number): Promise<ProcessResult>; }

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  // Terminate the whole PROCESS TREE. exe + arg array, shell:false (no command-string quoting).
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false });
  else try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
}

// Production controller: real spawn. shell:false, args as an array, task via STDIN (closed
// deterministically), raw byte stdout/stderr, monotonic-clock timeout, tree-kill on timeout,
// partial stdout preserved. NEVER invoked by the test suite (which injects a fake controller).
export class NodeProcessController implements ProcessController {
  run(spec: CommandSpec, timeoutMs: number): Promise<ProcessResult> {
    const out: Buffer[] = [], err: Buffer[] = [];
    const startedAt = performance.now();
    const base = { exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    return new Promise<ProcessResult>((resolve) => {
      let child: ReturnType<typeof spawn>, settled = false, timedOut = false, forced = false;
      const done = (r: Partial<ProcessResult>): void => {
        if (settled) return; settled = true;
        resolve({ startFailed: false, timedOut, forcedKill: forced, elapsedMs: performance.now() - startedAt, ...base, ...r });
      };
      try {
        child = spawn(spec.exe, spec.args, { shell: false, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        resolve({ startFailed: true, timedOut: false, forcedKill: false, elapsedMs: 0, ...base }); return;
      }
      const timer = setTimeout(() => { timedOut = true; forced = true; killTree(child.pid); }, timeoutMs);
      child.on("error", () => { clearTimeout(timer); if (!settled) { settled = true; resolve({ startFailed: true, timedOut: false, forcedKill: false, elapsedMs: 0, ...base }); } });
      child.stdout?.on("data", (d: Buffer) => out.push(d));
      child.stderr?.on("data", (d: Buffer) => err.push(d));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done({ exitCode: code, signal: signal ?? null, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      });
      child.stdin?.end(spec.stdin); // deterministic stdin close
    });
  }
}

export interface ExecVerdict { valid: boolean; reason: string; }
// FAIL CLOSED: start-failure / timeout / non-zero exit / empty / malformed stream => INVALID.
export function classifyExecution(p: ProcessResult, hasOutput: boolean, parsedOk: boolean): ExecVerdict {
  if (p.startFailed) return { valid: false, reason: "PROCESS_START_FAILURE" };
  if (p.timedOut) return { valid: false, reason: "TIMEOUT_PROCESS_TREE_KILLED" };
  if (p.exitCode !== 0) return { valid: false, reason: `NONZERO_EXIT_${p.exitCode}` };
  if (!hasOutput) return { valid: false, reason: "EMPTY_OUTPUT" };
  if (!parsedOk) return { valid: false, reason: "MALFORMED_EVENT_STREAM" };
  return { valid: true, reason: "OK" };
}

// D-192 §I model-id FAIL-CLOSED guard. Rejects floating/placeholder ids and any id the client
// does not echo/confirm. The PR defines this guard; it does NOT select the model.
const BANNED_MODEL_IDS = new Set(["", "codex", "default", "latest", "opus", "claude", "unresolved_at_execution_freeze"]);
export function assertModelResolved(modelId: string, confirmed?: string | null): void {
  const id = (modelId ?? "").trim();
  if (BANNED_MODEL_IDS.has(id.toLowerCase()) || /unresolved|placeholder/i.test(id)) {
    throw new ExecutionInvalid(`unresolved/placeholder/floating model id: '${id}'`);
  }
  if (confirmed != null && confirmed !== id) {
    throw new ExecutionInvalid(`model id not confirmed by client: '${id}' != '${confirmed}'`);
  }
}

export interface SealEntry { relative_path: string; byte_size: number; sha256: string; artifact_class: string; episode_id: string; }

// Unique run dir under the gitignored out/ path; FAIL if it already exists (no recursive create).
export function createRunDir(outRoot: string, runId: string): string {
  const dir = join(outRoot, runId);
  mkdirSync(dir, { recursive: false });
  return dir;
}
// Exclusive-create: never overwrite a raw artifact (flag wx throws on collision).
export function writeRawArtifact(dir: string, rel: string, data: string | Buffer): void {
  writeFileSync(join(dir, rel), data, { flag: "wx" });
}
// Normalized artifacts are written via a temp file + atomic rename (no in-place mutation).
export function atomicNormalizedWrite(dir: string, rel: string, data: string): void {
  const tmp = join(dir, `.tmp-${rel.replace(/[\\/]/g, "_")}-${process.pid}`);
  writeFileSync(tmp, data, { flag: "wx" });
  renameSync(tmp, join(dir, rel));
}
export function buildSealManifest(entries: SealEntry[]): SealEntry[] {
  return [...entries].sort((a, b) => (a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0));
}
// Seal: write the sorted manifest, hash it, drop a RUN_SEALED marker carrying that hash.
export function sealRun(dir: string, entries: SealEntry[]): string {
  const manifestStr = JSON.stringify(buildSealManifest(entries));
  writeRawArtifact(dir, "seal_manifest.json", manifestStr);
  const hash = sha256(manifestStr);
  writeRawArtifact(dir, "RUN_SEALED", hash);
  return hash;
}
// Refuse scoring if RUN_SEALED is absent OR any size/hash diverges (the manifest hash binds both).
export function assertSealedForScoring(dir: string, currentEntries: SealEntry[]): void {
  let marker: string;
  try { marker = readFileSync(join(dir, "RUN_SEALED"), "utf8"); }
  catch { throw new ExecutionInvalid("RUN_SEALED marker absent: refusing to score"); }
  if (sha256(JSON.stringify(buildSealManifest(currentEntries))) !== marker) {
    throw new ExecutionInvalid("seal hash mismatch: artifact size/hash diverged post-seal");
  }
}

export type ReconVerdict =
  | "CONFIRMED" | "CONFIRMED_WITH_TRACE_LIMITATION" | "EXECUTION_INVALID"
  | "NO_MACHINE_PROVEN_CALL" | "MISSING_TRACE";
export interface ReconInput {
  arm: Arm; relayF2aiCall: boolean; relayMalformed: boolean; nativeF2aiCall: boolean;
  nativeContradictsIdentity: boolean; nativeFormatGuaranteesCompleteness: boolean;
  controlNativeF2ai: boolean; availableDirectOutsideRelay: boolean;
}
// Relay is PRIMARY AVAILABLE F2AI evidence; native streams corroborate. Tool use never inferred from prose.
export function reconcile(a: ReconInput): { verdict: ReconVerdict; reason: string } {
  const inv = (reason: string) => ({ verdict: "EXECUTION_INVALID" as const, reason });
  if (a.arm === "CONTROL" && (a.controlNativeF2ai || a.relayF2aiCall)) return inv("CONTROL_NATIVE_F2AI_ACCESS");
  if (a.arm === "AVAILABLE" && a.availableDirectOutsideRelay) return inv("AVAILABLE_DIRECT_F2AI_OUTSIDE_RELAY");
  if (a.relayMalformed) return { verdict: "MISSING_TRACE", reason: "MALFORMED_OR_INCOMPLETE_RELAY_TRACE" };
  if (a.relayF2aiCall && a.nativeContradictsIdentity) return inv("RELAY_VS_NATIVE_IDENTITY_CONTRADICTION");
  if (a.nativeF2aiCall && !a.relayF2aiCall) return inv("NATIVE_F2AI_WITHOUT_RELAY_TRACE");
  if (a.relayF2aiCall && a.nativeF2aiCall) return { verdict: "CONFIRMED", reason: "RELAY_PLUS_MATCHING_NATIVE" };
  if (a.relayF2aiCall && !a.nativeFormatGuaranteesCompleteness) {
    return { verdict: "CONFIRMED_WITH_TRACE_LIMITATION", reason: "RELAY_CALL_NATIVE_ABSENT_FORMAT_NOT_GUARANTEED" };
  }
  if (a.relayF2aiCall) return { verdict: "CONFIRMED", reason: "RELAY_PRIMARY_EVIDENCE" };
  return { verdict: "NO_MACHINE_PROVEN_CALL", reason: "PROSE_ONLY_NO_RELAY_TRACE" };
}

export interface CellOutcome { cell_id: string; evaluated: boolean; passing: boolean; }
export type A1Acceptance = "A1_PASS" | "A1_FAIL" | "A1_INSUFFICIENT" | "EXECUTION_INVALID";
// Two REQUIRED real cells (Codex + Claude). One passing can never hide one failing; a missing
// required cell forces A1_INSUFFICIENT. Legacy self-loops/optional 3rd can never satisfy this gate.
export function acceptTwoCell(codex?: CellOutcome, claude?: CellOutcome): { state: A1Acceptance; reasons: string[] } {
  const reasons: string[] = [];
  if (!codex || !codex.evaluated) { reasons.push("required cell CELL-A Codex NOT_EVALUATED"); return { state: "A1_INSUFFICIENT", reasons }; }
  if (!claude || !claude.evaluated) { reasons.push("required cell CELL-B Claude_Code_Opus NOT_EVALUATED"); return { state: "A1_INSUFFICIENT", reasons }; }
  const failing = [codex, claude].filter((c) => !c.passing);
  if (failing.length) { for (const f of failing) reasons.push(`required cell ${f.cell_id} failed`); return { state: "A1_FAIL", reasons }; }
  reasons.push("both required real-Agent cells evaluated and passing");
  return { state: "A1_PASS", reasons };
}
