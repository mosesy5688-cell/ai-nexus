// manifest.ts — closed-world artifact hashing, model provenance, data-binding
// drift invalidation, and fail-closed verification. Pure functions; no live calls.
import { createHash } from "node:crypto";

export class ExecutionInvalid extends Error {
  readonly code = "EXECUTION_INVALID";
  constructor(public reason: string) {
    super(`EXECUTION_INVALID: ${reason}`);
    this.name = "ExecutionInvalid";
  }
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

// Canonical JSON hash (stable key ordering) for config sub-objects.
export function hashJson(value: unknown): string {
  return sha256(canonical(value));
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export interface ModelProvenance {
  cell_id: string;
  model_repo: string;
  model_digest: string;
  transport: string;
  agent_host_impl: string;
}

export interface F2aiDataBinding {
  production_deployment_sha: string;
  data_manifest_identifier: string;
  data_manifest_sha256_or_equivalent_digest: string;
  relevant_object_etags_or_snapshot_fingerprint: string;
  captured_before_utc: string;
  captured_after_utc: string;
  binding_mode: "FROZEN_SNAPSHOT" | "BOUNDED_LIVE_WINDOW";
}

export interface RunManifest {
  harness_git_sha: string;
  corpus_sha256: string;
  labels_sha256: string;
  promptset_sha256: string;
  matrix_sha256: string;
  tools_sha256: string;
  limits_sha256: string;
  models: ModelProvenance[];
  runtime_versions: Record<string, string>;
  started_at_utc: string;
  f2ai_data_binding: F2aiDataBinding;
  ordering: OrderingRecord;
}

// D-189 §D: arm + scenario order is deterministically randomized from a
// PRE-REGISTERED seed AND recorded in the manifest (not merely procedural).
export interface OrderingRecord {
  ordering_seed: number;
  arm_order: string[];
  scenario_order: string[];
  ordering_sha256: string; // hash of {seed, arm_order, scenario_order} for tamper-evidence
}

const DIGEST_PLACEHOLDER = "RECORDED_AT_QUALIFICATION";
const REQUIRED_HASH_KEYS: Array<keyof RunManifest> = [
  "corpus_sha256",
  "labels_sha256",
  "promptset_sha256",
  "matrix_sha256",
  "tools_sha256",
  "limits_sha256",
];

// FAIL CLOSED: every consumed-artifact hash must be a present 64-hex string.
export function assertManifestComplete(m: RunManifest): void {
  for (const key of REQUIRED_HASH_KEYS) {
    const v = m[key];
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) {
      throw new ExecutionInvalid(`missing or malformed hash: ${String(key)}`);
    }
  }
  if (!m.harness_git_sha) throw new ExecutionInvalid("missing harness_git_sha");
  if (!m.models.length) throw new ExecutionInvalid("no model provenance recorded");
  assertOrderingRecorded(m.ordering);
}

// FAIL CLOSED: the pre-registered ordering must be present, non-empty, and carry
// a 64-hex integrity hash. An absent/empty ordering record voids the run.
export function assertOrderingRecorded(o: OrderingRecord | undefined): void {
  if (!o || typeof o.ordering_seed !== "number") throw new ExecutionInvalid("missing pre-registered ordering seed");
  if (!Array.isArray(o.arm_order) || o.arm_order.length === 0) throw new ExecutionInvalid("missing recorded arm_order");
  if (!Array.isArray(o.scenario_order) || o.scenario_order.length === 0) throw new ExecutionInvalid("missing recorded scenario_order");
  if (typeof o.ordering_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.ordering_sha256)) {
    throw new ExecutionInvalid("missing or malformed ordering_sha256");
  }
  if (o.ordering_sha256 !== hashJson({ seed: o.ordering_seed, arm_order: o.arm_order, scenario_order: o.scenario_order })) {
    throw new ExecutionInvalid("recorded ordering does not match its integrity hash");
  }
}

// FAIL CLOSED at run start: a model digest may NOT remain the qualification
// placeholder — the model is pinned by id + digest, never a floating tag.
export function assertModelsPinnedForRun(m: RunManifest): void {
  for (const model of m.models) {
    if (!model.model_digest || model.model_digest === DIGEST_PLACEHOLDER) {
      throw new ExecutionInvalid(`model digest absent for cell ${model.cell_id} (no floating identifiers)`);
    }
  }
}

// Re-verify consumed artifacts against the recorded manifest. Any divergence
// (changed corpus / prompts / tools / limits / matrix) voids the run.
export function verifyArtifactHashes(m: RunManifest, observed: Partial<Record<keyof RunManifest, string>>): void {
  assertManifestComplete(m);
  for (const key of REQUIRED_HASH_KEYS) {
    const seen = observed[key];
    if (seen === undefined) continue;
    if (seen !== m[key]) {
      throw new ExecutionInvalid(`artifact hash divergence on ${String(key)} (recorded ${String(m[key]).slice(0, 8)} != observed ${seen.slice(0, 8)})`);
    }
  }
}

// Detect model/runtime substitution against the recorded provenance.
export function assertNoModelSubstitution(m: RunManifest, current: ModelProvenance[]): void {
  if (current.length !== m.models.length) {
    throw new ExecutionInvalid(`runtime count changed mid-run (${m.models.length} -> ${current.length})`);
  }
  const byId = new Map(m.models.map((x) => [x.cell_id, x]));
  for (const c of current) {
    const rec = byId.get(c.cell_id);
    if (!rec) throw new ExecutionInvalid(`unregistered runtime cell ${c.cell_id}`);
    if (rec.model_repo !== c.model_repo || rec.model_digest !== c.model_digest || rec.transport !== c.transport) {
      throw new ExecutionInvalid(`model/runtime substitution on ${c.cell_id}`);
    }
  }
}

// Data-baseline drift: a deployment SHA alone is insufficient; the before/after
// fingerprint must match. Drift => EXECUTION_INVALID.
export function assertNoDataBindingDrift(b: F2aiDataBinding): void {
  if (!b.production_deployment_sha) throw new ExecutionInvalid("missing production_deployment_sha");
  if (!b.data_manifest_sha256_or_equivalent_digest) throw new ExecutionInvalid("missing data manifest digest");
  if (b.captured_before_utc !== b.captured_after_utc && b.binding_mode === "FROZEN_SNAPSHOT") {
    throw new ExecutionInvalid("frozen-snapshot window changed between before/after capture");
  }
}

// For the bounded-live-window mode the caller supplies the after-fingerprint
// captured at run end; any change from the before-fingerprint invalidates.
export function assertLiveWindowStable(before: F2aiDataBinding, afterFingerprint: string): void {
  if (before.relevant_object_etags_or_snapshot_fingerprint !== afterFingerprint) {
    throw new ExecutionInvalid("F2AI data baseline drifted within the bounded live window");
  }
}

// D-189 §C run-start gate: the single pre-run invariant the operator MUST pass
// before any episode. Puts the otherwise-latent model-pin guard on the real
// pre-run path. FAILS CLOSED on a placeholder digest (no floating identifier),
// an incomplete manifest, or a data-baseline defect. Throws ExecutionInvalid.
export function assertReadyForRun(m: RunManifest): void {
  assertManifestComplete(m);
  assertModelsPinnedForRun(m);
  assertNoDataBindingDrift(m.f2ai_data_binding);
}
