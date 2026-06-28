import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// D-155 §4 / D-162 — Node support-floor (>=22; Node 20 EOL) + Release-Seal
// publish invariants. FAIL if reverted to ">=20"/Node-20 wording, or if the
// `private` publish-guard is reintroduced into source OR the packed tarball.

const PKG_ROOT = resolve(__dirname, "..");
const PKG_PATH = resolve(PKG_ROOT, "package.json");
const README_PATH = resolve(PKG_ROOT, "README.md");
const SRC_CONFIG_PATH = resolve(PKG_ROOT, "src/config.ts");

const PKG_RAW = readFileSync(PKG_PATH, "utf8");
const README_RAW = readFileSync(README_PATH, "utf8");
const SRC_CONFIG_RAW = readFileSync(SRC_CONFIG_PATH, "utf8");
const pkg = JSON.parse(PKG_RAW) as Record<string, any>;

// ---- Invariant predicates (each returns true when the posture is GOOD) ------
function enginesFloorIsNode22(p: Record<string, any>): boolean {
  return p?.engines?.node === ">=22";
}
// Reject any Node 20 / ">=20" / "Node.js 20" / "Node 20+" supported-runtime claim.
const NODE20_RUNTIME = /\bnode(?:\.js)?\s*20\b|>=\s*20\b|node\s*20\+/i;
function noNode20RuntimeWording(text: string): boolean {
  return !NODE20_RUNTIME.test(text);
}
function readmeStatesNode22Floor(text: string): boolean {
  return /\bnode(?:\.js)?\s*22\b|node\s*22\+/i.test(text);
}
// RELEASE-SEAL (D-162): publish-guard removed -> manifest must have NO `private`.
function hasPrivate(p: Record<string, any>): boolean {
  return Object.prototype.hasOwnProperty.call(p, "private");
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

  // RC-A private:true FREEZE inverted -> SOURCE manifest must have NO `private`
  // (absent, not merely !== true); version stays 0.1.0.
  it("SOURCE package.json: NO private property; version 0.1.0; RED mutation", () => {
    expect(hasPrivate(pkg)).toBe(false); // GREEN: publish-guard removed
    expect(pkg.private).toBeUndefined();
    expect(pkg.version).toBe("0.1.0");
    const mutated = { ...pkg, private: true }; // in-memory; disk NOT touched
    expect(hasPrivate(mutated)).toBe(true); // RED: guard reintroduced
    expect(mutated.private).toBe(true);
  });

  it("SDK has zero runtime dependencies", () => {
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

// SOURCE LAYER (D-160 RC-A) — scan src/config.ts (#2244 shipped green while it
// still emitted "Node 20+"; scanning the source catches it).
describe("D-160 RC-A SOURCE LAYER — src/config.ts carries no Node-20 wording", () => {
  it("src/config.ts has NO Node-20 supported-runtime wording", () => {
    expect(noNode20RuntimeWording(SRC_CONFIG_RAW)).toBe(true);
  });

  it("mutation: injecting a \"Node 20+\" claim into src/config.ts content fails", () => {
    // in-memory; disk NOT touched
    const mutated = SRC_CONFIG_RAW.replace("Node 22+, Workers, browsers", "Node 20+, Workers, browsers");
    expect(mutated).not.toBe(SRC_CONFIG_RAW); // non-vacuity: corrected wording existed
    expect(noNode20RuntimeWording(mutated)).toBe(false);
    expect(noNode20RuntimeWording(SRC_CONFIG_RAW)).toBe(true); // unmutated stays GREEN
  });
});

// ARTIFACT LAYER (D-160 RC-A) — bind invariants to a FRESHLY built + packed
// tarball (never stale dist): clean build + pack, scan EVERY shipped surface
// (pkg/README/CHANGELOG/dist/**/*.js+d.ts). FAIL-CLOSED: vacuous scan must FAIL.
interface PackedArtifact {
  tgzPath: string;
  entries: string[];
  contents: Map<string, string>; // entry path -> content, for every scanned surface
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
    // Drop existing dist + tgz (no stale artifact), fresh build, then pack.
    rmSync(resolve(PKG_ROOT, "dist"), { recursive: true, force: true });
    rmSync(tgzPath, { force: true });
    execSync("npm run build", { cwd: PKG_ROOT, stdio: "pipe" });
    execSync("npm pack", { cwd: PKG_ROOT, stdio: "pipe" });
    if (!existsSync(tgzPath)) {
      throw new Error(`npm pack did not produce ${TGZ_NAME}`);
    }
    // Enumerate the EXACT tarball by bare name from cwd: GNU tar treats an
    // absolute Windows path ("G:\...") as a remote host, so name-from-dir is
    // the portable form (POSIX CI too).
    const listing = execSync(`tar -tzf "${TGZ_NAME}"`, {
      cwd: PKG_ROOT,
      encoding: "utf8",
    });
    const entries = listing
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Read every scannable entry's bytes straight out of the tarball.
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
    // Always clean up: dist/ + .tgz are derived and the .tgz is NOT gitignored.
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
    // Zero-file scan MUST fail: require pkg + README + CHANGELOG + >=1 JS.
    expect(packed).not.toBeNull();
    expect(packed!.contents.size).toBeGreaterThan(0);
    expect(packed!.contents.has("package/package.json")).toBe(true);
    expect(packed!.contents.has("package/README.md")).toBe(true);
    expect(packed!.contents.has("package/CHANGELOG.md")).toBe(true);
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

  it("packed package.json: NO private + publish invariants + RED mutation", () => {
    expect(packed).not.toBeNull();
    const ppkg = JSON.parse(packed!.contents.get("package/package.json")!) as Record<string, any>;
    expect(hasPrivate(ppkg)).toBe(false); // publish-seal: no guard in the exact tarball
    expect(ppkg.private).toBeUndefined();
    expect(ppkg.name).toBe("@free2aitools/sdk");
    expect(ppkg.version).toBe("0.1.0");
    expect(ppkg.publishConfig?.access).toBe("public");
    expect(ppkg.engines?.node).toBe(">=22");
    expect(Object.keys(ppkg.dependencies ?? {})).toEqual([]);
    // Packed-fixture mutation: reintroducing private:true flags RED.
    const mutated = { ...ppkg, private: true };
    expect(hasPrivate(mutated)).toBe(true);
    expect(mutated.private).toBe(true);
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
    expect(noNode20RuntimeWording(cfg)).toBe(true); // unmutated packed text GREEN
    const mutated = cfg.replace("Node 22+, Workers, browsers", "Node 20+, Workers, browsers");
    expect(mutated).not.toBe(cfg); // non-vacuity: bytes actually changed
    expect(noNode20RuntimeWording(mutated)).toBe(false);
  });
});
