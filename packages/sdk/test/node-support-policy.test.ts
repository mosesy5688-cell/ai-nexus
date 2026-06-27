import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// D-155 §4 — SDK runtime-floor (Node support policy) invariant + mutation tests.
// Node 20 is EOL; the public SDK runtime floor is Node >=22. ASSERT the corrected
// posture and FAIL if it is reverted (engines back to ">=20") or if any Node-20
// supported-runtime wording is reintroduced into the package surfaces.

const PKG_ROOT = resolve(__dirname, "..");
const PKG_PATH = resolve(PKG_ROOT, "package.json");
const README_PATH = resolve(PKG_ROOT, "README.md");
const SRC_CONFIG_PATH = resolve(PKG_ROOT, "src/config.ts");

const PKG_RAW = readFileSync(PKG_PATH, "utf8");
const README_RAW = readFileSync(README_PATH, "utf8");
const SRC_CONFIG_RAW = readFileSync(SRC_CONFIG_PATH, "utf8");
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

// ===========================================================================
// SOURCE LAYER (D-160 RC-A) — extend the scan to src/config.ts.
// #2244 shipped green while src/config.ts still emitted a "Node 20+" runtime
// hint because the original gate scanned ONLY package.json + README. Adding the
// source file to the scan means the original bug WOULD have been caught here.
// ===========================================================================

describe("D-160 RC-A SOURCE LAYER — src/config.ts carries no Node-20 wording", () => {
  it("src/config.ts has NO Node-20 supported-runtime wording", () => {
    expect(noNode20RuntimeWording(SRC_CONFIG_RAW)).toBe(true);
  });

  it("mutation: injecting a \"Node 20+\" claim into src/config.ts content fails", () => {
    // Pure in-memory string mutation — the file on disk is NOT touched.
    const mutated = SRC_CONFIG_RAW.replace(
      "Node 22+, Workers, browsers",
      "Node 20+, Workers, browsers",
    );
    // Guard the mutation actually changed the content (else the assertion below
    // would be vacuous): the corrected wording must have been present to replace.
    expect(mutated).not.toBe(SRC_CONFIG_RAW);
    expect(noNode20RuntimeWording(mutated)).toBe(false);
    // ...and the unmutated content stays GREEN.
    expect(noNode20RuntimeWording(SRC_CONFIG_RAW)).toBe(true);
  });
});

// ===========================================================================
// ARTIFACT LAYER (D-160 RC-A) — bind the invariant to a FRESHLY built + packed
// tarball, never to stale local dist. This is the layer that was entirely
// missing in #2244: source can be clean while a stale-or-divergent shipped
// artifact still leaks the EOL runtime claim. We force a clean build, pack, and
// scan EVERY shipped surface (packed package.json / README / CHANGELOG / every
// dist/**/*.js + dist/**/*.d.ts) for prohibited Node-20 wording. The layer is
// FAIL-CLOSED: a vacuous "scanned nothing, found nothing" must FAIL.
// ===========================================================================

interface PackedArtifact {
  tgzPath: string;
  entries: string[]; // tarball entry paths (e.g. "package/dist/config.js")
  // Map of entry path -> file content, for every surface we scan.
  contents: Map<string, string>;
}

const TGZ_NAME = "free2aitools-sdk-0.1.0.tgz";
const PACKED_CONFIG_ENTRY = "package/dist/config.js";

// Entries we require to be scanned (the shipped runtime + doc surfaces).
function isScannableEntry(entry: string): boolean {
  return (
    entry === "package/package.json" ||
    entry === "package/README.md" ||
    entry === "package/CHANGELOG.md" ||
    /^package\/dist\/.*\.(js|d\.ts)$/.test(entry)
  );
}

let packed: PackedArtifact | null = null;
let packError: Error | null = null;

beforeAll(() => {
  const tgzPath = resolve(PKG_ROOT, TGZ_NAME);
  try {
    // 1) Remove any existing dist so stale dist can NOT be relied on.
    rmSync(resolve(PKG_ROOT, "dist"), { recursive: true, force: true });
    rmSync(tgzPath, { force: true });

    // 2) Fresh build (tsc -p tsconfig.json via the package `build` script).
    execSync("npm run build", { cwd: PKG_ROOT, stdio: "pipe" });

    // 3) Pack -> free2aitools-sdk-0.1.0.tgz in the package root.
    execSync("npm pack", { cwd: PKG_ROOT, stdio: "pipe" });

    if (!existsSync(tgzPath)) {
      throw new Error(`npm pack did not produce ${TGZ_NAME}`);
    }

    // 4) Enumerate the EXACT tarball. Use the bare filename relative to cwd
    //    (PKG_ROOT): GNU tar treats an absolute Windows path like "G:\..." as a
    //    remote host (the drive-letter colon), so always reference the tarball
    //    by name from inside its directory — portable to POSIX CI too.
    const listing = execSync(`tar -tzf "${TGZ_NAME}"`, {
      cwd: PKG_ROOT,
      encoding: "utf8",
    });
    const entries = listing
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 5) Read every scannable entry's bytes straight out of the tarball.
    const contents = new Map<string, string>();
    for (const entry of entries) {
      if (!isScannableEntry(entry)) continue;
      const body = execSync(`tar -xzf "${TGZ_NAME}" -O "${entry}"`, {
        cwd: PKG_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      contents.set(entry, body);
    }

    packed = { tgzPath, entries, contents };
  } catch (err) {
    packError = err instanceof Error ? err : new Error(String(err));
  } finally {
    // Always clean up: never leave dist/ or the .tgz on disk (they are derived
    // and the .tgz is NOT gitignored — must never be staged for commit).
    rmSync(tgzPath, { force: true });
    rmSync(resolve(PKG_ROOT, "dist"), { recursive: true, force: true });
  }
}, 120_000);

describe("D-160 RC-A ARTIFACT LAYER — freshly packed tarball is Node-20-clean", () => {
  it("fresh build + pack succeeded (fail-closed on any pack error)", () => {
    if (packError) throw packError;
    expect(packed).not.toBeNull();
  });

  it("tarball enumerated a non-empty file set (fail-closed on empty tarball)", () => {
    expect(packed).not.toBeNull();
    expect(packed!.entries.length).toBeGreaterThan(0);
  });

  it("packed dist/config.js entry exists (fail-closed if missing)", () => {
    expect(packed).not.toBeNull();
    expect(packed!.entries).toContain(PACKED_CONFIG_ENTRY);
    expect(packed!.contents.has(PACKED_CONFIG_ENTRY)).toBe(true);
  });

  it("actually scanned a non-empty set of surfaces (no vacuous pass)", () => {
    expect(packed).not.toBeNull();
    // Must have scanned the packed package.json + README + CHANGELOG + at least
    // the dist JS/d.ts surfaces. A scan of zero files MUST fail.
    expect(packed!.contents.size).toBeGreaterThan(0);
    expect(packed!.contents.has("package/package.json")).toBe(true);
    expect(packed!.contents.has("package/README.md")).toBe(true);
    expect(packed!.contents.has("package/CHANGELOG.md")).toBe(true);
    // At least one shipped JS file (the runtime surface) was scanned.
    const jsScanned = [...packed!.contents.keys()].filter((e) =>
      /^package\/dist\/.*\.js$/.test(e),
    );
    expect(jsScanned.length).toBeGreaterThan(0);
  });

  it("EVERY packed surface has ZERO Node-20 runtime wording", () => {
    expect(packed).not.toBeNull();
    const offenders: string[] = [];
    for (const [entry, body] of packed!.contents) {
      if (!noNode20RuntimeWording(body)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it("packed dist/config.js specifically does not contain \"Node 20+\"", () => {
    expect(packed).not.toBeNull();
    const cfg = packed!.contents.get(PACKED_CONFIG_ENTRY);
    expect(cfg).toBeDefined();
    expect(noNode20RuntimeWording(cfg!)).toBe(true);
  });

  it("packed-fixture mutation: injecting \"Node 20+\" into packed dist/config.js flags RED", () => {
    expect(packed).not.toBeNull();
    const cfg = packed!.contents.get(PACKED_CONFIG_ENTRY)!;
    // Unmutated packed text is GREEN — proving the scanner is non-vacuous.
    expect(noNode20RuntimeWording(cfg)).toBe(true);
    const mutated = cfg.replace(
      "Node 22+, Workers, browsers",
      "Node 20+, Workers, browsers",
    );
    // The mutation must have changed the bytes (else the proof is vacuous).
    expect(mutated).not.toBe(cfg);
    expect(noNode20RuntimeWording(mutated)).toBe(false);
  });
});
