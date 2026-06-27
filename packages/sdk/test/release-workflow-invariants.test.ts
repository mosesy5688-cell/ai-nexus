import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

// =============================================================================
// D-152 release-supply-chain invariant + mutation tests for the SDK staged
// Trusted-Publishing workflow. These ASSERT the hardened posture and FAIL if any
// of the defects (A-H) is reintroduced. Each invariant has a paired mutation
// that injects the defect and proves the check goes red.
// =============================================================================

const WORKFLOW_PATH = resolve(
  __dirname,
  "../../../.github/workflows/sdk-npm-publish.yml",
);
const RAW = readFileSync(WORKFLOW_PATH, "utf8");

// Text-based invariant scans run against the EXECUTABLE surface only: strip
// full-line `#` comments so documentation prose (which legitimately mentions
// "npm publish" and "NPM_TOKEN" while explaining what is forbidden) does not
// trip a scan. Inline trailing comments are rare here and left intact.
const CODE = RAW.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

type Doc = ReturnType<typeof parse>;
const load = (text: string): Doc => parse(text);
// GitHub Actions parses the `on:` key as YAML boolean `true`.
const triggers = (d: Doc) => d.on ?? d[true as unknown as string];
const jobs = (d: Doc) => d.jobs;

// ---- Invariant predicates (each returns true when the posture is GOOD) ------

// (D/OIDC-leak) verify-and-pack must NOT hold id-token:write.
function verifyJobHasNoOidc(d: Doc): boolean {
  const perms = jobs(d)["verify-and-pack"]?.permissions ?? {};
  return perms["id-token"] !== "write";
}

// (A/stage-only) The stage job must use `npm stage publish`, never bare publish.
function usesStagePublish(text: string): boolean {
  return /npm stage publish/.test(text);
}
function hasNoDirectNpmPublish(text: string): boolean {
  // Any `npm publish` not immediately preceded by `stage ` is a direct publish.
  return !/npm(?!\s+stage)\s+publish/.test(text);
}

// (B/C exact tarball) Stage job recomputes + matches the SHA-256 from Job 1.
function stageMatchesSha(text: string): boolean {
  return (
    /SHA-256 mismatch/.test(text) &&
    /ACTUAL_SHA.*!=.*EXPECTED_SHA|"\$ACTUAL_SHA" != "\$EXPECTED_SHA"/.test(text)
  );
}

// (F fail-closed-but-Job1-succeeds) private:true must be blocked in the STAGE
// job (fail-closed), while Job 1 has no such guard (so default run succeeds).
function stagePrivateGuard(text: string): boolean {
  return /"\$T_PRIVATE" = "true"/.test(text) && /staging BLOCKED/.test(text);
}

// (E version mins) npm >= 11.15.0 and Node >= 22.14.0 asserted fail-closed.
function assertsToolchainMins(text: string): boolean {
  return (
    /11\.15\.0/.test(text) &&
    /22\.14\.0/.test(text) &&
    /node --version/.test(text) &&
    /npm --version/.test(text)
  );
}

// (G environment ref) stage job references the protected `npm-publish` env.
function stageReferencesEnvironment(d: Doc): boolean {
  return jobs(d)["stage"]?.environment === "npm-publish";
}

// Stage job must run NO lifecycle (no npm ci/build/test/checkout in that job).
function stageRunsNoLifecycle(d: Doc): boolean {
  const steps = jobs(d)["stage"]?.steps ?? [];
  const blob = JSON.stringify(steps);
  return (
    !/npm ci/.test(blob) &&
    !/npm run build/.test(blob) &&
    !/npm test/.test(blob) &&
    !/npm run typecheck/.test(blob) &&
    !/actions\/checkout/.test(blob)
  );
}

// No NPM_TOKEN / token-style credential anywhere.
function hasNoNpmToken(text: string): boolean {
  return !/NPM_TOKEN|_authToken|npm_password|NODE_AUTH_TOKEN/i.test(text);
}

describe("D-152 release workflow — good YAML satisfies all invariants", () => {
  const d = load(RAW);

  it("is valid YAML with workflow_dispatch-only trigger + confirm_stage input", () => {
    const t = triggers(d);
    expect(Object.keys(t)).toEqual(["workflow_dispatch"]);
    const input = t.workflow_dispatch.inputs.confirm_stage;
    expect(input.type).toBe("boolean");
    expect(input.default).toBe(false);
  });

  it("verify-and-pack has contents:read only and NO id-token:write", () => {
    expect(jobs(d)["verify-and-pack"].permissions).toEqual({ contents: "read" });
    expect(verifyJobHasNoOidc(d)).toBe(true);
  });

  it("stage has exactly contents:read + id-token:write, gated on confirm_stage", () => {
    expect(jobs(d)["stage"].permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(jobs(d)["stage"].if).toContain("confirm_stage == true");
    expect(jobs(d)["stage"].needs).toBe("verify-and-pack");
  });

  it("uses npm stage publish and NO direct npm publish", () => {
    expect(usesStagePublish(CODE)).toBe(true);
    expect(hasNoDirectNpmPublish(CODE)).toBe(true);
  });

  it("stage re-matches SHA-256, fail-closes on private, asserts toolchain mins", () => {
    expect(stageMatchesSha(CODE)).toBe(true);
    expect(stagePrivateGuard(CODE)).toBe(true);
    expect(assertsToolchainMins(CODE)).toBe(true);
  });

  it("stage references npm-publish environment and runs no lifecycle", () => {
    expect(stageReferencesEnvironment(d)).toBe(true);
    expect(stageRunsNoLifecycle(d)).toBe(true);
  });

  it("contains no NPM_TOKEN / token credential", () => {
    expect(hasNoNpmToken(CODE)).toBe(true);
  });
});

// ---- Mutation tests: inject each defect, prove the invariant goes RED -------

describe("D-152 mutation tests — reintroducing any defect FAILS", () => {
  it("A: stage-only removed (npm stage publish -> npm publish) fails", () => {
    const m = CODE.replace(/npm stage publish/g, "npm publish");
    expect(hasNoDirectNpmPublish(m)).toBe(false);
    expect(usesStagePublish(m)).toBe(false);
  });

  it("A2: a direct `npm publish` step introduced fails", () => {
    const m = CODE + "\n          run: npm publish --access public\n";
    expect(hasNoDirectNpmPublish(m)).toBe(false);
  });

  it("B/C: SHA mismatch guard removed fails", () => {
    const m = CODE.replace(/SHA-256 mismatch/g, "ignored");
    expect(stageMatchesSha(m)).toBe(false);
  });

  it("D: id-token:write leaked into verify-and-pack fails", () => {
    const d = load(RAW);
    jobs(d)["verify-and-pack"].permissions["id-token"] = "write";
    expect(verifyJobHasNoOidc(d)).toBe(false);
  });

  it("E: npm-version-downgrade (drop 11.15.0) fails", () => {
    const m = CODE.replace(/11\.15\.0/g, "11.0.0");
    expect(assertsToolchainMins(m)).toBe(false);
  });

  it("F: private:true not blocked in stage fails", () => {
    const m = CODE.replace(/staging BLOCKED/g, "ignored");
    expect(stagePrivateGuard(m)).toBe(false);
  });

  it("G: environment reference removed fails", () => {
    const d = load(RAW);
    delete jobs(d)["stage"].environment;
    expect(stageReferencesEnvironment(d)).toBe(false);
  });

  it("H/lifecycle: npm ci added to stage job fails", () => {
    const d = load(RAW);
    jobs(d)["stage"].steps.push({ name: "leak", run: "npm ci" });
    expect(stageRunsNoLifecycle(d)).toBe(false);
  });

  it("NPM_TOKEN introduced fails", () => {
    const m = CODE + "\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n";
    expect(hasNoNpmToken(m)).toBe(false);
  });
});
