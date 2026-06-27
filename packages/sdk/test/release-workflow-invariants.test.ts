import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

// D-152/D-153 release-supply-chain invariant + mutation tests for the SDK
// staged Trusted-Publishing workflow. ASSERT the hardened posture; FAIL if any
// defect is reintroduced. Each invariant has a paired mutation proving RED.

const WORKFLOW_PATH = resolve(
  __dirname,
  "../../../.github/workflows/sdk-npm-publish.yml",
);
const RAW = readFileSync(WORKFLOW_PATH, "utf8");

// Text scans run against the EXECUTABLE surface only: strip full-line `#`
// comments so documentation prose (which legitimately mentions "npm publish" /
// "NPM_TOKEN" while explaining what is forbidden) does not trip a scan.
const CODE = RAW.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

type Doc = ReturnType<typeof parse>;
const load = (text: string): Doc => parse(text);
// GitHub Actions parses the `on:` key as YAML boolean `true`.
const triggers = (d: Doc) => d.on ?? d[true as unknown as string];
const jobs = (d: Doc) => d.jobs;

// ---- Invariant predicates (each returns true when the posture is GOOD) ------

// (D) verify-and-pack must NOT hold id-token:write.
function verifyJobHasNoOidc(d: Doc): boolean {
  const perms = jobs(d)["verify-and-pack"]?.permissions ?? {};
  return perms["id-token"] !== "write";
}

// (A) stage job must use `npm stage publish`, never bare publish.
function usesStagePublish(text: string): boolean {
  return /npm stage publish/.test(text);
}
function hasNoDirectNpmPublish(text: string): boolean {
  return !/npm(?!\s+stage)\s+publish/.test(text);
}

// (B/C) Stage job recomputes + matches the SHA-256 from Job 1.
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

// (E, D-153) EXACT pins asserted fail-closed: Node 24.18.0 + npm 11.16.0.
// Must be exact-equality asserts (the `!=` comparison), not a floor.
function assertsExactToolchain(text: string): boolean {
  return (
    /24\.18\.0/.test(text) &&
    /11\.16\.0/.test(text) &&
    /node --version/.test(text) &&
    /npm --version/.test(text) &&
    /!= required exact|!= "\$EXPECTED_NODE"|!= "\$EXPECTED_NPM"/.test(text)
  );
}

const isSetupNode = (s: any) =>
  typeof s.uses === "string" && /actions\/setup-node/.test(s.uses);

// (D-153) Pinned runtime must be the EXACT Node version (no floating major).
function stagePinsExactNode(d: Doc): boolean {
  const setup = (jobs(d)["stage"]?.steps ?? []).find(isSetupNode);
  return setup?.with?.["node-version"] === "24.18.0";
}

// (D-153) Stage job must use setup-node to provision its runtime.
function stageHasSetupNode(d: Doc): boolean {
  return (jobs(d)["stage"]?.steps ?? []).some(isSetupNode);
}

// (D-153 CORE) Inside the id-token:write stage job, NO tool/package acquisition
// may run. setup-node (`uses:`) is allowed; among `run:` scripts the only npm
// command permitted is `npm stage publish`. Any forbidden acquisition command
// in a stage `run:` block makes this predicate FALSE.
function stageNoToolAcquisition(d: Doc): boolean {
  const steps = jobs(d)["stage"]?.steps ?? [];
  const forbidden = [
    /\bnpm\s+install\b/,
    /\bnpm\s+i\b/,
    /\bnpm\s+ci\b/,
    /\bnpm\s+update\b/,
    /\bnpm\s+exec\b/,
    /\bnpx\b/,
    /\bpnpm\b/,
    /\byarn\b/,
    /\bcorepack\s+(prepare|use)\b/,
    /\b(curl|wget)\b[^\n]*\|[^\n]*\b(sh|bash|node)\b/,
    /npm@latest/,
  ];
  for (const s of steps) {
    const run = typeof (s as any).run === "string" ? (s as any).run : "";
    for (const re of forbidden) {
      if (re.test(run)) return false;
    }
  }
  return true;
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

  it("workflow_dispatch-only trigger + confirm_stage boolean default false", () => {
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
  it("stage has contents:read + id-token:write, gated on confirm_stage", () => {
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
  it("stage re-matches SHA, fail-closes on private, asserts exact pins", () => {
    expect(stageMatchesSha(CODE)).toBe(true);
    expect(stagePrivateGuard(CODE)).toBe(true);
    expect(assertsExactToolchain(CODE)).toBe(true);
  });
  it("stage references npm-publish environment and runs no lifecycle", () => {
    expect(stageReferencesEnvironment(d)).toBe(true);
    expect(stageRunsNoLifecycle(d)).toBe(true);
  });
  it("stage pins exact Node 24.18.0 via setup-node + no tool acquisition", () => {
    expect(stageHasSetupNode(d)).toBe(true);
    expect(stagePinsExactNode(d)).toBe(true);
    expect(stageNoToolAcquisition(d)).toBe(true);
  });
  it("contains no NPM_TOKEN / token credential", () => {
    expect(hasNoNpmToken(CODE)).toBe(true);
  });
});

// ---- Mutation tests: inject each defect, prove the invariant goes RED -------

const pushStage = (run: string) => {
  const d = load(RAW);
  jobs(d)["stage"].steps.push({ name: "x", run });
  return d;
};

describe("D-152/D-153 mutation tests — reintroducing any defect FAILS", () => {
  it("A: stage-only removed (npm stage publish -> npm publish) fails", () => {
    const m = CODE.replace(/npm stage publish/g, "npm publish");
    expect(hasNoDirectNpmPublish(m)).toBe(false);
    expect(usesStagePublish(m)).toBe(false);
  });
  it("A2: a direct `npm publish` step introduced fails", () => {
    expect(hasNoDirectNpmPublish(CODE + "\n  run: npm publish --access public\n")).toBe(false);
  });
  it("B/C: SHA mismatch guard removed fails", () => {
    expect(stageMatchesSha(CODE.replace(/SHA-256 mismatch/g, "x"))).toBe(false);
  });
  it("D: id-token:write leaked into verify-and-pack fails", () => {
    const d = load(RAW);
    jobs(d)["verify-and-pack"].permissions["id-token"] = "write";
    expect(verifyJobHasNoOidc(d)).toBe(false);
  });
  it("E: exact pin removed (drop npm 11.16.0 assert) fails", () => {
    expect(assertsExactToolchain(CODE.replace(/11\.16\.0/g, "11.99.0"))).toBe(false);
  });
  it("F: private:true not blocked in stage fails", () => {
    expect(stagePrivateGuard(CODE.replace(/staging BLOCKED/g, "x"))).toBe(false);
  });
  it("G: environment reference removed fails", () => {
    const d = load(RAW);
    delete jobs(d)["stage"].environment;
    expect(stageReferencesEnvironment(d)).toBe(false);
  });
  it("H/lifecycle: npm ci added to stage job fails", () => {
    expect(stageRunsNoLifecycle(pushStage("npm ci"))).toBe(false);
  });
  it("NPM_TOKEN introduced fails", () => {
    expect(hasNoNpmToken(CODE + "\n env:\n  NPM_TOKEN: x\n")).toBe(false);
  });
  // D-153 mandatory cases:
  it("(1) inject `npm install -g npm@latest` into stage fails", () => {
    expect(stageNoToolAcquisition(pushStage("npm install -g npm@latest"))).toBe(false);
  });
  it("(2) inject `npm install -g npm@11.15.0` into stage fails", () => {
    expect(stageNoToolAcquisition(pushStage("npm install -g npm@11.15.0"))).toBe(false);
  });
  it("(3) floating node-version `24` (no exact pin) fails", () => {
    const d = load(RAW);
    (jobs(d)["stage"].steps.find(isSetupNode) as any).with["node-version"] = "24";
    expect(stagePinsExactNode(d)).toBe(false);
  });
  it("(4) nonmatching expected npm version fails", () => {
    expect(assertsExactToolchain(CODE.replace(/11\.16\.0/g, "11.20.0"))).toBe(false);
  });
  it("(5) remove setup-node from stage fails", () => {
    const d = load(RAW);
    jobs(d)["stage"].steps = jobs(d)["stage"].steps.filter((s: any) => !isSetupNode(s));
    expect(stageHasSetupNode(d)).toBe(false);
    expect(stagePinsExactNode(d)).toBe(false);
  });
  it("(6) introduce `npx` into stage fails", () => {
    expect(stageNoToolAcquisition(pushStage("npx some-tool --do"))).toBe(false);
  });
});
