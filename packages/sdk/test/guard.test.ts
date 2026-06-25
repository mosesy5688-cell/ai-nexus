/**
 * Guard / mutation tests: detect route drift, limit drift, required-field
 * disappearance, error-to-success masking, and prohibited final-authority
 * language in the public JSDoc/docs. These FAIL LOUDLY if the SDK drifts from
 * the honest-contract baseline.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Free2AIClient } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const BASE = "https://example.test";

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

describe("guard: route + limit drift (locked in endpoints.ts)", () => {
  const src = read("methods/endpoints.ts");
  const routes = [
    "/api/v1/health",
    "/api/v1/search",
    "/api/v1/entity/",
    "/api/v1/select",
    "/api/v1/compare",
    "/api/v1/concepts",
    "/api/v1/trends/batch",
    "/api/v1/datasets",
  ];
  for (const r of routes) {
    it(`route present: ${r}`, () => expect(src.includes(r)).toBe(true));
  }

  it("search limit clamp stays [1,20] default 5", () => {
    expect(src).toMatch(/clampLimit\(req\.limit, 1, 20, 5\)/);
  });
  it("concepts limit clamp stays [1,200] default 50", () => {
    expect(src).toMatch(/clampLimit\(req\.limit, 1, 200, 50\)/);
  });
  it("compare id count stays 2..25", () => {
    expect(src).toMatch(/requireIdCount\(req\.ids, "ids", 2, 25\)/);
  });
  it("trends id count stays 1..25", () => {
    expect(src).toMatch(/requireIdCount\(req\.ids, "ids", 1, 25\)/);
  });
  it("select stays POST + non-idempotent (no auto-retry)", () => {
    expect(src).toMatch(/idempotent: false/);
  });
});

describe("guard: no REST rank/explain route invented", () => {
  it("no /rank or /explain url anywhere in src", () => {
    const files = ["methods/endpoints.ts", "client.ts", "index.ts"];
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/\/api\/v1\/rank/);
      expect(s).not.toMatch(/\/api\/v1\/explain/);
    }
  });
});

describe("guard: error-to-success masking is impossible", () => {
  it("503 never yields a resolved value", async () => {
    const { fetch } = mockFetch({ status: 503, body: { error: "cold" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: { attempts: 1 } });
    let resolved = false;
    await c.search({ q: "x" }).then(() => (resolved = true)).catch(() => {});
    expect(resolved).toBe(false);
  });

  it("404 never yields a resolved value", async () => {
    const { fetch } = mockFetch({ status: 404, body: { error: "absent" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: { attempts: 1 } });
    let resolved = false;
    await c.getEntity({ id: "x" }).then(() => (resolved = true)).catch(() => {});
    expect(resolved).toBe(false);
  });
});

describe("guard: prohibited final-authority language absent from docs", () => {
  // The SDK must use caller-final-decision language, never assert a verdict.
  const banned = [
    /\bthe best (model|choice|option)\b/i,
    /\bguaranteed compatible\b/i,
    /\bwe (choose|pick|decide) for you\b/i,
  ];
  const files = ["client.ts", "index.ts", "methods/evidence.ts"];
  for (const f of files) {
    const s = read(f);
    for (const re of banned) {
      it(`${f} has no "${re.source}"`, () => expect(s).not.toMatch(re));
    }
  }
});
