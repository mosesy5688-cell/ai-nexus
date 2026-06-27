import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// D-155 §4 — SDK runtime-floor (Node support policy) invariant + mutation tests.
// Node 20 is EOL; the public SDK runtime floor is Node >=22. ASSERT the corrected
// posture and FAIL if it is reverted (engines back to ">=20") or if any Node-20
// supported-runtime wording is reintroduced into the package surfaces.

const PKG_PATH = resolve(__dirname, "../package.json");
const README_PATH = resolve(__dirname, "../README.md");

const PKG_RAW = readFileSync(PKG_PATH, "utf8");
const README_RAW = readFileSync(README_PATH, "utf8");
const pkg = JSON.parse(PKG_RAW) as Record<string, any>;

// ---- Invariant predicates (each returns true when the posture is GOOD) ------

// engines.node must be exactly ">=22" (the corrected floor), not ">=20".
function enginesFloorIsNode22(p: Record<string, any>): boolean {
  return p?.engines?.node === ">=22";
}

// No supported-runtime surface (engines OR README prose) may claim Node 20 /
// ">=20" / "Node.js 20" / "Node 20+" as a supported runtime.
const NODE20_RUNTIME = /\bnode(?:\.js)?\s*20\b|>=\s*20\b|node\s*20\+/i;
function noNode20RuntimeWording(text: string): boolean {
  return !NODE20_RUNTIME.test(text);
}

// README must positively state the Node 22 floor.
function readmeStatesNode22Floor(text: string): boolean {
  return /\bnode(?:\.js)?\s*22\b|node\s*22\+/i.test(text);
}

describe("D-155 SDK Node support policy — corrected posture holds", () => {
  it("engines.node is exactly \">=22\" (Node 20 EOL)", () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBe(">=22");
    expect(enginesFloorIsNode22(pkg)).toBe(true);
  });

  it("package.json carries NO Node-20 supported-runtime wording", () => {
    expect(noNode20RuntimeWording(PKG_RAW)).toBe(true);
  });

  it("README carries NO Node-20 supported-runtime wording", () => {
    expect(noNode20RuntimeWording(README_RAW)).toBe(true);
  });

  it("README positively states the Node 22 runtime floor", () => {
    expect(readmeStatesNode22Floor(README_RAW)).toBe(true);
  });

  // Guard the unrelated, MUST-NOT-CHANGE invariants D-155 §4 freezes.
  it("private:true and version 0.1.0 are unchanged", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("0.1.0");
  });

  it("SDK has zero runtime dependencies", () => {
    // Either absent or an empty object — never a populated dependency tree.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});

// ---- Mutation tests: reintroduce the EOL policy, prove the gate goes RED -----

describe("D-155 mutation tests — reverting to Node 20 FAILS", () => {
  it("reverting engines.node to \">=20\" fails the floor invariant", () => {
    const mutated = { ...pkg, engines: { node: ">=20" } };
    expect(enginesFloorIsNode22(mutated)).toBe(false);
  });

  it("reintroducing \">=20\" engines text into package.json fails", () => {
    const mutated = PKG_RAW.replace(/">=22"/, '">=20"');
    expect(noNode20RuntimeWording(mutated)).toBe(false);
  });

  it("reintroducing \"Node.js 20+\" wording into README fails", () => {
    const mutated = README_RAW.replace(/Node\.js 22\+/, "Node.js 20+");
    expect(noNode20RuntimeWording(mutated)).toBe(false);
  });

  it("a bare \"Node 20\" support claim anywhere fails the scan", () => {
    expect(noNode20RuntimeWording("Supported runtimes: Node 20.")).toBe(false);
  });
});
