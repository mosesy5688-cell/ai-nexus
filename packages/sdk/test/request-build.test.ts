import { describe, expect, it } from "vitest";
import { Free2AIClient } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "https://example.test";

function client(spec: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(spec);
  return { c: new Free2AIClient({ baseUrl: BASE, fetch }), calls };
}

describe("request construction + query serialization", () => {
  it("search applies REST defaults (limit=5, page=1, type=all)", async () => {
    const { c, calls } = client({ body: { results: [] } });
    await c.search({ q: "llama" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/api/v1/search");
    expect(u.searchParams.get("q")).toBe("llama");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("page")).toBe("1");
    expect(u.searchParams.get("type")).toBe("all");
  });

  it("search clamps limit to [1,20]", async () => {
    const { c, calls } = client({ body: {} });
    await c.search({ q: "x", limit: 999 });
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("20");
    await c.search({ q: "x", limit: 0 });
    expect(new URL(calls[1]!.url).searchParams.get("limit")).toBe("1");
  });

  it("getEntity encodes id in the path and passes include", async () => {
    const { c, calls } = client({ body: { entity: {} } });
    await c.getEntity({ id: "meta/llama 3", include: "body" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/api/v1/entity/meta%2Fllama%203");
    expect(u.searchParams.get("include")).toBe("body");
  });

  it("compare joins ids as CSV (REST wire form)", async () => {
    const { c, calls } = client({ body: { entities: [] } });
    await c.compare({ ids: ["a", "b", "c"] });
    expect(new URL(calls[0]!.url).searchParams.get("ids")).toBe("a,b,c");
  });

  it("concepts uses offset/limit defaults (50/0)", async () => {
    const { c, calls } = client({ body: { concepts: [] } });
    await c.getConcepts();
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("limit")).toBe("50");
    expect(u.searchParams.get("offset")).toBe("0");
    expect(u.searchParams.has("category")).toBe(false);
  });

  it("select is a POST with JSON body and explain default true", async () => {
    const { c, calls } = client({ body: { entries: [] } });
    await c.select({ task: "summarize", constraints: { max_vram_gb: 24 } });
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.task).toBe("summarize");
    expect(body.explain).toBe(true);
    expect(body.limit).toBe(5);
    expect(body.constraints).toEqual({ max_vram_gb: 24 });
  });

  it("badgeUrl is a pure builder and does not fetch", async () => {
    const { c, calls } = client({ body: {} });
    const url = c.badgeUrl("author--name");
    expect(url).toBe(`${BASE}/api/v1/badge/author--name`);
    expect(calls.length).toBe(0);
  });
});
