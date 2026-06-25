import { describe, expect, it } from "vitest";
import { Free2AIClient, getEntityEvidence } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "https://example.test";

describe("unknown-additive-field tolerance (append-only data)", () => {
  it("preserves unknown extra fields on a search response", async () => {
    const { fetch } = mockFetch({
      body: {
        version: "fni_v2.0",
        results: [{ id: "a", name: "A", brand_new_field: 42 }],
        total_count: 1,
        tier: "inverted_index",
        elapsed_ms: 3,
        future_top_level: "kept",
      },
    });
    const c = new Free2AIClient({ baseUrl: BASE, fetch });
    const res = await c.search({ q: "x" });
    expect((res as Record<string, unknown>).future_top_level).toBe("kept");
    expect((res.results[0] as Record<string, unknown>).brand_new_field).toBe(42);
    // elapsed_ms is TOP-LEVEL, not under meta.
    expect(res.elapsed_ms).toBe(3);
  });
});

describe("getEntityEvidence (local convenience, no network)", () => {
  const entityResponse = {
    version: "fni_v2.0",
    entity: {
      id: "meta/llama",
      canonical_id: "meta--llama",
      source: "huggingface",
      links: { source_url: "https://hf.co/meta/llama", badge_url: "/api/v1/badge/x" },
      relations: { datasets_used: ["d1"] },
      citation: "Meta 2024",
      stats: { downloads: 1000, stars: null },
      fni: {
        score: 88,
        percentile: 95,
        factors: {
          semantic: null,
          semantic_note: "query-time baseline; not a per-entity value",
          authority: 9,
          popularity: 8,
          recency: 7,
          quality: 8,
        },
        is_trending: true,
        trend_7d: null,
      },
    },
    meta: { elapsed_ms: 1, etag: null, candidates_tried: 1 },
  };

  it("re-shapes evidence and preserves semantic null + note verbatim", () => {
    const ev = getEntityEvidence(entityResponse as never);
    expect(ev.fni.factors.semantic).toBeNull();
    expect(ev.semantic_note).toBe("query-time baseline; not a per-entity value");
    expect(ev.relations).toEqual({ datasets_used: ["d1"] });
    expect(ev.stats).toEqual({ downloads: 1000, stars: null });
    expect(ev.citation).toBe("Meta 2024");
    expect(ev.disclaimer.toLowerCase()).toContain("final decision");
  });

  it("accepts a bare entity as well as the wrapped response", () => {
    const ev = getEntityEvidence(entityResponse.entity as never);
    expect(ev.id).toBe("meta/llama");
    expect(ev.identity_note.toLowerCase()).toContain("not proven external provenance");
  });
});
