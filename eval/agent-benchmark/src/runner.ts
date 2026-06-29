// runner.ts — out-of-band orchestration + pure, testable harness helpers.
// NEVER runs in product CI. NO live call or model inference happens here unless an
// operator supplies live executors + a local model; the test suite uses neither.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Arm, HostContext, ToolCall, ToolResult } from "./schema_evidence.js";
import { COMPETING_DESCRIPTORS, type ToolDescriptor } from "./tools_competing.js";
import { F2AI_DESCRIPTORS } from "./tools_f2a.js";
import { ExecutionInvalid, hashJson, sha256, type ModelProvenance, type RunManifest, type F2aiDataBinding, type OrderingRecord } from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(HERE, "..");

export function loadJson<T = unknown>(absPath: string): T {
  return JSON.parse(readFileSync(absPath, "utf8")) as T;
}

export interface CorpusItem {
  id: string;
  prompt: string;
  is_qualification?: boolean;
  fault_class?: string;
}

export type CorpusKind = "evaluation" | "qualification";

// FAIL CLOSED: a missing or empty corpus throws; an item placed in the wrong
// corpus (cross-load) throws. Qualification and evaluation can NEVER cross-load.
export function loadCorpus(kind: CorpusKind, root = PKG_ROOT): CorpusItem[] {
  const file = join(root, "corpus", `${kind}.jsonl`);
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new ExecutionInvalid(`empty corpus: ${kind}`);
  const items = lines.map((l) => JSON.parse(l) as CorpusItem);
  for (const it of items) {
    if (!it.id || typeof it.prompt !== "string") throw new ExecutionInvalid(`malformed corpus item in ${kind}`);
    if (kind === "evaluation" && (it.is_qualification || it.id.startsWith("QUAL-"))) {
      throw new ExecutionInvalid(`qualification item ${it.id} leaked into evaluation corpus`);
    }
    if (kind === "qualification" && !it.is_qualification) {
      throw new ExecutionInvalid(`evaluation item ${it.id} present in qualification corpus`);
    }
  }
  return items;
}

export function assertNoCrossLoad(evalItems: CorpusItem[], qualItems: CorpusItem[]): void {
  const evalIds = new Set(evalItems.map((i) => i.id));
  for (const q of qualItems) {
    if (evalIds.has(q.id)) throw new ExecutionInvalid(`scenario ${q.id} appears in BOTH corpora`);
  }
  if (evalItems.length === 0 || qualItems.length === 0) throw new ExecutionInvalid("a corpus is empty");
}

// ARM-CONTROL excludes ALL F2AI tools; ARM-AVAILABLE adds them alongside the same
// competing alternatives (F2AI optional, never the only able tool, never forced).
export function buildToolset(arm: Arm): ToolDescriptor[] {
  const base = [...COMPETING_DESCRIPTORS];
  if (arm === "AVAILABLE") return [...base, ...F2AI_DESCRIPTORS];
  return base;
}

// Deterministic seeded RNG (mulberry32) for reproducible arm/scenario ordering.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededOrder<T>(seed: number, items: readonly T[]): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Unique, deterministic session id per episode — guarantees a FRESH session and
// that no tool output / memory / learning carries across episodes or arms.
export function makeSessionId(scenarioId: string, runtimeId: string, arm: Arm, rep: number): string {
  return sha256(`${runtimeId}|${arm}|${scenarioId}|rep${rep}`).slice(0, 24);
}

export function buildEpisodeContext(
  args: { scenarioId: string; runtimeId: string; arm: Arm; rep: number; seed: number; prompt: string; injectedFault?: string | null },
  execute: (call: ToolCall) => Promise<ToolResult>,
): HostContext {
  const tools = buildToolset(args.arm).map((t) => ({ name: t.name, description: t.description }));
  return {
    scenario_id: args.scenarioId,
    runtime_id: args.runtimeId,
    arm: args.arm,
    rep: args.rep,
    seed: args.seed,
    session_id: makeSessionId(args.scenarioId, args.runtimeId, args.arm, args.rep),
    prompt: args.prompt,
    tools,
    injected_fault: args.injectedFault ?? null,
    execute,
  };
}

export function assertFreshSessions(sessionIds: string[]): void {
  if (new Set(sessionIds).size !== sessionIds.length) throw new ExecutionInvalid("duplicate session id: session not fresh");
}

export interface MatrixCell {
  cell_id: string;
  required: boolean;
  model_repo: string;
  model_digest: string;
  transport: string;
  agent_host_impl: string;
}
export interface MatrixConfig {
  required_cell_count: number;
  cells: MatrixCell[];
}

// FAIL CLOSED: fewer than the required number of resolvable required cells voids
// the run (a required runtime missing cannot become a pass).
export function resolveCells(matrix: MatrixConfig): MatrixCell[] {
  const required = matrix.cells.filter((c) => c.required);
  if (required.length < matrix.required_cell_count) {
    throw new ExecutionInvalid(`only ${required.length} required cells resolve; need ${matrix.required_cell_count}`);
  }
  return required;
}

export function computeArtifactHashes(root = PKG_ROOT): Pick<RunManifest, "corpus_sha256" | "labels_sha256" | "promptset_sha256" | "matrix_sha256" | "tools_sha256" | "limits_sha256"> {
  const tools = loadJson<{ tools_version: string; promptset: unknown }>(join(root, "config", "tools.json"));
  return {
    corpus_sha256: sha256(readFileSync(join(root, "corpus", "evaluation.jsonl"), "utf8")),
    labels_sha256: hashJson(loadJson(join(root, "corpus", "labels.manifest.json"))),
    promptset_sha256: hashJson(tools.promptset),
    matrix_sha256: hashJson(loadJson(join(root, "config", "matrix.json"))),
    tools_sha256: hashJson(loadJson(join(root, "config", "tools.json"))),
    limits_sha256: hashJson(loadJson(join(root, "config", "limits.json"))),
  };
}

// PRE-REGISTERED default ordering seed (frozen; recorded in the manifest).
export const PRE_REGISTERED_ORDERING_SEED = 0xa1be11;

// Derive the deterministic, hash-stamped arm + scenario ordering from a seed.
export function buildOrderingRecord(seed: number, scenarioIds: string[]): OrderingRecord {
  const arm_order = seededOrder(seed, ["CONTROL", "AVAILABLE"] as const) as string[];
  const scenario_order = seededOrder(seed, scenarioIds);
  return {
    ordering_seed: seed,
    arm_order,
    scenario_order,
    ordering_sha256: hashJson({ seed, arm_order, scenario_order }),
  };
}

export function buildRunManifest(
  harnessGitSha: string,
  root = PKG_ROOT,
  dataBinding?: F2aiDataBinding,
  orderingSeed = PRE_REGISTERED_ORDERING_SEED,
): RunManifest {
  const hashes = computeArtifactHashes(root);
  const matrix = loadJson<MatrixConfig>(join(root, "config", "matrix.json"));
  const cells = resolveCells(matrix);
  const ordering = buildOrderingRecord(orderingSeed, loadCorpus("evaluation", root).map((i) => i.id));
  const models: ModelProvenance[] = cells.map((c) => ({
    cell_id: c.cell_id,
    model_repo: c.model_repo,
    model_digest: c.model_digest,
    transport: c.transport,
    agent_host_impl: c.agent_host_impl,
  }));
  return {
    harness_git_sha: harnessGitSha,
    ...hashes,
    models,
    runtime_versions: {},
    started_at_utc: new Date(0).toISOString(),
    f2ai_data_binding:
      dataBinding ?? {
        production_deployment_sha: "4288d569ec50f7aa995ed40759c2cb172a64f2fa",
        data_manifest_identifier: "RECORDED_AT_QUALIFICATION",
        data_manifest_sha256_or_equivalent_digest: "RECORDED_AT_QUALIFICATION",
        relevant_object_etags_or_snapshot_fingerprint: "RECORDED_AT_QUALIFICATION",
        captured_before_utc: "RECORDED_AT_QUALIFICATION",
        captured_after_utc: "RECORDED_AT_QUALIFICATION",
        binding_mode: "BOUNDED_LIVE_WINDOW",
      },
    ordering,
  };
}

// Used to list discoverable artifact files for the secret/content scan in tests.
export function listSourceFiles(root = PKG_ROOT): string[] {
  const out: string[] = [];
  for (const d of ["src", "config", "corpus"]) {
    for (const f of readdirSync(join(root, d))) out.push(join(root, d, f));
  }
  return out;
}
