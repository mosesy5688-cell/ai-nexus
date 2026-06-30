// subject_runner.ts — episode LIFECYCLE/ORCHESTRATION for the HARNESS_DRIVEN_NON_INTERACTIVE
// real-Agent cells (D-193 P1/P3/P7). Owns: immutable input record, Windows-safe process spawn
// (shell:false/STDIN/monotonic timeout/process-tree kill), RAW capture, fail-closed classification,
// evidence seal, relay-vs-native reconciliation, matrix-bound required-cell acceptance (D-197), and
// a fail-closed model-id guard. NO live Agent/F2AI here; tests inject a fake controller + mock data.
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

// D-197 §H/§I/§J model-id FAIL-CLOSED guard. EXACT-token (not substring): pinned ids (claude-opus-4-8, gpt-5.5-2026-04-23) PASS; floating/placeholder/fallback FINAL ids fail.
export type CellProduct = "codex" | "claude";
const FORBIDDEN_COMMON = ["", "default", "latest", "unresolved_at_execution_freeze"];
const FORBIDDEN_CODEX = ["codex", "gpt-5.5", "gpt-5.3-codex", "unspecified configured default", "unconfirmed account-routed identity"];
const FORBIDDEN_CLAUDE = ["claude", "opus", "opusplan", "best", "claude-opus-latest", "sonnet fallback", "haiku fallback", "fable fallback", "unknown", "router-selected", "unconfirmed account-routed identity"];
export function assertModelResolved(modelId: string, confirmed?: string | null, product?: CellProduct): void {
  const id = (modelId ?? "").trim(), norm = id.toLowerCase(), banned = new Set(FORBIDDEN_COMMON);
  if (product !== "claude") for (const x of FORBIDDEN_CODEX) banned.add(x);
  if (product !== "codex") for (const x of FORBIDDEN_CLAUDE) banned.add(x);
  if (banned.has(norm) || /unresolved|placeholder/i.test(id) || /(^|[-_\s])(latest|default|best)$/.test(norm)) throw new ExecutionInvalid(`unresolved/placeholder/floating/forbidden model id: '${id}'`);
  if (confirmed != null && confirmed !== id) throw new ExecutionInvalid(`model id not confirmed by client: '${id}' != '${confirmed}'`);
}
// §I/§J generic per-cell identity guard: one EXACT frozen model per cell; every episode observes exactly it; no mid-run change; no fallback. NO second hardcoded candidate model registry.
export interface ModelObservation { cell_id: string; configured_exact_model_id: string; observed_model_id: string; product?: CellProduct; }
export function assertCellModelIdentity(obs: ModelObservation[]): void {
  if (!obs.length) throw new ExecutionInvalid("no model observations: missing model identity");
  const perCell = new Map<string, string>();
  for (const o of obs) {
    const cell = (o?.cell_id ?? "").trim();
    if (!cell) throw new ExecutionInvalid("missing cell_id in model observation");
    assertModelResolved(o.configured_exact_model_id, null, o.product);
    assertModelResolved(o.observed_model_id, null, o.product);
    const conf = o.configured_exact_model_id.trim(), seen = o.observed_model_id.trim(), prior = perCell.get(cell);
    if (seen !== conf) throw new ExecutionInvalid(`observed model '${seen}' != configured frozen model '${conf}' for ${cell}`);
    if (prior !== undefined && prior !== seen) throw new ExecutionInvalid(`model transition within run for ${cell}: '${prior}' -> '${seen}'`);
    perCell.set(cell, seen);
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

// D-197 §C/§D SINGLE SOURCE OF TRUTH: matrix.real_agent_primary_cells[].cell_id is the ONLY authoritative required-membership source. Fail closed on any defect; return a SORTED set.
export function requiredRealCellIds(matrix: unknown): string[] {
  const m = (matrix ?? {}) as Record<string, unknown>, primary = m.real_agent_primary_cells, legacy = new Set<string>();
  if (!Array.isArray(primary) || !primary.length) throw new ExecutionInvalid("real_agent_primary_cells missing/empty/not-an-array");
  if (Array.isArray(m.cells)) for (const c of m.cells) { const id = (c as { cell_id?: unknown })?.cell_id; if (typeof id === "string") legacy.add(id.trim()); }
  const seen = new Map<string, string>(), ids: string[] = [];
  for (const e of primary as Array<Record<string, unknown>>) {
    if (!e || typeof e !== "object") throw new ExecutionInvalid("malformed real_agent_primary_cells entry");
    if (typeof e.cell_id !== "string" || !e.cell_id.trim()) throw new ExecutionInvalid("missing/empty cell_id in real_agent_primary_cells");
    const raw = e.cell_id.trim();
    if (e.a1_primary === false || ("a1_primary" in e && e.a1_primary !== true)) throw new ExecutionInvalid(`non-primary cell in required set: ${raw}`);
    if (legacy.has(raw)) throw new ExecutionInvalid(`legacy local cell included as required: ${raw}`);
    const norm = raw.toUpperCase(), prior = seen.get(norm);
    if (prior !== undefined) throw new ExecutionInvalid(prior === raw ? `duplicate required cell_id: ${raw}` : `normalization collision: ${raw} vs ${prior}`);
    seen.set(norm, raw); ids.push(raw);
  }
  const count = m.real_agent_required_cell_count;
  if (typeof count !== "number" || count !== ids.length) throw new ExecutionInvalid(`real_agent_required_cell_count != derived cardinality (${String(count)} vs ${ids.length})`);
  return ids.sort();
}
// D-197 §E: agents.required_cells is a validated CONFIGURATION MIRROR ONLY (never a 2nd acceptance source). Any drift vs the derived matrix set = CONFIG_REQUIRED_CELL_DRIFT = EXECUTION_INVALID -> ABORT.
export class ConfigRequiredCellDrift extends ExecutionInvalid { constructor(reason: string) { super(`CONFIG_REQUIRED_CELL_DRIFT: ${reason}`); this.name = "ConfigRequiredCellDrift"; } }
export function reconcileRequiredCells(matrix: unknown, agents: unknown): string[] {
  const required = requiredRealCellIds(matrix), a = (agents ?? {}) as Record<string, unknown>;
  const raw = (a.acceptance as { required_cells?: unknown } | undefined)?.required_cells ?? a.required_cells;
  if (!Array.isArray(raw)) throw new ConfigRequiredCellDrift("agents required_cells missing or not an array");
  const reqSet = new Set(required), seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) throw new ConfigRequiredCellDrift("empty/malformed agents required cell");
    const id = v.trim();
    if (seen.has(id)) throw new ConfigRequiredCellDrift(`duplicate agents required cell: ${id}`);
    if (!reqSet.has(id)) throw new ConfigRequiredCellDrift(`extra agents required cell not in matrix: ${id}`);
    seen.add(id);
  }
  for (const id of required) if (!seen.has(id)) throw new ConfigRequiredCellDrift(`missing agents required cell: ${id}`);
  return required;
}
export interface CellOutcome { cell_id: string; evaluated: boolean; passing: boolean; }
export type A1Acceptance = "A1_PASS" | "A1_FAIL" | "A1_INSUFFICIENT" | "EXECUTION_INVALID";
type AcceptResult = { state: A1Acceptance; reasons: string[] };
// D-197 §F acceptance. Identity from cell_id, NEVER argument position. Consumes the ALREADY-VALIDATED required set + outcomes carrying explicit cell_id. One passing never hides one missing/failing.
export function acceptRequiredCells(required: string[], outcomes: CellOutcome[]): AcceptResult {
  const reasons: string[] = [], inv = (msg: string): AcceptResult => { reasons.push(msg); return { state: "EXECUTION_INVALID", reasons }; };
  const reqSet = new Set(required), byId = new Map<string, CellOutcome>();
  for (const o of outcomes) {
    if (!o || typeof o.cell_id !== "string" || !o.cell_id.trim()) return inv("malformed outcome: missing cell_id");
    const id = o.cell_id.trim();
    if (byId.has(id)) return inv(`duplicate outcome for cell ${id}`);
    if (!reqSet.has(id)) return inv(`unknown/legacy outcome not in required set: ${id}`);
    byId.set(id, o);
  }
  for (const id of required) { const o = byId.get(id); if (!o || !o.evaluated) { reasons.push(`required cell ${id} NOT_EVALUATED`); return { state: "A1_INSUFFICIENT", reasons }; } }
  const failing = required.filter((id) => !byId.get(id)!.passing);
  if (failing.length) { for (const id of failing) reasons.push(`required cell ${id} failed`); return { state: "A1_FAIL", reasons }; }
  reasons.push("all required real-Agent cells evaluated and passing");
  return { state: "A1_PASS", reasons };
}
// acceptTwoCell is a MATRIX-BOUND wrapper, NOT an authority: the required set is the matrix single
// source (reconcileRequiredCells over the supplied configs), NEVER self-derived from the outcomes;
// throwaway/positional ids that are not the matrix-derived required cells can never reach A1_PASS.
export function acceptTwoCell(matrix: unknown, agents: unknown, codex?: CellOutcome, claude?: CellOutcome): AcceptResult {
  return acceptRequiredCells(reconcileRequiredCells(matrix, agents), [codex, claude].filter((c): c is CellOutcome => !!c));
}
