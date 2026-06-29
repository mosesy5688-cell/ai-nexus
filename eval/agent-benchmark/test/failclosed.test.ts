// failclosed.test.ts — L requirements (1) closed-world manifest hashing,
// (2) fail on missing hash, (3) fail on changed corpus, (4) fail on changed
// prompts/tools/limits/matrix, (5) fail on model/runtime substitution,
// (6) data-binding drift, (16) thresholds read from frozen limits object,
// (22) missing/zero scenarios fail closed, (23) missing required runtime fails
// closed, (24) out/ ignored, (25) no secret/credential committed. Fixtures only.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRunManifest,
  computeArtifactHashes,
  resolveCells,
  loadCorpus,
  listSourceFiles,
  seededOrder,
  PRE_REGISTERED_ORDERING_SEED,
  PKG_ROOT,
} from "../src/runner.js";
import {
  ExecutionInvalid,
  assertManifestComplete,
  assertOrderingRecorded,
  assertReadyForRun,
  verifyArtifactHashes,
  assertNoModelSubstitution,
  assertNoDataBindingDrift,
  assertLiveWindowStable,
  sha256,
  type RunManifest,
} from "../src/manifest.js";

const HASH_KEYS: (keyof RunManifest)[] = [
  "corpus_sha256",
  "labels_sha256",
  "promptset_sha256",
  "matrix_sha256",
  "tools_sha256",
  "limits_sha256",
];

describe("closed-world manifest hashing (L1/L2)", () => {
  it("L1: builds a manifest with present 64-hex artifact hashes", () => {
    const m = buildRunManifest("4288d569ec50f7aa995ed40759c2cb172a64f2fa");
    for (const k of HASH_KEYS) expect(String(m[k])).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertManifestComplete(m)).not.toThrow();
    expect(m.models.length).toBe(3);
  });

  it("L2: a missing/blank hash fails closed", () => {
    const m = buildRunManifest("abc");
    (m as unknown as Record<string, unknown>).corpus_sha256 = "";
    expect(() => assertManifestComplete(m)).toThrow(ExecutionInvalid);
  });
});

describe("artifact divergence (L3/L4)", () => {
  it("L3: a changed corpus diverges from the manifest", () => {
    const m = buildRunManifest("abc");
    const tampered = sha256("evaluation corpus mutated");
    expect(() => verifyArtifactHashes(m, { corpus_sha256: tampered })).toThrow(ExecutionInvalid);
  });

  it("L4: changed prompts/tools/limits/matrix each diverge", () => {
    const m = buildRunManifest("abc");
    for (const k of ["promptset_sha256", "tools_sha256", "limits_sha256", "matrix_sha256"] as (keyof RunManifest)[]) {
      expect(() => verifyArtifactHashes(m, { [k]: sha256(`mutated:${String(k)}`) } as Partial<Record<keyof RunManifest, string>>)).toThrow(
        ExecutionInvalid,
      );
    }
  });

  it("matching observed hashes pass", () => {
    const m = buildRunManifest("abc");
    const observed = computeArtifactHashes();
    expect(() => verifyArtifactHashes(m, observed)).not.toThrow();
  });
});

describe("model/runtime substitution (L5)", () => {
  it("a substituted model digest/repo voids the run", () => {
    const m = buildRunManifest("abc");
    const swapped = m.models.map((x, i) => (i === 0 ? { ...x, model_repo: "phi3:mini" } : x));
    expect(() => assertNoModelSubstitution(m, swapped)).toThrow(ExecutionInvalid);
    expect(() => assertNoModelSubstitution(m, m.models.slice(1))).toThrow(ExecutionInvalid);
    expect(() => assertNoModelSubstitution(m, m.models)).not.toThrow();
  });
});

describe("data-binding drift (L6)", () => {
  const base = {
    production_deployment_sha: "4288d569ec50f7aa995ed40759c2cb172a64f2fa",
    data_manifest_identifier: "dm-1",
    data_manifest_sha256_or_equivalent_digest: "deadbeef",
    relevant_object_etags_or_snapshot_fingerprint: "fp-before",
    captured_before_utc: "2026-06-29T00:00:00Z",
    captured_after_utc: "2026-06-29T00:00:00Z",
    binding_mode: "BOUNDED_LIVE_WINDOW" as const,
  };

  it("a drifted live-window fingerprint invalidates", () => {
    expect(() => assertLiveWindowStable(base, "fp-AFTER-different")).toThrow(ExecutionInvalid);
    expect(() => assertLiveWindowStable(base, "fp-before")).not.toThrow();
  });

  it("a frozen snapshot whose window changed invalidates; a SHA alone is insufficient", () => {
    const frozenChanged = { ...base, binding_mode: "FROZEN_SNAPSHOT" as const, captured_after_utc: "2026-06-30T00:00:00Z" };
    expect(() => assertNoDataBindingDrift(frozenChanged)).toThrow(ExecutionInvalid);
    expect(() => assertNoDataBindingDrift({ ...base, production_deployment_sha: "" })).toThrow(ExecutionInvalid);
  });
});

describe("frozen limits object (L16)", () => {
  it("limits.json carries the exact frozen floors and avoids the word 'illustrative'", () => {
    const raw = readFileSync(join(PKG_ROOT, "config", "limits.json"), "utf8");
    expect(/illustrative/i.test(raw)).toBe(false);
    const limits = JSON.parse(raw);
    expect(limits.primary_floors.rarr_wilson95_lower_bound_min).toBe(0.6);
    expect(limits.primary_floors.cnu_wilson95_lower_bound_min).toBe(0.75);
    expect(limits.coverage.min_valid_observations_per_class_per_runtime).toBe(20);
  });
});

describe("coverage + runtime resolution fail-closed (L22/L23)", () => {
  it("L22: a zero-scenario corpus fails closed", () => {
    const root = join(tmpdir(), `a1-empty-${Date.now()}`);
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "evaluation.jsonl"), "\n  \n");
    expect(() => loadCorpus("evaluation", root)).toThrow(ExecutionInvalid);
    rmSync(root, { recursive: true, force: true });
  });

  it("L23: fewer than the required cells fails closed", () => {
    expect(() =>
      resolveCells({ required_cell_count: 3, cells: [{ cell_id: "X", required: true } as never, { cell_id: "Y", required: true } as never] }),
    ).toThrow(ExecutionInvalid);
  });
});

describe("out/ ignored + no secrets committed (L24/L25)", () => {
  it("L24: .gitignore ignores out/", () => {
    const gi = readFileSync(join(PKG_ROOT, ".gitignore"), "utf8");
    expect(/^\/?out\/?$/m.test(gi)).toBe(true);
  });

  it("L25: no committed source carries a secret/credential/private transcript", () => {
    const secretPatterns = [
      /ghp_[A-Za-z0-9]{20,}/,
      /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/,
      /bearer\s+ey[A-Za-z0-9._-]+/i,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      /d1_token\s*=\s*['"].+['"]/,
    ];
    for (const f of listSourceFiles()) {
      const content = readFileSync(f, "utf8");
      for (const p of secretPatterns) expect(p.test(content), `${f} :: ${p}`).toBe(false);
    }
  });
});

describe("pre-registered ordering recorded in the manifest (D-189 §D)", () => {
  it("records the seed + resolved arm/scenario order, reproducible from the seed", () => {
    const m = buildRunManifest("4288d569ec50f7aa995ed40759c2cb172a64f2fa");
    expect(m.ordering.ordering_seed).toBe(PRE_REGISTERED_ORDERING_SEED);
    expect(m.ordering.arm_order.length).toBe(2);
    expect(m.ordering.scenario_order.length).toBe(36);
    expect(m.ordering.ordering_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic: same seed => same recorded order on a second build.
    const m2 = buildRunManifest("abc");
    expect(m2.ordering.scenario_order).toEqual(m.ordering.scenario_order);
    expect(m2.ordering.arm_order).toEqual(m.ordering.arm_order);

    // The recorded order is exactly the seeded shuffle of the evaluation ids.
    const ids = loadCorpus("evaluation").map((i) => i.id);
    expect(m.ordering.scenario_order).toEqual(seededOrder(PRE_REGISTERED_ORDERING_SEED, ids));
    expect(() => assertManifestComplete(m)).not.toThrow();
  });

  it("an absent or empty ordering record fails closed", () => {
    const m = buildRunManifest("abc");
    m.ordering.scenario_order = [];
    expect(() => assertManifestComplete(m)).toThrow(ExecutionInvalid);
    expect(() => assertOrderingRecorded(undefined)).toThrow(ExecutionInvalid);
    // A tampered order whose hash no longer matches also fails closed.
    const m2 = buildRunManifest("abc");
    m2.ordering.scenario_order = [...m2.ordering.scenario_order].reverse();
    expect(() => assertManifestComplete(m2)).toThrow(ExecutionInvalid);
  });
});

describe("run-start model-pin gate (D-189 §C — fail closed if digest absent)", () => {
  it("a placeholder model digest voids the run via assertReadyForRun", () => {
    const m = buildRunManifest("abc"); // matrix digests are still RECORDED_AT_QUALIFICATION
    expect(m.models.every((x) => x.model_digest === "RECORDED_AT_QUALIFICATION")).toBe(true);
    expect(() => assertReadyForRun(m)).toThrow(ExecutionInvalid);
  });

  it("a manifest with real pinned (fixture) digests passes the gate", () => {
    const m = buildRunManifest("abc");
    m.models = m.models.map((x, i) => ({ ...x, model_digest: sha256(`fixture-digest-${i}`) }));
    expect(() => assertReadyForRun(m)).not.toThrow();
  });
});
