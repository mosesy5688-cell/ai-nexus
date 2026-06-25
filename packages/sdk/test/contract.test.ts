/**
 * Contract test: paths / methods / params / limits / defaults must match the
 * SDK-0 contract baseline (Sections 1-3). Mock fetch records the wire form.
 */
import { describe, expect, it } from "vitest";
import { Free2AIClient } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "https://example.test";
function rec(spec: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(spec);
  return { c: new Free2AIClient({ baseUrl: BASE, fetch, retry: { attempts: 1 } }), calls };
}

describe("contract: endpoint paths + methods", () => {
  it("health -> GET /api/v1/health", async () => {
    const { c, calls } = rec({ body: {} });
    await c.health();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/health");
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
  });

  it("search -> GET /api/v1/search", async () => {
    const { c, calls } = rec({ body: {} });
    await c.search({ q: "x" });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/search");
  });

  it("entity -> GET /api/v1/entity/{id}", async () => {
    const { c, calls } = rec({ body: { entity: {} } });
    await c.getEntity({ id: "abc" });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/entity/abc");
  });

  it("select -> POST /api/v1/select", async () => {
    const { c, calls } = rec({ body: {} });
    await c.select({ task: "x" });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/select");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("compare -> GET /api/v1/compare", async () => {
    const { c, calls } = rec({ body: {} });
    await c.compare({ ids: ["a", "b"] });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/compare");
  });

  it("concepts -> GET /api/v1/concepts", async () => {
    const { c, calls } = rec({ body: {} });
    await c.getConcepts();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/concepts");
  });

  it("trends -> GET /api/v1/trends/batch", async () => {
    const { c, calls } = rec({ body: {} });
    await c.getTrendsBatch({ ids: ["a"] });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/trends/batch");
  });

  it("datasets -> GET /api/v1/datasets", async () => {
    const { c, calls } = rec({ body: {} });
    await c.listDatasets();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/datasets");
  });
});

describe("contract: REST defaults + ranges (NOT MCP defaults)", () => {
  it("search default limit is 5 (REST), not 10 (MCP)", async () => {
    const { c, calls } = rec({ body: {} });
    await c.search({ q: "x" });
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("5");
  });

  it("concepts default limit 50, clamps to 200 max", async () => {
    const { c, calls } = rec({ body: {} });
    await c.getConcepts({ limit: 9999 });
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("200");
  });

  it("select default limit is 5 and explain true", async () => {
    const { c, calls } = rec({ body: {} });
    await c.select({ task: "x" });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.limit).toBe(5);
    expect(body.explain).toBe(true);
  });
});

describe("contract: rank/explain are NOT REST methods", () => {
  it("client exposes no rank() or explain() method", () => {
    const c = new Free2AIClient({ baseUrl: BASE });
    expect((c as unknown as Record<string, unknown>).rank).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).explain).toBeUndefined();
  });
});
